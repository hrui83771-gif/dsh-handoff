/**
 * dsh-handoff —— 跨会话上下文接力
 *
 * 定位：dsh 已有的 compaction 负责"同会话内隐藏旧条目"，
 *       本插件负责"跨会话传递结论"。
 *
 * 三层：
 *   ① 监测  step/end 时读 tokenMeter，按 60% / 80% 报警
 *   ② 蒸馏  /handoff 或 handoff_save 生成 pack.json（确定性，不调模型）
 *   ③ 注入  agent/created(source=startup) 时把 L0 摘要 inject 进新会话
 *           细节由 recall_context 按需取，避免把膨胀问题搬过去
 */

import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { synthesizeBrief, synthEnabled } from './brief.js'
import { buildPack, type PackBrief } from './distill.js'
import { gitFacts } from './git.js'
import {
  formatPressure,
  pressureHint,
  readPressure,
  resolveWindow,
  routeOf,
  type Pressure,
} from './meter.js'
import {
  PACK_SECTIONS,
  formatAge,
  isStale,
  listPacks,
  loadLatestPack,
  loadPackById,
  loadRecentPacks,
  mirrorLatest,
  packAgeMs,
  readSection,
  savePack,
  toL0,
  truncate,
  type HandoffPack,
  type PackMeta,
} from './pack.js'
import { injectContext, onSessionEvent, registerCommand } from './compat.js'
import {
  dshHome,
  handoffRemoteRoot,
  handoffRoot,
  resolveWorkspace,
  type WorkspaceRef,
} from './workspace.js'

export const name = 'dsh-handoff'
export const inject = ['agents', 'llm', 'sessions', 'tokenMeter', 'tools']

/* 插件自己发出的两个事件，声明出来让消费方有类型可用 */
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** 新会话已接过上一个会话的摘要 */
    'handoff/restored'(payload: {
      agent: Agent
      workspace: string
      packId: string
      fromSession: string
      at: string
    }): void
    /** 上下文压力越过 60% / 80% 阈值（同档位只报一次） */
    'handoff/pressure'(payload: {
      agent: Agent | undefined
      sessionId: string
      pressure: Pressure
      hint: string
      at: string
    }): void
  }
}

export function apply(ctx: Context) {
  /** 每条会话上次报警的档位，防止每个 step 都喊一次 */
  const lastBand = new Map<string, string>()
  /** 每条会话上次采样的时间戳，给 O(surface) 的 measure() 做节流 */
  const lastMeasure = new Map<string, number>()
  /** provider/model 路由 → 真实上下文窗口 */
  const windowByRoute = new Map<string, number>()
  const MEASURE_INTERVAL_MS = 5_000

  /** 已经接过包的会话（startup 注入或延迟接力），防止重复注入 */
  const restoredSessions = new Set<string>()
  /** 延迟接力的尝试次数：按改动文件反推仓库根不是每次都能成，别无限试 */
  const lateAttempts = new Map<string, number>()
  const MAX_LATE_ATTEMPTS = 3

  /** 已解析过的窗口；没解析过返回 undefined（调用方负责触发解析） */
  const windowFor = (agent: Agent): number | undefined => windowByRoute.get(routeOf(agent))

  /** 解析窗口并缓存。resolveModelInfo 是异步的，所以只解析一次、之后走缓存。 */
  const ensureWindow = (agent: Agent): Promise<number> => {
    const route = routeOf(agent)
    const hit = windowByRoute.get(route)
    if (hit) return Promise.resolve(hit)

    return resolveWindow(ctx, agent).then((info) => {
      windowByRoute.set(route, info.tokens)
      console.log(
        `[dsh-handoff] window ${route} = ${info.tokens.toLocaleString()} tok (${info.source})`,
      )
      return info.tokens
    })
  }

  /* ---------------- ③ 新会话接力 ---------------- */

  ctx.on('agent/created', (payload) => {
    const { agent } = payload

    // 任何来源都先把窗口解析出来（异步、只一次），监测层才不至于用兜底值
    void ensureWindow(agent)

    // resume / clear / compact 不重复注入
    if (payload.source !== 'startup') return

    const header = agent.session.header

    // 子会话（subagent）不该继承父会话的交接包
    if (header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0) return

    return restore(agent).then(() => undefined)
  })

  /**
   * 读取接力包并注入。listener 会被 await 到创建完成之前，
   * 所以这里返回 Promise 保证"注入一定早于用户的第一条消息"。
   */
  async function restore(agent: Agent): Promise<void> {
    const ws = resolveWorkspace(agent)
    const pack = await loadPackForWorkspace(ws)
    if (!pack) return
    if (pack.fromSession === String(agent.session.id)) return // 自己交给自己，跳过

    const stale = isStale(pack)

    // 前几次接力包：给 L0 提供演化弧线 + 差异注入（remote 镜像只存 latest，弧线只看本机链）
    const recent = await loadRecentPacks(handoffRoot(ws), 4)
    const at = recent.findIndex((p) => p.id === pack.id)
    const previous = at >= 0 ? recent.slice(at + 1) : recent.filter((p) => p.id !== pack.id)

    const injected = injectContext(agent, {
      // 过时的包照样注入，但 L0 开头带显式警告：模型别照抄一周前的下一步
      text: toL0(pack, { stale, previous }),
      fromSession: pack.fromSession,
      packId: pack.id,
      form: 'recall',
    })
    if (!injected) {
      console.warn(
        `[dsh-handoff] 注入失败：pack ${pack.id} → 会话 ${agent.session.id}（inject() 抛错）`,
      )
      return
    }

    if (stale) {
      console.warn(
        `[dsh-handoff] pack ${pack.id} 写于 ${formatAge(packAgeMs(pack))}（已过期线），注入时带了过时警告`,
      )
    }
    restoredSessions.add(String(agent.session.id))
    console.log(
      `[dsh-handoff] restored pack ${pack.id}（会话 ${pack.fromSession}）→ 会话 ${agent.session.id}`,
    )

    ctx.emit('handoff/restored', {
      agent,
      workspace: ws.label,
      packId: pack.id,
      fromSession: pack.fromSession,
      at: new Date().toISOString(),
    })
  }

  /**
   * 找这个工作区的接力包：本机 key 目录优先（最新鲜），没有再按仓库
   * origin 找远端镜像目录——换机器/换 clone 时本地 key 必然对不上，
   * 远端地址才认得出来。
   */
  async function loadPackForWorkspace(ws: WorkspaceRef, packId?: string): Promise<HandoffPack | null> {
    const local = packId
      ? await loadPackById(handoffRoot(ws), packId)
      : await loadLatestPack(handoffRoot(ws))
    if (local) return local

    const facts = await gitFacts(ws.dir)
    if (!facts.remote) return null

    const remote = packId
      ? await loadPackById(handoffRemoteRoot(facts.remote), packId)
      : await loadLatestPack(handoffRemoteRoot(facts.remote))
    if (remote) {
      console.log(
        `[dsh-handoff] 本机无记录，按远端 ${facts.remote} 找到接力包 ${remote.id}` +
          (packId ? '' : `（写于 ${formatAge(packAgeMs(remote))}）`),
      )
    }
    return remote
  }

  /**
   * 延迟接力：startup 时没接到包（cwd 不在仓库里、或本机无记录），
   * 等第一个带路径参数的工具调用落地，从改动文件反推仓库根，
   * 再按 git origin 找远端镜像——覆盖"家目录开会话改别处仓库"的场景。
   */
  async function maybeLateRestore(session: Session, event: any): Promise<void> {
    const id = String(session.id)
    if (restoredSessions.has(id)) return
    const attempts = lateAttempts.get(id) ?? 0
    if (attempts >= MAX_LATE_ATTEMPTS) return

    const agent = ctx.agents.get(session.id)
    if (!agent) return
    const header = agent.session.header
    if (header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0) return

    const raw = typeof event?.data?.arguments === 'string' ? event.data.arguments : ''
    const dirs = candidateDirs(raw, String(session.header?.cwd ?? process.cwd()))
    if (!dirs.length) return
    lateAttempts.set(id, attempts + 1)

    for (const dir of dirs) {
      // git -C 会自己向上找仓库根，所以文件的所在目录就够
      const facts = await gitFacts(dir)
      if (!facts.remote) continue

      const pack = await loadLatestPack(handoffRemoteRoot(facts.remote))
      // 找到了远端目录但没有可用包：换目录再试没有意义，本会话就此作罢
      if (!pack || pack.fromSession === id) return

      const injected = injectContext(agent, {
        text: toL0(pack, { stale: isStale(pack) }),
        fromSession: pack.fromSession,
        packId: pack.id,
        form: 'recall',
      })
      if (!injected) return

      restoredSessions.add(id)
      console.log(
        `[dsh-handoff] 延迟接力：会话 ${id} 的 cwd 不在仓库内，按改动文件（${dir}）` +
          `反推出 ${facts.remote}，注入 pack ${pack.id}`,
      )
      ctx.emit('handoff/restored', {
        agent,
        workspace: resolveWorkspace(agent).label,
        packId: pack.id,
        fromSession: pack.fromSession,
        at: new Date().toISOString(),
      })
      return
    }
  }

  /** 从工具参数的 JSON 字符串里挑出真实存在的路径，取其所在目录 */
  function candidateDirs(rawArgs: string, cwd: string): string[] {
    const out: string[] = []
    if (!rawArgs) return out

    // 优先按 JSON 解析取值：正则按引号切分会被路径里的单引号坑掉
    // （Windows 短目录名就有 HEN'R'~1 这种）
    const candidates: string[] = []
    let parsed: unknown = null
    try {
      parsed = JSON.parse(rawArgs)
    } catch {
      /* 非 JSON 参数：退回双引号正则 */
    }
    if (parsed && typeof parsed === 'object') {
      collectStringValues(parsed, candidates)
    } else {
      const re = /"([^"\n]+\.[A-Za-z0-9]{1,6})"/g
      for (const match of rawArgs.matchAll(re)) {
        if (match[1]) candidates.push(match[1])
      }
    }

    for (const path of candidates) {
      if (!path || path.length > 300 || /^https?:/.test(path)) continue
      if (!/\.[A-Za-z0-9]{1,6}$/.test(path)) continue
      const dir = dirname(isAbsolute(path) ? path : join(cwd, path))
      if (!existsSync(dir)) continue
      if (!out.includes(dir)) out.push(dir)
      if (out.length >= 3) break
    }
    return out
  }

  function collectStringValues(node: unknown, out: string[]): void {
    if (typeof node === 'string') {
      out.push(node)
      return
    }
    if (Array.isArray(node)) {
      for (const item of node) collectStringValues(item, out)
      return
    }
    if (node && typeof node === 'object') {
      for (const value of Object.values(node as Record<string, unknown>)) {
        collectStringValues(value, out)
      }
    }
  }

  /**
   * compaction 断点：压缩的那一刻同样是丢上下文的时刻（旧细节被隐藏）。
   * 落一份纯事实包（含失败教训），压缩后本会话还能 recall_context 找回来，
   * 下个会话也会把它当最新接力包接走。
   * 不补写结论：compaction 本身已经在跑模型请求，这里必须快。
   */
  async function compactionSnapshot(session: Session): Promise<void> {
    const agent = ctx.agents.get(session.id)
    if (!agent) return
    const header = agent.session.header
    if (header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0) return

    try {
      const ws = resolveWorkspace(agent)
      const existing = await loadLatestPack(handoffRoot(ws))
      // 本会话已经存过包（多半带模型结论）：别用断点包把更好的结论顶掉
      if (existing?.fromSession === String(agent.session.id)) return

      const { pack } = await createPack(agent, undefined, { trigger: 'compaction' })
      console.log(
        `[dsh-handoff] compaction 断点：已存 pack ${pack.id}` +
          `（${pack.files.length} 文件 / ${pack.deadEnds.length} 条失败教训，压缩后可 recall_context 找回细节）`,
      )
    } catch (error) {
      console.warn(`[dsh-handoff] compaction 断点落盘失败：${(error as Error)?.message ?? error}`)
    }
  }

  /* ---------------- ① 压力监测 ---------------- */

  ctx.on('agent/disposed', ({ agent }) => {
    const id = String(agent.session.id)
    lastBand.delete(id)
    lastMeasure.delete(id)
  })

  onSessionEvent(ctx, (session, event) => {
    // compaction 前落断点包：被压掉的细节之后还能 recall_context 找回来。
    // compaction/start 不在 rc.3 的事件类型联合里（桌面版 compaction 插件
    // 以扩展事件写入日志），所以按字符串比较。
    if (String(event.type) === 'compaction/start') {
      void compactionSnapshot(session)
      return
    }
    // startup 没接到包的会话：等第一个带路径的工具调用反推仓库根，补一次接力
    if (event.type === 'tool/call') {
      void maybeLateRestore(session, event)
      return
    }
    if (event.type !== 'step/end') return

    const id = String(session.id)

    // measure() 是 O(surface) 的：长会话里每个 step 都全量折一遍会很贵。
    // 5 秒一次足够，阈值是 60%/80% 这种粗粒度，不需要更密。
    const now = Date.now()
    if (now - (lastMeasure.get(id) ?? 0) < MEASURE_INTERVAL_MS) return

    // 窗口还不知道就先触发解析，本轮跳过（下一次 step/end 就有缓存了）
    const agent = ctx.agents.get(session.id)
    const window = agent ? windowFor(agent) : undefined
    if (!window) {
      if (agent) void ensureWindow(agent)
      return
    }
    lastMeasure.set(id, now)

    const pressure = readPressure(ctx, session, window)

    if (!pressure || pressure.band === 'ok') {
      lastBand.delete(id)
      return
    }
    if (lastBand.get(id) === pressure.band) return // 同档位只报一次
    lastBand.set(id, pressure.band)

    const hint = pressureHint(pressure)

    // 让模型自己也看到这条警告：inject 不唤醒 driver，等下一次 pre-step 才被 claim。
    // 用 notice 形式（官方 model-selection 也是这么追加 user-role 通知的）。
    if (agent) {
      injectContext(agent, {
        text: hint,
        fromSession: id,
        packId: `pressure-${pressure.band}`,
        form: 'notice',
        summary: `上下文已用 ${Math.round(pressure.ratio * 100)}%`,
      })
    }

    // 高压力档位顺手落一份纯事实包，防止模型没来得及 handoff_save 就断了
    if (pressure.band === 'high' && agent) void autoSave(agent)

    ctx.emit('handoff/pressure', {
      agent,
      sessionId: id,
      pressure,
      hint,
      at: new Date().toISOString(),
    })
  })

  /* ---------------- 工具：按需取 L1 / L2 ---------------- */

  /** 跨历史包全文检索：每个包的每个分节取第一条命中行，最多 20 条 */
  const searchPacks = async (ws: WorkspaceRef, query: string, section?: string): Promise<string> => {
    const q = query.toLowerCase()

    const local = await loadRecentPacks(handoffRoot(ws), 20)
    let packs = local
    const facts = await gitFacts(ws.dir)
    if (facts.remote) {
      const remote = await loadRecentPacks(handoffRemoteRoot(facts.remote), 20)
      const seen = new Set(local.map((p) => p.id))
      packs = [...local, ...remote.filter((p) => !seen.has(p.id))]
    }
    if (!packs.length) return '(no handoff packs for this workspace)'

    const hits: string[] = []
    for (const pack of packs) {
      for (const [name, text] of Object.entries(pack.sections ?? {})) {
        if (section && name !== section) continue
        const line = String(text ?? '')
          .split('\n')
          .map((l) => l.trim())
          .find((l) => l.toLowerCase().includes(q))
        if (line) {
          hits.push(`pack ${pack.id}（${formatAge(packAgeMs(pack))}）· ${name} · ${truncate(line, 200)}`)
        }
        if (hits.length >= 20) break
      }
      if (hits.length >= 20) break
    }

    return hits.length
      ? hits.join('\n')
      : `"${query}" 在 ${packs.length} 份交接包里没有命中${section ? `（分节 ${section}）` : ''}`
  }

  ctx.tools.register(
    defineTool({
      name: 'recall_context',
      description:
        'Read a section of a handoff pack carried over from a previous session, ' +
        'or full-text search across all recent packs with `query`. ' +
        'Use this instead of guessing what happened before. ' +
        'Defaults to the latest pack; pass packId (from handoff_list) for an older one.',
      parameters: {
        section: {
          type: 'string',
          description: `Which section to read: ${PACK_SECTIONS.join(' | ')}. Required unless query is given.`,
        },
        query: {
          type: 'string',
          description:
            'Full-text search across all recent handoff packs (this workspace plus the ' +
            'remote mirror): returns matching lines with pack id, age and section. ' +
            'Combine with section to narrow down.',
        },
        packId: {
          type: 'string',
          description:
            'Which pack to read, from handoff_list. Omit for the latest pack.',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args: any, value: any) => [{ type: 'text', text: String(value) }],
      },
      async execute(args: any) {
        const agent = ctx.agents.currentInitiator()
        if (!agent) return '(no active agent)'

        const ws = resolveWorkspace(agent)

        const query = typeof args?.query === 'string' ? args.query.trim() : ''
        if (query) {
          const section = typeof args?.section === 'string' ? args.section.trim() : ''
          return searchPacks(ws, query, section || undefined)
        }

        const section = typeof args?.section === 'string' ? args.section.trim() : ''
        if (!section) return '(specify a section, or query="..." for full-text search)'

        const packId = typeof args?.packId === 'string' ? args.packId.trim() : ''
        const pack = await loadPackForWorkspace(ws, packId || undefined)
        if (!pack) return packId ? `(no pack ${packId} for this workspace)` : '(no handoff pack for this workspace)'

        const body = readSection(pack, section)
        if (body == null) return `(unknown section: ${section})`

        return (
          `# ${section}（来自会话 ${pack.fromSession}，${pack.createdAt}，pack ${pack.id}）\n\n` +
          (body || '(empty)')
        )
      },
    }),
  )

  /* ---------------- 工具：列出历史接力包 ---------------- */

  /** 本机 + 远端镜像合并列表（handoff_list 工具和 /handoff list 共用） */
  const listForWorkspace = async (ws: WorkspaceRef): Promise<PackMeta[]> => {
    const local = await listPacks(handoffRoot(ws))

    let remote: PackMeta[] = []
    const facts = await gitFacts(ws.dir)
    if (facts.remote) remote = await listPacks(handoffRemoteRoot(facts.remote))

    // 本机的在前（更新鲜），按 id 去重
    const seen = new Set(local.map((p) => p.id))
    return [...local, ...remote.filter((p) => !seen.has(p.id))].slice(0, 10)
  }

  const renderPackList = (rows: PackMeta[]): string => {
    if (!rows.length) return '(no handoff packs for this workspace)'
    return rows
      .map((p) => {
        const tags = [
          p.hasConclusion ? '' : '[纯事实]',
          p.trigger === 'compaction' ? '[压缩断点]' : '',
          p.trigger === 'pressure' ? '[压力兜底]' : '',
        ].filter(Boolean)
        const repo = p.git?.remote ? `  ${p.git.remote}` : ''
        return `${p.id}  ${p.createdAt}（${p.age}）${tags.length ? ` ${tags.join(' ')}` : ''}${repo}\n  ${p.goal || '(无标题)'}\n  ${p.progress || '(无结论)'}`
      })
      .join('\n\n')
  }

  ctx.tools.register(
    defineTool({
      name: 'handoff_list',
      description:
        'List saved handoff packs for this workspace, newest first. ' +
        'Use a pack id with recall_context(packId=...) to read an older pack ' +
        '(for example when the latest one is a facts-only auto save).',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args: any, value: any) => [{ type: 'text', text: String(value) }],
      },
      async execute() {
        const agent = ctx.agents.currentInitiator()
        if (!agent) return '(no active agent)'

        return renderPackList(await listForWorkspace(resolveWorkspace(agent)))
      },
    }),
  )

  /* ---------------- 工具 + 命令：生成接力包 ---------------- */

  const createPack = async (
    agent: Agent,
    brief?: PackBrief,
    opts: { synthesize?: boolean; trigger?: HandoffPack['trigger'] } = {},
  ): Promise<{ pack: HandoffPack; file: string; synthesized: boolean }> => {
    const ws: WorkspaceRef = resolveWorkspace(agent)
    const window = await ensureWindow(agent)
    const pressure = readPressure(ctx, agent.session, window)

    const input = {
      session: agent.session,
      workspaceDir: ws.dir,
      window,
      pressure: pressure
        ? {
            totalTokens: pressure.totalTokens,
            window: pressure.window,
            ratio: pressure.ratio,
          }
        : { totalTokens: 0, window, ratio: 0 },
    }

    // 仓库身份：先按会话 cwd 找；用户常在家目录开会话改 D: 上的仓库，
    // 这时 cwd 不是仓库，等 buildPack 推出 projectRoot 再补一次。
    let git = await gitFacts(ws.dir)

    let pack = buildPack({ ...input, brief, git, trigger: opts.trigger })
    if (!git.remote && pack.projectRoot) git = await gitFacts(pack.projectRoot)

    /**
     * 结论补写：模型没传 summary 时补一次结构化调用（一次、低温、30s 超时）。
     * 失败就保持纯事实包——和没有这个功能时行为一致。
     */
    let synthesized = false
    if (opts.synthesize && !brief?.summary && synthEnabled()) {
      const filled = await synthesizeBrief(ctx, agent, {
        goal: pack.goal,
        files: pack.files,
        commands: pack.commands,
        done: pack.done,
        deadEnds: pack.deadEnds,
        recentPrompts: pack.recentPrompts,
        pressurePercent: Math.round(pack.pressure.ratio * 100),
      })
      if (filled?.summary) {
        pack = buildPack({ ...input, brief: { ...brief, ...filled }, git, trigger: opts.trigger })
        pack.conclusionSource = 'synth'
        synthesized = true
      }
    }

    const file = await savePack(handoffRoot(ws), pack)

    // 跨机器接力：往按仓库 origin 分的目录镜像一份，换 clone 也找得回来
    if (pack.git?.remote) void mirrorLatest(handoffRemoteRoot(pack.git.remote), pack)

    return { pack, file, synthesized }
  }

  /**
   * 把 L0 摘要投递给一个正在运行的会话（handoff_save 的 toSession / /handoff --to）。
   * inject() 不唤醒 driver：目标会话要等下一条用户消息才 claim。
   */
  const deliverToSession = (sessionId: string, pack: HandoffPack): string => {
    const target = ctx.agents.get(sessionId as unknown as SessionId)
    if (!target) {
      const live = (ctx.agents.list?.() ?? []).map((a) => String(a.session.id)).slice(0, 20)
      return `⚠ 没有正在运行的会话 ${sessionId}。当前活动会话：${live.join('、') || '(无)'}`
    }
    if (String(target.session.id) === String(pack.fromSession)) {
      return `⚠ 会话 ${sessionId} 就是这份包的来源会话，无需投递。`
    }
    const injected = injectContext(target, {
      text: toL0(pack),
      fromSession: pack.fromSession,
      packId: pack.id,
      form: 'recall',
    })
    if (!injected) return `⚠ 会话 ${sessionId} 的 inject() 失败。`
    console.log(`[dsh-handoff] pack ${pack.id} 已投递给运行中的会话 ${sessionId}`)
    return `已把交接摘要投递给会话 ${sessionId}（该会话下一条消息时生效）。`
  }

  /**
   * 高压力档位自动落一份纯事实包。
   *
   * 只是兜底：模型忘了 handoff_save 时，新会话至少还有文件/命令/待办可用。
   * 不会覆盖本会话已经存过的包（那多半带模型写的结论，比事实包好）。
   */
  const autoSave = async (agent: Agent): Promise<void> => {
    try {
      const ws = resolveWorkspace(agent)
      const existing = await loadLatestPack(handoffRoot(ws))
      if (existing?.fromSession === String(agent.session.id)) return

      // 80% 时模型多半还没写结论：补一次结构化调用，失败就退回纯事实包
      const { pack, synthesized } = await createPack(agent, undefined, {
        synthesize: true,
        trigger: 'pressure',
      })
      console.log(
        `[dsh-handoff] 自动落盘 pack ${pack.id}（上下文 ${Math.round(pack.pressure.ratio * 100)}%，` +
          `${synthesized ? '结论由模型补写' : '纯事实，无模型结论'}）`,
      )
    } catch (error) {
      console.warn(`[dsh-handoff] 自动落盘失败：${(error as Error)?.message ?? error}`)
    }
  }

  ctx.tools.register(
    defineTool({
      name: 'handoff_save',
      description:
        'Save a handoff pack for the next session in this workspace. ' +
        'Files, commands and todos are derived from the session log automatically, ' +
        'but the LOG DOES NOT KNOW YOUR CONCLUSIONS: pass `summary`, `nextStep` and ' +
        '`openQuestions` yourself, otherwise the next session only gets raw facts. ' +
        'Call this before the context gets compacted.',
      parameters: {
        summary: {
          type: 'string',
          description:
            'What this session accomplished and what the conclusions are. ' +
            'This is the most valuable field — the next session reads it first. ' +
            'If omitted, one model call tries to fill it in, but your own summary is better.',
        },
        goal: {
          type: 'string',
          description: 'One line: what the session was about (overrides the auto title).',
        },
        nextStep: {
          type: 'string',
          description: 'Concrete next action, as if briefing a colleague.',
        },
        openQuestions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Unresolved decisions or questions the next session must confirm.',
        },
        refs: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Files the next session should read for details (e.g. a hand-written ' +
            'HANDOFF.md). Relative paths resolve against the workspace.',
        },
        toSession: {
          type: 'string',
          description:
            'Optional: also deliver the summary to this RUNNING session id ' +
            '(see handoff_list output / session id in the UI). Delivery takes ' +
            'effect on that session\'s next message.',
        },
        note: {
          type: 'string',
          description: 'Legacy: extra line appended to `nextStep`. Prefer `nextStep`.',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args: any, value: any) => [{ type: 'text', text: String(value) }],
      },
      async execute(args: any) {
        const agent = ctx.agents.currentInitiator()
        if (!agent) return '(no active agent)'

        const brief: PackBrief = {
          goal: str(args?.goal),
          summary: str(args?.summary),
          nextStep: str(args?.nextStep),
          openQuestions: strList(args?.openQuestions),
          refs: strList(args?.refs),
        }
        const note = str(args?.note)
        if (note) brief.nextStep = `${brief.nextStep ?? ''}\n- ${note}`.trim()

        // 没传 summary 时补一次模型调用；失败退回纯事实包
        const { pack, file, synthesized } = await createPack(agent, brief, {
          synthesize: true,
          trigger: 'manual',
        })

        const lines = [
          `交接包已保存：${file}`,
          `会话：${pack.fromSession}`,
          `目标：${pack.goal || '(空)'}`,
          `文件：${pack.files.length} 个${pack.stats.toolCalls ? `（共 ${pack.stats.toolCalls} 次工具调用）` : ''}`,
          `已完成待办：${pack.done.length} 项`,
          pack.deadEnds.length ? `失败教训：${pack.deadEnds.length} 条（下个会话不会重蹈覆辙）` : '',
          `未决问题：${pack.openQuestions.length} 条`,
          pack.refs.length ? `详细交接：${pack.refs.join('、')}` : '',
          brief.summary
            ? '结论已写入。现在开新会话，它会自动带上摘要。'
            : synthesized
              ? '结论已由模型自动补写（DSH_HANDOFF_SYNTH=0 可关）。你自己的 summary 会更准。'
              : '⚠ 没有传 summary，自动补写也没成：本次只存了事实（文件/命令/待办），结论需要下次补。',
        ].filter(Boolean)

        const toSession = str(args?.toSession)
        if (toSession) lines.push(deliverToSession(toSession, pack))

        return lines.join('\n')
      },
    }),
  )

  registerCommand(ctx, {
    name: 'handoff',
    description: '保存/查看/恢复交接包：/handoff list | show <id> | restore <id> | <一句话结论>',
    hint: '<一句话结论> | list | show <id> | restore <id>',
    // agent 由 CommandInvocation 带来（收到这条命令的那个会话），比
    // currentInitiator() 更准——多会话并存时不会指错对象。
    async run(args: string, agent: Agent) {
      const text = args ?? ''
      const ws = resolveWorkspace(agent)

      /* -------- 子命令：list / show / restore -------- */

      const subMatch = /^(list|ls|show|restore)\b\s*(\S+)?/i.exec(text.trim())
      if (subMatch) {
        const sub = (subMatch[1] ?? '').toLowerCase()
        const id = subMatch[2] ?? ''

        if (sub === 'list' || sub === 'ls') {
          return ['本工作区的交接包（新的在前）：', '', renderPackList(await listForWorkspace(ws))].join('\n')
        }

        if (!id) return `⚠ 用法：/handoff ${sub} <包 id>（先 /handoff list 看 id）`
        const pack = await loadPackForWorkspace(ws, id)
        if (!pack) return `⚠ 没找到 id 为 ${id} 的交接包（本机 + 远端镜像都没有）。`

        if (sub === 'show') {
          const stale = isStale(pack)
          return [
            `pack ${pack.id}（${pack.createdAt}，写于 ${formatAge(packAgeMs(pack))}${stale ? '，⚠ 已过期' : ''}）`,
            `来源会话：${pack.fromSession}${pack.fromTitle ? `（${pack.fromTitle}）` : ''}${pack.trigger ? `，落盘方式：${pack.trigger}` : ''}`,
            '',
            `目标：${pack.goal || '(空)'}`,
            '',
            '结论：',
            pack.progress || '(无)',
            '',
            '下一步：',
            pack.nextStep || '(无)',
            pack.deadEnds.length ? ['', '试过但不行的：', ...pack.deadEnds.map((d) => `- ${d}`)].join('\n') : undefined,
            pack.openQuestions.length
              ? ['', '未决问题：', ...pack.openQuestions.map((q) => `- ${q}`)].join('\n')
              : undefined,
            '',
            `改动文件 ${pack.files.length} 个 / 命令 ${pack.commands.length} 条 / 完成待办 ${pack.done.length} 项`,
            `其余分节用 recall_context(section=..., packId=${pack.id}) 读取。`,
          ]
            .filter((l): l is string => l != null)
            .join('\n')
        }

        // restore：把这份包的 L0 注入当前会话（startup 没接到 / 想换一份时用）
        if (pack.fromSession === String(agent.session.id)) {
          return `⚠ 包 ${pack.id} 就是当前会话存的，无需恢复到本会话。`
        }
        const stale = isStale(pack)
        const injected = injectContext(agent, {
          text: toL0(pack, { stale }),
          fromSession: pack.fromSession,
          packId: pack.id,
          form: 'recall',
        })
        if (!injected) return `⚠ 注入包 ${pack.id} 失败（inject() 抛错）。`
        restoredSessions.add(String(agent.session.id))
        console.log(`[dsh-handoff] /handoff restore：pack ${pack.id} 注入会话 ${agent.session.id}`)
        return [
          `已把交接包 ${pack.id}（会话 ${pack.fromSession}，写于 ${formatAge(packAgeMs(pack))}）注入当前会话。`,
          stale ? '⚠ 这份包已过期，摘要里带了过时警告。' : '下一条消息时生效。',
        ].join('\n')
      }

      /* -------- 默认：保存 -------- */

      let saveText = text
      let toSession: string | undefined
      const toMatch = /(?:^|\s)--to\s+(\S+)/.exec(saveText)
      if (toMatch) {
        toSession = toMatch[1]
        saveText = saveText.replace(toMatch[0], ' ').trim()
      }

      // 剩下的话直接当 summary，避免"只存事实"；没给就补一次模型调用
      const brief: PackBrief | undefined = saveText.trim() ? { summary: saveText.trim() } : undefined
      const { pack, file, synthesized } = await createPack(agent, brief, {
        synthesize: true,
        trigger: 'manual',
      })
      const window = windowFor(agent)
      const pressure = window ? readPressure(ctx, agent.session, window) : null
      const head = pressure
        ? `当前上下文 ${formatPressure(pressure)}。`
        : '当前上下文压力未知（tokenMeter 或窗口容量未就绪）。'

      const conclusion = brief?.summary
        ? '已记录（你自己写的）'
        : synthesized
          ? '已记录（模型自动补写）'
          : '未记录（/handoff <一句话结论> 可补）'

      const lines = [
        `${head}交接包已写入：`,
        file,
        '',
        `- 目标：${pack.goal || '(空)'}`,
        `- 结论：${conclusion}`,
        `- 改动文件：${pack.files.length} 个`,
        `- 命令：${pack.commands.length} 条`,
        `- 已完成待办：${pack.done.length} 项`,
        pack.deadEnds.length ? `- 失败教训：${pack.deadEnds.length} 条` : '',
        `- 未决问题：${pack.openQuestions.length} 条`,
        '',
        '开一个新会话即可自动接续；需要细节时模型会调用 recall_context。',
      ].filter(Boolean)

      if (toSession) lines.push(deliverToSession(toSession, pack))
      return lines.join('\n')
    },
  })

  /* ---------------- 启动日志 ---------------- */

  console.log(`[dsh-handoff] loaded · packs=${join(dshHome(), 'handoff')}`)
  if (process.env.DSH_HANDOFF_WINDOW) {
    console.log(`[dsh-handoff] window 由 DSH_HANDOFF_WINDOW 固定为 ${process.env.DSH_HANDOFF_WINDOW}`)
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function strList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const list = value
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter(Boolean)
  return list.length ? list : undefined
}

export type { HandoffPack, Pressure }

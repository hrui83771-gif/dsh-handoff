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

import { join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { buildPack, type PackBrief } from './distill.js'
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
  loadLatestPack,
  readSection,
  savePack,
  toL0,
  type HandoffPack,
} from './pack.js'
import { injectContext, onSessionEvent, registerCommand } from './compat.js'
import { dshHome, handoffRoot, resolveWorkspace, type WorkspaceRef } from './workspace.js'

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
    const pack = await loadLatestPack(handoffRoot(ws))
    if (!pack) return
    if (pack.fromSession === String(agent.session.id)) return // 自己交给自己，跳过

    const injected = injectContext(agent, {
      text: toL0(pack),
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

  /* ---------------- ① 压力监测 ---------------- */

  ctx.on('agent/disposed', ({ agent }) => {
    const id = String(agent.session.id)
    lastBand.delete(id)
    lastMeasure.delete(id)
  })

  onSessionEvent(ctx, (session, event) => {
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

  ctx.tools.register(
    defineTool({
      name: 'recall_context',
      description:
        'Read a section of the handoff pack carried over from the previous session. ' +
        'Use this instead of guessing what happened before.',
      parameters: {
        section: {
          type: 'string',
          required: true,
          description: `Which section to read: ${PACK_SECTIONS.join(' | ')}`,
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
        const pack = await loadLatestPack(handoffRoot(ws))
        if (!pack) return '(no handoff pack for this workspace)'

        const body = readSection(pack, args.section)
        if (body == null) return `(unknown section: ${args.section})`

        return (
          `# ${args.section}（来自会话 ${pack.fromSession}，${pack.createdAt}）\n\n` +
          (body || '(empty)')
        )
      },
    }),
  )

  /* ---------------- 工具 + 命令：生成接力包 ---------------- */

  const createPack = async (
    agent: Agent,
    brief?: PackBrief,
  ): Promise<{ pack: HandoffPack; file: string }> => {
    const ws: WorkspaceRef = resolveWorkspace(agent)
    const window = await ensureWindow(agent)
    const pressure = readPressure(ctx, agent.session, window)

    const pack = buildPack({
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
      brief,
    })

    const file = await savePack(handoffRoot(ws), pack)
    return { pack, file }
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

      const { pack } = await createPack(agent)
      console.log(
        `[dsh-handoff] 自动落盘 pack ${pack.id}（上下文 ${Math.round(pack.pressure.ratio * 100)}%，纯事实，无模型结论）`,
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
            'This is the most valuable field — the next session reads it first.',
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

        const { pack, file } = await createPack(agent, brief)
        const lines = [
          `交接包已保存：${file}`,
          `会话：${pack.fromSession}`,
          `目标：${pack.goal || '(空)'}`,
          `文件：${pack.files.length} 个${pack.stats.toolCalls ? `（共 ${pack.stats.toolCalls} 次工具调用）` : ''}`,
          `已完成待办：${pack.done.length} 项`,
          `未决问题：${pack.openQuestions.length} 条`,
          pack.refs.length ? `详细交接：${pack.refs.join('、')}` : '',
          brief.summary
            ? '结论已写入。现在开新会话，它会自动带上摘要。'
            : '⚠ 没有传 summary：本次只存了事实（文件/命令/待办），结论需要下次补。',
        ].filter(Boolean)
        return lines.join('\n')
      },
    }),
  )

  registerCommand(ctx, {
    name: 'handoff',
    description: '保存当前会话的交接包，供下一个会话自动接续',
    async run(args: string) {
      const agent = ctx.agents.currentInitiator()
      if (!agent) return '当前没有活动会话。'

      // /handoff <一句话结论> 直接把参数当 summary，避免"只存事实"
      const brief: PackBrief | undefined = args?.trim() ? { summary: args.trim() } : undefined
      const { pack, file } = await createPack(agent, brief)
      const window = windowFor(agent)
      const pressure = window ? readPressure(ctx, agent.session, window) : null
      const head = pressure
        ? `当前上下文 ${formatPressure(pressure)}。`
        : '当前上下文压力未知（tokenMeter 或窗口容量未就绪）。'

      return [
        `${head}交接包已写入：`,
        file,
        '',
        `- 目标：${pack.goal || '(空)'}`,
        `- 结论：${pack.progress ? '已记录' : '未记录（/handoff <一句话结论> 可补）'}`,
        `- 改动文件：${pack.files.length} 个`,
        `- 命令：${pack.commands.length} 条`,
        `- 已完成待办：${pack.done.length} 项`,
        `- 未决问题：${pack.openQuestions.length} 条`,
        '',
        '开一个新会话即可自动接续；需要细节时模型会调用 recall_context。',
      ].join('\n')
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

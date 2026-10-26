/**
 * distill.ts —— 生成接力包（确定性派生 + 模型补写结论）。
 *
 * 为什么是混合模式：
 *   事件日志是**事实**的权威来源，但完全不知道**结论**。
 *   v0.1 只看投影的头尾，于是 goal 永远是第一条消息、files 几乎为空；
 *   v0.2 改读原始事件后 files/commands/todos 都准了，但 progress 只能拿
 *   assistant 的散文拼，经常拼出"复述用户原话"这种垃圾。
 *
 *   真正知道"这次做完了什么、下一步是什么"的只有当时那个模型。
 *   所以：事实（文件/命令/待办/标题/压力）一律从日志派生，免费且不会编；
 *        结论（summary/nextStep/openQuestions/refs）由 handoff_save 传入，
 *        模型不传就退化成纯事实包，绝不拿散文冒充结论。
 *
 * 数据来源：
 *   session.snapshotEvents()  tool/call（arguments 是 JSON 字符串）
 *                             todo/write（模型自己维护的权威清单）
 *                             session/title（比第一条消息更适合当 goal）
 *   session.deriveMessages()  文本，且只认 source.kind === 'user' 的真实用户消息
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

import type { Session } from '@deepseek-ai/dsh-session'

import type { GitFacts } from './git.js'
import { hasGitFacts } from './git.js'
import type { HandoffPack, PackStats, PackTodo } from './pack.js'
import { PACK_VERSION, buildSections, truncate } from './pack.js'

/** 只从这些 key 取路径：不再把正文里出现的文件名当成"改动" */
const PATH_KEY = /^(path|paths|file|files|filepath|file_path|filename|target|targets)$/i

/**
 * 会改动文件的工具。
 *
 * 必须按**词**匹配而不是前缀：真实工具叫 `multi_edit`、`str_replace_editor`、
 * `apply_patch`，前缀匹配会全部漏掉（v0.2 的 files 只有 1 条就是这么来的）。
 * 同时排除 `todo_write` —— 名字里有 write，但它只写待办清单，不碰文件。
 */
const MUTATING =
  /(^|[^a-z0-9])(edit|write|create|delete|remove|move|rename|patch|replace|insert|append|mkdir|touch|copy|save)([^a-z0-9]|$)/i
const NOT_MUTATING = /^(todo_?write|memory_?write|write_?todo)/i

/** 执行命令的工具：只取命令，不从命令行里猜路径 */
const SHELL = /^(pwsh|powershell|bash|sh|zsh|cmd|shell|run|exec|terminal)/i

const FILE_EXT =
  /(^|[\\/])[\w.\- ]+\.(ts|tsx|js|jsx|mjs|cjs|json|md|mdx|py|go|rs|java|kt|c|h|cpp|hpp|cs|rb|php|swift|css|scss|less|html|vue|svelte|yml|yaml|toml|ini|sh|ps1|bat|sql|txt|log|tmpl|lock)$/i

const IGNORED = /(^|[\\/])(node_modules|\.git|dist|build|\.next|target|__pycache__)([\\/]|$)/

/** 交接动作本身不该变成"用户目标"或"最近在做的事" */
const META_PROMPT = /(handoff_save|\/handoff|交接包|把当前会话存成)/i

/** 构建/测试/提交类命令：接力时真正需要复现的就是这些 */
const BUILD_LIKE =
  /(^|[\s;&|(])(go\s+(build|test|vet|run|mod|generate)|npm|pnpm|yarn|npx|node|tsc|python3?|pytest|make|cargo|dotnet|gradle|mvn|web_build|git\s+(commit|push|status|diff|log|add))(\s|$)/i

/** 去掉开头的 `cd xxx;` / `$env:X=...;` 赋值，看真正的命令是什么 */
const LEADING_NOISE = /^\s*((cd\s+[^;&|]+|\$env:\w+='[^']*'|set\s+\w+=[^;&|]*)\s*[;&|]+\s*)+/i

/* ------------------------------------------------------------------ *
 * 命令脱敏
 *
 * pack 会落盘到 ~/.dsh/handoff/ 再注入新会话——命令原文里混着的密钥会跟着
 * 一起持久化。宁可错杀（`--token=x` 被打码）也不留真值。
 * ------------------------------------------------------------------ */

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // Authorization: Bearer xxx / Basic xxx
  [/\b(bearer|basic)\s+[A-Za-z0-9._\-+/=]{8,}/gi, '$1 ***'],
  // sk-xxx / ghp_xxx / xoxb-xxx 等常见 token 形状
  [/\b(sk|pk|rk|ghp|gho|ghs|github_pat|xox[baprs])[-_][A-Za-z0-9._-]{8,}/g, '$1-***'],
  // key=value / "api_key": "xxx"：变量名里带 key/token/secret/password 的一律打码
  [
    /((?:[A-Za-z0-9_.-]*(?:api[-_]?key|secret|token|passw(?:or)?d|credential|authorization)[A-Za-z0-9_.-]*)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|`[^`]*`|[^\s;&|]+)/gi,
    '$1***',
  ],
  // URL 里的密码：scheme://user:pass@host
  [/([a-z][a-z0-9+.-]*:\/\/[^:@/\s]+):[^@/\s]+@/gi, '$1:***@'],
]

export function redactCommand(cmd: string): string {
  let out = cmd
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement)
  return out
}

/** 模型对本次会话的结论。全部可选：不传就是纯事实包。 */
export interface PackBrief {
  /** 一句话说明这次会话在做什么（覆盖自动取的标题） */
  goal?: string
  /** 做完了什么 / 结论是什么。这是 pack 里最有价值的一段。 */
  summary?: string
  /** 下一步具体动作 */
  nextStep?: string
  /** 悬而未决、需要下个会话确认的问题 */
  openQuestions?: string[]
  /** 需要下个会话去读的文件（比如手写的交接文档），相对路径按工作区解析 */
  refs?: string[]
}

export interface DistillInput {
  /** 官方 Session 类型；内部派生仍按形状防御性读取（投影/事件可能缺席） */
  session: Session
  workspaceDir: string
  window: number
  pressure: { totalTokens: number; window: number; ratio: number }
  brief?: PackBrief
  /** 仓库身份（remote/branch/commit），跨机器接力用；没有就不写进 pack */
  git?: GitFacts
}

export function buildPack(input: DistillInput): HandoffPack {
  const messages: any[] = safeMessages(input.session)
  const events: any[] = safeEvents(input.session)
  const brief = input.brief ?? {}

  /* ---------------- 文本：来自投影，只认真实用户消息 ---------------- */

  const prompts: string[] = []
  const assistantTexts: string[] = []

  for (const message of messages) {
    if (!Array.isArray(message?.content)) continue
    const text = textOf(message.content)
    if (!text) continue

    if (message.role === 'user') {
      // dsh 会以 user 角色注入 runtime-context / time-context / skill-catalog，
      // 它们的 source.kind 不是 'user'，混进来会把 goal 和 recentPrompts 弄脏。
      if (message.source?.kind === 'user') prompts.push(text)
    } else if (message.role === 'assistant') {
      assistantTexts.push(text)
    }
  }

  /* ---------------- 结构化信息：来自原始事件日志 ---------------- */

  const fileHits = new Map<string, number>()
  const commands: string[] = []
  const todoHistory: PackTodo[][] = []
  let title = ''
  let turns = 0
  let toolCalls = 0

  for (const event of events) {
    const type = event?.type

    if (type === 'tool/call') {
      toolCalls += 1
      const turn = Number(event.data?.turn ?? 0)
      if (Number.isFinite(turn) && turn > turns) turns = turn

      const name = String(event.data?.name ?? '')
      const args = parseArgs(event.data?.arguments)
      if (!args) continue

      if (SHELL.test(name)) {
        const cmd = firstLine(args.command ?? args.cmd ?? args.script)
        if (cmd) pushUnique(commands, truncate(redactCommand(cmd), 200))
        continue
      }
      if (!MUTATING.test(name) || NOT_MUTATING.test(name)) continue
      collectPaths(args, fileHits)
    } else if (type === 'todo/write') {
      if (Array.isArray(event.data?.todos)) {
        todoHistory.push(normalizeTodos(event.data.todos))
      }
    } else if (type === 'session/title') {
      if (typeof event.data?.title === 'string' && event.data.title.trim()) {
        title = event.data.title.trim()
      }
    } else if (type === 'turn/end') {
      const turn = Number(event.data?.turn ?? 0)
      if (Number.isFinite(turn) && turn > turns) turns = turn
    }
  }

  // snapshotEvents 不可用时的兜底：从投影里的 tool-call 块取同样的信息
  if (fileHits.size === 0 && commands.length === 0) {
    for (const message of messages) collectFromMessage(message, fileHits, commands)
  }

  const files = rankFiles(fileHits)
  const { done, pending } = mergeTodos(todoHistory)

  /**
   * 会话的 workspace 不一定等于真正的项目目录（用户常在家目录开会话去改 D: 上的仓库）。
   * 从改动最多的文件里推一个公共根，给 refs 的相对路径和 L0 的提示用。
   */
  const projectRoot = commonDir(files.slice(0, 5))

  /* ---------------- 组装 ---------------- */

  const realPrompts = prompts.filter((p) => !META_PROMPT.test(p))
  const lastAssistant = assistantTexts.at(-1) ?? ''

  const goal = truncate(brief.goal?.trim() || title || realPrompts[0] || prompts[0] || '', 300)
  const focus = truncate(realPrompts.at(-1) ?? '', 400)

  const nextStep = composeNextStep(brief.nextStep, pending, lastAssistant)

  const stats: PackStats = {
    turns,
    toolCalls,
    files: files.length,
    commands: commands.length,
  }

  const progress =
    brief.summary?.trim() ||
    (realPrompts.length || toolCalls
      ? buildActivity(stats, files, done)
      : '')

  const openQuestions = brief.openQuestions?.length
    ? brief.openQuestions.map((q) => truncate(q.trim(), 200)).filter(Boolean).slice(0, 10)
    : extractQuestions(lastAssistant)

  const refs = (brief.refs ?? [])
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => resolveRef(r, input.workspaceDir, projectRoot))
    .slice(0, 10)

  const base: Omit<HandoffPack, 'sections'> = {
    version: PACK_VERSION,
    id: createHash('sha1')
      .update(`${input.session?.id ?? 'unknown'}:${Date.now()}`)
      .digest('hex')
      .slice(0, 10),
    createdAt: new Date().toISOString(),
    fromSession: String(input.session?.id ?? 'unknown'),
    fromTitle: title || undefined,
    workspace: input.workspaceDir,
    projectRoot,
    git: hasGitFacts(input.git) ? input.git : undefined,
    pressure: input.pressure,
    goal,
    focus,
    progress,
    conclusionSource: brief.summary?.trim() ? 'brief' : 'activity',
    nextStep,
    files: files.slice(0, 200),
    commands: rankCommands(commands).slice(0, 40),
    done: done.slice(0, 40),
    refs,
    openQuestions,
    recentPrompts: realPrompts.slice(-3).map((p) => truncate(p, 400)),
    stats,
  }

  return { ...base, sections: buildSections(base) }
}

/* ------------------------------------------------------------------ */

function safeMessages(session: any): any[] {
  try {
    const derive = session?.deriveMessages
    if (typeof derive !== 'function') return []
    const result = derive.call(session)
    return Array.isArray(result) ? result : []
  } catch {
    return []
  }
}

function safeEvents(session: any): any[] {
  try {
    const snapshot = session?.snapshotEvents
    if (typeof snapshot !== 'function') return []
    const result = snapshot.call(session)
    return Array.isArray(result) ? result : []
  } catch {
    return []
  }
}

function parseArgs(raw: unknown): any {
  if (raw && typeof raw === 'object') return raw
  if (typeof raw !== 'string') return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function firstLine(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.split('\n')[0]?.trim() ?? ''
}

function pushUnique(list: string[], value: string): void {
  if (value && !list.includes(value)) list.push(value)
}

function normalizeTodos(raw: any[]): PackTodo[] {
  return raw
    .filter((t) => t && typeof t.content === 'string')
    .map((t) => ({
      content: t.content.trim(),
      status: typeof t.status === 'string' ? t.status : 'pending',
    }))
    .filter((t) => t.content)
}

function textOf(blocks: any[]): string {
  return blocks
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
    .trim()
}

/** 只在明确的路径参数上取文件，正文里提到文件名不算改动 */
function collectPaths(node: unknown, out: Map<string, number>, key?: string): void {
  if (node == null) return

  if (typeof node === 'string') {
    if (key && PATH_KEY.test(key)) addFile(node, out)
    return
  }

  if (Array.isArray(node)) {
    for (const item of node) collectPaths(item, out, key)
    return
  }

  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      collectPaths(v, out, k)
    }
  }
}

/** 投影兜底：tool-call 块的 arguments 同样是 JSON 字符串 */
function collectFromMessage(
  message: any,
  files: Map<string, number>,
  commands: string[],
): void {
  const blocks = Array.isArray(message?.content) ? message.content : []
  for (const block of blocks) {
    if (block?.type !== 'tool-call') continue
    const name = String(block.name ?? '')
    const args = parseArgs(block.arguments)
    if (!args) continue

    if (SHELL.test(name)) {
      const cmd = firstLine(args.command ?? args.cmd ?? args.script)
      if (cmd) pushUnique(commands, truncate(redactCommand(cmd), 200))
      continue
    }
    if (MUTATING.test(name) && !NOT_MUTATING.test(name)) collectPaths(args, files)
  }
}

function looksLikePath(value: string): boolean {
  if (value.length > 260 || value.includes('\n')) return false
  if (/^https?:\/\//i.test(value)) return false
  return FILE_EXT.test(value)
}

function addFile(value: string, files: Map<string, number>): void {
  const path = value.replace(/\\/g, '/').replace(/^\.\//, '').trim()
  if (!path) return
  if (IGNORED.test(path)) return
  if (!looksLikePath(path)) return
  files.set(path, (files.get(path) ?? 0) + 1)
}

/**
 * refs 的相对路径解析：先按 workspace，再按从改动文件推出来的项目根。
 * 两者都不是就按 workspace 拼——至少路径形状是对的，用户能看出意图。
 */
function resolveRef(ref: string, workspaceDir: string, projectRoot?: string): string {
  if (isAbsolute(ref)) return ref

  const primary = join(workspaceDir, ref)
  if (!projectRoot || projectRoot === workspaceDir) return primary
  if (existsSync(primary)) return primary

  const alt = join(projectRoot, ref)
  if (existsSync(alt)) return alt
  return primary
}

/** 从若干文件路径里取公共目录；不足两段（比如只有 D:/）就当没有 */
function commonDir(paths: string[]): string | undefined {
  if (paths.length < 2) return undefined

  const dirs = paths.map((p) => p.replace(/\\/g, '/').split('/').slice(0, -1))
  const first = dirs[0]
  if (!first) return undefined

  let i = 0
  while (i < first.length && dirs.every((d) => d[i] === first[i])) i += 1
  if (i < 2) return undefined

  return join(...first.slice(0, i))
}

/** 改得最多的文件排前面：接力时最先要看的就是这些 */
function rankFiles(hits: Map<string, number>): string[] {
  return [...hits.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([path]) => path)
}

/**
 * 命令排序：先把 `cd xxx;` 这类前缀剥掉，再看真正的命令是什么。
 * 构建/测试/提交类排前面；纯探查（Get-ChildItem、pwd、Get-Content）沉底。
 * 只排序不丢弃——recall_context('commands') 仍然能看到全部。
 */
function rankCommands(commands: string[]): string[] {
  const seen = new Set<string>()
  const scored: Array<{ cmd: string; score: number }> = []

  for (const cmd of commands) {
    const body = cmd.replace(LEADING_NOISE, '').trim()
    const key = body.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)

    let score = 0
    if (BUILD_LIKE.test(body)) score = 2
    if (/^(go|npm|pnpm|yarn|node|tsc|python3?|pytest|make|cargo|dotnet|gradle|mvn|git)\b/i.test(body)) {
      score = 3
    }
    scored.push({ cmd, score })
  }

  // sort 是稳定的：同分保持时间顺序
  return scored.sort((a, b) => b.score - a.score).map((item) => item.cmd)
}

/**
 * 待办合并。
 *
 * todo/write 每次写的是**整份清单**，不是增量。所以：
 *   done    = 所有出现过的条目里，最后一次观察到的状态是 completed 的（按首次出现排序）
 *   pending = 最后一份清单里还没完成的
 * 这样既不会丢掉中途完成又被删掉的条目，也不会把上一阶段删掉的条目当成待办。
 */
function mergeTodos(history: PackTodo[][]): { done: string[]; pending: string[] } {
  const latest = new Map<string, string>()
  const firstSeen: string[] = []

  for (const list of history) {
    for (const item of list) {
      if (!latest.has(item.content)) firstSeen.push(item.content)
      latest.set(item.content, item.status)
    }
  }

  const lastList = history.at(-1) ?? []
  const done = firstSeen.filter((content) => latest.get(content) === 'completed')
  const pending = lastList
    .filter((item) => item.status !== 'completed')
    .map((item) => item.content)

  return { done, pending }
}

/**
 * 下一步：模型给了就用模型的，同时把清单里还没完成的项附在后面。
 * 模型没给就用清单，最后才退到从最后一条 assistant 消息里找 "下一步：" 标记。
 */
function composeNextStep(
  brief: string | undefined,
  pending: string[],
  lastAssistant: string,
): string {
  const own = brief?.trim()
  if (own) {
    const rest = pending.length
      ? `\n未完成待办：\n${pending.slice(0, 8).map((t) => `- ${t}`).join('\n')}`
      : ''
    return truncate(`${own}${rest}`, 900)
  }

  if (pending.length) {
    return truncate(pending.slice(0, 8).map((t) => `- ${t}`).join('\n'), 900)
  }
  return extractNextStep(lastAssistant)
}

/** 没有模型结论时的进度：只陈述事实，不复述散文 */
function buildActivity(stats: PackStats, files: string[], done: string[]): string {
  const parts: string[] = []
  if (stats.turns) parts.push(`${stats.turns} 轮`)
  if (stats.toolCalls) parts.push(`${stats.toolCalls} 次工具调用`)
  if (stats.files) parts.push(`改动 ${stats.files} 个文件`)

  const lines = [`本会话 ${parts.join('、') || '无活动记录'}。`]
  if (done.length) lines.push(`完成的待办 ${done.length} 项。`)
  const top = files.slice(0, 5)
  if (top.length) lines.push(`改动最多的文件：${top.join('、')}`)
  return truncate(lines.join('\n'), 600)
}

function extractNextStep(text: string): string {
  const lines = text.split('\n')

  const todos = lines
    .filter((l) => /^\s*[-*]\s*\[\s*\]/.test(l))
    .map((l) => l.replace(/^\s*[-*]\s*\[\s*\]\s*/, '').trim())
    .filter(Boolean)
  if (todos.length) return todos.slice(0, 3).map((t) => `- ${t}`).join('\n')

  const marker = lines.find((l) =>
    /^\s*(next step|next|todo|to do|下一步|接下来)\s*[:：]/i.test(l),
  )
  return marker ? truncate(stripLabel(marker), 300) : ''
}

function extractQuestions(text: string): string[] {
  const seen = new Set<string>()
  const result: string[] = []

  for (const raw of text.split('\n')) {
    const line = stripLabel(raw.replace(/^\s*[-*]\s*/, '').trim())
    if (!line || line.length > 200) continue
    if (!/[?？]/.test(line)) continue
    if (seen.has(line)) continue
    seen.add(line)
    result.push(line)
    if (result.length >= 5) break
  }
  return result
}

/** 去掉 "未决问题：" / "Open questions:" 这类重复标签 */
function stripLabel(line: string): string {
  return line
    .replace(/^(未决问题|待确认|open questions?|questions?|q)\s*[:：]\s*/i, '')
    .trim()
}

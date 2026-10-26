/**
 * pack.ts —— 接力包的数据结构与落盘。
 *
 * 设计要点：L0 常驻注入（小），L1 分节按需取（中），L2 指回原会话（大）。
 * 全量注入等于把旧会话的膨胀问题搬到新会话，所以这里强制分层。
 */

import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const PACK_VERSION = 3
export const PACK_SECTIONS = [
  'goal',
  'focus',
  'progress',
  'done',
  'nextStep',
  'files',
  'commands',
  'refs',
  'openQuestions',
  'prompts',
] as const

export type PackSection = (typeof PACK_SECTIONS)[number]

/** 模型自己维护的 todo 项（来自 todo/write 事件） */
export interface PackTodo {
  content: string
  status: string
}

/** 会话规模，给新会话一个"上一个会话干了多少活"的量感 */
export interface PackStats {
  turns: number
  toolCalls: number
  files: number
  commands: number
}

export interface HandoffPack {
  version: number
  id: string
  createdAt: string
  /** 来源会话，便于 L2 回溯 */
  fromSession: string
  fromTitle?: string
  workspace: string
  /** 从改动文件推出的项目根；workspace 与真实项目不同目录时用得上 */
  projectRoot?: string
  pressure: {
    totalTokens: number
    window: number
    ratio: number
  }
  /** 会话标题（dsh 自动生成），模型可用 brief.goal 覆盖 */
  goal: string
  /** 交接时正在做的事：最后一条真实用户消息 */
  focus: string
  /** 模型写的结论摘要；没有模型结论时是事实性活动统计 */
  progress: string
  nextStep: string
  /** 改动过的文件，按改动次数排序 */
  files: string[]
  /** 执行过的命令，构建/测试类排前面 */
  commands: string[]
  /** todo/write 里已完成的项目 */
  done: string[]
  /** 需要下个会话直接去读的文件（手写交接文档等），绝对路径 */
  refs: string[]
  openQuestions: string[]
  /** 最近几轮用户原话，防止摘要丢口味 */
  recentPrompts: string[]
  stats: PackStats
  /** 由 L0 之外的字段组装的分节文本 */
  sections: Record<string, string>
}

const KEEP_PACKS = 20
/** L0 预算，按字符近似（中文约 1 字 1 token，英文约 4 字符 1 token） */
const L0_BUDGET_CHARS = 4000

export async function savePack(dir: string, pack: HandoffPack): Promise<string> {
  await mkdir(dir, { recursive: true })

  const stamp = pack.createdAt.replace(/[:.]/g, '-')
  const file = join(dir, `${stamp}_${pack.id}.json`)
  const body = JSON.stringify(pack, null, 2)

  await writeFile(file, body, 'utf8')
  await writeFile(join(dir, 'latest.json'), body, 'utf8')
  await prune(dir)
  return file
}

export async function loadLatestPack(dir: string): Promise<HandoffPack | null> {
  try {
    const raw = await readFile(join(dir, 'latest.json'), 'utf8')
    const parsed = JSON.parse(raw) as HandoffPack
    return parsed?.version === PACK_VERSION ? parsed : null
  } catch {
    return null
  }
}

export function readSection(pack: HandoffPack, section: string): string | null {
  if (!(PACK_SECTIONS as readonly string[]).includes(section)) return null
  return pack.sections[section] ?? null
}

/**
 * L0：新会话自动注入的那一小段。
 *
 * 只放"不看就会走错路"的信息，其余全部留给 recall_context。
 * 按优先级整块累加，超预算就整块跳过——不切半行，免得把"下一步"截成半句。
 */
export function toL0(pack: HandoffPack): string {
  const list = (items: string[], max: number, bullet = '- ') =>
    items.slice(0, max).map((i) => `${bullet}${i}`).join('\n')

  const candidates: Array<[string, string]> = []
  const add = (title: string, body: string) => {
    const text = (body ?? '').trim()
    if (text) candidates.push([title, text])
  }

  // 顺序就是重要性顺序
  add('目标', pack.goal)
  add('交接点（最后一条用户请求）', pack.focus)
  add('详细交接（先读这些文件）', list(pack.refs, 5))
  add('下一步', pack.nextStep)
  add('本次会话的结论', pack.progress)
  add('已完成', list(pack.done, 15))
  add('改动最多的文件', list(pack.files, 20))
  add('未决问题', list(pack.openQuestions, 8))

  const scale =
    pack.stats?.turns || pack.stats?.toolCalls
      ? `上一个会话共 ${pack.stats.turns || '?'} 轮、${pack.stats.toolCalls || 0} 次工具调用、改动 ${pack.stats.files || 0} 个文件。`
      : ''

  const project =
    pack.projectRoot && pack.projectRoot !== pack.workspace
      ? `主项目目录：${pack.projectRoot}。`
      : ''

  const header =
    `这是上一个会话的交接摘要（会话 ${pack.fromSession}` +
    (pack.fromTitle ? `，标题「${pack.fromTitle}」` : '') +
    `，交接时上下文 ${Math.round(pack.pressure.ratio * 100)}%）。${scale}${project}` +
    `摘要只保留结论，可能不完整：需要细节时调用 recall_context（` +
    `focus / progress / done / files / commands / refs / prompts / openQuestions），` +
    `不要凭摘要臆测未列出的内容。`

  let out = header
  for (const [title, body] of candidates) {
    const block = `\n\n## ${title}\n${body}`
    if (out.length + block.length > L0_BUDGET_CHARS) continue
    out += block
  }
  return out
}

export function buildSections(pack: Omit<HandoffPack, 'sections'>): Record<string, string> {
  return {
    goal: pack.goal,
    focus: pack.focus,
    progress: pack.progress,
    done: pack.done.map((d) => `- ${d}`).join('\n'),
    nextStep: pack.nextStep,
    files: pack.files.map((f) => `- ${f}`).join('\n'),
    commands: pack.commands.map((c) => `- \`${c}\``).join('\n'),
    refs: pack.refs.map((r) => `- ${r}`).join('\n'),
    openQuestions: pack.openQuestions.map((q) => `- ${q}`).join('\n'),
    prompts: pack.recentPrompts.map((p, i) => `### ${i + 1}\n${p}`).join('\n\n'),
  }
}

async function prune(dir: string): Promise<void> {
  try {
    const entries = (await readdir(dir))
      .filter((f) => f.endsWith('.json') && f !== 'latest.json')
      .sort()
    const stale = entries.slice(0, Math.max(0, entries.length - KEEP_PACKS))
    await Promise.all(stale.map((f) => unlink(join(dir, f)).catch(() => undefined)))
  } catch {
    /* 清理失败不影响主流程 */
  }
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max - 1)}…`
}

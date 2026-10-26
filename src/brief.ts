/**
 * brief.ts —— 模型没写结论时，用一次结构化调用补上。
 *
 * 事件日志能派生事实（文件/命令/待办/标题），派生不出"做完了什么、下一步
 * 该怎么走"。handoff_save 没传 summary、或者 80% 自动落盘时，这里补一次
 * ctx.llm.stream()：
 *
 *   - 只调一次、低温、限长、30 秒超时
 *   - 任何失败（适配器缺席、超时、输出不是 JSON）→ 返回 null，
 *     调用方退回纯事实包，行为和没有这个文件时完全一致
 *   - DSH_HANDOFF_SYNTH=0 关掉
 *
 * 这是"事实自动、结论手写"原则的补充而不是推翻：模型主动写了就用模型的，
 * 只有它没写时才补——补出来的结论标 conclusionSource: 'synth'，L0/列表里
 * 能看出这不是会话中亲口说的。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'

import type { PackBrief } from './distill.js'

/** 补写用的事实：全部来自 buildPack 已经派生好的字段，不重复扫日志 */
export interface BriefFacts {
  goal: string
  files: string[]
  commands: string[]
  done: string[]
  recentPrompts: string[]
  pressurePercent: number
}

const TIMEOUT_MS = 30_000
const MAX_OUTPUT_CHARS = 4_000
const MAX_LIST_ITEMS = 8

/** DSH_HANDOFF_SYNTH=0 时关闭（默认开） */
export function synthEnabled(): boolean {
  return process.env.DSH_HANDOFF_SYNTH !== '0'
}

const SYSTEM = [
  'You write handoff notes for the NEXT coding session.',
  'You are given raw facts from a finished session (files touched, commands run, todos completed, recent user prompts).',
  'Infer what was accomplished and what to do next, but NEVER invent files, commands or decisions that are not in the facts.',
  'Write summary and nextStep in the same language as the recent prompts.',
  'Answer with ONE JSON object only, no prose, no markdown fence:',
  '{"summary": "...", "nextStep": "...", "openQuestions": ["..."]}',
  'Omit any field you cannot ground in the facts.',
].join('\n')

export function buildPrompt(facts: BriefFacts): string {
  const lines = [
    `Goal (session title): ${facts.goal || '(none)'}`,
    `Context used at handoff: ${facts.pressurePercent}%`,
  ]
  if (facts.files.length) lines.push(`Files touched:\n${facts.files.slice(0, MAX_LIST_ITEMS).map((f) => `- ${f}`).join('\n')}`)
  if (facts.commands.length) lines.push(`Commands run:\n${facts.commands.slice(0, MAX_LIST_ITEMS).map((c) => `- ${c}`).join('\n')}`)
  if (facts.done.length) lines.push(`Todos completed:\n${facts.done.slice(0, MAX_LIST_ITEMS).map((d) => `- ${d}`).join('\n')}`)
  if (facts.recentPrompts.length) lines.push(`Recent user prompts:\n${facts.recentPrompts.map((p) => `- ${p}`).join('\n')}`)
  return lines.join('\n\n')
}

/**
 * 调一次模型补结论。失败返回 null（调用方退回纯事实包）。
 */
export async function synthesizeBrief(
  ctx: Context,
  agent: Agent,
  facts: BriefFacts,
): Promise<PackBrief | null> {
  if (!synthEnabled()) return null

  const { provider, model } = agent.options ?? {}
  if (!provider || !model) return null

  // 没有任何可总结的活动就别白烧一次请求
  if (!facts.recentPrompts.length && !facts.files.length && !facts.done.length) return null

  try {
    const stream = ctx.llm.stream({
      provider,
      model,
      system: SYSTEM,
      // RequestUserInput：一次性请求，不带 id / source
      messages: [{ role: 'user', content: [{ type: 'text', text: buildPrompt(facts) }] }],
      temperature: 0.2,
      maxTokens: 600,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })

    let text = ''
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
        text += chunk.text
        if (text.length > MAX_OUTPUT_CHARS) break
      }
    }
    return parseBrief(text)
  } catch {
    return null
  }
}

/** 从模型输出里抠出 JSON 并校验形状；任何不对劲都返回 null */
export function parseBrief(text: string): PackBrief | null {
  if (!text) return null

  const match = /\{[\s\S]*\}/.exec(text)
  if (!match) return null

  let raw: unknown
  try {
    raw = JSON.parse(match[0])
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null

  const obj = raw as Record<string, unknown>
  const brief: PackBrief = {}

  if (typeof obj.summary === 'string' && obj.summary.trim()) {
    brief.summary = obj.summary.trim().slice(0, 1_200)
  }
  if (typeof obj.nextStep === 'string' && obj.nextStep.trim()) {
    brief.nextStep = obj.nextStep.trim().slice(0, 900)
  }
  if (Array.isArray(obj.openQuestions)) {
    const questions = obj.openQuestions
      .filter((q): q is string => typeof q === 'string' && !!q.trim())
      .map((q) => q.trim().slice(0, 200))
      .slice(0, 8)
    if (questions.length) brief.openQuestions = questions
  }

  // 一个字段都没抠出来就当失败
  return brief.summary ?? brief.nextStep ?? brief.openQuestions ? brief : null
}

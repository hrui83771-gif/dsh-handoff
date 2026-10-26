/**
 * meter.ts —— 上下文压力监测。
 *
 * 用 ctx.tokenMeter.measure()：这是 dsh 官方的 replay 快照，会复用
 * 最近一次成功请求的 provider usage 作为锚点，比自己数字符准得多。
 *
 * 它是 O(surface) 的，所以只在 step/end 或 turn/end 采一次，
 * 绝不在 assistant-stream 的 chunk 里调。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'

/** 交接建议线：必须早于 compaction 的触发阈值，否则生成 pack 时已经很脏 */
export const THRESHOLDS = {
  warn: 0.6,
  high: 0.8,
} as const

/** 解析不出真实窗口时的兜底值，只在日志里明确提示过之后才用 */
export const DEFAULT_WINDOW_TOKENS = 1_000_000

export type PressureBand = 'ok' | 'warn' | 'high'

export interface Pressure {
  totalTokens: number
  surfaceTokens: number
  window: number
  ratio: number
  band: PressureBand
}

/** provider/model 路由标识，用作窗口缓存 key */
export function routeOf(agent: Agent): string {
  const { provider, model } = agent.options
  return `${provider ?? '?'}/${model ?? '?'}`
}

/** 窗口从哪来——写进日志，避免"兜底值恰好等于真值"时误判 */
export type WindowSource = 'env' | 'adapter' | 'fallback'

export interface ResolvedWindow {
  tokens: number
  source: WindowSource
}

/**
 * 解析真实上下文窗口。
 *
 * 优先级：DSH_HANDOFF_WINDOW 环境变量 → provider 适配器声明的 contextWindow
 * → DEFAULT_WINDOW_TOKENS。
 *
 * 这一步不能省：窗口如果猜大了（比如实际 128k 却按 1M 算），60% 阈值永远
 * 到不了，监测层就是死的，而 compaction 会先动手。
 */
export async function resolveWindow(ctx: Context, agent: Agent): Promise<ResolvedWindow> {
  const env = Number(process.env.DSH_HANDOFF_WINDOW ?? '')
  if (Number.isFinite(env) && env > 0) return { tokens: env, source: 'env' }

  const { provider, model } = agent.options
  if (!provider || !model) return { tokens: DEFAULT_WINDOW_TOKENS, source: 'fallback' }

  try {
    const info = await ctx.llm.resolveModelInfo(provider, model)
    const w = info.context?.contextWindow
    if (typeof w === 'number' && Number.isFinite(w) && w > 0) {
      return { tokens: w, source: 'adapter' }
    }
  } catch {
    /* 适配器没声明容量：退回兜底值 */
  }
  return { tokens: DEFAULT_WINDOW_TOKENS, source: 'fallback' }
}

export function readPressure(
  ctx: Context,
  session: Session,
  windowTokens: number,
): Pressure | null {
  try {
    const meter = ctx.tokenMeter
    if (!meter || typeof meter.measure !== 'function') return null

    const m: TokenMeasurement = meter.measure(session)
    const totalTokens = Number(m?.totalTokens ?? 0)
    if (!Number.isFinite(totalTokens) || totalTokens <= 0) return null

    const ratio = totalTokens / windowTokens
    return {
      totalTokens,
      surfaceTokens: Number(m?.surfaceTokens ?? 0),
      window: windowTokens,
      ratio,
      band: ratio >= THRESHOLDS.high ? 'high' : ratio >= THRESHOLDS.warn ? 'warn' : 'ok',
    }
  } catch {
    // tokenMeter 不可用（profile 没装）或 session 形状不符：静默降级
    return null
  }
}

export function formatPressure(p: Pressure): string {
  const pct = (p.ratio * 100).toFixed(1)
  return `${pct}%（${p.totalTokens.toLocaleString()} / ${p.window.toLocaleString()} tokens）`
}

export function pressureHint(p: Pressure): string {
  const head = `上下文已用 ${formatPressure(p)}。`
  if (p.band === 'high') {
    return (
      `${head}建议立即调用 handoff_save 存交接包，然后开新会话。` +
      `重要：文件/命令/待办会自动从会话日志派生，但**结论不会**——` +
      `请务必传 summary（这次做完了什么）、nextStep、openQuestions、refs（要下个会话读的文档），` +
      `否则新会话只拿到事实、拿不到你的判断。继续下去会先触发压缩，压缩后再存质量会明显变差。`
    )
  }
  return (
    `${head}接近交接线。如果当前任务还有一段路，可以先 handoff_save 存一份，` +
    `顺手把 summary / nextStep 写上。`
  )
}

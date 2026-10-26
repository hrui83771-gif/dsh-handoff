/**
 * compat.ts —— 与 dsh 具体类型对接的唯一文件。
 *
 * 全部按官方 .d.ts 写（dsh 0.2.1-rc.3；lib 与桌面版内置的 0.2.1-rc.2 逐字节相同，
 * rc.3 只是内部依赖 pin 的 bump，所以类型同时覆盖桌面运行时）：
 *   UserMessage / MessageId / MessageSourceMap  → @deepseek-ai/dsh-llm
 *   Session / SessionEvent / session/event      → @deepseek-ai/dsh-session
 *   Agent / AgentRegistry / agent/created       → @deepseek-ai/dsh-agent
 *   CommandDefinition / CommandInvocation       → @deepseek-ai/dsh-commands
 *
 * commands 注册已不再是形状探测。桌面版（内置 0.2.1-rc.2）register() 会强制
 * 要求 definition.handler 是函数，旧的 {run, execute} 形状会被 TypeError 拒掉，
 * 之前两种探测形式都栽在这——/handoff 其实从来没挂上过，只是失败被静默吞了。
 * 现在按官方 CommandDefinition 写；dsh-commands 只 import type，运行时用宿主
 * 自己的 commands 服务实例，不打进插件产物。
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import type { ContextFormed, UserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

/**
 * 往 MessageSourceMap 里加自己的来源类型。
 *
 * dsh 的注释明确说这个 map 由"每个生产者在自己的模块里声明自己的 kind"扩展，
 * 且"user 消息可以携带任何生产者的 kind，消费方遇到未知 kind 会跳过"。
 * 官方自己的 @deepseek-ai/dsh-agent/model-selection 就是这么做的：
 *
 *   declare module '@deepseek-ai/dsh-llm' {
 *     interface MessageSourceMap {
 *       'model-selection': { kind: 'model-selection' } & ContextFormed
 *     }
 *   }
 *
 * `& ContextFormed` 让来源可以声明 form：'recall'（从别的会话摘出来的材料）
 * 和 'notice'（单行通知），正是这两种消息的官方分类。
 */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    handoff: {
      kind: 'handoff'
      fromSession: string
      packId: string
    } & ContextFormed
  }
}

export interface InjectedContext {
  text: string
  fromSession: string
  packId: string
  /**
   * recall = 上一个会话的摘要材料（默认）
   * notice = 单行通知，必须给 summary
   */
  form?: 'recall' | 'notice'
  /** notice 的一行账目，UI 不展开时显示这行 */
  summary?: string
}

export function makeInjectedMessage(input: InjectedContext): UserMessage {
  const source: UserMessage['source'] =
    input.form === 'notice'
      ? {
          kind: 'handoff',
          form: 'notice',
          summary: input.summary ?? input.text.split('\n')[0] ?? '',
          fromSession: input.fromSession,
          packId: input.packId,
        }
      : {
          kind: 'handoff',
          form: 'recall',
          fromSession: input.fromSession,
          packId: input.packId,
        }

  return {
    // MessageId 只是 brand 转换（官方注释：不做任何校验），用断言免掉一次运行时依赖
    id: `msg_handoff_${randomUUID()}` as MessageId,
    role: 'user',
    content: [{ type: 'text', text: input.text }],
    source,
  }
}

/**
 * 把接力包注入到 agent 的下一个 pre-step。
 *
 * inject() 不唤醒 driver：新会话里注入之后要等用户发第一条消息，
 * 那条消息唤醒 driver，注入内容才和它一起被 claim。刻意如此——
 * 自动 followup() 会烧掉一次用户没要求的请求。
 */
export function injectContext(agent: Agent, input: InjectedContext): boolean {
  try {
    agent.inject(makeInjectedMessage(input))
    return true
  } catch {
    return false
  }
}

/**
 * 监听会话事件。
 * 签名（dsh-session 0.2.1-rc.2）：
 *   'session/event'(session: Session, event: SessionEvent): void
 */
export function onSessionEvent(
  ctx: Context,
  handler: (session: Session, event: SessionEvent) => void,
): void {
  ctx.on('session/event', (session, event) => handler(session, event))
}

/** 从会话反查 live Agent（AgentRegistry.get 是同步 Map 查找） */
export function findAgent(ctx: Context, session: Session): Agent | undefined {
  return ctx.agents.get(session.id)
}

/* ------------------------------------------------------------------ *
 * 人类命令注册（官方 CommandDefinition 契约）
 * ------------------------------------------------------------------ */

export interface CommandSpec {
  name: string
  description: string
  /** composer 在用户还没打字时显示的输入提示 */
  hint?: string
  /** rawInput = 命令名之后的原文；agent = 收到这条命令的那个会话 */
  run: (args: string, agent: Agent) => Promise<string>
}

/**
 * 注册人类斜杠命令。
 *
 * 官方契约（桌面版内置的 0.2.1-rc.2 与 npm 上的 0.2.1-rc.3 lib 相同）：
 *   register(definition: CommandDefinition): () => void
 *   if (typeof definition.handler !== 'function') throw TypeError
 * handler 收 CommandInvocation（取 rawInput / agent），返回 CommandResult。
 * handler 抛错由注册表 settle 成 kind:'error'；这里也兜一层，给出可读文案。
 */
export function registerCommand(ctx: Context, spec: CommandSpec): boolean {
  const definition: CommandDefinition = {
    name: spec.name,
    description: spec.description,
    ...(spec.hint ? { input: { hint: spec.hint } } : {}),
    handler: async (invocation) => {
      try {
        const text = await spec.run(invocation.rawInput.trim(), invocation.agent)
        return { kind: 'success', text }
      } catch (error) {
        return { kind: 'error', text: (error as Error)?.message ?? String(error) }
      }
    },
  }

  let registered = false
  try {
    // commands 是可选服务：web / headless profile 可能没装，缺席就静默降级
    ctx.inject(['commands'], (c: Context) => {
      if (typeof c.commands?.register !== 'function') return
      c.commands.register(definition)
      registered = true
      // 注册结果必须可见：之前形状探测一直失败却没人发现，就是因为全静默
      console.log(`[dsh-handoff] /${spec.name} 已注册（commands 服务就绪）`)
    })
  } catch {
    /* commands 服务不存在：用户改用 handoff_save 工具 */
  }
  if (!registered) {
    console.warn(
      `[dsh-handoff] /${spec.name} 未注册：commands 服务未就绪` +
        `（该 profile 可能没有命令面板；生成交接包请改用 handoff_save 工具）`,
    )
  }
  return registered
}

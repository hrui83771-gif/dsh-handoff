/**
 * compat.ts —— 与 dsh 具体类型对接的唯一文件。
 *
 * 全部按官方 .d.ts 写（dsh 0.2.1-rc.2）：
 *   UserMessage / MessageId / MessageSourceMap  → @deepseek-ai/dsh-llm
 *   Session / SessionEvent / session/event      → @deepseek-ai/dsh-session
 *   Agent / AgentRegistry / agent/created       → @deepseek-ai/dsh-agent
 *
 * 唯一还剩形状探测的是 commands 注册（@deepseek-ai/dsh-commands 在 registry
 * 上只有 0.0.1-rc.1，与 0.2.1-rc.2 对不上），失败会静默降级到 handoff_save。
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
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
 * 人类命令注册（仍是形状探测）
 * ------------------------------------------------------------------ */

export interface CommandSpec {
  name: string
  description: string
  run: (args: string) => Promise<string>
}

export function registerCommand(ctx: Context, spec: CommandSpec): boolean {
  const definition = {
    name: spec.name,
    description: spec.description,
    run: spec.run,
    execute: spec.run,
  }

  let registered = false
  try {
    ctx.inject(['commands'], (c: any) => {
      const commands = c?.commands
      if (!commands?.register) return
      try {
        commands.register(definition)
        registered = true
      } catch {
        try {
          commands.register(spec.name, definition)
          registered = true
        } catch {
          /* 签名不匹配：降级，用户改用 handoff_save 工具 */
        }
      }
    })
  } catch {
    /* commands 服务不存在 */
  }
  return registered
}

/**
 * 共享的假 dsh 环境：假会话 / 假 agent / 假 ctx。
 *
 * smoke.mjs 和 mock-run.mjs 共用同一套契约，避免两边各写一份、慢慢长歪。
 * 假 ctx 的每个服务都按官方 .d.ts 的真实契约实现（会校验，不是空壳）：
 *   - commands.register 会检查 handler（桌面版内置实现就是这么校验的）
 *   - llm.stream 默认抛错：模型调用失败时插件必须退回纯事实包
 */

/* ------------------------------------------------------------------ *
 * 简单会话：mock-run 端到端用（事件 + 投影都给）
 * ------------------------------------------------------------------ */

export const makeSession = (id, overrides = {}) => ({
  id,
  cwd: process.cwd(),
  header: { cwd: process.cwd(), origin: 'user', delegationDepth: 0 },
  deriveMessages: () => [
    {
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: '把 auth 换成 session cookie。' }],
    },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: '改完了签发路径。' },
        { type: 'tool-call', name: 'edit', arguments: '{"file_path":"src/auth/session.ts"}' },
      ],
    },
  ],
  snapshotEvents: () => [
    { type: 'session/title', data: { title: 'Auth 迁 cookie' } },
    {
      type: 'tool/call',
      data: { turn: 1, callId: 'call_edit_ok', name: 'edit', arguments: '{"file_path":"src/auth/session.ts"}' },
    },
    {
      type: 'tool/call',
      data: { turn: 2, callId: 'call_pwsh_1', name: 'pwsh', arguments: '{"command":"pnpm test"}' },
    },
    {
      type: 'tool/result',
      data: {
        turn: 2,
        message: { role: 'tool', toolCallId: 'call_pwsh_1', isError: false, content: [{ type: 'text', text: 'ok' }] },
      },
    },
    // 故意带一条高熵密钥：验证落盘前会被脱敏
    {
      type: 'tool/call',
      data: {
        turn: 2,
        name: 'pwsh',
        arguments: '{"command":"curl -H \\"Authorization: Bearer sk-live-abcdef1234567890\\" https://api.example.com/deploy"}',
      },
    },
    // 同一命令再跑一次（第一次多半没成功）→ deadEnds 应标注重跑
    {
      type: 'tool/call',
      data: { turn: 3, callId: 'call_pwsh_2', name: 'pwsh', arguments: '{"command":"pnpm test"}' },
    },
    // 失败的工具调用 → deadEnds；reason 里再带一条密钥验证脱敏
    {
      type: 'tool/call',
      data: { turn: 3, callId: 'call_edit_fail', name: 'edit', arguments: '{"file_path":"src/auth/expired.ts"}' },
    },
    {
      type: 'tool/result',
      data: {
        turn: 3,
        message: {
          role: 'tool',
          toolCallId: 'call_edit_fail',
          isError: true,
          content: [{ type: 'text', text: 'ENOENT: no such file src/auth/expired.ts' }],
        },
        error: {
          name: 'EditError',
          code: 'ENOENT',
          reason: 'ENOENT: no such file src/auth/expired.ts (token=sk-deadbeef123456)',
        },
      },
    },
    {
      type: 'todo/write',
      data: {
        todos: [
          { content: '切签发路径', status: 'completed' },
          { content: '补过期测试', status: 'pending' },
        ],
      },
    },
    { type: 'turn/end', data: { turn: 3 } },
  ],
})

export const makeAgent = (id, overrides = {}) => {
  const injected = []
  const session = makeSession(id)
  return {
    session: { ...session, ...overrides.session },
    options: { provider: 'deepseek-official', model: 'deepseek-flash' },
    inject(message) {
      injected.push(message)
    },
    injected,
  }
}

/* ------------------------------------------------------------------ *
 * 丰富会话：smoke 直接测 distill 用（覆盖事件优先、投影兜底两条路）
 * ------------------------------------------------------------------ */

export const makeRichSession = () => ({
  id: 'sess_demo_001',
  cwd: process.cwd(),
  deriveMessages: () => [
    {
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: '把 auth 模块从 JWT 换成 session cookie，顺便补测试。' }],
    },
    {
      // dsh 自己注入的上下文：role 是 user，但 kind 不是 'user'，必须忽略
      role: 'user',
      source: { kind: 'runtime-context' },
      content: [{ type: 'text', text: '<runtime-context>cwd=/repo</runtime-context>' }],
    },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: '先看一下现有实现。' },
        { type: 'tool-call', name: 'read_file', arguments: '{"path":"src/auth/jwt.ts"}' },
      ],
    },
    {
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          name: 'edit_file',
          arguments: '{"file_path":"src/auth/session.ts","target":"src/auth/index.ts"}',
        },
        { type: 'tool-call', name: 'bash', arguments: '{"command":"pnpm test src/auth --run\\n# 省略"}' },
        {
          type: 'text',
          text: [
            '## 进度',
            'JWT 签发路径已切到 cookie，index.ts 的导出还没改完。',
            '',
            '下一步：',
            '- [ ] 更新 src/auth/index.ts 的导出',
            '',
            '未决问题：旧 token 是否需要兼容期？',
          ].join('\n'),
        },
      ],
    },
    {
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: '把当前会话存成交接包。' }],
    },
  ],
  snapshotEvents: () => [
    { type: 'session', data: {} },
    { type: 'session/title', data: { title: 'Auth 迁到 session cookie' } },
    {
      type: 'tool/call',
      data: {
        turn: 1,
        callId: 'call_rich_1',
        name: 'edit',
        arguments: '{"file_path":"src/auth/session.ts"}',
      },
    },
    {
      type: 'tool/result',
      data: {
        turn: 1,
        message: {
          role: 'tool',
          toolCallId: 'call_rich_1',
          isError: true,
          content: [{ type: 'text', text: 'FileNotFoundError: src/auth/session.ts is read-only' }],
        },
        error: {
          name: 'EditError',
          code: 'EROFS',
          reason: 'FileNotFoundError: src/auth/session.ts is read-only (token=sk-deadbeef123456)',
        },
      },
    },
    {
      type: 'tool/call',
      data: {
        turn: 2,
        name: 'multi_edit',
        arguments: '{"paths":["src/auth/index.ts","src/auth/cookie.ts"]}',
      },
    },
    {
      type: 'tool/call',
      data: {
        turn: 2,
        name: 'write',
        arguments: '{"path":"src/auth/session.ts"}',
      },
    },
    {
      type: 'tool/call',
      data: {
        turn: 3,
        name: 'pwsh',
        arguments: '{"command":"pnpm test src/auth --run\\n# 长输出省略"}',
      },
    },
    {
      // 同一命令重跑（第一次多半失败）→ deadEnds 标注
      type: 'tool/call',
      data: {
        turn: 4,
        name: 'pwsh',
        arguments: '{"command":"pnpm test src/auth --run\\n# 第二次"}',
      },
    },
    {
      type: 'tool/call',
      data: {
        turn: 3,
        name: 'pwsh',
        arguments: '{"command":"cd repo; Get-ChildItem -Force"}',
      },
    },
    {
      type: 'todo/write',
      data: {
        todos: [
          { content: '切到 cookie 签发', status: 'completed' },
          { content: '更新 index.ts 导出', status: 'in_progress' },
        ],
      },
    },
    {
      type: 'todo/write',
      data: {
        todos: [
          { content: '切到 cookie 签发', status: 'completed' },
          { content: '更新 index.ts 导出', status: 'completed' },
          { content: '补 session 过期测试', status: 'pending' },
        ],
      },
    },
    { type: 'turn/end', data: { turn: 7 } },
    {
      type: 'tool/call',
      data: { turn: 7, name: 'handoff_save', arguments: '{"summary":"x"}' },
    },
  ],
})

/* ------------------------------------------------------------------ *
 * 假 ctx
 * ------------------------------------------------------------------ */

/**
 * @param {{ llm?: object, tokenMeter?: object }} options 可覆盖默认服务
 */
export function makeCtx(options = {}) {
  const state = { currentAgent: undefined, agents: [] }
  const handlers = new Map()
  const tools = new Map()
  const commands = new Map()
  const emitted = []

  const on = (name, fn) => {
    if (!handlers.has(name)) handlers.set(name, [])
    handlers.get(name).push(fn)
  }

  const ctx = {
    on,
    emit(name, payload) {
      emitted.push({ name, payload })
    },
    inject(_deps, cb) {
      // 按桌面版（内置 dsh-commands 0.2.1-rc.2）register() 的真实契约校验：
      // handler 不是函数就 throw TypeError。旧的 {run, execute} 形状探测正是
      // 被这条拒掉、又被 compat.ts 静默吞掉的，所以这里必须严格。
      cb({
        commands: {
          register(definition) {
            if (typeof definition.handler !== 'function') {
              throw new TypeError(`command "${definition.name}" handler must be a function`)
            }
            commands.set(definition.name, definition)
            return () => commands.delete(definition.name)
          },
        },
      })
    },
    agents: {
      get: (id) => state.agents.find((a) => String(a.session.id) === String(id)),
      currentInitiator: () => state.currentAgent,
      list: () => state.agents,
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return definition
      },
    },
    llm: options.llm ?? {
      async resolveModelInfo(provider, model) {
        return { provider, id: model, name: model, context: { contextWindow: 1_000_000 } }
      },
      // 默认没有模型：流式调用必须失败得干脆，插件要能退回纯事实包
      async *stream() {
        throw new Error('mock ctx has no llm stream')
      },
    },
    tokenMeter: options.tokenMeter ?? {
      measure: () => ({ totalTokens: 812_000, surfaceTokens: 500_000 }),
    },
  }

  /** 设定"当前活动 agent"，并登记进 agents（toSession 投递按 id 找） */
  const setAgent = (agent) => {
    state.currentAgent = agent
    if (agent && !state.agents.includes(agent)) state.agents.push(agent)
    return agent
  }

  const fire = async (name, ...args) => {
    const results = []
    for (const fn of handlers.get(name) ?? []) results.push(await fn(...args))
    return results
  }

  return { ctx, state, handlers, tools, commands, emitted, fire, setAgent }
}

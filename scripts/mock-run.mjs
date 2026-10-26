/**
 * 端到端（假 ctx）：真的加载 dist/index.js 并调用 apply()，
 * 然后模拟 dsh 的 agent/created、工具调用，验证整条链路。
 *
 *   node scripts/mock-run.mjs
 *
 * 覆盖：
 *   1. 插件装配不炸（工具注册、命令注册、事件挂载）
 *   2. startup 会话自动注入 L0（含 refs 指针）
 *   3. resume / subagent 不注入
 *   4. handoff_save 带 brief → 落盘 → 新会话能读到
 *   5. recall_context 能取分节
 *   6. 80% 压力只报一次 + 自动落纯事实包
 *
 * 全程用 DSH_HOME 指向临时目录，不碰用户真实的 ~/.dsh。
 */

import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = await mkdtemp(join(tmpdir(), 'dsh-handoff-e2e-'))
process.env.DSH_HOME = home

const { apply } = await import('../dist/index.js')
const { PACK_VERSION } = await import('../dist/pack.js')

/* ---------------- 假会话 ---------------- */

const makeSession = (id) => ({
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
    { type: 'tool/call', data: { turn: 1, name: 'edit', arguments: '{"file_path":"src/auth/session.ts"}' } },
    { type: 'tool/call', data: { turn: 2, name: 'pwsh', arguments: '{"command":"pnpm test"}' } },
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

const makeAgent = (id, overrides = {}) => {
  const injected = []
  const session = makeSession(id)
  const agent = {
    session: { ...session, ...overrides.session },
    options: { provider: 'deepseek-official', model: 'deepseek-flash' },
    inject(message) {
      injected.push(message)
    },
    injected,
  }
  return agent
}

/* ---------------- 假 ctx ---------------- */

const handlers = new Map()
const tools = new Map()
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
    cb({ commands: { register() {} } })
  },
  agents: {
    get: () => currentAgent,
    currentInitiator: () => currentAgent,
  },
  tools: {
    register(definition) {
      tools.set(definition.name, definition)
      return definition
    },
  },
  llm: {
    async resolveModelInfo(provider, model) {
      return { provider, id: model, name: model, context: { contextWindow: 1_000_000 } }
    },
  },
  tokenMeter: {
    measure: () => ({ totalTokens: 812_000, surfaceTokens: 500_000 }),
  },
}

let currentAgent

const fire = async (name, ...args) => {
  const results = []
  for (const fn of handlers.get(name) ?? []) results.push(await fn(...args))
  return results
}

apply(ctx)

const checks = []
const check = (label, ok) => checks.push([label, ok])

/* ---------------- 1. 装配 ---------------- */

check('工具已注册 recall_context', tools.has('recall_context'))
check('工具已注册 handoff_save', tools.has('handoff_save'))
check('挂了 agent/created', (handlers.get('agent/created') ?? []).length === 1)
check('挂了 session/event', (handlers.get('session/event') ?? []).length === 1)

/* ---------------- 2. handoff_save 带结论 ---------------- */

currentAgent = makeAgent('sess_old_001')
const saveOut = await tools.get('handoff_save').execute({
  summary: '签发路径已切到 cookie，测试还没补。',
  nextStep: '补 session 过期测试。',
  openQuestions: ['旧 token 要兼容期吗？'],
  refs: ['docs/HANDOFF.md'],
})

check('handoff_save 返回成功', saveOut.includes('交接包已保存'))
check('handoff_save 提到结论已写入', saveOut.includes('结论已写入'))

const packs = await readdir(join(home, 'handoff', (await import('../dist/workspace.js')).resolveWorkspace(currentAgent).key))
check('pack 落在 DSH_HOME/handoff/<key>', packs.includes('latest.json'))

/* ---------------- 3. 新会话自动注入 ---------------- */

const fresh = makeAgent('sess_new_002')
currentAgent = fresh
await fire('agent/created', { agent: fresh, source: 'startup' })

const l0 = fresh.injected[0]
check('startup 会话被注入 1 条消息', fresh.injected.length === 1)
check('注入消息来自 handoff 源', l0?.source?.kind === 'handoff' && l0?.source?.form === 'recall')
check('注入内容是 L0 摘要', (l0?.content?.[0]?.text ?? '').includes('这是上一个会话的交接摘要'))
check('L0 带上了模型写的结论', (l0?.content?.[0]?.text ?? '').includes('签发路径已切到 cookie'))
check('L0 带上了 refs 指针', (l0?.content?.[0]?.text ?? '').includes('HANDOFF.md'))
check('触发了 handoff/restored 事件', emitted.some((e) => e.name === 'handoff/restored'))

/* ---------------- 4. resume / subagent 不注入 ---------------- */

const resumed = makeAgent('sess_resume_003')
currentAgent = resumed
await fire('agent/created', { agent: resumed, source: 'resume' })
check('resume 不注入', resumed.injected.length === 0)

const sub = makeAgent('sess_sub_004', { session: { header: { cwd: process.cwd(), origin: 'subagent', delegationDepth: 1 } } })
currentAgent = sub
await fire('agent/created', { agent: sub, source: 'startup' })
check('subagent 不注入', sub.injected.length === 0)

/* ---------------- 5. recall_context ---------------- */

const recall = await tools.get('recall_context').execute({ section: 'files' })
check('recall files 能读到改动文件', recall.includes('src/auth/session.ts'))
const recallRefs = await tools.get('recall_context').execute({ section: 'refs' })
check('recall refs 能读到文档指针', recallRefs.includes('HANDOFF.md'))
const recallBad = await tools.get('recall_context').execute({ section: 'nope' })
check('recall 未知分节给出提示', recallBad.includes('unknown section'))

/* ---------------- 6. 压力提示 ---------------- */

const pressureSession = makeSession('sess_pressure_005')
const pressureAgent = makeAgent('sess_pressure_005')
currentAgent = pressureAgent
await fire('session/event', pressureSession, { type: 'step/end', data: {} })
const notices = pressureAgent.injected.filter((m) => m.source?.form === 'notice')
check('80% 时注入一条 notice', notices.length === 1)
check('notice 指向 handoff_save', (notices[0]?.content?.[0]?.text ?? '').includes('handoff_save'))
check('压力事件已发出', emitted.some((e) => e.name === 'handoff/pressure' && e.payload.pressure.band === 'high'))

// 同一档位再来一次：不该重复报，也不该重复注入
await new Promise((r) => setTimeout(r, 5_100))
await fire('session/event', pressureSession, { type: 'step/end', data: {} })
check('同档位只报一次', pressureAgent.injected.filter((m) => m.source?.form === 'notice').length === 1)

/* ---------------- 7. 自动落盘的是纯事实包 ---------------- */

const { loadLatestPack } = await import('../dist/pack.js')
const { resolveWorkspace } = await import('../dist/workspace.js')
const autoPack = await loadLatestPack(join(home, 'handoff', resolveWorkspace(pressureAgent).key))
check('80% 自动落了纯事实包', !!autoPack && autoPack.version === PACK_VERSION)
check('自动包没有模型结论（是活动统计）', (autoPack?.progress ?? '').includes('次工具调用'))

/* ---------------- 结果 ---------------- */

let failed = 0
for (const [label, ok] of checks) {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
}

await rm(home, { recursive: true, force: true })
console.log(failed === 0 ? `\n全部通过（${checks.length} 项）。` : `\n${failed} / ${checks.length} 项失败。`)
process.exitCode = failed === 0 ? 0 : 1

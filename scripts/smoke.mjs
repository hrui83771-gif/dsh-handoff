/**
 * 离线冒烟测试：直接测编译产物 dist/，不依赖 dsh、不依赖 tsx、不挑 Node 版本。
 *
 *   node scripts/smoke.mjs        （或 pnpm build && node scripts/smoke.mjs）
 *
 * 测的是 dsh 真正会加载的那份 JS，所以通过这里就等于产物逻辑没问题。
 */

import { mkdtemp } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildPack } from '../dist/distill.js'
import { PACK_VERSION, loadLatestPack, readSection, savePack, toL0 } from '../dist/pack.js'

/* ------------------------------------------------------------------ *
 * 假会话：投影（deriveMessages）和原始事件（snapshotEvents）都给全，
 * 用来覆盖"事件优先、投影兜底"两条路。
 * ------------------------------------------------------------------ */

const fakeSession = {
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
        name: 'edit',
        arguments: '{"file_path":"src/auth/session.ts"}',
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
}

const dir = await mkdtemp(join(tmpdir(), 'dsh-handoff-smoke-'))

const factsOnly = buildPack({
  session: fakeSession,
  workspaceDir: dir,
  window: 1_000_000,
  pressure: { totalTokens: 812_000, window: 1_000_000, ratio: 0.812 },
})

const withBrief = buildPack({
  session: fakeSession,
  workspaceDir: dir,
  window: 1_000_000,
  pressure: { totalTokens: 812_000, window: 1_000_000, ratio: 0.812 },
  brief: {
    goal: '把 auth 从 JWT 换成 cookie',
    summary: '签发路径已切换，导出和测试还没收尾。',
    nextStep: '改完 index.ts 的导出，再补过期测试。',
    openQuestions: ['旧 token 需要兼容期吗？'],
    refs: ['docs/HANDOFF.md'],
  },
})

const file = await savePack(dir, withBrief)
const loaded = await loadLatestPack(dir)

const checks = [
  ['PACK_VERSION 已升到 3', PACK_VERSION === 3 && factsOnly.version === 3],
  ['落盘后能读回', !!loaded && loaded.id === withBrief.id],
  ['goal 优先用会话标题', factsOnly.goal === 'Auth 迁到 session cookie'],
  ['files 从 tool 参数派生（JSON 字符串）', factsOnly.files.includes('src/auth/session.ts')],
  ['多路径参数也覆盖', factsOnly.files.includes('src/auth/index.ts') && factsOnly.files.includes('src/auth/cookie.ts')],
  ['files 按改动次数排序', factsOnly.files[0] === 'src/auth/session.ts'],
  ['只读工具不算改动', !factsOnly.files.includes('src/auth/jwt.ts')],
  ['命令只取首行', factsOnly.commands.includes('pnpm test src/auth --run')],
  ['构建类命令排前面', /pnpm test/.test(factsOnly.commands[0] ?? '')],
  ['done 跨多次 todo/write 合并', factsOnly.done.includes('切到 cookie 签发') && factsOnly.done.includes('更新 index.ts 导出')],
  ['下一步来自最后一份清单的未完成项', factsOnly.nextStep.includes('补 session 过期测试')],
  ['没有模型结论时 progress 只陈述事实', factsOnly.progress.includes('7 轮') && !factsOnly.progress.includes('不过说实话')],
  ['meta 提问不进 recentPrompts', !factsOnly.recentPrompts.some((p) => p.includes('交接包'))],
  ['runtime-context 不进 recentPrompts', !factsOnly.recentPrompts.some((p) => p.includes('runtime-context'))],
  ['stats 记录规模', factsOnly.stats.turns === 7 && factsOnly.stats.toolCalls === 6],
  ['模型 brief 覆盖 goal', withBrief.goal === '把 auth 从 JWT 换成 cookie'],
  ['模型 brief 覆盖 progress', withBrief.progress === '签发路径已切换，导出和测试还没收尾。'],
  ['模型 nextStep 带上未完成待办', withBrief.nextStep.startsWith('改完 index.ts') && withBrief.nextStep.includes('补 session 过期测试')],
  ['模型 openQuestions 优先', withBrief.openQuestions[0] === '旧 token 需要兼容期吗？'],
  ['refs 解析成绝对路径', withBrief.refs[0] === join(dir, 'docs/HANDOFF.md')],
  ['L0 有预算上限', toL0(withBrief).length <= 4000],
  ['L0 包含详细交接指针', toL0(withBrief).includes(join(dir, 'docs/HANDOFF.md'))],
  ['L0 里"下一步"只出现一次', (toL0(withBrief).match(/## 下一步/g) ?? []).length === 1],
  ['L0 标题带会话标题', toL0(withBrief).includes('Auth 迁到 session cookie')],
  ['recall 能取 files 分节', (readSection(withBrief, 'files') ?? '').includes('src/auth')],
  ['recall 能取 refs 分节', (readSection(withBrief, 'refs') ?? '').includes('HANDOFF.md')],
  ['未知分节返回 null', readSection(withBrief, 'nope') === null],
]

/* ---------------- 注入路径（用假 agent，不需要 dsh） ---------------- */

const { injectContext, makeInjectedMessage } = await import('../dist/compat.js')
const { handoffRoot, resolveWorkspace } = await import('../dist/workspace.js')

const recallMsg = makeInjectedMessage({
  text: toL0(withBrief),
  fromSession: withBrief.fromSession,
  packId: withBrief.id,
  form: 'recall',
})
const noticeMsg = makeInjectedMessage({
  text: '上下文已用 82%。建议立即 handoff_save。',
  fromSession: 'sess_demo_001',
  packId: 'pressure-high',
  form: 'notice',
  summary: '上下文已用 82%',
})

const captured = []
const fakeAgent = {
  session: { id: 'sess_new_002' },
  inject(message) {
    captured.push(message)
  },
}

const ok = injectContext(fakeAgent, {
  text: 'hello',
  fromSession: 'sess_demo_001',
  packId: 'p1',
  form: 'recall',
})

const brokenAgent = {
  inject() {
    throw new Error('boom')
  },
}

checks.push(
  ['注入消息是 user 角色', recallMsg.role === 'user'],
  ['注入消息 id 带 handoff 前缀', String(recallMsg.id).startsWith('msg_handoff_')],
  ['注入消息内容是文本块', recallMsg.content[0]?.type === 'text'],
  ['recall 来源声明 form', recallMsg.source.kind === 'handoff' && recallMsg.source.form === 'recall'],
  ['notice 来源带一行账目', noticeMsg.source.form === 'notice' && noticeMsg.source.summary === '上下文已用 82%'],
  ['injectContext 调用了 agent.inject', ok === true && captured.length === 1],
  ['inject() 抛错时返回 false 而不炸', injectContext(brokenAgent, { text: 'x', fromSession: 's', packId: 'p' }) === false],
)

/* ---------------- 工作区 key 稳定性 ---------------- */

const wsA = resolveWorkspace({ session: { header: { cwd: dir } } })
const wsB = resolveWorkspace({ session: { cwd: dir.toUpperCase() } })
checks.push(
  ['工作区 key 为 12 位十六进制', /^[0-9a-f]{12}$/.test(wsA.key)],
  ['同一路径大小写不同仍同 key', wsA.key === wsB.key],
  ['handoffRoot 落在 <dsh-home>/handoff/<key>', handoffRoot(wsA) === join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'handoff', wsA.key)],
)

/* ---------------- 上下文窗口解析 ---------------- */

const { DEFAULT_WINDOW_TOKENS, resolveWindow, routeOf } = await import('../dist/meter.js')

const agentWithRoute = { options: { provider: 'deepseek-official', model: 'deepseek-flash' } }
const declaringCtx = {
  llm: {
    async resolveModelInfo(provider, model) {
      return { provider, id: model, name: model, context: { contextWindow: 128_000 } }
    },
  },
}
const silentCtx = {
  llm: {
    async resolveModelInfo() {
      throw new Error('adapter has no capacity')
    },
  },
}

const fromAdapter = await resolveWindow(declaringCtx, agentWithRoute)
const fromFallback = await resolveWindow(silentCtx, agentWithRoute)

process.env.DSH_HANDOFF_WINDOW = '200000'
const fromEnv = await resolveWindow(declaringCtx, agentWithRoute)
delete process.env.DSH_HANDOFF_WINDOW

checks.push(
  ['窗口取自适配器声明的 contextWindow', fromAdapter.tokens === 128_000 && fromAdapter.source === 'adapter'],
  ['适配器不声明时退回兜底值', fromFallback.tokens === DEFAULT_WINDOW_TOKENS && fromFallback.source === 'fallback'],
  ['环境变量优先级最高', fromEnv.tokens === 200_000 && fromEnv.source === 'env'],
  ['路由 key 用 provider/model', routeOf(agentWithRoute) === 'deepseek-official/deepseek-flash'],
)

let failed = 0
for (const [label, ok] of checks) {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
}

console.log('\n--- L0 预览（事实 + 模型结论）---\n')
console.log(toL0(withBrief))
console.log(`\npack: ${file}`)
console.log(failed === 0 ? `\n全部通过（${checks.length} 项）。` : `\n${failed} / ${checks.length} 项失败。`)
process.exitCode = failed === 0 ? 0 : 1

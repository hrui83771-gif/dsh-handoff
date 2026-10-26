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

import { buildPack, redactCommand } from '../dist/distill.js'
import { parseBrief } from '../dist/brief.js'
import { normalizeRemote } from '../dist/git.js'
import {
  PACK_VERSION,
  formatAge,
  isStale,
  listPacks,
  loadLatestPack,
  loadPackById,
  mirrorLatest,
  packAgeMs,
  readSection,
  savePack,
  toL0,
} from '../dist/pack.js'
import { makeRichSession } from './fixtures/mock-ctx.mjs'

/* ------------------------------------------------------------------ *
 * 假会话：投影（deriveMessages）和原始事件（snapshotEvents）都给全，
 * 用来覆盖"事件优先、投影兜底"两条路。fixture 与 mock-run 共用。
 * ------------------------------------------------------------------ */

const fakeSession = makeRichSession()

const dir = await mkdtemp(join(tmpdir(), 'dsh-handoff-smoke-'))
// 冒烟也可能写出文件（mirrorLatest）：全程指向临时目录，不碰真实 ~/.dsh
process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'dsh-handoff-home-'))

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
const { handoffRemoteRoot, handoffRoot, resolveWorkspace } = await import('../dist/workspace.js')

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

/* ---------------- 命令脱敏（密钥不落盘） ---------------- */

checks.push(
  ['Bearer 凭证打码', !redactCommand('curl -H "Authorization: Bearer sk-live-abcdef123456" x').includes('sk-live-abcdef123456')],
  ['key=value 赋值打码', redactCommand('DEEPSEEK_API_KEY=sk-1234567890 pnpm build').includes('DEEPSEEK_API_KEY=***')],
  ["$env:TOKEN='...' 打码", redactCommand("$env:TOKEN='ghp_abcdefgh12345'; pnpm t").includes('TOKEN=***')],
  ['URL 里的密码打码', redactCommand('git push https://user:pass12345@host/r.git').includes(':***@')],
  ['--token= 形式打码', redactCommand('tool --token=abcdef123456 run').includes('--token=***')],
  ['普通命令原样保留', redactCommand('pnpm test src/auth --run') === 'pnpm test src/auth --run'],
  ['构建命令里的普通参数不误伤', !redactCommand('pnpm test --runInBand').includes('***')],
)

/* ---------------- 跨机器接力：远端 key ---------------- */

checks.push(
  ['scp 形式远端归一化', normalizeRemote('git@github.com:foo/bar.git') === 'github.com/foo/bar'],
  ['https 远端归一化（去协议/斜杠/大小写）', normalizeRemote('https://GitHub.com/foo/bar/') === 'github.com/foo/bar'],
  ['远端 key 目录带 remote- 前缀', handoffRemoteRoot('github.com/foo/bar').includes('remote-')],
  ['同一远端 → 同一目录', handoffRemoteRoot('github.com/foo/bar') === handoffRemoteRoot('github.com/foo/bar')],
)

const remoteDir = handoffRemoteRoot('github.com/foo/bar')
await mirrorLatest(remoteDir, withBrief)
const mirrored = await loadLatestPack(remoteDir)
checks.push(
  ['mirrorLatest 镜像 latest.json', mirrored?.id === withBrief.id],
  ['镜像目录能被 loadLatestPack 读回', (await loadLatestPack(remoteDir))?.goal === withBrief.goal],
)

/* ---------------- 包新鲜度 ---------------- */

const oldPack = { ...withBrief, createdAt: new Date(Date.now() - 10 * 86_400_000).toISOString() }

checks.push(
  ['formatAge 天级', formatAge(packAgeMs(oldPack)) === '10 天前'],
  ['formatAge 小时级', formatAge(2 * 3_600_000) === '2 小时前'],
  ['formatAge 分钟级', formatAge(5 * 60_000) === '5 分钟前'],
  ['formatAge 刚刚', formatAge(0) === '刚刚'],
  ['超过 3 天默认过期线 → stale', isStale(oldPack) === true],
  ['新鲜包不 stale', isStale(withBrief) === false],
)

process.env.DSH_HANDOFF_MAX_AGE_DAYS = '0'
const staleOff = isStale(oldPack)
process.env.DSH_HANDOFF_MAX_AGE_DAYS = '30'
const staleWide = isStale(oldPack)
delete process.env.DSH_HANDOFF_MAX_AGE_DAYS
checks.push(
  ['DSH_HANDOFF_MAX_AGE_DAYS=0 关掉过期判断', staleOff === false],
  ['DSH_HANDOFF_MAX_AGE_DAYS=30 放宽过期线', staleWide === false],
)

checks.push(
  ['过期包 L0 开头带警告', toL0(oldPack, { stale: true }).trimStart().startsWith('⚠') && toL0(oldPack, { stale: true }).includes('早已过期')],
  ['新鲜包 L0 不带警告', !toL0(withBrief).includes('早已过期')],
  ['L0 标注写入时间', toL0(withBrief).includes('写于 刚刚')],
)

/* ---------------- git 事实进 pack / L0 ---------------- */

const withGit = buildPack({
  session: fakeSession,
  workspaceDir: dir,
  window: 1_000_000,
  pressure: { totalTokens: 812_000, window: 1_000_000, ratio: 0.812 },
  git: { remote: 'github.com/foo/bar', branch: 'main', commit: 'abcdef1234567890' },
})
checks.push(
  ['git 事实写进 pack', withGit.git?.remote === 'github.com/foo/bar' && withGit.git?.branch === 'main'],
  ['没有 git 事实时不写字段', factsOnly.git === undefined],
  ['L0 带上来源仓库', toL0(withGit).includes('github.com/foo/bar') && toL0(withGit).includes('main@abcdef12')],
  ['无结论时 conclusionSource=activity', factsOnly.conclusionSource === 'activity'],
  ['有 brief 时 conclusionSource=brief', withBrief.conclusionSource === 'brief'],
)

/* ---------------- 历史包：list / 按 id 读 ---------------- */

const olderPack = {
  ...withBrief,
  id: 'older00001',
  createdAt: new Date(Date.now() - 3600_000).toISOString(),
  progress: '一小时前的旧结论。',
  conclusionSource: 'brief',
}
await savePack(dir, olderPack)
const metas = await listPacks(dir)
const byId = await loadPackById(dir, 'older00001')
const byMissing = await loadPackById(dir, 'nosuch0000')
checks.push(
  ['listPacks 新的在前', metas.length === 2 && metas[0].id === withBrief.id],
  ['listPacks 标注结论有无', metas[0]?.hasConclusion === true],
  ['listPacks 带年龄文案', typeof metas[1]?.age === 'string' && metas[1].age.includes('前')],
  ['loadPackById 命中', byId?.progress === '一小时前的旧结论。'],
  ['loadPackById 未命中返回 null', byMissing === null],
)

/* ---------------- 结论补写解析（parseBrief） ---------------- */

checks.push(
  ['parseBrief 正常 JSON', parseBrief('{"summary":"ok","nextStep":"n"}')?.summary === 'ok'],
  ['parseBrief 容忍 markdown 围栏', parseBrief('前置 ```json\n{"summary":"ok"}\n``` 后缀')?.summary === 'ok'],
  ['parseBrief 剔除超长字段', (parseBrief(`{"summary":"${'x'.repeat(5000)}"}`)?.summary ?? '').length <= 1200],
  ['parseBrief 非 JSON 返回 null', parseBrief('不是 JSON') === null],
  ['parseBrief 缺结论字段返回 null', parseBrief('{"foo":1}') === null],
  ['parseBrief 空输入返回 null', parseBrief('') === null],
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

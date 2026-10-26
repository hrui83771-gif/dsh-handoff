/**
 * 端到端（假 ctx）：真的加载 dist/index.js 并调用 apply()，
 * 然后模拟 dsh 的 agent/created、工具调用，验证整条链路。
 *
 *   node scripts/mock-run.mjs
 *
 * 覆盖：
 *   1. 插件装配不炸（工具注册、命令注册、事件挂载）
 *   2. handoff_save 带 brief → 落盘 → 新会话能读到
 *   3. startup 会话自动注入 L0（含 refs 指针）
 *   4. resume / subagent 不注入
 *   5. recall_context 能取分节（含 packId 选历史包）
 *   6. 80% 压力只报一次 + 自动落盘
 *   7. /handoff 命令走官方 CommandDefinition 契约（handler → CommandResult）
 *   8. 命令脱敏：密钥不落盘
 *   9. handoff_list 列历史包
 *  10. handoff_save toSession 投递给运行中的会话
 *  11. 结论自动补写（模型没传 summary 时一次结构化调用）+ 开关
 *  12. 过期包注入时带警告
 *  13. compaction 前落断点包（trigger=compaction，失败教训一并保存）
 *  14. /handoff 子命令：list / show <id> / restore <id>
 *  15. 延迟接力：cwd 不在仓库内时，按改动文件反推仓库根补注入
 *
 * 全程用 DSH_HOME 指向临时目录，不碰用户真实的 ~/.dsh；
 * DSH_HANDOFF_NO_GIT=1 让 git 探测确定性地关闭（第 15 段临时打开，
 * 配一个真的 git 仓库验证反推链路；其余 git 逻辑在 smoke.mjs 按纯函数单测）。
 */

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const pExec = promisify(execFile)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const home = await mkdtemp(join(tmpdir(), 'dsh-handoff-e2e-'))
process.env.DSH_HOME = home
process.env.DSH_HANDOFF_NO_GIT = '1'

const { apply } = await import('../dist/index.js')
const { PACK_VERSION, loadLatestPack, mirrorLatest } = await import('../dist/pack.js')
const { handoffRemoteRoot, resolveWorkspace } = await import('../dist/workspace.js')
const { makeAgent, makeCtx, makeSession } = await import('./fixtures/mock-ctx.mjs')

/* ---------------- 假 ctx ---------------- */

const { ctx, handlers, tools, commands, emitted, fire, setAgent } = makeCtx()

apply(ctx)

const checks = []
const check = (label, ok) => checks.push([label, ok])

const workspaceDirOf = (agent) => join(home, 'handoff', resolveWorkspace(agent).key)

/* ---------------- 1. 装配 ---------------- */

check('工具已注册 recall_context', tools.has('recall_context'))
check('工具已注册 handoff_save', tools.has('handoff_save'))
check('工具已注册 handoff_list', tools.has('handoff_list'))
check('命令已注册 handoff', commands.has('handoff'))
check('命令定义符合官方契约（handler 是函数）', typeof commands.get('handoff')?.handler === 'function')
check('命令带了 composer 输入提示', commands.get('handoff')?.input?.hint === '<一句话结论> | list | show <id> | restore <id>')
check('挂了 agent/created', (handlers.get('agent/created') ?? []).length === 1)
check('挂了 session/event', (handlers.get('session/event') ?? []).length === 1)

/* ---------------- 2. handoff_save 带结论 ---------------- */

const oldAgent = setAgent(makeAgent('sess_old_001'))
const saveOut = await tools.get('handoff_save').execute({
  summary: '签发路径已切到 cookie，测试还没补。',
  nextStep: '补 session 过期测试。',
  openQuestions: ['旧 token 要兼容期吗？'],
  refs: ['docs/HANDOFF.md'],
})

check('handoff_save 返回成功', saveOut.includes('交接包已保存'))
check('handoff_save 提到结论已写入', saveOut.includes('结论已写入'))

const packs = await readdir(workspaceDirOf(oldAgent))
check('pack 落在 DSH_HOME/handoff/<key>', packs.includes('latest.json'))

const packA = await loadLatestPack(workspaceDirOf(oldAgent))
check('结论来源标成 brief', packA?.conclusionSource === 'brief')

/* ---------------- 3. 新会话自动注入 ---------------- */

const fresh = setAgent(makeAgent('sess_new_002'))
await fire('agent/created', { agent: fresh, source: 'startup' })

const l0 = fresh.injected[0]
check('startup 会话被注入 1 条消息', fresh.injected.length === 1)
check('注入消息来自 handoff 源', l0?.source?.kind === 'handoff' && l0?.source?.form === 'recall')
check('注入内容是 L0 摘要', (l0?.content?.[0]?.text ?? '').includes('这是上一个会话的交接摘要'))
check('L0 带上了模型写的结论', (l0?.content?.[0]?.text ?? '').includes('签发路径已切到 cookie'))
check('L0 带上了 refs 指针', (l0?.content?.[0]?.text ?? '').includes('HANDOFF.md'))
check('L0 标注了交接时间', /写于 .+前|写于 刚刚/.test(l0?.content?.[0]?.text ?? ''))
check('触发了 handoff/restored 事件', emitted.some((e) => e.name === 'handoff/restored'))

/* ---------------- 4. resume / subagent 不注入 ---------------- */

const resumed = setAgent(makeAgent('sess_resume_003'))
await fire('agent/created', { agent: resumed, source: 'resume' })
check('resume 不注入', resumed.injected.length === 0)

const sub = setAgent(
  makeAgent('sess_sub_004', { session: { header: { cwd: process.cwd(), origin: 'subagent', delegationDepth: 1 } } }),
)
await fire('agent/created', { agent: sub, source: 'startup' })
check('subagent 不注入', sub.injected.length === 0)

/* ---------------- 5. recall_context ---------------- */

setAgent(oldAgent)
const recall = await tools.get('recall_context').execute({ section: 'files' })
check('recall files 能读到改动文件', recall.includes('src/auth/session.ts'))
const recallRefs = await tools.get('recall_context').execute({ section: 'refs' })
check('recall refs 能读到文档指针', recallRefs.includes('HANDOFF.md'))
const recallBad = await tools.get('recall_context').execute({ section: 'nope' })
check('recall 未知分节给出提示', recallBad.includes('unknown section'))

/* ---------------- 6. 压力提示 ---------------- */

const pressureSession = makeSession('sess_pressure_005')
const pressureAgent = setAgent(makeAgent('sess_pressure_005'))
await fire('session/event', pressureSession, { type: 'step/end', data: {} })
const notices = pressureAgent.injected.filter((m) => m.source?.form === 'notice')
check('80% 时注入一条 notice', notices.length === 1)
check('notice 指向 handoff_save', (notices[0]?.content?.[0]?.text ?? '').includes('handoff_save'))
check('压力事件已发出', emitted.some((e) => e.name === 'handoff/pressure' && e.payload.pressure.band === 'high'))

// 同一档位再来一次：不该重复报，也不该重复注入
await new Promise((r) => setTimeout(r, 5_100))
await fire('session/event', pressureSession, { type: 'step/end', data: {} })
check('同档位只报一次', pressureAgent.injected.filter((m) => m.source?.form === 'notice').length === 1)

/* ---------------- 7. 自动落盘（llm 不可用 → 纯事实包） ---------------- */

const autoPack = await loadLatestPack(workspaceDirOf(pressureAgent))
check('80% 自动落了包', !!autoPack && autoPack.version === PACK_VERSION)
check('llm 不可用时退回纯事实（是活动统计）', (autoPack?.progress ?? '').includes('次工具调用'))
check('自动包 conclusionSource=activity', autoPack?.conclusionSource === 'activity')

/* ---------------- 8. /handoff 命令（官方 CommandDefinition 契约） ---------------- */

const cmdAgent = setAgent(makeAgent('sess_cmd_006'))
// 模拟桌面 UI 派发：rawInput 带前导分隔空格，验证 handler 链路原样接住
const cmdResult = await commands.get('handoff').handler({
  commandId: 'cmd_1',
  agent: cmdAgent,
  rawInput: ' cookie 签发链路收尾，剩过期测试',
  attachments: [],
  signal: new AbortController().signal,
})

check('/handoff handler 返回 CommandResult.success', cmdResult?.kind === 'success')
check('/handoff 落的包带了模型结论', (cmdResult?.text ?? '').includes('结论：已记录'))
check('/handoff 结论标注为亲写', (cmdResult?.text ?? '').includes('你自己写的'))

const cmdPack = await loadLatestPack(workspaceDirOf(cmdAgent))
check('rawInput 作为 summary 写进了 pack', (cmdPack?.progress ?? '').includes('cookie 签发链路收尾'))

/* ---------------- 9. 命令脱敏：密钥不落盘 ---------------- */

const cmdText = (cmdPack?.commands ?? []).join('\n')
check('密钥不落盘', !!cmdText && !cmdText.includes('sk-live-abcdef1234567890') && cmdText.includes('***'))

/* ---------------- 9b. 失败教训蒸馏（deadEnds） ---------------- */

const deadText = (packA?.deadEnds ?? []).join('\n')
check('packA 记录失败的工具调用', deadText.includes('edit') && deadText.includes('ENOENT'))
check('packA 标注重跑的命令', deadText.includes('跑了 2 次'))
check('失败原因里的密钥也脱敏', !deadText.includes('sk-deadbeef123456'))
check('成功的调用不进 deadEnds', !deadText.includes('call_pwsh_1'))
check('handoff_save 结果提到失败教训', saveOut.includes('失败教训'))

const deadSection = await tools.get('recall_context').execute({ section: 'deadEnds', packId: packA.id })
check('recall_context 能取 deadEnds 分节', deadSection.includes('ENOENT'))

/* ---------------- 10. handoff_list + packId 选历史包 ---------------- */

const listOut = await tools.get('handoff_list').execute({})
check('handoff_list 列出了 pack', listOut.includes(packA.id) && listOut.includes('Auth 迁 cookie'))
check('handoff_list 标出纯事实包', listOut.includes('[纯事实]'))

const oldById = await tools.get('recall_context').execute({ section: 'progress', packId: packA.id })
check('recall packId 能取到旧包的结论', oldById.includes('签发路径已切到 cookie'))
const latestNoId = await tools.get('recall_context').execute({ section: 'progress' })
check('不传 packId 默认取最新', latestNoId.includes('cookie 签发链路收尾'))

/* ---------------- 11. toSession 投递给运行中的会话 ---------------- */

const target = setAgent(makeAgent('sess_live_007'))
const saver = setAgent(makeAgent('sess_saver_008'))
const deliverOut = await tools.get('handoff_save').execute({
  summary: '测试投递结论：给运行中的会话。',
  toSession: 'sess_live_007',
})
check('toSession 投递成功', deliverOut.includes('已把交接摘要投递给会话 sess_live_007'))
check('目标会话收到了注入', target.injected.length === 1)
check('投递内容是 L0 结论', (target.injected[0]?.content?.[0]?.text ?? '').includes('测试投递结论'))

const missOut = await tools.get('handoff_save').execute({ summary: 'x', toSession: 'sess_ghost' })
check('未知会话给出活动会话列表', missOut.includes('没有正在运行的会话') && missOut.includes('sess_live_007'))

/* ---------------- 12. 结论自动补写（模型没传 summary） ---------------- */

// 换一个"能用"的 llm：吐一段合法 JSON
ctx.llm.stream = async function* () {
  yield {
    type: 'text-delta',
    index: 0,
    text: '{"summary":"签发路径已切到 cookie（模型补写）","nextStep":"补 session 过期测试。","openQuestions":["旧 token 要兼容期吗？"]}',
  }
}

const synthAgent = setAgent(makeAgent('sess_synth_009'))
const synthOut = await tools.get('handoff_save').execute({})
check('自动补写生效（结果里说明）', synthOut.includes('自动补写'))

const synthPack = await loadLatestPack(workspaceDirOf(synthAgent))
check('补写的结论写进了 pack', (synthPack?.progress ?? '').includes('模型补写'))
check('conclusionSource 标成 synth', synthPack?.conclusionSource === 'synth')
check('openQuestions 也补上了', (synthPack?.openQuestions ?? []).includes('旧 token 要兼容期吗？'))

// 开关：关掉后必须退回纯事实包
process.env.DSH_HANDOFF_SYNTH = '0'
const offAgent = setAgent(makeAgent('sess_off_010'))
const offOut = await tools.get('handoff_save').execute({})
check('DSH_HANDOFF_SYNTH=0 退回纯事实包', offOut.includes('只存了事实'))
const offPack = await loadLatestPack(workspaceDirOf(offAgent))
check('关闭时结论是活动统计', (offPack?.progress ?? '').includes('次工具调用'))
delete process.env.DSH_HANDOFF_SYNTH

// 恢复默认（无模型）：后续断言不受影响
ctx.llm.stream = async function* () {
  throw new Error('mock ctx has no llm stream')
}

/* ---------------- 13. 过期包注入时带警告 ---------------- */

// 把 cmdAgent 工作区的 latest.json 改成 10 天前（默认过期线 3 天）
const staleDir = workspaceDirOf(cmdAgent)
const staleRaw = JSON.parse(await readFile(join(staleDir, 'latest.json'), 'utf8'))
staleRaw.createdAt = new Date(Date.now() - 10 * 86_400_000).toISOString()
await writeFile(join(staleDir, 'latest.json'), JSON.stringify(staleRaw), 'utf8')

const staleAgent = setAgent(makeAgent('sess_stale_011'))
await fire('agent/created', { agent: staleAgent, source: 'startup' })
const staleText = staleAgent.injected[0]?.content?.[0]?.text ?? ''
check('过期包仍注入但带警告', staleText.includes('早已过期'))
check('警告放在摘要最前面', staleText.trimStart().startsWith('⚠'))
check('新鲜包不带警告', !(l0?.content?.[0]?.text ?? '').includes('早已过期'))

/* ---------------- 13. compaction 断点 ---------------- */

const compactAgent = setAgent(makeAgent('sess_compact_012'))
await fire('session/event', compactAgent.session, { type: 'compaction/start', data: {} })
await sleep(600)

const compactPack = await loadLatestPack(workspaceDirOf(compactAgent))
check('compaction/start 触发断点落盘', !!compactPack && compactPack.fromSession === 'sess_compact_012')
check('断点包 trigger=compaction', compactPack?.trigger === 'compaction')
check('断点包带失败教训', (compactPack?.deadEnds ?? []).length > 0)
check('断点包是纯事实（不补写结论）', compactPack?.conclusionSource === 'activity')

// 本会话已经存过包：断点不该用它把（可能更好的）包顶掉
const compactId = compactPack?.id
await fire('session/event', compactAgent.session, { type: 'compaction/start', data: {} })
await sleep(600)
const compactAfter = await loadLatestPack(workspaceDirOf(compactAgent))
check('本会话已有包时断点不覆盖', compactAfter?.id === compactId)

/* ---------------- 14. /handoff 子命令 ---------------- */

const dispatch = (rawInput, agent) =>
  commands.get('handoff').handler({
    commandId: `cmd_${checks.length}`,
    agent,
    rawInput,
    attachments: [],
    signal: new AbortController().signal,
  })

const subAgent = setAgent(makeAgent('sess_subcmd_013'))
const subList = await dispatch(' list', subAgent)
check('/handoff list 返回包列表', subList?.kind === 'success' && (subList.text ?? '').includes(packA.id))

const subShow = await dispatch(` show ${packA.id}`, subAgent)
check('/handoff show 预览结论', (subShow?.text ?? '').includes('签发路径已切到 cookie'))
check('/handoff show 带失败教训', (subShow?.text ?? '').includes('试过但不行的'))

const subShowNoId = await dispatch(' show', subAgent)
check('/handoff show 缺 id 给用法提示', (subShowNoId?.text ?? '').includes('用法'))

const subRestore = await dispatch(` restore ${packA.id}`, subAgent)
check('/handoff restore 注入当前会话', subAgent.injected.length === 1 && (subRestore?.text ?? '').includes('已把交接包'))

const subMissing = await dispatch(' restore nosuch99', subAgent)
check('/handoff restore 未命中给出提示', (subMissing?.text ?? '').includes('没找到'))

/* ---------------- 15. 延迟接力（按改动文件反推仓库根） ---------------- */

const repoDir = await mkdtemp(join(tmpdir(), 'dsh-handoff-repo-'))
await mkdir(join(repoDir, 'src'), { recursive: true })
await pExec('git', ['-C', repoDir, 'init'])
await pExec('git', ['-C', repoDir, 'remote', 'add', 'origin', 'git@github.com:foo/bar.git'])
await mirrorLatest(handoffRemoteRoot('github.com/foo/bar'), packA)

delete process.env.DSH_HANDOFF_NO_GIT
try {
  const lateAgent = setAgent(makeAgent('sess_late_014'))
  await fire('session/event', lateAgent.session, {
    type: 'tool/call',
    data: { turn: 1, name: 'edit', arguments: JSON.stringify({ file_path: join(repoDir, 'src', 'a.ts') }) },
  })
  await sleep(1_500)
  check('延迟接力：按改动文件反推仓库根后注入', lateAgent.injected.length === 1)
  check(
    '延迟接力注入的是 L0 摘要',
    (lateAgent.injected[0]?.content?.[0]?.text ?? '').includes('这是上一个会话的交接摘要'),
  )

  await fire('session/event', lateAgent.session, {
    type: 'tool/call',
    data: { turn: 2, name: 'edit', arguments: JSON.stringify({ file_path: join(repoDir, 'src', 'b.ts') }) },
  })
  await sleep(300)
  check('已接力的会话不再重复注入', lateAgent.injected.length === 1)
} finally {
  process.env.DSH_HANDOFF_NO_GIT = '1'
  await rm(repoDir, { recursive: true, force: true })
}

/* ---------------- 结果 ---------------- */

let failed = 0
for (const [label, ok] of checks) {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
}

await rm(home, { recursive: true, force: true })
console.log(failed === 0 ? `\n全部通过（${checks.length} 项）。` : `\n${failed} / ${checks.length} 项失败。`)
process.exitCode = failed === 0 ? 0 : 1

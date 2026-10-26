/**
 * 用真实会话日志回放蒸馏，检查接力包到底抽出了什么。
 *
 *   node scripts/replay-distill.mjs <会话目录 | .jsonl.zstd> [--json] [--brief=<file.json>] [--out=<file>]
 *
 * --brief 传一份 PackBrief（{summary, nextStep, openQuestions, refs}），
 * 用来对比"只有事实"和"事实 + 模型结论"两种包。
 *
 * 需要支持 zstd 的 Node（v22.15+ / v24+）。
 */

import { readFile, writeFile } from 'node:fs/promises'

import { fakeSession } from './session-log.mjs'
import { buildPack } from '../dist/distill.js'
import { toL0 } from '../dist/pack.js'

const target = process.argv[2]
if (!target) {
  console.error('usage: node scripts/replay-distill.mjs <session dir | file> [--json] [--brief=<file.json>]')
  process.exit(1)
}

const briefPath = process.argv.find((a) => a.startsWith('--brief='))?.slice('--brief='.length)
const brief = briefPath
  ? JSON.parse((await readFile(briefPath, 'utf8')).replace(/^\uFEFF/, ''))
  : undefined
/** --out=<file>：报告写成 UTF-8 文件，绕开 PowerShell 管道的编码问题 */
const outPath = process.argv.find((a) => a.startsWith('--out='))?.slice('--out='.length)

const { header, session } = await fakeSession(target)
const pack = buildPack({
  session,
  workspaceDir: header.cwd ?? process.cwd(),
  window: 1_000_000,
  pressure: { totalTokens: 657_851, window: 1_000_000, ratio: 0.657851 },
  brief,
})

const out = []
const say = (line = '') => out.push(line)

if (process.argv.includes('--json')) {
  say(JSON.stringify(pack, null, 2))
} else {
  say(`session : ${pack.fromSession}`)
  say(`title   : ${pack.fromTitle ?? '(无)'}`)
  say(`goal    : ${pack.goal}`)
  say(`focus   : ${pack.focus || '(空)'}`)
  say(`stats   : ${pack.stats.turns} 轮 / ${pack.stats.toolCalls} 次工具调用`)
  say(`files   : ${pack.files.length}`)
  say(`commands: ${pack.commands.length}`)
  say(`done    : ${pack.done.length}`)
  say(`refs    : ${pack.refs.length}`)
  say(`questions: ${pack.openQuestions.length}`)
  say(`\n--- 文件（按改动次数，前 12）---`)
  for (const f of pack.files.slice(0, 12)) say(`  ${f}`)
  say(`\n--- 命令（前 6，构建类优先）---`)
  for (const c of pack.commands.slice(0, 6)) say(`  ${c}`)
  say(`\n--- 已完成（前 15）---`)
  for (const d of pack.done.slice(0, 15)) say(`  - ${d}`)
  say(`\n--- 结论 ---`)
  say(pack.progress || '(空)')
  say(`\n--- 下一步 ---`)
  say(pack.nextStep || '(空)')
  say(`\n=== L0（${toL0(pack).length} 字符）===\n`)
  say(toL0(pack))
}

const report = out.join('\n')
if (outPath) {
  await writeFile(outPath, report, 'utf8')
  console.log(`wrote ${outPath}`)
} else {
  console.log(report)
}

/** --save：把回放结果真的写进 ~/.dsh/handoff/<workspace-key>/（用于从旧日志重建接力包） */
if (process.argv.includes('--save')) {
  const { handoffRoot, resolveWorkspace } = await import('../dist/workspace.js')
  const { savePack } = await import('../dist/pack.js')

  const ws = resolveWorkspace({ session: { header: { cwd: header.cwd } } })
  const dir = handoffRoot(ws)
  const saved = await savePack(dir, pack)
  console.log(`saved: ${saved}`)
  console.log(`workspace key: ${ws.key} (${ws.dir})`)
}

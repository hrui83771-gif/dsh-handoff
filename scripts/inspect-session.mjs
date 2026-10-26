/**
 * 探查真实会话日志，用来核对插件里"按文档猜"的形状。
 *
 *   node scripts/inspect-session.mjs <会话目录或 .jsonl.zstd 文件>
 *   node scripts/inspect-session.mjs <...> --type=tool/call --limit=3
 *
 * 解码逻辑在 session-log.mjs 里（多帧 zstd），这里只做统计和取样。
 * 需要支持 zstd 的 Node（v22.15+ / v24+）。
 */

import { loadSession } from './session-log.mjs'

const target = process.argv[2]
if (!target) {
  console.error('usage: node scripts/inspect-session.mjs <session dir | file> [--type=<event type>] [--limit=<n>]')
  process.exit(1)
}

const { logPath, events } = await loadSession(target)

console.log(`log: ${logPath}`)
console.log(`lines: ${events.length}, parsed: ${events.length}\n`)

const counts = new Map()
for (const e of events) {
  const type = e.type ?? '(header)'
  counts.set(type, (counts.get(type) ?? 0) + 1)
}
console.log('--- event types ---')
for (const [type, n] of [...counts].sort((a, b) => b[1] - a[1])) {
  console.log(`${String(n).padStart(5)}  ${type}`)
}

const typeFilter = process.argv.find((a) => a.startsWith('--type='))?.slice('--type='.length)
const limit = Number(process.argv.find((a) => a.startsWith('--limit='))?.slice('--limit='.length) ?? 1)

if (typeFilter) {
  const samples = events.filter((e) => e?.type === typeFilter).slice(0, limit)
  console.log(`\n=== ${typeFilter} (${samples.length} of ${counts.get(typeFilter) ?? 0}) ===`)
  for (const s of samples) console.log(JSON.stringify(s, null, 2).slice(0, 6000))
} else {
  const first = events[0]
  console.log('\n--- first record keys ---')
  console.log(JSON.stringify(first, null, 2).slice(0, 800))

  for (const type of [
    'user/message',
    'tool/call',
    'tool/result',
    'assistant/message',
    'workspace/changes',
    'todo/write',
    'session/title',
  ]) {
    const sample = events.find((e) => e?.type === type)
    console.log(`\n--- ${type} ---`)
    if (!sample) {
      console.log('(none)')
      continue
    }
    console.log(JSON.stringify(sample, null, 2).slice(0, 2000))
  }
}

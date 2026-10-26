/**
 * 只读校验：用插件自己的 loadLatestPack/toL0 读真实落盘包，
 * 确认版本、结构、L0 渲染都没问题（不写任何东西）。
 *
 *   node scripts/verify-pack.mjs <handoff 目录> [--out=<file>]
 */

import { writeFile } from 'node:fs/promises'

import { loadLatestPack, toL0 } from '../dist/pack.js'

const dir = process.argv[2]
if (!dir) {
  console.error('usage: node scripts/verify-pack.mjs <handoff dir> [--out=<file>]')
  process.exit(1)
}
const outPath = process.argv.find((a) => a.startsWith('--out='))?.slice('--out='.length)

const pack = await loadLatestPack(dir)
if (!pack) {
  console.log('loadLatestPack 返回 null（版本不匹配或文件损坏）')
  process.exit(1)
}

const l0 = toL0(pack)
const lines = [
  `pack        : ${pack.id}  v${pack.version}`,
  `fromSession : ${pack.fromSession}`,
  `goal        : ${pack.goal}`,
  `files/done  : ${pack.files.length} / ${pack.done.length}`,
  `refs        : ${pack.refs.join(', ') || '(无)'}`,
  `L0 长度     : ${l0.length} 字符（预算 4000）`,
  `L0 分节     : ${(l0.match(/^## .+$/gm) ?? []).join(' | ')}`,
  '',
  '--- L0 ---',
  '',
  l0,
]
const report = lines.join('\n')

if (outPath) {
  await writeFile(outPath, report, 'utf8')
  console.log(`wrote ${outPath}`)
} else {
  console.log(report)
}

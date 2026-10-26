/**
 * 从 Electron 的 app.asar 里按路径读取文件。
 *
 *   node scripts/asar-read.mjs <app.asar> <path/in/archive>
 *   node scripts/asar-read.mjs <app.asar> --find dsh-agent/package.json
 *
 * asar 布局：u32(=4) | u32(header pickle 大小) | u32(json 长度) | json | 文件数据
 */

import { open, writeFile } from 'node:fs/promises'

const [archive, query] = process.argv.slice(2)
if (!archive || !query) {
  console.error('usage: node scripts/asar-read.mjs <app.asar> <path | --find substring>')
  process.exit(1)
}

const fh = await open(archive, 'r')
try {
  const head = Buffer.alloc(16)
  await fh.read(head, 0, 16, 0)
  const headerSize = head.readUInt32LE(4)
  const jsonLen = head.readUInt32LE(12)
  const jsonBuf = Buffer.alloc(jsonLen)
  await fh.read(jsonBuf, 0, jsonLen, 16)
  const header = JSON.parse(jsonBuf.toString('utf8'))

  const dataOffset = 8 + headerSize

  const walk = (node, prefix, out) => {
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      const path = prefix ? `${prefix}/${name}` : name
      if (entry.files) walk(entry, path, out)
      else out.push({ path, size: entry.size, offset: entry.offset })
    }
    return out
  }

  const all = walk(header, '', [])

  if (query === '--find') {
    const needle = process.argv[4] ?? ''
    const hits = all.filter((e) => e.path.includes(needle))
    for (const h of hits.slice(0, 200)) console.log(`${String(h.size).padStart(9)}  ${h.path}`)
    console.log(`\n${hits.length} match(es) of ${all.length} files`)
  } else {
    const entry = all.find((e) => e.path === query)
    if (!entry) {
      console.error(`not found: ${query}`)
      process.exit(2)
    }
    const buf = Buffer.alloc(entry.size)
    await fh.read(buf, 0, entry.size, dataOffset + Number(entry.offset))

    // --out=<file>：写 UTF-8 文件，绕开 PowerShell 重定向的编码问题
    const outPath = process.argv.find((a) => a.startsWith('--out='))?.slice('--out='.length)
    if (outPath) {
      await writeFile(outPath, buf)
      console.error(`wrote ${outPath} (${entry.size} bytes)`)
    } else {
      process.stdout.write(buf)
    }
  }
} finally {
  await fh.close()
}

/**
 * 读取 dsh 会话日志（v4 JSONL，多帧 zstd 拼接）。
 *
 *   import { loadSession } from './session-log.mjs'
 *   const { events, messages, header } = await loadSession(path)
 *
 * dsh 每次 flush 追加一帧 zstd，Node 的 zstdDecompressSync 只解第一帧就返回
 * 且**不报错**，所以必须按帧魔数切开逐帧解压。
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

export function decodeZstd(buf) {
  const starts = []
  for (let i = 0; i + 4 <= buf.length; i += 1) {
    if (
      buf[i] === ZSTD_MAGIC[0] &&
      buf[i + 1] === ZSTD_MAGIC[1] &&
      buf[i + 2] === ZSTD_MAGIC[2] &&
      buf[i + 3] === ZSTD_MAGIC[3]
    ) {
      starts.push(i)
    }
  }
  if (starts.length === 0) throw new Error('not a zstd stream')

  const out = []
  let cursor = 0
  while (cursor < starts.length) {
    let decoded = false
    for (let end = cursor + 1; end <= starts.length; end += 1) {
      const from = starts[cursor]
      const to = end < starts.length ? starts[end] : buf.length
      try {
        out.push(zstdDecompressSync(buf.subarray(from, to)))
        cursor = end
        decoded = true
        break
      } catch {
        /* 魔数出现在压缩数据里：把下一段拼进来重试 */
      }
    }
    if (!decoded) cursor += 1
  }
  if (out.length === 0) throw new Error('failed to decode any zstd frame')
  return Buffer.concat(out)
}

export async function resolveLog(path) {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => null)
  if (!entries) return path
  const file = entries.find(
    (e) => e.isFile() && e.name.startsWith('session.') && e.name.includes('jsonl'),
  )
  if (!file) throw new Error(`no session log in ${path}`)
  return join(path, file.name)
}

/** 事件 → 投影消息。user/developer/system 的 data 本身就是消息。 */
function messageOf(event) {
  const data = event?.data
  if (!data) return null
  if (event.type === 'assistant/message') return data.message ?? null
  if (
    event.type === 'user/message' ||
    event.type === 'developer/message' ||
    event.type === 'system/message'
  ) {
    return data.role && data.content ? data : null
  }
  return null
}

export async function loadSession(path) {
  const logPath = await resolveLog(path)
  const raw = await readFile(logPath)
  const text = logPath.endsWith('.zstd')
    ? decodeZstd(raw).toString('utf8')
    : raw.toString('utf8')

  const events = text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)

  const header = events.find((e) => e.type === 'session') ?? {}
  const messages = events.map(messageOf).filter(Boolean)

  return { logPath, header, events, messages }
}

/** 把日志包成一个 dsh Session 的最小替身，供 distill 离线回放 */
export async function fakeSession(path) {
  const { header, events, messages } = await loadSession(path)
  return {
    header,
    session: {
      id: header.id,
      cwd: header.cwd,
      deriveMessages: () => messages,
      snapshotEvents: () => events,
    },
  }
}

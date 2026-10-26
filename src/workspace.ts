/**
 * workspace.ts —— 解析"这个会话属于哪个工作区"。
 *
 * 不能用 cwd 字符串直接当 key：working-directory 重映射、软链接、
 * Windows 盘符大小写都会让同一个项目算出不同 key，接力包就对不上了。
 * 这里先取真实路径再统一分隔符和大小写（仅 Windows）。
 */

import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'

export interface WorkspaceRef {
  /** 真实绝对路径，用于落盘 */
  dir: string
  /** 稳定 key，用于分目录 */
  key: string
  /** 展示名 */
  label: string
}

export interface WorkspaceSource {
  session?: {
    readonly cwd?: string
    readonly header?: { readonly cwd?: string }
  }
}

export function resolveWorkspace(agent: WorkspaceSource): WorkspaceRef {
  const raw: string =
    agent?.session?.cwd ?? agent?.session?.header?.cwd ?? process.cwd()

  let dir = resolve(raw)
  try {
    dir = realpathSync.native(dir)
  } catch {
    /* 目录可能还没建，用 resolve 的结果 */
  }

  const normalized = process.platform === 'win32' ? dir.toLowerCase() : dir
  const key = createHash('sha1').update(normalized).digest('hex').slice(0, 12)

  return { dir, key, label: basename(dir) || dir }
}

/** dsh 的 home 目录：优先环境变量，否则 ~/.dsh */
export function dshHome(): string {
  return process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
}

/**
 * 接力包的存放目录：~/.dsh/handoff/<workspace-key>/
 *
 * 刻意不写进用户项目里——插件不该在每个仓库拉出 .dsh/ 目录，
 * 而且工作区只读时也能落盘。
 */
export function handoffRoot(ws: WorkspaceRef): string {
  return join(dshHome(), 'handoff', ws.key)
}

/**
 * 跨机器接力的镜像目录：~/.dsh/handoff/remote-<key>/
 *
 * workspace-key 是本地路径 hash，换台机器必然对不上；仓库远端地址才是
 * 跨机器稳定的身份。落盘时往这里镜像一份 latest.json，恢复时本机 key
 * 目录找不到就按当前仓库的 origin 找到这里（见 index.ts）。
 */
export function handoffRemoteRoot(remote: string): string {
  const key = createHash('sha1').update(remote.trim().toLowerCase()).digest('hex').slice(0, 12)
  return join(dshHome(), 'handoff', `remote-${key}`)
}

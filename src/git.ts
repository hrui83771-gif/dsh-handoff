/**
 * git.ts —— 仓库身份（remote / branch / commit），给跨工作区接力用。
 *
 * workspace key 是本地真实路径的 hash：换机器、换 clone、挪盘，key 必然
 * 对不上，接力包就找不回来。仓库远端地址才是跨机器稳定的身份，所以 pack
 * 里顺手记一份，落盘时镜像一份到按远端 key 分的目录（见 index.ts）。
 *
 * 全部失败静默：git 不在 PATH、目录不是仓库、没有 origin —— 这时 pack
 * 退化成本机接力（和没有这个文件时完全一样），绝不影响主流程。
 */

import { execFile } from 'node:child_process'

export interface GitFacts {
  /** 归一化后的 origin 地址（用于比较和做 key） */
  remote?: string
  /** 原始 origin 地址（给人看） */
  remoteRaw?: string
  branch?: string
  commit?: string
}

const GIT_TIMEOUT_MS = 3_000

function runGit(dir: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      execFile(
        'git',
        ['-C', dir, ...args],
        { timeout: GIT_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' },
        (error, stdout) => {
          if (error) return resolve(undefined)
          const out = String(stdout ?? '').trim()
          resolve(out || undefined)
        },
      )
    } catch {
      resolve(undefined)
    }
  })
}

/**
 * 归一化远端地址，只做比较用的保守变换：
 *   git@github.com:foo/bar.git  → github.com/foo/bar
 *   https://github.com/foo/bar/ → github.com/foo/bar
 * 整串转小写——主机名大小写不敏感；路径部分宁可统一，同一远端在不同机器
 * 上写法一致的概率，远高于路径真的大小写不同。
 */
export function normalizeRemote(url: string): string {
  const raw = (url ?? '').trim()
  if (!raw) return ''

  let s = raw
  const scp = /^git@([^:]+):(.+)$/.exec(s) // scp 形式：git@host:path
  if (scp) s = `${scp[1]}/${scp[2]}`

  return s
    .replace(/^(https?|ssh):\/\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .toLowerCase()
}

/** 读取仓库身份。DSH_HANDOFF_NO_GIT=1 直接跳过（测试用）。 */
export async function gitFacts(dir: string): Promise<GitFacts> {
  if (process.env.DSH_HANDOFF_NO_GIT) return {}

  const [remoteRaw, branch, commit] = await Promise.all([
    runGit(dir, ['remote', 'get-url', 'origin']),
    runGit(dir, ['rev-parse', '--abbrev-ref', 'HEAD']),
    runGit(dir, ['rev-parse', 'HEAD']),
  ])

  const facts: GitFacts = {}
  const remote = remoteRaw ? normalizeRemote(remoteRaw) : undefined
  if (remote) {
    facts.remote = remote
    facts.remoteRaw = remoteRaw
  }
  // detached HEAD 时 rev-parse --abbrev-ref 回 "HEAD"，没有分支信息
  if (branch && branch !== 'HEAD') facts.branch = branch
  if (commit) facts.commit = commit
  return facts
}

/** 有没有任何仓库信息（决定要不要写进 pack） */
export function hasGitFacts(facts: GitFacts | undefined): facts is GitFacts {
  return !!(facts && (facts.remote || facts.branch || facts.commit))
}

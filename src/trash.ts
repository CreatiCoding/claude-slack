/**
 * "폴더 버리고 종료": move a session's folder to the Trash, never delete it, and never a folder whose loss
 * would take other things with it (home, anything above it, the default folder, the broker's own).
 * Before asking, say what would be lost: uncommitted changes and commits not pushed, per repository.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'

export interface RepoState {
  path: string
  /** Changed, added or untracked files. */
  uncommitted: number
  /** Commits on local branches that no remote has. */
  unpushed: number
  /** The checked-out branch, shown in the confirmation (48). */
  branch?: string
}

/** Why this folder must not go to the Trash, or undefined when it may. */
export function refuseReason(folder: string, protectedDirs: string[]): string | undefined {
  const f = resolve(folder)
  if (f === sep) return '루트 폴더는 버릴 수 없습니다.'
  for (const p of protectedDirs.map((d) => resolve(d))) {
    if (f === p) return `${p} 는 버릴 수 없는 폴더입니다.`
    if (p.startsWith(f + sep)) return `${p} 를 품은 상위 폴더라 버릴 수 없습니다.`
  }
  if (!existsSync(f) || !statSync(f).isDirectory()) return '폴더가 없습니다.'
  return undefined
}

/**
 * Why a folder may not go to the Trash (48), in the order the page explains it: missing, outside home or home
 * itself, directly under home, already in the Trash, the default folder, another living session's folder.
 */
export function trashRefusal(folder: string, o: { home: string; trashDir: string; defaultCwd: string; livingFolders: string[] }): string | undefined {
  const f = resolve(folder)
  const home = resolve(o.home)
  const inside = f.startsWith(home + sep)
  if (!existsSync(f) || !statSync(f).isDirectory()) return '폴더가 없어요'
  if (!inside || f === home) return '홈 폴더 밖이거나 홈 폴더 자체라서 버릴 수 없어요'
  if (dirname(f) === home) return '홈 바로 아래 폴더는 버릴 수 없어요'
  const trash = resolve(o.trashDir)
  if (f === trash || f.startsWith(trash + sep)) return '이미 휴지통 안에 있어요'
  if (f === resolve(o.defaultCwd)) return '기본 세션 폴더는 버릴 수 없어요'
  if (o.livingFolders.some((x) => resolve(x) === f)) return '다른 살아 있는 세션이 쓰는 폴더라 버릴 수 없어요'
  return undefined
}

const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] })

/** Repositories in the folder (itself, and up to two levels down), with what each would lose. */
export function repoStates(folder: string): RepoState[] {
  const found: string[] = []
  const walk = (dir: string, depth: number) => {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    if (names.includes('.git')) found.push(dir)
    if (depth >= 2) return
    for (const n of names) {
      if (n === '.git' || n === 'node_modules' || n.startsWith('.')) continue
      const p = join(dir, n)
      try {
        if (statSync(p).isDirectory()) walk(p, depth + 1)
      } catch {}
    }
  }
  walk(resolve(folder), 0)
  return found.map((path) => {
    let uncommitted = 0
    let unpushed = 0
    try {
      uncommitted = git(path, ['status', '--porcelain']).split('\n').filter(Boolean).length
    } catch {}
    try {
      unpushed = git(path, ['log', '--branches', '--not', '--remotes', '--oneline']).split('\n').filter(Boolean).length
    } catch {}
    let branch: string | undefined
    try {
      branch = git(path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim() || undefined
    } catch {}
    return { path, uncommitted, unpushed, branch }
  })
}

/** Move to the Trash under its own name (with a time suffix when that name is taken). Returns where it went. */
export function moveToTrash(folder: string, trashDir = join(homedir(), '.Trash')): string {
  mkdirSync(trashDir, { recursive: true })
  let dest = join(trashDir, basename(folder))
  if (existsSync(dest)) dest = `${dest} ${new Date().toISOString().replace(/[:.]/g, '-')}`
  renameSync(folder, dest)
  return dest
}

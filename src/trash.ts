/**
 * "폴더 버리고 종료": move a session's folder to the Trash, never delete it, and never a folder whose loss
 * would take other things with it (home, anything above it, the default folder, the broker's own).
 * Before asking, say what would be lost: uncommitted changes and commits not pushed, per repository.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'

export interface RepoState {
  path: string
  /** Changed, added or untracked files. */
  uncommitted: number
  /** Commits on local branches that no remote has. */
  unpushed: number
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
    return { path, uncommitted, unpushed }
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

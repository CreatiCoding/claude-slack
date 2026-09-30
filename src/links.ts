/**
 * The links a session is about, for the chips above the web app's input: the pull request of the branch it
 * works on (asked of gh, in the folder and in clones inside it) and Slack threads, its own and any mentioned.
 */
import { execFile } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export interface Link {
  url: string
  label: string
}

const PR_RE = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g
const SLACK_RE = /https:\/\/[\w-]+\.slack\.com\/archives\/[A-Z0-9]+\/p\d{16}(?:\?[^\s)>|]*)?/g

/** Links of a kind found in some text, first mention first, each once. */
export function linksIn(texts: string[], kind: 'pr' | 'slack'): string[] {
  const out: string[] = []
  for (const t of texts) for (const m of t.matchAll(kind === 'pr' ? PR_RE : SLACK_RE)) if (!out.includes(m[0])) out.push(m[0])
  return out
}

/** Git work trees in a folder: itself and up to two levels down. */
export function repos(folder: string): string[] {
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
      if (n.startsWith('.') || n === 'node_modules') continue
      const p = join(dir, n)
      try {
        if (statSync(p).isDirectory()) walk(p, depth + 1)
      } catch {}
    }
  }
  if (existsSync(folder)) walk(folder, 0)
  return found
}

/** The open PR of the checked-out branch in one repository, if gh knows one. */
export function branchPr(repo: string, gh = 'gh'): Promise<Link | undefined> {
  return new Promise((resolve) =>
    execFile(gh, ['pr', 'view', '--json', 'url,title,number,state'], { cwd: repo, timeout: 8000 }, (err, out) => {
      if (err) return resolve(undefined)
      try {
        const pr = JSON.parse(out) as { url: string; title: string; number: number; state: string }
        resolve({ url: pr.url, label: `#${pr.number} ${pr.title}${pr.state === 'OPEN' ? '' : ` (${pr.state.toLowerCase()})`}` })
      } catch {
        resolve(undefined)
      }
    }),
  )
}

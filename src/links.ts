/**
 * The links a session is about, for the chips above the web app's input: the pull request of the branch it
 * works on (asked of gh, in the folder and in clones inside it) and Slack threads, its own and any mentioned.
 */
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export interface Link {
  url: string
  label: string
  /** A pull request's state, for its coloured icon: open green, draft grey, merged purple, closed red, and
   *  missing when gh cannot say (50). */
  state?: 'OPEN' | 'DRAFT' | 'MERGED' | 'CLOSED' | 'MISSING'
  number?: number
}

/** The hosts whose pull requests count (50): github.com, plus any set in CLAUDE_SLACK_GITHUB_HOSTS (comma list). */
export function prHosts(env = process.env.CLAUDE_SLACK_GITHUB_HOSTS ?? ''): string[] {
  return ['github.com', ...env.split(',').map((h) => h.trim()).filter(Boolean)].filter((h, i, all) => all.indexOf(h) === i)
}
const prRe = (hosts: string[]) => new RegExp(`https://(?:${hosts.map((h) => h.replace(/\./g, '\\.')).join('|')})/[\\w.-]+/[\\w.-]+/pull/\\d+`, 'g')
const SLACK_RE = /https:\/\/[\w-]+\.slack\.com\/archives\/[A-Z0-9]+\/p\d{16}(?:\?[^\s)>|]*)?/g

/** Links of a kind found in some text, first mention first, each once. */
export function linksIn(texts: string[], kind: 'pr' | 'slack', hosts: string[] = prHosts()): string[] {
  const out: string[] = []
  const re = kind === 'pr' ? prRe(hosts) : SLACK_RE
  for (const t of texts) for (const m of t.matchAll(re)) if (!out.includes(m[0])) out.push(m[0])
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

const branchInflight = new Map<string, Promise<Link | undefined>>()
/** The open PR of the checked-out branch in one repository, if gh knows one. The same repo asked twice at once is one gh call. */
export function branchPr(repo: string, gh = 'gh'): Promise<Link | undefined> {
  const running = branchInflight.get(repo)
  if (running) return running
  const p = branchPrOnce(repo, gh).finally(() => branchInflight.delete(repo))
  branchInflight.set(repo, p)
  return p
}
function branchPrOnce(repo: string, gh: string): Promise<Link | undefined> {
  return new Promise((resolve) =>
    execFile(gh, ['pr', 'view', '--json', 'url,title,number,state,isDraft'], { cwd: repo, timeout: 8000 }, (err, out) => {
      if (err) return resolve(undefined)
      try {
        const pr = JSON.parse(out) as { url: string; title: string; number: number; state: string; isDraft?: boolean }
        resolve({ url: pr.url, label: `#${pr.number} ${pr.title}`, state: prState(pr), number: pr.number })
      } catch {
        resolve(undefined)
      }
    }),
  )
}

/** The host of a folder's `origin` remote, when it is a web address (50). Empty when there is none. */
export function originHosts(folder: string): string[] {
  try {
    const url = execFileSync('git', ['-C', folder, 'remote', 'get-url', 'origin'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    const host = /^(?:https?:\/\/|ssh:\/\/git@|git@)([^/:]+)/.exec(url)?.[1]
    return host ? [host] : []
  } catch {
    return []
  }
}

/** The state the chip shows: a draft is its own (50), anything gh does not name is missing. */
export function prState(pr: { state?: string; isDraft?: boolean }): Link['state'] {
  if (pr.state === 'OPEN' && pr.isDraft) return 'DRAFT'
  if (pr.state === 'OPEN' || pr.state === 'MERGED' || pr.state === 'CLOSED') return pr.state
  return 'MISSING'
}

/** A merged or closed PR does not change again: remembered for good. An open one is asked again after 90 s (50). */
const prStates = new Map<string, { at: number; link: Link }>()
/** Asks under way, so the same address asked twice at once is one gh call. */
const inflight = new Map<string, Promise<Link>>()
/** gh failed (or timed out) for this address: not asked again for a minute, so a dead host is not waited on each time. */
const failed = new Map<string, number>()
const PR_STATES_MAX = 500
export const _prStateCount = () => prStates.size

function remember(url: string, link: Link): void {
  prStates.delete(url)
  prStates.set(url, { at: Date.now(), link })
  while (prStates.size > PR_STATES_MAX) prStates.delete(prStates.keys().next().value!)
}

/** The state and title of PRs by address, asked of gh four at a time. */
export async function prInfo(urls: string[], gh = 'gh'): Promise<Link[]> {
  const fallback = (url: string): Link => ({ url, label: url.replace(/^https:\/\/github\.com\//, '').replace('/pull/', ' #'), number: Number(/\/pull\/(\d+)/.exec(url)?.[1]) || undefined })
  const ask = (url: string): Promise<Link> => {
    const known = prStates.get(url)
    if (known && (known.link.state !== 'OPEN' && known.link.state !== 'DRAFT' || Date.now() - known.at < 90_000)) return Promise.resolve(known.link)
    if (Date.now() - (failed.get(url) ?? 0) < 60_000) return Promise.resolve(known?.link ?? fallback(url))
    const running = inflight.get(url)
    if (running) return running
    const p = new Promise<Link>((resolve) => {
      execFile(gh, ['pr', 'view', url, '--json', 'url,title,number,state,isDraft'], { timeout: 8000 }, (err, out) => {
        if (err) {
          failed.set(url, Date.now())
          if (failed.size > PR_STATES_MAX) failed.delete(failed.keys().next().value!)
          return resolve(known?.link ?? fallback(url))
        }
        try {
          const pr = JSON.parse(out) as { title: string; number: number; state: string; isDraft?: boolean }
          const link: Link = { url, label: `#${pr.number} ${pr.title}`, state: prState(pr), number: pr.number }
          remember(url, link)
          resolve(link)
        } catch {
          resolve(fallback(url))
        }
      })
    }).finally(() => inflight.delete(url))
    inflight.set(url, p)
    return p
  }
  const out: Link[] = []
  for (let i = 0; i < urls.length; i += 4) out.push(...(await Promise.all(urls.slice(i, i + 4).map(ask))))
  return out
}

/** Open ones first, then the newest (largest number) first. */
export function sortPrs(prs: Link[]): Link[] {
  return [...prs].sort((a, b) => (a.state === 'OPEN' ? 0 : 1) - (b.state === 'OPEN' ? 0 : 1) || (b.number ?? 0) - (a.number ?? 0))
}

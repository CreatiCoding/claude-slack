/**
 * The newest message of every Slack thread, kept on the machine so a link that lands on it is known without asking Slack.
 * Every message exchanged in a thread updates it; the admin page opens the link as it is.
 *
 * `base` is `https://<workspace>.slack.com/archives/<channel>/`, learnt once from any permalink; a message's link is that
 * base, `p` + its ts without the dot, and for a reply `?thread_ts=<root>&cid=<channel>`.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const DEFAULT_LINKS_PATH = process.env.CLAUDE_SLACK_LINKS ?? join(homedir(), '.claude-slack', 'thread-links.json')
/** Old threads are dropped past this; the newest are the ones anyone opens. */
const MAX_THREADS = 500
const SAVE_DELAY_MS = 1000

export class ThreadLinks {
  private path: string
  private channel: string
  private base?: string
  private latest = new Map<string, string>()
  private loaded = false
  private timer?: ReturnType<typeof setTimeout>
  private dirty = false

  constructor(channel: string, path = DEFAULT_LINKS_PATH) {
    this.channel = channel
    this.path = path
  }

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      const d = JSON.parse(readFileSync(this.path, 'utf8')) as { base?: string; latest?: Record<string, string> }
      if (typeof d.base === 'string') this.base = d.base
      for (const [k, v] of Object.entries(d.latest ?? {})) this.latest.set(k, v)
    } catch {}
  }

  /** Record a message in a thread; only a newer one replaces what is known. */
  note(threadTs: string, ts: string): void {
    this.load()
    const known = this.latest.get(threadTs)
    if (known && Number(known) >= Number(ts)) return
    this.latest.set(threadTs, ts)
    this.saveSoon()
  }

  has(threadTs: string): boolean {
    this.load()
    return this.latest.has(threadTs)
  }

  /** Learn the link's shape from a permalink Slack gave. */
  learn(permalink: string | undefined): void {
    this.load()
    const base = /^(https:\/\/[^/]+\/archives\/[^/]+\/)p\d+/.exec(permalink ?? '')?.[1]
    if (base && base !== this.base) {
      this.base = base
      this.saveSoon()
    }
  }

  get known(): boolean {
    this.load()
    return !!this.base
  }

  /** The link to a thread's newest message, or undefined until the shape is known. */
  linkTo(threadTs: string): string | undefined {
    this.load()
    if (!this.base) return undefined
    const last = this.latest.get(threadTs) ?? threadTs
    return `${this.base}p${last.replace('.', '')}${last === threadTs ? '' : `?thread_ts=${threadTs}&cid=${this.channel}`}`
  }

  private saveSoon(): void {
    this.dirty = true
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.flush()
    }, SAVE_DELAY_MS)
    this.timer.unref?.()
  }

  /** Write what changed; called on a timer and when the broker saves its state or stops. */
  flush(): void {
    if (!this.dirty) return
    this.dirty = false
    const newest = [...this.latest.entries()].sort((a, b) => Number(b[0]) - Number(a[0])).slice(0, MAX_THREADS)
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      writeFileSync(this.path, JSON.stringify({ base: this.base, latest: Object.fromEntries(newest) }) + '\n')
    } catch {}
  }
}

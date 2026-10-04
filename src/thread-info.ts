/**
 * What a Slack thread link is about (51): its channel name, the first message's author and the first 120
 * characters. Kept in a file for good (a thread's first message does not change), so the page's menu can show
 * `#채널 · 작성자 · 첫 글` after a restart without asking Slack again.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const DEFAULT_THREAD_INFO_PATH = process.env.CLAUDE_SLACK_THREAD_INFO ?? join(homedir(), '.claude-slack', 'thread-info.json')

export interface ThreadInfo {
  channel: string
  user: string
  text: string
}

/** A Slack message link's channel id and message ts (`…/archives/C1/p1000000100000001`). */
export function parseSlackLink(url: string): { channel: string; ts: string } | undefined {
  const m = /\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})/.exec(url)
  return m ? { channel: m[1]!, ts: `${m[2]}.${m[3]}` } : undefined
}

export class ThreadInfoStore {
  private items = new Map<string, ThreadInfo>()
  private failed = new Map<string, number>()

  private file: string

  constructor(file = DEFAULT_THREAD_INFO_PATH) {
    this.file = file
    try {
      if (existsSync(file)) this.items = new Map(Object.entries(JSON.parse(readFileSync(file, 'utf8')) as Record<string, ThreadInfo>))
    } catch {
      this.items = new Map()
    }
  }

  get(ts: string): ThreadInfo | undefined {
    return this.items.get(ts)
  }

  set(ts: string, info: ThreadInfo): void {
    this.items.set(ts, info)
    this.failed.delete(ts)
    this.save()
  }

  /** A failed lookup waits: 30 minutes, or 60 s when Slack rate-limited it (51). */
  markFailed(ts: string, waitMs: number, now = Date.now()): void {
    this.failed.set(ts, now + waitMs)
  }

  /** Worth asking now: not known, and not waiting out a failure. */
  wanted(ts: string, now = Date.now()): boolean {
    return !this.items.has(ts) && (this.failed.get(ts) ?? 0) <= now
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.items)))
      renameSync(tmp, this.file)
    } catch {
      // Best-effort: asked again after a restart if the file could not be written.
    }
  }
}

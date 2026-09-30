/**
 * Session events: what happened in a session, independent of where it is shown.
 *
 * Slack gets its messages from the broker directly. The web app gets the same
 * story as a numbered log per thread, so a tab that was asleep can ask "what
 * came after seq N" and catch up exactly, instead of re-reading a Slack thread.
 *
 * Keyed by thread, not by session: a refresh relaunches Claude Code in the same
 * thread under a new launch key, and to a person it is one conversation.
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_EVENTS_DIR = process.env.CLAUDE_SLACK_EVENTS_DIR ?? join(homedir(), '.claude-slack', 'events')

/** Kept in memory per thread; older ones are still in the file. */
const MEMORY_PER_THREAD = 3000
/** At most this many in one catch-up answer, and about this many bytes; the page asks again from the last one it got. */
const PAGE = 1000
const PAGE_BYTES = 1_000_000

export type EventBody =
  /** Something a person said: typed in Slack, in the web app, or in the terminal. */
  | { type: 'user'; ts: string; text: string; via: 'slack' | 'web' | 'terminal' }
  /** Claude's answer text, as markdown. */
  | { type: 'text'; text: string; files?: string[] }
  | { type: 'tool'; id: string; name: string; title: string; detail?: string }
  | { type: 'tool_end'; id: string; ok: boolean; output: string }
  | { type: 'todos'; todos: Array<{ content: string; status: string; activeForm?: string }> }
  /** A message the broker put in the thread (cards, notices, command output), with its Slack blocks so buttons work the same. */
  | { type: 'msg'; ts: string; text: string; blocks?: unknown[]; ephemeral?: boolean; files?: string[] }
  | { type: 'msg_update'; ts: string; text: string; blocks?: unknown[] }
  | { type: 'msg_delete'; ts: string }
  | { type: 'react'; ts: string; name: string; on: boolean }
  | { type: 'status'; state: string; waiting?: string }
  | { type: 'end'; why: string }

export type SessionEvent = EventBody & { seq: number; at: number }

type Listener = (thread: string, ev: SessionEvent) => void

export class EventLog {
  private dir: string
  private threads = new Map<string, { seq: number; events: SessionEvent[] }>()
  private listeners = new Set<Listener>()

  constructor(dir = DEFAULT_EVENTS_DIR) {
    this.dir = dir
  }

  private file(thread: string): string {
    // A Slack ts is digits and one dot; anything else never reaches the disk.
    if (!/^\d+\.\d+$/.test(thread)) throw new Error(`not a thread ts: ${thread}`)
    return join(this.dir, `${thread}.jsonl`)
  }

  private load(thread: string): { seq: number; events: SessionEvent[] } {
    let t = this.threads.get(thread)
    if (t) return t
    this.file(thread) // throws for anything that is not a thread ts
    const events: SessionEvent[] = []
    try {
      for (const line of readFileSync(this.file(thread), 'utf8').split('\n')) {
        if (!line) continue
        try {
          events.push(JSON.parse(line) as SessionEvent)
        } catch {
          // A line cut short by a crash: the rest of the file is still good.
        }
      }
    } catch {
      // No file yet.
    }
    t = { seq: events.at(-1)?.seq ?? 0, events: events.slice(-MEMORY_PER_THREAD) }
    this.threads.set(thread, t)
    return t
  }

  emit(thread: string, body: EventBody): SessionEvent | undefined {
    let t: { seq: number; events: SessionEvent[] }
    try {
      t = this.load(thread)
    } catch {
      return undefined
    }
    const ev = { ...body, seq: t.seq + 1, at: Date.now() } as SessionEvent
    t.seq = ev.seq
    t.events.push(ev)
    if (t.events.length > MEMORY_PER_THREAD) t.events.splice(0, t.events.length - MEMORY_PER_THREAD)
    try {
      mkdirSync(this.dir, { recursive: true })
      appendFileSync(this.file(thread), JSON.stringify(ev) + '\n')
    } catch {
      // The live listeners still get it; only a later catch-up would miss it.
    }
    for (const l of this.listeners) {
      try {
        l(thread, ev)
      } catch {
        // One broken listener must not stop the others.
      }
    }
    return ev
  }

  /** The newest seq of a thread, 0 when nothing happened there yet. */
  last(thread: string): number {
    try {
      return this.load(thread).seq
    } catch {
      return 0
    }
  }

  /** Events after `after`, oldest first, at most one page. Older than memory holds: read from the file. */
  since(thread: string, after: number): SessionEvent[] {
    let t: { seq: number; events: SessionEvent[] }
    try {
      t = this.load(thread)
    } catch {
      return []
    }
    const first = t.events[0]?.seq ?? t.seq + 1
    let pool = t.events
    if (after + 1 < first) {
      pool = []
      try {
        for (const line of readFileSync(this.file(thread), 'utf8').split('\n')) {
          if (!line) continue
          try {
            const ev = JSON.parse(line) as SessionEvent
            if (ev.seq > after) pool.push(ev)
            if (pool.length >= PAGE) break
          } catch {}
        }
      } catch {}
    }
    const out: SessionEvent[] = []
    let bytes = 0
    for (const ev of pool) {
      if (ev.seq <= after) continue
      // Always at least one, however large: otherwise a page could never get past it.
      bytes += JSON.stringify(ev).length
      if (out.length && bytes > PAGE_BYTES) break
      out.push(ev)
      if (out.length >= PAGE) break
    }
    return out
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }
}

/**
 * Where each session's transcript reading stopped.
 *
 * The tailer starts at the end of the file, which is right for a new session
 * and wrong after a restart: everything Claude Code wrote while the broker was
 * down is skipped, and the thread looks frozen mid-answer. Remembering the
 * position lets a restart pick up exactly where it left off.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const DEFAULT_OFFSETS_PATH = process.env.CLAUDE_SLACK_OFFSETS ?? join(homedir(), '.claude-slack', 'offsets.json')

/** Keyed by session key; the path is stored so a rotated transcript is not resumed by mistake. */
interface Entry {
  path: string
  offset: number
}

export class OffsetStore {
  private file: string
  private entries: Record<string, Entry>
  private dirty = false

  constructor(file = DEFAULT_OFFSETS_PATH, flushAfterMs = 500) {
    this.file = file
    this.flushAfterMs = flushAfterMs
    this.entries = this.load()
  }

  private load(): Record<string, Entry> {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, Entry>
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }

  /** Where to resume for this session and file, or undefined to start at the end. */
  get(key: string, path: string): number | undefined {
    const e = this.entries[key]
    return e && e.path === path ? e.offset : undefined
  }

  private timer?: ReturnType<typeof setTimeout>
  /** A crash loses whatever was read since the last write; keep that window short. */
  private flushAfterMs: number

  set(key: string, path: string, offset: number): void {
    const e = this.entries[key]
    if (e && e.path === path && e.offset === offset) return
    this.entries[key] = { path, offset }
    this.dirty = true
    this.scheduleFlush()
  }

  private scheduleFlush(): void {
    if (this.timer || this.flushAfterMs <= 0) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.flush()
    }, this.flushAfterMs)
    this.timer.unref?.()
  }

  forget(key: string): void {
    if (!(key in this.entries)) return
    delete this.entries[key]
    this.dirty = true
  }

  /** Write if anything changed. Cheap enough to call on a timer and on shutdown. */
  flush(): void {
    if (!this.dirty) return
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify(this.entries))
      this.dirty = false
    } catch {
      // Losing the file only costs us the resume, never correctness.
    }
  }
}

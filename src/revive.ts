/**
 * Which sessions were alive when the broker went down.
 *
 * The broker now comes back on its own after a reboot, but the Claude Code
 * processes it was talking to do not: the machine took them with it. Their
 * conversations survive on disk, so remembering which session belonged to which
 * thread is enough to bring each one back where it was, with `--resume`.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const DEFAULT_REVIVE_PATH = process.env.CLAUDE_SLACK_REVIVE ?? join(homedir(), '.claude-slack', 'live.json')

export interface ReviveEntry {
  /** Claude Code's own session id, which is what `--resume` takes. */
  sessionId: string
  cwd: string
  threadTs: string
  rootTs?: string
  /** The process's pid when this was recorded; a thread is found by threadTs, but this is kept for lookups that only have the pid. */
  pid?: number
  /** The tmux pane the process runs in, so a revival can check whether that process is still there before launching a second one. */
  pane?: string
  /** When the process started (epoch ms, `ps` precision), for the rare session with no pane to check instead. */
  processStartedAt?: number
  /** Who the turn streams to, so a revived session answers the same person. */
  recipient: string
  /** Refreshed while the session lives, so it doubles as "when we last saw it". */
  lastSeen: number
  /** Messages held for a running tool when the broker went down; delivered on return. */
  held?: Array<{ text: string; user: string; ts: string }>
  /** The "holding N messages" card in the thread, so it can be taken down once they are delivered, whichever broker does it. */
  holdNoticeTs?: string
  /** Permission cards still open in the thread. Only meaningful while the same process is alive (same pid). */
  pendingPermissions?: Array<{ msgTs: string; pid: number; requestId: string; toolName: string; at: number }>
  notify?: 'decisions' | 'on' | 'off'
  view?: 'summary' | 'normal' | 'verbose'
  title?: string
  manualTitle?: string
  autoAllow?: boolean
  model?: string
  launchModel?: string
  /** "끝나면 새로고침" was reserved at this time. */
  refreshAfter?: number
  effort?: string
  /** Permission mode at the time (42): a refresh or a revive carries it over. */
  permissionMode?: string
}

export class ReviveStore {
  private file: string
  private entries: Record<string, ReviveEntry>
  private dirty = false

  constructor(file = DEFAULT_REVIVE_PATH) {
    this.file = file
    this.entries = this.load()
  }

  private load(): Record<string, ReviveEntry> {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, ReviveEntry>
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }

  /** What was recorded before this broker started. Read once, before `note` overwrites it. */
  taken(): Array<ReviveEntry & { key: string }> {
    return Object.entries(this.entries).map(([key, e]) => ({ ...e, key }))
  }

  note(key: string, e: Omit<ReviveEntry, 'lastSeen'>, now = Date.now()): void {
    const prev = this.entries[key]
    // A session that has not moved still needs its clock kept, but writing the
    // file for that alone would churn; a minute of drift costs nothing. What was
    // held or left open must land at once, though: that is the part a crash loses.
    const { lastSeen: _prevSeen, ...prevRest } = prev ?? ({} as ReviveEntry)
    const same = prev && JSON.stringify(prevRest) === JSON.stringify(e)
    if (same && now - prev.lastSeen < 60_000) return
    this.entries[key] = { ...e, lastSeen: now }
    this.dirty = true
  }

  forget(key: string): void {
    if (!(key in this.entries)) return
    delete this.entries[key]
    this.dirty = true
  }

  /** Drop everything: used once the revival pass has decided what to do. */
  clear(): void {
    if (!Object.keys(this.entries).length) return
    this.entries = {}
    this.dirty = true
  }

  flush(): void {
    if (!this.dirty) return
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify(this.entries))
      this.dirty = false
    } catch {
      // Losing the file only costs us the revival, never correctness.
    }
  }
}

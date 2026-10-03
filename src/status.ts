/**
 * What `scripts/statusline.ts` last saw for a session: cost, model, whether the transcript is near the
 * 200k-token mark. Claude Code calls a `statusLine` command on (almost) every render with a JSON blob on
 * stdin; `scripts/statusline.ts` is that command, registered per-launch via `--settings` (not the global
 * `~/.claude/settings.json` — a broker-managed session gets its own statusLine without touching the
 * person's own Claude Code setup), and it writes the fields the broker cares about to one file per
 * session key here. This store just reads that file back; nothing in this process writes it.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_STATUS_DIR = process.env.CLAUDE_SLACK_STATUS_DIR ?? join(homedir(), '.claude-slack', 'status')

export interface SessionStatus {
  at: number
  model?: string
  costUsd?: number
  durationMs?: number
  exceeds200k?: boolean
}

export class StatusStore {
  private dir: string

  constructor(dir = DEFAULT_STATUS_DIR) {
    this.dir = dir
  }

  /** `undefined` when the session never rendered a status line yet (just launched) or the file is gone. */
  get(sessionKey: string): SessionStatus | undefined {
    if (!sessionKey) return undefined
    try {
      const parsed = JSON.parse(readFileSync(join(this.dir, `${sessionKey}.json`), 'utf8')) as SessionStatus
      return typeof parsed.at === 'number' ? parsed : undefined
    } catch {
      return undefined
    }
  }
}

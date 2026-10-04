/**
 * What `scripts/statusline.ts` last saw for a session: cost, model, whether the transcript is near the
 * 200k-token mark. Claude Code calls a `statusLine` command on (almost) every render with a JSON blob on
 * stdin; `scripts/statusline.ts` is that command, registered per-launch via `--settings` (not the global
 * `~/.claude/settings.json` — a broker-managed session gets its own statusLine without touching the
 * person's own Claude Code setup), and it writes the fields the broker cares about to one file per
 * session key here. This store just reads that file back; nothing in this process writes it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_STATUS_DIR = process.env.CLAUDE_SLACK_STATUS_DIR ?? join(homedir(), '.claude-slack', 'status')

export interface RateWindow {
  used?: number
  resetsAt?: number
}

export interface SessionStatus {
  at: number
  model?: string
  costUsd?: number
  durationMs?: number
  exceeds200k?: boolean
  /** The status line's context-window use, as Claude Code reports it (43). */
  contextPercent?: number
  contextSize?: number
  contextUsed?: number
  rateLimits?: { fiveHour?: RateWindow; sevenDay?: RateWindow }
}

/** How much of the plan's five-hour and weekly window is used now (43). A window that has already reset is 0. */
export interface PlanUsage {
  fiveHour?: number
  sevenDay?: number
  /** When each window resets, epoch ms (77: the gauge's tooltip). */
  fiveHourResetsAt?: number
  sevenDayResetsAt?: number
}

const USAGE_CACHE_MS = 5_000

export class StatusStore {
  private dir: string
  private usageCache?: { at: number; usage: PlanUsage | undefined }

  constructor(dir = DEFAULT_STATUS_DIR) {
    this.dir = dir
  }

  /**
   * The plan's usage, the same for every session: the newest status file that carries it, read at most once
   * every 5 s (43).
   */
  usage(now = Date.now()): PlanUsage | undefined {
    if (this.usageCache && now - this.usageCache.at < USAGE_CACHE_MS) return this.usageCache.usage
    let newest: SessionStatus | undefined
    let newestAt = -1
    try {
      for (const name of readdirSync(this.dir)) {
        if (!name.endsWith('.json')) continue
        const mtime = statSync(join(this.dir, name)).mtimeMs
        if (mtime <= newestAt) continue
        try {
          const parsed = JSON.parse(readFileSync(join(this.dir, name), 'utf8')) as SessionStatus
          if (parsed.rateLimits) {
            newest = parsed
            newestAt = mtime
          }
        } catch {
          // A file being written: skip it this time.
        }
      }
    } catch {
      // No status directory yet.
    }
    const rl = newest?.rateLimits
    const pct = (w: RateWindow | undefined) => (!w || typeof w.used !== 'number' ? undefined : w.resetsAt && w.resetsAt * 1000 <= now ? 0 : Math.round(w.used))
    const reset = (w: RateWindow | undefined) => (w?.resetsAt ? w.resetsAt * 1000 : undefined)
    const usage = rl ? { fiveHour: pct(rl.fiveHour), sevenDay: pct(rl.sevenDay), fiveHourResetsAt: reset(rl.fiveHour), sevenDayResetsAt: reset(rl.sevenDay) } : undefined
    this.usageCache = { at: now, usage }
    return usage
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

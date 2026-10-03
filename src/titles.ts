/**
 * Names a person chose for a conversation (`applyTitle`), kept by the conversation's own id so the name
 * survives past the live session: a resume, a revival, or the "이어서 하기"/보관 list all show it instead of
 * whatever ai-title or last-prompt guess would otherwise stand in for a title.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const DEFAULT_TITLES_PATH = process.env.CLAUDE_SLACK_TITLES ?? join(homedir(), '.claude-slack', 'titles.json')
/** Older entries are dropped past this; a name someone set recently is the one worth keeping around. */
const MAX_TITLES = 500

export class TitleStore {
  private path: string
  private entries?: Map<string, string>

  constructor(path = DEFAULT_TITLES_PATH) {
    this.path = path
  }

  private load(): Map<string, string> {
    if (!this.entries) {
      try {
        const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, string>
        this.entries = new Map(Object.entries(parsed))
      } catch {
        this.entries = new Map()
      }
    }
    return this.entries
  }

  get(sessionId: string): string | undefined {
    if (!sessionId) return undefined
    return this.load().get(sessionId)
  }

  set(sessionId: string, title: string): void {
    if (!sessionId || !title) return
    const entries = this.load()
    // Re-inserted at the end: Map iteration order is insertion order, so the oldest is whichever was
    // touched longest ago, not whichever was merely added first.
    entries.delete(sessionId)
    entries.set(sessionId, title)
    while (entries.size > MAX_TITLES) entries.delete(entries.keys().next().value!)
    this.flush()
  }

  private flush(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      writeFileSync(this.path, JSON.stringify(Object.fromEntries(this.load())))
    } catch {
      // Losing this file only costs the name falling back to ai-title/last-prompt, never correctness.
    }
  }
}

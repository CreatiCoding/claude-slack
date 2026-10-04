/**
 * The notification center (49): short notices the page shows at the top, newest first, kept in a file so they
 * survive a restart. Thirty at most; a notice is dropped by id, or all of them at once.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const DEFAULT_NOTICES_PATH = process.env.CLAUDE_SLACK_NOTICES ?? join(homedir(), '.claude-slack', 'notices.json')
const MAX = 30

export interface Notice {
  id: string
  thread: string
  title: string
  text: string
  tone: 'ok' | 'fail' | 'info'
  at: number
}

export class NoticeStore {
  private items: Notice[] = []
  private seq = 0
  private keys = new Set<string>()
  private file: string

  constructor(file = DEFAULT_NOTICES_PATH) {
    this.file = file
    try {
      if (existsSync(file)) this.items = (JSON.parse(readFileSync(file, 'utf8')) as Notice[]).slice(0, MAX)
    } catch {
      this.items = []
    }
    this.seq = this.items.length
  }

  list(): Notice[] {
    return [...this.items]
  }

  /** Add to the top. A repeat of the same `key` (a task's id and status, say) is not added twice. */
  add(n: Omit<Notice, 'id' | 'at'>, key?: string, now = Date.now()): Notice | undefined {
    if (key && this.keys.has(key)) return undefined
    if (key) this.keys.add(key)
    const item: Notice = { ...n, id: `n${now.toString(36)}${(this.seq++).toString(36)}`, at: now }
    this.items = [item, ...this.items].slice(0, MAX)
    this.save()
    return item
  }

  /** Drop one notice by id, or every one when no id is given. Returns whether anything went. */
  remove(id?: string): boolean {
    const before = this.items.length
    this.items = id ? this.items.filter((x) => x.id !== id) : []
    if (this.items.length === before) return false
    this.save()
    return true
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(this.items))
      renameSync(tmp, this.file)
    } catch {
      // Best-effort: the list in memory is still right until the next restart.
    }
  }
}

/**
 * The rows pinned to the top of the admin table. Kept on the machine running the broker, not in the
 * browser, so a phone and a desktop show the same pins.
 *
 * A key names a conversation, not a row: the session id when there is one (so the pin follows a
 * session from "실행 중" to "이어서" to "보관"), else the archive path or the leftover thread's ts.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const DEFAULT_PINS_PATH = process.env.CLAUDE_SLACK_PINS ?? join(homedir(), '.claude-slack', 'pins.json')
/** More than this is a runaway client, not a person pinning things. */
const MAX_PINS = 200

export class PinStore {
  private path: string
  private keys?: Set<string>

  constructor(path = DEFAULT_PINS_PATH) {
    this.path = path
  }

  private load(): Set<string> {
    if (!this.keys) {
      try {
        this.keys = new Set((JSON.parse(readFileSync(this.path, 'utf8')) as { pins?: string[] }).pins ?? [])
      } catch {
        this.keys = new Set()
      }
    }
    return this.keys
  }

  list(): string[] {
    return [...this.load()]
  }

  /** Pin or unpin. Returns false for a key that is not a plain identifier or when the limit is reached. */
  set(key: string, pinned: boolean): boolean {
    if (!/^[\w:./~@+-]{1,300}$/.test(key)) return false
    const keys = this.load()
    if (pinned && !keys.has(key) && keys.size >= MAX_PINS) return false
    if (pinned) keys.add(key)
    else keys.delete(key)
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      writeFileSync(this.path, JSON.stringify({ pins: [...keys] }, null, 2) + '\n')
    } catch {}
    return true
  }
}

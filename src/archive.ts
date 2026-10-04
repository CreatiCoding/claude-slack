import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

export interface ArchivedMessage {
  ts: string
  user?: string
  bot: boolean
  text: string
  blocks?: unknown[]
  /** The whole event (47): tools, cards, notices too, so the past record reads as the conversation did. */
  event?: Record<string, unknown>
}

export interface SessionArchive {
  key: string
  sessionId: string
  cwd: string
  title?: string
  threadTs: string
  origin: 'terminal' | 'slack'
  archivedAt: string
  transcriptPath?: string
  messages: ArchivedMessage[]
}

export const DEFAULT_ARCHIVE_DIR = process.env.CLAUDE_SLACK_ARCHIVE_DIR ?? join(homedir(), '.claude-slack', 'sessions')

/** Write the archive as JSON (source of truth) and Markdown (for humans). Returns the JSON path. */
export function writeArchive(a: SessionArchive, dir = DEFAULT_ARCHIVE_DIR): string {
  mkdirSync(dir, { recursive: true })
  const stem = join(dir, `${a.archivedAt.replace(/[:.]/g, '-')}_${a.key}`)
  writeFileSync(`${stem}.json`, JSON.stringify(a, null, 2) + '\n')
  writeFileSync(`${stem}.md`, toMarkdown(a))
  return `${stem}.json`
}

export function toMarkdown(a: SessionArchive): string {
  const head = [
    `# ${a.title ?? basename(a.cwd)}`,
    '',
    `- cwd: \`${a.cwd}\``,
    `- session: \`${a.sessionId}\` (bridge key \`${a.key}\`)`,
    `- slack thread: \`${a.threadTs}\` · origin: ${a.origin}`,
    `- archived: ${a.archivedAt}`,
    a.transcriptPath ? `- transcript: \`${a.transcriptPath}\` → \`claude --resume ${a.sessionId}\`` : '',
    '',
    '---',
    '',
  ]
  const body = a.messages.map((m) => `**${m.bot ? 'claude-slack' : m.user ?? 'user'}** · ${tsToIso(m.ts)}\n\n${m.text.trim()}\n`).join('\n')
  return head.filter((l) => l !== undefined).join('\n') + body
}

/** How many sessions are archived. Counts filenames; does not open them. */
export function countArchives(dir = DEFAULT_ARCHIVE_DIR): number {
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.json')).length
  } catch {
    return 0
  }
}

export function listArchives(limit = 20, dir = DEFAULT_ARCHIVE_DIR): Array<{ path: string; title: string; cwd: string; sessionId: string; archivedAt: string; preview?: string; messages?: number }> {
  let files: string[]
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort().reverse()
  } catch {
    return []
  }
  const out = []
  for (const f of files.slice(0, limit)) {
    try {
      const a = JSON.parse(readFileSync(join(dir, f), 'utf8')) as SessionArchive
      const first = a.messages?.find((m) => !m.bot && m.text?.trim())?.text.trim()
      const preview = first && (first.length > 240 ? `${first.slice(0, 240)}…` : first)
      out.push({ path: join(dir, f), title: a.title ?? basename(a.cwd), cwd: a.cwd, sessionId: a.sessionId, archivedAt: a.archivedAt, messages: (a.messages ?? []).filter((m) => !m.bot && m.text?.trim()).length, ...(preview ? { preview } : {}) })
    } catch {}
  }
  return out
}

/** The archive already written for this Slack thread, if any. A second purge of the same thread updates it instead of adding a copy. */
export function findArchiveByThread(threadTs: string, dir = DEFAULT_ARCHIVE_DIR): { path: string; archive: SessionArchive } | undefined {
  let files: string[]
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'))
  } catch {
    return undefined
  }
  for (const f of files) {
    try {
      const archive = JSON.parse(readFileSync(join(dir, f), 'utf8')) as SessionArchive
      if (archive.threadTs === threadTs) return { path: join(dir, f), archive }
    } catch {}
  }
  return undefined
}

/** Rewrite an archive in place (its .json and the .md beside it). */
export function overwriteArchive(path: string, a: SessionArchive): string {
  writeFileSync(path, JSON.stringify(a, null, 2) + '\n')
  writeFileSync(path.replace(/\.json$/, '.md'), toMarkdown(a))
  return path
}

/** Change an archive's title, in the .json and in the heading of the .md. Same path rule as deleteArchive. */
export function renameArchive(path: string, title: string, dir = DEFAULT_ARCHIVE_DIR): boolean {
  const file = resolve(path)
  if (!title.trim() || !file.endsWith('.json') || dirname(file) !== resolve(dir)) return false
  let a: SessionArchive
  try {
    a = JSON.parse(readFileSync(file, 'utf8')) as SessionArchive
  } catch {
    return false
  }
  a.title = title.trim()
  writeFileSync(file, JSON.stringify(a, null, 2))
  writeFileSync(file.replace(/\.json$/, '.md'), toMarkdown(a))
  return true
}

/** Delete one archive (its .json and the .md beside it). Refuses anything that is not a .json directly inside `dir`. */
export function deleteArchive(path: string, dir = DEFAULT_ARCHIVE_DIR): boolean {
  const file = resolve(path)
  if (!file.endsWith('.json') || dirname(file) !== resolve(dir)) return false
  rmSync(file, { force: true })
  rmSync(file.replace(/\.json$/, '.md'), { force: true })
  return true
}

function tsToIso(ts: string): string {
  const n = Number(ts)
  return Number.isFinite(n) ? new Date(n * 1000).toISOString() : ts
}

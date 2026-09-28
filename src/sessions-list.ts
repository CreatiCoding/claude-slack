import { existsSync, rmSync } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface RecentSession {
  /** How many messages the user sent in this conversation. */
  messages?: number
  id: string
  cwd: string
  title: string
  mtime: number
  when: string
  /** The conversation's first message, so a list of similar titles can be told apart. */
  preview?: string
}

/**
 * Recent resumable sessions from ~/.claude/projects/<dir>/<id>.jsonl.
 * Reads only the head (for cwd) and tail (for title / last prompt) of each file.
 */
export async function listRecentSessions(limit = 15, projectsDir = join(homedir(), '.claude', 'projects')): Promise<RecentSession[]> {
  let dirs: string[]
  try {
    dirs = await readdir(projectsDir)
  } catch {
    return []
  }
  // The broker is a single process relaying every session, so this must not
  // block the event loop; read the project directories concurrently.
  const perDir = await Promise.all(dirs.map((dir) => readProjectDir(join(projectsDir, dir))))
  return perDir
    .flat()
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
}

async function readProjectDir(full: string): Promise<RecentSession[]> {
  let files: string[]
  try {
    files = (await readdir(full)).filter((f) => f.endsWith('.jsonl'))
  } catch {
    return []
  }
  const entries = await Promise.all(files.map((f) => readSessionFile(join(full, f), f)))
  return entries.filter((e): e is RecentSession => e !== null)
}

const HEAD_TAIL_BYTES = 64 * 1024
/** Below this a transcript holds nothing useful yet. */
const MIN_TRANSCRIPT_BYTES = 200

async function readSessionFile(path: string, name: string): Promise<RecentSession | null> {
  let handle
  try {
    const st = await stat(path)
    if (st.size < MIN_TRANSCRIPT_BYTES) return null
    handle = await open(path, 'r')
    const [head, tail] = await Promise.all([
      readChunk(handle, 0, HEAD_TAIL_BYTES),
      readChunk(handle, Math.max(0, st.size - HEAD_TAIL_BYTES), HEAD_TAIL_BYTES),
    ])
    const cwd = firstMatch(head, /"cwd":"((?:[^"\\]|\\.)*)"/)
    if (!cwd) return null
    const title = lastMatch(tail, /"aiTitle":"((?:[^"\\]|\\.)*)"/) ?? lastMatch(tail, /"lastPrompt":"((?:[^"\\]|\\.)*)"/) ?? '(제목 없음)'
    const preview = firstUserMessage(head)
    return { id: name.replace(/\.jsonl$/, ''), cwd: unescape(cwd), title: unescape(title).slice(0, 60), mtime: st.mtimeMs, when: relTime(st.mtimeMs), messages: await countUserMessages(path), ...(preview ? { preview } : {}) }
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => {})
  }
}

/**
 * Delete one conversation Claude Code saved: <projects>/<dir>/<id>.jsonl and the <id>/ folder beside it
 * (subagent and tool-result files). The id must be a plain session id, so it cannot point elsewhere.
 * Returns whether a transcript was found and removed.
 */
export async function deleteRecentSession(id: string, projectsDir = join(homedir(), '.claude', 'projects')): Promise<boolean> {
  if (!/^[\w-]+$/.test(id)) return false
  let dirs: string[]
  try {
    dirs = await readdir(projectsDir)
  } catch {
    return false
  }
  let removed = false
  for (const dir of dirs) {
    const file = join(projectsDir, dir, `${id}.jsonl`)
    if (!existsSync(file)) continue
    rmSync(file, { force: true })
    rmSync(join(projectsDir, dir, id), { recursive: true, force: true })
    removed = true
  }
  return removed
}

const PREVIEW_CHARS = 240

/**
 * The first thing the user typed, read from the head of a transcript. Lines that only carry
 * Claude Code's own wrappers (`<command-name>`, `<local-command-caveat>`, system reminders) are skipped,
 * and the last line may be cut off by the chunk size, so a line that does not parse is ignored.
 */
export function firstUserMessage(head: string): string | undefined {
  for (const line of head.split('\n')) {
    if (!line.includes('"type":"user"')) continue
    let entry: { type?: string; isMeta?: boolean; message?: { content?: unknown } }
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry.type !== 'user') continue
    const c = entry.message?.content
    const text = typeof c === 'string' ? c : Array.isArray(c) ? (c.find((b) => b?.type === 'text')?.text as string | undefined) : undefined
    // A message typed in Slack reaches Claude Code as a meta entry wrapped in <channel …>…</channel>.
    const t = (/^\s*<channel\b[^>]*>([\s\S]*?)<\/channel>/.exec(text ?? '')?.[1] ?? (entry.isMeta ? undefined : text))?.trim()
    if (!t || t.startsWith('<')) continue
    return t.length > PREVIEW_CHARS ? `${t.slice(0, PREVIEW_CHARS)}…` : t
  }
  return undefined
}

/** The first user message of one transcript file, or undefined when there is none in its head. */
export async function readFirstMessage(path: string): Promise<string | undefined> {
  let handle
  try {
    handle = await open(path, 'r')
    return firstUserMessage(await readChunk(handle, 0, HEAD_TAIL_BYTES))
  } catch {
    return undefined
  } finally {
    await handle?.close().catch(() => {})
  }
}

async function readChunk(handle: Awaited<ReturnType<typeof open>>, start: number, len: number): Promise<string> {
  const buf = Buffer.alloc(len)
  const { bytesRead } = await handle.read(buf, 0, len, start)
  return buf.toString('utf8', 0, bytesRead)
}

function firstMatch(s: string, re: RegExp): string | undefined {
  return re.exec(s)?.[1]
}
function lastMatch(s: string, re: RegExp): string | undefined {
  let m: RegExpExecArray | null
  let last: string | undefined
  const g = new RegExp(re.source, 'g')
  while ((m = g.exec(s))) last = m[1]
  return last
}
function unescape(s: string): string {
  try {
    return JSON.parse(`"${s}"`)
  } catch {
    return s
  }
}
function relTime(ms: number): string {
  const d = Date.now() - ms
  const m = Math.round(d / 60000)
  if (m < 60) return `${m}분 전`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}시간 전`
  return `${Math.round(h / 24)}일 전`
}

/**
 * How many messages the user sent in a transcript: typed lines and Slack messages, not tool results or Claude Code's own
 * wrappers. A transcript only grows, so what was counted is kept with the size it was counted at and only the new bytes are read.
 */
const counted = new Map<string, { size: number; count: number; tail: string }>()
export async function countUserMessages(path: string): Promise<number> {
  let handle
  try {
    const size = (await stat(path)).size
    let c = counted.get(path)
    if (!c || size < c.size) c = { size: 0, count: 0, tail: '' }
    if (size > c.size) {
      handle = await open(path, 'r')
      const buf = Buffer.alloc(size - c.size)
      const { bytesRead } = await handle.read(buf, 0, buf.length, c.size)
      const lines = (c.tail + buf.toString('utf8', 0, bytesRead)).split('\n')
      const tail = lines.pop() ?? ''
      c = { size, count: c.count + lines.filter(isUserMessageLine).length, tail }
      counted.set(path, c)
    }
    return c.count
  } catch {
    return 0
  } finally {
    await handle?.close().catch(() => {})
  }
}

export function isUserMessageLine(line: string): boolean {
  if (!line.includes('"type":"user"')) return false
  try {
    const e = JSON.parse(line) as { type?: string; isMeta?: boolean; isSidechain?: boolean; message?: { content?: unknown } }
    if (e.type !== 'user' || e.isSidechain) return false
    const c = e.message?.content
    const text = typeof c === 'string' ? c : Array.isArray(c) ? (c.find((b) => b?.type === 'text')?.text as string | undefined) : undefined
    if (!text) return false
    if (/^\s*<channel\b/.test(text)) return true
    return !e.isMeta && !text.trim().startsWith('<')
  } catch {
    return false
  }
}

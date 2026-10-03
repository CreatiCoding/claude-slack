import { EventEmitter } from 'node:events'
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, watch, type FSWatcher } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Structured events distilled from Claude Code's transcript JSONL. The file
 * is appended while a turn is running, so tailing it gives step-level
 * progress: each text block, tool call, and tool result as it lands.
 */
export type TranscriptEvent = { uuid?: string } & (
  | { kind: 'text'; text: string }
  | { kind: 'thinking' }
  | { kind: 'tool_use'; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; toolUseId: string; output: string; isError: boolean; images?: Array<{ mediaType: string; data: string }> }
  | { kind: 'user'; text: string }
  | { kind: 'local'; text: string; isError: boolean }
  | { kind: 'title'; title: string }
  | { kind: 'model'; model: string }
)

/**
 * Parse one JSONL line into zero or more events. Pure, so it is testable. Each event carries its line's
 * uuid, so a forked transcript's copied history (same uuids as the original) can be told apart.
 */
export function parseTranscriptLine(line: string): TranscriptEvent[] {
  let entry: Record<string, unknown>
  try {
    entry = JSON.parse(line)
  } catch {
    return []
  }
  const events = parseEntry(entry)
  return typeof entry.uuid === 'string' ? events.map((e) => ({ ...e, uuid: entry.uuid as string })) : events
}

/** Every line's uuid in a transcript: what a fork of it copies and must not replay. */
export function transcriptUuids(path: string): Set<string> {
  const out = new Set<string>()
  try {
    for (const m of readFileSync(path, 'utf8').matchAll(/"uuid":"([0-9a-f-]{36})"/g)) out.add(m[1]!)
  } catch {}
  return out
}

function parseEntry(entry: Record<string, unknown>): TranscriptEvent[] {
  if (entry.isSidechain) return []
  if (entry.type === 'ai-title' && typeof entry.aiTitle === 'string') return [{ kind: 'title', title: entry.aiTitle }]
  const message = entry.message as { role?: string; content?: unknown } | undefined
  if (!message) return []
  const content = message.content
  if (entry.type === 'assistant' && Array.isArray(content)) {
    const out: TranscriptEvent[] = []
    const model = (message as { model?: unknown }).model
    if (typeof model === 'string' && model) out.push({ kind: 'model', model })
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) out.push({ kind: 'text', text: block.text })
      else if (block.type === 'thinking') out.push({ kind: 'thinking' })
      else if (block.type === 'tool_use') out.push({ kind: 'tool_use', id: String(block.id), name: String(block.name), input: block.input })
    }
    return out
  }
  if (entry.type === 'user') {
    if (typeof content === 'string') {
      const printed = localOutput(content)
      return printed.length ? printed : [{ kind: 'user', text: content }]
    }
    if (Array.isArray(content)) {
      const out: TranscriptEvent[] = []
      for (const block of content as Array<Record<string, unknown>>) {
        if (block.type === 'tool_result') {
          const images = resultImages(block.content)
          out.push({
            kind: 'tool_result',
            toolUseId: String(block.tool_use_id),
            output: flattenResult(block.content),
            isError: block.is_error === true,
            ...(images.length ? { images } : {}),
          })
        } else if (block.type === 'text' && typeof block.text === 'string') {
          out.push({ kind: 'user', text: block.text })
        }
      }
      return out
    }
  }
  return []
}

/** What a local command (`/model`, `/cost`, `/compact`, `!ls` ...) printed: Claude Code stores it as a user entry in a stdout/stderr envelope. */
const LOCAL_OUTPUT_RE = /<(?:local-command|bash)-(stdout|stderr)>([\s\S]*?)<\/(?:local-command|bash)-\1>/g
function localOutput(content: string): TranscriptEvent[] {
  return [...content.matchAll(LOCAL_OUTPUT_RE)].map((m): TranscriptEvent => ({ kind: 'local', text: m[2]!, isError: m[1] === 'stderr' }))
}

/** Pictures a tool returned (a Read of a png, a screenshot), as base64. */
function resultImages(content: unknown): Array<{ mediaType: string; data: string }> {
  if (!Array.isArray(content)) return []
  return (content as Array<{ type?: string; source?: { type?: string; media_type?: string; data?: string } }>)
    .filter((c) => c.type === 'image' && c.source?.type === 'base64' && typeof c.source.data === 'string')
    .map((c) => ({ mediaType: String(c.source!.media_type ?? 'image/png'), data: c.source!.data! }))
}

function flattenResult(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c: { type?: string; text?: string }) => (c.type === 'text' && c.text ? c.text : c.type === 'image' ? '[image]' : ''))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

/**
 * Tails a transcript file from its current end, emitting 'event' for every
 * parsed TranscriptEvent. Uses fs.watch plus a polling fallback because
 * macOS fs.watch can miss appends.
 */
export class TranscriptTailer extends EventEmitter {
  private path: string
  private offset: number
  private partial = ''
  private watcher?: FSWatcher
  private poller?: ReturnType<typeof setInterval>
  private reading = false
  /** Handlers run one at a time, in file order, and `drain` waits for them. */
  private queue: Promise<void> = Promise.resolve()
  private handler?: (ev: TranscriptEvent) => Promise<void> | void
  private closed = false

  constructor(path: string, opts: { fromStart?: boolean; startAt?: number; pollMs?: number; onEvent?: (ev: TranscriptEvent) => Promise<void> | void } = {}) {
    super()
    this.handler = opts.onEvent
    this.path = path
    // A saved position resumes an interrupted read; past the end means the file
    // was rotated or truncated, so fall back to the end rather than replaying it.
    const size = safeSize(path)
    this.offset = opts.fromStart ? 0 : Math.min(opts.startAt ?? size, size)
    try {
      this.watcher = watch(path, () => this.read())
      this.watcher.on('error', () => {})
    } catch {}
    this.poller = setInterval(() => this.read(), opts.pollMs ?? 500)
    this.poller.unref?.()
    // Catch up at once when resuming: the content is already on disk, and
    // fs.watch only fires on the next change, so waiting for the poll would
    // leave the thread silent for as long as the session stays quiet.
    this.read()
  }

  /**
   * How far into the file we have read. Two copies of one hook see the same
   * position; a genuinely repeated event comes after the transcript has grown.
   */
  get position(): number {
    return this.offset
  }

  /** Read any bytes appended since the last read. Safe to call repeatedly. */
  read(): void {
    if (this.reading) return
    this.reading = true
    try {
      const size = safeSize(this.path)
      if (size < this.offset) this.offset = 0 // truncated / rotated
      if (size === this.offset) return
      const fd = openSync(this.path, 'r')
      try {
        const buf = Buffer.alloc(size - this.offset)
        readSync(fd, buf, 0, buf.length, this.offset)
        this.offset = size
        this.partial += buf.toString('utf8')
      } finally {
        closeSync(fd)
      }
      let idx: number
      while ((idx = this.partial.indexOf('\n')) >= 0) {
        const line = this.partial.slice(0, idx)
        this.partial = this.partial.slice(idx + 1)
        for (const ev of parseTranscriptLine(line)) this.dispatch(ev)
      }
    } catch (err) {
      this.emit('error', err)
    } finally {
      this.reading = false
    }
  }

  /**
   * Hand an event to the handler, keeping file order. Without the queue two
   * async handlers overlap and, say, a checklist update can land before the
   * text that preceded it.
   */
  private dispatch(ev: TranscriptEvent): void {
    if (this.closed) return
    if (!this.handler) {
      this.emit('event', ev)
      return
    }
    this.queue = this.queue.then(() => this.handler!(ev)).then(
      () => {},
      (err) => void this.emit('error', err),
    )
  }

  /**
   * Read what is pending and wait for every handler to finish. The Stop hook
   * can beat the poller, and without this the final text is rendered twice:
   * once from the hook and once when the tailer catches up.
   */
  async drain(): Promise<void> {
    this.read()
    await this.queue
  }

  close(): void {
    // Stop dispatching too: a queued handler running after the session is gone
    // would post into a thread that has already been wrapped up.
    this.closed = true
    this.watcher?.close()
    if (this.poller) clearInterval(this.poller)
  }
}

function safeSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

/** Where Claude Code keeps the transcript for a session: ~/.claude/projects/<cwd with / → ->/<sessionId>.jsonl */
export function transcriptPathFor(cwd: string, sessionId: string, projectsDir = join(homedir(), '.claude', 'projects')): string | undefined {
  if (!sessionId) return undefined
  const path = join(projectsDir, cwd.replace(/[^A-Za-z0-9]/g, '-'), `${sessionId}.jsonl`)
  return existsSync(path) ? path : undefined
}

/** The model of the last assistant entry, read from the file's tail. */
export function lastModelInTranscript(path: string, tailBytes = 256 * 1024): string | undefined {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const size = statSync(path).size
    const start = Math.max(0, size - tailBytes)
    const buf = Buffer.alloc(size - start)
    readSync(fd, buf, 0, buf.length, start)
    const lines = buf.toString('utf8').split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const ev = parseTranscriptLine(lines[i]!).find((e) => e.kind === 'model')
      if (ev && ev.kind === 'model') return ev.model
    }
  } catch {
    // unreadable: caller falls back to nothing
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
  return undefined
}

/**
 * Whether a turn is still open, read from the transcript alone, for the moment a screen-only judgement
 * (the input box looks idle) would otherwise close it. The screen can read as idle while Claude Code is
 * still between steps — a tool call just finished and the next one has not printed yet, or the model's
 * next message has not started — so the last thing actually written settles it: a tool call with no
 * result yet, or a result/message Claude has not answered, means the turn is open; a final piece of text
 * means it answered and the turn really is done.
 */
export function transcriptTurnLooksOpen(path: string, tailBytes = 262_144): boolean {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const size = statSync(path).size
    const start = Math.max(0, size - tailBytes)
    const buf = Buffer.alloc(size - start)
    readSync(fd, buf, 0, buf.length, start)
    const lines = buf.toString('utf8').split('\n').filter((l) => l.trim())
    // A tail that does not start at byte 0 may begin mid-record; that partial line is dropped.
    if (start > 0 && lines.length) lines.shift()
    let last: 'text' | 'tool_use' | 'pending' | undefined
    for (const line of lines) {
      let entry: { type?: string; isSidechain?: boolean; message?: { content?: unknown } }
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }
      if (entry.isSidechain) continue
      const content = entry.message?.content
      if (entry.type === 'assistant' && Array.isArray(content)) {
        for (const block of content as Array<Record<string, unknown>>) {
          if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) last = 'text'
          else if (block.type === 'tool_use') last = 'tool_use'
        }
      } else if (entry.type === 'user') {
        last = 'pending'
      }
    }
    return last === 'tool_use' || last === 'pending'
  } catch {
    // Unreadable: fall back to the screen-only judgement that called this.
    return false
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

const READ_SESSION_TAIL_BYTES = 8 * 1024 * 1024
const READ_SESSION_TOOL_INPUT_MAX = 160

/**
 * A conversation's recent transcript as plain text, for the `read_session` MCP tool: another session's
 * Claude reading what happened in this one. Reads the last 8 MiB of the file; includes what a person said
 * (typed or sent through Slack, `<channel>`-wrapped lines unwrapped), what Claude answered, and each tool
 * call by name with its input cut to 160 chars — not the tool's own output, which is usually the bulk of
 * the file and rarely what a cross-reading Claude needs.
 */
export function readSessionText(path: string, tailBytes = READ_SESSION_TAIL_BYTES): string {
  let fd: number | undefined
  const out: string[] = []
  try {
    fd = openSync(path, 'r')
    const size = statSync(path).size
    const start = Math.max(0, size - tailBytes)
    const buf = Buffer.alloc(size - start)
    readSync(fd, buf, 0, buf.length, start)
    const lines = buf.toString('utf8').split('\n')
    if (start > 0 && lines.length) lines.shift() // a tail that does not start at byte 0 may begin mid-record
    for (const line of lines) {
      if (!line.trim()) continue
      let entry: { type?: string; isSidechain?: boolean; message?: { role?: string; content?: unknown } }
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }
      if (entry.isSidechain) continue
      const content = entry.message?.content
      if (entry.type === 'user') {
        const text = typeof content === 'string' ? content : Array.isArray(content) ? (content as Array<Record<string, unknown>>).find((b) => b.type === 'text')?.text : undefined
        if (typeof text !== 'string' || !text.trim()) continue
        const unwrapped = /^\s*<channel\b[^>]*>([\s\S]*?)<\/channel>/.exec(text)?.[1]?.trim() ?? text.trim()
        if (unwrapped.startsWith('<')) continue // another system wrapper (task-notification, local-command, …): not something a person said
        out.push(`User: ${unwrapped}`)
      } else if (entry.type === 'assistant' && Array.isArray(content)) {
        for (const block of content as Array<Record<string, unknown>>) {
          if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) out.push(`Claude: ${block.text.trim()}`)
          else if (block.type === 'tool_use') out.push(`Tool: ${String(block.name)}(${JSON.stringify(block.input).slice(0, READ_SESSION_TOOL_INPUT_MAX)})`)
        }
      }
    }
  } catch {
    // unreadable: whatever was gathered so far (likely nothing) is returned
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
  return out.join('\n')
}

import { EventEmitter } from 'node:events'
import { closeSync, existsSync, openSync, readSync, statSync, watch, type FSWatcher } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Structured events distilled from Claude Code's transcript JSONL. The file
 * is appended while a turn is running, so tailing it gives step-level
 * progress: each text block, tool call, and tool result as it lands.
 */
export type TranscriptEvent =
  | { kind: 'text'; text: string }
  | { kind: 'thinking' }
  | { kind: 'tool_use'; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; toolUseId: string; output: string; isError: boolean }
  | { kind: 'user'; text: string }
  | { kind: 'local'; text: string; isError: boolean }
  | { kind: 'title'; title: string }
  | { kind: 'model'; model: string }

/** Parse one JSONL line into zero or more events. Pure, so it is testable. */
export function parseTranscriptLine(line: string): TranscriptEvent[] {
  let entry: Record<string, unknown>
  try {
    entry = JSON.parse(line)
  } catch {
    return []
  }
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
          out.push({
            kind: 'tool_result',
            toolUseId: String(block.tool_use_id),
            output: flattenResult(block.content),
            isError: block.is_error === true,
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

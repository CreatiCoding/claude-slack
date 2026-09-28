import type { URLSourceElement } from '@slack/types'
import type { SlackApi, StreamChunk } from './slack.ts'
import { chunk as splitText, convertTables, toMrkdwn, truncate } from './format.ts'

const TASK_TEXT_MAX = 250
/** One markdown_text chunk may not exceed a plain message's text limit. */
const TEXT_CHUNK_MAX = 3900
/**
 * What one streamed message may hold: text plus the task cards, which now carry
 * the whole command. Slack said msg_too_long at 11k often enough (424 times in
 * one log), and again at ~5.5k with the cap at 7k, so it now sits at a plain
 * message's text limit; more messages, none of them refused.
 */
const STREAM_TEXT_MAX = 4000
/**
 * Slack allows on the order of 20 stream appends per minute. 2.5s batching is
 * 24/min, which spends the budget during a long answer; 3s lands on 20.
 */
const DEFAULT_FLUSH_MS = 3000
/**
 * Slack closes a stream that sits idle, and a tool call that takes a minute is
 * exactly that: silence. Re-send the in-flight tasks well inside that window so
 * the stream is still open when the result finally lands. Observed closures
 * followed gaps around a minute, so keep this comfortably below it.
 */
const HEARTBEAT_MS = 20_000
/** Reopening forever would post a new message per flush; two is enough to ride out a closure. */
const MAX_STREAM_RESTARTS = 2

/**
 * One Claude turn rendered into Slack. Prefers the streaming API (markdown
 * text plus task_update cards); if the workspace rejects streaming it falls
 * back to a plain message that is edited in place. Appends are batched so we
 * stay under Slack's per-minute limits.
 */
export class TurnStream {
  private slack: SlackApi
  private threadTs: string
  private recipient: string
  private flushMs: number
  private heartbeatMs: number
  private log: (m: string) => void

  private pending: StreamChunk[] = []
  private timer?: ReturnType<typeof setTimeout>
  private heartbeat?: ReturnType<typeof setInterval>
  private lastAppendAt = Date.now()
  private queue: Promise<void> = Promise.resolve()
  private ts?: string
  private chars = 0
  private titles = new Map<string, string>()
  private extras = new Map<string, { details?: string; sources?: URLSourceElement[] }>()
  private running = new Set<string>()
  /** Tracked as in flight but never drawn (summary view). */
  private silent = new Set<string>()
  private verbose = new Set<string>()
  private startedAt = new Map<string, number>()
  private restarts = 0
  private plain = false
  private plainText = ''
  private plainTs?: string
  private sizes = new Map<string, number>()
  private seenTexts = new Set<string>()
  ended = false

  constructor(slack: SlackApi, opts: { threadTs: string; recipient: string; flushMs?: number; heartbeatMs?: number; log?: (m: string) => void }) {
    this.slack = slack
    this.threadTs = opts.threadTs
    this.recipient = opts.recipient
    this.flushMs = opts.flushMs ?? DEFAULT_FLUSH_MS
    this.heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS
    this.log = opts.log ?? (() => {})
  }

  /**
   * Did this turn already carry that exact answer? The hook hands us the final
   * message separately, and a turn whose last text lands after the stream closed
   * never rendered it — answering "we saw some text" would drop the answer.
   */
  rendered(text: string): boolean {
    return this.seenTexts.has(text.trim())
  }

  text(text: string): void {
    if (this.ended) return
    this.seenTexts.add(text.trim())
    // One chunk past Slack's per-message text limit is rejected as msg_too_long
    // no matter how the stream is split; cut it up here, keeping fences balanced.
    for (const part of splitText(convertTables(text))) {
      const last = this.pending.at(-1)
      if (last?.type === 'markdown_text' && last.text.length + part.length + 2 <= TEXT_CHUNK_MAX) last.text += '\n\n' + part
      else this.pending.push({ type: 'markdown_text', text: part })
    }
    this.schedule()
  }

  /** Has Claude said or done anything in this turn yet? A late Stop from a previous turn arrives before that. */
  get hasContent(): boolean {
    return this.seenTexts.size > 0 || this.titles.size > 0
  }

  /** Tool calls started but not finished: the session is working, not stuck. */
  get inFlight(): string[] {
    return [...this.running].map((id) => this.titles.get(id) ?? id)
  }

  /**
   * A tool call began. `silent` tracks it as in flight without a card (summary
   * view); `verbose` keeps more of its output when it ends.
   */
  taskStart(id: string, title: string, extra?: { details?: string; sources?: URLSourceElement[]; silent?: boolean; verbose?: boolean }): void {
    if (this.ended) return
    title = truncate(title, TASK_TEXT_MAX)
    this.titles.set(id, title)
    this.running.add(id)
    this.startedAt.set(id, Date.now())
    if (extra?.silent) {
      this.silent.add(id)
      return
    }
    if (extra?.verbose) this.verbose.add(id)
    // Kept so a heartbeat re-sends the task whole rather than stripping it back
    // to a bare title, which would drop what the reader can expand into.
    const { details, sources } = extra ?? {}
    if (details || sources) this.extras.set(id, { details, sources })
    this.pending.push({ type: 'task_update', id, title, status: 'in_progress', ...(details ? { details } : {}), ...(sources ? { sources } : {}) })
    this.armHeartbeat()
    this.schedule()
  }

  taskEnd(id: string, output: string, isError: boolean): void {
    if (this.ended) return
    this.running.delete(id)
    this.startedAt.delete(id)
    if (!this.running.size) this.clearHeartbeat()
    if (this.silent.delete(id)) return
    const title = this.titles.get(id) ?? truncate(output.split('\n')[0] ?? id, TASK_TEXT_MAX)
    const trimmed = output.trim()
    const verbose = this.verbose.delete(id)
    this.pending.push({
      type: 'task_update',
      id,
      title,
      status: isError ? 'error' : 'complete',
      ...this.extras.get(id),
      ...(trimmed ? { output: verbose ? truncate(firstLines(trimmed, 12), TASK_TEXT_MAX * 4) : truncate(firstLines(trimmed, 3), TASK_TEXT_MAX) } : {}),
    })
    this.extras.delete(id)
    this.schedule()
  }

  /** Flush what is pending and finalize the message. Idempotent. */
  async end(): Promise<void> {
    if (this.ended) return
    this.ended = true
    if (this.timer) clearTimeout(this.timer)
    this.clearHeartbeat()
    this.enqueue(() => this.flushNow())
    this.enqueue(async () => {
      if (this.ts && !this.plain) await this.slack.stopStream(this.ts)
    })
    await this.queue
  }

  private armHeartbeat(): void {
    if (this.heartbeat) return
    this.heartbeat = setInterval(() => this.beat(), this.heartbeatMs)
    // The broker outlives any one turn; a pending beat must not hold the process open.
    this.heartbeat.unref?.()
  }

  private clearHeartbeat(): void {
    if (!this.heartbeat) return
    clearInterval(this.heartbeat)
    this.heartbeat = undefined
  }

  /**
   * Nudge the stream while a tool call runs. Re-sending a task_update the
   * viewer already has changes nothing on screen, but it counts as an append,
   * which is what keeps Slack from closing the stream underneath us.
   */
  private beat(): void {
    if (this.ended || this.plain || !this.ts || !this.running.size) return this.clearHeartbeat()
    // Something real is already on its way, and it does the same job.
    if (this.pending.length) return
    if (Date.now() - this.lastAppendAt < this.heartbeatMs) return
    for (const id of this.running) {
      if (this.silent.has(id)) continue
      // The re-send is free (it keeps the stream open); carrying the elapsed time
      // on it answers "is this stuck?" without another message.
      const since = this.startedAt.get(id)
      const elapsed = since ? ` · ${elapsedLabel(Date.now() - since)}` : ''
      this.pending.push({ type: 'task_update', id, title: truncate(`${this.titles.get(id) ?? id}${elapsed}`, TASK_TEXT_MAX), status: 'in_progress', ...this.extras.get(id) })
    }
    this.enqueue(() => this.flushNow())
  }

  private schedule(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.enqueue(() => this.flushNow())
    }, this.flushMs)
  }

  private enqueue(fn: () => Promise<void>): void {
    this.queue = this.queue.then(fn).catch((e) => this.log(`stream op failed: ${e}`))
  }

  private async flushNow(): Promise<void> {
    if (!this.pending.length) return
    const chunks = this.pending
    this.pending = []
    if (this.plain) return this.flushPlain(chunks)

    let added = this.growthOf(chunks, !this.ts)
    try {
      if (this.ts && this.chars + added > STREAM_TEXT_MAX) {
        // Slack caps a streamed message; close it and continue in a new one.
        await this.slack.stopStream(this.ts)
        this.startingOver()
        added = this.growthOf(chunks, true)
      }
      if (!this.ts) {
        this.ts = await this.slack.startStream({ threadTs: this.threadTs, recipientUserId: this.recipient, chunks })
      } else {
        await this.slack.appendStream(this.ts, chunks)
      }
      this.chars += added
      this.countSent(chunks)
      this.lastAppendAt = Date.now()
      this.restarts = 0
    } catch (err) {
      // The message filled up before our own count said so: not a closure, just
      // a full message. Continue in a new one without spending a restart on it.
      const tooLong = /msg_too_long/.test(String(err)) || (err as { data?: { error?: string } })?.data?.error === 'msg_too_long'
      // A stream Slack closed under us is not a reason to spend the rest of the
      // turn as an edited plain message. Carry on in a fresh one, and only give
      // up if starting over keeps failing.
      if (this.ts && (tooLong || this.restarts < MAX_STREAM_RESTARTS)) {
        if (!tooLong) this.restarts++
        this.log(tooLong ? `message full (msg_too_long at ~${this.chars} chars), continuing in a new one` : `stream closed, continuing in a new one (${this.restarts}): ${err}`)
        await this.slack.stopStream(this.ts).catch(() => {})
        this.startingOver()
        try {
          this.ts = await this.slack.startStream({ threadTs: this.threadTs, recipientUserId: this.recipient, chunks })
          this.chars = this.growthOf(chunks, true)
          this.countSent(chunks)
          this.lastAppendAt = Date.now()
          return
        } catch (err2) {
          this.log(`could not reopen the stream: ${err2}`)
        }
      }
      // Whether the stream never opened or reopening failed too, the chunks were
      // already taken off `pending`; deliver them as plain messages instead of
      // dropping them.
      this.log(`streaming unavailable, falling back to plain messages: ${err}`)
      this.clearHeartbeat()
      if (this.ts) {
        await this.slack.stopStream(this.ts).catch(() => {})
        this.ts = undefined
      }
      this.plain = true
      await this.flushPlain(chunks)
    }
  }

  /**
   * How much this batch adds to the message. A task card counts for its whole
   * size — with the command it expands into, that is most of what a busy turn
   * weighs — but re-sending a card the message already has only counts for what
   * it grew by, since Slack replaces it in place. Without that, a heartbeat on a
   * long tool call would look like unbounded growth and split the message.
   */
  private growthOf(chunks: StreamChunk[], fresh: boolean): number {
    let n = 0
    for (const c of chunks) {
      if (c.type === 'markdown_text') {
        n += c.text.length
        continue
      }
      const size = JSON.stringify(c).length
      const already = fresh || c.type !== 'task_update' ? 0 : (this.sizes.get(c.id) ?? 0)
      n += Math.max(0, size - already)
    }
    return n
  }

  private countSent(chunks: StreamChunk[]): void {
    for (const c of chunks) if (c.type === 'task_update') this.sizes.set(c.id, JSON.stringify(c).length)
  }

  /** A new message starts empty, so nothing the old one held still counts. */
  private startingOver(): void {
    this.ts = undefined
    this.chars = 0
    this.sizes.clear()
  }

  private async flushPlain(chunks: StreamChunk[]): Promise<void> {
    for (const c of chunks) {
      if (c.type === 'markdown_text') this.plainText += (this.plainText ? '\n\n' : '') + toMrkdwn(c.text)
      else if (c.type === 'task_update') {
        const icon = c.status === 'in_progress' ? '⏳' : c.status === 'error' ? '❌' : '✅'
        const line = `${icon} ${c.title}`
        // Replace the in-progress line for the same task if present.
        const re = new RegExp(`^⏳ ${escapeRe(c.title)}$`, 'm')
        this.plainText = re.test(this.plainText) ? this.plainText.replace(re, line) : this.plainText + (this.plainText ? '\n' : '') + line
      }
    }
    const parts = splitText(this.plainText)
    const head = parts[0] ?? ''
    if (!this.plainTs) this.plainTs = await this.slack.post({ threadTs: this.threadTs, text: head })
    else await this.slack.update(this.plainTs, head)
    if (parts.length > 1) {
      // Overflow: post the rest as new messages and start fresh.
      for (const p of parts.slice(1)) this.plainTs = await this.slack.post({ threadTs: this.threadTs, text: p })
      this.plainText = parts.at(-1)!
    }
  }
}

function elapsedLabel(ms: number): string {
  const total = Math.round(ms / 1000)
  if (total < 60) return `${total}초`
  const m = Math.floor(total / 60)
  return total % 60 ? `${m}분 ${total % 60}초` : `${m}분`
}

function firstLines(s: string, n: number): string {
  const lines = s.split('\n')
  return lines.length > n ? lines.slice(0, n).join('\n') + ' …' : s
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

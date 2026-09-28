/**
 * Archiving a thread and then deleting it.
 *
 * "Delete my Slack history" is the one irreversible thing this app does, so it
 * always writes the whole thread to disk first and reports exactly what it
 * could not remove. Kept apart from the broker because it needs nothing from a
 * running session beyond its identity.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { findArchiveByThread, overwriteArchive, toMarkdown, writeArchive, type SessionArchive } from './archive.ts'
import { describeError, shortenHome } from './format.ts'
import type { SlackApi } from './slack.ts'
import type { Session } from './session.ts'

export const DEFAULT_PENDING_PATH = process.env.CLAUDE_SLACK_PENDING_PURGES ?? join(homedir(), '.claude-slack', 'pending-purges.json')

/** What is left of a thread to delete: a restart must not strand it half deleted. Replies first, the root last. */
type Pending = Record<string, { archivePath: string; messages: Array<{ ts: string; bot: boolean }>; attempts: number }>

const GAP_MS = 700
/** chat.delete is rate limited; wait out Retry-After for up to this long before giving up on one message. */
const MAX_RATE_WAIT_MS = 5 * 60 * 1000
const MAX_RESUME_ATTEMPTS = 5
/** Slack will never delete these (a channel-join notice, another app's message): retrying only wastes calls. */
const refusedForGood = (e: unknown): boolean => /cant_delete_message/.test(`${(e as { data?: { error?: string } })?.data?.error ?? ''} ${String(e)}`)
const rateLimited = (e: unknown): boolean => (e as { code?: string })?.code === 'slack_webapi_rate_limited' || (e as { data?: { error?: string } })?.data?.error === 'ratelimited'
const retryAfterMs = (e: unknown): number => Math.max(1, Number((e as { retryAfter?: number })?.retryAfter ?? (e as { data?: { retry_after?: number } })?.data?.retry_after ?? 10)) * 1000 + 250

export interface PurgeResult {
  /** Another purge of this thread is still running, so nothing was started. */
  skipped?: 'running'
  /** Messages that failed and stay queued for a retry after the next restart or timer tick. */
  pending?: number
  /** Messages Slack refuses to delete at all; they stay, and are not retried. */
  refused?: number
  /** Where the thread was written. Absent when it could not even be read. */
  archivePath?: string
  deleted: number
  kept: number
  /** The root message is gone, so a reply can no longer be posted to that thread. */
  rootGone: boolean
  /** Messages were left behind only because no user token is configured. */
  userTokenMissing: boolean
  /** The archived thread as markdown, for a canvas or any other destination. */
  markdown?: string
  /** Set when nothing was done at all. */
  error?: unknown
}

export interface PurgeOptions {
  archiveDir?: string
  log?: (m: string) => void
  /** Where the not-yet-deleted messages are remembered. */
  pendingFile?: string
  /** Pause between two deletes, to stay under Slack's rate limit. */
  gapMs?: number
  sleep?: (ms: number) => Promise<void>
}

export class PurgeService {
  private slack: SlackApi
  private archiveDir?: string
  private log: (m: string) => void
  private pendingFile: string
  private gapMs: number
  private sleep: (ms: number) => Promise<void>
  /** Threads being purged right now: a second request for the same one must not run alongside. */
  private running = new Set<string>()

  constructor(slack: SlackApi, opts: PurgeOptions = {}) {
    this.slack = slack
    this.archiveDir = opts.archiveDir
    this.log = opts.log ?? (() => {})
    this.pendingFile = opts.pendingFile ?? DEFAULT_PENDING_PATH
    this.gapMs = opts.gapMs ?? GAP_MS
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  }

  private load(): Pending {
    try {
      return JSON.parse(readFileSync(this.pendingFile, 'utf8')) as Pending
    } catch {
      return {}
    }
  }

  private save(p: Pending): void {
    try {
      mkdirSync(dirname(this.pendingFile), { recursive: true })
      writeFileSync(this.pendingFile, JSON.stringify(p, null, 2) + '\n')
    } catch (err) {
      this.log(`could not save pending purges: ${describeError(err)}`)
    }
  }

  /** A thread that is being purged right now, or whose purge is queued for a retry. */
  isPending(threadTs: string): boolean {
    return this.running.has(threadTs) || threadTs in this.load()
  }

  /** How many threads still have messages to delete. */
  pendingThreads(): number {
    return Object.keys(this.load()).length
  }

  /** The thread as markdown, without deleting anything. */
  async render(session: Session): Promise<string | undefined> {
    try {
      return toMarkdown(this.archiveOf(session, await this.slack.replies(session.threadTs)))
    } catch {
      return undefined
    }
  }

  private archiveOf(session: Session, messages: SessionArchive['messages']): SessionArchive {
    return {
      key: session.key,
      sessionId: session.sessionId,
      cwd: session.cwd,
      title: session.title,
      threadTs: session.threadTs,
      origin: session.origin,
      archivedAt: new Date().toISOString(),
      transcriptPath: session.transcriptPath,
      messages,
    }
  }

  /**
   * Delete one message, waiting out Slack's rate limit, with whichever token is allowed to.
   * Who wrote a message is not what `bot` says: one posted as the person through this app (the QA runs did) carries
   * a bot_id, so it looks like the bot's, but only the person's token may delete it. So a bot message that the bot
   * token is refused is tried with the person's token before it is given up on.
   */
  private async removeOne(m: { ts: string; bot: boolean }): Promise<'gone' | 'no-token' | 'refused' | 'failed'> {
    const until = Date.now() + MAX_RATE_WAIT_MS
    let refused = false
    let noToken = false
    for (const asUser of m.bot ? [false, true] : [true]) {
      for (;;) {
        try {
          if (asUser) {
            if (await this.slack.deleteAsUser(m.ts)) {
              if (m.bot) this.log(`${m.ts} was written as you through the app; deleted with your token`)
              return 'gone'
            }
            noToken = true
          } else {
            await this.slack.delete(m.ts)
            return 'gone'
          }
          break
        } catch (err) {
          if (rateLimited(err) && Date.now() < until) {
            const wait = retryAfterMs(err)
            this.log(`rate limited on ${m.ts}; waiting ${Math.round(wait / 1000)}s`)
            await this.sleep(wait)
            continue
          }
          this.log(`delete ${m.ts} failed${asUser ? ' with your token' : ''}: ${describeError(err)}`)
          if (!refusedForGood(err)) return 'failed'
          refused = true
          break
        }
      }
    }
    // Refused by every token that could try, or by the only one there is: it stays, and is not retried.
    if (refused) return 'refused'
    return noToken ? 'no-token' : 'failed'
  }

  /** Work through a thread's queued messages, saving the queue as it shrinks. Returns what happened. */
  private async drain(threadTs: string, pending: Pending): Promise<{ deleted: number; kept: number; failed: number; refused: number; userTokenMissing: boolean; rootGone: boolean }> {
    const entry = pending[threadTs]!
    let deleted = 0
    let kept = 0
    let refused = 0
    let userTokenMissing = false
    let rootGone = false
    const left: Array<{ ts: string; bot: boolean }> = []
    const todo = [...entry.messages]
    let sinceSave = 0
    for (const [i, m] of todo.entries()) {
      const outcome = await this.removeOne(m)
      if (outcome === 'gone') {
        deleted++
        if (m.ts === threadTs) rootGone = true
        await this.sleep(this.gapMs)
      } else if (outcome === 'no-token') {
        kept++
        userTokenMissing = true
      } else if (outcome === 'refused') {
        kept++
        refused++
      } else left.push(m)
      // Save the shrinking queue now and then: a restart mid-way resumes from here.
      entry.messages = [...left, ...todo.slice(i + 1)]
      if (++sinceSave >= 10) {
        this.save(pending)
        sinceSave = 0
      }
    }
    entry.messages = left
    if (left.length) pending[threadTs] = entry
    else delete pending[threadTs]
    this.save(pending)
    return { deleted, kept: kept + left.length, failed: left.length, refused, userTokenMissing, rootGone }
  }

  async run(session: Session): Promise<PurgeResult> {
    return this.runThread(session.threadTs, this.archiveOf(session, []))
  }

  /** Purge a thread that has no live session, from what is known about it (an orphaned thread). */
  async runThread(threadTs: string, shell: SessionArchive): Promise<PurgeResult> {
    if (this.running.has(threadTs)) return { skipped: 'running', deleted: 0, kept: 0, rootGone: false, userTokenMissing: false }
    this.running.add(threadTs)
    try {
      let messages
      try {
        messages = await this.slack.replies(threadTs)
      } catch (error) {
        return { deleted: 0, kept: 0, rootGone: false, userTokenMissing: false, error }
      }

      // A thread purged before (and not finished) already has an archive: merge, so a retry adds no copy.
      const prior = findArchiveByThread(threadTs, this.archiveDir)
      const byTs = new Map((prior?.archive.messages ?? []).map((m) => [m.ts, m]))
      for (const m of messages) byTs.set(m.ts, m)
      const merged = [...byTs.values()].sort((a, b) => Number(a.ts) - Number(b.ts))
      const archive: SessionArchive = { ...shell, ...(prior ? { archivedAt: prior.archive.archivedAt } : {}), messages: merged }
      const markdown = toMarkdown(archive)
      const archivePath = prior ? overwriteArchive(prior.path, archive) : writeArchive(archive, this.archiveDir)
      this.log(`archived thread ${threadTs} → ${archivePath}${prior ? ' (updated)' : ''}`)

      // Queue what is to be deleted before deleting any of it, replies first and the root last.
      const root = messages.find((m) => m.ts === threadTs)
      const queue = [...messages.filter((m) => m !== root), ...(root ? [root] : [])].map((m) => ({ ts: m.ts, bot: m.bot }))
      const pending = this.load()
      pending[threadTs] = { archivePath, messages: queue, attempts: 0 }
      this.save(pending)

      const r = await this.drain(threadTs, pending)
      this.log(`purge of ${threadTs} finished: deleted ${r.deleted}, kept ${r.kept}${r.refused ? ` (${r.refused} refused by Slack)` : ''}${r.failed ? ` (${r.failed} will be retried)` : ''}, root ${r.rootGone ? 'gone' : 'kept'}`)
      return { archivePath, markdown, deleted: r.deleted, kept: r.kept, rootGone: r.rootGone, userTokenMissing: r.userTokenMissing, pending: r.failed, refused: r.refused }
    } finally {
      this.running.delete(threadTs)
    }
  }

  /** Finish what a restart or a failure left half deleted. Called at startup and on a timer. */
  async resume(): Promise<{ threads: number; deleted: number; left: number }> {
    const pending = this.load()
    let deleted = 0
    let left = 0
    let threads = 0
    for (const threadTs of Object.keys(pending)) {
      if (this.running.has(threadTs)) continue
      const entry = pending[threadTs]!
      if (entry.attempts >= MAX_RESUME_ATTEMPTS) {
        this.log(`giving up on ${threadTs}: ${entry.messages.length} message(s) could not be deleted after ${entry.attempts} tries (archive: ${entry.archivePath})`)
        delete pending[threadTs]
        this.save(pending)
        continue
      }
      entry.attempts++
      this.running.add(threadTs)
      try {
        const r = await this.drain(threadTs, pending)
        threads++
        deleted += r.deleted
        left += r.failed
        this.log(`resumed purge of ${threadTs}: deleted ${r.deleted}, ${r.failed} still failing`)
      } finally {
        this.running.delete(threadTs)
      }
    }
    return { threads, deleted, left }
  }

  /** What to tell the user who asked for this. */
  static describe(r: PurgeResult): string {
    if (r.skipped) return '⏳ 이 스레드는 이미 정리하는 중입니다. 끝나면 결과가 올라옵니다.'
    if (r.error) return `⚠️ 스레드를 읽지 못해 지우지 않았습니다. ${describeError(r.error)}`
    const note = r.userTokenMissing ? ' · 내 메시지는 SLACK_USER_TOKEN이 없어 남겼습니다' : ''
    const retry = r.pending ? ` · ${r.pending}개는 실패해서 잠시 뒤 자동으로 다시 시도합니다` : ''
    const refused = r.refused ? ` · ${r.refused}개는 Slack 이 지우지 못하게 막아 남겼습니다(채널 참여 알림 등)` : ''
    const left = r.kept ? ` (${r.kept}개 남음${note}${retry}${refused})` : ''
    return `🗑 메시지 ${r.deleted}개를 지우고 서버에 보관했습니다${left}: \`${shortenHome(r.archivePath ?? '')}\``
  }
}

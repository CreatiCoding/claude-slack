/** Shared fakes and helpers for the broker tests. */
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { Broker, type BrokerConfig } from '../src/broker.ts'
import { connect, listen, type Conn } from '../src/ipc.ts'
import { slashCommandName, SLASH_COMMANDS, type SlackApi, type StreamChunk } from '../src/slack.ts'
import type { TmuxLike } from '../src/tmux.ts'

export class FakeSlack implements SlackApi {
  posts: Array<{ ts: string; text: string; threadTs?: string; blocks?: unknown[] }> = []
  updates: Array<{ ts: string; text: string; blocks?: unknown[] }> = []
  reactions: string[] = []
  statuses: string[] = []
  streams: Array<{ ts: string; threadTs: string; recipient: string; chunks: StreamChunk[]; stopped: boolean }> = []
  renames: string[] = []
  failStreaming = false
  private n = 0
  async post(opts: { text: string; threadTs?: string; blocks?: unknown[] }) {
    if (this.rejectBlocks && opts.blocks) throw Object.assign(new Error('invalid_blocks'), { data: { error: 'invalid_blocks' } })
    const ts = `${++this.n}.000`
    this.posts.push({ ts, ...opts })
    return ts
  }
  rejectBlocks = false
  async update(ts: string, text: string, blocks?: unknown[]) {
    if (this.rejectBlocks && blocks) throw Object.assign(new Error('invalid_blocks'), { data: { error: 'invalid_blocks' } })
    this.updates.push({ ts, text, blocks })
  }
  async react(ts: string, name: string) {
    this.reactions.push(`+${name}@${ts}`)
  }
  async unreact(ts: string, name: string) {
    this.reactions.push(`-${name}@${ts}`)
  }
  ephemerals: Array<{ user: string; text: string; threadTs?: string; blocks?: unknown[] }> = []
  modals: unknown[] = []
  entryExists = true
  async postEphemeral(user: string, text: string, threadTs?: string, blocks?: unknown[]) {
    this.ephemerals.push({ user, text, threadTs, blocks })
  }
  async openModal(_triggerId: string, view: unknown) {
    this.modals.push(view)
  }
  permalinks = 0
  async permalink(ts: string) {
    this.permalinks++
    return `https://slack.example/${ts}`
  }
  async findBotMessage() {
    return this.entryExists ? 'entry' : undefined
  }
  deleted: string[] = []
  userMessages: Array<{ ts: string; user: string; text: string; threadTs?: string }> = []
  async replies(threadTs: string) {
    const bot = this.posts.filter((p) => p.ts === threadTs || p.threadTs === threadTs).map((p) => ({ ts: p.ts, user: 'BOT', bot: true, text: p.text, blocks: p.blocks }))
    const users = this.userMessages.filter((m) => m.ts === threadTs || m.threadTs === threadTs).map((m) => ({ ts: m.ts, user: m.user, bot: false, text: m.text }))
    return [...bot, ...users].sort((a, b) => Number(a.ts) - Number(b.ts))
  }
  latestCalls = 0
  async latestReply(threadTs: string) {
    this.latestCalls++
    return (await this.replies(threadTs)).map((m) => m.ts).sort((a, b) => Number(a) - Number(b)).at(-1)
  }
  /** Roots of `posts` (and the user's own) as the channel history would list them. */
  async threads(limit: number) {
    const roots = [...this.posts.filter((p) => !p.threadTs), ...this.userMessages.filter((m) => !m.threadTs).map((m) => ({ ts: m.ts, text: m.text, blocks: undefined as unknown[] | undefined, user: true }))]
    return roots
      .map((r) => {
        const replies = [...this.posts.filter((p) => p.threadTs === r.ts), ...this.userMessages.filter((m) => m.threadTs === r.ts)]
        return {
          ts: r.ts,
          bot: !('user' in r),
          text: r.text,
          replyCount: replies.length,
          ...(replies.length ? { latestReply: replies.map((x) => x.ts).sort().at(-1)! } : {}),
          blockIds: ((r as { blocks?: Array<{ block_id?: string }> }).blocks ?? []).map((b) => String(b.block_id ?? '')),
        }
      })
      .sort((a, b) => Number(b.ts) - Number(a.ts))
      .slice(0, limit)
  }
  failDelete = new Set<string>()
  async delete(ts: string) {
    if (this.failDelete.has(ts)) throw new Error('ratelimited')
    this.deleted.push(ts)
  }
  userToken = false
  deletedAsUser: string[] = []
  async deleteAsUser(ts: string) {
    if (!this.userToken) return false
    this.deletedAsUser.push(ts)
    return true
  }
  async startStream(opts: { threadTs: string; recipientUserId: string; chunks: StreamChunk[] }) {
    if (this.failStreaming) throw new Error('not_allowed_token_type')
    const ts = `s${++this.n}.000`
    this.streams.push({ ts, threadTs: opts.threadTs, recipient: opts.recipientUserId, chunks: [...opts.chunks], stopped: false })
    return ts
  }
  failAppend = false
  async appendStream(ts: string, chunks: StreamChunk[]) {
    if (this.failAppend) throw new Error('internal_error')
    this.streams.find((s) => s.ts === ts)!.chunks.push(...chunks)
  }
  async stopStream(ts: string) {
    this.streams.find((s) => s.ts === ts)!.stopped = true
  }
  async setSessionStatus(threadTs: string, status: string) {
    this.statuses.push(`${status}@${threadTs}`)
  }
  canvases: Array<{ title: string; markdown: string }> = []
  canvasScope = true
  async createCanvas(title: string, markdown: string) {
    if (!this.canvasScope) return undefined
    this.canvases.push({ title, markdown })
    return `https://slack.example/docs/${this.canvases.length}`
  }
  homeViews: unknown[] = []
  async publishHome(_userId: string, view: unknown) {
    this.homeViews.push(view)
  }
  async renameSession(_threadTs: string, title: string) {
    this.renames.push(title)
  }
  async downloadFile(url: string) {
    return Buffer.from(`bytes-of:${url}`)
  }
  uploads: Array<{ threadTs: string; paths: string[]; text?: string }> = []
  filesScope = true
  async uploadFiles(o: { threadTs: string; paths: string[]; text?: string }) {
    if (!this.filesScope) return false
    this.uploads.push(o)
    return true
  }
  /** Optional in the API; set per test to capture direct messages. */
  dm?: (userId: string, text: string) => Promise<void>
  texts() {
    return this.posts.map((p) => p.text)
  }
}

export class FakeTmux implements TmuxLike {
  launches: Array<{ cwd: string; env: Record<string, string>; command: string[]; name?: string }> = []
  keys: string[] = []
  async launch(opts: { cwd: string; env: Record<string, string>; command: string[]; name?: string }) {
    this.launches.push(opts)
    return { window: '@7', pane: '%9' }
  }
  async sendKeys(pane: string, keys: string[]) {
    this.keys.push(`${pane}:${keys.join(' ')}`)
  }
  async typeLine(pane: string, text: string) {
    this.keys.push(`${pane}:${text}⏎`)
  }
  async pasteLine(pane: string, text: string) {
    this.keys.push(`${pane}:paste:${text}⏎`)
  }
  screen = '> hello\n  ⏵⏵ auto mode on (shift+tab to cycle)\n'
  async capture() {
    return this.screen
  }
  growths: string[] = []
  async growHeight(pane: string, rows: number) {
    this.growths.push(`${pane}:${rows}`)
    return false
  }
  async captureAnsi() {
    return this.screen
  }
  async killPane(pane: string) {
    this.keys.push(`${pane}:kill`)
  }
  async hasPane() {
    return true
  }
}

export async function setup(extra: Partial<BrokerConfig> & { transcript?: string } = {}) {
  const id = `${process.pid}-${Math.random().toString(36).slice(2)}`
  const socketPath = join(tmpdir(), `cs-${id}.sock`)
  const archiveDir = join(tmpdir(), `cs-archive-${id}`)
  const offsetsPath = join(tmpdir(), `cs-offsets-${id}.json`)
  const revivePath = join(tmpdir(), `cs-live-${id}.json`)
  const slack = new FakeSlack()
  const tmux = new FakeTmux()
  const { transcript: _ignored, ...brokerExtra } = extra
  const broker = new Broker(
    {
      channelId: 'C1',
      allowedUsers: new Set(['U1']),
      defaultCwd: '/default',
      launcher: '/bin/claude-slack',
      socketPath,
      flushMs: 20,
      // Never the real ones: a test run must not leave state the machine's own
      // broker would act on, such as reviving a session that never existed.
      offsetsPath,
      revivePath,
      listSessions: () => [{ id: 'sess-1', cwd: '/home/u/proj', title: '테스트 수정', mtime: 1, when: '5분 전' }],
      archiveDir,
      purgeGapMs: 0,
      // Tests never start a browser: pictures are off unless a test turns them on with its own renderer.
      screenImages: false,
      pendingPurgesPath: join(tmpdir(), `cs-pending-${id}.json`),
      pinsPath: join(tmpdir(), `cs-pins-${id}.json`),
      ...brokerExtra,
    },
    slack,
    tmux,
  )
  broker.log = () => {}
  const server = listen(socketPath, (c) => broker.onConn(c))
  await new Promise((r) => server.once('listening', r))
  // A restart test needs the second broker to tail the same file as the first.
  const transcript = extra.transcript ?? join(tmpdir(), `cs-${id}.jsonl`)
  if (!extra.transcript) writeFileSync(transcript, '')
  return { broker, slack, tmux, socketPath, transcript, archiveDir, offsetsPath, revivePath, close: () => server.close() }
}

export async function shim(socketPath: string, hello: Record<string, unknown>): Promise<{ conn: Conn; inbox: unknown[]; ack: string }> {
  const conn = await connect(socketPath)
  const inbox: unknown[] = []
  const ackP = new Promise<string>((resolve) => {
    conn.on('message', (m: { type: string; threadTs?: string }) => {
      inbox.push(m)
      if (m.type === 'hello_ack') resolve(m.threadTs!)
    })
  })
  conn.send({ type: 'hello', role: 'channel', key: String(hello.pid ?? 100), pid: 100, sessionId: 's1', cwd: '/home/u/proj', ...hello })
  return { conn, inbox, ack: await ackP }
}

export async function hook(socketPath: string, pid: number, event: Record<string, unknown>, transcript?: string) {
  const conn = await connect(socketPath)
  conn.send({ type: 'hook', key: String(pid), pid, event: { session_id: 's1', cwd: '/home/u/proj', ...(transcript ? { transcript_path: transcript } : {}), ...event } })
  conn.close()
  await tick(150)
}

export const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms))

/** Wait for a condition instead of a fixed delay, so a slow machine does not fail the run. */
export async function until(cond: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cond()) return
    await tick(25)
  }
  assert.fail(`시간 안에 이루어지지 않음: ${what}`)
}

/** Click a button the way Slack does: with the action_id and value actually rendered. */
export function button(blocks: unknown, baseActionId: string): { actionId: string; value: string } {
  for (const b of (blocks as Array<{ elements?: Array<{ action_id?: string; value?: string }> }>) ?? []) {
    for (const e of b.elements ?? []) {
      if (e.action_id?.startsWith(baseActionId) && e.value !== undefined) return { actionId: e.action_id, value: e.value }
    }
  }
  throw new Error(`no ${baseActionId} button in ${JSON.stringify(blocks)}`)
}


/** The rendered button whose value is exactly this, for messages that carry several of the same base. */
export function buttonWithValue(blocks: unknown, baseActionId: string, value: string): { actionId: string; value: string } {
  for (const b of (blocks as Array<{ elements?: Array<{ action_id?: string; value?: string }> }>) ?? []) {
    for (const e of b.elements ?? []) {
      if (e.action_id?.startsWith(baseActionId) && e.value === value) return { actionId: e.action_id, value: e.value }
    }
  }
  throw new Error(`no ${baseActionId} button with value ${value} in ${JSON.stringify(blocks)}`)
}

export function assistant(block: Record<string, unknown>) {
  return JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [block] } }) + '\n'
}
export function toolResult(id: string, content: string, isError = false) {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } }) + '\n'
}

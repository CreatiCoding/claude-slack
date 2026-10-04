import pkg from '@slack/bolt'
import { ACTION_PREFIXES } from './actions.ts'
import { WebClient } from '@slack/web-api'
import type { AnyChunk } from '@slack/types'
import { basename } from 'node:path'
const { App, LogLevel } = pkg

export type StreamChunk = AnyChunk
export type InFile = { url: string; mimetype: string; name: string }
export type InMsg = { user: string; text: string; ts: string; threadTs?: string; channel: string; files?: InFile[] }
export type InAction = { user: string; actionId: string; value: string; messageTs: string; channel: string; threadTs?: string; triggerId?: string; /** The message's current blocks, so a handler can edit one of them in place. */ blocks?: unknown[] }
export type InStop = { user: string; threadTs: string; channel: string }
/** `name` is the sub-command with the `/cc` or `/claude-code-` prefix removed (new, resume, list, history, help). */
export type InCommand = { user: string; name: string; text: string; channel: string; triggerId: string }

/** Slash commands registered in slack-manifest.json: a short and a full form for each. */
export const SLASH_COMMAND_NAMES = ['new', 'resume', 'list', 'history', 'refresh', 'help'] as const
export const SLASH_COMMANDS = SLASH_COMMAND_NAMES.flatMap((n) => [`/cc${n}`, `/claude-code-${n}`])

export function slashCommandName(command: string): string {
  return command.replace(/^\/(claude-code-|cc)/, '')
}
export interface ChannelThread {
  ts: string
  /** Posted by this app. Threads a person started are not ours to clean up. */
  bot: boolean
  text: string
  replyCount: number
  /** ts of the newest reply, when there are any. */
  latestReply?: string
  /** block_ids of the message, to recognise the channel's "new session" entry. */
  blockIds: string[]
}
export type InView = { user: string; callbackId: string; privateMetadata?: string; values: Record<string, Record<string, { value?: string; selected_option?: { value: string } }>> }
export type SessionStatus = 'active' | 'processing' | 'suspended' | 'closed'

/** The subset of the Slack Web API the broker needs. Fakeable in tests. */
export interface SlackApi {
  post(opts: { text: string; threadTs?: string; blocks?: unknown[] }): Promise<string>
  update(ts: string, text: string, blocks?: unknown[]): Promise<void>
  react(ts: string, name: string): Promise<void>
  unreact(ts: string, name: string): Promise<void>
  postEphemeral(user: string, text: string, threadTs?: string, blocks?: unknown[]): Promise<void>
  openModal(triggerId: string, view: unknown): Promise<void>
  permalink(ts: string): Promise<string>
  /** Find the bot's most recent channel message containing a block with this block_id. */
  findBotMessage(blockId: string): Promise<string | undefined>
  /** All messages in a thread, root first. `bot` marks messages this app can delete. */
  replies(threadTs: string): Promise<Array<{ ts: string; user?: string; bot: boolean; text: string; blocks?: unknown[] }>>
  /** A thread's channel name, its first message's author and the first 120 characters (51). */
  threadInfo?(channelId: string, ts: string): Promise<{ channel: string; user: string; text: string }>
  /** The newest reply of a thread in one call (the root's own ts when it has none); absent where only `replies` is available. */
  latestReply?(threadTs: string): Promise<string | undefined>
  /** The channel's recent top-level messages, newest first, to find threads nothing owns any more. */
  threads(limit: number): Promise<ChannelThread[]>
  delete(ts: string): Promise<void>
  /** Delete a message as the user (needs SLACK_USER_TOKEN). Resolves false when unavailable. */
  deleteAsUser(ts: string): Promise<boolean>
  startStream(opts: { threadTs: string; recipientUserId: string; chunks: StreamChunk[] }): Promise<string>
  appendStream(ts: string, chunks: StreamChunk[]): Promise<void>
  stopStream(ts: string, blocks?: unknown[]): Promise<void>
  setSessionStatus(threadTs: string, status: SessionStatus, opts?: { title?: string; initiatorUserId?: string }): Promise<void>
  renameSession(threadTs: string, title: string): Promise<void>
  /** Replace the app's Home tab for one user. */
  publishHome(userId: string, view: unknown): Promise<void>
  /**
   * Create a standalone canvas and return its link. Resolves undefined when the
   * app has no `canvases:write` scope, so callers can carry on without it.
   */
  createCanvas(title: string, markdown: string): Promise<string | undefined>
  /** Download a Slack-hosted file (e.g. `url_private` from a message's `files`), authenticated as the bot. */
  downloadFile(url: string): Promise<Buffer>
  /**
   * Upload local files into a thread as one message, with `text` as its caption.
   * Resolves false when the app has no `files:write` scope.
   */
  uploadFiles(opts: { threadTs: string; paths: string[]; text?: string }): Promise<boolean>
  /** A direct message to one user, for when a thread reply has gone unanswered too long. Optional: fakes may omit it. */
  dm?(userId: string, text: string): Promise<void>
}

export interface SlackEvents {
  onMessage(handler: (m: InMsg) => void): void
  onAction(handler: (a: InAction) => void): void
  onStop(handler: (s: InStop) => void): void
  onCommand(handler: (c: InCommand) => void): void
  onView(handler: (v: InView) => void): void
  onHomeOpened(handler: (userId: string) => void): void
}

/** Bolt's logger shape, so SDK warnings land in the same file and format as ours. */
export interface SdkLogSink {
  (level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR', msg: string): void
}

export function createBoltSlack(opts: { botToken: string; appToken: string; channelId: string; userToken?: string; sdkLog?: SdkLogSink }): {
  api: SlackApi
  events: SlackEvents
  start(): Promise<{ botUserId: string; teamId: string }>
} {
  const sink = opts.sdkLog
  const logger = sink
    ? {
        debug: (...m: unknown[]) => sink('DEBUG', m.join(' ')),
        info: (...m: unknown[]) => sink('INFO', m.join(' ')),
        warn: (...m: unknown[]) => sink('WARN', m.join(' ')),
        error: (...m: unknown[]) => sink('ERROR', m.join(' ')),
        setLevel: () => {},
        getLevel: () => LogLevel.WARN,
        setName: () => {},
      }
    : undefined
  const app = new App({ token: opts.botToken, appToken: opts.appToken, socketMode: true, logLevel: LogLevel.WARN, ...(logger ? { logger } : {}) })
  const channel = opts.channelId
  const messageHandlers: Array<(m: InMsg) => void> = []
  const actionHandlers: Array<(a: InAction) => void> = []
  const stopHandlers: Array<(s: InStop) => void> = []
  const commandHandlers: Array<(c: InCommand) => void> = []
  const homeHandlers: Array<(userId: string) => void> = []
  const viewHandlers: Array<(v: InView) => void> = []
  let botUserId = ''
  let teamId = ''

  app.event('app_home_opened', async ({ event }) => {
    const e = event as { user?: string; tab?: string }
    if (e.tab && e.tab !== 'home') return
    for (const h of homeHandlers) h(String(e.user ?? ''))
  })

  app.event('message', async ({ event }) => {
    const e = event as unknown as Record<string, unknown>
    // Say why a message was dropped: a message posted with the user's own token (QA, automation)
    // looks slightly different from one typed in the client, and a silent drop is undebuggable.
    const drop = (why: string) => sink?.('DEBUG', `message dropped (${why}) ts=${String(e.ts)} channel=${String(e.channel)} user=${String(e.user ?? '')} subtype=${String(e.subtype ?? '')} bot_id=${String(e.bot_id ?? '')}`)
    if (e.subtype && e.subtype !== 'file_share') return drop('subtype')
    if (e.channel !== channel) return drop('other channel')
    // A message posted through the app's own user token carries a bot_id and app_id even though
    // its author is the person (and auth.test on the bot token does not reveal the app id to
    // compare against). The author is what matters: a real user, not this bot; the broker's
    // allowlist decides the rest.
    if (!e.user || e.user === botUserId) return drop('no user or the bot itself')
    const rawFiles = Array.isArray(e.files) ? (e.files as Array<Record<string, unknown>>) : []
    // Every file, not only images: a PDF or a log is handed to the session as a path.
    const files = rawFiles
      .filter((f) => typeof f.mimetype === 'string' && typeof f.url_private === 'string')
      .map((f) => ({ url: String(f.url_private), mimetype: String(f.mimetype), name: String(f.name ?? 'file') }))
    const m: InMsg = { user: String(e.user), text: String(e.text ?? ''), ts: String(e.ts), threadTs: e.thread_ts ? String(e.thread_ts) : undefined, channel, files: files.length ? files : undefined }
    for (const h of messageHandlers) h(m)
  })

  app.event('agent_session_stopped' as never, async ({ event }: { event: Record<string, unknown> }) => {
    if (event.channel !== channel) return
    const s: InStop = { user: String(event.user ?? ''), threadTs: String(event.thread_ts ?? ''), channel }
    for (const h of stopHandlers) h(s)
  })

  app.action(new RegExp(`^(${ACTION_PREFIXES.join('|')})`), async ({ ack, body, action }) => {
    await ack()
    const b = body as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
    const a = action as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
    const inAction: InAction = {
      user: b.user?.id ?? '',
      actionId: a.action_id,
      value: a.value ?? a.selected_option?.value ?? '',
      messageTs: b.message?.ts ?? b.container?.message_ts ?? '',
      threadTs: b.message?.thread_ts ?? b.container?.thread_ts,
      channel: b.channel?.id ?? b.container?.channel_id ?? channel,
      triggerId: b.trigger_id,
      blocks: b.message?.blocks as unknown[] | undefined,
    }
    for (const h of actionHandlers) h(inAction)
  })

  for (const name of SLASH_COMMANDS) {
    app.command(name, async ({ ack, command }) => {
      await ack()
      const c: InCommand = { user: command.user_id, name: slashCommandName(command.command), text: command.text ?? '', channel: command.channel_id, triggerId: command.trigger_id }
      for (const h of commandHandlers) h(c)
    })
  }

  app.view(/^cs_/, async ({ ack, body, view }) => {
    await ack()
    const v: InView = { user: body.user.id, callbackId: view.callback_id, privateMetadata: view.private_metadata, values: view.state.values as InView['values'] }
    for (const h of viewHandlers) h(v)
  })

  const client = app.client
  const userClient = opts.userToken ? new WebClient(opts.userToken) : undefined
  const api: SlackApi = {
    async post({ text, threadTs, blocks }) {
      const res = await retrying(() => client.chat.postMessage({ channel, text, thread_ts: threadTs, blocks: blocks as never, unfurl_links: false, unfurl_media: false }))
      return res.ts as string
    },
    async update(ts, text, blocks) {
      await retrying(() => client.chat.update({ channel, ts, text, blocks: (blocks ?? []) as never }))
    },
    async react(ts, name) {
      await ignoring(['already_reacted', 'invalid_name'], () => retrying(() => client.reactions.add({ channel, timestamp: ts, name })))
    },
    async unreact(ts, name) {
      await ignoring(['no_reaction', 'invalid_name'], () => retrying(() => client.reactions.remove({ channel, timestamp: ts, name })))
    },
    async dm(userId, text) {
      await retrying(() => client.chat.postMessage({ channel: userId, text, unfurl_links: false, unfurl_media: false }))
    },
    async postEphemeral(user, text, threadTs, blocks) {
      await retrying(() => client.chat.postEphemeral({ channel, user, text, thread_ts: threadTs, blocks: blocks as never }))
    },
    async openModal(triggerId, view) {
      await client.views.open({ trigger_id: triggerId, view: view as never })
    },
    async permalink(ts) {
      const res = await client.chat.getPermalink({ channel, message_ts: ts })
      return String(res.permalink ?? '')
    },
    async threadInfo(channelId, ts) {
      const [chan, first] = await Promise.all([client.conversations.info({ channel: channelId }), client.conversations.replies({ channel: channelId, ts, limit: 1 })])
      const msg = first.messages?.[0]
      const who = msg?.user ? await client.users.info({ user: msg.user }).catch(() => undefined) : undefined
      const name = who?.user?.real_name || who?.user?.name || msg?.user || ''
      return { channel: String(chan.channel?.name ?? channelId), user: name, text: String(msg?.text ?? '').replace(/\s+/g, ' ').slice(0, 120) }
    },
    async replies(threadTs) {
      const out: Array<{ ts: string; user?: string; bot: boolean; text: string; blocks?: unknown[] }> = []
      let cursor: string | undefined
      do {
        const res = await client.conversations.replies({ channel, ts: threadTs, limit: 999, cursor })
        for (const m of res.messages ?? []) {
          out.push({ ts: String(m.ts), user: m.user, bot: m.user === botUserId || !!m.bot_id, text: String(m.text ?? ''), blocks: m.blocks as unknown[] })
        }
        cursor = res.response_metadata?.next_cursor || undefined
      } while (cursor)
      return out
    },
    async latestReply(threadTs) {
      const res = await client.conversations.history({ channel, oldest: threadTs, latest: threadTs, inclusive: true, limit: 1 })
      const m = res.messages?.[0]
      return m ? String((m as { latest_reply?: string }).latest_reply ?? m.ts) : undefined
    },
    async threads(limit) {
      const out: ChannelThread[] = []
      let cursor: string | undefined
      do {
        const res = await client.conversations.history({ channel, limit: Math.min(200, limit), cursor })
        for (const m of res.messages ?? []) {
          // A reply that was also posted to the channel carries a thread_ts of another root; only roots count.
          if (m.thread_ts && m.thread_ts !== m.ts) continue
          out.push({
            ts: String(m.ts),
            bot: m.user === botUserId || !!m.bot_id,
            text: String(m.text ?? ''),
            replyCount: Number(m.reply_count ?? 0),
            ...(m.latest_reply ? { latestReply: String(m.latest_reply) } : {}),
            blockIds: ((m.blocks ?? []) as Array<{ block_id?: string }>).map((b) => String(b.block_id ?? '')),
          })
        }
        cursor = out.length < limit ? res.response_metadata?.next_cursor || undefined : undefined
      } while (cursor)
      return out.slice(0, limit)
    },
    async delete(ts) {
      await ignoring(['message_not_found'], () => client.chat.delete({ channel, ts }))
    },
    async deleteAsUser(ts) {
      if (!userClient) return false
      await ignoring(['message_not_found'], () => userClient.chat.delete({ channel, ts }))
      return true
    },
    async findBotMessage(blockId) {
      const res = await client.conversations.history({ channel, limit: 200 })
      const hit = (res.messages ?? []).find((m) => m.user === botUserId && (m.blocks ?? []).some((b) => b.block_id === blockId))
      return hit?.ts
    },
    async startStream({ threadTs, recipientUserId, chunks }) {
      const res = await client.chat.startStream({ channel, thread_ts: threadTs, recipient_user_id: recipientUserId, recipient_team_id: teamId, chunks })
      return res.ts as string
    },
    async appendStream(ts, chunks) {
      await client.chat.appendStream({ channel, ts, chunks })
    },
    async stopStream(ts, blocks) {
      await client.chat.stopStream({ channel, ts, ...(blocks ? { blocks: blocks as never } : {}) })
    },
    async setSessionStatus(threadTs, status, o) {
      await client.agents.sessions.setStatus({
        channel_id: channel,
        thread_ts: threadTs,
        status,
        ...(o?.title ? { title: o.title.slice(0, 200) } : {}),
        ...(o?.initiatorUserId ? { initiator_user_id: o.initiatorUserId } : {}),
      })
    },
    async createCanvas(title, markdown) {
      try {
        const res = await client.canvases.create({ title, document_content: { type: 'markdown', markdown } })
        const id = res.canvas_id as string | undefined
        return id ? `https://slack.com/docs/${teamId}/${id}` : undefined
      } catch (err) {
        // Missing scope is the normal case until the app is reinstalled with it.
        if ((err as { data?: { error?: string } })?.data?.error === 'missing_scope') return undefined
        throw err
      }
    },
    async publishHome(userId, view) {
      await client.views.publish({ user_id: userId, view: view as never })
    },
    async renameSession(threadTs, title) {
      await client.agents.sessions.rename({ channel_id: channel, thread_ts: threadTs, title: title.slice(0, 200) } as never)
    },
    async downloadFile(url) {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${opts.botToken}` } })
      if (!res.ok) throw new Error(`file download failed: ${res.status} ${res.statusText}`)
      return Buffer.from(await res.arrayBuffer())
    },
    async uploadFiles({ threadTs, paths, text }) {
      try {
        await client.filesUploadV2({
          channel_id: channel,
          thread_ts: threadTs,
          ...(text ? { initial_comment: text } : {}),
          file_uploads: paths.map((p) => ({ file: p, filename: basename(p) })),
        } as never)
        return true
      } catch (err) {
        if ((err as { data?: { error?: string } })?.data?.error === 'missing_scope') return false
        throw err
      }
    },
  }

  return {
    api,
    events: {
      onMessage: (h) => messageHandlers.push(h),
      onAction: (h) => actionHandlers.push(h),
      onStop: (h) => stopHandlers.push(h),
      onCommand: (h) => commandHandlers.push(h),
      onView: (h) => viewHandlers.push(h),
      onHomeOpened: (h) => homeHandlers.push(h),
    },
    async start() {
      await app.start()
      const auth = await client.auth.test()
      botUserId = String(auth.user_id ?? '')
      teamId = String(auth.team_id ?? '')
      return { botUserId, teamId }
    },
  }
}

async function ignoring(codes: string[], fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn()
  } catch (err) {
    if (!codes.some((c) => String(err).includes(c))) throw err
  }
}

/** Failures that mean "the network blinked", not "Slack said no". */
const TRANSIENT_RE = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|network|service_unavailable|internal_error|request_timeout/i
const RETRY_DELAYS_MS = [1000, 3000, 9000]

/**
 * Retry a Web API call across a dropped connection. Rate limits the SDK handles
 * itself; this is for the laptop-sleeps case Remote Control also survives by
 * queueing. Three tries, backing off, then the error is the caller's.
 */
export async function retrying<T>(fn: () => Promise<T>, delays = RETRY_DELAYS_MS): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i <= delays.length; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      const code = (err as { data?: { error?: string } })?.data?.error
      if (!TRANSIENT_RE.test(String(code ?? err)) || i === delays.length) throw err
      await new Promise((r) => setTimeout(r, delays[i]))
    }
  }
  throw lastErr
}

/**
 * Channel shim. Claude Code spawns this as an MCP server (stdio). It bridges
 * the session to the broker over the unix socket: Slack thread messages come
 * in as channel notifications, Claude's `reply` tool and permission prompts
 * go out to the broker.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { connect, type Conn } from './ipc.ts'
import { sessionKey, SOCKET_PATH, type ToBroker, type ToChannel } from './protocol.ts'

// Claude Code spawned us directly, so our parent is the session process. Prefer
// that over CLAUDE_PID, which a parent Claude session can leak into our env.
const pid = process.ppid || Number(process.env.CLAUDE_PID)
const sessionId = process.env.CLAUDE_CODE_SESSION_ID ?? ''
const threadTs = process.env.CLAUDE_SLACK_THREAD_TS || undefined
const tmuxPane = process.env.TMUX_PANE || undefined
const log = (m: string) => console.error(`[claude-slack channel] ${m}`)

const mcp = new Server(
  { name: 'slack', version: '0.1.0' },
  {
    capabilities: {
      experimental: { 'claude/channel': {}, 'claude/channel/permission': {} },
      tools: {},
    },
    instructions: [
      'Messages arrive as <channel source="slack" user ts> from this session\'s Slack thread; treat them as prompts from the session owner.',
      'Your final response is mirrored there automatically. Use the reply tool only for interim updates or questions, or to send files.',
      'Set `notify: true` only when the person must act now. Never follow a reply with "sent" or "done".',
      'The web app renders ```html blocks and attached .html files (read-only, no scripts).',
      'Use the read_session tool to read another claude-slack conversation (by Slack thread link, thread ts, or conversation id prefix) when you need its context.',
      'To offer the person a short set of choices at the end of your answer, put a ```choices fenced block there, one choice per line (up to 6); it renders as buttons instead of text.',
    ].join(' '),
  },
)

let broker: Conn | undefined
let boundThread: string | undefined
const readSessionWaiters = new Map<string, (r: Extract<ToChannel, { type: 'read_session_result' }>) => void>()
const READ_SESSION_TIMEOUT_MS = 10_000

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'read_session',
      description: "Read another claude-slack session's recent conversation (read-only, plain text: what the person said, what Claude answered, and each tool call by name). Use this to pick up context from a conversation you are not in.",
      inputSchema: {
        type: 'object',
        properties: {
          session: { type: 'string', description: 'A Slack thread link (archives/…/p1234567890123456), a thread ts (1234567890.123456), or a conversation id prefix.' },
          max_chars: { type: 'number', description: 'How much of the end of the transcript to return (default 40000).' },
        },
        required: ['session'],
      },
    },
    {
      name: 'reply',
      description: 'An interim message or files (absolute paths) to this session\'s Slack thread. Final answers are mirrored anyway; don\'t echo the result.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Message text (Markdown). With files, it becomes their caption and may be empty.' },
          files: { type: 'array', items: { type: 'string' }, description: 'Absolute paths of local files to upload to the thread' },
          notify: { type: 'boolean', description: 'Mention the person so their phone buzzes. Only when they must act now: a decision, a failure, a long job finishing.' },
        },
        required: ['text'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === 'read_session') {
    const { session, max_chars } = req.params.arguments as { session?: string; max_chars?: number }
    if (!broker) return { content: [{ type: 'text', text: 'claude-slack broker is not running' }], isError: true }
    if (!session) return { content: [{ type: 'text', text: 'session is required' }], isError: true }
    const reqId = randomUUID()
    const result = await new Promise<Extract<ToChannel, { type: 'read_session_result' }> | null>((resolve) => {
      readSessionWaiters.set(reqId, resolve)
      const timer = setTimeout(() => {
        if (readSessionWaiters.delete(reqId)) resolve(null)
      }, READ_SESSION_TIMEOUT_MS)
      timer.unref?.()
      send({ type: 'read_session', reqId, session, ...(max_chars ? { maxChars: max_chars } : {}) })
    })
    if (!result) return { content: [{ type: 'text', text: 'timed out waiting for the broker' }], isError: true }
    if (result.error) return { content: [{ type: 'text', text: result.error }], isError: true }
    return { content: [{ type: 'text', text: result.text || '(empty)' }] }
  }
  if (req.params.name !== 'reply') throw new Error(`unknown tool: ${req.params.name}`)
  const { text = '', files = [], notify = false } = req.params.arguments as { text?: string; files?: string[]; notify?: boolean }
  if (!broker) return { content: [{ type: 'text', text: 'not sent: claude-slack broker is not running' }], isError: true }
  // The upload happens in the broker, out of our sight, so catch bad paths here where Claude can still see the error.
  const bad = files.filter((f) => !isAbsolute(f) || !statSync(f, { throwIfNoEntry: false })?.isFile())
  if (bad.length) return { content: [{ type: 'text', text: `not sent: not an absolute path to an existing file: ${bad.join(', ')}` }], isError: true }
  send({ type: 'reply', text, ...(files.length ? { files } : {}), ...(notify ? { notify: true } : {}) })
  // Worded so the model has nothing tempting to repeat as its own message.
  return { content: [{ type: 'text', text: 'Delivered to the Slack thread. Continue your work; do not repeat this confirmation.' }] }
})

const PermissionRequestSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
})

mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  send({
    type: 'permission_request',
    requestId: params.request_id,
    toolName: params.tool_name,
    description: params.description,
    inputPreview: params.input_preview,
  })
})

function send(msg: ToBroker): void {
  broker?.send(msg)
}

// Another process already owns this run: reconnecting at the normal pace would just be refused again
// every few seconds. Slowed way down instead of stopped outright, in case the other one later exits.
let byeAt: number | undefined

async function onBrokerMessage(msg: ToChannel): Promise<void> {
  switch (msg.type) {
    case 'hello_ack':
      boundThread = msg.threadTs
      byeAt = undefined
      log(`bound to Slack thread ${boundThread}`)
      break
    case 'inbound':
      await mcp.notification({
        method: 'notifications/claude/channel',
        params: { content: msg.text, meta: { user: msg.user, ts: msg.ts } },
      })
      break
    case 'permission':
      await mcp.notification({
        method: 'notifications/claude/channel/permission',
        params: { request_id: msg.requestId, behavior: msg.behavior },
      })
      break
    case 'read_session_result': {
      const waiting = readSessionWaiters.get(msg.reqId)
      if (waiting) {
        readSessionWaiters.delete(msg.reqId)
        waiting(msg)
      }
      break
    }
    case 'bye':
      byeAt = Date.now()
      log(`broker turned this connection away: ${msg.reason}; backing off`)
      break
  }
}

/** A broker that was just restarted comes back in seconds; retrying fast for a while catches that window
 *  without hammering a socket that is genuinely down for longer. */
const FAST_RECONNECT_MS = 500
const FAST_RECONNECT_WINDOW_MS = 30_000
const SLOW_RECONNECT_MS = 5_000
const BYE_BACKOFF_MS = 60_000

async function connectLoop(): Promise<void> {
  let warned = false
  // Set the moment a connection that was up goes down, or the first failed attempt; cleared on success.
  let lostAt: number | undefined
  for (;;) {
    try {
      const conn = await connect(SOCKET_PATH)
      broker = conn
      warned = false
      lostAt = undefined
      conn.send({ type: 'hello', role: 'channel', key: sessionKey(pid), pid, sessionId, cwd: process.cwd(), threadTs, tmuxPane } satisfies ToBroker)
      conn.on('message', (m: ToChannel) => onBrokerMessage(m).catch((e) => log(`handler failed: ${e}`)))
      await new Promise<void>((resolve) => conn.once('close', resolve))
      broker = undefined
      lostAt ??= Date.now()
      log('broker connection closed; will retry')
    } catch (err) {
      lostAt ??= Date.now()
      if (!warned) {
        log(`broker not reachable at ${SOCKET_PATH} (${(err as Error).message}); retrying`)
        warned = true
      }
    }
    const delay = byeAt !== undefined ? BYE_BACKOFF_MS : Date.now() - lostAt! < FAST_RECONNECT_WINDOW_MS ? FAST_RECONNECT_MS : SLOW_RECONNECT_MS
    await new Promise((r) => setTimeout(r, delay))
  }
}

// Only talk to the broker once Claude Code has finished the MCP handshake;
// notifications sent before that are dropped.
const initialized = new Promise<void>((resolve) => {
  mcp.oninitialized = () => resolve()
})
await mcp.connect(new StdioServerTransport())
if (process.env.CLAUDE_SLACK) {
  initialized.then(() => {
    log('mcp initialized; connecting to broker')
    return connectLoop()
  }).catch((e) => log(`connect loop died: ${e}`))
} else {
  log('CLAUDE_SLACK is not set; running inert (start Claude via bin/claude-slack to bridge this session)')
}

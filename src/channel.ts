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
      'The web app renders ```html blocks and attached .html files (read-only).',
    ].join(' '),
  },
)

let broker: Conn | undefined
let boundThread: string | undefined

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
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

async function onBrokerMessage(msg: ToChannel): Promise<void> {
  switch (msg.type) {
    case 'hello_ack':
      boundThread = msg.threadTs
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
  }
}

async function connectLoop(): Promise<void> {
  let warned = false
  for (;;) {
    try {
      const conn = await connect(SOCKET_PATH)
      broker = conn
      warned = false
      conn.send({ type: 'hello', role: 'channel', key: sessionKey(pid), pid, sessionId, cwd: process.cwd(), threadTs, tmuxPane } satisfies ToBroker)
      conn.on('message', (m: ToChannel) => onBrokerMessage(m).catch((e) => log(`handler failed: ${e}`)))
      await new Promise<void>((resolve) => conn.once('close', resolve))
      broker = undefined
      log('broker connection closed; will retry')
    } catch (err) {
      if (!warned) {
        log(`broker not reachable at ${SOCKET_PATH} (${(err as Error).message}); retrying every 5s`)
        warned = true
      }
    }
    await new Promise((r) => setTimeout(r, 5000))
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

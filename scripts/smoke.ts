/**
 * End-to-end check without Slack: run the broker with a console "Slack",
 * launch a real Claude Code session in tmux via bin/claude-slack, inject a
 * prompt as if it came from a thread reply, and print everything the broker
 * would have sent to Slack. Usage: node scripts/smoke.ts <cwd> "<prompt>"
 */
import { Broker } from '../src/broker.ts'
import { listen } from '../src/ipc.ts'
import { SOCKET_PATH } from '../src/protocol.ts'
import type { SlackApi, StreamChunk } from '../src/slack.ts'
import { realTmux } from '../src/tmux.ts'
import { autoConfirmDialogs } from '../src/dialog.ts'
import { REPO_ROOT } from '../src/config.ts'
import { resolve } from 'node:path'

const [cwd = process.cwd(), prompt = 'What files are in this directory? Answer in one line.'] = process.argv.slice(2)
let n = 0
const stamp = () => new Date().toISOString().slice(11, 19)
const consoleSlack: SlackApi = {
  async post({ text, threadTs, blocks }) {
    const ts = `${++n}`
    console.log(`${stamp()} POST${threadTs ? ` [thread ${threadTs}]` : ''} #${ts}: ${text}${blocks ? ' +blocks' : ''}`)
    return ts
  },
  async update(ts, text) {
    console.log(`${stamp()} UPDATE #${ts}: ${text}`)
  },
  async react(ts, name) {
    console.log(`${stamp()} REACT +${name} on #${ts}`)
  },
  async unreact(ts, name) {
    console.log(`${stamp()} REACT -${name} on #${ts}`)
  },
  async postEphemeral(user, text) {
    console.log(`${stamp()} EPHEMERAL to ${user}: ${text}`)
  },
  async openModal() {
    console.log(`${stamp()} MODAL opened`)
  },
  async permalink(ts) {
    return `https://slack.example/${ts}`
  },
  async findBotMessage() {
    return 'entry'
  },
  async threads() {
    return []
  },
  async replies() {
    return []
  },
  async delete(ts) {
    console.log(`${stamp()} DELETE #${ts}`)
  },
  async deleteAsUser() {
    return false
  },
  async startStream({ threadTs, chunks }) {
    const ts = `s${++n}`
    console.log(`${stamp()} STREAM start #${ts} [thread ${threadTs}] ${fmt(chunks)}`)
    return ts
  },
  async appendStream(ts, chunks) {
    console.log(`${stamp()} STREAM append #${ts} ${fmt(chunks)}`)
  },
  async stopStream(ts) {
    console.log(`${stamp()} STREAM stop #${ts}`)
  },
  async setSessionStatus(threadTs, status) {
    console.log(`${stamp()} STATUS ${status} [thread ${threadTs}]`)
  },
  async createCanvas() {
    return undefined
  },
  async publishHome() {},
  async renameSession(_t, title) {
    console.log(`${stamp()} RENAME ${title}`)
  },
  async downloadFile() {
    return Buffer.from('')
  },
  async uploadFiles() {
    return true
  },
}
function fmt(chunks: StreamChunk[]): string {
  return chunks
    .map((c) => (c.type === 'markdown_text' ? `text(${JSON.stringify(c.text.slice(0, 80))})` : c.type === 'task_update' ? `task(${c.status}: ${c.title}${c.output ? ` → ${JSON.stringify(c.output.slice(0, 60))}` : ''})` : c.type))
    .join(' | ')
}

const broker = new Broker(
  { channelId: 'C1', allowedUsers: new Set(['U1']), defaultCwd: cwd, launcher: resolve(REPO_ROOT, 'bin', 'claude-slack'), socketPath: SOCKET_PATH, flushMs: 1500 },
  consoleSlack,
  realTmux,
  (pane, done) => autoConfirmDialogs(realTmux, pane, done),
)
const server = listen(SOCKET_PATH, (c) => broker.onConn(c))
await new Promise((r) => server.once('listening', r))
console.log(`${stamp()} broker listening on ${SOCKET_PATH}`)

// Simulate a top-level Slack message: "<cwd> <prompt>"
await broker.handleSlackMessage({ user: 'U1', text: `${cwd} ${prompt}`, ts: '1000.0', channel: 'C1' })

const deadline = Date.now() + 180_000
const timer = setInterval(async () => {
  const s = broker.sessions[0]
  if (Date.now() > deadline) {
    console.log(`${stamp()} timeout`)
    finish()
  }
  if (s && !s.turn && s.transcriptPath && (s as { _done?: boolean })._done !== true && Date.now() > (globalThis as { _t0?: number })._t0!) {
    // no-op; we finish on Stop via the log below
  }
}, 2000)
;(globalThis as { _t0?: number })._t0 = Date.now() + 15_000

const origLog = broker.log
broker.log = (m: string) => {
  origLog(m)
}
// Finish a few seconds after the first Stop (status active) shows up.
const origStatus = consoleSlack.setSessionStatus
consoleSlack.setSessionStatus = async (threadTs, status, o) => {
  await origStatus(threadTs, status, o)
  if (status === 'active') setTimeout(finish, 4000)
}

async function finish() {
  clearInterval(timer)
  const s = broker.sessions[0]
  if (s?.pane) {
    console.log(`${stamp()} --- terminal screen ---`)
    console.log((await realTmux.capture(s.pane)).replace(/\s+$/, ''))
    await realTmux.killPane(s.pane).catch(() => {})
  }
  server.close()
  setTimeout(() => process.exit(0), 1500)
}

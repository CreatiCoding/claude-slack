/**
 * QA sweep for the "stuck session" class of bugs: a real Claude Code session
 * is driven through scenarios that historically wedged (permission prompts,
 * model switch, plan mode). A fake Slack auto-clicks every card and dialog the
 * broker surfaces, exactly as a user would.
 *
 * The general check is one invariant, not a list of dialogs:
 *   after any action, the terminal must never sit on an input-waiting dialog
 *   for more than STUCK_MS — the broker must surface it as buttons (which the
 *   fake Slack then clicks) or drive it directly.
 * Any dialog the broker fails to handle stays on screen and is reported, even
 * a kind we have never seen.
 *
 * Usage: node --env-file=.env scripts/qa-sweep.ts [cwd]
 * No Slack tokens needed. Leaves nothing running.
 *
 * With `CLAUDE_SLACK_QA_CHANNEL` set (a channel the bot is in, never the live
 * one), every card the broker renders is also posted there for real. That is
 * what catches a block type this workspace rejects — `invalid_blocks` showed up
 * 1,274 times in one day's log without a single test noticing, because the fake
 * Slack accepts anything. Inbound still goes straight to `handleSlackMessage`:
 * a second Socket Mode connection for the same app would take events away from
 * the live broker, so the sweep never opens one.
 */
import { Broker } from '../src/broker.ts'
import { listen } from '../src/ipc.ts'
import { SOCKET_PATH } from '../src/protocol.ts'
import type { SlackApi, StreamChunk } from '../src/slack.ts'
import { realTmux } from '../src/tmux.ts'
import { autoConfirmDialogs, parseDialog } from '../src/dialog.ts'
import { REPO_ROOT } from '../src/config.ts'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { WebClient } from '@slack/web-api'

// The QA session gets its own socket and tmux session (see docs/QA.md), so its channel
// shim can only reach this sweep's broker. Channels stay on, which is the point: the
// injection path (broker → shim → MCP notification → session) is what breaks.
const qaChannel = process.env.CLAUDE_SLACK_QA_CHANNEL
if (!qaChannel) process.env.CLAUDE_SLACK_NO_CHANNEL = '1'
const cwd = process.argv[2] ?? REPO_ROOT
const STUCK_MS = 30_000
const stamp = () => new Date().toISOString().slice(11, 19)
const log = (m: string) => console.log(`${stamp()} ${m}`)

interface Block { type?: string; block_id?: string; elements?: Array<{ action_id?: string; value?: string }> }
function findAction(blocks: unknown, prefix: string): { actionId: string; value: string } | undefined {
  for (const b of (blocks as Block[]) ?? []) {
    for (const e of b.elements ?? []) {
      if (e.action_id?.startsWith(prefix) && e.value) return { actionId: e.action_id, value: e.value }
    }
  }
  return undefined
}

let broker: Broker
let n = 0
let stops = 0
/** What the run actually rendered, so a scenario cannot pass by producing nothing. */
const rendered = { permission: 0, dialog: 0 }
const clicked = new Set<string>()
/** Auto-click any permission card or surfaced dialog, like the user tapping a button. */
function autoClick(ts: string, blocks: unknown): void {
  const perm = findAction(blocks, 'perm_allow')
  const dlg = findAction(blocks, 'dlg_answer')
  const hit = perm ?? dlg
  if (!hit || clicked.has(ts)) return
  clicked.add(ts)
  // Use the real action_id Slack would deliver (it carries a uniqueness suffix).
  const actionId = hit.actionId
  log(`  ↳ auto-click ${actionId} (${hit.value})`)
  setTimeout(() => broker.handleAction({ user: 'U1', actionId, value: hit.value, messageTs: ts, channel: 'C1' }).catch((e) => log(`click failed: ${e}`)), 400)
}

/**
 * Post the same message to the QA channel for real, so Slack itself judges the
 * blocks. Failures are recorded, never thrown: the sweep is about the terminal
 * not getting stuck, and a rejected block should not end the run.
 */
const web = qaChannel ? new WebClient(process.env.SLACK_BOT_TOKEN) : undefined
const blockFailures: string[] = []
async function mirror(text: string, blocks?: unknown[]): Promise<void> {
  if (!web || !qaChannel) return
  try {
    await web.chat.postMessage({ channel: qaChannel, text, blocks: blocks as never, unfurl_links: false })
  } catch (err) {
    const code = (err as { data?: { error?: string } })?.data?.error ?? String(err)
    const types = (blocks as Array<{ type?: string }> | undefined)?.map((b) => b.type).join(',') ?? '-'
    const note = `Slack 이 거부한 블록 [${types}]: ${code}`
    if (!blockFailures.includes(note)) blockFailures.push(note)
    log(`  ⚠ ${note}`)
  }
}

const slack: SlackApi = {
  async post({ text, threadTs, blocks }) {
    const ts = `${++n}`
    if (blocks) log(`POST${threadTs ? ' [thread]' : ''}: ${text.split('\n')[0]!.slice(0, 70)} +blocks`)
    if (/권한 요청/.test(text)) rendered.permission++
    if (/선택을 기다립니다|입력을 기다립니다/.test(text)) rendered.dialog++
    await mirror(text, blocks)
    if (blocks) autoClick(ts, blocks)
    return ts
  },
  async update() {},
  async react() {},
  async unreact() {},
  async postEphemeral(_u, text, _t, blocks) {
    await mirror(text, blocks)
    if (blocks) autoClick(`e${++n}`, blocks)
  },
  async openModal() {},
  async permalink(ts) {
    return `https://slack.example/${ts}`
  },
  async findBotMessage() {
    return undefined
  },
  async threads() {
    return []
  },
  async replies() {
    return []
  },
  async delete() {},
  async deleteAsUser() {
    return false
  },
  async startStream() {
    return `s${++n}`
  },
  async appendStream() {},
  async stopStream() {},
  async setSessionStatus(_t, status) {
    if (status === 'active' || status === 'closed') stops++
  },
  async createCanvas() {
    return undefined
  },
  async publishHome() {},
  async renameSession() {},
  async downloadFile() {
    return Buffer.from('')
  },
  async uploadFiles() {
    return true
  },
}

broker = new Broker(
  { channelId: 'C1', allowedUsers: new Set(['U1']), defaultCwd: cwd, launcher: resolve(REPO_ROOT, 'bin', 'claude-slack'), socketPath: SOCKET_PATH, flushMs: 1200, stallMs: 8000 },
  slack,
  realTmux,
  (pane, done) => autoConfirmDialogs(realTmux, pane, done),
)
broker.log = () => {}
const server = listen(SOCKET_PATH, (c) => broker.onConn(c))
await new Promise((r) => server.once('listening', r))

const failures: string[] = []
let sawStuck: { since: number; screen: string } | null = null
// The invariant monitor: a numbered dialog must never persist past STUCK_MS.
const monitor = setInterval(async () => {
  const s = broker.sessions[0]
  if (!s?.pane) return
  const screen = await realTmux.capture(s.pane).catch(() => '')
  const dialog = parseDialog(screen)
  if (dialog) {
    if (!sawStuck) sawStuck = { since: Date.now(), screen }
    else if (Date.now() - sawStuck.since > STUCK_MS) {
      const tail = screen.replace(/\s+$/, '').split('\n').slice(-10).join('\n')
      failures.push(`터미널이 ${Math.round((Date.now() - sawStuck.since) / 1000)}초째 다이얼로그에 멈춤:\n${tail}`)
      log(`❌ STUCK: ${dialog.question}`)
      sawStuck = { since: Date.now(), screen } // reset so we don't spam
    }
  } else sawStuck = null
}, 2000)

async function settle(label: string, ms: number): Promise<void> {
  log(`▶ ${label}`)
  const start = Date.now()
  // Quiet = terminal not on a dialog and no active turn, stable for two checks.
  // The continuous monitor is the real stuck-detector; this just paces scenarios
  // and gives the auto-click round-trips time. A grace period avoids settling
  // before the action even starts.
  let quiet = 0
  while (Date.now() - start < ms) {
    await sleep(2000)
    const s = broker.sessions[0]
    const screen = s?.pane ? await realTmux.capture(s.pane).catch(() => '') : ''
    const busy = !!s?.turn || !!parseDialog(screen)
    quiet = busy ? 0 : quiet + 1
    if (Date.now() - start > 6000 && quiet >= 2) {
      log(`  ✓ ${label} quiet`)
      return
    }
  }
  log(`  … ${label} still busy after ${ms / 1000}s`)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

try {
  // Manual permission mode so a Bash tool call actually prompts.
  await broker.launchSession({ cwd, prompt: '', user: 'U1', extraArgs: ['--permission-mode', 'default'] })
  await sleep(9000)
  const s = broker.sessions[0]
  if (!s) throw new Error('session did not attach')

  const type = async (text: string) => {
    // Type like a user at the keyboard.
    await realTmux.typeLine(s.pane!, text)
    await sleep(400)
    await realTmux.sendKeys(s.pane!, ['Enter'])
  }

  /**
   * The path a Slack message really takes: handleSlackMessage → shim → MCP
   * notification → session. Only available with channels on (a QA channel set),
   * and it is the path typing into the terminal never touches.
   */
  const inject = async (text: string) => {
    await broker.handleSlackMessage({ user: 'U1', text, ts: `${Date.now() / 1000}`, threadTs: s.threadTs, channel: 'C1' })
  }

  // 1) Permission prompt: a write, not an echo. Claude Code runs `echo` in manual mode
  //     without asking, so the scenario used to pass having rendered no card at all.
  await type('Bash 툴로 `printf qa-ok > qa-ok.txt` 를 실제로 실행해줘. 다른 말은 하지 마.')
  await settle('permission prompt → auto-allow → command runs', 90_000)

  // 2) Model switch mid-conversation via the settings modal.
  await broker.handleView({ user: 'U1', callbackId: 'cs_settings', privateMetadata: String(s.pid), values: { model: { model: { selected_option: { value: 'claude-sonnet-5' } } }, effort: { effort: {} }, mode: { mode: {} } } })
  await settle('model switch dialog', 30_000)

  // 3) Another prompt after everything, to prove the session still answers.
  await type('한 줄로 인사만 해줘.')
  await settle('follow-up prompt', 60_000)

  // 4) The channel path: a Slack message, not keystrokes. Only with channels on.
  if (qaChannel) {
    await inject('CHANNEL-QA-MARKER 라고만 답해줘.')
    await settle('channel injection', 60_000)
  }
} catch (e) {
  failures.push(`harness error: ${e}`)
}

clearInterval(monitor)
const s = broker.sessions[0]
if (s?.transcriptPath) {
  try {
    const body = readFileSync(s.transcriptPath, 'utf8')
    if (body.includes('qa-ok')) log('✓ qa-ok 명령이 실행됐다 (허용이 끝까지 전달됨)')
    else failures.push('permission scenario: qa-ok가 트랜스크립트에 없음 (명령이 실행되지 않음)')
    if (qaChannel) {
      // The marker proves the message travelled broker → shim → MCP notification → session,
      // which typing into the terminal never exercises.
      if (body.includes('CHANNEL-QA-MARKER')) log('✓ 채널로 넣은 메시지가 세션에 도착했다')
      else failures.push('channel injection: 메시지가 세션에 도착하지 않음 (broker → shim → MCP 경로)')
    }
  } catch (e) {
    failures.push(`transcript read failed: ${e}`)
  }
}
for (const f of blockFailures) failures.push(f)
// A green run that rendered nothing is not a pass: the cards are what is being tested.
if (qaChannel && !rendered.permission) {
  failures.push('권한 카드가 한 번도 그려지지 않았다 — 릴레이가 붙지 않았거나 명령이 승인 없이 실행됐다. 시나리오가 스스로를 검증하지 못한다')
}
log(`렌더된 카드: 권한 ${rendered.permission} · 다이얼로그 ${rendered.dialog}`)
try {
  const { unlinkSync } = await import('node:fs')
  unlinkSync(resolve(cwd, 'qa-ok.txt'))
} catch {}
if (s?.pane) {
  log('--- final terminal screen ---')
  console.log((await realTmux.capture(s.pane)).replace(/\s+$/, '').split('\n').slice(-8).join('\n'))
  await realTmux.killPane(s.pane).catch(() => {})
}
server.close()
console.log('\n=== QA SWEEP RESULT ===')
if (!failures.length) console.log('✅ PASS — no session got stuck; every dialog was surfaced or handled.')
else {
  console.log(`❌ ${failures.length} issue(s):`)
  for (const f of failures) console.log(`\n- ${f}`)
}
setTimeout(() => process.exit(failures.length ? 1 : 0), 1500)

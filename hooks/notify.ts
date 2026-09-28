/**
 * Claude Code hook. Forwards the hook payload to the broker and exits.
 * Never blocks the session: any failure is swallowed and we exit 0.
 *
 * It does leave a line in ~/.claude-slack/logs/hook.log, because "the hook
 * could not reach the broker" used to vanish without a trace, and that is the
 * first thing to check when a thread goes quiet. CLAUDE_SLACK_HOOK_LOG=0 turns
 * the file off; CLAUDE_SLACK_HOOK_LOG=<path> moves it.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { connect } from '../src/ipc.ts'
import { sessionKey, SOCKET_PATH } from '../src/protocol.ts'

if (!process.env.CLAUDE_SLACK) process.exit(0)

const HOOK_LOG = process.env.CLAUDE_SLACK_HOOK_LOG === '0' ? undefined : process.env.CLAUDE_SLACK_HOOK_LOG || join(process.env.CLAUDE_SLACK_LOG_DIR ?? join(homedir(), '.claude-slack', 'logs'), 'hook.log')
const HOOK_LOG_MAX = 5 * 1024 * 1024

function stamp(): string {
  const d = new Date()
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

function hookLog(level: 'INFO' | 'WARN', msg: string): void {
  if (!HOOK_LOG) return
  try {
    mkdirSync(dirname(HOOK_LOG), { recursive: true })
    try {
      if (statSync(HOOK_LOG).size > HOOK_LOG_MAX) renameSync(HOOK_LOG, `${HOOK_LOG}.1`)
    } catch {}
    appendFileSync(HOOK_LOG, `${stamp()} [${level}] ${msg}\n`)
  } catch {}
}

/**
 * The session's pid. Claude Code sets CLAUDE_PID for hooks; if it is missing,
 * walk up the process tree (hook → sh → claude) to the nearest claude process.
 */
function findClaudePid(): number {
  // If the walk runs out without finding claude, fall back to the direct parent
  // rather than the last ancestor we looked at: the shell that ran the hook is
  // at least a real, related process, while a distant ancestor (launchd, tmux)
  // would key the session to something unrelated.
  if (process.env.CLAUDE_PID) return Number(process.env.CLAUDE_PID)
  let pid = process.ppid
  for (let i = 0; i < 6 && pid > 1; i++) {
    let line: string
    try {
      line = execFileSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { encoding: 'utf8' }).trim()
    } catch {
      break
    }
    const [ppid, ...comm] = line.split(/\s+/)
    if (/claude/i.test(comm.join(' '))) return pid
    pid = Number(ppid)
  }
  return process.ppid
}

const timer = setTimeout(() => {
  hookLog('WARN', `timed out after 3s (broker not answering?) key=${sessionKey(findClaudePid())}`)
  process.exit(0)
}, 3000)
timer.unref()

let raw = ''
process.stdin.setEncoding('utf8')
for await (const piece of process.stdin) raw += piece

let event: { hook_event_name?: string; session_id?: string; tool_name?: string } = {}
try {
  event = JSON.parse(raw)
} catch (err) {
  hookLog('WARN', `bad payload (${String(err).slice(0, 80)}): ${raw.slice(0, 120).replace(/\s+/g, ' ')}`)
  process.exit(0)
}
const pid = findClaudePid()
const key = sessionKey(pid)
const what = `${event.hook_event_name ?? '?'} s=${String(event.session_id ?? '').slice(0, 8)} key=${key.slice(0, 8)}${event.tool_name ? ` tool=${event.tool_name}` : ''}`
try {
  const conn = await connect(SOCKET_PATH, 1500)
  conn.send({ type: 'hook', key, pid, event })
  await new Promise<void>((resolve) => conn.socket.end(resolve))
  // Only failures and the events that matter for "did it reach the broker" are kept; PostToolUse is most of the traffic.
  if (event.hook_event_name !== 'PostToolUse' || process.env.CLAUDE_SLACK_HOOK_LOG_VERBOSE) hookLog('INFO', `${what} → sent`)
} catch (err) {
  const e = err as { code?: string; message?: string }
  const why = e?.code === 'ENOENT' || e?.code === 'ECONNREFUSED' ? `broker not running (${SOCKET_PATH})` : /timeout/i.test(String(e?.message)) ? 'broker did not accept the connection in 1.5s' : String(e?.message ?? err).slice(0, 120)
  hookLog('WARN', `${what} → not delivered: ${why}`)
}
process.exit(0)

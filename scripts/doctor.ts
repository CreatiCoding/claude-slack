/**
 * Diagnose (and, with a subcommand, fix) the broker without digging through tmux and ps by hand.
 *
 *   node scripts/doctor.ts              diagnosis only, changes nothing
 *   node scripts/doctor.ts restart      restart the broker the way launchd does, wait for it to answer
 *   node scripts/doctor.ts dedupe [--yes]  kill the newer of each pair of Claude processes sharing a run
 *   node scripts/doctor.ts logs [n]     the last n lines of the log, any level (default 60)
 *
 * Each diagnosis line that points at a problem is followed by a `→` suggesting what to run next.
 */
import { execFile } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { promisify } from 'node:util'
import { existsSync, statSync } from 'node:fs'
import { SOCKET_PATH } from '../src/protocol.ts'
import { connect } from '../src/ipc.ts'
import { DEFAULT_LOG_DIR, tailLog } from '../src/log.ts'
import { TMUX_SESSION } from '../src/tmux.ts'
import { join } from 'node:path'

const execFileP = promisify(execFile)
const sh = async (cmd: string, args: string[]): Promise<string> => {
  try {
    return (await execFileP(cmd, args, { maxBuffer: 8 * 1024 * 1024 })).stdout
  } catch {
    return ''
  }
}
const say = (line: string, hint?: string) => console.log(hint ? `${line}\n  → ${hint}` : line)
const durationSince = (ms: number) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return `${s}초`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}분`
  return `${Math.floor(m / 60)}시간 ${m % 60}분`
}

async function socketAnswers(): Promise<boolean> {
  try {
    const conn = await connect(SOCKET_PATH, 1000)
    conn.close()
    return true
  } catch {
    return false
  }
}

/** `ps` doesn't give a process's own start time in epoch ms directly on macOS; `lstart` parses to one. */
async function brokerProcess(): Promise<{ pid: number; startedAt?: number } | undefined> {
  const out = await sh('pgrep', ['-f', 'node --env-file=.env src/index.ts'])
  const pid = Number(out.trim().split('\n')[0])
  if (!pid) return undefined
  const lstart = (await sh('ps', ['-o', 'lstart=', '-p', String(pid)])).trim()
  const startedAt = lstart ? Date.parse(lstart) : undefined
  return { pid, startedAt: Number.isNaN(startedAt) ? undefined : startedAt }
}

interface ClaudeProc {
  pid: number
  startedAt?: number
  key?: string
  threadTs?: string
}

/**
 * A `ps eww -A -o pid=,lstart=,command=` line, parsed as a claude-slack-run Claude process, or undefined.
 * The env vars `ps eww` prints are inherited by every child the `claude` process spawns (a bash shell, an
 * MCP server, a subagent's own process), which would otherwise all count as separate "Claude processes";
 * and "claude-slack" in a cwd path matches a looser `\bclaude\b`. Only a line whose command actually
 * invokes the `claude` binary (the word "claude" on its own, not immediately followed by "-slack" or
 * another word character) counts.
 */
export function parseClaudeProcessLine(line: string): Omit<ClaudeProc, 'startedAt'> | undefined {
  if (!/CLAUDE_SLACK_SESSION=|CLAUDE_SLACK_THREAD_TS=/.test(line)) return undefined
  if (!/(^|[\s/])claude(\s|$)/.test(line)) return undefined
  const pidMatch = /^\s*(\d+)/.exec(line)
  if (!pidMatch) return undefined
  const key = /CLAUDE_SLACK_SESSION=(\S+)/.exec(line)?.[1]
  const threadTs = /CLAUDE_SLACK_THREAD_TS=(\S+)/.exec(line)?.[1]
  return { pid: Number(pidMatch[1]), key, threadTs }
}

/** Every `claude` process and the run-identifying env vars from its environment (`ps eww`, macOS-only flag). */
async function claudeProcesses(): Promise<ClaudeProc[]> {
  const out = await sh('ps', ['eww', '-A', '-o', 'pid=,lstart=,command='])
  const procs: ClaudeProc[] = out.split('\n').map(parseClaudeProcessLine).filter((p): p is ClaudeProc => !!p)
  for (const p of procs) {
    const lstart = (await sh('ps', ['-o', 'lstart=', '-p', String(p.pid)])).trim()
    const t = lstart ? Date.parse(lstart) : NaN
    if (!Number.isNaN(t)) p.startedAt = t
  }
  return procs
}

async function diagnose(): Promise<void> {
  console.log('=== claude-slack 진단 ===\n')

  const broker = await brokerProcess()
  const answering = await socketAnswers()
  if (broker) {
    say(`브로커: pid ${broker.pid}, 켜진 지 ${broker.startedAt ? durationSince(broker.startedAt) : '알 수 없음'}`)
  } else {
    say('브로커: 떠 있지 않음', 'node scripts/doctor.ts restart')
  }
  if (existsSync(SOCKET_PATH)) {
    say(answering ? '소켓: 응답함' : '소켓: 파일은 있지만 응답 없음 (죽은 흔적)', answering ? undefined : 'node scripts/doctor.ts restart')
  } else {
    say('소켓: 파일 없음', broker ? '브로커가 아직 뜨는 중일 수 있습니다. 잠시 뒤 다시 확인하세요.' : 'node scripts/doctor.ts restart')
  }

  const windows = (await sh('tmux', ['list-windows', '-t', TMUX_SESSION])).trim()
  const windowCount = windows ? windows.split('\n').length : 0
  say(`tmux 창: ${windowCount}개(세션 \`${TMUX_SESSION}\`)`)

  const procs = await claudeProcesses()
  const byGroup = new Map<string, ClaudeProc[]>()
  for (const p of procs) {
    const k = p.key ?? p.threadTs
    if (!k) continue
    if (!byGroup.has(k)) byGroup.set(k, [])
    byGroup.get(k)!.push(p)
  }
  const dupes = [...byGroup.entries()].filter(([, list]) => list.length > 1)
  if (!dupes.length) {
    say('중복 프로세스: 없음')
  } else {
    say(`중복 프로세스: ${dupes.length}개의 실행이 Claude 를 둘 이상 띄우고 있음`, 'node scripts/doctor.ts dedupe')
    for (const [key, list] of dupes) {
      console.log(`  ${key}:`)
      for (const p of list.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))) {
        console.log(`    pid ${p.pid}, 켜진 지 ${p.startedAt ? durationSince(p.startedAt) : '알 수 없음'}`)
      }
    }
  }

  const logFile = join(DEFAULT_LOG_DIR, 'broker.log')
  let attachesInLastMinute = 0
  if (existsSync(logFile)) {
    const recent = tailLog(logFile, 5000)
    const cutoff = Date.now() - 60_000
    for (const line of recent) {
      const m = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/.exec(line)
      const t = m ? Date.parse(m[1]!.replace(' ', 'T')) : NaN
      if (!Number.isNaN(t) && t >= cutoff && line.includes('[session] attached')) attachesInLastMinute++
    }
    say(`최근 60초 동안 attach: ${attachesInLastMinute}회`, attachesInLastMinute > 40 ? '연결이 되풀이되는 루프로 보입니다. node scripts/doctor.ts dedupe 로 중복을 확인하세요.' : undefined)

    const problems = tailLog(logFile, 2000, { minLevel: 'WARN' }).slice(-5)
    say(`최근 WARN/ERROR ${problems.length}줄:`)
    for (const line of problems) console.log(`  ${line}`)
  } else {
    say('로그 파일 없음 (브로커가 한 번도 안 떴을 수 있습니다)')
  }

  const diskMtime = existsSync(SOCKET_PATH) ? statSync(SOCKET_PATH).mtimeMs : undefined
  void diskMtime
}

async function restart(): Promise<void> {
  console.log('재시작: tmux 세션을 끝내 launchd(KeepAlive)가 다시 띄우게 합니다. Claude 세션 자체는 건드리지 않습니다.')
  await sh('tmux', ['kill-session', '-t', 'claude-slack-broker'])
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (await socketAnswers()) {
      console.log(`소켓이 응답합니다 (${Math.round((20_000 - (deadline - Date.now())) / 1000)}초 걸림).`)
      return
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  console.log('20초 안에 응답하지 않았습니다. launchd 상태를 확인하세요: launchctl list | grep claude-slack')
}

// Claude processes (not brokers) that share one run: the newer one stays, the older is closed (60).
async function dedupe(autoYes: boolean): Promise<void> {
  const procs = await claudeProcesses()
  const byGroup = new Map<string, ClaudeProc[]>()
  for (const p of procs) {
    const k = p.key ?? p.threadTs
    if (!k) continue
    if (!byGroup.has(k)) byGroup.set(k, [])
    byGroup.get(k)!.push(p)
  }
  const dupes = [...byGroup.entries()].filter(([, list]) => list.length > 1)
  if (!dupes.length) {
    console.log('중복이 없습니다.')
    return
  }
  const panes = (await sh('tmux', ['list-panes', '-a', '-F', '#{pane_pid} #{pane_id}']))
    .trim()
    .split('\n')
    .map((l) => l.split(' '))
    .filter((parts) => parts.length === 2)
    .map(([pid, pane]) => ({ pid: Number(pid), pane: pane! }))
  for (const [key, list] of dupes) {
    // The one started last stays (60): the page and the Slack channel wait on the newer broker, which took the
    // socket and the channel shim after the older one was already up; closing the newer one left them with nothing.
    const sorted = [...list].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
    const keep = sorted[0]!
    const kill = sorted.slice(1)
    console.log(`${key}: ${sorted.length}개 — 가장 나중에 뜬 pid ${keep.pid} 만 남깁니다.`)
    for (const p of kill) {
      const pane = panes.find((x) => x.pid === p.pid)?.pane
      if (!pane) {
        console.log(`  pid ${p.pid}: tmux pane 을 못 찾았습니다(건너뜀)`)
        continue
      }
      if (!autoYes) {
        const rl = createInterface({ input: process.stdin, output: process.stdout })
        const ans = (await rl.question(`  pid ${p.pid} (pane ${pane}) 를 끌까요? [y/N] `)).trim().toLowerCase()
        rl.close()
        if (ans !== 'y' && ans !== 'yes') {
          console.log('  건너뜀')
          continue
        }
      }
      await sh('tmux', ['kill-pane', '-t', pane])
      console.log(`  pid ${p.pid} (pane ${pane}) 를 껐습니다.`)
    }
  }
}

// Guarded so `test/doctor.test.ts` can import the pure helpers above without shelling out to ps/tmux
// and printing a live diagnosis as a side effect of the import.
if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, ...rest] = process.argv.slice(2)
  if (!cmd) await diagnose()
  else if (cmd === 'restart') await restart()
  else if (cmd === 'dedupe') await dedupe(rest.includes('--yes'))
  else if (cmd === 'logs') {
    // The end of the log, any level (60): a WARN-only view hid what came just before it (60).
    const n = Number(rest[0]) || 60
    const logFile = join(DEFAULT_LOG_DIR, 'broker.log')
    for (const line of tailLog(logFile, n)) console.log(line)
  } else {
    console.log(`사용법: node scripts/doctor.ts [restart|dedupe [--yes]|logs [n]]`)
    process.exit(1)
  }
}

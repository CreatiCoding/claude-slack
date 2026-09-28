/**
 * One log line per event, in a form that can be grepped by thread.
 *
 *   14:52:31.208 [INFO] [inject] held while a tool runs t=1790052852.118929 s=671111e3 p=claude-controller n=1
 *
 * The old log had no clock and no thread, so the afternoon a message kept
 * cutting a running command could not be reconstructed from it. Every line now
 * carries the local time, a level, the area of the code that wrote it, and —
 * whenever a session is involved — `t=<thread ts> s=<session id prefix>
 * p=<project>` so `grep t=1790052852` pulls one thread's whole history.
 *
 * The file rotates in-process: the broker runs under launchd for weeks, and a
 * check that only happened at startup let the file grow without bound.
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type Level = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'
export type Fields = Record<string, string | number | boolean | undefined | null>

export const DEFAULT_LOG_DIR = process.env.CLAUDE_SLACK_LOG_DIR ?? join(homedir(), '.claude-slack', 'logs')
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024
/** Checking the size on every line is a stat per line; every N lines is plenty. */
const SIZE_CHECK_EVERY = 200

const LEVEL_RANK: Record<Level, number> = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 }

export interface LoggerOptions {
  /** File to append to. Omit for stderr only (tests). */
  file?: string
  maxBytes?: number
  /** Lines below this level are dropped. DEBUG is where the hook chatter goes. */
  minLevel?: Level
  /** Also write to stderr, which under launchd is the tmux pane a person can attach to. */
  stderr?: boolean
  now?: () => Date
}

export interface Logger {
  (msg: string, fields?: Fields): void
  debug(area: string, msg: string, fields?: Fields): void
  info(area: string, msg: string, fields?: Fields): void
  warn(area: string, msg: string, fields?: Fields): void
  error(area: string, msg: string, fields?: Fields): void
  at(level: Level, area: string, msg: string, fields?: Fields): void
  /** Where lines go, for `claude-slack logs` and the admin page. */
  readonly file?: string
}

/** `HH:MM:SS.mmm` in local time; the phone and the terminal both show local time. */
export function stamp(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

/** A date prefix once per day would be nicer to read, but `sort` and `grep` prefer every line to carry it. */
function dayStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function formatFields(fields?: Fields): string {
  if (!fields) return ''
  const parts: string[] = []
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || v === '') continue
    const s = String(v)
    // Quote only what needs it, so the common `t=… s=… p=…` stays greppable as-is.
    parts.push(/[\s"=]/.test(s) ? `${k}=${JSON.stringify(s)}` : `${k}=${s}`)
  }
  return parts.length ? ' ' + parts.join(' ') : ''
}

export function formatLine(now: Date, level: Level, area: string, msg: string, fields?: Fields): string {
  return `${dayStamp(now)} ${stamp(now)} [${level}] [${area}] ${msg.replace(/\n/g, '\\n')}${formatFields(fields)}`
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const minRank = LEVEL_RANK[opts.minLevel ?? 'INFO']
  const now = opts.now ?? (() => new Date())
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  let linesSinceCheck = 0
  let fileBroken = false

  const rotateIfNeeded = () => {
    if (!opts.file) return
    if (++linesSinceCheck < SIZE_CHECK_EVERY) return
    linesSinceCheck = 0
    try {
      if (statSync(opts.file).size > maxBytes) renameSync(opts.file, `${opts.file}.1`)
    } catch {
      // Missing file: nothing to rotate.
    }
  }

  const write = (level: Level, area: string, msg: string, fields?: Fields) => {
    if (LEVEL_RANK[level] < minRank) return
    const line = formatLine(now(), level, area, msg, fields)
    if (opts.stderr ?? true) process.stderr.write(line + '\n')
    if (!opts.file || fileBroken) return
    try {
      rotateIfNeeded()
      appendFileSync(opts.file, line + '\n')
    } catch (err) {
      // Say it once on stderr and carry on: a log that cannot be written must not take the broker down.
      fileBroken = true
      process.stderr.write(`[log] cannot write ${opts.file}: ${String(err)}\n`)
    }
  }

  if (opts.file) {
    try {
      mkdirSync(dirname(opts.file), { recursive: true })
    } catch {}
  }

  const fn = ((msg: string, fields?: Fields) => write('INFO', 'broker', msg, fields)) as Logger
  fn.debug = (area, msg, fields) => write('DEBUG', area, msg, fields)
  fn.info = (area, msg, fields) => write('INFO', area, msg, fields)
  fn.warn = (area, msg, fields) => write('WARN', area, msg, fields)
  fn.error = (area, msg, fields) => write('ERROR', area, msg, fields)
  fn.at = write
  Object.defineProperty(fn, 'file', { value: opts.file, enumerable: true })
  return fn
}

/** A logger that says nothing: the default for library code and tests. */
export const silentLogger: Logger = createLogger({ stderr: false, minLevel: 'ERROR' })
// Even ERROR lines would reach stderr without this; tests want silence.
Object.assign(silentLogger, { at: () => {}, error: () => {}, warn: () => {}, info: () => {}, debug: () => {} })

/**
 * Tail a log file in memory: the last `n` lines, optionally only those about
 * one thread. Reads the whole file, which at the 5MB rotation cap is fine.
 */
export function tailLog(file: string, n = 50, filter?: { thread?: string; minLevel?: Level; area?: string }): string[] {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  let lines = text.split('\n').filter(Boolean)
  if (filter?.thread) lines = lines.filter((l) => l.includes(`t=${filter.thread}`))
  if (filter?.area) lines = lines.filter((l) => l.includes(`[${filter.area}]`))
  if (filter?.minLevel) {
    const min = LEVEL_RANK[filter.minLevel]
    lines = lines.filter((l) => {
      const m = /\[(DEBUG|INFO|WARN|ERROR)\]/.exec(l)
      return m ? LEVEL_RANK[m[1] as Level] >= min : true
    })
  }
  return lines.slice(-n)
}

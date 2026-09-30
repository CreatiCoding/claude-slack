/**
 * Background work a Claude process started and has not finished: background shell commands, commands moved
 * to the background, Monitors, async agents. A refresh ends the process, and all of these die with it; the
 * person should know before, and the relaunched session should be told after.
 *
 * Read from the conversation file (jsonl). A start is a tool result whose first line is one of Claude Code's
 * own phrases (only the first line: a command's output may print the same words). An end is a
 * <task-notification> for the same tool-use id with a status other than running, a TaskStop naming the task,
 * or, for a Monitor, its timeout passing.
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { execFile } from 'node:child_process'

export interface BackgroundTask {
  toolUseId: string
  /** Claude Code's own id (bash / monitor task id, agent id). */
  id?: string
  kind: 'bash' | 'monitor' | 'agent'
  /** What it is: the command, or the agent's description. */
  label: string
  startedAt: number
  /** A Monitor stops on its own at this time. */
  expiresAt?: number
}

/** On first read, only the end of a long conversation file. */
const FIRST_READ_BYTES = 16 * 1024 * 1024
/** A Monitor without timeout_ms stops after the tool's default. */
const MONITOR_DEFAULT_MS = 300_000

const STARTS: Array<{ re: RegExp; kind: BackgroundTask['kind'] }> = [
  { re: /^Command running in background with ID: (\S+?)\.?(?:\s|$)/, kind: 'bash' },
  // "Command did not complete within its 120s timeout and was moved to the background (ID: …)"
  { re: /^Command [^\n]{0,120}?moved to the background \(ID: ([^)]+)\)/, kind: 'bash' },
  { re: /^Monitor started \(task (\S+?),/, kind: 'monitor' },
  { re: /^Async agent launched/, kind: 'agent' },
]

type Block = { type?: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; content?: unknown; text?: string }

const textOf = (content: unknown): string =>
  typeof content === 'string' ? content : Array.isArray(content) ? (content as Block[]).map((c) => (c.type === 'text' ? String(c.text ?? '') : '')).join('\n') : ''

export class BackgroundTracker {
  private path: string
  private offset = -1
  private rest = ''
  private started = false
  /** Only a name tag per tool call still waiting for its result (never the input: a Write carries whole files). */
  private uses = new Map<string, { name: string; label: string; timeoutMs?: number; taskId?: string }>()
  private tasks = new Map<string, BackgroundTask>()

  constructor(path: string) {
    this.path = path
  }

  /** Read what was added to the file since the last time. */
  scan(): void {
    let size: number
    try {
      size = statSync(this.path).size
    } catch {
      return
    }
    if (this.offset < 0) this.offset = Math.max(0, size - FIRST_READ_BYTES)
    if (size < this.offset) {
      // Rewritten from the start: read it again.
      this.offset = 0
      this.rest = ''
    }
    if (size === this.offset) {
      this.started = true
      return
    }
    const fd = openSync(this.path, 'r')
    let chunk = ''
    try {
      const buf = Buffer.alloc(size - this.offset)
      readSync(fd, buf, 0, buf.length, this.offset)
      chunk = buf.toString('utf8')
    } finally {
      closeSync(fd)
    }
    // Only the very first read can start mid-file (the last 16MB of a long file); a flag, not a guess.
    const firstRead = !this.started && this.offset > 0
    this.started = true
    this.offset = size
    const lines = (this.rest + chunk).split('\n')
    this.rest = lines.pop() ?? ''
    // Started mid-file: the first piece is the tail of a line we did not read.
    if (firstRead) lines.shift()
    for (const line of lines) if (line) this.line(line)
  }

  private line(line: string): void {
    let entry: { type?: string; timestamp?: string; message?: { content?: unknown } }
    try {
      entry = JSON.parse(line)
    } catch {
      return
    }
    const at = Date.parse(entry.timestamp ?? '') || 0
    const content = entry.message?.content
    if (entry.type === 'assistant' && Array.isArray(content)) {
      for (const b of content as Block[]) {
        if (b.type !== 'tool_use' || !b.id) continue
        const input = b.input ?? {}
        this.uses.set(b.id, {
          name: String(b.name ?? ''),
          label: String(input.description ?? input.command ?? input.prompt ?? b.name ?? '').replace(/\s+/g, ' ').slice(0, 120),
          ...(typeof input.timeout_ms === 'number' ? { timeoutMs: input.timeout_ms } : {}),
          ...(b.name === 'TaskStop' ? { taskId: String(input.task_id ?? input.shell_id ?? '') } : {}),
        })
      }
      return
    }
    if (entry.type !== 'user') return
    this.notifications(textOf(content))
    if (!Array.isArray(content)) return
    for (const b of content as Block[] & Array<{ is_error?: boolean }>) {
      if (b.type === 'text') continue
      if (b.type !== 'tool_result' || !b.tool_use_id) continue
      const use = this.uses.get(b.tool_use_id)
      // The result is in: the tag is no longer needed.
      this.uses.delete(b.tool_use_id)
      const text = textOf(b.content)
      // A TaskStop ends its task only when it worked.
      if (use?.name === 'TaskStop') {
        if (!(b as { is_error?: boolean }).is_error && !/no task|not found|failed/i.test(text)) for (const [k, t] of this.tasks) if (t.id === use.taskId) this.tasks.delete(k)
        continue
      }
      const first = text.split('\n')[0]!.slice(0, 400)
      const start = STARTS.find((s) => s.re.test(first))
      if (!start) continue
      const id = start.re.exec(first)?.[1] ?? /agentId: (\w+)/.exec(text)?.[1]
      const timeout = use?.timeoutMs ?? MONITOR_DEFAULT_MS
      const label = use?.label || start.kind
      this.tasks.set(b.tool_use_id, { toolUseId: b.tool_use_id, ...(id ? { id } : {}), kind: start.kind, label, startedAt: at, ...(start.kind === 'monitor' && at ? { expiresAt: at + timeout } : {}) })
    }
  }

  /** <task-notification> blocks in a message: a status other than "running" ends that tool use's task. */
  private notifications(text: string): void {
    if (!text.includes('<task-notification>')) return
    for (const m of text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
      const body = m[1]!
      const use = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(body)?.[1]
      const taskId = /<task-id>([^<]+)<\/task-id>/.exec(body)?.[1]
      const status = /<status>([^<]+)<\/status>/.exec(body)?.[1]?.trim()
      if (!status || status === 'running') continue
      // By the tool-use id first; a notice without one names the task.
      if (use && this.tasks.has(use)) this.tasks.delete(use)
      else if (taskId) for (const [k, t] of this.tasks) if (t.id === taskId) this.tasks.delete(k)
    }
  }

  /**
   * What is still running for the process started at `processStart`: older tasks died with an earlier process.
   * A notification can come late, so shell tasks are cut to the number of shells the process really has open,
   * newest first.
   */
  open(o: { now: number; processStart?: number; shells?: number }): BackgroundTask[] {
    let list = [...this.tasks.values()].filter((t) => (!o.processStart || t.startedAt >= o.processStart) && !(t.expiresAt && t.expiresAt <= o.now))
    if (o.shells !== undefined) {
      const shellTasks = list.filter((t) => t.kind !== 'agent').sort((a, b) => b.startedAt - a.startedAt)
      const keep = new Set(shellTasks.slice(0, o.shells))
      list = list.filter((t) => t.kind === 'agent' || keep.has(t))
    }
    return list.sort((a, b) => a.startedAt - b.startedAt)
  }
}

/** Shells (bash, zsh, sh started with -c) that are children of `pid`, from `ps -A -o ppid=,command=`. Claude Code runs commands in $SHELL, zsh on a Mac. */
export function countShells(ps: string, pid: number): number {
  return ps
    .split('\n')
    .map((l) => /^\s*(\d+)\s+(.*)$/.exec(l))
    .filter((m) => m && Number(m[1]) === pid && /^(\S*\/)?(ba|z)?sh -c /.test(m[2]!)).length
}

/**
 * When a process started (ps -o lstart), and how many shells it has open. ps runs with LC_ALL=C: lstart follows
 * the locale, and a Korean date cannot be parsed.
 */
export function processFacts(pid: number, ps = 'ps'): Promise<{ startedAt?: number; shells?: number }> {
  const env = { ...process.env, LC_ALL: 'C', LANG: 'C' }
  const run = (args: string[]) => new Promise<string>((resolve) => execFile(ps, args, { timeout: 5000, env }, (err, out) => resolve(err ? '' : out)))
  return Promise.all([run(['-o', 'lstart=', '-p', String(pid)]), run(['-A', '-o', 'ppid=,command='])]).then(([lstart, all]) => {
    const startedAt = Date.parse(lstart.trim()) || undefined
    return { ...(startedAt ? { startedAt } : {}), ...(all ? { shells: countShells(all, pid) } : {}) }
  })
}

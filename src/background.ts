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

const STARTS: Array<{ re: RegExp; kind: BackgroundTask['kind'] }> = [
  { re: /^Command running in background with ID: (\S+?)\.?(?:\s|$)/, kind: 'bash' },
  { re: /moved to the background \(ID: ([^)]+)\)/, kind: 'bash' },
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
  private uses = new Map<string, { name: string; input: Record<string, unknown> }>()
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
    if (size === this.offset) return
    const fd = openSync(this.path, 'r')
    let chunk = ''
    try {
      const buf = Buffer.alloc(size - this.offset)
      readSync(fd, buf, 0, buf.length, this.offset)
      chunk = buf.toString('utf8')
    } finally {
      closeSync(fd)
    }
    const firstRead = this.rest === '' && this.offset > 0 && this.uses.size === 0 && this.tasks.size === 0
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
        this.uses.set(b.id, { name: String(b.name ?? ''), input: b.input ?? {} })
        if (b.name === 'TaskStop') {
          const id = String(b.input?.task_id ?? b.input?.shell_id ?? '')
          for (const [k, t] of this.tasks) if (t.id === id) this.tasks.delete(k)
        }
      }
      return
    }
    if (entry.type !== 'user') return
    this.notifications(textOf(content))
    if (!Array.isArray(content)) return
    for (const b of content as Block[]) {
      if (b.type === 'text') continue
      if (b.type !== 'tool_result' || !b.tool_use_id) continue
      const first = textOf(b.content).split('\n')[0]!.slice(0, 400)
      const start = STARTS.find((s) => s.re.test(first))
      if (!start) continue
      const use = this.uses.get(b.tool_use_id)
      const input = use?.input ?? {}
      const id = start.re.exec(first)?.[1] ?? /agentId: (\w+)/.exec(textOf(b.content))?.[1]
      const minutes = /expires in (\d+)m/.exec(first)?.[1]
      const timeout = typeof input.timeout_ms === 'number' ? input.timeout_ms : minutes ? Number(minutes) * 60_000 : undefined
      const label = String(input.description ?? input.command ?? input.prompt ?? use?.name ?? start.kind).replace(/\s+/g, ' ').slice(0, 120)
      this.tasks.set(b.tool_use_id, { toolUseId: b.tool_use_id, ...(id ? { id } : {}), kind: start.kind, label, startedAt: at, ...(start.kind === 'monitor' && timeout && at ? { expiresAt: at + timeout } : {}) })
    }
  }

  /** <task-notification> blocks in a message: a status other than "running" ends that tool use's task. */
  private notifications(text: string): void {
    if (!text.includes('<task-notification>')) return
    for (const m of text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
      const body = m[1]!
      const use = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(body)?.[1]
      const status = /<status>([^<]+)<\/status>/.exec(body)?.[1]?.trim()
      if (use && status && status !== 'running') this.tasks.delete(use)
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

/** When a process started (ps -o lstart), and how many `/bin/bash -c` children it has open. */
export function processFacts(pid: number): Promise<{ startedAt?: number; shells?: number }> {
  const run = (args: string[]) =>
    new Promise<string>((resolve) => execFile('ps', args, { timeout: 5000 }, (err, out) => resolve(err ? '' : out)))
  return Promise.all([run(['-o', 'lstart=', '-p', String(pid)]), run(['-A', '-o', 'ppid=,command='])]).then(([lstart, all]) => {
    const startedAt = Date.parse(lstart.trim()) || undefined
    const shells = all
      .split('\n')
      .map((l) => /^\s*(\d+)\s+(.*)$/.exec(l))
      .filter((m) => m && Number(m[1]) === pid && m[2]!.startsWith('/bin/bash -c')).length
    return { ...(startedAt ? { startedAt } : {}), ...(all ? { shells } : {}) }
  })
}

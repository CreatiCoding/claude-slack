/**
 * Which version of the user's own plugins a session really runs. Plugins are read when the Claude process
 * starts, so "installed now" and "this session uses" differ after an update until the session is refreshed.
 *
 * Only marketplaces of the user's own account (its git path has the user name). A marketplace split into
 * several per-skill plugins is one line, named after the marketplace; its version is that of the plugin
 * named like the marketplace (the bundle) when there is one. Any plugin in it being newer marks the line.
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'

export interface PluginLine {
  market: string
  /** What the session runs. */
  version: string
  /** Installed and newer than what the session runs: a refresh would bring it. */
  latest?: string
}

interface Version {
  version: string
  /** When it appeared in the cache. */
  at: number
}

/** The user's own marketplaces: those whose git address has the user name in its path. */
export function userMarkets(pluginsDir: string, user: string): string[] {
  try {
    const known = JSON.parse(readFileSync(join(pluginsDir, 'known_marketplaces.json'), 'utf8')) as Record<string, { source?: { repo?: string; url?: string } }>
    const me = user.toLowerCase()
    return Object.entries(known)
      .filter(([, v]) => {
        const where = String(v.source?.repo ?? v.source?.url ?? '').toLowerCase()
        return where.split(/[/:]/).includes(me)
      })
      .map(([k]) => k)
  } catch {
    return []
  }
}

function versions(pluginsDir: string, market: string, plugin: string): Version[] {
  const dir = join(pluginsDir, 'cache', market, plugin)
  try {
    return readdirSync(dir)
      .map((v) => {
        const st = statSync(join(dir, v))
        return { version: v, at: st.birthtimeMs || st.mtimeMs }
      })
      .sort((a, b) => a.at - b.at)
  } catch {
    return []
  }
}

/**
 * "Base directory for this skill: …/cache/<market>/<plugin>/<version>/" lines Claude Code itself wrote into the
 * conversation (a person's own message, not a tool's output), with when each was written. Read from where it was
 * left: the first time only the last 16MB, then what was added (a whole-file read every 30s was the old way).
 */
export class SkillLineReader {
  private path: string
  private offset = -1
  private rest = ''
  readonly seen = new Map<string, { version: string; at: number }>()

  constructor(path: string) {
    this.path = path
  }

  read(tailBytes = 16 * 1024 * 1024): Map<string, { version: string; at: number }> {
    let size: number
    try {
      size = statSync(this.path).size
    } catch {
      return this.seen
    }
    const first = this.offset < 0
    if (first) this.offset = Math.max(0, size - tailBytes)
    if (size < this.offset) {
      this.offset = 0
      this.rest = ''
    }
    if (size === this.offset) return this.seen
    const fd = openSync(this.path, 'r')
    let text = ''
    try {
      const buf = Buffer.alloc(size - this.offset)
      readSync(fd, buf, 0, buf.length, this.offset)
      text = buf.toString('utf8')
    } finally {
      closeSync(fd)
    }
    const startedMid = first && this.offset > 0
    this.offset = size
    const lines = (this.rest + text).split('\n')
    this.rest = lines.pop() ?? ''
    if (startedMid) lines.shift()
    for (const line of lines) {
      if (!line.includes('Base directory for this skill:')) continue
      let entry: { type?: string; timestamp?: string; message?: { content?: unknown } }
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }
      if (entry.type !== 'user') continue
      const c = entry.message?.content
      const own = typeof c === 'string' ? c : Array.isArray(c) ? (c as Array<{ type?: string; text?: string }>).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n') : ''
      const at = Date.parse(entry.timestamp ?? '') || 0
      for (const m of own.matchAll(/Base directory for this skill: \S*?\/cache\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\//g)) this.seen.set(`${m[1]}/${m[2]}`, { version: m[3]!, at })
    }
    return this.seen
  }
}

/** One line per user marketplace: the version this process runs, and a newer one when installed. */
export function sessionPlugins(o: { pluginsDir?: string; user: string | string[]; processStart?: number; transcript?: string; reader?: SkillLineReader }): PluginLine[] {
  const dir = o.pluginsDir ?? join(homedir(), '.claude', 'plugins')
  const reader = o.reader ?? (o.transcript && existsSync(o.transcript) ? new SkillLineReader(o.transcript) : undefined)
  const seen = reader?.read() ?? new Map<string, { version: string; at: number }>()
  const lines: PluginLine[] = []
  const users = Array.isArray(o.user) ? o.user : [o.user]
  const markets = [...new Set(users.flatMap((u) => userMarkets(dir, u)))]
  for (const market of markets) {
    let plugins: string[]
    try {
      plugins = readdirSync(join(dir, 'cache', market))
    } catch {
      continue
    }
    const per = plugins.map((plugin) => {
      const all = versions(dir, market, plugin)
      const before = o.processStart ? all.filter((v) => v.at <= o.processStart!) : all
      const fromCache = before.at(-1)?.version ?? all.at(-1)?.version
      // A skill line counts only if this process wrote it: --resume appends to the same file, so the old process's
      // lines are still there after a refresh. Of the line and the cache's pick, the newer version wins.
      const line = seen.get(`${market}/${plugin}`)
      const fromLine = line && (!o.processStart || line.at >= o.processStart) ? line.version : undefined
      const birth = (v?: string) => all.find((x) => x.version === v)?.at ?? -1
      const running = fromLine && birth(fromLine) > birth(fromCache) ? fromLine : fromCache ?? fromLine
      const newest = all.at(-1)?.version
      return { plugin, running, newest }
    })
    const bundle = per.find((p) => p.plugin === market) ?? (per.length === 1 ? per[0] : undefined)
    const shown = bundle ?? per.slice().sort((a, b) => String(a.running).localeCompare(String(b.running), undefined, { numeric: true })).at(-1)
    if (!shown?.running) continue
    const outdated = per.some((p) => p.newest && p.newest !== p.running)
    lines.push({ market, version: shown.running, ...(outdated ? { latest: shown.newest !== shown.running ? shown.newest : '최신' } : {}) })
  }
  return lines
}

/** Account names gh is logged in with, on every host ("Logged in to <host> account <name>"). Empty when gh cannot say. */
export function githubAccounts(gh = 'gh'): Promise<string[]> {
  return new Promise((resolve) =>
    execFile(gh, ['auth', 'status'], { timeout: 8000 }, (_err, out, errOut) => {
      const text = `${out ?? ''}\n${errOut ?? ''}`
      resolve([...new Set([...text.matchAll(/Logged in to \S+ account (\S+)/g)].map((m) => m[1]!))])
    }),
  )
}

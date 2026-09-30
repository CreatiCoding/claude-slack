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

interface Member {
  plugin: string
  /** What installed_plugins.json points at: what a refresh would load. */
  version: string
  /** When that pointer last changed, and when the plugin first came. */
  lastUpdated: number
  installedAt: number
}

/** What installed_plugins.json says for a marketplace's plugins; without it, the cache folders (newest = installed). */
function members(dir: string, market: string, cacheFor: (plugin: string) => Version[]): Member[] {
  try {
    const all = JSON.parse(readFileSync(join(dir, 'installed_plugins.json'), 'utf8')) as { plugins?: Record<string, Array<{ version?: string; installedAt?: string; lastUpdated?: string }>> }
    const out = Object.entries(all.plugins ?? {})
      .filter(([id]) => id.endsWith('@' + market))
      .flatMap(([id, entries]) => {
        const e = entries.at(-1)
        if (!e?.version) return []
        return [{ plugin: id.slice(0, -market.length - 1), version: e.version, lastUpdated: Date.parse(e.lastUpdated ?? '') || 0, installedAt: Date.parse(e.installedAt ?? e.lastUpdated ?? '') || 0 }]
      })
    if (out.length) return out
  } catch {}
  let plugins: string[] = []
  try {
    plugins = readdirSync(join(dir, 'cache', market))
  } catch {}
  return plugins.flatMap((plugin) => {
    const v = cacheFor(plugin)
    return v.length ? [{ plugin, version: v.at(-1)!.version, lastUpdated: v.at(-1)!.at, installedAt: v[0]!.at }] : []
  })
}

const COMMIT_RE = /^[0-9a-f]{12,40}$/

/**
 * One line per user marketplace: the version this process runs, and what a refresh would load when different.
 *
 * What a refresh loads is installed_plugins.json (autoUpdate makes new cache folders but points only some plugins
 * at them, so "the newest cache folder" is a promise it may not keep). What this process runs: the installed
 * version if it was set before the process started; otherwise the newest cache folder older than the start
 * (other than the new one); a "Base directory for this skill" line this process wrote beats both. A plugin first
 * installed after the start is not in this process at all.
 *
 * A marketplace split into per-skill plugins versions them by commit: shown as a 7-letter id, the member commit
 * installed last (ordered by when its cache folder appeared: the marketplace copy is a shallow clone, so git cannot
 * compare them). Otherwise the bundle's version (the plugin named like the marketplace).
 */
export function sessionPlugins(o: { pluginsDir?: string; user: string | string[]; processStart?: number; transcript?: string; reader?: SkillLineReader }): PluginLine[] {
  const dir = o.pluginsDir ?? join(homedir(), '.claude', 'plugins')
  const reader = o.reader ?? (o.transcript && existsSync(o.transcript) ? new SkillLineReader(o.transcript) : undefined)
  const seen = reader?.read() ?? new Map<string, { version: string; at: number }>()
  const users = Array.isArray(o.user) ? o.user : [o.user]
  const start = o.processStart
  const lines: PluginLine[] = []
  for (const market of [...new Set(users.flatMap((u) => userMarkets(dir, u)))]) {
    const cacheOf = new Map<string, Version[]>()
    const cacheFor = (plugin: string) => {
      let v = cacheOf.get(plugin)
      if (!v) cacheOf.set(plugin, (v = versions(dir, market, plugin)))
      return v
    }
    const birth = (plugin: string, version: string) => cacheFor(plugin).find((x) => x.version === version)?.at ?? 0
    const running: Array<{ plugin: string; version: string; at: number }> = []
    const installed: Array<{ plugin: string; version: string; at: number }> = []
    for (const m of members(dir, market, cacheFor)) {
      installed.push({ plugin: m.plugin, version: m.version, at: birth(m.plugin, m.version) || m.lastUpdated })
      let version: string | undefined
      if (!start || m.lastUpdated <= start) version = m.version
      else version = cacheFor(m.plugin).filter((v) => v.version !== m.version && v.at <= start).at(-1)?.version
      const line = seen.get(`${market}/${m.plugin}`)
      if (line && (!start || line.at >= start)) version = line.version
      // Not there before this process started (and no line says it was loaded since): not in this process.
      if (!version) continue
      running.push({ plugin: m.plugin, version, at: birth(m.plugin, version) })
    }
    const show = (list: Array<{ plugin: string; version: string; at: number }>): string | undefined => {
      if (!list.length) return undefined
      // Split into per-skill plugins: the commit installed last speaks for the marketplace.
      const commits = list.filter((x) => COMMIT_RE.test(x.version))
      if (commits.length) return commits.sort((a, b) => a.at - b.at).at(-1)!.version.slice(0, 7)
      // Not split (or a process from before the split): the bundle's version.
      const bundle = list.find((x) => x.plugin === market) ?? (list.length === 1 ? list[0] : undefined)
      if (bundle) return bundle.version
      return [...list].sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true })).at(-1)!.version
    }
    const now = show(running)
    if (!now) continue
    const next = show(installed)
    // Same shown version, but some member would change on a refresh (a sub-plugin of a bundle): say so without a number.
    const changed = installed.some((i) => running.find((r) => r.plugin === i.plugin)?.version !== i.version)
    lines.push({ market, version: now, ...(next && next !== now ? { latest: next } : changed ? { latest: '최신' } : {}) })
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

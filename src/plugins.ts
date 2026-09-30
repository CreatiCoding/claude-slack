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
 * "Base directory for this skill: …/cache/<market>/<plugin>/<version>/" lines Claude Code itself wrote into
 * the conversation (a person's own message, not a tool's output), from the end of the file.
 */
export function loadedSkillVersions(transcript: string, tailBytes = 16 * 1024 * 1024): Map<string, string> {
  const out = new Map<string, string>()
  let text = ''
  try {
    const size = statSync(transcript).size
    const start = Math.max(0, size - tailBytes)
    const fd = openSync(transcript, 'r')
    try {
      const buf = Buffer.alloc(size - start)
      readSync(fd, buf, 0, buf.length, start)
      text = buf.toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return out
  }
  for (const line of text.split('\n')) {
    if (!line.includes('Base directory for this skill:')) continue
    let entry: { type?: string; message?: { content?: unknown } }
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry.type !== 'user') continue
    const c = entry.message?.content
    const own = typeof c === 'string' ? c : Array.isArray(c) ? (c as Array<{ type?: string; text?: string }>).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n') : ''
    for (const m of own.matchAll(/Base directory for this skill: \S*?\/cache\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\//g)) out.set(`${m[1]}/${m[2]}`, m[3]!)
  }
  return out
}

/** One line per user marketplace: the version this process runs, and a newer one when installed. */
export function sessionPlugins(o: { pluginsDir?: string; user: string; processStart?: number; transcript?: string }): PluginLine[] {
  const dir = o.pluginsDir ?? join(homedir(), '.claude', 'plugins')
  const loaded = o.transcript && existsSync(o.transcript) ? loadedSkillVersions(o.transcript) : new Map<string, string>()
  const lines: PluginLine[] = []
  for (const market of userMarkets(dir, o.user)) {
    let plugins: string[]
    try {
      plugins = readdirSync(join(dir, 'cache', market))
    } catch {
      continue
    }
    const per = plugins.map((plugin) => {
      const all = versions(dir, market, plugin)
      const before = o.processStart ? all.filter((v) => v.at <= o.processStart!) : all
      const running = loaded.get(`${market}/${plugin}`) ?? before.at(-1)?.version ?? all.at(-1)?.version
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

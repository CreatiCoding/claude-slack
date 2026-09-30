/**
 * The skills and slash commands a session can use, and how often the person called each one themselves.
 *
 * Available: the user's (~/.claude/skills, ~/.claude/commands), the project's (.claude/ in the folder and
 * every folder above it), and those of enabled plugins (named plugin:skill).
 *
 * Called directly: a `<command-name>/name</command-name>` in a person's message, or a Skill call whose name is
 * in the person's message just before it. Any other Skill call was Claude's own choice ("자동으로 쓰인").
 * A person's message excludes system reminders, tool results, skill bodies (isMeta) and compaction summaries.
 * Counted over every conversation in ~/.claude/projects, reading each file only from where it was left.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export interface SkillInfo {
  name: string
  kind: 'skill' | 'command'
  source: 'user' | 'project' | 'plugin'
  description?: string
}

function frontmatterDescription(file: string): string | undefined {
  try {
    const head = readFileSync(file, 'utf8').slice(0, 4000)
    const fm = /^---\n([\s\S]*?)\n---/.exec(head)?.[1] ?? ''
    const d = /^description:\s*(.+)$/m.exec(fm)?.[1]?.trim().replace(/^["']|["']$/g, '')
    return d ? d.slice(0, 200) : undefined
  } catch {
    return undefined
  }
}

/** Skills (<dir>/skills/<name>/SKILL.md) and commands (<dir>/commands/**\/*.md, nested as a:b) under one .claude-like folder. */
function scanDir(base: string, source: SkillInfo['source'], prefix = ''): SkillInfo[] {
  const out: SkillInfo[] = []
  const skills = join(base, 'skills')
  try {
    for (const n of readdirSync(skills)) {
      const f = join(skills, n, 'SKILL.md')
      if (existsSync(f)) out.push({ name: prefix + n, kind: 'skill', source, ...(frontmatterDescription(f) ? { description: frontmatterDescription(f) } : {}) })
    }
  } catch {}
  const walk = (dir: string, ns: string[]) => {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const n of names) {
      const p = join(dir, n)
      let st
      try {
        st = statSync(p)
      } catch {
        continue
      }
      if (st.isDirectory()) walk(p, [...ns, n])
      else if (n.endsWith('.md')) out.push({ name: prefix + [...ns, n.slice(0, -3)].join(':'), kind: 'command', source, ...(frontmatterDescription(p) ? { description: frontmatterDescription(p) } : {}) })
    }
  }
  walk(join(base, 'commands'), [])
  return out
}

/** Everything callable from a session in `cwd`. */
export function availableSkills(cwd: string, o: { home?: string; claudeDir?: string } = {}): SkillInfo[] {
  const home = o.home ?? homedir()
  const claude = o.claudeDir ?? join(home, '.claude')
  const out: SkillInfo[] = [...scanDir(claude, 'user')]
  // The project's: the folder and every folder above it (Claude Code reads .claude/ up the tree).
  for (let d = resolve(cwd); ; d = dirname(d)) {
    if (d !== home) out.push(...scanDir(join(d, '.claude'), 'project'))
    if (d === dirname(d) || d === dirname(home)) break
  }
  // Enabled plugins, from where they are installed.
  try {
    const installed = JSON.parse(readFileSync(join(claude, 'plugins', 'installed_plugins.json'), 'utf8')) as { plugins?: Record<string, Array<{ installPath?: string }>> }
    let enabled: Record<string, boolean> | undefined
    try {
      enabled = (JSON.parse(readFileSync(join(claude, 'settings.json'), 'utf8')) as { enabledPlugins?: Record<string, boolean> }).enabledPlugins
    } catch {}
    for (const [id, entries] of Object.entries(installed.plugins ?? {})) {
      if (enabled && enabled[id] !== true) continue
      const path = entries.at(-1)?.installPath
      if (path) out.push(...scanDir(path, 'plugin', id.split('@')[0] + ':'))
    }
  } catch {}
  const seen = new Set<string>()
  return out.filter((s) => (seen.has(s.name) ? false : (seen.add(s.name), true)))
}

interface FileState {
  offset: number
  /** The last message the person wrote in this file, for a Skill call that comes after it. */
  last?: string
}
interface UsageState {
  files: Record<string, FileState>
  direct: Record<string, number>
  auto: Record<string, number>
}

const REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g

/** The person's own words in a transcript entry, or undefined when it is not theirs. */
function ownText(entry: { type?: string; isMeta?: boolean; isCompactSummary?: boolean; message?: { content?: unknown } }): string | undefined {
  if (entry.type !== 'user' || entry.isMeta || entry.isCompactSummary) return undefined
  const c = entry.message?.content
  let text: string
  if (typeof c === 'string') text = c
  else if (Array.isArray(c)) {
    const blocks = c as Array<{ type?: string; text?: string }>
    if (blocks.some((b) => b.type === 'tool_result')) return undefined
    text = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n')
  } else return undefined
  const clean = text.replace(REMINDER_RE, '').trim()
  return clean || undefined
}

export class SkillUsage {
  private path: string
  private projects: string
  private state: UsageState

  constructor(o: { statePath?: string; projectsDir?: string } = {}) {
    this.path = o.statePath ?? join(homedir(), '.claude-slack', 'skill-usage.json')
    this.projects = o.projectsDir ?? join(homedir(), '.claude', 'projects')
    try {
      this.state = JSON.parse(readFileSync(this.path, 'utf8')) as UsageState
    } catch {
      this.state = { files: {}, direct: {}, auto: {} }
    }
  }

  counts(): { direct: Record<string, number>; auto: Record<string, number> } {
    return { direct: this.state.direct, auto: this.state.auto }
  }

  /** Read what was added to every conversation since last time; yields between files so the broker stays responsive. */
  async update(): Promise<void> {
    let dirs: string[]
    try {
      dirs = await readdir(this.projects)
    } catch {
      return
    }
    let changed = false
    for (const d of dirs) {
      let names: string[]
      try {
        names = (await readdir(join(this.projects, d))).filter((n) => n.endsWith('.jsonl'))
      } catch {
        continue
      }
      for (const n of names) {
        const file = join(this.projects, d, n)
        let size: number
        try {
          size = (await stat(file)).size
        } catch {
          continue
        }
        const st = (this.state.files[file] ??= { offset: 0 })
        if (size < st.offset) Object.assign(st, { offset: 0, last: undefined })
        if (size === st.offset) continue
        this.readFile(file, st, size)
        changed = true
        await new Promise((r) => setImmediate(r))
      }
    }
    if (changed) this.save()
  }

  private readFile(file: string, st: FileState, size: number): void {
    const fd = openSync(file, 'r')
    let text: string
    try {
      const buf = Buffer.alloc(size - st.offset)
      readSync(fd, buf, 0, buf.length, st.offset)
      text = buf.toString('utf8')
    } finally {
      closeSync(fd)
    }
    // Only whole lines: a line still being written is read next time.
    const end = text.lastIndexOf('\n')
    if (end < 0) return
    st.offset += Buffer.byteLength(text.slice(0, end + 1))
    for (const line of text.slice(0, end).split('\n')) {
      if (!line.includes('"user"') && !line.includes('"Skill"')) continue
      let entry: { type?: string; isMeta?: boolean; isCompactSummary?: boolean; message?: { content?: unknown } }
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }
      const own = ownText(entry)
      if (own !== undefined) {
        for (const m of own.matchAll(/<command-name>\/?([^<\s]+)<\/command-name>/g)) this.state.direct[m[1]!] = (this.state.direct[m[1]!] ?? 0) + 1
        st.last = own.slice(0, 2000)
        continue
      }
      if (entry.type !== 'assistant' || !Array.isArray(entry.message?.content)) continue
      for (const b of entry.message!.content as Array<{ type?: string; name?: string; input?: { skill?: unknown } }>) {
        if (b.type !== 'tool_use' || b.name !== 'Skill' || typeof b.input?.skill !== 'string') continue
        const name = b.input.skill.replace(/^\//, '')
        const short = name.split(':').pop()!
        const asked = st.last !== undefined && (st.last.includes(name) || st.last.includes(short))
        const bucket = asked ? this.state.direct : this.state.auto
        bucket[name] = (bucket[name] ?? 0) + 1
      }
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      writeFileSync(this.path, JSON.stringify(this.state))
    } catch {}
  }
}

/** The chip's menu: called directly (most first), used on Claude's own, the rest. */
export function skillMenu(skills: SkillInfo[], counts: { direct: Record<string, number>; auto: Record<string, number> }) {
  const n = (map: Record<string, number>, s: SkillInfo) => map[s.name] ?? 0
  const direct = skills.filter((s) => n(counts.direct, s) > 0).sort((a, b) => n(counts.direct, b) - n(counts.direct, a) || a.name.localeCompare(b.name))
  const auto = skills.filter((s) => !n(counts.direct, s) && n(counts.auto, s) > 0).sort((a, b) => n(counts.auto, b) - n(counts.auto, a) || a.name.localeCompare(b.name))
  const other = skills.filter((s) => !n(counts.direct, s) && !n(counts.auto, s)).sort((a, b) => a.name.localeCompare(b.name))
  const row = (s: SkillInfo, count: number) => ({ name: s.name, kind: s.kind, source: s.source, count, ...(s.description ? { description: s.description } : {}) })
  return { direct: direct.map((s) => row(s, n(counts.direct, s))), auto: auto.map((s) => row(s, n(counts.auto, s))), other: other.map((s) => row(s, 0)) }
}


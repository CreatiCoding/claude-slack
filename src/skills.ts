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
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

export interface SkillInfo {
  name: string
  kind: 'skill' | 'command'
  source: 'user' | 'project' | 'plugin'
  description?: string
}

/** `user-invocable: false`: a skill only Claude calls, not one to offer in the chip. */
function hiddenFromUser(file: string): boolean {
  try {
    const fm = /^---\n([\s\S]*?)\n---/.exec(readFileSync(file, 'utf8').slice(0, 4000))?.[1] ?? ''
    return /^user-invocable:\s*false\s*$/m.test(fm)
  } catch {
    return false
  }
}

function frontmatterDescription(file: string): string | undefined {
  try {
    const head = readFileSync(file, 'utf8').slice(0, 4000)
    const fm = /^---\n([\s\S]*?)\n---/.exec(head)?.[1] ?? ''
    // A block description (`>` folded or `|` literal) continues on the lines indented under it (78).
    const block = /^description:\s*[>|][-+]?\s*\n((?:[ \t]+.*(?:\n|$))+)/m.exec(fm)
    if (block) {
      const d = block[1]!.split('\n').map((l) => l.trim()).filter(Boolean).join(' ')
      return d ? d.slice(0, 200) : undefined
    }
    const d = /^description:\s*(.+)$/m.exec(fm)?.[1]?.trim().replace(/^["']|["']$/g, '')
    return d ? d.slice(0, 200) : undefined
  } catch {
    return undefined
  }
}

/** Skills (<dir>/skills/<name>/SKILL.md) and commands (<dir>/commands/**\/*.md, nested as a:b) under one .claude-like folder. */
function scanDir(base: string, source: SkillInfo['source'], prefix = ''): SkillInfo[] {
  const out: SkillInfo[] = []
  // A plugin's manifest may point its skills and commands at other folders (78).
  let manifestSkills: string[] = []
  let manifestCommands: string[] = []
  try {
    const m = JSON.parse(readFileSync(join(base, '.claude-plugin', 'plugin.json'), 'utf8')) as { skills?: string | string[]; commands?: string | string[] }
    const list = (v?: string | string[]) => (v === undefined ? [] : Array.isArray(v) ? v : [v])
    manifestSkills = list(m.skills).map((p) => join(base, p))
    manifestCommands = list(m.commands).map((p) => join(base, p))
  } catch {}
  // A SKILL.md at the top of the install folder is the plugin's own skill (78).
  if (existsSync(join(base, 'SKILL.md')) && !hiddenFromUser(join(base, 'SKILL.md'))) {
    const top = join(base, 'SKILL.md')
    // Named by the skill's own name, else the plugin's (78): not the version folder it was installed in.
    const own = /^name:\s*(.+)$/m.exec(readFileSync(top, 'utf8').slice(0, 4000).match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '')?.[1]?.trim().replace(/^["']|["']$/g, '')
    out.push({ name: prefix + (own || prefix.replace(/:$/, '')), kind: 'skill', source, ...(frontmatterDescription(top) ? { description: frontmatterDescription(top) } : {}) })
  }
  for (const skills of [join(base, 'skills'), ...manifestSkills]) {
    try {
      for (const n of readdirSync(skills)) {
        const f = join(skills, n, 'SKILL.md')
        if (existsSync(f) && !hiddenFromUser(f)) out.push({ name: prefix + n, kind: 'skill', source, ...(frontmatterDescription(f) ? { description: frontmatterDescription(f) } : {}) })
      }
    } catch {}
  }
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
  for (const c of [join(base, 'commands'), ...manifestCommands]) walk(c, [])
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
    const installed = JSON.parse(readFileSync(join(claude, 'plugins', 'installed_plugins.json'), 'utf8')) as { plugins?: Record<string, Array<{ installPath?: string; scope?: string; projectPath?: string }>> }
    // Enabled: the user's settings, then each folder's .claude/settings.json and settings.local.json from the top
    // down to the session's folder; the nearest one that says something decides (false turns it off).
    let enabled: Record<string, boolean> | undefined
    const layer = (file: string) => {
      try {
        const e = (JSON.parse(readFileSync(file, 'utf8')) as { enabledPlugins?: Record<string, boolean> }).enabledPlugins
        if (e) enabled = { ...(enabled ?? {}), ...e }
      } catch {}
    }
    layer(join(claude, 'settings.json'))
    const chain: string[] = []
    for (let d = resolve(cwd); ; d = dirname(d)) {
      if (d !== home) chain.unshift(d)
      if (d === dirname(d) || d === dirname(home)) break
    }
    for (const d of chain) {
      layer(join(d, '.claude', 'settings.json'))
      layer(join(d, '.claude', 'settings.local.json'))
    }
    for (const [id, entries] of Object.entries(installed.plugins ?? {})) {
      if (enabled && enabled[id] !== true) continue
      // A plugin installed for one project belongs only to sessions in that project's folder.
      const here = resolve(cwd)
      const entry = [...entries].reverse().find((e) => e.scope !== 'project' || (e.projectPath && (here === resolve(e.projectPath) || here.startsWith(resolve(e.projectPath) + '/'))))
      if (entry?.installPath) out.push(...scanDir(entry.installPath, 'plugin', id.split('@')[0] + ':'))
    }
  } catch {}
  const seen = new Set<string>()
  return out.filter((s) => (seen.has(s.name) ? false : (seen.add(s.name), true)))
}

interface FileState {
  offset: number
  /**
   * Short hashes of the words in the last message the person wrote in this file, for a Skill call read later.
   * Not the message itself: it is private, and it would make the state file large.
   */
  lastWords?: string[]
}
interface UsageState {
  /** The counting rules this was made with: different rules, start over. */
  version: number
  files: Record<string, FileState>
  direct: Record<string, number>
  auto: Record<string, number>
}

/** Bump when the counting rules change; older counts are dropped. 3: counts inflated by a split character are dropped. */
const USAGE_VERSION = 4
/** Read a conversation this much at a time, letting the broker breathe in between. */
const CHUNK = 1024 * 1024
/** A name this short ("run", "docs", "loop") is an everyday word: only /name counts as calling it. */
const SHORT_NAME = 4

const REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g
const wordHash = (w: string) => createHash('sha1').update(w.toLowerCase()).digest('hex').slice(0, 8)
/**
 * Words as skill names are written: ASCII letters, digits and - _ : kept together, anything else separates. So
 * "report" does not match "reporting", and "tap-review로" (Korean right after the name) still says tap-review.
 */
const words = (text: string) => [...new Set(text.toLowerCase().split(/[^a-z0-9_:\-]+/).filter(Boolean))]

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
    const fresh = (): UsageState => ({ version: USAGE_VERSION, files: {}, direct: {}, auto: {} })
    try {
      const st = JSON.parse(readFileSync(this.path, 'utf8')) as UsageState
      this.state = st.version === USAGE_VERSION ? st : fresh()
    } catch {
      this.state = fresh()
    }
  }

  counts(): { direct: Record<string, number>; auto: Record<string, number> } {
    return { direct: this.state.direct, auto: this.state.auto }
  }

  /** Read what was added to every conversation since last time, a piece at a time, yielding in between. */
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
        if (size < st.offset) Object.assign(st, { offset: 0, lastWords: undefined })
        if (size === st.offset) continue
        await this.readFile(file, st, size)
        changed = true
      }
    }
    if (changed) this.save()
  }

  private async readFile(file: string, st: FileState, size: number): Promise<void> {
    // Lines are cut in bytes (0x0A), and only whole lines are decoded: a piece boundary inside a multi-byte
    // character decoded on its own became U+FFFD, and its byte count pushed the offset past the file's end.
    let rest: Buffer = Buffer.alloc(0)
    let consumed = st.offset
    const stream = createReadStream(file, { start: st.offset, end: size - 1, highWaterMark: CHUNK })
    for await (const chunk of stream) {
      const buf = rest.length ? Buffer.concat([rest, chunk as Buffer]) : (chunk as Buffer)
      const end = buf.lastIndexOf(0x0a)
      if (end < 0) {
        rest = buf
        continue
      }
      rest = buf.subarray(end + 1)
      consumed += end + 1
      let from = 0
      for (let nl = buf.indexOf(0x0a, from); nl !== -1 && nl <= end; nl = buf.indexOf(0x0a, from)) {
        this.line(buf.toString('utf8', from, nl), st)
        from = nl + 1
      }
      // One piece at a time: a hundred-MB conversation must not stop the broker.
      await new Promise((r) => setImmediate(r))
    }
    // Only whole lines count as read: a line still being written is read next time.
    st.offset = consumed
  }

  private line(line: string, st: FileState): void {
    if (!line.includes('"user"') && !line.includes('"Skill"')) return
    let entry: { type?: string; isMeta?: boolean; isCompactSummary?: boolean; message?: { content?: unknown } }
    try {
      entry = JSON.parse(line)
    } catch {
      return
    }
    const own = ownText(entry)
    if (own !== undefined) {
      for (const m of own.matchAll(/<command-name>\/?([^<\s]+)<\/command-name>/g)) this.state.direct[m[1]!] = (this.state.direct[m[1]!] ?? 0) + 1
      st.lastWords = words(own).slice(0, 300).map(wordHash)
      return
    }
    if (entry.type !== 'assistant' || !Array.isArray(entry.message?.content)) return
    for (const b of entry.message!.content as Array<{ type?: string; name?: string; input?: { skill?: unknown } }>) {
      if (b.type !== 'tool_use' || b.name !== 'Skill' || typeof b.input?.skill !== 'string') continue
      const name = b.input.skill.replace(/^\//, '')
      const short = name.split(':').pop()!
      const said = new Set(st.lastWords ?? [])
      // A short, common name is only "called directly" as /name (counted above), never by being mentioned.
      const asked = short.length > SHORT_NAME && (said.has(wordHash(name)) || said.has(wordHash(short)))
      const bucket = asked ? this.state.direct : this.state.auto
      bucket[name] = (bucket[name] ?? 0) + 1
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


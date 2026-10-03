/**
 * What Claude is writing right now, read off the terminal. Claude Code writes a block of text to the
 * transcript only when it is finished, so the web app's "쓰는 중" line comes from the screen instead.
 *
 * The screen, bottom up: the input box (a rule line, then a line starting with ❯), above it the spinner line
 * (✻ ✢ ✶ ✳ ✽ · * …) and "⎿  Tip:" lines, above those the block being written: "⏺ " then lines indented two
 * spaces. A "⏺ ToolName(" block with a tool summary or ⎿ under it is a running tool, not text.
 *
 * Capture is `-e` (with SGR colour codes) so the block can be turned back into the markdown Claude actually
 * wrote (15): bold (SGR 1) → `**`, the theme's inline-code colour → backtick, a dim line holding only a
 * language name → a fenced code block up to the next blank line. The whole block is returned, not a
 * 160-character tail — the web app now shows it as the answer, not a two-line activity-box preview.
 */
const RULE_RE = /^\s*[─━]{8,}\s*$/
const SPINNER_RE = /^\s*[✻✢✶✳✽·*⏺]?\s*[✻✢✶✳✽·*]\s+\S.*…/
const TIP_RE = /^\s*⎿\s+Tip:/
const TOOL_HEAD_RE = /^⏺\s+[\w.:-]+\(/
const TOOL_SUMMARY_RE = /^\s*(⎿|Running…|Ran\s|Searched\s|Read\s|Wrote\s|Updated\s|Edited\s|Listed\s|Fetched\s)/

const SGR_RE = /\x1b\[[0-9;]*m/g
/** Claude Code's default theme draws inline code in this 256-colour slot. */
const CODE_FG = '153'
const LANG_LINE_RE = /^[a-z][a-z0-9+#.-]*$/i

export const stripAnsi = (s: string): string => s.replace(SGR_RE, '')

interface Seg {
  text: string
  bold: boolean
  code: boolean
}

/** One line's text split into runs that share bold/inline-code styling, SGR codes consumed as they're seen. */
function parseSgrLine(line: string): Seg[] {
  const segs: Seg[] = []
  let bold = false
  let code = false
  let last = 0
  SGR_RE.lastIndex = 0
  let m: RegExpExecArray | null
  const push = (text: string) => {
    if (text) segs.push({ text, bold, code })
  }
  while ((m = SGR_RE.exec(line))) {
    push(line.slice(last, m.index))
    last = SGR_RE.lastIndex
    const codes = m[0].slice(2, -1).split(';').filter(Boolean)
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i]!
      if (c === '0' || c === '') {
        bold = false
        code = false
      } else if (c === '1') bold = true
      else if (c === '22' || c === '2') bold = false
      else if (c === '38' && codes[i + 1] === '5') {
        code = codes[i + 2] === CODE_FG
        i += 2
      } else if (c === '39') code = false
    }
  }
  push(line.slice(last))
  return segs
}

/** A merged run's own leading/trailing space goes outside the markdown marks (`** text**` reads oddly). */
function wrapRun(text: string, bold: boolean, code: boolean): string {
  if (!bold && !code) return text
  const lead = /^\s*/.exec(text)![0]
  const trail = /\s*$/.exec(text.slice(lead.length))![0]
  const core = text.slice(lead.length, text.length - trail.length)
  if (!core) return text
  return lead + (code ? '`' + core + '`' : '**' + core + '**') + trail
}

function lineToMarkdown(line: string): string {
  const segs = parseSgrLine(line)
  let out = ''
  let i = 0
  while (i < segs.length) {
    const s = segs[i]!
    let j = i + 1
    let text = s.text
    while (j < segs.length && segs[j]!.bold === s.bold && segs[j]!.code === s.code) {
      text += segs[j]!.text
      j++
    }
    out += wrapRun(text, s.bold, s.code)
    i = j
  }
  return out
}

/** A line that is entirely dim text and looks like a language name (`typescript`, `bash`, …): a fence opener. */
function isDimLangLine(line: string): string | undefined {
  const plain = stripAnsi(line).trim()
  if (!LANG_LINE_RE.test(plain)) return undefined
  // Dim is SGR 2, with no SGR 22/1 after it for the visible run.
  const m = /\x1b\[([0-9;]*)m/.exec(line)
  if (!m) return undefined
  const codes = m[1]!.split(';')
  return codes.includes('2') && !codes.includes('1') ? plain : undefined
}

/** The raw block's lines (bottom-up order already resolved), as one markdown string — fences restored. */
function blockToMarkdown(lines: string[]): string {
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const lang = isDimLangLine(lines[i]!)
    if (lang !== undefined) {
      const code: string[] = []
      let j = i + 1
      while (j < lines.length && stripAnsi(lines[j]!).trim() !== '') {
        code.push(stripAnsi(lines[j]!))
        j++
      }
      out.push('```' + lang, ...code, '```')
      i = j
      continue
    }
    out.push(lineToMarkdown(lines[i]!))
    i++
  }
  return out.join('\n').replace(/\s+$/, '')
}

/** Drop the first `n` *visible* characters of an SGR-coloured line, keeping any escape codes among them live. */
function dropVisiblePrefix(line: string, n: number): string {
  let i = 0
  let visible = 0
  while (i < line.length && visible < n) {
    const rest = line.slice(i)
    const m = /^\x1b\[[0-9;]*m/.exec(rest)
    if (m) {
      i += m[0].length
      continue
    }
    i++
    visible++
  }
  return line.slice(i)
}

/**
 * `screen` is `tmux capture-pane -e` output (SGR colour codes kept). Returns the block's markdown, or `''`
 * when nothing is being written right now (either genuinely idle, or — while still busy — a thinking pause
 * with no text block on screen; callers tell the two apart from the session's own busy/idle state, not from
 * this return value, since the screen looks the same in both cases).
 */
export function writingPreview(screen: string): string {
  const ansiLines = screen.split('\n')
  const lines = ansiLines.map(stripAnsi)
  // The input box: a rule with a ❯ line right under it, the lowest one on screen.
  let box = -1
  for (let i = lines.length - 2; i >= 0; i--) {
    if (RULE_RE.test(lines[i]!) && /^❯/.test(lines[i + 1]!)) {
      box = i
      break
    }
  }
  if (box < 0) return ''
  let end = box
  while (end > 0 && (!lines[end - 1]!.trim() || SPINNER_RE.test(lines[end - 1]!) || TIP_RE.test(lines[end - 1]!))) end--
  let start = -1
  for (let i = end - 1; i >= 0; i--) {
    const l = lines[i]!
    if (l.startsWith('⏺ ')) {
      if (TOOL_HEAD_RE.test(l)) return ''
      start = i
      break
    }
    if (/^\S/.test(l)) return '' // another line at column 0 (the prompt, a banner): no text block
    if (TOOL_SUMMARY_RE.test(l)) return ''
  }
  if (start < 0) return ''
  const raw: string[] = []
  for (let i = start; i < end; i++) {
    const n = i === start ? 2 : lines[i]!.startsWith('  ') ? 2 : lines[i]!.length - lines[i]!.trimStart().length
    raw.push(dropVisiblePrefix(ansiLines[i]!, n))
  }
  return blockToMarkdown(raw)
}

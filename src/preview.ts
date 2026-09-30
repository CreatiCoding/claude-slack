/**
 * What Claude is writing right now, read off the terminal. Claude Code writes a block of text to the
 * transcript only when it is finished, so the web app's "쓰는 중" line comes from the screen instead.
 *
 * The screen, bottom up: the input box (a rule line, then a line starting with ❯), above it the spinner line
 * (✻ ✢ ✶ ✳ ✽ · * …) and "⎿  Tip:" lines, above those the block being written: "⏺ " then lines indented two
 * spaces. A "⏺ ToolName(" block with a tool summary or ⎿ under it is a running tool, not text.
 */
const RULE_RE = /^\s*[─━]{8,}\s*$/
const SPINNER_RE = /^\s*[✻✢✶✳✽·*⏺]?\s*[✻✢✶✳✽·*]\s+\S.*…/
const TIP_RE = /^\s*⎿\s+Tip:/
const TOOL_HEAD_RE = /^⏺\s+[\w.:-]+\(/
const TOOL_SUMMARY_RE = /^\s*(⎿|Running…|Ran\s|Searched\s|Read\s|Wrote\s|Updated\s|Edited\s|Listed\s|Fetched\s)/
const TAIL_CHARS = 160

export function writingPreview(screen: string): string {
  const lines = screen.split('\n')
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
  const block: string[] = []
  let found = false
  for (let i = end - 1; i >= 0; i--) {
    const l = lines[i]!
    if (l.startsWith('⏺ ')) {
      if (TOOL_HEAD_RE.test(l)) return ''
      block.unshift(l.slice(2))
      found = true
      break
    }
    // Another line starting at column 0 (the prompt ❯, a banner): no text block is being written.
    if (/^\S/.test(l)) return ''
    if (TOOL_SUMMARY_RE.test(l)) return ''
    block.unshift(l.startsWith('  ') ? l.slice(2) : l.trimStart())
  }
  if (!found) return ''
  const text = block.join('\n').replace(/\s+$/, '')
  return text.length > TAIL_CHARS ? text.slice(-TAIL_CHARS) : text
}

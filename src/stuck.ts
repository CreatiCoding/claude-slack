/**
 * Screens and transcript lines that mean "nothing will happen until a person
 * acts", recognized so the thread can say so instead of showing a raw screen.
 *
 * The afternoon this was written for: a session sat on
 * `Interrupted · What should Claude do instead?` for two hours while the
 * thread got "37분째 새 출력이 없습니다" plus a diff dump. The words were on
 * screen the whole time; nobody had taught the broker to read them.
 */

export type StuckKind = 'interrupted' | 'idle-prompt'

export interface StuckState {
  kind: StuckKind
  /** What to tell the person, in their words. */
  text: string
  /** Something to press; `continue` injects "계속해". */
  actions: Array<'continue' | 'screen'>
}

const INTERRUPTED_RE = /Interrupted\s*[·•]\s*What should Claude do instead\?/i
/** The prompt box with nothing typed and no work indicator: Claude is simply waiting. */
const EMPTY_PROMPT_RE = /^\s*❯\s*$/m
// `esc to interrupt` is the familiar hint; newer Claude Code also shows only a spinner line
// (`✽ Flibbertigibbeting… (13m 20s · ↓ 14.5k tokens)`) while a long tool call runs, with no hint text at all.
export const WORKING_RE = /esc to interrupt|^\s*[✻✢✶✳✽✦*·]\s+\S+…\s*\(\d/im

/**
 * Read a stuck state off a screen. Only states that are unambiguous on the
 * screen alone; the auto-mode classifier's refusal lives in the transcript and
 * is read there ({@link classifierDenial}).
 */
export function detectStuckState(screen: string): StuckState | null {
  // "Interrupted" is only a state while it is the last thing said. Once new output
  // follows it (the next turn started), the line is history, not a stuck session —
  // reading it as one posted a "계속해" button in the middle of live work.
  const lines = screen.split('\n')
  const last = lines.reduce((acc, l, i) => (INTERRUPTED_RE.test(l) ? i : acc), -1)
  const trailing = lines.slice(last + 1)
  const nothingAfter = last >= 0 && trailing.every((l) => !l.trim() || /^\s*❯/.test(l) || /^[\s─▔━═_╌╍│|]+$/.test(l) || /for shortcuts|to cycle|for agents|\/effort|mode on|bypass/i.test(l))
  if (nothingAfter && !WORKING_RE.test(screen)) {
    return {
      kind: 'interrupted',
      text: '작업이 중단된 채 다음 지시를 기다리고 있습니다. 이어서 하려면 *계속해* 를 누르거나 새 지시를 쓰세요.',
      actions: ['continue', 'screen'],
    }
  }
  if (EMPTY_PROMPT_RE.test(screen) && !WORKING_RE.test(screen)) {
    return { kind: 'idle-prompt', text: '터미널은 유휴 상태입니다. 진행 중인 작업이 없습니다.', actions: ['screen'] }
  }
  return null
}

const CLASSIFIER_RE = /denied by the Claude Code auto mode classifier\.?\s*(?:Reason:\s*)?(\[[^\]]+\])?/i

/**
 * Auto mode refused a tool call. It reaches the transcript as an error tool
 * result; there is no dialog and nothing to approve, which is exactly why the
 * last time this happened Claude told the user to go approve something.
 */
export function classifierDenial(toolResult: string): { reason: string } | null {
  const m = CLASSIFIER_RE.exec(toolResult)
  if (!m) return null
  return { reason: m[1] ?? '이유 없음' }
}

const HANDBACK_FRAME_RE = /^\s*\[Subagent hand-back\][\s\S]*?The report follows:\s*\n/i
const HARNESS_NOTE_RE = /^[ \t]*\[harness:[^\]]*\][ \t]*\n?/gim
const AGENT_TAG_RE = /^\s*<agent-message\b[^>]*>\s*|\s*<\/agent-message>\s*$/gi

/**
 * A finished subagent comes back as a user message wrapped in an
 * `<agent-message>` tag with a paragraph of harness framing (the indentation
 * warning, the "carries no user authority" notice). None of that is for the
 * person reading the thread. Return the report itself, dedented, or null when
 * the text is not one of these.
 */
export function subagentReport(text: string): string | null {
  if (!/^\s*<agent-message\b/i.test(text)) return null
  let body = text.replace(AGENT_TAG_RE, '')
  body = body.replace(HANDBACK_FRAME_RE, '')
  body = body.replace(HARNESS_NOTE_RE, '')
  // The harness indents every report line by two spaces; drop that so headings and lists render.
  const lines = body.split('\n')
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => /^ */.exec(l)![0].length))
  return lines
    .map((l) => l.slice(Number.isFinite(indent) ? indent : 0))
    .join('\n')
    .trim()
}

/**
 * Is this text the whole of Claude's answer, and is it only an echo of the
 * reply tool's result? After calling `reply`, the model tends to finish with a
 * bare "sent" or "done", which the thread then shows as a message of its own.
 */
export function isToolEcho(text: string): boolean {
  return /^\s*[(\[]?\s*(sent|done|delivered|ok|okay|완료|보냈습니다|전송했습니다)\s*[.!)\]]?\s*$/i.test(text)
}

/**
 * Whether typed text is sitting in Claude Code's input box, unsent. The box is the last pair of horizontal rules on the
 * screen; a `❯` line anywhere else (a message Claude Code is holding in its queue while it works, or an earlier prompt in the
 * scrollback) is not the box, and pressing Enter for it does nothing but repeat forever.
 */
export function inputBoxHas(screen: string, head: string): boolean {
  if (!head) return false
  const lines = screen.split('\n')
  const rules: number[] = []
  lines.forEach((l, i) => {
    if (/^[\s─━]*[─━]{20,}[\s─━]*$/.test(l)) rules.push(i)
  })
  if (rules.length < 2) return false
  const box = lines.slice(rules.at(-2)! + 1, rules.at(-1)!)
  return box.some((l) => /^\s*❯\s*\S/.test(l) && l.includes(head))
}

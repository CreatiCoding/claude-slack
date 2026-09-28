/**
 * Terminal dialogs: reading them, deciding who answers, and answering safely.
 *
 * Every keystroke that answers a dialog goes through {@link DialogDriver}. That
 * is the point of this module: pressing a number is only safe if that option is
 * on screen right now. When the check was missing, a tap on a stale Slack
 * button typed its digit into the prompt and sent "1" to the session as a
 * message. The driver makes that impossible by construction.
 */
import type { TmuxLike } from './tmux.ts'

export interface DialogOption {
  /** The digit Claude Code accepts as an answer. */
  n: number
  label: string
  /** The explanation Claude Code prints under the option, if any. */
  description?: string
}

export interface TerminalDialog {
  /** First non-empty line above the options: what is being asked. */
  question: string
  /** Lines between the question and the options, if any. */
  description?: string
  /** Numbered options in screen order. */
  options: DialogOption[]
  /** Index into `options` of the line the ❯ cursor is on. */
  selected: number
}

/**
 * Dialogs we answer without asking, because the user already made the decision
 * (model switch) or there is nobody at the terminal to accept a startup prompt.
 * Anything not listed is shown to the user as buttons instead.
 */
const KNOWN: Array<{ name: string; present: RegExp; choose: RegExp }> = [
  { name: 'folder-trust', present: /trust this folder|trust the files in this folder/i, choose: /Yes, (I trust|proceed)/i },
  { name: 'dev-channels', present: /I am using this for local development/i, choose: /I am using this for local development/i },
  { name: 'mcp-consent', present: /Use this MCP server/i, choose: /Use this MCP server/i },
  // `/model` mid-conversation asks before dropping the prompt cache. The user already chose, so say yes.
  { name: 'model-switch', present: /Switch model\?/i, choose: /Yes, switch/i },
  // Startup, when the Chrome extension is installed and `--chrome` was not passed (QA runs). The launcher
  // passes `--chrome` for real sessions, so this only shows up where browser tools are meant to stay off.
  // Found by the QA sweep on 2026-09-23: the session sat here and never attached.
  { name: 'chrome-extension', present: /Claude in Chrome extension detected/i, choose: /No, keep browser tools off/i },
]

const SEPARATOR_RE = /^[\s─▔━═_╌╍-]+$/
const OPTION_RE = /^\s*(❯\s*)?(\d+)\.\s+(.*\S)\s*$/
/** How far apart two options may sit; each carries a few lines of explanation. */
const MAX_OPTION_GAP = 6
/**
 * The tab strip Claude Code draws above a multi-question dialog
 * ("← ☐ 규칙 충돌 ☐ 진입 방식 ✔ Submit →"). It sits right where the question
 * would be, so without skipping it the card asks the wrong thing.
 */
const DIALOG_CHROME_RE = /^[←→]|[☐☑✔]\s*\S|Enter to (select|confirm)|Tab\/Arrow/
/**
 * The key hints under a dialog with no numbers. The running status line also
 * mentions Esc ("esc to interrupt"), so requiring an Enter hint is what keeps a
 * working session from reading as a question.
 */
const KEYED_FOOTER_RE = /(?:Enter|↵)\s+to\s+(?:continue|confirm|select|submit|proceed|accept)/i

/**
 * Recognize any numbered dialog Claude Code draws (❯ on one of `1. …` lines),
 * whether or not we know what it is. The normal prompt line (`❯ text`) has no
 * numbered options, so it never matches.
 */
export function parseDialog(screen: string): TerminalDialog | null {
  const lines = screen.split('\n')
  const cursor = lines.findIndex((l) => /^\s*❯/.test(l) && OPTION_RE.test(l))
  if (cursor < 0) return null

  // Options are not always adjacent: Claude Code prints an explanation under
  // each one, so `1.` and `2.` can be several lines apart. Walk the numbered
  // lines instead, keeping those that continue the sequence.
  const numbered = lines.flatMap((l, i) => {
    const m = OPTION_RE.exec(l)
    return m ? [{ i, n: Number(m[2]), label: m[3]!.trim() }] : []
  })
  const at = numbered.findIndex((o) => o.i === cursor)
  if (at < 0) return null

  const run = [numbered[at]!]
  for (let k = at - 1; k >= 0; k--) {
    const prev = numbered[k]!
    if (prev.n !== run[0]!.n - 1 || run[0]!.i - prev.i > MAX_OPTION_GAP) break
    run.unshift(prev)
  }
  for (let k = at + 1; k < numbered.length; k++) {
    const next = numbered[k]!
    if (next.n !== run[run.length - 1]!.n + 1 || next.i - run[run.length - 1]!.i > MAX_OPTION_GAP) break
    run.push(next)
  }
  if (run.length < 2) return null

  const options: DialogOption[] = run.map((o, k) => ({
    n: o.n,
    label: o.label,
    description: describeOption(lines, o.i, run[k + 1]?.i ?? o.i + MAX_OPTION_GAP),
  }))

  const lo = run[0]!.i
  const above: string[] = []
  for (let i = lo - 1; i >= 0 && above.length < 6; i--) {
    const l = lines[i]!.replace(/^[\s│|]+/, '').trim()
    if (!l || SEPARATOR_RE.test(l)) {
      if (above.length) break
      continue
    }
    if (DIALOG_CHROME_RE.test(l)) continue
    above.unshift(l)
  }
  return {
    question: above[0] ?? '터미널이 선택을 기다립니다',
    description: above.slice(1).join('\n') || undefined,
    options,
    selected: at - numbered.indexOf(run[0]!),
  }
}

/**
 * Is the prompt input drawn underneath the dialog? Claude Code does that when the
 * dialog belongs to a background agent while the main loop is mid-turn: the box is
 * on screen, but keystrokes go to the prompt. A digit pressed then is typed there
 * and sent to the session as the message "1", and the dialog never gets its answer.
 */
export function promptHoldsFocus(screen: string): boolean {
  const lines = screen.split('\n')
  let lastOption = -1
  lines.forEach((l, i) => {
    if (OPTION_RE.test(l)) lastOption = i
  })
  if (lastOption < 0) return false
  return lines.slice(lastOption + 1).some((l) => /^\s*❯/.test(l) && !OPTION_RE.test(l))
}

/** A dialog with no numbered options, driven by arrows and Enter. */
export interface KeyedDialog {
  question: string
  /** The rest of what the box says, so the reader can decide without the terminal. */
  body?: string
  /** The key hints Claude Code prints, quoted as-is. */
  footer: string
}

/**
 * Claude Code also draws dialogs with no numbers — checkbox forms like "Teach
 * auto mode about your environment?", answered with arrows and Enter.
 * {@link parseDialog} cannot see those, so the session would sit there with
 * nothing actionable in Slack. Recognize them by the key hints they print.
 */
export function parseKeyedDialog(screen: string): KeyedDialog | null {
  const lines = screen.split('\n')
  const foot = lines.findIndex((l) => KEYED_FOOTER_RE.test(l))
  if (foot < 0) return null
  // The prompt line is `❯ ` with nothing on it; a dialog's cursor sits on a choice.
  const cursor = lines.findIndex((l, i) => i < foot && /^\s*❯\s*\S/.test(l))
  if (cursor < 0) return null

  const body: string[] = []
  for (let i = foot - 1; i >= 0 && body.length < 12; i--) {
    const l = lines[i]!.replace(/^[\s│|]+/, '').replace(/[\s│|]+$/, '').trim()
    if (SEPARATOR_RE.test(l)) break
    if (l) body.unshift(l)
  }
  if (!body.length) return null
  return { question: body[0]!, body: body.slice(1).join('\n') || undefined, footer: lines[foot]!.trim() }
}

/** The indented lines under an option, joined; empty when there are none. */
function describeOption(lines: string[], from: number, until: number): string | undefined {
  const body: string[] = []
  for (let i = from + 1; i < Math.min(until, lines.length); i++) {
    const l = lines[i]!.trim()
    if (!l || SEPARATOR_RE.test(l) || OPTION_RE.test(lines[i]!)) break
    body.push(l)
  }
  return body.join(' ') || undefined
}

/**
 * A dialog we may answer on the user's behalf, with how many Down (positive) or
 * Up (negative) presses reach the option we want.
 */
export function detectKnown(screen: string): { name: string; moves: number } | null {
  for (const d of KNOWN) {
    if (!d.present.test(screen)) continue
    const lines = screen.split('\n')
    const cursor = lines.findIndex((l) => /^\s*❯/.test(l))
    const target = lines.findIndex((l, i) => /^\s*(❯\s*)?\S/.test(l) && d.choose.test(l) && (cursor < 0 || Math.abs(i - cursor) <= 6))
    if (cursor < 0 || target < 0) return { name: d.name, moves: 0 }
    const [lo, hi] = cursor < target ? [cursor, target] : [target, cursor]
    const steps = lines.slice(lo + 1, hi + 1).filter((l) => l.trim()).length
    return { name: d.name, moves: cursor < target ? steps : steps === 0 ? 0 : -steps }
  }
  return null
}

/** Keys that move the ❯ cursor onto a detected dialog's option and confirm it. */
export function cursorKeys(moves: number): string[] {
  const keys: string[] = []
  for (let i = 0; i < Math.abs(moves); i++) keys.push(moves > 0 ? 'Down' : 'Up')
  keys.push('Enter')
  return keys
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** How long to wait for a dialog that a hook announced but the terminal has not drawn yet. */
const APPEAR_TIMEOUT_MS = 900
const POLL_MS = 300
/** Claude Code needs a moment between the digit and Enter. */
const KEY_GAP_MS = 300

/** 'unfocused': the dialog is up but the prompt has the keyboard, so nothing was pressed. */
export type AnswerResult = 'answered' | 'gone' | 'unfocused'
/** 'no-dialog' is normal (nothing to answer); 'no-option' means we saw the dialog but could not answer it. */
export type ProceedResult = 'answered' | 'no-dialog' | 'no-option' | 'unfocused'

/** Broader than a one-time yes: answering this also covers future calls. */
const ALWAYS_RE = /don'?t ask again|always allow|항상/i
/** "Yes, allow reading from /X from this project" — still broader than one time. */
const PROJECT_WIDE_RE = /\b(project|directory|folder)\b/i
const DENY_RE = /^(no|deny|cancel|reject)\b/i
const YES_RE = /^(yes|proceed|allow|continue)\b/i

export type OptionKind = 'allow-once' | 'allow-always' | 'deny' | 'other'

/**
 * What answering this option means. Order matters: "Don't ask again for Bash"
 * reads as a deny if you only look at the leading word, but it is the broadest
 * allow there is, so the always-check runs first.
 */
export function classifyOption(label: string): OptionKind {
  if (ALWAYS_RE.test(label)) return 'allow-always'
  if (DENY_RE.test(label)) return 'deny'
  if (YES_RE.test(label)) return PROJECT_WIDE_RE.test(label) ? 'allow-always' : 'allow-once'
  return 'other'
}

/**
 * Is this the yes/no confirmation that gates a tool call, as opposed to an
 * AskUserQuestion or some other numbered list? A permission verdict may only
 * drive this kind, otherwise an unrelated dialog could be answered by accident.
 */
export function isProceedDialog(d: TerminalDialog): boolean {
  const kinds = d.options.map((o) => classifyOption(o.label))
  return kinds.includes('deny') && (kinds.includes('allow-once') || kinds.includes('allow-always'))
}

/**
 * Reads and answers terminal dialogs. Holds the only code in the app that
 * presses dialog keys, so "is that option actually on screen?" is asked once.
 */
export class DialogDriver {
  private tmux: TmuxLike
  private log: (m: string) => void

  constructor(tmux: TmuxLike, log: (m: string) => void = () => {}) {
    this.tmux = tmux
    this.log = log
  }

  async read(pane: string): Promise<TerminalDialog | null> {
    try {
      return parseDialog(await this.tmux.capture(pane))
    } catch (err) {
      this.log(`dialog read failed: ${err}`)
      return null
    }
  }

  /** Wait briefly for a dialog to be drawn; hooks can outrun the terminal. */
  async waitForDialog(pane: string, timeoutMs = APPEAR_TIMEOUT_MS): Promise<TerminalDialog | null> {
    const deadline = Date.now() + timeoutMs
    let dialog = await this.read(pane)
    while (!dialog && Date.now() < deadline) {
      await sleep(POLL_MS)
      dialog = await this.read(pane)
    }
    return dialog
  }

  /**
   * Press an option by its number, but only if the dialog on screen offers it.
   * A stale button (its dialog already answered or gone) reports 'gone' and
   * sends nothing, so the digit can never land in the prompt as a message.
   */
  async answerNumber(pane: string, n: string): Promise<AnswerResult> {
    const dialog = await this.waitForDialog(pane)
    if (!dialog || !dialog.options.some((o) => String(o.n) === n)) return 'gone'
    return (await this.press(pane, n)) ? 'answered' : 'unfocused'
  }

  /** Press the first option whose label matches, if any. Returns the number pressed. */
  async answerMatching(pane: string, match: RegExp, timeoutMs = APPEAR_TIMEOUT_MS): Promise<number | null> {
    const dialog = await this.waitForDialog(pane, timeoutMs)
    const hit = dialog?.options.find((o) => match.test(o.label))
    if (!hit) return null
    return (await this.press(pane, String(hit.n))) ? hit.n : null
  }

  /**
   * Answer the yes/no dialog that gates a tool call. Does nothing unless the
   * screen actually holds such a dialog, so a verdict for one request can never
   * answer an unrelated prompt that happens to be up.
   */
  async answerProceed(pane: string, behavior: 'allow' | 'deny' | 'always', timeoutMs = 0): Promise<ProceedResult> {
    // Default to a single capture: a verdict answers the dialog that is up *now*.
    // Waiting would let a verdict for one request answer the next request's dialog.
    const dialog = timeoutMs > 0 ? await this.waitForDialog(pane, timeoutMs) : await this.read(pane)
    if (!dialog || !isProceedDialog(dialog)) return 'no-dialog'
    const want: OptionKind = behavior === 'always' ? 'allow-always' : behavior === 'allow' ? 'allow-once' : 'deny'
    const pick = dialog.options.find((o) => classifyOption(o.label) === want)
    if (!pick) return 'no-option'
    return (await this.press(pane, String(pick.n))) ? 'answered' : 'unfocused'
  }

  /**
   * Answer a dialog we recognize, without involving the user. Returns its name,
   * or null when the screen holds no known dialog.
   */
  async confirmKnown(pane: string, screen: string): Promise<string | null> {
    const known = detectKnown(screen)
    if (!known) return null
    // `present` is matched against the whole screen, so prose that merely quotes
    // "Switch model?" would otherwise make us press Enter into the live prompt.
    // Only act when a dialog is actually drawn — numbered or not. Claude Code
    // draws the MCP and folder-trust prompts without numbers, and requiring
    // numbers here left those sessions stuck at startup, never connecting.
    const numbered = parseDialog(screen)
    if (numbered) {
      if (!numbered.options[numbered.selected + known.moves]) return null
    } else if (!parseKeyedDialog(screen)) {
      return null
    }
    await this.tmux.sendKeys(pane, cursorKeys(known.moves))
    return known.name
  }

  /**
   * Press a digit, then Enter. Resolves false, having sent nothing that reaches the
   * session, when the prompt rather than the dialog has the keyboard.
   */
  private async press(pane: string, n: string): Promise<boolean> {
    if (promptHoldsFocus(await this.tmux.capture(pane))) {
      this.log(`dialog on ${pane} is up but the prompt has focus; not pressing ${n}`)
      return false
    }
    await this.tmux.sendKeys(pane, [n])
    await sleep(KEY_GAP_MS)
    // Belt and braces: if the digit landed in the prompt after all, take it back
    // instead of sending it with Enter.
    const typed = (await this.tmux.capture(pane)).split('\n').some((l) => new RegExp(`^\\s*❯\\s*${n}\\s*$`).test(l))
    if (typed) {
      await this.tmux.sendKeys(pane, ['BSpace'])
      this.log(`digit ${n} landed in the prompt on ${pane}; erased it`)
      return false
    }
    await this.tmux.sendKeys(pane, ['Enter'])
    return true
  }
}

/**
 * Claude Code shows up to three dialogs when started with the development
 * channels flag in a fresh directory: folder trust, the dev-channels warning,
 * and MCP server consent. Nobody is at the tmux window, so answer them here.
 * Returns the list of dialogs it confirmed.
 */
export async function autoConfirmDialogs(t: TmuxLike, pane: string, done: () => boolean = () => false, timeoutMs = 45_000): Promise<string[]> {
  const driver = new DialogDriver(t)
  const confirmed: string[] = []
  const deadline = Date.now() + timeoutMs
  let quietRounds = 0
  // `done` is the hook-based exit: the broker says the session attached, so nothing more will be asked.
  while (Date.now() < deadline && !done()) {
    let screen: string
    try {
      screen = await t.capture(pane)
    } catch {
      break
    }
    const name = await driver.confirmKnown(pane, screen)
    if (name) {
      confirmed.push(name)
      quietRounds = 0
      await sleep(1500)
      continue
    }
    if (/messages from server:\S+ inject directly/i.test(screen) || /^>\s*$/m.test(screen)) {
      // Channel notice or an empty prompt line: session is up.
      quietRounds++
      if (quietRounds >= 2) break
    }
    await sleep(700)
  }
  return confirmed
}

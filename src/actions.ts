/**
 * The Slack interaction contract, defined once for both sides.
 *
 * Buttons are built in `panel.ts` and handled in `broker.ts`. When each side
 * spelled the format out for itself they drifted: `btn()` appends a uniqueness
 * suffix to `action_id` (Slack requires it to be unique within a message), so
 * the broker's `actionId === 'perm_allow'` never matched and every permission
 * click was silently dropped. Everything about the wire format now lives here.
 */

/** Base action ids. The rendered `action_id` starts with one of these. */
export const ACTION = {
  permAllow: 'perm_allow',
  permAlways: 'perm_always',
  permDeny: 'perm_deny',
  ctlNew: 'ctl_new',
  ctlResume: 'ctl_resume',
  ctlSettings: 'ctl_settings',
  ctlPurge: 'ctl_purge',
  ctlConfirm: 'ctl_confirm',
  ctlMore: 'ctl_more',
  ctlBtn: 'ctl_btn',
  /** A link button (opens a URL). Still needs acking, so it must carry a known base. */
  ctlOpen: 'ctl_open',
  dlgAnswer: 'dlg_answer',
  /** Enter/Esc on a dialog that has no numbered options to press. */
  dlgKey: 'dlg_key',
} as const

export type ActionBase = (typeof ACTION)[keyof typeof ACTION]

/** Prefixes Bolt subscribes to. Every base id must start with one of these. */
export const ACTION_PREFIXES = ['perm_', 'dlg_', 'ctl_'] as const

let seq = 0

/**
 * Render an `action_id`: the base plus a slug and counter, because Slack
 * rejects duplicate action_ids inside one message. Consumers must therefore
 * match with {@link isAction}, never with `===`.
 */
export function renderActionId(base: ActionBase, value: string): string {
  const slug = value
    .replace(/^\d+:/, '')
    .replace(/[^a-z0-9]+/gi, '_')
    .slice(0, 40)
  return `${base}_${slug}_${++seq % 1000}`
}

/** Does a rendered action_id come from this base? */
export function isAction(actionId: string, base: ActionBase): boolean {
  return actionId === base || actionId.startsWith(`${base}_`)
}

/** Button values are `<pid>:<command>`; the command is the broker's runCommand vocabulary. */
export function encodeValue(pid: number, command: string): string {
  return `${pid}:${command}`
}

export function decodeValue(value: string): { pid: number; command: string } | null {
  const idx = value.indexOf(':')
  if (idx <= 0) return null
  const pid = Number(value.slice(0, idx))
  const command = value.slice(idx + 1)
  if (!Number.isFinite(pid) || !command) return null
  return { pid, command }
}

/**
 * `answer <questionIndex> <optionNumber> [label]` as buttons encode it. A person
 * types the short form, `answer 2`, so both are accepted.
 */
export function encodeAnswer(pid: number, questionIndex: number, optionNumber: number, label: string): string {
  return encodeValue(pid, `answer ${questionIndex} ${optionNumber} ${label}`)
}

export function decodeAnswer(command: string): { questionIndex: number; optionNumber: string; label: string } | null {
  const full = /^answer\s+(\d+)\s+(\d+)(?:\s+(.*))?$/.exec(command)
  if (full) return { questionIndex: Number(full[1]), optionNumber: full[2]!, label: full[3]?.trim() || full[2]! }
  const short = /^answer\s+(\d+)\s*$/.exec(command)
  return short ? { questionIndex: 0, optionNumber: short[1]!, label: short[1]! } : null
}

/** The block holding one question's buttons, so answering it can replace just that block. */
export function questionBlockId(pid: number, questionIndex: number): string {
  return `dlg_q${questionIndex}_${pid}`
}

/** Control-panel block ids. The broker finds an existing panel in a thread by these. */
export function panelBlockId(pid: number, ended = false): string {
  return ended ? `ctl_ended_${pid}` : `ctl_${pid}`
}

export function isPanelBlockId(blockId: string | undefined): boolean {
  return !!blockId && /^ctl_(ended_)?\d+$/.test(blockId)
}

/**
 * The resume picker's option value: `resume:<sessionId>:<cwd>`.
 *
 * Slack rejects an option value over {@link OPTION_VALUE_MAX} characters, and a
 * uuid plus an absolute path goes past it easily — the whole picker then fails
 * with `invalid_blocks`. The home directory is abbreviated and, if that is still
 * not enough, the path is cut from the left, keeping the part that identifies
 * the project. `decodeResume` returns whatever survived; the launcher resolves it.
 */
export const OPTION_VALUE_MAX = 75

export function encodeResume(sessionId: string, cwd: string, home = process.env.HOME ?? ''): string {
  const short = home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd
  const room = OPTION_VALUE_MAX - `resume:${sessionId}:`.length
  const path = short.length <= room ? short : `…${short.slice(short.length - room + 1)}`
  return `resume:${sessionId}:${path}`
}

export function decodeResume(value: string): { sessionId: string; cwd: string } | null {
  const m = /^resume:([^:]+):(.+)$/.exec(value)
  return m ? { sessionId: m[1]!, cwd: m[2]! } : null
}

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)
/** Height of a new window. Taller shows more of the conversation, in the terminal and in a screen picture. */
export const TMUX_ROWS = Number(process.env.CLAUDE_SLACK_TMUX_ROWS) || 80
export const TMUX_SESSION = process.env.CLAUDE_SLACK_TMUX_SESSION ?? 'claude-slack'

export interface TmuxLike {
  launch(opts: { cwd: string; env: Record<string, string>; command: string[]; name?: string }): Promise<{ window: string; pane: string }>
  sendKeys(pane: string, keys: string[]): Promise<void>
  typeLine(pane: string, text: string): Promise<void>
  /** Paste possibly multi-line text as one bracketed paste, then Enter. */
  pasteLine(pane: string, text: string): Promise<void>
  capture(pane: string): Promise<string>
  /** The screen with its colours, as SGR escape sequences, to draw it as a picture. */
  captureAnsi(pane: string, history?: number): Promise<string>
  /**
   * Make the pane's window at least `rows` tall, so Claude Code draws more of the conversation. Left alone when someone
   * is attached (it would resize their view). Resolves true when the window changed.
   */
  growHeight(pane: string, rows: number): Promise<boolean>
  killPane(pane: string): Promise<void>
  hasPane(pane: string): Promise<boolean>
}

async function tmux(args: string[]): Promise<string> {
  const { stdout } = await execFileP('tmux', args, { maxBuffer: 4 * 1024 * 1024 })
  return stdout
}

const rawTmux: TmuxLike = {
  async launch({ cwd, env, command, name }) {
    const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`])
    const nameArgs = name ? ['-n', name] : []
    const fmt = '#{window_id}|#{pane_id}'
    const cmd = command.map(shellQuote).join(' ')
    let out: string
    if (await hasSession()) {
      out = await tmux(['new-window', '-d', '-t', `=${TMUX_SESSION}:`, ...nameArgs, '-c', cwd, '-P', '-F', fmt, ...envArgs, cmd])
    } else {
      out = await tmux(['new-session', '-d', '-s', TMUX_SESSION, ...nameArgs, '-x', '220', '-y', String(TMUX_ROWS), '-c', cwd, '-P', '-F', fmt, ...envArgs, cmd])
    }
    const [window, pane] = out.trim().split('|')
    return { window: window!, pane: pane! }
  },
  async sendKeys(pane, keys) {
    await tmux(['send-keys', '-t', pane, ...keys])
  },
  async typeLine(pane, text) {
    await tmux(['send-keys', '-t', pane, '-l', text])
    // Give the TUI a moment to render slash-command autocomplete before Enter.
    await new Promise((r) => setTimeout(r, 150))
    await tmux(['send-keys', '-t', pane, 'Enter'])
  },
  async pasteLine(pane, text) {
    const buffer = `claude-slack-${process.pid}-${Date.now()}`
    await tmux(['set-buffer', '-b', buffer, '--', text])
    // -p brackets the paste so a newline inside stays part of the message; -d drops the buffer afterwards.
    await tmux(['paste-buffer', '-p', '-d', '-b', buffer, '-t', pane])
    await new Promise((r) => setTimeout(r, 150))
    await tmux(['send-keys', '-t', pane, 'Enter'])
  },
  async capture(pane) {
    return tmux(['capture-pane', '-p', '-t', pane])
  },
  async captureAnsi(pane, history) {
    return tmux(['capture-pane', '-p', '-e', ...(history ? ['-S', `-${history}`] : []), '-t', pane])
  },
  async growHeight(pane, rows) {
    try {
      const [win, height, attached] = (await tmux(['display-message', '-p', '-t', pane, '#{window_id} #{window_height} #{session_attached}'])).trim().split(' ')
      if (!win || Number(attached) > 0 || Number(height) >= rows) return false
      await tmux(['resize-window', '-t', win, '-y', String(rows)])
      return true
    } catch {
      return false
    }
  },
  async killPane(pane) {
    await tmux(['kill-pane', '-t', pane])
  },
  async hasPane(pane) {
    try {
      const out = await tmux(['list-panes', '-a', '-F', '#{pane_id}'])
      return out.split('\n').includes(pane)
    } catch {
      return false
    }
  },
}

async function hasSession(): Promise<boolean> {
  try {
    await tmux(['has-session', '-t', `=${TMUX_SESSION}`])
    return true
  } catch {
    return false
  }
}

function shellQuote(s: string): string {
  return /^[A-Za-z0-9_\-./:=@]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`
}

/** Effort as Claude Code prints it: the startup header ("… with low effort") or the /effort hint ("low · /effort"). */
export function detectEffort(screen: string): string | null {
  const m = /\bwith (low|medium|high|xhigh|max) effort\b/i.exec(screen) ?? /\b(low|medium|high|xhigh|max)\s*·\s*\/effort/i.exec(screen)
  return m ? m[1]!.toLowerCase() : null
}

/** Read the permission mode Claude Code shows in its status line. */
export function detectPermissionMode(screen: string): string | null {
  if (/auto mode on/i.test(screen)) return 'auto'
  if (/accept edits on/i.test(screen)) return 'acceptEdits'
  if (/plan mode on/i.test(screen)) return 'plan'
  if (/bypass(ing)? permissions/i.test(screen)) return 'bypassPermissions'
  if (/manual mode on/i.test(screen)) return 'default'
  return null
}

/**
 * Several pollers (the stall watchdog, post-command checks, the dialog driver)
 * can want the same pane at the same moment. Share one `capture-pane` process
 * between concurrent callers instead of spawning one each. Only in-flight calls
 * are shared, so no caller ever sees a stale screen.
 */
export function withCoalescedCaptures(t: TmuxLike): TmuxLike {
  const inFlight = new Map<string, Promise<string>>()
  return {
    ...t,
    capture(pane) {
      const running = inFlight.get(pane)
      if (running) return running
      const p = t.capture(pane).finally(() => inFlight.delete(pane))
      inFlight.set(pane, p)
      return p
    },
  }
}

export const realTmux: TmuxLike = withCoalescedCaptures(rawTmux)

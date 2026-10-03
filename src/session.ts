/**
 * One Claude Code session as the broker sees it: the tmux window it runs in,
 * the Slack thread it is bound to, and the per-turn state that only lives in
 * memory (a broker restart recovers what it can from the screen and transcript).
 */
import type { Conn } from './ipc.ts'
import type { TranscriptTailer } from './transcript.ts'
import type { TurnStream } from './stream.ts'
import type { SessionState } from './panel.ts'

export interface Session {
  /** Unique per launch (launcher UUID), never a display name. */
  key: string
  pid: number
  sessionId: string
  cwd: string
  threadTs: string
  /** A name a person gave (`:rename`, the web app). Slack still follows Claude Code's ai-title; the web app shows this first. */
  manualTitle?: string
  /** The model given at launch or with /model (e.g. opus[1m]); `model` follows the transcript, which drops [1m]. */
  launchModel?: string
  /** "끝나면 새로고침": when it was asked for; the refresh runs once the session is idle and its background work ended. */
  refreshAfter?: number
  /** A scheduled-refresh check is under way (set before its first await, so two cannot run at once). */
  refreshChecking?: boolean
  /** Background work that a refresh cut off, told to the relaunched session first. */
  interrupted?: Array<{ kind: string; label: string }>
  /** How often each dialog was surfaced lately, so one that keeps coming back is explained once instead of carded forever. */
  dialogSeen?: Map<string, { n: number; at: number }>
  /** Bot-owned root message (terminal-started sessions). Editable. */
  rootTs?: string
  origin: 'terminal' | 'slack'
  pane?: string
  window?: string
  conn?: Conn
  ended: boolean
  title?: string
  transcriptPath?: string
  tailer?: TranscriptTailer
  turn?: TurnStream
  /** Slack user the current turn streams to. */
  recipient: string
  /** Slack ts of the message that started the current turn, for reactions. */
  triggerTs?: string
  lastInjected?: string
  statusCreated: boolean
  panelTs?: string
  state: SessionState
  model?: string
  effort?: string
  permissionMode?: string
  panelTimer?: ReturnType<typeof setTimeout>
  panelDue?: number
  /** Text Claude sent via the reply tool this turn, to avoid mirroring it twice. */
  lastReplyText?: string
  /** When a command's screen was last posted, so its printed output in the transcript is not posted twice. */
  screenShownAt?: number
  /** Final text of the last turn, so a late transcript read does not re-stream it. */
  lastFinalText?: string
  /** Archive and delete the thread once the session ends. */
  purgeOnEnd?: boolean
  startedAt: number
  /** Watchdog: fires when a busy session shows no transcript activity for a while. */
  stallTimer?: ReturnType<typeof setTimeout>
  stallSince?: number
  /** The dialog already surfaced for this screen, so it is not posted twice. */
  stallShown?: string
  /** The "still working" notice for this turn, edited in place instead of reposted. */
  quietTs?: string
  /** The picture of the screen was already posted for this quiet spell; later notices only say how long. */
  quietImage?: boolean
  /** The checklist message for this session, edited in place as the plan progresses. */
  todoTs?: string
  /** Last rendered checklist, so an unchanged update is not re-sent. */
  lastTodoText?: string
  /** Context usage as last read from the terminal, e.g. "37%". */
  contextLabel?: string
  /** Last rendered root line, so an unchanged update is not re-sent. */
  lastRootText?: string
  /** Tool calls rendered somewhere else, so they get no task card and no result card. */
  silentTools?: Set<string>
  /**
   * Messages that arrived while a tool call was running. Delivered when the
   * tool finishes, like Claude Code's own queue, or at once on "지금 보내기".
   */
  /** `:refresh` killed this process on purpose; its end reopens the same conversation instead of announcing a close. */
  refreshing?: boolean
  held?: HeldMessage[]
  /** The one "held, [send now] [drop]" notice for the current batch, edited as it grows. */
  holdNoticeTs?: string
  /** An injected message we have not yet seen start a turn; checked after a short delay. */
  injectCheck?: { text: string; ts: string; user: string; attempts: number; timer?: ReturnType<typeof setTimeout> }
  /** Why the session is waiting on a person, for the status line and the Home tab. */
  waitingReason?: WaitingReason
  waitingSince?: number
  /** When to @-mention the user: on decisions only (default), on everything, or never. */
  notify?: NotifyMode
  /** How much of a turn to mirror: no tool cards, the usual cards, or everything. */
  view?: ViewMode
  /** "전부 허용" (`:auto on`): the broker allows every permission request itself and leaves a record card. */
  autoAllow?: boolean
  /** Watches the terminal's own permission mode while autoAllow is on (REQ-F-030-ish): a tool bypasses the broker entirely when the terminal itself is not in manual mode. */
  autoAllowWatch?: ReturnType<typeof setInterval>
  /** The last PreToolUse seen, so a permission card can show the actual edit rather than a one-line preview. */
  lastToolInput?: { name: string; input: unknown; at: number }
  /** The stuck state already reported for this screen, so it is not posted twice. */
  stuckShown?: string
  /** Dialog answers waiting for the prompt to release the keyboard, one per dialog. */
  dialogRetries?: Map<string, { cancel: () => void }>
  /** Calls the person once a wait (question, plan, dialog, stopped turn) has gone on too long. */
  waitingTimer?: ReturnType<typeof setTimeout>
  /** When we last sent Esc ourselves, so the interrupted turn's late Stop is not taken for the new turn's. */
  escAt?: number
}

export interface HeldMessage {
  text: string
  user: string
  ts: string
}

export type WaitingReason = 'permission' | 'question' | 'plan' | 'instruction' | 'dialog'
export type NotifyMode = 'decisions' | 'on' | 'off'
export type ViewMode = 'summary' | 'normal' | 'verbose'

export const WAITING_LABEL: Record<WaitingReason, string> = {
  permission: '권한 대기',
  question: '질문 대기',
  plan: '플랜 승인 대기',
  instruction: '지시 대기',
  dialog: '터미널 확인 대기',
}

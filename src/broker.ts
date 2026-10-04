import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import type { Conn } from './ipc.ts'
import { WAITING_LABEL, type HeldMessage, type NotifyMode, type Session, type ViewMode, type WaitingReason } from './session.ts'
import type { Fields, Level, Logger } from './log.ts'
import { detectStuckState, inputBoxHas, classifierDenial, isToolEcho, subagentReport, WORKING_RE } from './stuck.ts'
import { SessionRegistry } from './registry.ts'
import { RecentKeys } from './dedupe.ts'
import { OffsetStore } from './offsets.ts'
import { ReviveStore, type ReviveEntry } from './revive.ts'
import type { HookEvent, ToBroker, ToChannel } from './protocol.ts'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { readdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { SlackApi, InMsg, InAction, InStop, InCommand, InView } from './slack.ts'
import { detectEffort, detectPermissionMode, type TmuxLike } from './tmux.ts'
import { cursorKeys, DialogDriver, isProceedDialog, parseDialog, parseKeyedDialog, questionTag, promptHoldsFocus } from './dialog.ts'
import { ACTION, decodeAnswer, decodeResume, decodeValue, encodeValue, isAction, isPanelBlockId, questionBlockId } from './actions.ts'
import { TurnStream } from './stream.ts'
import { lastModelInTranscript, readSessionText, transcriptPathFor, transcriptTurnLooksOpen, TranscriptTailer, transcriptUuids, type TranscriptEvent } from './transcript.ts'
import { normalizeMessage, sameMessage } from './format.ts'
import { activityDetails, activityLine, activitySources, alertBlock, chunk, describeError, extractChoices, processAlive, detectContextUsage, duration, expandHome, parseColumns, tableBlock, todoPlanBlock, parseTodos, todoList, type Todo, parseLaunchText, PERMISSION_REPLY_RE, screenDigest, shortenHome, systemEnvelope, toMrkdwn, truncate } from './format.ts'
import { btn, answeredBlocks, choiceBlocks, EFFORT_OPTIONS, MODEL_OPTIONS, PERMISSION_MODES, refreshPicker, confirmBlocks, controlPanel, heldNoticeBlocks, keyedDialogBlocks, markAnswered, shortModel, newSessionEntry, newSessionModal, NEW_SESSION_BLOCK_ID, NEW_SESSION_VIEW_ID, permissionBlocksV2, planApprovalBlocks, questionBlocks, homeView, resumePicker, settingsModal, stuckBlocks, SETTINGS_VIEW_ID, type PanelState, type PurgeScope, type Question, type SessionState } from './panel.ts'
import { renderScreenPictures, type ScreenPicture } from './terminal-image.ts'
import { PinStore } from './pins.ts'
import { TitleStore } from './titles.ts'
import { StatusStore, DEFAULT_STATUS_DIR } from './status.ts'
import { stableNodePath } from './node-path.ts'
import { ThreadLinks } from './thread-links.ts'
import { countUserMessages, deleteRecentSession, listRecentSessions, readFirstMessage, type RecentSession } from './sessions-list.ts'
import { countArchives, deleteArchive, findArchiveByThread, listArchives, renameArchive, writeArchive, type ArchivedMessage, type SessionArchive } from './archive.ts'
import { PurgeService } from './purge.ts'
import { EventLog, type EventBody, type SessionEvent } from './events.ts'
import { attachedImagePaths, ImageStore, type WebImage } from './images.ts'
import { moveToTrash, repoStates, trashRefusal, type RepoState } from './trash.ts'
import { writingPreview } from './preview.ts'
import { branchPr, linksIn, prInfo, repos, sortPrs, type Link } from './links.ts'
import { GroupStore, type GroupOp, type GroupsState } from './groups.ts'
import { NoticeStore, type Notice } from './notices.ts'
import { parseSlackLink, ThreadInfoStore } from './thread-info.ts'
import { computeStats, prSummary, type StatDays, type StatThread } from './stats.ts'
import { prViewPages } from './pr-view.ts'
import { originHosts, prHosts } from './links.ts'
import { BackgroundTracker, parseTaskNotifications, processFacts, type BackgroundTask } from './background.ts'
import { githubAccounts, SkillLineReader, sessionPlugins, type PluginLine } from './plugins.ts'
import { availableSkills, skillMenu, SkillUsage } from './skills.ts'
import { execFile } from 'node:child_process'
import { REPO_ROOT } from './config.ts'
import { AsyncLocalStorage } from 'node:async_hooks'

export type { Session } from './session.ts'

/** A dialog is on screen but keystrokes would land in the prompt: the broker will press once the prompt lets go. */
const RETRY_NOTE = '⏳ 터미널이 프롬프트 입력을 받는 중이라 확인 창을 아직 못 눌렀습니다. 응답이 끝나는 대로 자동으로 누릅니다.'
/** The wait ran out (a minute) and the person has to press again. */
const UNFOCUSED_NOTE = '⏳ 1분을 기다렸지만 터미널이 계속 프롬프트 입력을 받고 있어 확인 창을 대신 누르지 못했습니다. 응답이 끝난 뒤 다시 눌러 주세요.'

function imagesDir(): string {
  return process.env.CLAUDE_SLACK_IMAGES_DIR || join(homedir(), '.claude-slack', 'images')
}

/** What the admin page renders. Plain data, no Slack or tmux objects. */
/** One row of the web app's session list. */
export interface WebSession {
  /** Put to rest (45): grey in the list, woken by a message or a terminal prompt. */
  resting?: boolean
  pid: number
  thread: string
  cwd: string
  title?: string
  state: SessionState
  waiting?: string
  waitingSince?: number
  model?: string
  effort?: string
  permissionMode?: string
  contextLabel?: string
  startedAt: number
  /** Messages held until the running tool finishes. */
  held: number
  /** The oldest permission card still open, for the web app's modal. */
  permission?: { ts: string; text: string; blocks: unknown[] }
  /** Runs in a tmux pane, so keys and the screen are available. */
  canKeys: boolean
  /** "전부 허용": the broker answers every permission request with allow. */
  autoAllow: boolean
  /** "끝나면 새로고침" is waiting for the work to end. */
  refreshAfter?: boolean
  /** The user's own plugins as this process runs them (and a newer installed version). */
  plugins?: Array<{ market: string; version: string; latest?: string }>
  lastSeq: number
  lastAt: number
  preview?: string
  /** The newest message in the thread (this broker run), and whether the person said it. */
  last?: { text: string; mine: boolean }
  /** The status line's context use, as a percentage text (43). Falls back to the terminal's reading. */
  /** 75: the list's state beside the badge: 코딩 중 while a turn writes code. */
  coding?: boolean
  /** 75: the PR review loop is running. */
  reviewLoop?: boolean
  /** 75: background work still running after the turn ended (titles). */
  background?: string[]
  context?: string
  /** The context window and what it holds: `used` is rounded to 1,000 tokens (43). */
  contextWindow?: { size: number; used: number }
  /** The plan's usage in percent, five-hour and weekly (43). */
  usage?: { fiveHour?: number; sevenDay?: number; fiveHourResetsAt?: number; sevenDayResetsAt?: number }
  /** The transcript's size in MB, one decimal (43). */
  transcriptMb?: number
  /** SESSION.md in the session folder, when there is one (43). */
  sessionMd?: { bytes: number; max: number }
  /** The tools running in this turn, by title (43). */
  running?: string[]
  /** Quiet for over 90 s in a turn (43). */
  quietMs?: number
}

export interface AdminState {
  channelId: string
  live: Array<{
    pid: number
    key: string
    cwd: string
    title?: string
    state: SessionState
    model?: string
    effort?: string
    permissionMode?: string
    contextLabel?: string
    startedAt: number
    busy: boolean
    window?: string
    /** The session runs in a tmux pane we can read, whether or not the broker started it. */
    canScreen?: boolean
    threadTs: string
    waiting?: string
    preview?: string
    link?: string
    messages?: number
    sessionId?: string
  }>
  /** Keys of the rows pinned to the top, see pins.ts. */
  pins: string[]
  recent: RecentSession[]
  archives: ReturnType<typeof listArchives>
}

export interface ThreadView {
  title: string
  cwd: string
  sessionId: string
  archivedAt?: string
  /** Still in Slack (read just now), not from an archive file. */
  live?: boolean
  messages: Array<{ ts: string; user?: string; bot: boolean; text: string; blocks?: unknown[] }>
}

export interface Orphan {
  ts: string
  kind: 'ended' | 'dormant' | 'unknown'
  title: string
  replies: number
  /** ms of the newest message in the thread. */
  at: number
  /** The conversation behind an ended or dormant thread, so it can be reopened there. Absent when nothing is known of it. */
  sessionId?: string
}

/** Rows of the terminal a screen picture shows, and the scrollback added above them when there is any. */
const SCREEN_ROWS = 80
const SCREEN_HISTORY = 120
/** How far up the 쓰는 중 preview reads (15/39): long answers scroll their head off the screen. */
const LIVE_HISTORY = 200
const ORPHAN_SCAN_LIMIT = 400
const ORPHAN_SCAN_TTL_MS = 30_000

export interface BrokerConfig {
  /** Where the pinned rows are kept. Tests use a temp file. */
  pinsPath?: string
  titlesPath?: string
  /** Where `scripts/statusline.ts` writes each session's last statusLine read (default ~/.claude-slack/status). */
  statusDir?: string
  /** The generated `--settings` file registering that statusLine command (default ~/.claude-slack/statusline-settings.json). Set to '' in tests to skip writing one. */
  statusLineSettingsPath?: string
  /** How often transcripts are sized for the 50MB/100MB notices (P4-32). Default 30,000 ms. */
  sizeCheckMs?: number
  /** Where the web app's session events are kept (one file per thread). */
  eventsDir?: string
  /** Where pictures shown in the web app are kept. */
  webImagesDir?: string
  /** The web app's groups (default ~/.claude-slack/groups.json). */
  groupsPath?: string
  /** "기본 프롬프트": added to every session launched (default ~/.claude-slack/default-prompt.txt). */
  defaultPromptPath?: string
  /** Where "폴더 버리고 종료" moves a folder (default ~/.Trash). */
  trashDir?: string
  /** The notification center's file (49); tests point it at a temporary one. */
  noticesPath?: string
  /** The Slack thread info file (51); tests point it at a temporary one. */
  threadInfoPath?: string
  /** The home folder new sessions and the folder picker stay under (tests use a temporary one). */
  homeDir?: string
  /** The GitHub account whose marketplaces count as the user's own (default: asked of gh once). */
  githubUser?: string
  /** Skill call counts (default ~/.claude-slack/skill-usage.json) and the conversations counted (~/.claude/projects). */
  skillUsagePath?: string
  claudeProjectsDir?: string
  /** Where ~/.claude is (tests use a temporary one). */
  claudeDir?: string
  /** Where Claude Code keeps plugins (tests use a temporary one). */
  pluginsDir?: string
  /** PR states by address (tests fake gh). */
  prInfo?: (urls: string[]) => Promise<Link[]>
  /** How often a scheduled refresh looks again (default a minute). */
  refreshCheckMs?: number
  /** When a process started and how many shells it has open (tests fake it). */
  processFacts?: (pid: number) => Promise<{ startedAt?: number; shells?: number }>
  /** Does a conversation's folder still exist (tests fake it). */
  folderExists?: (path: string) => boolean
  /** Draw terminal screens as pictures (default on); text when off or when rendering fails. */
  screenImages?: boolean
  /** Renders a screen with colours to its pictures (one, or the conversation and its side panel). Tests replace it so no browser starts; a single Buffer is one picture. */
  renderScreen?: (ansi: string, opts: { title?: string; maxRows?: number }) => Promise<Buffer | ScreenPicture[]>
  /** Pause between two message deletes of a purge (ms). Tests set 0. */
  purgeGapMs?: number
  /** Where the not-yet-deleted messages of a purge are remembered. */
  pendingPurgesPath?: string
  /** Removes a saved conversation by session id. Tests replace it so they never touch ~/.claude. */
  deleteSession?: (id: string) => Promise<boolean>
  /** Type a message held during a turn into the terminal instead of sending it through the channel (default on). */
  midTurnKeys?: boolean
  channelId: string
  allowedUsers: Set<string>
  defaultCwd: string
  launcher: string
  socketPath?: string
  /** Batch interval for stream appends. Tests lower it. */
  flushMs?: number
  /** How often an in-flight tool call re-pings the stream. Tests lower it. */
  heartbeatMs?: number
  /** Override for tests. */
  listSessions?: (limit: number) => RecentSession[] | Promise<RecentSession[]>
  /** Where purged threads are archived. */
  archiveDir?: string
  /** Where transcript read positions are remembered. Tests point this elsewhere. */
  offsetsPath?: string
  /** Where the sessions alive at shutdown are remembered, for reviving them. Tests point this elsewhere. */
  revivePath?: string
  /** How long to let shims reconnect before deciding a session needs reviving. Tests lower it. */
  reviveAfterMs?: number
  /** How long a launched session has to connect before we give up on it. Tests lower it. */
  launchTimeoutMs?: number
  /** How stale a remembered session may be and still be worth reviving. */
  reviveMaxAgeMs?: number
  /** A user token is configured, so purge removes the user's own messages as well. Only changes wording. */
  userToken?: string
  /** How long a busy session may go without transcript activity before we look at the terminal. Tests lower it. */
  stallMs?: number
  /** How often, while 전부 허용 is on, to check the terminal is still in manual mode. Tests lower it. */
  autoAllowCheckMs?: number
  /** How often restart-when-idle checks whether every session has gone idle. Tests lower it. */
  restartCheckMs?: number
  /** How long the quiet must last before we say anything about it. Tests lower it. */
  quietMs?: number
  /** How long after start a thread that was alive before shutdown is given to reattach. Tests lower it. */
  startupGraceMs?: number
  /** How often to poll for that reattachment. Tests lower it. */
  reattachPollMs?: number
  /** Override for tests. */
  transcriptPathFor?: (cwd: string, sessionId: string) => string | undefined
  /** How long after injecting a message we expect to see it start a turn. Tests lower it. */
  injectVerifyMs?: number
  /** How long an unanswered decision waits before the user is called again. Tests lower it. */
  remindMs?: number
  /** How long before the second call goes to a DM. Tests lower it. */
  remindDmMs?: number
  /** How long a dialog answer keeps waiting for the prompt to let go of the keyboard. Tests lower it. */
  dialogRetryMs?: number
  /** Poll interval for that wait. */
  dialogRetryPollMs?: number
  /** How long after Esc we look at the screen to say what happened. Tests lower it. */
  escSettleMs?: number
}

/** Long enough for a live session's shim to reconnect, so a plain restart revives nothing. */
const REVIVE_AFTER_MS = 15_000
/** For this long after a broker start, a thread whose session has not reattached yet is given the benefit of the doubt. */
const STARTUP_GRACE_MS = 20_000
/** How often to check whether a session everyone is waiting for has reattached. */
const REATTACH_POLL_MS = 200
/** Older than this and the machine has been off long enough that reopening is noise, not recovery. */
const REVIVE_MAX_AGE_MS = 12 * 60 * 60 * 1000
/** A dozen sessions waking at once would be a surprise; the newest are the ones in use. */
const REVIVE_MAX = 5
/** Live sessions have their clock refreshed about once a minute, so anything this far behind the newest was already gone at shutdown. */
const ALIVE_AT_SHUTDOWN_MS = 3 * 60 * 1000
/** A thread we did not reopen can still be woken by writing in it, for this long. */
const DORMANT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000

const STALL_MS = 15_000
/** After this long with no activity and no dialog, show the screen once so the user sees where it is stuck. */
const STALL_SCREEN_MS = 90_000
/** A hook delivered twice (user + project config) arrives within this window. */
const HOOK_DEDUPE_MS = 2000
/** A mobile double-tap delivers the same button twice within this window. */
const ACTION_DEDUPE_MS = 1500
/** A web message repeated within this window is a double send, not a second message (17/40). */
const WEB_SEND_DEDUPE_MS = 1500
/** Cut a string to at most `maxBytes` of UTF-8, at a character boundary (46). */
function cutUtf8(s: string, maxBytes: number): string {
  let out = ''
  let bytes = 0
  for (const ch of s) {
    const b = Buffer.byteLength(ch)
    if (bytes + b > maxBytes) break
    out += ch
    bytes += b
  }
  return out
}

/** How long a command's dialog may take to appear after we type it. */
const POST_COMMAND_DIALOG_MS = 3000
const POST_SLASH_DIALOG_MS = 2000
const LOCAL_OUTPUT_DEDUPE_MS = 20_000
const ANSI_RE = /\x1b\[[0-?]*[ -\/]*[@-~]/g
const DIALOG_POLL_MS = 300
/** shift+tab cycles permission modes; this many presses covers the whole cycle. */
const MODE_CYCLE_TRIES = 5
/** Poll interval while waiting for a command's output to stop redrawing. */
const SCREEN_SETTLE_MS = 400
const BTW_TIMEOUT_MS = 60_000
const BTW_POLL_MS = 400
const LIGHTFORK_TIMEOUT_MS = 180_000
const LIGHTFORK_POLL_MS = 1_000
const LIGHTFORK_MAX_CHARS = 20_000
/** Longer than this, SESSION.md is asked about before a light copy (46). */
const LIGHTFORK_FILE_MAX = 20_000
/** How many conversations of ended sessions the past records keep (47). */
const ENDED_ARCHIVE_MAX = 100
const SCREEN_SETTLE_TIMEOUT_MS = 4000
/** Lines kept from a screen: enough for a glance, few enough to read on a phone. */
const SCREEN_DIGEST_LINES = 20
/** A command's own output is what was asked for, so keep more of it. */
const SCREEN_OUTPUT_LINES = 40
/** Commands whose output is columns of numbers, worth rendering as a table. */
const TABULAR_COMMANDS = /^\/(context|usage|cost)\b/
/** Panel edits are batched: Slack rate-limits message updates. */
const PANEL_REFRESH_MS = 2000
const PANEL_REFRESH_FAST_MS = 400
const PANEL_REFRESH_SETTLE_MS = 500
/** A launched session that never says hello within this window is reported as failed. */
const LAUNCH_TIMEOUT_MS = 90_000
/** A launch or exit arrives as a burst; publish the Home tab once after it settles. */
const HOME_REFRESH_MS = 1000
/** Hooks that can arrive twice, once per config level. */
const DEDUPED_HOOKS = new Set(['UserPromptSubmit', 'Stop', 'PreToolUse', 'SessionEnd'])
/** A channel message shows up as a UserPromptSubmit within a few seconds; longer than that and it did not land. */
const INJECT_VERIFY_MS = 5000
const INJECT_MAX_ATTEMPTS = 2
const INJECT_MAX_ENTERS = 3
/** Slack's per-thread reply is silent on a phone that is not in the thread; after this long we call the person. */
const REMIND_MS = 5 * 60 * 1000
/** Then, if still nothing, a direct message. */
const REMIND_DM_MS = 10 * 60 * 1000
/** How long a dialog answer waits for the prompt to release the keyboard before giving up. */
const DIALOG_RETRY_MS = 60_000
const DIALOG_RETRY_POLL_MS = 500
/** After Esc, give the TUI a moment to draw "Interrupted" before reading the screen. */
const ESC_SETTLE_MS = 1000
/** A Stop hook this soon after our own Esc, with the new turn still empty, belongs to the turn we cut. */
const LATE_STOP_MS = 5000
/** A subagent report is worth reading in full, but not without end. */
const REPORT_MAX_CHARS = 6000
/** A permission card matches the PreToolUse that preceded it only if they are this close. */
const TOOL_INPUT_MATCH_MS = 15_000
/** How much of a typed prompt is mirrored before folding. */
const PROMPT_MIRROR_MAX = 600
/** How long `:mode` waits for the status line to redraw after each shift+tab. */
const MODE_SETTLE_POLL_MS = 100
const MODE_SETTLE_MAX_MS = 1200
const AUTO_ALLOW_CHECK_MS = 30_000
const AUTO_ALLOW_PRESS_TRIES = 3
const AUTO_ALLOW_PRESS_RETRY_MS = 1_000
const READ_SESSION_MAX_CHARS = 40_000
const RESTART_CHECK_MS = 3_000
const SIZE_CHECK_MS = 30_000
const SIZE_WARN_BYTES = 50 * 1024 * 1024
const SIZE_BLOCK_BYTES = 100 * 1024 * 1024
const READ_SESSION_MAX_CHARS_CAP = 200_000
// 18: a web message's picture limits, checked here (never just in the page that happened to send them).
const WEB_IMAGES_MAX = 8
/** The default prompt when none is set (54). */
const BUILTIN_DEFAULT_PROMPT = '나는 한국어를 읽어. 페이지에 보이는 글은 모두 한국어로 써 줘: 최종 답, 도구를 쓰는 사이사이 쓰는 짧은 설명, reply 메시지까지. 코드·명령·파일 경로·식별자·인용한 출력은 원래 그대로 둬.'
/** Claude Code's own permission modes (the ones `--permission-mode` takes). */
const CLAUDE_PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto']
/** Tools that write code: a turn using one is 코딩 중 in the list (75). */
const CODING_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
/** How many just-ended sessions the list keeps (43). */
const RECENT_ENDED_MAX = 10
/** A turn quiet this long shows as 'no new output' (43, §4.3.3). */
const QUIET_MS = 90_000
const WEB_IMAGES_BASE64_MAX = 3_145_728
const WEB_IMAGE_BYTES_MAX = 10 * 1024 * 1024
const DIALOG_CLOSE_TRIES = 5
const DIALOG_CLOSE_SETTLE_MS = 150

/** A launch that was requested and has not said hello yet: a list row with no pid (43). */
function startingRow(p: PendingLaunch): WebSession {
  return { pid: 0, thread: p.threadTs, cwd: p.cwd, state: 'starting', startedAt: Date.now(), held: 0, canKeys: false, autoAllow: false, lastSeq: 0, lastAt: Date.now() }
}

interface PendingLaunch {
  threadTs: string
  /** The name the new session takes when it says hello (46: a copy is "<name>의 사본"). */
  title?: string
  /** The conversation being reopened, so a second request for it is refused while this one is coming up. */
  resumeId?: string
  rootTs?: string
  statusTs?: string
  cwd: string
  prompt: string
  pane: string
  window: string
  /** Typed while the session was still coming up; delivered once it attaches. */
  queued: Array<{ text: string; user: string; ts: string }>
  /** What it was launched with (--model / --effort), known before any hook or screen says so. */
  model?: string
  effort?: string
  /** Said once that the launch is taking a while but the pane is still there, so it is not said again every timeout. */
  warnedLate?: boolean
}

/** What a command handler is given. The pane is known to exist. */
interface CommandContext {
  session: Session
  pane: string
  /** The whole command, e.g. `answer 0 1 Yes`. */
  cmd: string
  /** Tokens after the name. */
  args: string[]
  /** Everything after the name, joined. */
  arg: string
  post(text: string): Promise<unknown>
  /** Answers the clicker only when a button triggered this, else the thread. */
  ack(text: string): Promise<unknown>
  fromButton: boolean
  /** The button's message and who pressed it, when a button triggered this. */
  messageTs?: string
  user?: string
}

interface CommandSpec {
  /** A user may type this after `:`. Without it the command is internal: panel buttons only. */
  user?: boolean
  /** Works without a tmux pane: it changes the broker's own handling, not the terminal. */
  noPane?: boolean
  run: (c: CommandContext) => Promise<void>
}

const HELP = [
  '*이 스레드는 Claude Code 세션 하나에 연결되어 있습니다.*',
  '• 그냥 글을 쓰면 세션에 프롬프트로 들어갑니다. 작업 중 표시의 중단 버튼이 터미널의 Esc입니다.',
  '• `/compact` `/model opus` `/review` 처럼 `/`로 시작하면 Claude Code 명령으로 터미널에 그대로 들어갑니다. `!npm test` 처럼 `!`는 bash 모드. Slack이 `/`를 가로채면 `:/명령`.',
  '• 세션 제어: `:esc` 중단 · `:screen` 화면(`:screen raw` 전체) · `:status` 상태 · `:answer 2` 번호 응답 · `:key Down Enter` 키 입력 · `:type 텍스트` 타이핑 · `:canvas` 기록을 캔버스로 · `:refresh` 세션 다시 열기(스킬·플러그인 반영) · `:kill` Slack에서 띄운 세션 종료',
  '• 도구가 도는 중에 보낸 메시지는 붙잡았다가 도구가 끝나면 전달합니다. 바로 보내려면 안내의 *지금 보내기* 또는 `:now`.',
  '• `:notify decisions|on|off` 멘션 알림 · `:view summary|normal|verbose` 보기 · `:rename 이름` · `:btw 질문` 옆길 질문 · `:tell <세션> 메시지` 다른 세션에 전달 · `:retract` 방금 보낸 메시지 철회 · `:context` 비용·모델·200k 근접 여부 · `:lightfork` SESSION.md 로 가벼운 새 세션에 이어가기',
  '• 권한 요청은 버튼으로, 또는 `yes abcde` / `no abcde` 로 답합니다. `:auto on` 이면 브로커가 모든 권한 요청을 바로 허용하고 무엇을 허용했는지 스레드에 남깁니다(`:auto off` 로 끔).',
].join('\n')

const SLASH_HELP = '`/ccnew [경로] [프롬프트]` 새 세션 (인자 없으면 폼) · `/ccresume [id]` 이전 세션 재개 · `/cclist` 실행 중 세션 · `/cchistory` 보관된 세션 · `/ccrefresh` 세션 새로고침 · `/cchelp` 이 안내. 풀네임은 `/claude-code-new` 처럼 씁니다.'

/** Former `:` commands that just mirrored a Claude Code slash command. */
const REPLACED_COMMANDS: Record<string, string> = { mode: '/permission-mode', model: '/model', effort: '/effort', clear: '/clear', compact: '/compact', exit: '/exit', purge: '패널의 🗑 버튼' }

export class Broker {
  private registry = new SessionRegistry()
  /** The 쓰는 중 text last shown per thread: the anchor when the block's head has scrolled off (15/39). */
  private liveShown = new Map<string, string>()
  /** A hook delivered twice (user + project config) is handled once. */
  private recentHooks = new RecentKeys(HOOK_DEDUPE_MS)
  /** A mobile double-tap delivers the same button twice. */
  private recentActions = new RecentKeys(ACTION_DEDUPE_MS)
  private recentWebSends = new RecentKeys(WEB_SEND_DEDUPE_MS)
  /** The one-line result of the page's last button press, for its toast (42). */
  private lastWebNote?: string
  /** The notification center (49). */
  private notices: NoticeStore
  /** What Slack thread links are about, asked once and kept (51). */
  private threadInfos: ThreadInfoStore
  private threadInfoBusy = false
  /** The thread a page action just opened (a light copy), handed back with its result (46). */
  private lastWebThread?: string
  /** Sessions that just ended, newest last, for the list's ended section (43). */
  private recentEnded = new Map<string, WebSession>()
  /** Per-transcript size reads, every 30 s (43). */
  private transcriptSizes = new Map<string, { at: number; mb: number }>()
  private pendingLaunches = new Map<string, PendingLaunch>()
  private pendingPermissions = new Map<string, { msgTs: string; pid: number; requestId: string; toolName: string; at: number; timer?: ReturnType<typeof setTimeout>; reminded?: number; text?: string; blocks?: unknown[] }>()
  /** Block types this workspace rejected, so they are not sent (and refused) again every time. */
  private unsupportedBlocks = new Set<string>()
  /** Home tab filter per user: everything, or only sessions that need a person. */
  private homeFilter = new Map<string, 'all' | 'attention'>()
  /** transcript paths seen in hooks before the shim said hello */
  private earlyTranscripts = new Map<string, string>()
  private cfg: BrokerConfig
  private slack: SlackApi
  /**
   * The same Slack client, but what it posts is not copied into the web app's event log. For
   * messages the web app gets in a better shape from their own event (answers, the plan, the
   * person's own message) and would otherwise show twice.
   */
  private quietSlack: SlackApi
  private mirrorOff = new AsyncLocalStorage<boolean>()
  /** Session events for the web app, one numbered log per thread. */
  readonly events: EventLog
  /** Pictures shown in the web app, kept under the broker's own folder. */
  readonly images: ImageStore
  private groupStore: GroupStore
  /** Which thread a message the broker posted lives in, so its edits, deletions and reactions reach the right log. */
  private msgThread = new Map<string, string>()
  /**
   * A fork's transcript begins with a copy of the original's lines (same uuids). Read as new, the whole
   * old conversation would pour into the new thread as if said just now; these uuids are skipped.
   */
  private forkSkips = new Map<string, Set<string>>()
  /** The newest thing said in each thread, for the web list's second line. */
  private lastTexts = new Map<string, { text: string; mine: boolean }>()
  private changeListeners = new Set<() => void>()
  private changeTimer?: ReturnType<typeof setTimeout>
  private tmux: TmuxLike
  private confirmDialogs: (pane: string, done?: () => boolean) => Promise<string[]>
  /** The only thing that presses dialog keys. */
  private dialogs: DialogDriver
  /** Archiving and deleting a thread. */
  private purges: PurgeService
  /** How far each session's transcript has been read, so a restart resumes. */
  private offsets: OffsetStore
  /** Which sessions were alive, so a reboot can bring them back to their threads. */
  private revive: ReviveStore
  /** Read before the first save overwrites it, since that is the record of the run that died. */
  private wasAlive: Array<ReviveEntry & { key: string }>
  /**
   * What the previous broker recorded, kept for the sessions that reattach. `wasAlive` cannot serve: the revival pass takes it
   * and empties it at the very start, before any shim has come back, so a reattaching session found nothing to restore.
   */
  private recordedAtStart: Array<ReviveEntry & { key: string }>
  private readonly startedAt = Date.now()
  /** Threads whose session was not reopened after a restart; a message in one wakes it. */
  private dormant = new Map<string, ReviveEntry & { key: string }>()
  /** Messages that arrived while a thread's session was being reopened (woken from dormant, or refreshed). */
  private waking = new Map<string, Array<{ text: string; user: string; ts: string }>>()
  /** Plain `log(msg)` still works; a {@link Logger} adds levels, areas and fields. */
  log: ((msg: string) => void) | Logger = (m: string) => console.error(`[broker] ${m}`)

  /** Write a structured line if the logger supports it, else a plain one. DEBUG only goes to a real logger. */
  private logAt(level: Level, area: string, msg: string, fields?: Fields): void {
    const l = this.log as Partial<Logger>
    if (typeof l.at === 'function') return l.at(level, area, msg, fields)
    if (level === 'DEBUG') return
    const extra = fields ? ' ' + Object.entries(fields).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}=${v}`).join(' ') : ''
    this.log(`[${area}] ${msg}${extra}`)
  }

  /** The three values every line about a session carries, so one thread can be grepped out. */
  private tag(session: Pick<Session, 'threadTs' | 'sessionId' | 'cwd'> | undefined, more?: Fields): Fields {
    return { ...(session ? { t: session.threadTs, s: session.sessionId.slice(0, 8), p: basename(session.cwd) } : {}), ...more }
  }

  constructor(cfg: BrokerConfig, slack: SlackApi, tmux: TmuxLike, confirmDialogs: (pane: string, done?: () => boolean) => Promise<string[]> = async () => []) {
    this.cfg = cfg
    this.slack = slack
    this.threadLinks = new ThreadLinks(cfg.channelId)
    // Every message exchanged in a thread updates the link to its newest one.
    const post = slack.post.bind(slack)
    slack.post = async (o) => {
      const ts = await post(o)
      if (o.threadTs) this.threadLinks.note(o.threadTs, ts)
      return ts
    }
    const startStream = slack.startStream.bind(slack)
    slack.startStream = async (o) => {
      const ts = await startStream(o)
      this.threadLinks.note(o.threadTs, ts)
      return ts
    }
    this.events = new EventLog(cfg.eventsDir)
    this.images = new ImageStore(cfg.webImagesDir)
    this.groupStore = new GroupStore(cfg.groupsPath)
    this.notices = new NoticeStore(cfg.noticesPath)
    this.threadInfos = new ThreadInfoStore(cfg.threadInfoPath)
    this.quietSlack = this.installMirror(slack)
    this.tmux = tmux
    this.confirmDialogs = confirmDialogs
    this.dialogs = new DialogDriver(tmux, (m) => this.logAt('INFO', 'dialog', m))
    this.pinStore = new PinStore(cfg.pinsPath)
    this.titles = new TitleStore(cfg.titlesPath)
    this.status = new StatusStore(cfg.statusDir)
    this.statusLineSettingsPath = this.ensureStatusLineSettings(cfg.statusLineSettingsPath)
    this.purges = new PurgeService(slack, { archiveDir: cfg.archiveDir, gapMs: cfg.purgeGapMs, pendingFile: cfg.pendingPurgesPath, log: (m) => this.logAt('INFO', 'purge', m) })
    this.offsets = new OffsetStore(cfg.offsetsPath)
    this.revive = new ReviveStore(cfg.revivePath)
    this.wasAlive = this.revive.taken()
    this.recordedAtStart = [...this.wasAlive]
    this.armSizeCheck(cfg.sizeCheckMs)
  }

  // ------------------------------------------------------------ web mirror

  /**
   * Copy what the broker does in a session's thread into that thread's event log: posts, edits,
   * deletions, reactions, ephemeral notes. Cards keep their Slack blocks, so the web app draws the
   * same buttons and a press goes through {@link handleAction} exactly as a Slack click does.
   * Returns a client whose calls are not copied (see {@link quietSlack}).
   */
  private installMirror(slack: SlackApi): SlackApi {
    const isPanel = (blocks?: unknown[]) => !!blocks?.some((b) => typeof (b as { block_id?: unknown }).block_id === 'string' && isPanelBlockId((b as { block_id: string }).block_id))
    let n = 0
    const wrap = <K extends keyof SlackApi>(name: K, after: (args: Parameters<Extract<SlackApi[K], (...a: never[]) => unknown>>, result: unknown) => void) => {
      const orig = slack[name] as unknown
      if (typeof orig !== 'function') return
      ;(slack as unknown as Record<string, unknown>)[name] = async (...args: never[]) => {
        const result = await (orig as (...a: never[]) => Promise<unknown>).apply(slack, args)
        if (!this.mirrorOff.getStore()) {
          try {
            after(args as never, result)
          } catch (err) {
            this.logAt('WARN', 'web', `mirror ${String(name)} failed: ${describeError(err)}`)
          }
        }
        return result
      }
    }
    wrap('post', ([o], ts) => {
      if (!o.threadTs || typeof ts !== 'string' || ts === o.threadTs || isPanel(o.blocks)) return
      this.noteMsg(ts, o.threadTs)
      this.mirror(o.threadTs, { type: 'msg', ts, text: o.text, ...(o.blocks ? { blocks: o.blocks } : {}) })
    })
    wrap('update', ([ts, text, blocks]) => {
      const thread = this.msgThread.get(ts)
      if (thread) this.mirror(thread, { type: 'msg_update', ts, text, ...(blocks ? { blocks } : {}) })
    })
    wrap('delete', ([ts]) => {
      const thread = this.msgThread.get(ts)
      if (thread) this.mirror(thread, { type: 'msg_delete', ts })
    })
    wrap('react', ([ts, name]) => {
      const thread = this.msgThread.get(ts)
      if (thread) this.mirror(thread, { type: 'react', ts, name, on: true })
    })
    wrap('unreact', ([ts, name]) => {
      const thread = this.msgThread.get(ts)
      if (thread) this.mirror(thread, { type: 'react', ts, name, on: false })
    })
    wrap('postEphemeral', ([, text, threadTs, blocks]) => {
      if (threadTs) this.mirror(threadTs, { type: 'msg', ts: `eph-${Date.now()}-${++n}`, text, ephemeral: true, ...(blocks ? { blocks } : {}) })
    })
    wrap('uploadFiles', ([o], ok) => {
      if (ok) this.mirror(o.threadTs, { type: 'msg', ts: `up-${Date.now()}-${++n}`, text: o.text ?? '', files: o.paths })
    })
    const off = this.mirrorOff
    return new Proxy(slack, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver) as unknown
        if (typeof v !== 'function') return v
        return (...args: unknown[]) => off.run(true, () => (v as (...a: unknown[]) => unknown).apply(target, args))
      },
    })
  }

  private noteMsg(ts: string, thread: string): void {
    this.msgThread.set(ts, thread)
    if (this.msgThread.size > 5000) this.msgThread.delete(this.msgThread.keys().next().value!)
  }

  /** Into the log only for threads a session owns; a stray thread has no page to show it on. */
  private mirror(thread: string, body: EventBody): void {
    if (!this.registry.byThreadTs(thread)) return
    this.emitEvent(thread, body)
  }

  /** A person's message for the web: `[Image attached: …]` lines become pictures, the rest stays text. */
  private userEvent(thread: string, ts: string, raw: string, via: 'slack' | 'web' | 'terminal'): EventBody {
    const { paths, text } = attachedImagePaths(raw)
    const images = paths.map((p) => this.images.putFile(thread, p)).filter((x): x is WebImage => !!x)
    return { type: 'user', ts, text: images.length ? text : raw, via, ...(images.length ? { images } : {}) }
  }

  private emitEvent(thread: string, body: EventBody): SessionEvent | undefined {
    if (body.type === 'user' || body.type === 'text') this.lastTexts.set(thread, { text: body.text.replace(/\s+/g, ' ').trim().slice(0, 200), mine: body.type === 'user' })
    const ev = this.events.emit(thread, body)
    this.changed()
    return ev
  }

  /** Something the session list shows may have changed: tell the web app, at most a few times a second. */
  private changed(): void {
    if (this.changeTimer) return
    this.changeTimer = setTimeout(() => {
      this.changeTimer = undefined
      for (const l of this.changeListeners) {
        try {
          l()
        } catch {}
      }
    }, 250)
    this.changeTimer.unref?.()
  }

  /** The web app listens here for "the session list changed". */
  onChange(l: () => void): () => void {
    this.changeListeners.add(l)
    return () => this.changeListeners.delete(l)
  }

  private linkCache = new Map<number, { at: number; value: { prs: Link[]; threads: Link[] } }>()
  /** For the chips: the branch's PR (gh, in the folder and clones in it) or PRs mentioned; this thread and threads mentioned. */
  private linkInflight = new Map<number, Promise<{ prs: Link[]; threads: Link[] }>>()
  async webLinks(pid: number): Promise<{ prs: Link[]; threads: Link[] }> {
    const cached = this.linkCache.get(pid)
    if (cached && Date.now() - cached.at < 60_000) return cached.value
    // The same session asked twice at once (two tabs opening it): one lookup.
    const running = this.linkInflight.get(pid)
    if (running) return running
    const p = this.lookLinks(pid).finally(() => this.linkInflight.delete(pid))
    this.linkInflight.set(pid, p)
    return p
  }
  private async lookLinks(pid: number): Promise<{ prs: Link[]; threads: Link[] }> {
    const session = this.registry.byPid(pid)
    if (!session) return { prs: [], threads: [] }
    const last = this.events.last(session.threadTs)
    const texts = this.events
      .since(session.threadTs, Math.max(0, last - 2000))
      .flatMap((e) => (e.type === 'user' || e.type === 'text' ? [e.text] : e.type === 'tool_end' ? [e.output] : []))
    const fromGh = (await Promise.all(repos(session.cwd).slice(0, 5).map((r) => branchPr(r)))).filter((x): x is Link => !!x)
    const hosts = [...prHosts(), ...originHosts(session.cwd)]
    const prLinks = linksIn(texts, 'pr', hosts)
    const prs = sortPrs(fromGh.length ? fromGh : await (this.cfg.prInfo ?? prInfo)(prLinks.slice(-10)))
    const own = await this.adminThreadLink(session.threadTs).catch(() => undefined)
    // The folder's own origin host (50): a GitHub Enterprise remote's pull requests are recognised without a setting.
    const slackLinks = linksIn(texts, 'slack').filter((u) => !own || !u.startsWith(own.split('?')[0]!)).slice(-10)
    this.scheduleThreadInfo(slackLinks)
    const threads = [...(own ? [{ url: own, label: '이 세션의 스레드' }] : []), ...slackLinks.map((url) => ({ url, label: this.threadLabel(url) }))]
    const value = { prs, threads }
    this.linkCache.set(pid, { at: Date.now(), value })
    return value
  }

  /**
   * What the session is writing right now, as markdown — the whole block, not a tail (15). `''` means
   * genuinely nothing to show (idle, ended, or no pane): the caller clears whatever it was showing.
   * `undefined` means busy but no text block is on screen right now (a thinking pause between blocks,
   * or a running tool) — the caller leaves what it was already showing alone rather than blanking it.
   */
  async webLive(thread: string): Promise<string | undefined> {
    const s = this.registry.byThreadTs(thread)
    // A block still on the screen is shown whatever the state (73): only an ended or paneless session has none.
    if (!s || s.ended || !s.pane) {
      this.liveShown.delete(thread)
      return ''
    }
    try {
      const block = writingPreview(await this.tmux.captureAnsi(s.pane, LIVE_HISTORY), this.liveShown.get(thread))
      if (block === '') return undefined
      this.liveShown.set(thread, block)
      return block
    } catch {
      return undefined
    }
  }

  /** The session list as the web app shows it: cheap enough to send on every change. */
  /**
   * The user's plugins as this process runs them, by key+pid (a refresh keeps the key; a key-only cache once
   * showed the old process's versions for half a minute). Worked out off the list's path, at most every 30s.
   */
  private skillUsage?: SkillUsage
  private skillUsageRun?: Promise<void>
  /** Count skill calls now, so the first "스킬" chip is quick (about a second over all conversations, then ms). */
  warmSkillUsage(): Promise<void> {
    this.skillUsage ??= new SkillUsage({ statePath: this.cfg.skillUsagePath, projectsDir: this.cfg.claudeProjectsDir })
    this.skillUsageRun ??= this.skillUsage.update().finally(() => (this.skillUsageRun = undefined))
    return this.skillUsageRun
  }
  /** The "스킬" chip: what this session's folder can call, the person's own most-called first. */
  async webSkills(pid: number): Promise<ReturnType<typeof skillMenu>> {
    const s = this.registry.byPid(pid)
    if (!s) return { direct: [], auto: [], other: [] }
    await this.warmSkillUsage().catch(() => {})
    const claudeDir = this.cfg.claudeDir
    return skillMenu(availableSkills(s.cwd, { ...(this.cfg.homeDir ? { home: this.cfg.homeDir } : {}), ...(claudeDir ? { claudeDir } : {}) }), this.skillUsage!.counts())
  }

  private pluginCache = new Map<string, { at: number; lines: PluginLine[]; busy?: boolean }>()
  private githubUsers?: string[]
  private skillReaders = new Map<string, SkillLineReader>()
  private pluginsFor(s: Session): PluginLine[] | undefined {
    const k = `${s.key}:${s.pid}`
    const c = this.pluginCache.get(k)
    if (!c || (Date.now() - c.at > 30_000 && !c.busy)) {
      const entry = c ?? { at: 0, lines: [] }
      entry.busy = true
      this.pluginCache.set(k, entry)
      void this.computePlugins(s).then((lines) => {
        const changed = JSON.stringify(lines) !== JSON.stringify(entry.lines)
        Object.assign(entry, { at: Date.now(), lines, busy: false })
        if (changed) this.changed()
      })
    }
    return c?.lines.length ? c.lines : undefined
  }
  private async computePlugins(s: Session): Promise<PluginLine[]> {
    // Every account gh is logged in to, on every host (a company GitHub too). A failure is not remembered: asked again next time.
    if (!this.githubUsers?.length) this.githubUsers = this.cfg.githubUser ? [this.cfg.githubUser] : await githubAccounts()
    if (!this.githubUsers.length) return []
    const facts = await (this.cfg.processFacts ?? processFacts)(s.pid).catch(() => ({}) as { startedAt?: number })
    let reader: SkillLineReader | undefined
    if (s.transcriptPath) {
      const k = `${s.key}:${s.pid}:${s.transcriptPath}`
      reader = this.skillReaders.get(k)
      if (!reader) this.skillReaders.set(k, (reader = new SkillLineReader(s.transcriptPath)))
    }
    try {
      return sessionPlugins({ pluginsDir: this.cfg.pluginsDir, user: this.githubUsers, processStart: facts.startedAt, reader })
    } catch {
      return []
    }
  }

  /** Last rows shown, so a session being refreshed keeps its line (name and place) as "뜨는 중". */
  private lastRows = new Map<string, WebSession>()
  private refreshFailed = new Map<string, number>()
  webSessions(): WebSession[] {
    const rows = this.liveRows()
    for (const r of rows) {
      this.lastRows.set(r.thread, r)
      this.recentEnded.delete(r.thread)
    }
    const shown = new Set(rows.map((r) => r.thread))
    const kept: WebSession[] = []
    for (const [thread, row] of this.lastRows) {
      if (shown.has(thread)) continue
      const failedAt = this.refreshFailed.get(thread)
      if (this.waking.has(thread) || this.pendingLaunches.has(thread)) kept.push({ ...row, state: 'starting', waiting: undefined, permission: undefined, held: 0 })
      else if (failedAt && Date.now() - failedAt < 10 * 60_000) kept.push({ ...row, state: 'ended', waiting: undefined, permission: undefined })
      else {
        // It just ended: kept for the list's ended section, the latest 10 (43).
        this.lastRows.delete(thread)
        this.recentEnded.delete(thread)
        this.recentEnded.set(thread, { ...row, state: 'ended', waiting: undefined, permission: undefined, held: 0, canKeys: false })
        while (this.recentEnded.size > RECENT_ENDED_MAX) this.recentEnded.delete(this.recentEnded.keys().next().value!)
      }
    }
    // A launch that was only requested shows at once, before its session says hello (43).
    for (const p of this.pendingLaunches.values()) {
      if (shown.has(p.threadTs) || this.lastRows.has(p.threadTs)) continue
      kept.push(startingRow(p))
    }
    return [...rows, ...kept, ...[...this.recentEnded.values()].reverse()]
  }

  /** What the list shows beside a live session, read from the status line, the transcript and the folder (43). */
  private listFacts(s: Session): Partial<WebSession> {
    const out: Partial<WebSession> = {}
    const st = this.status.get(s.key)
    if (st?.contextPercent !== undefined) out.context = `${Math.round(st.contextPercent)}%`
    else if (s.contextLabel) out.context = s.contextLabel
    if (st?.contextSize !== undefined && st.contextUsed !== undefined) out.contextWindow = { size: st.contextSize, used: st.contextUsed }
    const usage = this.status.usage()
    if (usage) out.usage = { fiveHour: usage.fiveHour, sevenDay: usage.sevenDay, fiveHourResetsAt: usage.fiveHourResetsAt, sevenDayResetsAt: usage.sevenDayResetsAt }
    if (s.transcriptPath) {
      const now = Date.now()
      let size = this.transcriptSizes.get(s.transcriptPath)
      if (!size || now - size.at >= 30_000) {
        try {
          size = { at: now, mb: Math.round(statSync(s.transcriptPath).size / 1e5) / 10 }
          this.transcriptSizes.set(s.transcriptPath, size)
        } catch {
          // Not there (yet): the size is left out.
        }
      }
      if (size) out.transcriptMb = size.mb
    }
    try {
      const st = statSync(join(s.cwd, 'SESSION.md'))
      out.sessionMd = { bytes: st.size, max: 20_000 }
    } catch {
      // No SESSION.md: left out.
    }
    const running = s.turn?.inFlight ?? []
    if (running.length) out.running = [...running]
    if (s.turn && s.stallSince && Date.now() - s.stallSince > QUIET_MS) out.quietMs = Date.now() - s.stallSince
    return out
  }

  private liveRows(): WebSession[] {
    return this.registry.live
      .filter((s) => !s.ended)
      .map((s) => ({
        pid: s.pid,
        thread: s.threadTs,
        cwd: s.cwd,
        title: s.manualTitle ?? s.title,
        state: s.state,
        waiting: s.waitingReason ? WAITING_LABEL[s.waitingReason] : undefined,
        waitingSince: s.waitingSince,
        model: s.launchModel ?? s.model,
        effort: s.effort,
        permissionMode: s.permissionMode,
        contextLabel: s.contextLabel,
        ...this.listFacts(s),
        startedAt: s.startedAt,
        held: s.held?.length ?? 0,
        canKeys: !!s.pane,
        autoAllow: !!s.autoAllow,
        ...(s.resting ? { resting: true } : {}),
        ...(s.codingTurn && s.turn ? { coding: true } : {}),
        ...(s.reviewLoop ? { reviewLoop: true } : {}),
        ...(!s.turn && s.bgTitles?.length ? { background: [...s.bgTitles] } : {}),
        ...(s.refreshAfter ? { refreshAfter: true } : {}),
        ...(this.pluginsFor(s) ? { plugins: this.pluginsFor(s) } : {}),
        lastSeq: this.events.last(s.threadTs),
        lastAt: this.lastEventAt(s.threadTs) ?? s.startedAt,
        preview: s.transcriptPath ? this.firstMessages.get(s.transcriptPath) : undefined,
        ...(this.lastTexts.get(s.threadTs) ? { last: this.lastTexts.get(s.threadTs) } : {}),
        ...(() => {
          // The oldest open permission card, so the web app can ask about it from any screen.
          const p = [...this.pendingPermissions.values()].filter((x) => x.pid === s.pid && x.blocks).sort((a, b) => a.at - b.at)[0]
          return p ? { permission: { ts: p.msgTs, text: p.text ?? '', blocks: p.blocks! } } : {}
        })(),
      }))
  }

  webGroups(): GroupsState {
    return this.groupStore.get()
  }
  webGroupOp(o: GroupOp): { ok: boolean; note: string; id?: string } {
    const r = this.groupStore.apply(o)
    if (r.ok) this.changed()
    return r
  }

  private get defaultPromptPath(): string {
    return this.cfg.defaultPromptPath ?? process.env.CLAUDE_SLACK_DEFAULT_PROMPT ?? join(homedir(), '.claude-slack', 'default-prompt.txt')
  }
  /** The instruction added to every session (--append-system-prompt), '' when none. */
  webDefaultPrompt(): string {
    try {
      return readFileSync(this.defaultPromptPath, 'utf8')
    } catch {
      // No file yet: the built-in prompt is written and used (54).
      try {
        mkdirSync(join(this.defaultPromptPath, '..'), { recursive: true })
        writeFileSync(this.defaultPromptPath, BUILTIN_DEFAULT_PROMPT)
      } catch {}
      return BUILTIN_DEFAULT_PROMPT
    }
  }
  /** The default prompt as the page shows it: the text, and whether it is the built-in one (54). */
  webDefaultPromptInfo(): { text: string; isDefault: boolean } {
    const text = this.webDefaultPrompt()
    return { text, isDefault: text === BUILTIN_DEFAULT_PROMPT }
  }
  webSetDefaultPrompt(text: string): { ok: boolean; note: string } {
    // A blank save is the built-in prompt again (54), not nothing.
    const t = (text.trim() || BUILTIN_DEFAULT_PROMPT).slice(0, 8000)
    try {
      mkdirSync(join(this.defaultPromptPath, '..'), { recursive: true })
      writeFileSync(this.defaultPromptPath, t)
    } catch (err) {
      return { ok: false, note: `저장하지 못했어요: ${describeError(err)}` }
    }
    return { ok: true, note: t ? '저장했어요. 새로 띄우거나 다시 연 세션부터 적용돼요.' : '비웠어요. 새로 띄우는 세션에는 기본 프롬프트를 넣지 않아요.' }
  }

  /** "지난 기록 모두 지우기": every archive except those of sessions still running. */
  async webClearArchives(): Promise<{ ok: boolean; note: string }> {
    const running = new Set(this.registry.live.filter((s) => !s.ended && s.sessionId).map((s) => s.sessionId))
    let n = 0
    for (const a of listArchives(10_000, this.cfg.archiveDir)) {
      if (running.has(a.sessionId)) continue
      if (deleteArchive(a.path, this.cfg.archiveDir)) n++
    }
    this.logAt('INFO', 'admin', 'archives cleared', { n })
    return { ok: true, note: `지난 기록 ${n}개를 지웠어요` }
  }

  /** The pickers' choices, the same lists the Slack settings modal offers. */
  webOptions(): { models: Array<{ label: string; value: string }>; efforts: string[]; modes: Array<{ label: string; value: string }> } {
    return { models: MODEL_OPTIONS, efforts: EFFORT_OPTIONS, modes: PERMISSION_MODES }
  }

  private lastEventAt(thread: string): number | undefined {
    const last = this.events.last(thread)
    return last ? this.events.since(thread, last - 1)[0]?.at : undefined
  }

  /** A message typed in the web app: shown in the thread as the web's, then handled exactly as a thread reply. */
  async webSend(pid: number, raw: string, pictures: Array<{ name?: string; type?: string; data: string; thumb?: string }> = []): Promise<{ ok: boolean; note: string }> {
    const session = this.registry.byPid(pid)
    if (!session || session.ended) return { ok: false, note: '이미 끝난 세션이에요' }
    return this.webDeliver(session.threadTs, raw, pictures, session)
  }

  /**
   * The same, found by thread (40): the page keeps the thread of a row it shows even while the session has no
   * pid yet (starting), or none any more (waking, dormant). Routed the way a Slack thread reply is: queued for a
   * launch or a wake in progress, woken from dormant, or sent to the live session.
   */
  async webSendThread(thread: string, raw: string, pictures: Array<{ name?: string; type?: string; data: string; thumb?: string }> = []): Promise<{ ok: boolean; note: string }> {
    const live = this.registry.byThreadTs(thread)
    if (live && !live.ended) return this.webDeliver(thread, raw, pictures, live)
    if (!this.pendingLaunches.has(thread) && !this.waking.has(thread) && !this.dormant.has(thread)) return { ok: false, note: '이미 끝난 세션이에요' }
    return this.webDeliver(thread, raw, pictures, undefined)
  }

  private async webDeliver(threadTs: string, raw: string, pictures: Array<{ name?: string; type?: string; data: string; thumb?: string }>, session: Session | undefined): Promise<{ ok: boolean; note: string }> {
    // Pictures from the page go where Slack attachments go, and reach Claude the same way: a path it can read.
    // Checked here too (18), not just client-side — a page is never the only thing that can reach this call.
    if (pictures.length > WEB_IMAGES_MAX) return { ok: false, note: `이미지는 한 번에 ${WEB_IMAGES_MAX}장까지 보낼 수 있어요` }
    // Each picture's own byte size is checked before it is added to the running total: a single
    // oversized picture should be refused as its own size, not as the (much smaller) total-size
    // message, since its base64 alone would trip that check too.
    let totalBase64 = 0
    for (const [i, p] of pictures.entries()) {
      const mime = String(p.type ?? '')
      const ext = /png/.test(mime) ? 'png' : /webp/.test(mime) ? 'webp' : /gif/.test(mime) ? 'gif' : /jpe?g/.test(mime) ? 'jpg' : undefined
      const name = p.name ?? `그림 ${i + 1}`
      if (!ext) return { ok: false, note: `이미지가 아니에요: ${name}` }
      const bytes = Math.ceil((String(p.data ?? '').length * 3) / 4)
      if (bytes > WEB_IMAGE_BYTES_MAX) return { ok: false, note: `이미지 크기가 맞지 않아요: ${name}` }
      totalBase64 += String(p.data ?? '').length
      if (totalBase64 > WEB_IMAGES_BASE64_MAX) return { ok: false, note: '이미지가 너무 커요. 몇 장씩 나눠서 보내 주세요' }
    }
    const typed = raw.trim()
    if (!typed && !pictures.length) return { ok: false, note: '보낼 내용이 없어요' }
    // The same text again within 1,500 ms is a double send (17/40); commands (`:`) are not held back by it.
    // Only read commands are exempt (74): a repeated write command within 1.5 s is a double send.
    if (!/^:(screen|status|context|help|stats)(\s|$)/.test(typed) && this.recentWebSends.isRepeat(`${threadTs}\n${typed}\n${pictures.length}`)) return { ok: false, note: '방금 보낸 글이에요. 잠시 뒤 다시 보내 주세요' }
    if (session?.handedOffTo && !typed.startsWith(':')) return { ok: false, note: '🧵 이 세션은 더 가벼운 새 스레드로 넘겨졌어요. 거기서 이어가세요.' }
    if (session?.sizeBlocked && !typed.startsWith(':')) return { ok: false, note: '🚫 대화 기록이 100MB 를 넘어 입력을 막았어요. :lightfork 로 가벼운 새 세션을 띄우거나, 터미널에서 직접 입력하세요.' }
    if (!session && (typed.startsWith(':') || typed.startsWith('!')) && this.dormant.has(threadTs) && !this.pendingLaunches.has(threadTs) && !this.waking.has(threadTs)) {
      return { ok: false, note: '쉬고 있는 세션에는 이 명령을 보낼 수 없어요. 일반 글로 보내면 깨어나요' }
    }
    const saved: string[] = []
    for (const [i, p] of pictures.entries()) {
      const mime = String(p.type ?? '')
      const ext = /png/.test(mime) ? 'png' : /webp/.test(mime) ? 'webp' : /gif/.test(mime) ? 'gif' : 'jpg'
      const buf = Buffer.from(String(p.data ?? '').replace(/^data:[^,]*,/, ''), 'base64')
      // All or nothing (40): one picture that cannot be written fails the whole message, not just that one.
      if (!buf.length || !this.images.put(threadTs, buf, p.type)) return { ok: false, note: `이미지 크기가 맞지 않아요: ${p.name ?? `그림 ${i + 1}`}` }
      const dir = imagesDir()
      mkdirSync(dir, { recursive: true })
      const path = join(dir, `${Date.now()}-web-${i}.${ext}`)
      await writeFile(path, buf)
      saved.push(path)
    }
    const text = [typed, ...saved.map((p) => `[Image attached: ${p}]`)].filter(Boolean).join('\n')
    const ts = await this.quietSlack.post({ threadTs, text: `🌐 웹: ${typed || '(그림)'}${saved.length ? ` · 그림 ${saved.length}장` : ''}` })
    if (saved.length) await this.quietSlack.uploadFiles({ threadTs, paths: saved }).catch(() => false)
    this.noteMsg(ts, threadTs)
    // The small copies the page made travel with their pictures (57), in the same order.
    const sent = this.userEvent(threadTs, ts, text, 'web')
    if (sent.type === 'user' && sent.images) sent.images = sent.images.map((im, i) => (pictures[i]?.thumb ? { ...im, thumb: pictures[i]!.thumb } : im))
    this.emitEvent(threadTs, sent)
    if (session) this.logAt('INFO', 'web', 'message', this.tag(session, { ts, chars: text.length }))
    if (!session) {
      // No live session yet: the same queues a Slack reply uses (3034–3047), or a wake from dormant.
      const msg = { text, user: 'web', ts }
      const pending = this.pendingLaunches.get(threadTs)
      if (pending) {
        pending.queued.push(msg)
        return { ok: true, note: '세션이 뜨면 바로 전달할게요' }
      }
      if (this.waking.has(threadTs)) {
        this.waking.get(threadTs)!.push(msg)
        return { ok: true, note: '세션이 뜨면 바로 전달할게요' }
      }
      await this.wakeDormant(this.dormant.get(threadTs)!, msg)
      return { ok: true, note: '보냈어요' }
    }
    // Same routing as a thread reply. In the web app `/` needs no `:` in front: nothing intercepts it there.
    if (text.startsWith(':')) await this.runThreadCommand(session, text.slice(1).trim())
    else if (text.startsWith('/') || text.startsWith('!')) await this.runCommand(session, text)
    else await this.inject(session, text, this.defaultRecipient, ts)
    return { ok: true, note: '보냈어요' }
  }

  /**
   * Take one held message back (it has not reached Claude): out of the queue, marked 취소함, and its text
   * returned so the page can put it in the field to be edited and sent again.
   */
  async webUnhold(pid: number, ts: string): Promise<{ ok: boolean; note: string; text?: string }> {
    const session = this.registry.byPid(pid)
    if (!session || session.ended) return { ok: false, note: '이미 끝난 세션입니다.' }
    const i = session.held?.findIndex((m) => m.ts === ts) ?? -1
    if (i < 0) return { ok: false, note: '이미 전달됐거나 대기 중이 아닌 메시지입니다.' }
    const [m] = session.held!.splice(i, 1)
    this.logAt('INFO', 'inject', 'held message taken back', this.tag(session, { ts, left: session.held!.length }))
    await this.slack.unreact(ts, 'hourglass_flowing_sand').then(() => this.slack.react(ts, 'x')).catch(() => {})
    if (session.holdNoticeTs) {
      if (session.held!.length) {
        const { text, blocks } = heldNoticeBlocks(session.pid, session.held!.length)
        await this.say(session, { ts: session.holdNoticeTs, text, blocks })
      } else {
        await this.slack.delete(session.holdNoticeTs).catch(() => {})
        session.holdNoticeTs = undefined
      }
    }
    this.changed()
    return { ok: true, note: '고치려고 입력칸으로 돌려놨어요', text: m!.text }
  }

  /**
   * "잘못 보냄" on a message Claude already has: a channel message cannot be taken out of the conversation
   * (it is not something /rewind reaches), so stop the turn and tell Claude plainly not to follow it.
   */
  async webRetract(pid: number, ts: string): Promise<{ ok: boolean; note: string }> {
    const session = this.registry.byPid(pid)
    if (!session || session.ended) return { ok: false, note: '이미 끝난 세션입니다.' }
    const last = this.events.last(session.threadTs)
    const said = this.events
      .since(session.threadTs, Math.max(0, last - 3000))
      .reverse()
      .find((e) => e.type === 'user' && e.ts === ts)
    if (!said || said.type !== 'user') return { ok: false, note: '그 메시지를 찾지 못했어요' }
    // The web's own wording and length (48): 80 characters, in double quotes.
    const quoted = truncate(said.text.replace(/\s+/g, ' ').trim(), 80)
    if (session.pane) await this.interrupt(this.ctx(session, 'esc'))
    const correction = `[정정] 방금 보낸 "${quoted}" 는 잘못 보낸 메시지예요. 그 지시는 따르지 마세요. 이미 파일을 바꾸거나 명령을 실행했다면 무엇을 했는지만 짧게 알려 주세요.`
    this.logAt('INFO', 'inject', 'retracted from the web', this.tag(session, { ts }))
    await this.slack.post({ threadTs: session.threadTs, text: `↩️ 웹: '${quoted}' 를 잘못 보냈다고 알렸습니다.` })
    // The wrong message is marked as dropped in the log, so every page and device shows it faded (48).
    this.emitEvent(session.threadTs, { type: 'react', ts, name: 'x', on: true })
    await this.deliver(session, correction, this.defaultRecipient, session.threadTs)
    return { ok: true, note: '멈추고 잘못 보냈다고 알렸어요' }
  }

  /** Folders that must never go to the Trash: home, the default folder, the broker's own and its state. */
  private get protectedDirs(): string[] {
    return [homedir(), this.cfg.defaultCwd, REPO_ROOT, join(homedir(), '.claude'), join(homedir(), '.claude-slack')]
  }

  /** What "폴더 버리고 종료" would do, for the page to show before it asks. */
  webTrashInfo(pid: number): { ok: boolean; note: string; folder?: string; repos?: RepoState[] } {
    const session = this.registry.byPid(pid)
    if (!session || session.ended) return { ok: false, note: '이미 끝난 세션이에요' }
    const refused = this.trashRefusalFor(session)
    if (refused) return { ok: false, note: refused, folder: session.cwd }
    return { ok: true, note: '', folder: session.cwd, repos: repoStates(session.cwd) }
  }

  /** End the session and move its folder to the Trash (never deleted). */
  /** `#채널 · 작성자 · 첫 글` once known, the address's tail until then (51). */
  private threadLabel(url: string): string {
    const parsed = parseSlackLink(url)
    const info = parsed ? this.threadInfos.get(parsed.ts) : undefined
    if (!info) return url.replace(/^https:\/\/[\w-]+\.slack\.com\/archives\//, '')
    return `#${info.channel} · ${info.user} · ${info.text}`
  }

  /**
   * Ask Slack about the thread links not known yet (51): twelve at most, two at a time. A failure waits 30 minutes,
   * a rate limit 60 s. Results are kept, so a thread is asked about once.
   */
  private scheduleThreadInfo(links: string[]): void {
    const ask = this.slack.threadInfo?.bind(this.slack)
    if (!ask || this.threadInfoBusy) return
    const wanted = links.map(parseSlackLink).filter((x): x is { channel: string; ts: string } => !!x && this.threadInfos.wanted(x.ts)).slice(0, 12)
    if (!wanted.length) return
    this.threadInfoBusy = true
    void (async () => {
      try {
        for (let i = 0; i < wanted.length; i += 2) {
          await Promise.all(
            wanted.slice(i, i + 2).map(async (w) => {
              try {
                this.threadInfos.set(w.ts, await ask(w.channel, w.ts))
              } catch (err) {
                this.threadInfos.markFailed(w.ts, /ratelimited/i.test(describeError(err)) ? 60_000 : 30 * 60_000)
              }
            }),
          )
        }
      } finally {
        this.threadInfoBusy = false
        this.changed()
      }
    })()
  }

  /** A notice for the page's notification center (49). Same key twice is not added twice. */
  private addNotice(n: Omit<Notice, 'id' | 'at'>, key?: string): void {
    if (this.notices.add(n, key)) this.changed()
  }

  /** The notification center, newest first (49). */
  webNotices(): Notice[] {
    return this.notices.list()
  }

  /**
   * Usage statistics (53): the logs' numbers, plus the person's pull requests from gh. The PR part is left out when
   * gh cannot say (no login, offline): the rest still shows.
   */
  async webStatsWithPr(days: StatDays): Promise<ReturnType<typeof computeStats> & { pr?: ReturnType<typeof prSummary> }> {
    const base = this.webStats(days)
    try {
      // The person's pull requests, merged and created, 100 at a time and at most ten pages each (53).
      const search = async (q: string) => {
        const out: Array<{ url: string; createdAt: string; mergedAt?: string | null; additions?: number; deletions?: number }> = []
        let after: string | null = null
        for (let page = 0; page < 10; page++) {
          const query = `query($q:String!,$after:String){search(query:$q,type:ISSUE,first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{... on PullRequest{url createdAt mergedAt additions deletions}}}}`
          const args = ['api', 'graphql', '-f', `query=${query}`, '-f', `q=${q}`]
          if (after) args.push('-f', `after=${after}`)
          const raw = await new Promise<string>((resolve, reject) => execFile('gh', args, { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }, (err, o) => (err ? reject(err) : resolve(o))))
          const page_ = (JSON.parse(raw) as { data: { search: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: typeof out } } }).data.search
          out.push(...page_.nodes.filter((n) => n && n.url))
          if (!page_.pageInfo.hasNextPage) break
          after = page_.pageInfo.endCursor
        }
        return out
      }
      const [merged, created] = await Promise.all([search('is:pr author:@me is:merged'), search('is:pr author:@me')])
      const byUrl = new Map<string, { url: string; createdAt: string; mergedAt?: string; additions?: number; deletions?: number }>()
      for (const p of created) byUrl.set(p.url, { url: p.url, createdAt: p.createdAt, additions: p.additions, deletions: p.deletions })
      for (const p of merged) byUrl.set(p.url, { url: p.url, createdAt: p.createdAt, mergedAt: p.mergedAt ?? undefined, additions: p.additions, deletions: p.deletions })
      // Links that came up in the tools' conversations: how many of the person's PRs (53).
      const texts = this.events.threadIds().flatMap((t) => this.events.since(t, 0).flatMap((e) => (e.type === 'user' || e.type === 'text' ? [e.text] : [])))
      const linked = new Set(texts.flatMap((t) => [...t.matchAll(/https:\/\/[\w.-]+\/[\w.-]+\/[\w.-]+\/pull\/\d+/g)].map((m) => m[0])))
      const summary = prSummary([...byUrl.values()], Date.now(), days)
      return { ...base, pr: { ...summary, linked: [...linked].filter((u) => byUrl.has(u)).length } }
    } catch {
      return base
    }
  }

  /** Usage statistics for the last 1, 7, 30 or 90 days (53), from every thread's event log. */
  webStats(days: StatDays): ReturnType<typeof computeStats> {
    const cwds = new Map<string, string>()
    for (const r of this.lastRows.values()) cwds.set(r.thread, r.cwd)
    for (const s of this.registry.live) cwds.set(s.threadTs, s.cwd)
    const threads: StatThread[] = this.events.threadIds().map((thread) => ({
      thread,
      cwd: cwds.get(thread) ?? '',
      events: this.events.since(thread, 0).map((e) => ({ type: e.type, at: e.at, via: 'via' in e ? (e as { via?: string }).via : undefined, name: 'name' in e ? (e as { name?: string }).name : undefined, state: 'state' in e ? (e as { state?: string }).state : undefined, text: 'text' in e ? (e as { text?: string }).text : undefined })),
    }))
    return computeStats(threads, Date.now(), days)
  }

  /** A pull request as the phone's page (50), kept 600 s. Only GitHub-style pull request addresses are asked. */
  private prViews = new Map<string, { at: number; title: string; pages: string[] }>()
  async webPrView(url: string, page = 0): Promise<{ ok: boolean; html?: string; note?: string; title?: string; pages?: number }> {
    const host = /^https:\/\/([\w.-]+)\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.exec(url)?.[1]
    // A host from settings, or the origin of a folder a session works in (71).
    const origins = this.registry.live.flatMap((s) => originHosts(s.cwd))
    if (!host || ![...prHosts(), ...origins].includes(host)) return { ok: false, note: 'PR 주소가 아니에요' }
    const hit = this.prViews.get(url)
    // Pages (50): a page is asked for by number; the window's buttons go through them.
    const shown = (view: { title: string; pages: string[] }) => {
      const i = Math.min(Math.max(0, Math.floor(page)), view.pages.length - 1)
      return { ok: true, html: view.pages[i], title: view.title, pages: view.pages.length }
    }
    if (hit && Date.now() - hit.at < 600_000) return shown(hit)
    try {
      const view = await prViewPages(url)
      this.prViews.set(url, { at: Date.now(), ...view })
      return shown({ ...view })
    } catch (err) {
      return { ok: false, note: `PR 을 읽지 못했어요: ${describeError(err)}` }
    }
  }

  /** Delete one past record (47): only the ones the list shows. */
  webDeleteArchive(path: string): { ok: boolean; note: string } {
    const known = listArchives(10_000, this.cfg.archiveDir).some((a) => a.path === path)
    if (!known) return { ok: false, note: '그 기록을 찾지 못했어요' }
    return deleteArchive(path, this.cfg.archiveDir) ? { ok: true, note: '기록을 지웠어요' } : { ok: false, note: '기록을 지우지 못했어요' }
  }

  /** The session folder's AGENTS.md, for the chip (57); nothing when there is none. */
  webAgentsMd(pid: number): { ok: boolean; note: string; text?: string } {
    const session = this.registry.byPid(pid)
    if (!session) return { ok: false, note: '이미 끝난 세션이에요' }
    const path = join(session.cwd, 'AGENTS.md')
    if (!existsSync(path)) return { ok: false, note: 'AGENTS.md 가 없어요' }
    return { ok: true, note: '', text: readFileSync(path, 'utf8').slice(0, 200_000) }
  }

  /** Clear one notice, or all (49). */
  webNoticeDismiss(id?: string): { ok: boolean; note: string } {
    this.notices.remove(id)
    this.changed()
    return { ok: true, note: id ? '알림을 지웠어요' : '알림을 모두 지웠어요' }
  }

  /** Why this session's folder may not be moved to the Trash (48), or nothing. */
  private trashRefusalFor(session: Session): string | undefined {
    return trashRefusal(session.cwd, {
      home: this.cfg.homeDir ?? homedir(),
      trashDir: this.cfg.trashDir ?? join(homedir(), '.Trash'),
      defaultCwd: this.cfg.defaultCwd,
      livingFolders: this.registry.live.filter((x) => !x.ended && x !== session).map((x) => x.cwd),
    })
  }

  async webTrash(pid: number, expectPath?: string): Promise<{ ok: boolean; note: string }> {
    const session = this.registry.byPid(pid)
    if (!session || session.ended) return { ok: false, note: '이미 끝난 세션이에요' }
    const folder = session.cwd
    // The page confirmed a path: if that is not the folder that would move, nothing moves (48).
    if (expectPath !== undefined && resolve(expectPath) !== resolve(folder)) return { ok: false, note: '확인한 폴더와 옮길 폴더가 달라요. 다시 확인해 주세요' }
    const refused = this.trashRefusalFor(session)
    if (refused) return { ok: false, note: refused }
    if (session.pane) await this.tmux.killPane(session.pane).catch(() => {})
    await sleep(800)
    let dest: string
    try {
      dest = moveToTrash(folder, this.cfg.trashDir)
    } catch (err) {
      return { ok: false, note: `세션은 끝냈지만 폴더를 옮기지 못했어요: ${describeError(err)}` }
    }
    this.logAt('INFO', 'session', 'folder moved to the Trash', this.tag(session, { dest: shortenHome(dest) }))
    await this.slack.post({ threadTs: session.threadTs, text: `🗑 폴더를 휴지통으로 옮기고 종료했어요: \`${shortenHome(folder)}\`` }).catch(() => {})
    return { ok: true, note: `세션을 끝내고 폴더를 휴지통으로 옮겼어요 · ${shortenHome(dest)}` }
  }

  /** 복제: the same conversation continued in a new session (claude --resume <id> --fork-session); the original goes on. */
  async webFork(pid: number): Promise<{ ok: boolean; note: string; thread?: string }> {
    const session = this.registry.byPid(pid)
    if (!session || session.ended) return { ok: false, note: '이미 끝난 세션입니다.' }
    if (!session.sessionId) return { ok: false, note: '대화 id 를 아직 모릅니다. 첫 메시지 뒤에 다시 해 보세요.' }
    this.logAt('INFO', 'launch', 'fork', this.tag(session))
    const name = session.manualTitle ?? session.title ?? basename(session.cwd)
    const thread = await this.launchSession({ cwd: session.cwd, prompt: '', user: this.defaultRecipient, resumeId: session.sessionId, extraArgs: [...this.settingsArgs(session), '--fork-session'], title: `${name}의 사본`, fork: { fromThread: session.threadTs, transcript: session.transcriptPath, fromId: session.sessionId?.slice(0, 8) } })
    if (thread) this.copyGroup(session.threadTs, thread)
    return thread ? { ok: true, note: '복제한 세션을 띄워요', thread } : { ok: false, note: '세션을 띄우지 못했어요' }
  }

  /** A button in the web app: the very handler a Slack click reaches, as the owner. */
  async webAction(a: { actionId: string; value: string; messageTs?: string; blocks?: unknown[] }): Promise<{ ok: boolean; note: string; thread?: string }> {
    if (!a.actionId || typeof a.value !== 'string') return { ok: false, note: '잘못된 버튼입니다.' }
    // Right after a broker restart the session may not be back yet: say so, rather than "눌렀습니다" for a press that went nowhere.
    const target = decodeValue(a.value)?.pid
    if (target && !this.registry.byPid(target)) return { ok: false, note: '세션이 아직 다시 붙지 않았어요. 잠시 뒤 다시 눌러 주세요.' }
    const thread = a.messageTs ? this.msgThread.get(a.messageTs) : undefined
    this.lastWebNote = undefined
    this.lastWebThread = undefined
    await this.handleAction({ user: this.defaultRecipient, channel: this.cfg.channelId, actionId: a.actionId, value: a.value, messageTs: a.messageTs ?? '', ...(thread ? { threadTs: thread } : {}), ...(a.blocks ? { blocks: a.blocks } : {}) })
    // The result of what was pressed, as a toast (42); a press with no result of its own still says 눌렀습니다.
    const note = this.lastWebNote ?? '눌렀어요'
    const opened = this.lastWebThread
    this.lastWebNote = undefined
    this.lastWebThread = undefined
    return opened ? { ok: true, note, thread: opened } : { ok: true, note }
  }

  // ----------------------------------------------------------------- admin

  /** Everything the admin page shows. Read-only; safe to call often. */
  async adminState(): Promise<AdminState> {
    const live = await Promise.all(
      this.registry.live
        .filter((s) => !s.ended)
        .map(async (s) => ({
          pid: s.pid,
          key: s.key,
          cwd: s.cwd,
          title: s.title,
          state: s.state,
          model: s.model,
          effort: s.effort,
          permissionMode: s.permissionMode,
          contextLabel: s.contextLabel,
          startedAt: s.startedAt,
          busy: !!s.turn,
          window: s.window,
          canScreen: !!s.pane,
          threadTs: s.threadTs,
          waiting: s.waitingReason ? WAITING_LABEL[s.waitingReason] : undefined,
          preview: await this.firstMessageOf(s),
          ...this.fastLinkOf(s.threadTs),
          ...(s.transcriptPath ? { messages: await countUserMessages(s.transcriptPath) } : {}),
          ...(s.sessionId ? { sessionId: s.sessionId } : {}),
        })),
    )
    return {
      channelId: this.cfg.channelId,
      live,
      pins: this.pinStore.list(),
      recent: await this.resumable(50),
      archives: listArchives(100, this.cfg.archiveDir).map((a) => {
        const stored = this.titles.get(a.sessionId)
        return stored ? { ...a, title: stored } : a
      }),
    }
  }

  /** A conversation's first message never changes, so it is read once per transcript and kept. */
  private firstMessages = new Map<string, string>()
  private async firstMessageOf(s: Session): Promise<string | undefined> {
    const path = s.transcriptPath
    if (!path) return undefined
    const known = this.firstMessages.get(path)
    if (known) return known
    const text = await readFirstMessage(path)
    if (text) this.firstMessages.set(path, text)
    return text
  }

  /** Start a session from the admin page: the same launch as `/ccnew`, credited to the first allowed user. */
  async adminNew(o: { cwd: string; prompt?: string; model?: string; effort?: string; create?: boolean }): Promise<{ ok: boolean; note: string; thread?: string; missing?: boolean }> {
    const cwd = resolve(expandHome(o.cwd || this.cfg.defaultCwd))
    if (!existsSync(cwd)) {
      // Made only when asked, and only under home: a typo must not create folders elsewhere on the machine.
      if (!o.create) return { ok: false, missing: true, note: `폴더가 없어요: ${shortenHome(cwd)}` }
      if (!cwd.startsWith((this.cfg.homeDir ?? homedir()) + '/')) return { ok: false, note: '홈 폴더 아래에만 만들 수 있어요.' }
      mkdirSync(cwd, { recursive: true })
      this.logAt('INFO', 'launch', 'folder created for a new session', { cwd: shortenHome(cwd) })
    }
    const model = MODEL_OPTIONS.some((m) => m.value === o.model) ? o.model : undefined
    const effort = EFFORT_OPTIONS.includes(o.effort ?? '') ? o.effort : undefined
    const extraArgs = [...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : [])]
    const thread = await this.launchSession({ cwd, prompt: (o.prompt ?? '').trim(), user: this.defaultRecipient, extraArgs })
    return { ok: true, note: `${shortenHome(cwd)} 에서 세션을 띄웁니다.`, ...(thread ? { thread } : {}) }
  }

  /** Folders to pick from for a new session: the subfolders of one folder under home, with which are git repositories. */
  webFolders(path?: string): { ok: boolean; note?: string; path?: string; parent?: string; dirs?: Array<{ name: string; git: boolean }> } {
    const home = this.cfg.homeDir ?? homedir()
    const dir = resolve(expandHome(path || this.cfg.defaultCwd))
    if (dir !== home && !dir.startsWith(home + '/')) return { ok: false, note: '홈 폴더 아래만 볼 수 있어요.' }
    let names: string[]
    try {
      names = readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
        .map((d) => d.name)
        .sort((a, b) => a.localeCompare(b))
        .slice(0, 300)
    } catch {
      return { ok: false, note: '폴더를 읽지 못했어요.', path: dir }
    }
    return { ok: true, path: dir, ...(dir !== home ? { parent: resolve(dir, '..') } : {}), dirs: names.map((name) => ({ name, git: existsSync(join(dir, name, '.git')) })) }
  }

  /** Reopen a recent conversation (from the "이어서 하기" list) as a new Slack thread, as `/ccresume` does. */
  async adminResume(id: string): Promise<{ ok: boolean; note: string; thread?: string }> {
    const recent = (await (this.cfg.listSessions ?? listRecentSessions)(25)).find((r) => r.id === id)
    const archived = listArchives(1000, this.cfg.archiveDir).find((a) => a.sessionId === id)
    const hit = recent ?? (archived && { id: archived.sessionId, cwd: archived.cwd })
    if (!hit) return { ok: false, note: '이어서 할 수 있는 세션 목록에 없어요' }
    // `thread` rides along even on this "failure": already running is somewhere to go to, not nothing (19).
    const busy = this.runningOf(hit.id)
    if (busy) return { ok: false, note: await this.alreadyRunningText(busy.threadTs), thread: busy.threadTs }
    if (!existsSync(hit.cwd)) return { ok: false, note: `폴더가 없습니다: ${shortenHome(hit.cwd)}` }
    const thread = await this.launchSession({ cwd: hit.cwd, prompt: '', resumeId: hit.id, user: this.defaultRecipient })
    return { ok: true, note: `${shortenHome(hit.cwd)} 의 대화를 이어서 띄웁니다. 스레드는 채널에 생깁니다.`, thread }
  }

  /** What the terminal shows right now, as `:screen` renders it. */
  async adminScreen(pid: number): Promise<{ ok: boolean; screen: string }> {
    const session = this.registry.byPid(pid)
    if (!session || session.ended || !session.pane) return { ok: false, screen: '' }
    try {
      return { ok: true, screen: screenDigest(await this.tmux.capture(session.pane), 60) }
    } catch (err) {
      return { ok: false, screen: describeError(err) }
    }
  }

  /** End a session from the admin page, as `:kill` does from a thread. */
  async adminKill(pid: number): Promise<{ ok: boolean; note: string }> {
    const session = this.registry.byPid(pid)
    if (!session || session.ended) return { ok: false, note: '이미 끝난 세션입니다.' }
    if (!session.pane) return { ok: false, note: 'tmux 밖 세션이라 종료할 수 없어요' }
    await this.tmux.killPane(session.pane)
    return { ok: true, note: '종료를 요청했어요' }
  }

  private pinStore: PinStore
  private titles: TitleStore
  private status: StatusStore
  /** The `--settings` file registered on every launch, or undefined if none could be written (statusLine just stays off). */
  private statusLineSettingsPath?: string
  private orphanScan?: { at: number; items: Orphan[] }

  /**
   * Threads in the channel that this app started and that no running session owns:
   * `ended` (its session is over), `dormant` (waiting to be woken by a message) and
   * `unknown` (no record of it at all: a leftover from an earlier run or a lost restart).
   * Scanning is one or a few history calls, so the result is kept for half a minute.
   */
  async adminOrphans(force = false): Promise<Orphan[]> {
    if (!force && this.orphanScan && Date.now() - this.orphanScan.at < ORPHAN_SCAN_TTL_MS) return this.orphanScan.items
    const threads = await this.slack.threads(ORPHAN_SCAN_LIMIT)
    const owned = new Set(this.registry.live.filter((s) => !s.ended).map((s) => s.threadTs))
    const items: Orphan[] = []
    for (const t of threads) {
      if (!t.bot || t.blockIds.includes(NEW_SESSION_BLOCK_ID) || owned.has(t.ts)) continue
      if (this.purges.isPending(t.ts)) continue
      const kind: Orphan['kind'] = this.dormant.has(t.ts) ? 'dormant' : this.registry.byThreadTs(t.ts) ? 'ended' : 'unknown'
      const sessionId = (kind === 'dormant' ? this.dormant.get(t.ts)?.sessionId : this.registry.byThreadTs(t.ts)?.sessionId) || undefined
      items.push({ ts: t.ts, kind, title: t.text.split('\n')[0]?.slice(0, 120) ?? '', replies: t.replyCount, at: Math.round(Number(t.latestReply ?? t.ts) * 1000), ...(sessionId ? { sessionId } : {}) })
    }
    this.orphanScan = { at: Date.now(), items }
    return items
  }

  /** Pin a row to the top of the admin table, or take it off. */
  async adminPin(key: string, pinned: boolean): Promise<{ ok: boolean; note: string }> {
    if (!this.pinStore.set(key, pinned)) return { ok: false, note: '고정할 수 없는 항목입니다.' }
    return { ok: true, note: pinned ? '상단에 고정했습니다.' : '고정을 풀었습니다.' }
  }

  private threadLinks!: ThreadLinks
  private seeding = new Set<string>()

  /**
   * The link to a thread's newest message, straight from what was recorded as messages went by. A thread nothing was recorded
   * for yet (one from before this was kept) is looked up once behind the scenes; until then it opens at the top of the thread.
   */
  private fastLinkOf(threadTs: string): { link?: string } {
    if (!this.threadLinks.known && !this.seeding.has('base')) {
      this.seeding.add('base')
      void this.slack.permalink(threadTs).then((l) => this.threadLinks.learn(l)).catch(() => {}).finally(() => this.seeding.delete('base'))
    }
    if (!this.threadLinks.has(threadTs) && this.slack.latestReply && !this.seeding.has(threadTs)) {
      this.seeding.add(threadTs)
      void this.slack.latestReply(threadTs).then((ts) => this.threadLinks.note(threadTs, ts ?? threadTs)).catch(() => {}).finally(() => this.seeding.delete(threadTs))
    }
    const link = this.threadLinks.linkTo(threadTs)
    return link ? { link } : {}
  }

  /** A link to a thread that lands on its newest reply, looked up in Slack (the admin page uses the recorded one when it has it). */
  async adminThreadLink(threadTs: string): Promise<string | undefined> {
    if (!/^\d+\.\d+$/.test(threadTs)) return undefined
    const last = this.slack.latestReply
      ? ((await this.slack.latestReply(threadTs).catch(() => undefined)) ?? threadTs)
      : (await this.slack.replies(threadTs).catch(() => [])).reduce((a, m) => (Number(m.ts) > Number(a) ? m.ts : a), threadTs)
    this.threadLinks.note(threadTs, last)
    const known = this.threadLinks.linkTo(threadTs)
    if (known) return known
    const link = (await this.slack.permalink(last).catch(() => '')) || undefined
    this.threadLinks.learn(link)
    return link
  }

  /** One picture of a running session's screen, for the admin page: the whole screen, or with a side panel open its conversation or its panel. */
  async adminScreenPng(pid: number, part: ScreenPicture['part'] = 'screen'): Promise<Buffer | undefined> {
    const session = this.registry.byPid(pid)
    if (!session || session.ended || !session.pane) return undefined
    const pictures = await this.screenPictures(session)
    // Asked for the whole screen but it came as two: the conversation is the one to show first.
    return (pictures.find((p) => p.part === part) ?? (part === 'screen' ? pictures.find((p) => p.part === 'conversation') : undefined))?.png
  }

  /** An archived conversation, message by message, for the history view. Only files the archive listing offers. */
  async adminArchiveThread(path: string): Promise<ThreadView | undefined> {
    if (!listArchives(1000, this.cfg.archiveDir).some((a) => a.path === path)) return undefined
    try {
      const a = JSON.parse(readFileSync(path, 'utf8')) as SessionArchive
      return { title: a.title ?? basename(a.cwd || path), cwd: a.cwd ? shortenHome(a.cwd) : '', sessionId: a.sessionId, archivedAt: a.archivedAt, messages: a.messages ?? [] }
    } catch {
      return undefined
    }
  }

  /** A leftover thread that is still in Slack, read live for the history view. */
  async adminOrphanThread(ts: string): Promise<ThreadView | undefined> {
    // A running session's thread reads the same way as a leftover one: the conversation as it is in Slack.
    const running = this.registry.live.find((s) => !s.ended && s.threadTs === ts)
    const orphan = running ? undefined : (await this.adminOrphans()).find((o) => o.ts === ts)
    if (!running && !orphan) return undefined
    const messages = await this.slack.replies(ts)
    return { title: running ? (running.title ?? basename(running.cwd)) : orphan!.title, cwd: running?.cwd ?? '', sessionId: running?.sessionId ?? '', live: true, messages }
  }

  /** Archive one leftover thread and delete it from Slack, in the background: it can take minutes under the rate limit. */
  async adminPurgeOrphan(ts: string): Promise<{ ok: boolean; note: string }> {
    const orphan = (await this.adminOrphans()).find((o) => o.ts === ts)
    if (!orphan) return { ok: false, note: '이 스레드는 더 이상 정리 대상이 아닙니다. 목록을 새로고침하세요.' }
    this.startOrphanPurge(orphan)
    const minutes = Math.max(1, Math.ceil((orphan.replies + 1) * 0.9 / 60))
    return { ok: true, note: `스레드 정리를 시작했습니다 (메시지 약 ${orphan.replies + 1}개, ${minutes}분 안팎). 끝나면 보관됨에 나타납니다.` }
  }

  /** Reopen a leftover thread's conversation in that same thread, instead of starting a second thread for it. */
  async adminResumeOrphan(ts: string): Promise<{ ok: boolean; note: string }> {
    const orphan = (await this.adminOrphans()).find((o) => o.ts === ts)
    if (!orphan) return { ok: false, note: '이 스레드는 더 이상 잔재가 아닙니다. 목록을 새로고침하세요.' }
    if (!orphan.sessionId) return { ok: false, note: '이어서 할 대화 정보가 없는 스레드입니다. 정리만 할 수 있어요' }
    const busy = this.runningOf(orphan.sessionId, ts)
    if (busy) return { ok: false, note: await this.alreadyRunningText(busy.threadTs) }
    if (orphan.kind === 'dormant') {
      const entry = this.dormant.get(ts)
      if (!entry) return { ok: false, note: '대기 중이던 세션 정보가 사라졌어요. 목록을 새로고침하세요' }
      await this.wakeDormant(entry, { text: '', user: this.defaultRecipient, ts })
    } else {
      const ended = this.registry.byThreadTs(ts)
      if (!ended) return { ok: false, note: '끝난 세션 정보가 사라졌어요. 목록을 새로고침하세요' }
      // The old panel's buttons address a pid that no longer exists.
      if (ended.panelTs) await this.slack.delete(ended.panelTs).catch(() => {})
      await this.launchSession({ cwd: ended.cwd, prompt: '', resumeId: orphan.sessionId, user: this.defaultRecipient, threadTs: ts, rootTs: ended.rootTs, extraArgs: this.settingsArgs(ended) })
    }
    this.orphanScan = undefined
    return { ok: true, note: '그 스레드에서 대화를 이어서 다시 엽니다.' }
  }

  /** Clean up every leftover thread whose session is over or unknown. Threads waiting to be woken (dormant) are left alone. */
  async adminPurgeOrphans(): Promise<{ ok: boolean; note: string }> {
    const targets = (await this.adminOrphans(true)).filter((o) => o.kind !== 'dormant')
    if (!targets.length) return { ok: true, note: '정리할 잔재 스레드가 없어요' }
    // One after another: they share Slack's rate limit, and running them together only makes each slower.
    void (async () => {
      for (const o of targets) await this.runOrphanPurge(o)
    })()
    const messages = targets.reduce((n, o) => n + o.replies + 1, 0)
    return { ok: true, note: `잔재 스레드 ${targets.length}개(메시지 약 ${messages}개)를 차례로 정리합니다. 몇 분 걸릴 수 있습니다.` }
  }

  private startOrphanPurge(o: Orphan): void {
    void this.runOrphanPurge(o)
  }

  private async runOrphanPurge(o: Orphan): Promise<void> {
    const shell = { key: `orphan-${o.ts}`, sessionId: '', cwd: '', title: o.title, threadTs: o.ts, origin: 'slack' as const, archivedAt: new Date().toISOString(), messages: [] }
    try {
      const r = await this.purges.runThread(o.ts, shell)
      this.logAt('INFO', 'purge', `orphan ${o.ts} (${o.kind}): ${PurgeService.describe(r)}`)
    } catch (err) {
      this.logAt('WARN', 'purge', `orphan ${o.ts} failed: ${describeError(err)}`)
    }
    this.orphanScan = undefined
  }

  /** Finish purges a restart or a failed delete left half done. Called at startup and every few minutes. */
  async resumePurges(): Promise<void> {
    if (!this.purges.pendingThreads()) return
    const r = await this.purges.resume()
    if (r.threads) this.logAt('INFO', 'purge', `resumed ${r.threads} thread(s): deleted ${r.deleted}, ${r.left} still failing`)
  }

  /** Give a live session a new title everywhere it shows: root message, Slack session name, panel, Home tab. */
  private async applyTitle(session: Session, title: string): Promise<void> {
    session.title = title
    // Claude Code's own title (ai-title) must never replace this, here or anywhere it shows.
    session.manualTitle = title
    if (session.sessionId) this.titles.set(session.sessionId, title)
    await this.refreshRoot(session)
    if (session.statusCreated) await this.slack.renameSession(session.threadTs, title).catch((e) => this.logAt('WARN', 'slack', `rename failed: ${describeError(e)}`, this.tag(session)))
    this.schedulePanelRefresh(session)
    this.refreshHome()
  }

  /** Rename a live session from the admin page, as `:rename` does from its thread. */
  async adminRename(pid: number, title: string): Promise<{ ok: boolean; note: string }> {
    const session = this.registry.byPid(pid)
    const name = title.trim()
    if (!session || session.ended) return { ok: false, note: '이미 끝난 세션입니다.' }
    if (!name) return { ok: false, note: '이름이 비어 있어요' }
    await this.applyTitle(session, name)
    await this.slack.post({ threadTs: session.threadTs, text: `✏️ 이름: *${name}*` }).catch(() => {})
    return { ok: true, note: `이름을 "${name}" 으로 바꿨습니다.` }
  }

  /** Rename one archived session. Only files the archive listing offers. */
  async adminRenameArchive(path: string, title: string): Promise<{ ok: boolean; note: string }> {
    const known = listArchives(1000, this.cfg.archiveDir).find((a) => a.path === path)
    if (!known || !renameArchive(path, title, this.cfg.archiveDir)) return { ok: false, note: '보관 기록을 찾지 못했거나 이름이 비어 있어요' }
    // So a later resume starts already carrying the name, not whatever ai-title the resumed run comes up with.
    this.titles.set(known.sessionId, title.trim())
    return { ok: true, note: `이름을 "${title.trim()}" 으로 바꿨습니다.` }
  }

  /** Delete a saved conversation from the "이어서 하기" list, so it can no longer be resumed. Never one that is running. */
  async adminDeleteRecent(id: string): Promise<{ ok: boolean; note: string }> {
    const known = (await (this.cfg.listSessions ?? listRecentSessions)(25)).some((r) => r.id === id)
    if (!known) return { ok: false, note: '이어서 할 수 있는 세션 목록에 없어요' }
    if (this.registry.live.some((s) => !s.ended && s.sessionId === id)) return { ok: false, note: '지금 실행 중인 세션입니다. 먼저 종료하세요.' }
    if (!(await (this.cfg.deleteSession ?? deleteRecentSession)(id))) return { ok: false, note: '대화 파일을 찾지 못했어요' }
    this.logAt('INFO', 'admin', `deleted saved conversation ${id.slice(0, 8)}`)
    return { ok: true, note: '대화를 삭제했어요. 더 이상 이어서 할 수 없어요' }
  }

  /**
   * Delete one archived session from disk. Only files the archive listing offers. The archive's own
   * event log and web pictures go with it (P4-33) — unless its thread somehow still has a live session
   * (a purge usually ends it first, but admin deletion can race one started again on the same thread),
   * in which case the whole delete is refused rather than pulling state out from under it.
   */
  async adminDeleteArchive(path: string): Promise<{ ok: boolean; note: string }> {
    const known = listArchives(1000, this.cfg.archiveDir).some((a) => a.path === path)
    if (!known) return { ok: false, note: '보관 기록을 찾지 못했어요' }
    let threadTs: string | undefined
    try {
      threadTs = (JSON.parse(readFileSync(path, 'utf8')) as { threadTs?: string }).threadTs
    } catch {}
    if (threadTs && this.registry.byThreadTs(threadTs)?.ended === false) return { ok: false, note: '이 보관 기록의 스레드가 아직 살아 있어요. 먼저 세션을 종료하세요' }
    if (!deleteArchive(path, this.cfg.archiveDir)) return { ok: false, note: '보관 기록을 찾지 못했어요' }
    if (threadTs) {
      this.events.forgetThread(threadTs)
      this.images.forgetThread(threadTs)
    }
    this.logAt('INFO', 'admin', `deleted archive ${basename(path)}`)
    return { ok: true, note: '보관 기록을 삭제했어요' }
  }

  /** Archive and delete a thread. A live session is ended first, and the thread goes when it reports SessionEnd. */
  async adminPurge(pid: number): Promise<{ ok: boolean; note: string }> {
    const session = this.registry.byPid(pid)
    if (!session) return { ok: false, note: '세션을 찾지 못했어요' }
    if (!session.ended) {
      if (!session.pane) return { ok: false, note: 'tmux 밖 세션이라 종료할 수 없어요. 터미널에서 종료한 뒤 다시 하세요' }
      await this.runCommand(session, 'purge')
      return { ok: true, note: '세션을 종료하는 중입니다. 끝나면 스레드를 보관하고 지워요' }
    }
    const result = await this.purges.run(session)
    if (!result.error) session.panelTs = undefined
    return { ok: !result.error, note: PurgeService.describe(result) }
  }

  /**
   * Persist what a restart needs: how far each transcript was read, and which
   * sessions were alive. Called on a timer and at shutdown, so a machine that
   * goes down without warning still leaves a usable record.
   */
  saveState(): void {
    this.threadLinks.flush()
    for (const s of this.registry.live) {
      if (s.ended || !s.sessionId) continue
      const pendingPermissions = [...this.pendingPermissions.values()].filter((p) => p.pid === s.pid).map(({ msgTs, pid, requestId, toolName, at }) => ({ msgTs, pid, requestId, toolName, at }))
      this.revive.note(s.key, {
        sessionId: s.sessionId,
        cwd: s.cwd,
        threadTs: s.threadTs,
        rootTs: s.rootTs,
        pid: s.pid,
        ...(s.pane ? { pane: s.pane } : {}),
        recipient: s.recipient || this.defaultRecipient,
        ...(s.held?.length ? { held: s.held } : {}),
        ...(s.holdNoticeTs ? { holdNoticeTs: s.holdNoticeTs } : {}),
        ...(pendingPermissions.length ? { pendingPermissions } : {}),
        ...(s.notify ? { notify: s.notify } : {}),
        ...(s.view ? { view: s.view } : {}),
        ...(s.title ? { title: s.title } : {}),
        ...(s.manualTitle ? { manualTitle: s.manualTitle } : {}),
        ...(s.autoAllow ? { autoAllow: true } : {}),
        ...(s.model ? { model: s.model } : {}),
        ...(s.launchModel ?? s.model ? { launchModel: s.launchModel ?? s.model } : {}),
        ...(s.refreshAfter ? { refreshAfter: s.refreshAfter } : {}),
        ...(s.effort ? { effort: s.effort } : {}),
        ...(s.permissionMode ? { permissionMode: s.permissionMode } : {}),
        ...(s.resting ? { resting: true } : {}),
      })
    }
    this.offsets.flush()
    this.revive.flush()
  }

  get sessions(): Session[] {
    return this.registry.live
  }

  private get defaultRecipient(): string {
    return [...this.cfg.allowedUsers][0] ?? ''
  }

  // ---------------------------------------------------------------- IPC side

  onConn(conn: Conn): void {
    conn.once('message', (first: ToBroker) => {
      if (first.type === 'hello') {
        // Messages sent right after hello (same data chunk) would otherwise be
        // lost while attachSession awaits Slack calls; hold them until it is wired up.
        const backlog: ToBroker[] = []
        const hold = (msg: ToBroker) => backlog.push(msg)
        conn.on('message', hold)
        const release = () => {
          conn.off('message', hold)
          return backlog.splice(0)
        }
        this.attachSession(conn, first, release).catch((e) => this.logAt('ERROR', 'session', `attach failed: ${describeError(e)}`))
      } else if (first.type === 'hook') this.handleHook(first.key ?? String(first.pid), first.event).catch((e) => this.logAt('ERROR', 'hook', `hook failed: ${describeError(e)}`))
      else conn.close()
    })
  }

  /** Already warned about this run having two live processes, so the message is not repeated on every reconnect. */
  private pidCollisionWarned = new Set<string>()

  private async attachSession(conn: Conn, hello: Extract<ToBroker, { type: 'hello' }>, release: () => ToBroker[]): Promise<void> {
    const key = hello.key ?? String(hello.pid)
    const existing = this.registry.byLaunchKey(key)
    let session: Session
    if (existing && !existing.ended) {
      // Two Claude Code processes under one launch key: a `claude` run from inside a session's own terminal
      // inherits CLAUDE_SLACK_SESSION from its parent, so both hellos carry the same key. Handing the
      // connection to whichever asks last (the old behavior) made the two fight over it every reconnect.
      // The one whose process is actually still running keeps it; the new hello is turned away.
      if (hello.pid !== existing.pid && processAlive(existing.pid)) {
        conn.send({ type: 'bye', reason: `another Claude Code process (pid ${existing.pid}) already owns this run` })
        conn.close()
        const warnKey = `${key}:${hello.pid}`
        if (!this.pidCollisionWarned.has(warnKey)) {
          this.pidCollisionWarned.add(warnKey)
          this.logAt('WARN', 'session', `second process for this run refused: pid ${hello.pid} vs running ${existing.pid}`, this.tag(existing))
          const note = `⚠️ 같은 대화가 다른 Claude 프로세스로도 떠 있어요. 하나를 끄세요: \`tmux kill-pane -t ${existing.pane ?? '<pane>'}\``
          this.slack.post({ threadTs: existing.threadTs, text: note }).catch(() => {})
        }
        return
      }
      session = existing
      session.conn?.close()
      session.pid = hello.pid
    } else {
      session = {
        key,
        pid: hello.pid,
        sessionId: hello.sessionId,
        cwd: hello.cwd,
        threadTs: '',
        origin: hello.threadTs ? 'slack' : 'terminal',
        pane: hello.tmuxPane,
        ended: false,
        recipient: this.defaultRecipient,
        statusCreated: false,
        state: 'idle',
        startedAt: Date.now(),
      }
    }
    session.conn = conn
    session.ended = false

    const pending = hello.threadTs ? this.pendingLaunches.get(hello.threadTs) : undefined
    if (hello.threadTs) {
      session.threadTs = hello.threadTs
      session.pane = pending?.pane ?? session.pane
      session.window = pending?.window
      if (pending) this.pendingLaunches.delete(hello.threadTs)
      if (pending?.statusTs) session.panelTs = pending.statusTs
      session.model ??= pending?.model
      session.launchModel ??= pending?.model
      session.effort ??= pending?.effort
    } else if (!session.threadTs) {
      const rootTs = await this.slack.post({ text: this.rootText(session, '🟢', '터미널 세션') })
      session.threadTs = rootTs
      session.rootTs = rootTs
    }
    if (pending?.rootTs) session.rootTs = pending.rootTs
    if (pending?.title) session.manualTitle ??= pending.title

    // The record before the session can be found: a hook arriving right after registration (a permission
    // dialog) must already see 전부 허용 and the rest.
    if (!existing) {
      this.restoreFromRecord(session)
      this.applyStoredTitle(session)
    }
    this.refreshFailed.delete(session.threadTs)
    this.registry.add(session)
    this.logAt('INFO', 'session', `attached (${session.origin})`, this.tag(session, { pid: session.pid, key: session.key.slice(0, 8), pane: session.pane }))
    this.refreshHome()

    this.armStall(session)

    const early = this.earlyTranscripts.get(session.key)
    if (early) {
      this.earlyTranscripts.delete(session.key)
      this.watchTranscript(session, early)
    }
    if (!existing) {
      session.state = 'idle'
      // Broker restarted under a live session: reuse the panel already in the thread instead of stacking a new one,
      // and recover what the panel shows from the terminal and the transcript.
      if (!session.panelTs) session.panelTs = await this.findPanelInThread(session.threadTs)
      // The record is already back (above): what it restores (전부 허용 above all) decides how a dialog on screen is handled.
      await this.restoreSessionFacts(session)
      const panel = controlPanel(this.panelState(session))
      try {
        if (session.panelTs) await this.slack.update(session.panelTs, panel.text, panel.blocks)
        else session.panelTs = await this.slack.post({ threadTs: session.threadTs, text: panel.text, blocks: panel.blocks })
      } catch (err) {
        this.logAt('WARN', 'slack', `control panel post failed: ${describeError(err)}`, this.tag(session))
      }
    }

    conn.on('message', (msg: ToBroker) => this.onChannelMessage(session, msg).catch((e) => this.logAt('ERROR', 'session', `channel msg failed: ${describeError(e)}`, this.tag(session))))
    for (const msg of release()) await this.onChannelMessage(session, msg).catch((e) => this.logAt('ERROR', 'session', `channel msg failed: ${describeError(e)}`, this.tag(session)))
    conn.on('close', () => {
      if (session.conn === conn) this.endSession(session, '채널 연결 끊김').catch((e) => this.logAt('ERROR', 'session', `end failed: ${describeError(e)}`, this.tag(session)))
    })
    this.send(session, { type: 'hello_ack', threadTs: session.threadTs })

    // The launch prompt and anything typed while waiting go in as one turn:
    // injecting them one by one would cut each turn short as the next arrived.
    const waiting = pending?.queued ?? []
    const opening = [pending?.prompt, ...waiting.map((q) => q.text)].filter(Boolean).join('\n\n')
    if (opening) {
      const last = waiting.at(-1)
      await this.deliver(session, opening, last?.user ?? this.defaultRecipient, last?.ts ?? pending!.threadTs)
      // The "끊긴 작업" note rides with the thread's own ts: it is not a message to react to.
      for (const q of waiting) if (q.ts !== last?.ts && q.ts !== session.threadTs) await this.slack.react(q.ts, 'eyes').catch(() => {})
    }
    // Held messages that survived a broker restart wait for the tool that was running, as they did before.
    if (session.held?.length) await this.releaseHeldIfIdle(session, 'restart', { drain: true })
  }

  /**
   * A broker restart under a live session loses what was only in memory: the
   * messages held for a running tool, the permission cards still open, the
   * per-thread settings. They were saved with the session's record; put them back.
   */
  private restoreFromRecord(session: Session): void {
    // Several keys can name one thread; the newest record speaks for it.
    const rec = this.recordedAtStart.filter((e) => e.threadTs === session.threadTs).sort((a, b) => b.lastSeen - a.lastSeen)[0] ?? this.dormant.get(session.threadTs)
    if (!rec) return
    // Applied once, then gone: a later attach in this thread (a refresh relaunches under a new key) must not get
    // it again, or a reservation kills the new pane, a 전부 허용 turned off comes back, held messages go twice.
    this.recordedAtStart = this.recordedAtStart.filter((e) => e.threadTs !== session.threadTs)
    this.dormant.delete(session.threadTs)
    session.notify = rec.notify ?? session.notify
    session.view = rec.view ?? session.view
    session.autoAllow = rec.autoAllow ?? session.autoAllow
    session.permissionMode ??= rec.permissionMode
    session.resting = rec.resting || undefined
    session.manualTitle = rec.manualTitle ?? session.manualTitle
    session.model ??= rec.model
    session.launchModel ??= rec.launchModel
    if (rec.refreshAfter && !session.refreshAfter) {
      session.refreshAfter = rec.refreshAfter
      this.armRefreshCheck()
    }
    session.effort ??= rec.effort
    if (rec.title && !session.title) session.title = rec.title
    if (rec.holdNoticeTs) {
      if (rec.held?.length) session.holdNoticeTs = rec.holdNoticeTs
      // Nothing is held any more (it was delivered another way), so the card and its button are only in the way.
      else void this.slack.delete(rec.holdNoticeTs).catch(() => {})
    }
    if (rec.held?.length) {
      session.held = [...rec.held]
      this.logAt('INFO', 'inject', 'restored held messages after restart', this.tag(session, { n: rec.held.length }))
    }
    // The card is still in the thread with working buttons; only our memory of it was lost.
    for (const p of rec.pendingPermissions ?? []) {
      if (p.pid !== session.pid) continue
      this.pendingPermissions.set(`${session.pid}:${p.requestId}`, { ...p, at: p.at ?? Date.now() })
      this.armReminder(session, `${session.pid}:${p.requestId}`)
      this.logAt('INFO', 'perm', 'restored open permission after restart', this.tag(session, { req: p.requestId, tool: p.toolName }))
    }
    if (this.hasOpenPermission(session)) this.markWaiting(session, 'permission')
  }

  /** A name a person chose for this conversation, from an earlier run: applied without writing it back (it is already on file). */
  private applyStoredTitle(session: Session): void {
    if (session.manualTitle || !session.sessionId) return
    const stored = this.titles.get(session.sessionId)
    if (!stored) return
    session.title = stored
    session.manualTitle = stored
  }

  /** Model / effort / permission mode are only in broker memory; after a restart read them back from the transcript and the screen. */
  private async restoreSessionFacts(session: Session): Promise<void> {
    if (!session.transcriptPath) {
      const path = (this.cfg.transcriptPathFor ?? transcriptPathFor)(session.cwd, session.sessionId)
      if (path) this.watchTranscript(session, path)
    }
    if (session.transcriptPath && !session.model) session.model = lastModelInTranscript(session.transcriptPath)
    if (session.pane) {
      try {
        const screen = await this.tmux.capture(session.pane)
        session.effort ??= detectEffort(screen) ?? undefined
        session.permissionMode ??= detectPermissionMode(screen) ?? undefined
        // Broker restarted while a dialog was up: surface it so it is not lost.
        await this.surfaceDialog(session, screen)
      } catch (err) {
        this.logAt('WARN', 'tmux', `screen read failed: ${describeError(err)}`, this.tag(session))
      }
    }
  }

  /** The most recent control panel this bot posted in a thread (block_id `ctl_<pid>` / `ctl_ended_<pid>`), if any. */
  private async findPanelInThread(threadTs: string): Promise<string | undefined> {
    try {
      const msgs = await this.slack.replies(threadTs)
      const hit = [...msgs].reverse().find((m) => m.bot && (m.blocks as Array<{ block_id?: string }> | undefined)?.some((b) => isPanelBlockId(b.block_id)))
      return hit?.ts
    } catch (err) {
      this.logAt('WARN', 'slack', `panel lookup failed: ${describeError(err)}`, { t: threadTs })
      return undefined
    }
  }

  private async onChannelMessage(session: Session, msg: ToBroker): Promise<void> {
    if (msg.type === 'reply') {
      session.lastReplyText = msg.text.trim()
      this.logAt('INFO', 'reply', 'reply tool', this.tag(session, { chars: msg.text.length, files: msg.files?.length ?? 0, notify: !!msg.notify }))
      // `notify` is the model asking for a push, as Remote Control's "notify me when the tests finish".
      const who = msg.notify && (session.notify ?? 'decisions') !== 'off' ? `<@${session.recipient || this.defaultRecipient}> ` : ''
      const text = who ? who + msg.text : msg.text
      const images = (msg.files ?? []).map((f) => this.images.putFile(session.threadTs, f)).filter((x): x is WebImage => !!x)
      // An attached .html file is drawn by the web app (read-only), so its content rides along when small.
      const html = (msg.files ?? []).filter((f) => /\.html?$/i.test(f)).flatMap((f) => {
        try {
          return statSync(f).size <= 500_000 ? [{ name: basename(f), content: readFileSync(f, 'utf8') }] : []
        } catch {
          return []
        }
      })
      // Text files up to 400 KB ride along, shown folded on the page (49); one that cannot be read says so.
      const textFiles = (msg.files ?? []).filter((f) => /\.(md|txt|json|csv|log|ya?ml)$/i.test(f)).flatMap((f) => {
        try {
          return statSync(f).size <= 400_000 ? [{ name: basename(f), path: shortenHome(f), content: readFileSync(f, 'utf8') }] : []
        } catch {
          return []
        }
      })
      for (const f of msg.files ?? []) {
        try {
          statSync(f)
        } catch {
          this.emitEvent(session.threadTs, { type: 'notice', text: `첨부 파일을 읽지 못했어요: ${shortenHome(f)}`, icon: 'alert' })
        }
      }
      this.emitEvent(session.threadTs, { type: 'text', text: msg.text, ...(msg.files?.length ? { files: msg.files } : {}), ...(images.length ? { images } : {}), ...(html.length ? { html } : {}), ...(textFiles.length ? { textFiles } : {}) })
      if (!msg.files?.length) {
        for (const part of chunk(toMrkdwn(text))) await this.quietSlack.post({ threadTs: session.threadTs, text: part })
        return
      }
      // The caption rides on the upload so text and files land as one message; anything past the first chunk goes ahead of it.
      const parts = text.trim() ? chunk(toMrkdwn(text)) : []
      const caption = parts.pop()
      for (const part of parts) await this.quietSlack.post({ threadTs: session.threadTs, text: part })
      try {
        if (await this.quietSlack.uploadFiles({ threadTs: session.threadTs, paths: msg.files, text: caption })) return
        if (caption) await this.quietSlack.post({ threadTs: session.threadTs, text: caption })
        await this.slack.post({ threadTs: session.threadTs, text: '⚠️ 파일을 올릴 권한이 없습니다. Slack 앱에 `files:write` 를 추가하고 재설치하세요.' })
      } catch (err) {
        this.logAt('WARN', 'slack', `file upload failed: ${describeError(err)}`, this.tag(session))
        if (caption) await this.quietSlack.post({ threadTs: session.threadTs, text: caption })
        await this.slack.post({ threadTs: session.threadTs, text: `⚠️ 파일 업로드에 실패했습니다. ${describeError(err)}` })
      }
    } else if (msg.type === 'read_session') {
      const result = await this.resolveReadSession(msg.session, msg.maxChars)
      session.conn?.send({ type: 'read_session_result', reqId: msg.reqId, ...result })
    } else if (msg.type === 'permission_request') {
      // Where the tool's arguments come from, in order of reliability:
      // 1. `input_preview` — the relay sends the whole input as JSON, so it is the real thing.
      //    (Until 2026-09-23 this was shown raw and the card never drew a diff: the PreToolUse
      //    hook below only fires for AskUserQuestion|ExitPlanMode, so `lastToolInput` was always
      //    empty for Edit, Write and Bash — the very tools the card is for.)
      // 2. the last PreToolUse, for the tools that hook does cover.
      const recent = session.lastToolInput && session.lastToolInput.name === msg.toolName && Date.now() - session.lastToolInput.at < TOOL_INPUT_MATCH_MS ? session.lastToolInput.input : undefined
      const toolInput = parsePreview(msg.inputPreview) ?? recent
      if (session.autoAllow) return this.autoAllowPermission(session, msg, toolInput)
      const { text, blocks } = permissionBlocksV2({ pid: session.pid, hasPane: !!session.pane, mention: this.mentionFor(session, 'decision'), toolInput, ...msg })
      const msgTs = await this.slack.post({ threadTs: session.threadTs, text, blocks })
      const key = `${session.pid}:${msg.requestId}`
      this.pendingPermissions.set(key, { msgTs, pid: session.pid, requestId: msg.requestId, toolName: msg.toolName, at: Date.now(), text, blocks })
      this.armReminder(session, key)
      this.logAt('INFO', 'perm', 'permission requested', this.tag(session, { req: msg.requestId, tool: msg.toolName, preview: truncate(msg.inputPreview, 80) }))
      this.markWaiting(session, 'permission')
      await this.setStatus(session, 'suspended')
    }
  }

  /** `https://…/archives/<channel>/p<16 digits>` → the ts it names (`<first 10>.<last 6>`), else undefined. */
  private threadTsFromLink(ref: string): string | undefined {
    const m = /p(\d{10})(\d{6})/.exec(ref)
    return m ? `${m[1]}.${m[2]}` : undefined
  }

  /** Find a conversation's cwd/sessionId from whatever `read_session` was given: a thread link, a thread ts, or a session id prefix. */
  private findReadableSession(ref: string): { cwd: string; sessionId: string } | undefined {
    const threadTs = this.threadTsFromLink(ref) ?? (/^\d+\.\d+$/.test(ref) ? ref : undefined)
    if (threadTs) {
      const live = this.registry.byThreadTs(threadTs)
      if (live?.sessionId) return { cwd: live.cwd, sessionId: live.sessionId }
      const rec = this.recordedAtStart.find((e) => e.threadTs === threadTs) ?? this.dormant.get(threadTs)
      if (rec) return { cwd: rec.cwd, sessionId: rec.sessionId }
      return undefined
    }
    // A session id prefix: the live registry, then what was recorded at start, then the saved lists.
    const liveHit = this.registry.live.find((x) => x.sessionId.startsWith(ref))
    if (liveHit) return { cwd: liveHit.cwd, sessionId: liveHit.sessionId }
    const recHit = this.recordedAtStart.find((e) => e.sessionId.startsWith(ref))
    if (recHit) return { cwd: recHit.cwd, sessionId: recHit.sessionId }
    return undefined
  }

  /** The `read_session` MCP tool: another session's recent transcript, read-only, as plain text. */
  private async resolveReadSession(ref: string, maxChars = READ_SESSION_MAX_CHARS): Promise<{ text?: string; error?: string }> {
    let hit = this.findReadableSession(ref)
    if (!hit) {
      const recent = await (this.cfg.listSessions ?? listRecentSessions)(500)
      const r = recent.find((x) => x.id.startsWith(ref))
      if (r) hit = { cwd: r.cwd, sessionId: r.id }
    }
    if (!hit) {
      const a = listArchives(1000, this.cfg.archiveDir).find((x) => x.sessionId.startsWith(ref))
      if (a) hit = { cwd: a.cwd, sessionId: a.sessionId }
    }
    if (!hit) return { error: `no session found matching "${ref}" (give a thread link, a thread ts, or a conversation id prefix)` }
    const path = (this.cfg.transcriptPathFor ?? transcriptPathFor)(hit.cwd, hit.sessionId)
    if (!path) return { error: `transcript not found for session ${hit.sessionId.slice(0, 8)}` }
    const text = readSessionText(path)
    const clamped = Math.max(1, Math.min(maxChars, READ_SESSION_MAX_CHARS_CAP))
    return { text: text.length > clamped ? text.slice(-clamped) : text }
  }

  // ------------------------------------------------------------ safe restart

  private restartTimer?: ReturnType<typeof setInterval>
  private restartIdleStreak = 0

  /** Whether this process was started by the launchd daemon (broker-daemon.sh), the only one a restart-on-idle may exit: a
   *  broker started by hand (`npm start`/`npm run dev`) would just stay dead. */
  private get isDaemonManaged(): boolean {
    return !!process.env.CLAUDE_SLACK_DAEMON
  }

  private busySessions(): Session[] {
    return this.registry.live.filter((s) => !s.ended && (s.state === 'busy' || !!s.turn))
  }

  /**
   * Schedule a restart for the moment every session goes idle (checked every 3,000 ms; two idle checks in a
   * row, not one, so a session between turns is not mistaken for genuinely done). Only on a daemon-managed
   * broker — launchd's KeepAlive is what brings it back; anywhere else this would just turn the broker off.
   */
  adminScheduleRestart(): { ok: boolean; note: string } {
    if (!this.isDaemonManaged) return { ok: false, note: '데몬(launchd)이 띄운 브로커가 아니라서 예약할 수 없어요. 재시작하면 꺼진 채로 남어요' }
    if (this.restartTimer) return { ok: true, note: '이미 예약되어 있어요' }
    this.restartIdleStreak = 0
    this.restartTimer = setInterval(() => this.checkRestartWhenIdle(), this.cfg.restartCheckMs ?? RESTART_CHECK_MS)
    this.restartTimer.unref?.()
    this.logAt('INFO', 'broker', 'restart-when-idle scheduled')
    return { ok: true, note: '모든 세션이 쉬면 재시작하도록 예약했어요' }
  }

  adminCancelRestart(): { ok: boolean; note: string } {
    if (!this.restartTimer) return { ok: false, note: '예약된 재시작이 없어요' }
    clearInterval(this.restartTimer)
    this.restartTimer = undefined
    this.logAt('INFO', 'broker', 'restart-when-idle cancelled')
    return { ok: true, note: '예약을 취소했어요' }
  }

  adminRestartStatus(): { scheduled: boolean; waitingOn: string[] } {
    return { scheduled: !!this.restartTimer, waitingOn: this.busySessions().map((s) => s.title || basename(s.cwd)) }
  }

  private checkRestartWhenIdle(): void {
    const busy = this.busySessions()
    if (busy.length) {
      this.restartIdleStreak = 0
      return
    }
    this.restartIdleStreak++
    if (this.restartIdleStreak < 2) return
    if (this.restartTimer) clearInterval(this.restartTimer)
    this.logAt('INFO', 'broker', 'all sessions idle; restarting now (restart-when-idle)')
    this.saveState()
    process.exit(0)
  }

  // ------------------------------------------------------------ attention

  /** Who to @-mention for this kind of event, or undefined when the session's setting says not to. */
  private mentionFor(session: Session, kind: 'decision' | 'all'): string | undefined {
    return this.wantsMention(session, kind) ? session.recipient || this.defaultRecipient : undefined
  }

  private wantsMention(session: Session, kind: 'decision' | 'all'): boolean {
    const mode: NotifyMode = session.notify ?? 'decisions'
    if (mode === 'off') return false
    if (mode === 'on') return true
    return kind === 'decision'
  }

  /**
   * The session now waits on a person: remember why and since when, for the
   * status line and the Home tab, and call them if it goes on too long.
   * Permissions carry their own reminder (it knows the request); this one
   * covers questions, plans, dialogs and a stopped turn.
   */
  private markWaiting(session: Session, reason: WaitingReason): void {
    if (session.waitingReason !== reason) session.waitingSince = Date.now()
    session.waitingReason = reason
    this.refreshHome()
    if (session.waitingTimer) clearTimeout(session.waitingTimer)
    if (reason === 'permission') return
    session.waitingTimer = setTimeout(() => {
      session.waitingTimer = undefined
      if (session.ended || session.waitingReason !== reason || !this.wantsMention(session, 'decision')) return
      const user = session.recipient || this.defaultRecipient
      this.slack
        .post({ threadTs: session.threadTs, text: `<@${user}> ⏰ ${duration(Date.now() - (session.waitingSince ?? Date.now()))}째 ${WAITING_LABEL[reason]} 중입니다. 세션이 그동안 멈춰 있습니다.` })
        .then(() => this.logAt('INFO', 'perm', 'reminded in thread', this.tag(session, { reason })))
        .catch((e) => this.logAt('WARN', 'perm', `reminder failed: ${describeError(e)}`, this.tag(session)))
    }, this.cfg.remindMs ?? REMIND_MS)
    session.waitingTimer.unref?.()
  }

  private clearWaiting(session: Session): void {
    if (session.waitingTimer) clearTimeout(session.waitingTimer)
    session.waitingTimer = undefined
    session.openDialogTs = undefined
    if (!session.waitingReason) return
    session.waitingReason = undefined
    session.waitingSince = undefined
    this.refreshHome()
  }

  /**
   * A thread reply does not reach a phone that is not in the thread. After a
   * while with no answer, call the person by name in the thread; after longer,
   * in a direct message. Once each, then let it be.
   */
  private armReminder(session: Session, key: string): void {
    const pending = this.pendingPermissions.get(key)
    if (!pending) return
    const remindMs = this.cfg.remindMs ?? REMIND_MS
    const step = pending.reminded ?? 0
    const dmMs = this.cfg.remindDmMs ?? REMIND_DM_MS
    const delay = step === 0 ? remindMs : step === 1 ? Math.max(1, dmMs - remindMs) : 0
    if (!delay) return
    pending.timer = setTimeout(() => {
      this.remind(session, key).catch((e) => this.logAt('WARN', 'perm', `reminder failed: ${e}`, this.tag(session)))
    }, delay)
    pending.timer.unref?.()
  }

  private async remind(session: Session, key: string): Promise<void> {
    const pending = this.pendingPermissions.get(key)
    if (!pending || session.ended) return
    const user = session.recipient || this.defaultRecipient
    const waited = duration(Date.now() - pending.at)
    pending.reminded = (pending.reminded ?? 0) + 1
    if (pending.reminded === 1) {
      if (this.wantsMention(session, 'decision')) {
        await this.slack.post({ threadTs: session.threadTs, text: `<@${user}> ⏰ ${waited}째 *${pending.toolName}* 권한 응답을 기다리고 있습니다 (\`${pending.requestId}\`). 세션이 그동안 멈춰 있습니다.` })
        this.logAt('INFO', 'perm', 'reminded in thread', this.tag(session, { req: pending.requestId, waited }))
      }
      this.armReminder(session, key)
      return
    }
    if (this.wantsMention(session, 'decision') && this.slack.dm) {
      const link = await this.slack.permalink(pending.msgTs).catch(() => '')
      await this.slack.dm(user, `⏰ *${basename(session.cwd)}* 세션이 ${waited}째 권한 응답을 기다립니다.${link ? ` <${link}|스레드로 가기>` : ''}`).catch((e) => this.logAt('WARN', 'perm', `dm failed: ${describeError(e)}`, this.tag(session)))
      this.logAt('INFO', 'perm', 'reminded by DM', this.tag(session, { req: pending.requestId, waited }))
    }
  }

  private clearReminder(key: string): void {
    const pending = this.pendingPermissions.get(key)
    if (pending?.timer) clearTimeout(pending.timer)
  }

  private send(session: Session, msg: ToChannel): void {
    session.conn?.send(msg)
  }

  // --------------------------------------------------------------- hook side

  async handleHook(key: string, event: HookEvent): Promise<void> {
    const session = this.registry.byLaunchKey(key)
    if (!session || session.ended) {
      if (typeof event.transcript_path === 'string') this.earlyTranscripts.set(key, event.transcript_path)
      return
    }
    if (this.isDuplicateHook(key, session, event)) return
    if (typeof event.transcript_path === 'string') this.watchTranscript(session, event.transcript_path)
    const toolName = typeof event.tool_name === 'string' ? event.tool_name : undefined
    // PostToolUse is most of the traffic and says nothing a person would grep for; keep it out of INFO.
    this.logAt(event.hook_event_name === 'PostToolUse' ? 'DEBUG' : 'INFO', 'hook', event.hook_event_name, this.tag(session, { tool: toolName, ...(event.hook_event_name === 'Notification' ? { kind: String(event.notification_type ?? '') } : {}) }))
    this.trackStatus(session, event)
    const post = (text: string, blocks?: unknown[]) => this.slack.post({ threadTs: session.threadTs, text, blocks })

    switch (event.hook_event_name) {
      case 'SessionStart': {
        session.sessionId = event.session_id
        this.applyStoredTitle(session)
        if (event.source === 'clear') await post('🧹 `/clear` · 대화가 초기화됐어요')
        else if (event.source === 'compact') await post('📦 컨텍스트 압축 완료')
        break
      }
      case 'UserPromptSubmit': {
        const text = String(event.user_message ?? event.prompt ?? '')
        if (!text) break
        this.confirmInjected(session, text)
        if (session.lastInjected !== undefined && sameMessage(text, session.lastInjected)) break
        // Claude Code injects some prompts itself (a Slack message, a finished
        // subagent, a system reminder). Those are not the user typing, so never
        // mirror them raw — at most say in one line what happened.
        const envelope = systemEnvelope(text)
        if (envelope) {
          if (envelope.kind === 'agent-message') {
            const report = subagentReport(text)
            if (report) await this.postReport(session, report)
          } else if (envelope.summary && !envelope.routine) await post(`🤖 ${truncate(envelope.summary, 300)}`)
          break
        }
        session.lastInjected = undefined
        session.triggerTs = undefined
        // It is their own text, but a long paste on a phone pushes the answer off screen; keep the opening.
        const mirrorTs = await this.quietSlack.post({ threadTs: session.threadTs, text: text.length > PROMPT_MIRROR_MAX ? `⌨️ ${text.slice(0, PROMPT_MIRROR_MAX)}… _(+${text.length - PROMPT_MIRROR_MAX}자, 전체는 터미널에)_` : `⌨️ ${text}` })
        this.emitEvent(session.threadTs, { type: 'user', ts: mirrorTs, text, via: 'terminal' })
        await this.beginTurn(session, this.defaultRecipient)
        break
      }
      case 'PreToolUse': {
        if (toolName) session.lastToolInput = { name: toolName, input: event.tool_input, at: Date.now() }
        if (event.tool_name === 'AskUserQuestion') {
          const questions = ((event.tool_input as { questions?: Question[] })?.questions ?? []) as Question[]
          const { text, blocks } = questionBlocks(session.pid, questions, undefined, this.mentionFor(session, 'decision'))
          session.openDialogTs = await post(text, blocks)
          // More than one question needs Claude Code's own "Submit answers" pressed once every question has
          // an answer; a single question submits itself (Enter) and there is no such line to press.
          session.openQuestionsRemaining = questions.length > 1 ? questions.length : undefined
          this.markWaiting(session, 'question')
          await this.setStatus(session, 'suspended')
        } else if (event.tool_name === 'ExitPlanMode') {
          const plan = (event.tool_input as { plan?: string } | undefined)?.plan
          const { text, blocks } = planApprovalBlocks(session.pid, this.mentionFor(session, 'decision'), typeof plan === 'string' ? plan : undefined)
          session.openDialogTs = await post(text, blocks)
          this.markWaiting(session, 'plan')
          await this.setStatus(session, 'suspended')
        }
        break
      }
      case 'PostToolUse':
      case 'PostToolUseFailure':
        // A tool finished: the moment Claude Code itself would hand over a queued message.
        await this.releaseHeldIfIdle(session, 'tool finished', { drain: true })
        break
      case 'Stop': {
        // We cut the previous turn with Esc and opened a new one at once; its Stop can arrive
        // after ours began. Before the new turn has produced anything, a Stop is the old one's.
        const lateAfterEsc = session.escAt !== undefined && Date.now() - session.escAt < LATE_STOP_MS && session.turn && !session.turn.hasContent
        if (lateAfterEsc) {
          this.logAt('INFO', 'esc', 'late Stop of the interrupted turn ignored', this.tag(session))
          break
        }
        await this.finishTurn(session, String(event.last_assistant_message ?? ''), post)
        await this.releaseHeldIfIdle(session, 'turn ended', { drain: true })
        break
      }
      case 'Notification': {
        const type = String(event.notification_type ?? '')
        if (type === 'elicitation_dialog' || type === 'agent_needs_input') {
          // Claude Code says it needs input. Show the actual dialog as buttons rather
          // than telling the user to go look at the terminal.
          if (session.pane) {
            const screen = await this.tmux.capture(session.pane).catch(() => '')
            if (screen && (await this.surfaceDialog(session, screen))) break
          }
          await post(`${this.mentionFor(session, 'decision') ? `<@${this.mentionFor(session, 'decision')}> ` : ''}⏸️ 터미널에서 입력을 기다리는 중: ${truncate(String(event.message ?? ''), 500)}\n\`:screen\` 으로 화면을 확인하세요.`)
          this.markWaiting(session, 'dialog')
          await this.setStatus(session, 'suspended')
        }
        break
      }
      case 'SessionEnd': {
        if (event.reason !== 'clear') await this.endSession(session, `종료 (${String(event.reason ?? 'unknown')})`)
        break
      }
    }
  }

  /**
   * The same hook can be configured at user and project level, so one event
   * arrives twice. Content alone is not identity — saying "네" twice in a row is
   * two real turns — so the transcript position tells them apart: duplicates
   * share a position, a genuine repeat comes after the file has grown.
   */
  private isDuplicateHook(key: string, session: Session, event: HookEvent): boolean {
    if (!DEDUPED_HOOKS.has(event.hook_event_name)) return false
    // Each hook needs something that differs between two real events. SessionEnd
    // carries no text at all, so without the reason a `/clear` end and a genuine
    // termination arriving together would collapse into one and the session would
    // never be closed out.
    const detail =
      event.hook_event_name === 'PreToolUse'
        ? `${String(event.tool_name)}|${String(event.tool_use_id ?? JSON.stringify(event.tool_input ?? ''))}`
        : event.hook_event_name === 'SessionEnd'
          ? String(event.reason ?? '')
          : String(event.user_message ?? event.last_assistant_message ?? '')
    return this.recentHooks.isRepeat(`${key}|${event.hook_event_name}|${session.tailer?.position ?? 0}|${detail.slice(0, 300)}`)
  }

  /**
   * The turn is over: flush what the transcript still holds, close the stream,
   * and make sure the answer was said once — through the stream if it carried
   * text, otherwise from the hook's copy.
   */
  private async finishTurn(session: Session, finalText: string, post: (text: string) => Promise<unknown>): Promise<void> {
    // Keep watching after the turn: the next dialog may arrive before the next turn.
    this.armStall(session)
    // The poller can lag the hook; wait for it so the final text is not rendered twice.
    await session.tailer?.drain()
    const repliedThisTurn = session.lastReplyText !== undefined
    session.lastReplyText = undefined
    // The "N분째 새 출력이 없습니다" notice is about a turn that is now over; a stale one reads as still stuck.
    if (session.quietTs) {
      await this.slack.delete(session.quietTs).catch(() => {})
      session.quietTs = undefined
    }
    session.lastFinalText = finalText.trim() || undefined

    // Close the stream before clearing the field: while `end()` awaits, a late
    // transcript event must land in the turn that is finishing, not start a new one.
    const turn = session.turn
    if (turn) {
      const abandoned = await turn.end()
      for (const id of abandoned) this.emitEvent(session.threadTs, { type: 'tool_end', id, ok: false, output: '(중단됨)' })
      session.turn = undefined
      // Work the turn started may still run: the list says 백그라운드 then (75).
      this.backgroundTasks(session).then((tasks) => {
        session.bgTitles = tasks.map((t) => t.label)
        this.changed()
      }, () => {})
    }
    // "sent" after a reply-tool call is the model narrating the tool result, not an answer.
    const echo = repliedThisTurn && isToolEcho(finalText)
    if (finalText && !echo && !turn?.rendered(finalText)) {
      // A trailing ```choices block (22) is never part of the answer itself, on either surface.
      const { text: stripped, choices } = extractChoices(finalText)
      const who = this.wantsMention(session, 'all') ? `<@${session.recipient || this.defaultRecipient}> ` : ''
      const parts = chunk(toMrkdwn(stripped))
      this.emitEvent(session.threadTs, { type: 'text', text: stripped, ...(choices ? { choices } : {}) })
      for (const [i, part] of parts.entries()) await this.quietSlack.post({ threadTs: session.threadTs, text: i === 0 ? who + part : part })
      if (choices) {
        session.lastChoices = choices
        const cb = choiceBlocks(session.pid, choices, this.mentionFor(session, 'decision'))
        await this.quietSlack.post({ threadTs: session.threadTs, text: cb.text, blocks: cb.blocks })
      }
    } else if (echo) this.logAt('DEBUG', 'stream', 'dropped tool-echo final text', this.tag(session, { text: finalText.trim() }))

    if (session.triggerTs) {
      await this.slack.unreact(session.triggerTs, 'eyes')
      await this.slack.react(session.triggerTs, 'white_check_mark')
      session.triggerTs = undefined
    }
    this.clearWaiting(session)
    session.stuckShown = undefined
    await this.setStatus(session, 'active')
    void this.maybeRunScheduledRefresh(session)
  }

  /** A subagent's report, without the harness framing, in as many messages as it takes (within reason). */
  private async postReport(session: Session, report: string): Promise<void> {
    const body = report.length > REPORT_MAX_CHARS ? report.slice(0, REPORT_MAX_CHARS) + '\n\n_… 이하 생략. 전체는 터미널 기록에 있습니다._' : report
    const parts = chunk(toMrkdwn(body))
    for (const [i, part] of parts.entries()) {
      await this.slack.post({ threadTs: session.threadTs, text: i === 0 ? `🤖 *서브에이전트 보고*\n${part}` : part })
    }
    // The page gets the same report, marked, so it can draw it as a 서브에이전트 보고 card (72).
    this.emitEvent(session.threadTs, { type: 'text', text: `🤖 *서브에이전트 보고*\n${body}` })
    this.logAt('INFO', 'stream', 'subagent report', this.tag(session, { chars: report.length, parts: parts.length }))
  }

  private watchTranscript(session: Session, path: string): void {
    if (session.transcriptPath === path) return
    session.tailer?.close()
    session.transcriptPath = path
    // Which file a session is tailing is the first thing to check when its
    // output stops reaching Slack, and it is not visible from anywhere else.
    const startAt = this.offsets.get(session.key, path)
    this.logAt('INFO', 'transcript', startAt !== undefined ? 'resuming' : 'tailing', this.tag(session, { path: shortenHome(path), at: startAt }))
    const tailer = new TranscriptTailer(path, { startAt, onEvent: (ev) => this.onTranscript(session, ev) })
    tailer.on('error', (e) => this.logAt('WARN', 'transcript', `tailer error: ${describeError(e)}`, this.tag(session)))
    session.tailer = tailer
  }

  /** What a local command printed or failed with, in the thread; the commands whose screen was already shown are not repeated. */
  private async showLocalOutput(session: Session, raw: string, isError: boolean): Promise<void> {
    const text = raw.replace(ANSI_RE, '').trim()
    if (!text) return
    if (!isError && Date.now() - (session.screenShownAt ?? 0) < LOCAL_OUTPUT_DEDUPE_MS) return
    const body = '```' + truncate(text.replace(/```/g, "'''"), 3500) + '```'
    await this.slack.post({ threadTs: session.threadTs, text: isError ? `⚠️ 명령 오류\n${body}` : body }).catch((e) => this.logAt('WARN', 'slack', `local command output not posted: ${describeError(e)}`, this.tag(session)))
  }

  private async onTranscript(session: Session, ev: TranscriptEvent): Promise<void> {
    if (session.ended) return
    if (ev.uuid && this.forkSkips.get(session.threadTs)?.has(ev.uuid)) return
    if (session.transcriptPath && session.tailer) this.offsets.set(session.key, session.transcriptPath, session.tailer.position)
    if (session.turn) this.noteActivity(session)
    if (ev.kind === 'title') {
      // A name a person chose (applyTitle) always wins: Claude Code's own ai-title must not overwrite it
      // anywhere — root message, Slack session name, panel, home tab alike, not just the web app.
      if (session.manualTitle) return
      session.title = ev.title
      await this.refreshRoot(session)
      if (session.statusCreated) await this.slack.renameSession(session.threadTs, ev.title).catch((e) => this.logAt('WARN', 'slack', `rename failed: ${describeError(e)}`, this.tag(session)))
      this.schedulePanelRefresh(session)
      return
    }
    if (ev.kind === 'model') {
      if (session.model !== ev.model) {
        session.model = ev.model
        // /model typed in the terminal only shows here. Same family: the launch choice stands (opus[1m] keeps its
        // [1m], which the transcript drops); another family: the choice is stale, the transcript's model is what runs.
        if (session.launchModel && modelFamily(session.launchModel) && modelFamily(session.launchModel) !== modelFamily(ev.model)) session.launchModel = undefined
        this.schedulePanelRefresh(session)
        this.changed()
      }
      return
    }
    if (ev.kind === 'user') {
      this.confirmInjected(session, ev.text)
      await this.notifyBackgroundTasks(session, ev.text)
      return
    }
    if (ev.kind === 'local') return this.showLocalOutput(session, ev.text, ev.isError)
    if (ev.kind === 'thinking') return
    if (!session.turn && ev.kind === 'text' && session.lastFinalText && ev.text.trim() === session.lastFinalText) return
    if (!session.turn) await this.beginTurn(session, session.recipient)
    const turn = session.turn!
    const view: ViewMode = session.view ?? 'normal'
    switch (ev.kind) {
      case 'text':
        // Claude sometimes answers through the reply tool and then repeats it as its final text.
        if (session.lastReplyText && ev.text.trim() === session.lastReplyText) break
        if (session.lastReplyText !== undefined && isToolEcho(ev.text)) break
        turn.text(ev.text)
        this.emitEvent(session.threadTs, { type: 'text', text: ev.text })
        break
      case 'tool_use':
        if (ev.name === 'mcp__slack__reply') break
        // The plan belongs in its own message, not in the stream of tool calls.
        if (ev.name === 'TodoWrite') {
          ;(session.silentTools ??= new Set()).add(ev.id)
          await this.showTodos(session, parseTodos(ev.input))
          break
        }
        if (CODING_TOOLS.has(ev.name)) session.codingTurn = true
        // The PR review loop (75): a Skill call for pr-review-loop starts it.
        if (ev.name === 'Skill' && /(^|:)pr-review-loop$/.test(String((ev.input as { skill?: string } | undefined)?.skill ?? ''))) session.reviewLoop = true
        this.emitEvent(session.threadTs, { type: 'tool', id: ev.id, name: ev.name, title: activityLine(ev.name, ev.input, session.cwd).replace(/`/g, ''), ...(activityDetails(ev.name, ev.input) ? { detail: activityDetails(ev.name, ev.input) } : {}) })
        // Summary view: the answer and the decisions, no cards. The tool is still tracked as in flight.
        if (view === 'summary') {
          turn.taskStart(ev.id, activityLine(ev.name, ev.input, session.cwd).replace(/`/g, ''), { silent: true })
          break
        }
        turn.taskStart(ev.id, activityLine(ev.name, ev.input, session.cwd).replace(/`/g, ''), {
          details: activityDetails(ev.name, ev.input),
          sources: activitySources(ev.name, ev.input),
          ...(view === 'verbose' ? { verbose: true } : {}),
        })
        break
      case 'tool_result': {
        const denial = ev.isError ? classifierDenial(ev.output) : null
        if (denial) await this.reportDenial(session, ev.toolUseId, denial.reason)
        if (session.silentTools?.delete(ev.toolUseId)) break
        const images = (ev.images ?? []).map((im) => this.images.put(session.threadTs, Buffer.from(im.data, 'base64'), im.mediaType)).filter((x): x is WebImage => !!x)
        // Its round says clean or abort: the loop is over (75).
        if (/ROUND_CLEAN|ROUND_ABORT/.test(ev.output ?? '')) session.reviewLoop = undefined
        this.emitEvent(session.threadTs, { type: 'tool_end', id: ev.toolUseId, ok: !ev.isError, output: truncate(ev.output ?? '', 4_000), ...(images.length ? { images } : {}) })
        turn.taskEnd(ev.toolUseId, ev.output, ev.isError)
        // The moment Claude Code itself would hand over a queued message.
        await this.releaseHeldIfIdle(session, 'tool result')
        break
      }
    }
  }

  /**
   * Auto mode refused a tool call. There is no dialog and nothing to approve,
   * so say what happened and what would change it, instead of leaving the
   * model to explain (last time it asked the user to approve a prompt that
   * did not exist).
   */
  private async reportDenial(session: Session, toolUseId: string, reason: string): Promise<void> {
    const sig = `denied|${toolUseId}`
    if (session.stuckShown === sig) return
    session.stuckShown = sig
    this.logAt('WARN', 'perm', 'auto mode classifier denied a tool call', this.tag(session, { reason }))
    await this.slack.post({
      threadTs: session.threadTs,
      text: `🚫 자동 모드가 도구 호출을 거부했습니다: \`${reason}\`. 누를 확인 창은 없습니다. 이 작업이 필요하면 설정에서 권한 모드를 바꾸거나(⚙️ 설정 → 권한 모드) 다른 방법으로 지시하세요.`,
    })
  }

  /** Keep one checklist message per session, edited as the plan changes. */
  private async showTodos(session: Session, todos: Todo[]): Promise<void> {
    const text = todoList(todos)
    if (!text || text === session.lastTodoText) return
    session.lastTodoText = text
    this.emitEvent(session.threadTs, { type: 'todos', todos: todos.map((t) => ({ content: t.content, status: t.status, ...(t.activeForm ? { activeForm: t.activeForm } : {}) })) })
    // Slack draws a plan block with its own agent styling; the text stays as the
    // notification body and as what is shown if the block is rejected.
    const plan = todoPlanBlock(todos)
    session.todoTs = (await this.mirrorOff.run(true, () => this.say(session, { ts: session.todoTs, text, blocks: plan ? [plan] : undefined }))) ?? session.todoTs
  }

  /**
   * Post or edit a message, keeping the text if Slack rejects the blocks. The
   * newer agent blocks (plan, alert, markdown) are not accepted on every
   * surface, and a notice that fails to render is worse than a plain one.
   */
  private async say(session: Session, o: { ts?: string; text: string; blocks?: unknown[] }): Promise<string | undefined> {
    const send = async (blocks?: unknown[]): Promise<string | undefined> => {
      if (o.ts) {
        await this.slack.update(o.ts, o.text, blocks)
        return o.ts
      }
      return await this.slack.post({ threadTs: session.threadTs, text: o.text, blocks })
    }
    // A block type this workspace has already refused is not sent again: the
    // refusal cost two API calls each time and, at one per stall tick, was most
    // of the errors in the log.
    const types = (o.blocks as Array<{ type?: string }> | undefined)?.map((b) => String(b.type)) ?? []
    const blocks = types.some((t) => this.unsupportedBlocks.has(t)) ? undefined : o.blocks
    try {
      return await send(blocks)
    } catch (err) {
      if (!blocks) {
        this.logAt('WARN', 'slack', `post failed: ${describeError(err)}`, this.tag(session))
        return undefined
      }
      const unsupported = /not supported in this container/i.test(String((err as { data?: { response_metadata?: { messages?: string[] } } })?.data?.response_metadata?.messages?.join(' ') ?? err))
      if (unsupported) for (const t of types) this.unsupportedBlocks.add(t)
      this.logAt(unsupported ? 'INFO' : 'WARN', 'slack', `blocks rejected, falling back to text${unsupported ? ' (will not send these block types again)' : ''}: ${describeError(err)}`, this.tag(session, { blocks: types.join(',') }))
      try {
        return await send()
      } catch (err2) {
        this.logAt('WARN', 'slack', `post failed: ${describeError(err2)}`, this.tag(session))
        return undefined
      }
    }
  }

  private async beginTurn(session: Session, recipient: string): Promise<void> {
    session.codingTurn = undefined
    if (session.turn) {
      await session.turn.end()
      session.turn = undefined
    }
    session.recipient = recipient || this.defaultRecipient
    // A new turn means the person answered whatever was waited on. A card still open for it (its terminal
    // dialog may since have scrolled off or been answered at the real tmux window) is folded rather than
    // left looking like nothing happened.
    if (session.openDialogTs) {
      this.slack.update(session.openDialogTs, '✅ 넘어감', [{ type: 'section', text: { type: 'mrkdwn', text: '✅ 넘어감 (새 턴이 시작됐습니다)' } }]).catch(() => {})
    }
    this.clearWaiting(session)
    await this.setStatus(session, 'processing')
    session.turn = new TurnStream(this.quietSlack, { threadTs: session.threadTs, recipient: session.recipient, flushMs: this.cfg.flushMs, heartbeatMs: this.cfg.heartbeatMs, log: (m) => this.logAt('INFO', 'stream', m, this.tag(session)) })
    session.stallShown = undefined
    session.quietTs = undefined
    this.noteActivity(session)
  }

  // ----------------------------------------------------------- stall watchdog

  /** (Re)start the countdown: called when a turn begins and on every transcript event. */
  /**
   * Something happened: restart both the silence clock and the timer. Kept apart
   * from `armStall` because the watchdog re-arms itself on every tick, and if
   * that reset the clock the silence could never add up.
   */
  private noteActivity(session: Session): void {
    session.stallSince = Date.now()
    this.armStall(session)
  }

  /**
   * Watch for as long as the session lives, not just during a turn. A dialog can
   * appear at any time — a follow-up question, a permission gate, a reconnect —
   * and tying the watchdog to our own turn bookkeeping meant that after a broker
   * restart nothing was looking, so the second question never reached Slack.
   */
  private armStall(session: Session): void {
    this.clearStall(session)
    if (!session.pane || session.ended) return
    session.stallTimer = setTimeout(() => {
      session.stallTimer = undefined
      this.onStall(session).catch((e) => this.logAt('WARN', 'stall', `stall check failed: ${describeError(e)}`, this.tag(session)))
    }, this.cfg.stallMs ?? STALL_MS)
    session.stallTimer.unref?.()
  }

  private clearStall(session: Session): void {
    if (session.stallTimer) clearTimeout(session.stallTimer)
    session.stallTimer = undefined
  }

  /**
   * No transcript activity for a while. If the terminal is sitting on a dialog,
   * answer it (known ones) or hand it to Slack as buttons (unknown ones).
   * Long tool calls also look quiet, so without a dialog stay silent until
   * STALL_SCREEN_MS, then show the screen once.
   */
  private async onStall(session: Session): Promise<void> {
    if (session.ended || !session.pane) return
    // Already waiting on the user via hooks (permission, AskUserQuestion, plan): nothing to add.
    const waitingOnUser = session.state === 'waiting' || [...this.pendingPermissions.keys()].some((k) => k.startsWith(`${session.pid}:`))
    if (waitingOnUser) {
      // The status line shows how long they have waited; keep it current.
      if (session.waitingSince) this.refreshRoot(session).catch(() => {})
    } else {
      const screen = await this.tmux.capture(session.pane)
      if (await this.surfaceDialog(session, screen)) return this.armStall(session)
      // A turn that looks busy but whose screen says "Interrupted": that is not quiet, that is waiting.
      if (session.turn && (await this.surfaceStuck(session, screen))) return this.armStall(session)
      // A turn whose screen shows a bare idle prompt: the Stop hook never reached us. Close the turn
      // ourselves rather than calling the session busy forever (and posting the screen every 90s).
      if (
        session.turn &&
        detectStuckState(screen)?.kind === 'idle-prompt' &&
        Date.now() - (session.stallSince ?? 0) >= (this.cfg.stallMs ?? STALL_MS) &&
        !(session.transcriptPath && transcriptTurnLooksOpen(session.transcriptPath))
      ) {
        this.logAt('WARN', 'stall', 'idle prompt with an open turn; closing it (Stop hook missed?)', this.tag(session))
        await this.finishTurn(session, '', (text) => this.slack.post({ threadTs: session.threadTs, text }))
        await this.releaseHeldIfIdle(session, 'idle prompt')
        return this.armStall(session)
      }
      // Only a turn in progress can be "quiet"; an idle session simply waits.
      const quietFor = Date.now() - (session.stallSince ?? Date.now())
      if (session.turn && quietFor >= (this.cfg.quietMs ?? STALL_SCREEN_MS)) await this.reportQuiet(session, screen, quietFor)
    }
    this.armStall(session)
  }

  /**
   * The screen says the session is stopped and waiting for a person. Say that,
   * with the button that resolves it, and stop calling the session busy.
   */
  private async surfaceStuck(session: Session, screen: string): Promise<boolean> {
    const stuck = detectStuckState(screen)
    if (!stuck || stuck.kind !== 'interrupted') return false
    const sig = `stuck|${stuck.kind}`
    if (session.stuckShown === sig) return true
    session.stuckShown = sig
    this.logAt('INFO', 'stall', 'stuck state on screen', this.tag(session, { kind: stuck.kind }))
    // The turn is over as far as the terminal is concerned; close our side of it so the thread stops saying "작업 중".
    if (session.turn) {
      await session.turn.end().catch(() => {})
      session.turn = undefined
    }
    if (session.quietTs) {
      await this.slack.delete(session.quietTs).catch(() => {})
      session.quietTs = undefined
    }
    const { text, blocks } = stuckBlocks(session.pid, { ...stuck, mention: this.mentionFor(session, 'decision') })
    await this.say(session, { text, blocks })
    this.markWaiting(session, 'instruction')
    await this.setStatus(session, 'suspended')
    return true
  }

  /**
   * Say why the thread has gone quiet, in one message that is edited as the wait
   * goes on rather than a new post each time. A long tool call is not a problem,
   * so name what is running; only when nothing is in flight is the screen worth
   * showing, and then only the lines that carry content.
   */
  /**
   * Post the terminal screen as a picture, drawn on a fixed grid so a phone and a desktop show the same
   * thing (as text, wide Korean letters drift and long lines wrap). Resolves false when it could not:
   * the caller then falls back to text.
   */
  private async postScreenImage(session: Session, caption: string): Promise<boolean> {
    if (!session.pane || this.cfg.screenImages === false) return false
    const files: string[] = []
    try {
      const pictures = await this.screenPictures(session)
      if (!pictures.length) return false
      const dir = join(imagesDir(), 'screens')
      mkdirSync(dir, { recursive: true })
      const stamp = Date.now()
      for (const p of pictures) {
        const file = join(dir, `screen-${stamp}${p.part === 'screen' ? '' : `-${p.part}`}.png`)
        writeFileSync(file, p.png)
        files.push(file)
      }
      // Two pictures (conversation and panel) go up as one message, so they stay together in the thread.
      const note = pictures.length > 1 ? `${caption} (대화 · 변경 내용, 두 장)` : caption
      return await this.slack.uploadFiles({ threadTs: session.threadTs, paths: files, text: note })
    } catch (err) {
      this.logAt('WARN', 'screen', `could not post the screen as a picture: ${describeError(err)}`, this.tag(session))
      return false
    } finally {
      for (const f of files) rmSync(f, { force: true })
    }
  }

  /** The screen of a session drawn as pictures: one, or the conversation and the side panel Claude Code has open. */
  private async screenPictures(session: Session): Promise<ScreenPicture[]> {
    const ansi = await this.screenAnsi(session.pane!)
    if (!ansi.trim()) return []
    const out = await (this.cfg.renderScreen ?? renderScreenPictures)(ansi, { title: `${basename(session.cwd)}${session.title ? ` · ${session.title}` : ''}`, maxRows: SCREEN_ROWS + SCREEN_HISTORY })
    return Buffer.isBuffer(out) ? [{ part: 'screen', png: out }] : out
  }

  /** The screen with its colours, from a window made taller when nobody is watching it, plus any scrollback. */
  private async screenAnsi(pane: string): Promise<string> {
    // Claude Code draws to fill the window, so a taller one shows more of the conversation. It redraws on resize.
    if (await this.tmux.growHeight(pane, SCREEN_ROWS)) await sleep(600)
    return this.tmux.captureAnsi(pane, SCREEN_HISTORY)
  }

  private async reportQuiet(session: Session, screen: string, quietFor: number): Promise<void> {
    const running = session.turn?.inFlight ?? []
    if (!session.quietTs) session.quietImage = false
    if (!running.length && !session.quietImage && (await this.postScreenImage(session, `⏳ ${duration(quietFor)}째 새 출력이 없습니다. 터미널 화면`))) session.quietImage = true
    const body = running.length
      ? `실행 중: ${running.map((t) => `\`${truncate(t, 80)}\``).join(', ')}`
      : session.quietImage
        ? '터미널 화면은 위 이미지를 보세요.'
        : (() => {
          const digest = screenDigest(screen)
          return digest ? `터미널 화면:\n\`\`\`${truncate(digest.replace(/\`\`\`/g, "'''"), 2500)}\`\`\`` : '터미널에 새로 표시된 내용이 없습니다.'
        })()
    const text = `⏳ ${duration(quietFor)}째 ${running.length ? '작업 중입니다' : '새 출력이 없습니다'}. ${body}\n\`:screen\` 전체 화면 · \`:esc\` 중단`
    const headline = `${duration(quietFor)}째 ${running.length ? `작업 중: ${running.join(', ')}` : '새 출력이 없습니다'}`
    session.quietTs =
      (await this.say(session, {
        ts: session.quietTs,
        text,
        blocks: [alertBlock(headline, 'info'), { type: 'markdown', text: `${body}\n\n\`:screen\` 전체 화면 · \`:esc\` 중단` }],
      })) ?? session.quietTs
  }

  /**
   * Look at a screen for a dialog. Known dialogs are answered on the spot;
   * any other numbered dialog is posted to the thread as buttons. Returns
   * true when something was found (and handled or surfaced).
   */
  private async surfaceDialog(session: Session, screen: string): Promise<boolean> {
    if (!session.pane) return false
    const known = await this.dialogs.confirmKnown(session.pane, screen)
    if (known) {
      this.logAt('INFO', 'dialog', `auto-confirmed ${known}`, this.tag(session))
      await this.slack.post({ threadTs: session.threadTs, text: `↩️ 터미널 확인 창(${known})을 자동으로 넘겼습니다` })
      return true
    }
    const dialog = parseDialog(screen)
    if (!dialog) return this.surfaceKeyedDialog(session, screen)
    const sig = `${dialog.question}|${dialog.options.map((o) => o.label).join('|')}`
    if (session.stallShown === sig) return true
    // 전부 허용: a permission asked only in the terminal (no MCP request) is pressed "yes" here too.
    // Only a yes/no proceed dialog; a question or a plan still goes to the person.
    if (session.autoAllow && isProceedDialog(dialog)) {
      // A single 'unfocused' (the prompt briefly holding the keyboard) must not fall straight through to a
      // card — that asks a person for something 전부 허용 already promised to handle. Retried a few times
      // first, 1,000 ms apart, before giving the terminal up as genuinely stuck.
      let pressed: Awaited<ReturnType<typeof this.dialogs.answerProceed>> = 'unfocused'
      for (let i = 0; i < AUTO_ALLOW_PRESS_TRIES; i++) {
        pressed = await this.dialogs.answerProceed(session.pane, 'auto')
        if (pressed === 'answered' || i === AUTO_ALLOW_PRESS_TRIES - 1) break
        this.logAt('INFO', 'perm', `auto-allow press ${i + 1} failed (${pressed}); retrying`, this.tag(session))
        await sleep(AUTO_ALLOW_PRESS_RETRY_MS)
      }
      if (pressed === 'answered') {
        const what = [dialog.context, dialog.description, dialog.question].filter(Boolean).join('\n')
        this.logAt('INFO', 'perm', 'auto-allowed a terminal dialog', this.tag(session, { question: truncate(dialog.question, 80) }))
        await this.slack.post({ threadTs: session.threadTs, text: `⚡ 자동 허용 · 터미널 확인 창\n\`\`\`${truncate(what, 2500).replace(/```/g, "'''")}\`\`\`` })
        return true
      }
      this.logAt('WARN', 'perm', `auto-allow could not press after ${AUTO_ALLOW_PRESS_TRIES} tries (${pressed}); asking instead`, this.tag(session, { question: truncate(dialog.question, 80) }))
    }
    session.stallShown = sig
    // The same dialog coming back again and again (an MCP server's Authenticate/Reconnect menu, say) is not
    // a question to answer again: after two cards, say once why it repeats and what fixes it.
    const seen = (session.dialogSeen ??= new Map()).get(sig) ?? { n: 0, at: Date.now() }
    if (Date.now() - seen.at > 15 * 60_000) Object.assign(seen, { n: 0, at: Date.now() })
    seen.n++
    session.dialogSeen.set(sig, seen)
    if (seen.n > 2) {
      if (seen.n === 3) {
        const mcp = dialog.options.some((o) => /^(Authenticate|Reconnect|Re-?authenticate)/i.test(o.label))
        const why = mcp
          ? 'MCP 서버 인증 메뉴가 되풀이됩니다. 설정 파일의 서버 주소와 실행 중인 세션이 쓰는 주소가 다르거나, 설정을 바꾼 뒤 세션을 다시 띄우지 않은 경우입니다. 설정은 세션을 다시 띄워야 반영됩니다.'
          : '같은 확인 창이 되풀이됩니다. 답해도 다시 뜨는 창이라 카드를 더 올리지 않습니다. 설정을 바꿨다면 세션을 다시 띄워야 반영됩니다.'
        this.logAt('WARN', 'dialog', 'dialog keeps coming back', this.tag(session, { question: truncate(dialog.question, 80), mcp }))
        await this.slack.post({
          threadTs: session.threadTs,
          text: `⚠️ ${why}`,
          blocks: [
            { type: 'section', text: { type: 'mrkdwn', text: `⚠️ ${why}` } },
            { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: '🔄 새로고침 (다시 열기)' }, action_id: `ctl_btn_refresh_${session.pid}`, value: encodeValue(session.pid, 'refresh'), style: 'primary' }, { type: 'button', text: { type: 'plain_text', text: '🖥 화면' }, action_id: `ctl_btn_screen_${session.pid}`, value: encodeValue(session.pid, 'screen') }] },
          ],
        })
      }
      this.markWaiting(session, 'dialog')
      return true
    }
    this.logAt('INFO', 'dialog', 'numbered dialog surfaced', this.tag(session, { question: truncate(dialog.question, 80), options: dialog.options.length }))
    // What is being confirmed goes above the question as a code box: the question alone is often just "Do you want to proceed?".
    const about = [dialog.context ? '```' + truncate(dialog.context, 2500).replace(/```/g, "'''") + '```' : '', dialog.description ?? ''].filter(Boolean).join('\n')
    const { text, blocks } = questionBlocks(
      session.pid,
      [{ header: '터미널', question: dialog.question, options: dialog.options.map((o) => ({ label: o.label, description: o.description })) }],
      about || undefined,
      this.mentionFor(session, 'decision'),
    )
    session.openDialogTs = await this.slack.post({ threadTs: session.threadTs, text, blocks })
    this.markWaiting(session, 'dialog')
    await this.setStatus(session, 'suspended')
    return true
  }

  /**
   * A dialog with nothing numbered to press. Claude Code's checkbox forms look
   * like this, and before we recognized them the session simply sat there: the
   * quiet notice said something was up, but there was nothing to act on.
   */
  private async surfaceKeyedDialog(session: Session, screen: string): Promise<boolean> {
    const keyed = parseKeyedDialog(screen)
    if (!keyed) return false
    const sig = `keyed|${keyed.question}|${keyed.body ?? ''}`
    if (session.stallShown === sig) return true
    session.stallShown = sig
    this.logAt('INFO', 'dialog', 'keyed dialog surfaced', this.tag(session, { question: truncate(keyed.question, 80) }))
    const { text, blocks } = keyedDialogBlocks(session.pid, keyed, this.mentionFor(session, 'decision'))
    session.openDialogTs = await this.slack.post({ threadTs: session.threadTs, text, blocks })
    this.markWaiting(session, 'dialog')
    await this.setStatus(session, 'suspended')
    return true
  }

  /**
   * Capture once the screen stops changing, so a command's output is complete
   * rather than half-drawn. Falls back to the last capture on timeout.
   */
  private async settledScreen(pane: string, timeoutMs = SCREEN_SETTLE_TIMEOUT_MS): Promise<string> {
    const deadline = Date.now() + timeoutMs
    let prev = await this.tmux.capture(pane)
    while (Date.now() < deadline) {
      await sleep(SCREEN_SETTLE_MS)
      const next = await this.tmux.capture(pane)
      if (next === prev) return next
      prev = next
    }
    return prev
  }

  /**
   * Read `/btw`'s answer off the screen: polled, not just "stopped changing" (a slow start can sit on the
   * spinner just long enough to look settled), and only accepted once the same non-spinner content reads
   * back twice in a row — a panel still filling in is "not yet", not a short, truncated answer.
   */
  /**
   * Waits for a file to exist and hold the same non-empty content across two polls in a row — Claude
   * writing SESSION.md for `:lightfork` is still mid-write the first time the file appears.
   */
  private async awaitStableFile(path: string, timeoutMs: number, pollMs: number): Promise<string | undefined> {
    const deadline = Date.now() + timeoutMs
    let last: string | undefined
    while (Date.now() < deadline) {
      await sleep(pollMs)
      let content: string | undefined
      try {
        content = readFileSync(path, 'utf8')
      } catch {
        continue
      }
      if (content && content === last) return content
      last = content
    }
    return undefined
  }

  private async readBtwAnswer(pane: string, before: string, timeoutMs = BTW_TIMEOUT_MS): Promise<string | undefined> {
    const deadline = Date.now() + timeoutMs
    let lastFresh: string | undefined
    while (Date.now() < deadline) {
      await sleep(BTW_POLL_MS)
      const screen = await this.tmux.capture(pane)
      const after = screenDigest(screen, 200)
      const lines = after
        .split('\n')
        .filter((l) => !before.includes(l) && !l.includes('/btw') && !/to scroll · c to copy|Plugins updated|reload-plugins/i.test(l))
        .map((l) => l.replace(/[▔]{3,}/g, '').trim())
        .filter(Boolean)
      // A spinner line alone ("✽ Thinking… (2s)") is still working, not an answer yet.
      if (!lines.length || (lines.length === 1 && WORKING_RE.test(lines[0]!))) {
        lastFresh = undefined
        continue
      }
      const fresh = lines.join('\n')
      if (fresh === lastFresh) return fresh
      lastFresh = fresh
    }
    return lastFresh
  }

  /**
   * Show a terminal screen in the thread. The digest drops box rules, the status
   * line and the empty input box, which is nearly all of a full-height TUI on a
   * phone; `raw` keeps every line for when that is the point.
   */
  private screenBlock(screen: string, opts: { raw?: boolean; maxLines?: number } = {}): string {
    const body = opts.raw ? screen.replace(/\s+$/, '') : screenDigest(screen, opts.maxLines ?? SCREEN_DIGEST_LINES)
    if (!body.trim()) return '터미널 화면에 표시된 내용이 없습니다.'
    return '```' + truncate(body.replace(/```/g, "'''"), 3800) + '```'
  }

  /** After typing a command into the terminal, watch briefly for a dialog it may open. */
  private async checkDialogSoon(session: Session, timeoutMs = POST_COMMAND_DIALOG_MS): Promise<boolean> {
    if (!session.pane) return false
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await sleep(DIALOG_POLL_MS)
      if (await this.surfaceDialog(session, await this.tmux.capture(session.pane))) return true
    }
    return false
  }

  private async setStatus(session: Session, status: 'active' | 'processing' | 'suspended' | 'closed'): Promise<void> {
    const state: SessionState = status === 'processing' ? 'busy' : status === 'suspended' ? 'waiting' : status === 'closed' ? 'ended' : 'idle'
    if (session.state !== state) {
      session.state = state
      this.schedulePanelRefresh(session, PANEL_REFRESH_FAST_MS)
      this.emitEvent(session.threadTs, { type: 'status', state, ...(session.waitingReason ? { waiting: WAITING_LABEL[session.waitingReason] } : {}) })
    }
    try {
      await this.slack.setSessionStatus(session.threadTs, status, {
        title: session.title ?? basename(session.cwd),
        initiatorUserId: session.recipient || this.defaultRecipient,
      })
      session.statusCreated = true
    } catch (err) {
      this.logAt('DEBUG', 'slack', `setSessionStatus(${status}) failed (Agents feature off?): ${describeError(err)}`, this.tag(session))
    }
  }

  /**
   * The thread's root message doubles as the status line: it is the one thing
   * visible from the channel list, so it carries what the session is and where
   * it stands without opening the thread.
   */
  private rootText(session: Session, icon: string, suffix: string): string {
    const name = session.title ? `${basename(session.cwd)} · ${session.title}` : basename(session.cwd)
    const status = [
      session.waitingReason && !session.ended ? `🟡 ${WAITING_LABEL[session.waitingReason]}${session.waitingSince ? ` ${duration(Date.now() - session.waitingSince)}` : ''}` : '',
      session.model ? `\`${shortModel(session.model)}\`` : '',
      session.effort ? `effort \`${session.effort}\`` : '',
      session.permissionMode ? `권한 \`${session.permissionMode}\`` : '',
      session.contextLabel ? `컨텍스트 \`${session.contextLabel}\`` : '',
    ].filter(Boolean)
    const head = `${icon} *${name}* · \`${shortenHome(session.cwd)}\` · ${suffix}`
    return status.length ? `${head}\n${status.join(' · ')}` : head
  }

  /** Refresh the root line after something on it changed. */
  private async refreshRoot(session: Session): Promise<void> {
    if (!session.rootTs) return
    // Same colours as the panel and the Home tab: 🟢 idle · 🔵 busy · 🟡 needs a person · ⚫ ended.
    const icon = session.ended ? '⚫' : session.waitingReason ? '🟡' : session.state === 'busy' ? '🔵' : '🟢'
    // Stopping has no button, so the one line always on screen has to carry the how.
    const suffix = session.ended
      ? '종료됨'
      : session.waitingReason
        ? '응답 필요'
        : session.state === 'busy'
          ? '작업 중 · 중단하려면 `:esc`'
          : session.origin === 'terminal'
            ? '터미널 세션'
            : 'Slack에서 시작'
    const text = this.rootText(session, icon, suffix)
    if (text === session.lastRootText) return
    session.lastRootText = text
    await this.slack.update(session.rootTs, text).catch((err) => this.logAt('WARN', 'slack', `root update failed: ${describeError(err)}`, this.tag(session)))
  }


  /**
   * Bring back the sessions that were alive when this broker's predecessor
   * stopped. A restart alone does not need this — the shims reconnect on their
   * own and are already in the registry by the time we look — so only threads
   * still without a session are revived, in place, with their conversation.
   */
  async reviveSessions(): Promise<void> {
    const taken = this.wasAlive
    this.wasAlive = []
    if (!taken.length) return
    await new Promise((r) => setTimeout(r, this.cfg.reviveAfterMs ?? REVIVE_AFTER_MS).unref?.())

    const maxAge = this.cfg.reviveMaxAgeMs ?? REVIVE_MAX_AGE_MS
    // Several keys can name one thread (each relaunch gets a new key); the newest speaks for it.
    const byThread = new Map<string, ReviveEntry & { key: string }>()
    for (const e of [...taken].sort((a, b) => a.lastSeen - b.lastSeen)) {
      const older = byThread.get(e.threadTs)
      if (older) this.revive.forget(older.key)
      byThread.set(e.threadTs, e)
    }
    const orphaned: Array<ReviveEntry & { key: string }> = []
    for (const e of byThread.values()) {
      // The thread has a session again under another key: the old record is history.
      if (this.registry.byThreadTs(e.threadTs)) this.revive.forget(e.key)
      else orphaned.push(e)
    }
    orphaned.sort((a, b) => b.lastSeen - a.lastSeen)
    if (!orphaned.length) return

    // Reviving a crowd at once would put a dozen Claude Code processes on the
    // machine before anyone asked for them. The newest are the ones in use; the
    // rest stay dormant and wake when someone writes in their thread.
    const newest = Math.max(...taken.map((e) => e.lastSeen))
    const recent = orphaned.filter((e) => newest - e.lastSeen < ALIVE_AT_SHUTDOWN_MS && Date.now() - e.lastSeen < maxAge)
    const revive = recent.slice(0, REVIVE_MAX)
    for (const e of orphaned) {
      if (revive.includes(e)) continue
      if (Date.now() - e.lastSeen < DORMANT_MAX_AGE_MS) this.dormant.set(e.threadTs, e)
      else this.revive.forget(e.key)
    }
    this.logAt('INFO', 'revive', `reviving ${revive.length} session(s) that did not survive the restart`, { dormant: this.dormant.size })
    for (const e of revive) {
      // The process can be alive and just slow to reattach (a loaded host, a pane mid-reconnect): launching a
      // second Claude Code onto the same conversation then gives it two writers. If the window is still there,
      // wait instead — the shim's own reconnect (or REQ-F-002's pid check) sorts it out without a second process.
      if (e.pane && (await this.tmux.hasPane(e.pane))) {
        this.logAt('WARN', 'revive', 'window still open; not reviving', { t: e.threadTs, pane: e.pane })
        await this.slack.post({ threadTs: e.threadTs, text: '⏳ 세션 창이 아직 살아 있어 다시 열지 않고 기다려요…' }).catch(() => {})
        continue
      }
      this.revive.forget(e.key)
      await this.slack.post({ threadTs: e.threadTs, text: '🔄 재시작으로 끊긴 세션을 대화 그대로 이어서 다시 엽니다.' }).catch(() => {})
      await this.launchSession({ cwd: e.cwd, prompt: '', resumeId: e.sessionId, user: e.recipient, threadTs: e.threadTs, rootTs: e.rootTs, extraArgs: this.settingsArgs(e) }).catch((err) =>
        this.logAt('ERROR', 'revive', `revive failed: ${describeError(err)}`, { t: e.threadTs }),
      )
    }
  }

  /**
   * The second half of `:refresh`: the process is gone, so open the same
   * conversation again. The thread keeps one status line — the old panel goes,
   * because its buttons address a pid that no longer exists.
   */
  /** taskId (or tool-use-id when a notice carries none) of background work already announced, so a
   *  notice does not get posted twice if the same transcript bytes are read again. */
  private notifiedBgTasks = new Set<string>()

  /** A background job (bash moved to the background, a Monitor, an async agent) finished: say so once. */
  private async notifyBackgroundTasks(session: Session, text: string): Promise<void> {
    for (const n of parseTaskNotifications(text)) {
      if (n.status === 'running' || n.status === 'killed' || n.status === 'stopped') continue
      const key = `${session.key}:${n.taskId ?? n.toolUseId ?? ''}`
      if (!n.taskId && !n.toolUseId) continue
      if (this.notifiedBgTasks.has(key)) continue
      this.notifiedBgTasks.add(key)
      const failed = n.status !== 'completed' || /exit code [1-9]|failed|error/i.test(n.summary ?? '')
      const label = truncate((n.summary ?? n.taskId ?? n.toolUseId ?? '').split('\n')[0]!, 200)
      const who = failed && this.mentionFor(session, 'all') ? `<@${this.mentionFor(session, 'all')}> ` : ''
      const headline = n.summary ? truncate(n.summary.split('\n')[0]!, 200) : `백그라운드 작업이 끝났어요 (${n.status})`
      // The notification centre takes only an alpha/deploy-style result (49); the rest is a conversation notice.
      if (/알파|alpha/i.test(headline) && /배포|deploy|publish/i.test(headline)) this.addNotice({ thread: session.threadTs, title: session.title ?? basename(session.cwd), text: headline, tone: failed ? 'fail' : 'ok' }, `${key}|${n.status}`)
      await this.slack.post({ threadTs: session.threadTs, text: `${who}${failed ? '⚠️' : '✅'} 백그라운드 작업 ${failed ? '실패' : '완료'}: ${label}` }).catch(() => {})
    }
  }

  private bgTrackers = new Map<string, BackgroundTracker>()
  /** Background work this session's process started and has not finished (by key+pid: a refresh keeps the key). */
  async backgroundTasks(session: Session): Promise<BackgroundTask[]> {
    if (!session.transcriptPath) return []
    const k = `${session.key}:${session.pid}:${session.transcriptPath}`
    let tr = this.bgTrackers.get(k)
    if (!tr) this.bgTrackers.set(k, (tr = new BackgroundTracker(session.transcriptPath)))
    tr.scan()
    const facts = await (this.cfg.processFacts ?? processFacts)(session.pid).catch(() => ({}) as { startedAt?: number; shells?: number })
    return tr.open({ now: Date.now(), processStart: facts.startedAt, shells: facts.shells })
  }

  /** What the web app shows before a refresh: is it working, and what background work would be cut. */
  async webRefreshInfo(pid: number): Promise<{ busy: boolean; tasks: Array<{ kind: string; label: string }> }> {
    const s = this.registry.byPid(pid)
    if (!s || s.ended) return { busy: false, tasks: [] }
    const tasks = await this.backgroundTasks(s).catch(() => [])
    return { busy: s.state === 'busy' || !!s.turn, tasks: tasks.map((t) => ({ kind: t.kind, label: t.label })) }
  }

  /** "끝나면 새로고침": kept by the broker, run the moment the session is idle and its background work is over. */
  private async scheduleRefresh(s: Session, c: CommandContext): Promise<void> {
    if (!s.sessionId) return void (await c.ack('⚠️ 아직 세션 id를 몰라 새로고침할 수 없습니다.'))
    if (!s.pane) return void (await c.ack('⚠️ tmux 밖에서 띄운 세션이라 새로고침할 수 없습니다.'))
    s.refreshAfter = Date.now()
    s.refreshWaitNoted = undefined
    this.logAt('INFO', 'session', 'refresh scheduled for when the work ends', this.tag(s))
    await c.post('⏳ 작업이 끝나면 새로고침합니다. 그동안 보낸 메시지는 붙잡아 두었다가 다시 연 세션에 넘깁니다.')
    this.changed()
    this.armRefreshCheck()
    await this.maybeRunScheduledRefresh(s)
  }
  private async cancelScheduledRefresh(s: Session, c: CommandContext): Promise<void> {
    if (!s.refreshAfter) return void (await c.ack('예약된 새로고침이 없어요'))
    s.refreshAfter = undefined
    this.logAt('INFO', 'session', 'scheduled refresh cancelled', this.tag(s))
    await c.post('↩️ 새로고침 예약을 취소했어요')
    this.changed()
    // What was held for the relaunch goes now, as it would have without the reservation.
    await this.releaseHeldIfIdle(s, 'refresh cancelled', { drain: true })
  }
  private async maybeRunScheduledRefresh(s: Session): Promise<void> {
    // Stopped with Esc it waits for an instruction: for a reserved refresh that is as good as idle.
    const resting = s.state === 'idle' || (s.state === 'waiting' && s.waitingReason === 'instruction')
    if (!s.refreshAfter || s.ended || s.refreshing || s.refreshChecking || s.turn || !resting || (s.waitingReason && s.waitingReason !== 'instruction')) return
    if (!s.pane) {
      // Not in tmux: it cannot be refreshed from here, so the reservation must not keep holding messages.
      s.refreshAfter = undefined
      await this.slack.post({ threadTs: s.threadTs, text: '⚠️ tmux 밖에서 띄운 세션이라 새로고침할 수 없어 예약을 취소했습니다.' }).catch(() => {})
      this.changed()
      return this.releaseHeldIfIdle(s, 'refresh impossible')
    }
    // Set before the first await: the turn's end and the one-minute look must not both get through.
    s.refreshChecking = true
    try {
      const tasks = await this.backgroundTasks(s).catch(() => [])
      if (tasks.length && !s.refreshWaitNoted) {
        // Said once, not on every look a minute later (42).
        s.refreshWaitNoted = true
        await this.slack.post({ threadTs: s.threadTs, text: `🔄 백그라운드 작업 ${tasks.length}개가 끝나면 새로고침할게요 · ${truncate(tasks[0]!.label, 80)}` }).catch(() => {})
      }
      if (tasks.length || !s.refreshAfter || s.turn || s.refreshing) return
      this.logAt('INFO', 'session', 'running the scheduled refresh', this.tag(s))
      await this.runCommand(s, 'refresh now')
    } finally {
      s.refreshChecking = false
    }
  }
  private refreshTimer?: ReturnType<typeof setInterval>
  /** Background work ends with a notification (a turn), but not always: look once a minute too. */
  private armRefreshCheck(): void {
    this.refreshTimer ??= setInterval(() => {
      const waiting = this.registry.live.filter((x) => x.refreshAfter && !x.ended)
      if (!waiting.length) {
        clearInterval(this.refreshTimer)
        this.refreshTimer = undefined
        return
      }
      for (const x of waiting) void this.maybeRunScheduledRefresh(x)
    }, this.cfg.refreshCheckMs ?? 60_000)
    this.refreshTimer.unref?.()
  }

  /** --model / --effort for relaunching a session as it is now (a refresh must not fall back to the defaults). */
  private settingsArgs(session: { launchModel?: string; model?: string; effort?: string; permissionMode?: string }): string[] {
    // The model it was launched or switched with (opus[1m] keeps its 1M context; the transcript's name drops [1m]),
    // else the one it runs now: better than falling back to the default.
    const chosen = session.launchModel ?? (session as { model?: string }).model
    const model = chosen && /^[\w.\[\]-]+$/.test(chosen) ? chosen : undefined
    const effort = session.effort && EFFORT_OPTIONS.includes(session.effort) ? session.effort : undefined
    // The permission mode too (42): a refresh or a revive opens in the mode the session was in. 전부 허용 is the
    // broker's own, not a Claude Code mode, so it is not passed; the record carries it instead.
    const mode = session.permissionMode && CLAUDE_PERMISSION_MODES.includes(session.permissionMode) ? session.permissionMode : undefined
    return [...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : []), ...(mode ? ['--permission-mode', mode] : [])]
  }

  private sizeCheckTimer?: ReturnType<typeof setInterval>

  /**
   * Transcripts grow without bound; a 50MB conversation is already slow to read back and a 100MB one
   * risks the broker itself (it reads the whole file for `read_session`, title-guessing, etc). Checked
   * every 30s (P4-32): 50MB gets one warning per session suggesting `:lightfork`, 100MB blocks further
   * Slack/web input (`sizeBlocked`, checked in `handleSlackMessage`/`webSend`) — the terminal itself can't
   * be blocked (Claude Code reads its own keyboard directly), so it only gets a one-time notice there too.
   */
  private armSizeCheck(ms?: number): void {
    this.sizeCheckTimer = setInterval(() => this.checkTranscriptSizes(), ms ?? SIZE_CHECK_MS)
    this.sizeCheckTimer.unref?.()
  }

  private checkTranscriptSizes(): void {
    for (const s of this.registry.live) {
      if (s.ended || !s.transcriptPath) continue
      let size: number
      try {
        size = statSync(s.transcriptPath).size
      } catch {
        continue
      }
      if (size >= SIZE_BLOCK_BYTES && !s.sizeBlocked) {
        s.sizeBlocked = true
        this.logAt('WARN', 'broker', 'transcript over 100MB; blocking further Slack/web input', this.tag(s, { bytes: size }))
        void this.slack.post({
          threadTs: s.threadTs,
          text: `🚫 대화 기록이 100MB 를 넘어 Slack·웹에서는 더 보낼 수 없습니다. \`:lightfork\` 로 가벼운 새 세션을 띄우세요. 터미널에서는 계속 쓸 수 있습니다(막을 수 없어요).`,
        })
      } else if (size >= SIZE_WARN_BYTES && !s.sizeWarned) {
        s.sizeWarned = true
        this.logAt('WARN', 'broker', 'transcript over 50MB', this.tag(s, { bytes: size }))
        void this.slack.post({ threadTs: s.threadTs, text: `⚠️ 대화 기록이 50MB 를 넘었습니다. 느려지기 전에 \`:lightfork\` 로 가벼운 새 세션에 이어가는 걸 권합니다.` })
      }
    }
  }

  /**
   * Writes a small `--settings` file registering `scripts/statusline.ts` as the statusLine command, so a
   * broker-launched session reports its cost/model back to `StatusStore` (P4-31) without touching the
   * person's own global `~/.claude/settings.json` — a session started by hand outside claude-slack is
   * untouched. `path === ''` (tests) skips writing one; launches then get no `--settings` flag at all.
   */
  private ensureStatusLineSettings(path?: string): string | undefined {
    if (path === '') return undefined
    const dest = path ?? join(homedir(), '.claude-slack', 'statusline-settings.json')
    try {
      const scriptPath = fileURLToPath(new URL('../scripts/statusline.ts', import.meta.url))
      const node = stableNodePath()
      mkdirSync(join(dest, '..'), { recursive: true })
      writeFileSync(dest, JSON.stringify({ statusLine: { type: 'command', command: `${node} ${scriptPath}` } }))
      return dest
    } catch (err) {
      this.logAt('WARN', 'broker', `could not write the statusLine settings file: ${describeError(err)}`)
      return undefined
    }
  }

  private async reopenForRefresh(session: Session, carried: HeldMessage[]): Promise<void> {
    session.refreshing = false
    const threadTs = session.threadTs
    // Background work the old process had running died with it: say so before anything else reaches the new one.
    if (session.interrupted?.length) {
      const list = session.interrupted.map((t) => `- ${t.kind === 'agent' ? '에이전트' : t.kind === 'monitor' ? 'Monitor' : '백그라운드 명령'}: ${t.label}`).join('\n')
      carried = [{ text: `[새로고침] 세션을 다시 열면서 백그라운드 작업이 끊겼어요.\n${list}\n필요한 것만 다시 걸고, 걸었으면 짧게 알려 줘요.`, user: session.recipient || this.defaultRecipient, ts: threadTs }, ...carried]
      session.interrupted = undefined
    }
    if (session.holdNoticeTs) {
      await this.slack.delete(session.holdNoticeTs).catch(() => {})
      session.holdNoticeTs = undefined
    }
    if (session.panelTs) await this.slack.delete(session.panelTs).catch(() => {})
    try {
      await this.launchSession({ cwd: session.cwd, prompt: '', resumeId: session.sessionId, user: session.recipient, threadTs, rootTs: session.rootTs, queued: carried, extraArgs: this.settingsArgs(session) })
    } catch (err) {
      this.waking.delete(threadTs)
      this.logAt('ERROR', 'session', `refresh relaunch failed: ${describeError(err)}`, this.tag(session))
      this.refreshFailed.set(threadTs, Date.now())
      this.changed()
      await this.slack.post({ threadTs, text: `❌ 세션을 다시 열지 못했습니다. ${describeError(err)}` }).catch(() => {})
      return
    }
    const late = this.waking.get(threadTs) ?? []
    this.waking.delete(threadTs)
    const pending = this.pendingLaunches.get(threadTs)
    if (pending) pending.queued.push(...late)
    else if (late.length) await this.slack.post({ threadTs, text: `⚠️ 전달하지 못한 메시지 ${late.length}개가 있습니다. 세션이 뜨면 다시 보내주세요.` }).catch(() => {})
  }

  /**
   * Someone wrote in a thread whose session we left asleep after a restart: reopen
   * it with its conversation and hand it what they wrote.
   */
  private async wakeDormant(e: ReviveEntry & { key: string }, first: { text: string; user: string; ts: string }): Promise<void> {
    this.dormant.delete(e.threadTs)
    this.revive.forget(e.key)
    this.waking.set(e.threadTs, [])
    await this.slack.react(first.ts, 'eyes').catch(() => {})
    await this.slack.post({ threadTs: e.threadTs, text: '🔄 재시작으로 끊긴 세션을 대화 그대로 이어서 다시 엽니다. 준비되면 방금 메시지를 바로 전달하겠습니다.' }).catch(() => {})
    try {
      await this.launchSession({ cwd: e.cwd, prompt: first.text, resumeId: e.sessionId, user: first.user, threadTs: e.threadTs, rootTs: e.rootTs, extraArgs: this.settingsArgs(e) })
    } catch (err) {
      this.logAt('ERROR', 'revive', `wake failed: ${describeError(err)}`, { t: e.threadTs })
    }
    const late = this.waking.get(e.threadTs) ?? []
    this.waking.delete(e.threadTs)
    const pending = this.pendingLaunches.get(e.threadTs)
    if (pending) pending.queued.push(...late)
    else if (late.length) await this.slack.post({ threadTs: e.threadTs, text: `⚠️ 전달하지 못한 메시지 ${late.length}개가 있습니다. 세션이 뜨면 다시 보내주세요.` }).catch(() => {})
  }

  // -------------------------------------------------------------- Slack side

  /**
   * Downloads attachments to disk and appends their paths so Claude Code can
   * `Read` them, even when the Slack message carries no caption text. Images
   * are what Claude sees directly; anything else (a PDF, a log) is handed over
   * as a file path, the way Remote Control passes non-photo files as `@` references.
   */
  private async resolveInboundText(m: InMsg): Promise<string> {
    if (!m.files?.length) return m.text
    const attachments: string[] = []
    for (const [i, f] of m.files.entries()) {
      try {
        const buf = await this.slack.downloadFile(f.url)
        const dir = imagesDir()
        mkdirSync(dir, { recursive: true })
        const isImage = f.mimetype.startsWith('image/')
        const ext = (f.name.includes('.') ? f.name.split('.').pop() : undefined) || f.mimetype.split('/')[1] || 'bin'
        const path = join(dir, `${m.ts}-${i}-${basename(f.name, `.${ext}`)}.${ext}`)
        await writeFile(path, buf)
        attachments.push(isImage ? `[Image attached: ${path}]` : `[File attached: ${path}]`)
        this.logAt('INFO', 'slack', 'attachment saved', { ts: m.ts, name: f.name, type: f.mimetype, bytes: buf.length })
      } catch (err) {
        this.logAt('WARN', 'slack', `attachment download failed: ${describeError(err)}`, { ts: m.ts, name: f.name })
      }
    }
    if (!attachments.length) return m.text
    return m.text ? `${m.text}\n${attachments.join('\n')}` : attachments.join('\n')
  }

  /**
   * A thread the previous broker recorded as alive within the window the shutdown cared about
   * (REQ-F-050): wait for its session to reattach instead of saying there is none, but only
   * for STARTUP_GRACE_MS after this broker's own start — past that, it really is gone.
   */
  private async awaitReattach(threadTs: string): Promise<Session | undefined> {
    const graceMs = this.cfg.startupGraceMs ?? STARTUP_GRACE_MS
    const elapsed = Date.now() - this.startedAt
    if (elapsed >= graceMs) return undefined
    const record = this.recordedAtStart.find((e) => e.threadTs === threadTs)
    if (!record) return undefined
    const deadline = this.startedAt + graceMs
    while (Date.now() < deadline) {
      const found = this.registry.byThreadTs(threadTs)
      if (found && !found.ended) return found
      await sleep(this.cfg.reattachPollMs ?? REATTACH_POLL_MS)
    }
    return this.registry.byThreadTs(threadTs)
  }

  async handleSlackMessage(m: InMsg): Promise<void> {
    if (m.threadTs) this.threadLinks.note(m.threadTs, m.ts)
    if (m.channel !== this.cfg.channelId) return
    if (!this.cfg.allowedUsers.has(m.user)) {
      this.logAt('WARN', 'slack', `ignored message from non-allowlisted user ${m.user} (add to SLACK_ALLOWED_USERS to allow)`)
      return
    }
    const text = await this.resolveInboundText(m)
    const isThreadReply = !!m.threadTs && m.threadTs !== m.ts
    this.logAt('INFO', 'slack', isThreadReply ? 'thread reply' : 'channel message', { t: m.threadTs ?? m.ts, ts: m.ts, user: m.user, chars: text.length, head: truncate(text.replace(/\s+/g, ' '), 60) })
    // Outside a thread, `:<command> <session> …` reaches a session by name, so a stuck one can be
    // stopped without opening its thread. Anything else at the top level starts a session.
    if (!isThreadReply && text.startsWith(':')) return this.runTargetedCommand(m, text.slice(1).trim())
    if (!isThreadReply) return this.launchFromSlack(m, text)

    const threadTs = m.threadTs!
    let session = this.registry.byThreadTs(threadTs)
    // An ended session stays in the thread lookup, but during a refresh its
    // replacement is already on the way, so what is coming speaks before it.
    // `refreshing` covers the moment between killing the process and its end
    // arriving, when the session is still listed but has nothing to listen with.
    if (!session || session.ended || session.refreshing) {
      const pending = this.pendingLaunches.get(threadTs)
      if (pending) {
        // Telling someone to type it again is asking them to do our waiting for
        // us. Hold it and hand it over the moment the session is there.
        pending.queued.push({ text, user: m.user, ts: m.ts })
        await this.slack.react(m.ts, 'eyes')
        if (pending.queued.length === 1) await this.slack.post({ threadTs, text: '⏳ 세션이 아직 준비 중입니다. 준비되면 바로 전달하겠습니다.' })
      } else if (this.waking.has(threadTs)) {
        this.waking.get(threadTs)!.push({ text, user: m.user, ts: m.ts })
        await this.slack.react(m.ts, 'eyes')
      } else if (session?.ended) {
        await this.slack.post({ threadTs, text: '⚫ 이 세션은 종료되었습니다. 새 세션은 채널에 새 메시지로 시작하세요.' })
      } else if (this.dormant.has(threadTs) && !text.startsWith('!') && !text.startsWith(':')) await this.wakeDormant(this.dormant.get(threadTs)!, { text, user: m.user, ts: m.ts })
      else if (this.recordedAtStart.some((e) => e.threadTs === threadTs) && Date.now() - this.startedAt < (this.cfg.startupGraceMs ?? STARTUP_GRACE_MS)) {
        // A broker restart under a live session: the revive record says it was alive, but its shim has
        // not reconnected yet (it retries every 500 ms for the first 30s). Wait rather than say "no
        // session" for a thread that is about to have one again.
        await this.slack.react(m.ts, 'eyes')
        const reattached = await this.awaitReattach(threadTs)
        if (reattached) session = reattached
        else if (!text.startsWith('!')) await this.slack.post({ threadTs, text: '이 스레드에 연결된 세션이 없습니다. 새 세션은 채널에 새 메시지로 시작하세요.' })
      } else if (!text.startsWith('!')) await this.slack.post({ threadTs, text: '이 스레드에 연결된 세션이 없습니다. 새 세션은 채널에 새 메시지로 시작하세요.' })
      if (!session || session.ended || session.refreshing) return
    }
    this.noteMsg(m.ts, threadTs)
    this.emitEvent(threadTs, this.userEvent(threadTs, m.ts, text, 'slack'))
    const perm = PERMISSION_REPLY_RE.exec(text)
    if (perm) {
      await this.resolvePermission(session, perm[2]!.toLowerCase(), perm[1]!.toLowerCase().startsWith('y') ? 'allow' : 'deny', m.user)
      return
    }
    // `:` is ours (session control). `/` and `!` are Claude Code's (slash command, bash mode): straight to the terminal.
    if (text.startsWith(':')) return this.runThreadCommand(session, text.slice(1).trim())
    if (session.handedOffTo) {
      await this.slack.post({ threadTs, text: `🧵 이 세션은 더 가벼운 새 스레드로 넘겨졌습니다. 거기서 이어가세요.` })
      return
    }
    if (session.sizeBlocked) {
      await this.slack.post({ threadTs, text: '🚫 대화 기록이 100MB 를 넘어 Slack·웹 입력을 막았어요. `:lightfork` 로 가벼운 새 세션을 띄우거나, 터미널에서 직접 입력하세요.' })
      return
    }
    if (text.startsWith('/') || text.startsWith('!')) return this.runCommand(session, text.trim())
    await this.inject(session, text, m.user, m.ts)
  }

  async handleAction(a: InAction): Promise<void> {
    if (a.channel !== this.cfg.channelId) return
    // Mobile double-taps deliver the same action twice; ignore repeats within 1.5s.
    // The action id is part of the key: two different buttons can carry the same
    // value (allow vs deny on one request), and those are not duplicates.
    const key = `${a.user}|${a.actionId}|${a.value}|${a.messageTs}`
    if (this.recentActions.isRepeat(key)) return
    if (!this.cfg.allowedUsers.has(a.user)) {
      this.logAt('WARN', 'slack', `ignored action from non-allowlisted user ${a.user}`)
      return
    }
    this.logAt('INFO', 'slack', 'button', { action: a.actionId.replace(/_\d+$/, ''), value: a.value, user: a.user, msg: a.messageTs })
    if (isAction(a.actionId, ACTION.ctlNew)) {
      if (a.triggerId) await this.openNewSessionModal(a.triggerId)
      return
    }
    if (isAction(a.actionId, ACTION.ctlResume)) {
      const r = decodeResume(a.value)
      if (!r) return
      // `~` is the home directory abbreviated to fit the option; `…` is a path cut from the left for the same reason,
      // only the project's tail survives, so the full path is looked up by the conversation's own id instead.
      let cwd = r.cwd.startsWith('~') ? expandHome(r.cwd) : r.cwd
      if (r.cwd.startsWith('…')) {
        const found = (await this.resumable(25)).find((x) => x.id === r.sessionId)
        if (!found) {
          await this.slack.postEphemeral(a.user, '이어서 할 수 있는 세션 목록에 없습니다.')
          return
        }
        cwd = found.cwd
      }
      await this.launchSession({ cwd, prompt: '', resumeId: r.sessionId, user: a.user })
      return
    }
    const decoded = decodeValue(a.value)
    if (!decoded) return
    const { pid, command: rest } = decoded
    // Home tab buttons carry no session.
    if (rest.startsWith('homefilter ')) {
      this.homeFilter.set(a.user, rest.endsWith('attention') ? 'attention' : 'all')
      await this.slack.publishHome(a.user, await this.buildHomeView(a.user)).catch((e) => this.logAt('WARN', 'slack', `home tab failed: ${describeError(e)}`))
      return
    }
    const session = this.registry.byPid(pid)
    if (!session) return
    if (isAction(a.actionId, ACTION.permAllow) || isAction(a.actionId, ACTION.permDeny)) {
      await this.resolvePermission(session, rest, isAction(a.actionId, ACTION.permAllow) ? 'allow' : 'deny', a.user, a.messageTs)
      return
    }
    if (isAction(a.actionId, ACTION.permAlways)) return this.permissionAlways(session, rest, a.user, a.messageTs)
    // Enter and Esc mean whatever is on screen right now, so a stale tap must
    // not reach a prompt the dialog has already left. Same rule the numbered
    // buttons follow, for the same reason.
    if (isAction(a.actionId, ACTION.dlgKey)) {
      if (a.messageTs && session.openDialogTs && a.messageTs !== session.openDialogTs) {
        await this.slack.postEphemeral(a.user, '이 창은 이미 끝났습니다 (다른 창으로 넘어갔습니다).', session.threadTs)
        return
      }
      if (session.pane && !parseKeyedDialog(await this.tmux.capture(session.pane))) {
        await this.slack.postEphemeral(a.user, '그 창은 이미 닫혔습니다. `:screen` 으로 지금 화면을 보세요.', session.threadTs)
        return
      }
      session.stallShown = undefined
      return this.runCommand(session, rest, a.user, a.messageTs || undefined)
    }
    if (rest === 'purge') return session.ended ? this.purgeThread(session, a.user) : this.runCommand(session, 'purge', a.user)
    if (rest === 'confirm purge') {
      const { text, blocks } = confirmBlocks(session.pid, 'purge', this.purgeScope)
      await this.slack.postEphemeral(a.user, text, session.threadTs, blocks)
      return
    }
    if (session.ended) return void (await this.slack.postEphemeral(a.user, '⚫ 이 세션은 종료되었습니다.', session.threadTs))
    if (rest === 'settings') {
      if (a.triggerId) await this.slack.openModal(a.triggerId, settingsModal(this.panelState(session)))
      return
    }
    if (rest.startsWith('confirm ')) {
      const { text, blocks } = confirmBlocks(session.pid, rest.slice(8), this.purgeScope)
      await this.slack.postEphemeral(a.user, text, session.threadTs, blocks)
      return
    }
    const answered = decodeAnswer(rest)
    if (answered && a.messageTs) {
      const summary = `☑️ 선택: *${answered.label}* · <@${a.user}>`
      // Several questions can share one message; replace only the one just
      // answered so the others keep their buttons.
      const edited = a.blocks ? markAnswered(a.blocks, questionBlockId(session.pid, answered.questionIndex), summary) : null
      const done = edited ? { text: summary, blocks: edited } : answeredBlocks(summary)
      await this.slack.update(a.messageTs, done.text, done.blocks).catch(() => {})
    }
    if (a.actionId.startsWith('ctl_') || a.actionId.startsWith('dlg_')) await this.runCommand(session, rest, a.user, a.messageTs || undefined)
  }

  /** "Always allow": pick the "don't ask again" option in the local dialog via tmux. */
  private async permissionAlways(session: Session, requestId: string, user: string, msgTs?: string): Promise<void> {
    if (!session.pane) return this.resolvePermission(session, requestId, 'allow', user, msgTs)
    const pressed = await this.dialogs.answerProceed(session.pane, 'always')
    this.logAt('INFO', 'perm', 'always', this.tag(session, { req: requestId, user, pressed }))
    // The dialog is up but the prompt has the keyboard: wait for it to let go and press then, rather than asking the person to come back.
    if (pressed === 'unfocused') {
      await this.slack.postEphemeral(user, RETRY_NOTE, session.threadTs)
      // On success the dialog has been answered exactly once: only the bookkeeping remains.
      // Calling permissionAlways again here pressed a second time, and if the dialog had
      // gone by then, the press could land on the next tool's dialog.
      this.retryWhenFocused(session, `perm:${requestId}`, () => this.dialogs.answerProceed(session.pane!, 'always'), (r) => (r === 'answered' ? this.markAlwaysAnswered(session, requestId, user, msgTs) : this.resolvePermission(session, requestId, 'allow', user, msgTs)), () =>
        this.slack.postEphemeral(user, UNFOCUSED_NOTE, session.threadTs),
      )
      return
    }
    if (pressed !== 'answered') {
      await this.slack.postEphemeral(user, '터미널에 "항상 허용" 항목이 없어 이번만 허용합니다.', session.threadTs)
      return this.resolvePermission(session, requestId, 'allow', user, msgTs)
    }
    await this.markAlwaysAnswered(session, requestId, user, msgTs)
  }

  /** The "always" option was pressed in the terminal: close the card and the bookkeeping. */
  private async markAlwaysAnswered(session: Session, requestId: string, user: string, msgTs?: string): Promise<void> {
    const key = `${session.pid}:${requestId}`
    const pending = this.pendingPermissions.get(key)
    this.clearReminder(key)
    this.pendingPermissions.delete(key)
    const label = `✅ 항상 허용 · \`${requestId}\` · <@${user}>`
    const ts = msgTs ?? pending?.msgTs
    if (ts) await this.slack.update(ts, label, [{ type: 'section', text: { type: 'mrkdwn', text: label } }])
    if (!this.hasOpenPermission(session)) this.clearWaiting(session)
    if (session.turn) await this.setStatus(session, 'processing')
  }

  private hasOpenPermission(session: Session): boolean {
    return [...this.pendingPermissions.values()].some((p) => p.pid === session.pid)
  }

  /**
   * A dialog is on screen but the prompt has the keyboard (a background
   * agent's permission window during the main turn). Instead of telling the
   * person to press again later, watch the screen and press the moment the
   * prompt lets go. One retry per session; a newer request replaces it.
   */
  private retryWhenFocused<R>(session: Session, key: string, attempt: () => Promise<R>, onDone: (r: R) => Promise<unknown>, onGiveUp: () => Promise<unknown>): void {
    // One retry per dialog, not per session: two cards waiting at once must both get their press.
    session.dialogRetries ??= new Map()
    session.dialogRetries.get(key)?.cancel()
    const pollMs = this.cfg.dialogRetryPollMs ?? DIALOG_RETRY_POLL_MS
    const deadline = Date.now() + (this.cfg.dialogRetryMs ?? DIALOG_RETRY_MS)
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      if (cancelled || session.ended || !session.pane) return
      try {
        const screen = await this.tmux.capture(session.pane)
        // The dialog itself is just gone — answered another way (a channel reply, someone at the real
        // terminal) while the prompt held focus. Pressing whatever is on screen now would answer the
        // wrong thing, and the 60s "couldn't press for you" at the end of this would be a false alarm for
        // something that already succeeded. Quietly stop instead.
        if (!parseDialog(screen) && !parseKeyedDialog(screen)) {
          session.dialogRetries?.delete(key)
          this.logAt('INFO', 'dialog', 'dialog gone before the prompt let go; nothing to press (answered another way?)', this.tag(session, { key }))
          return
        }
        if (!promptHoldsFocus(screen)) {
          session.dialogRetries?.delete(key)
          const r = await attempt()
          this.logAt('INFO', 'dialog', 'retried once the prompt let go', this.tag(session, { result: String(r) }))
          await onDone(r)
          return
        }
      } catch (err) {
        this.logAt('WARN', 'dialog', `retry check failed: ${describeError(err)}`, this.tag(session))
      }
      if (Date.now() >= deadline) {
        session.dialogRetries?.delete(key)
        this.logAt('WARN', 'dialog', 'gave up waiting for the prompt to let go', this.tag(session, { key }))
        await onGiveUp()
        return
      }
      timer = setTimeout(() => void tick(), pollMs)
      timer.unref?.()
    }
    session.dialogRetries.set(key, {
      cancel: () => {
        cancelled = true
        if (timer) clearTimeout(timer)
      },
    })
    timer = setTimeout(() => void tick(), pollMs)
    timer.unref?.()
  }

  // ------------------------------------------------------------ /cc command

  async handleCommand(c: InCommand): Promise<void> {
    if (c.channel !== this.cfg.channelId) {
      await this.slack.postEphemeral(c.user, `이 명령은 <#${this.cfg.channelId}> 채널에서만 동작합니다.`).catch(() => {})
      return
    }
    if (!this.cfg.allowedUsers.has(c.user)) {
      this.logAt('WARN', 'slack', `ignored /cc${c.name} from non-allowlisted user ${c.user}`)
      return
    }
    const text = c.text.trim()
    // Slash commands reached the broker with no trace at all until 2026-09-23; a QA run
    // that worked on screen left nothing in the log to compare against.
    this.logAt('INFO', 'slack', `slash /cc${c.name}`, { user: c.user, args: truncate(text, 60) })
    switch (c.name) {
      case 'new': {
        if (!text) return this.openNewSessionModal(c.triggerId)
        const { cwd, prompt } = parseLaunchText(text, this.cfg.defaultCwd)
        await this.launchSession({ cwd, prompt, user: c.user })
        break
      }
      case 'resume': {
        const list = await (this.cfg.listSessions ?? listRecentSessions)(25)
        if (!text) {
          const { text: t, blocks } = resumePicker(await this.resumable(25))
          await this.slack.postEphemeral(c.user, t, undefined, blocks)
          break
        }
        // `/ccresume <id>`: the id (or its prefix, as shown by /cchistory) picks the session directly.
        const hit = list.find((r) => r.id.startsWith(text)) ?? listArchives(200, this.cfg.archiveDir).find((a) => a.sessionId.startsWith(text))
        if (!hit) return void (await this.slack.postEphemeral(c.user, `\`${text}\` 로 시작하는 세션을 찾지 못했습니다. \`/ccresume\` 으로 목록에서 고르거나 \`/cchistory\` 를 확인하세요.`))
        await this.launchSession({ cwd: hit.cwd, prompt: '', resumeId: 'id' in hit ? hit.id : hit.sessionId, user: c.user })
        break
      }
      case 'history': {
        const items = listArchives(20, this.cfg.archiveDir)
        if (!items.length) return void (await this.slack.postEphemeral(c.user, '보관된 세션이 없습니다.'))
        const lines = items.map((a) => `• ${a.archivedAt.slice(0, 16).replace('T', ' ')} · *${a.title}* · \`${shortenHome(a.cwd)}\` · resume \`${a.sessionId.slice(0, 8)}\``)
        await this.slack.postEphemeral(c.user, `*보관된 세션 ${items.length}개* (\`${shortenHome(this.cfg.archiveDir ?? '~/.claude-slack/sessions')}\`)\n${lines.join('\n')}`)
        break
      }
      case 'list': {
        const live = this.sessions.filter((s) => !s.ended)
        if (!live.length) return void (await this.slack.postEphemeral(c.user, '실행 중인 세션이 없습니다.'))
        const lines = await Promise.all(
          live.map(async (s) => {
            const link = await this.slack.permalink(s.threadTs).catch(() => '')
            const name = s.title ? `${basename(s.cwd)} · ${s.title}` : basename(s.cwd)
            return `• ${link ? `<${link}|${name}>` : name} · \`${shortenHome(s.cwd)}\` · ${s.turn ? '작업 중' : '대기'}${s.window ? ` · tmux ${s.window}` : ''}`
          }),
        )
        await this.slack.postEphemeral(c.user, `*실행 중인 세션 ${live.length}개*\n${lines.join('\n')}`)
        break
      }
      case 'refresh': {
        // A slash command carries no thread, so it can't say which session: one live session is
        // unambiguous, several get a picker.
        const live = this.sessions.filter((x) => !x.ended && x.pane)
        if (!live.length) return void (await this.slack.postEphemeral(c.user, '새로고침할 수 있는 세션이 없습니다.'))
        const [only] = live
        if (only && live.length === 1) return this.runCommand(only, 'refresh', c.user)
        await this.slack.postEphemeral(c.user, '새로고침할 세션을 고르세요', undefined, refreshPicker(live))
        break
      }
      default:
        await this.slack.postEphemeral(c.user, SLASH_HELP)
    }
  }

  async handleView(v: InView): Promise<void> {
    if (!this.cfg.allowedUsers.has(v.user)) return
    this.logAt('INFO', 'slack', 'modal submitted', { user: v.user, view: v.callbackId })
    const pick = (b: string, a: string) => v.values[b]?.[a]
    if (v.callbackId === SETTINGS_VIEW_ID) {
      const session = this.sessions.find((x) => x.pid === Number(v.privateMetadata) && !x.ended)
      if (!session || session.ended) return
      const model = pick('model', 'model')?.selected_option?.value
      const effort = pick('effort', 'effort')?.selected_option?.value
      const mode = pick('mode', 'mode')?.selected_option?.value
      if (model && model !== (session.launchModel ?? session.model)) await this.runCommand(session, `model ${model}`, v.user)
      if (effort && effort !== session.effort) await this.runCommand(session, `effort ${effort}`, v.user)
      if (mode && mode !== session.permissionMode) await this.runCommand(session, `mode ${mode}`, v.user)
      return
    }
    if (v.callbackId !== NEW_SESSION_VIEW_ID) return
    const custom = pick('dir_custom', 'dir_custom')?.value?.trim()
    const cwd = custom ? expandHome(custom) : (pick('dir', 'dir')?.selected_option?.value ?? this.cfg.defaultCwd)
    const prompt = pick('prompt', 'prompt')?.value?.trim() ?? ''
    const model = pick('model', 'model')?.selected_option?.value
    const effort = pick('effort', 'effort')?.selected_option?.value
    if (!existsSync(cwd)) return void (await this.slack.postEphemeral(v.user, `폴더가 없습니다: \`${shortenHome(cwd)}\``))
    const extraArgs = [...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : [])]
    await this.launchSession({ cwd, prompt, user: v.user, extraArgs })
  }

  private async openNewSessionModal(triggerId: string): Promise<void> {
    const dirs = (await listDirs(this.cfg.defaultCwd)).map((d) => ({ label: shortenHome(d), value: d }))
    await this.slack.openModal(triggerId, newSessionModal([{ label: shortenHome(this.cfg.defaultCwd), value: this.cfg.defaultCwd }, ...dirs]))
  }

  /**
   * The Home tab is the only place that answers "what do I have going" without
   * scrolling the channel. Rebuilt on open, so it is always current.
   */
  async handleHomeOpened(userId: string): Promise<void> {
    if (!this.cfg.allowedUsers.has(userId)) return
    try {
      await this.slack.publishHome(userId, await this.buildHomeView(userId))
    } catch (err) {
      this.logAt('WARN', 'slack', `home tab failed: ${describeError(err)}`)
    }
  }

  /** The Home tab's contents: the session list is the same for everyone, the filter is per viewer. */
  private async buildHomeView(userId?: string): Promise<unknown> {
    const data = await this.homeData()
    return homeView({ ...data, filter: userId ? this.homeFilter.get(userId) : undefined })
  }

  /** What every viewer's Home tab shares, built once per refresh. */
  private async homeData(): Promise<{ live: Parameters<typeof homeView>[0]['live']; recent: RecentSession[]; archived: number; channelId: string }> {
    const live = await Promise.all(
      this.registry.live
        .filter((s) => !s.ended)
        .map(async (s) => ({
          pid: s.pid,
          cwd: s.cwd,
          title: s.title,
          state: s.state,
          model: s.model,
          link: await this.slack.permalink(s.threadTs).catch(() => undefined),
          waiting: s.waitingReason ? `${WAITING_LABEL[s.waitingReason]}${s.waitingSince ? ` ${duration(Date.now() - s.waitingSince)}` : ''}` : undefined,
        })),
    )
    const recent = await (this.cfg.listSessions ?? listRecentSessions)(10)
    return { live, recent, archived: countArchives(this.cfg.archiveDir), channelId: this.cfg.channelId }
  }

  private homeTimer?: ReturnType<typeof setTimeout>

  /**
   * Push a fresh Home tab to everyone allowed, after the session list changes.
   * Debounced because a launch or an exit arrives as a burst.
   */
  private refreshHome(): void {
    this.changed()
    if (this.homeTimer) return
    this.homeTimer = setTimeout(() => {
      this.homeTimer = undefined
      this.homeData()
        .then((data) => Promise.all([...this.cfg.allowedUsers].map((u) => this.slack.publishHome(u, homeView({ ...data, filter: this.homeFilter.get(u) })).catch(() => {}))))
        .catch((err) => this.logAt('WARN', 'slack', `home tab failed: ${describeError(err)}`))
    }, HOME_REFRESH_MS)
    this.homeTimer.unref?.()
  }

  /** Post (once) the channel-level "new session" entry message. */
  async ensureEntryMessage(): Promise<void> {
    try {
      const existing = await this.slack.findBotMessage(NEW_SESSION_BLOCK_ID)
      if (existing) return
      const { text, blocks } = newSessionEntry()
      await this.slack.post({ text, blocks })
    } catch (err) {
      // This is the first thing the broker asks Slack to do, so a failure here
      // usually means the setup is wrong, not that one message was lost. Say so
      // plainly at startup instead of leaving every later call to fail quietly.
      this.logAt('ERROR', 'slack', `채널에 안내 메시지를 올리지 못했습니다. ${describeError(err)}`)
    }
  }

  /** Slack's native stop button on the agent session → Esc in the terminal. */
  async handleStop(s: InStop): Promise<void> {
    if (s.channel !== this.cfg.channelId) return
    const session = this.registry.byThreadTs(s.threadTs)
    if (!session || session.ended) return
    if (!this.cfg.allowedUsers.has(s.user)) return
    // Slack's stop button sits next to the composer and gets hit by accident,
    // and an interrupted turn costs more than the tap saved. Point at `:esc`
    // instead: stopping should take a deliberate keystroke.
    await this.slack.post({ threadTs: session.threadTs, text: '중단하려면 `:esc` 를 입력하세요. 이 버튼으로는 중단되지 않습니다 (실수로 눌리기 쉬워서요).' })
    // Slack already flipped its own indicator, so restore the status the session
    // is actually in rather than leaving it looking stopped.
    await this.setStatus(session, session.turn ? 'processing' : 'active')
  }

  private async resolvePermission(session: Session, requestId: string, behavior: 'allow' | 'deny', user: string, msgTs?: string, record?: { text: string; blocks: unknown[] }): Promise<void> {
    const key = `${session.pid}:${requestId}`
    const pending = this.pendingPermissions.get(key)
    const waited = pending ? duration(Date.now() - pending.at) : undefined
    this.send(session, { type: 'permission', requestId, behavior })
    // Newer Claude Code also gates the same action with a terminal dialog (the auto-mode
    // classifier, "Do you want to proceed?"). The MCP verdict does not clear it, so drive it too.
    // Only a yes/no proceed dialog is touched, so an unrelated prompt cannot be answered by mistake.
    let terminalNote = ''
    // 전부 허용 (a record card) may take a "for this session" option; a person's 허용 is this once.
    const how = record && behavior === 'allow' ? 'auto' : behavior
    const pressed = session.pane ? await this.dialogs.answerProceed(session.pane, how) : 'no-dialog'
    this.logAt('INFO', 'perm', behavior, this.tag(session, { req: requestId, user, pressed, waited }))
    if (pressed === 'unfocused') {
      terminalNote = ' · ⏳ 터미널 확인 창은 프롬프트가 입력을 마치는 대로 자동으로 누릅니다'
      this.retryWhenFocused(
        session,
        `perm:${requestId}`,
        () => this.dialogs.answerProceed(session.pane!, how),
        async (r) => {
          const ts = msgTs ?? pending?.msgTs
          const label = `${behavior === 'allow' ? '✅ 허용' : '⛔ 거부'} · \`${requestId}\` · <@${user}>${r === 'answered' ? ' · 터미널 확인 창도 눌렀습니다' : r === 'no-dialog' ? '' : ' · ⚠️ 터미널 확인 창을 대신 눌러주지 못했습니다, `:screen` 으로 확인하세요'}`
          if (ts) await this.slack.update(ts, label, [{ type: 'section', text: { type: 'mrkdwn', text: label } }]).catch(() => {})
        },
        () => this.slack.postEphemeral(user, UNFOCUSED_NOTE, session.threadTs),
      )
    } else if (pressed === 'no-option') {
      // The dialog is up but offers nothing matching the verdict: say so instead of
      // reporting success while the terminal stays blocked.
      terminalNote = ' · ⚠️ 터미널 확인 창을 대신 눌러주지 못했습니다, `:screen` 으로 확인하세요'
    }
    const ts = msgTs ?? pending?.msgTs
    this.clearReminder(key)
    this.pendingPermissions.delete(key)
    // The answered line names the tool (72): 'Bash · 허용'.
    const tool = pending?.toolName ? `${pending.toolName} · ` : ''
    const label = `${behavior === 'allow' ? '✅' : '⛔'} ${tool}${behavior === 'allow' ? '허용' : '거부'} · <@${user}>${terminalNote}`
    // An automatic allow keeps what was allowed on the card: that record is the point of the mode.
    if (ts && record) await this.slack.update(ts, record.text, terminalNote ? [...record.blocks, { type: 'context', elements: [{ type: 'mrkdwn', text: terminalNote.replace(/^ · /, '') }] }] : record.blocks)
    else if (ts) await this.slack.update(ts, label, [{ type: 'section', text: { type: 'mrkdwn', text: label } }])
    else await this.slack.post({ threadTs: session.threadTs, text: label })
    if (!this.hasOpenPermission(session)) this.clearWaiting(session)
    if (session.turn) await this.setStatus(session, 'processing')
  }

  /**
   * "전부 허용" mode: Claude Code still asks (its own permission mode is unchanged), and the broker
   * answers yes at once through the same path as the 허용 button. The card stays in the thread,
   * folded to what was allowed, so the mode leaves a record rather than a gap.
   */
  private async autoAllowPermission(session: Session, msg: { requestId: string; toolName: string; description: string; inputPreview: string }, toolInput: unknown): Promise<void> {
    const { blocks } = permissionBlocksV2({ pid: session.pid, hasPane: !!session.pane, toolInput, ...msg })
    const detail = (blocks as Array<{ type: string }>).filter((b) => b.type !== 'actions' && b.type !== 'context').slice(1)
    const head = `⚡ 자동 허용 · *${msg.toolName}* · \`${msg.requestId}\`${msg.description ? ` · ${truncate(msg.description, 200)}` : ''}`
    const record = { text: `⚡ 자동 허용 · ${msg.toolName} · ${msg.requestId}`, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: head } }, ...detail] }
    const msgTs = await this.slack.post({ threadTs: session.threadTs, ...record })
    this.logAt('INFO', 'perm', 'auto-allowed', this.tag(session, { req: msg.requestId, tool: msg.toolName, preview: truncate(msg.inputPreview, 80) }))
    await this.resolvePermission(session, msg.requestId, 'allow', this.defaultRecipient, msgTs, record)
  }

  /**
   * Cycle shift+tab until the terminal's own status line shows `want` (or gives up after MODE_CYCLE_TRIES).
   * Reads the real screen each time rather than trusting a remembered mode — a `:mode` command, autoAllow
   * turning on, and the autoAllow watchdog all need the terminal's actual, current mode, not a guess.
   */
  private async cycleToMode(pane: string, want: string): Promise<{ reached: string | null }> {
    let reached: string | null = null
    for (let i = 0; i < MODE_CYCLE_TRIES; i++) {
      reached = detectPermissionMode(await this.tmux.capture(pane))
      if (!want || reached === want) break
      await this.tmux.sendKeys(pane, ['BTab'])
      const deadline = Date.now() + MODE_SETTLE_MAX_MS
      while (Date.now() < deadline && detectPermissionMode(await this.tmux.capture(pane)) === reached) await sleep(MODE_SETTLE_POLL_MS)
    }
    return { reached }
  }

  /** Turn "전부 허용" on or off; turning it on also answers what is already waiting. */
  async setAutoAllow(session: Session, on: boolean): Promise<void> {
    if (on && session.pane) {
      // 전부 허용 only means anything when the terminal itself hands permission decisions to the broker
      // (manual mode). In any other mode (auto, acceptEdits, plan, bypassPermissions) Claude Code's own
      // classifier decides, the broker never sees the request, and 전부 허용 would sit there doing nothing
      // while looking "on".
      const { reached } = await this.cycleToMode(session.pane, 'default')
      if (reached !== 'default') {
        await this.slack.post({ threadTs: session.threadTs, text: `⚠️ 터미널을 manual 모드로 바꾸지 못해 전부 허용을 켜지 않았습니다 (지금 ${reached ?? '?'} 모드). 화면을 확인하세요.` })
        return
      }
      session.permissionMode = 'default'
    }
    session.autoAllow = on || undefined
    this.logAt('INFO', 'perm', `auto-allow ${on ? 'on' : 'off'}`, this.tag(session))
    await this.slack.post({ threadTs: session.threadTs, text: on ? '⚡ *전부 허용* 켬 · 권한 요청을 브로커가 바로 허용하고, 허용한 내용은 여기에 남깁니다. 끄려면 `:auto off`' : '🔐 *전부 허용* 끔 · 권한 요청을 다시 버튼으로 묻습니다.' })
    this.changed()
    if (session.autoAllowWatch) {
      clearInterval(session.autoAllowWatch)
      session.autoAllowWatch = undefined
    }
    if (!on) return
    for (const p of [...this.pendingPermissions.values()].filter((x) => x.pid === session.pid)) await this.resolvePermission(session, p.requestId, 'allow', this.defaultRecipient, p.msgTs)
    if (session.pane) {
      const timer = setInterval(() => {
        this.checkAutoAllowMode(session).catch((e) => this.logAt('WARN', 'perm', `auto-allow mode check failed: ${describeError(e)}`, this.tag(session)))
      }, this.cfg.autoAllowCheckMs ?? AUTO_ALLOW_CHECK_MS)
      timer.unref?.()
      session.autoAllowWatch = timer
    }
  }

  /**
   * While 전부 허용 is on, the terminal can leave manual mode without the broker ever hearing about it —
   * the classifier just starts deciding instead, with the broker none the wiser. Checked on a timer
   * (independent of any blocked request) so a stray tool call cannot slip through unnoticed.
   */
  private async checkAutoAllowMode(session: Session): Promise<void> {
    if (!session.autoAllow || session.ended || !session.pane) return
    const mode = detectPermissionMode(await this.tmux.capture(session.pane))
    if (mode === 'default') return
    const label = mode ?? '알 수 없는'
    const { reached } = await this.cycleToMode(session.pane, 'default')
    if (reached === 'default') {
      session.permissionMode = 'default'
      this.schedulePanelRefresh(session, PANEL_REFRESH_SETTLE_MS)
      await this.slack.post({ threadTs: session.threadTs, text: `🔁 전부 허용인데 터미널이 ${label} 모드여서 manual 로 되돌렸습니다.` }).catch(() => {})
    } else {
      await this.setAutoAllow(session, false)
      await this.slack.post({ threadTs: session.threadTs, text: `⚠️ 터미널이 ${label} 모드라 전부 허용을 껐습니다.` }).catch(() => {})
    }
  }

  // ------------------------------------------------------------ injection

  /**
   * A thread message meant for the session. While a tool call is running it
   * is held, as Claude Code holds a message typed during a tool call, and
   * handed over when the tool finishes; delivering it at once would cut the
   * running command short (the afternoon of 2026-09-22, three times).
   */
  private async inject(session: Session, text: string, user: string, ts: string): Promise<void> {
    if (!session.conn) {
      await this.slack.post({ threadTs: session.threadTs, text: '⚠️ 세션과의 연결이 없어 메시지를 전달하지 못했습니다. 세션이 아직 뜨는 중이거나 끊긴 상태입니다. 잠시 뒤 다시 보내거나 `:status` 로 확인하세요.' })
      return
    }
    // Read what the transcript already holds before deciding: a tool_use written a moment
    // ago but not yet polled would otherwise look like "nothing running".
    await session.tailer?.drain()
    const running = session.turn?.inFlight ?? []
    // Claude Code queues a message for the whole turn, tool or no tool, and hands it over
    // between tool calls or at the end. A session waiting on a person (permission, question)
    // is the exception: the message is probably the answer, and nothing runs to be cut short.
    // A refresh is waiting for the work to end: hold it for the relaunched session, even between tools.
    // A session being refreshed right now takes the message into the queue for the new one (74).
    if (session.refreshing) return this.hold(session, { text, user, ts }, running)
    if (session.refreshAfter) return this.hold(session, { text, user, ts }, running)
    if (session.turn && session.state !== 'waiting') return this.hold(session, { text, user, ts }, running)
    // A question/plan card is open and keeps the keyboard until Esc: typed straight in, the message lands
    // behind it and does nothing. Close the card first (Esc, not a button answer) and fold it so it does
    // not sit there looking unanswered, then deliver as usual. A permission card (yes/no) is left alone —
    // there Esc means "deny", so clearing it is exactly the wrong thing to do.
    if ((session.waitingReason === 'question' || session.waitingReason === 'plan') && session.pane) {
      await this.closeOpenDialog(session)
    }
    // A numbered terminal dialog that is not a permission progress window (41): the same Esc, then deliver.
    else if (session.waitingReason === 'dialog' && session.pane && (await this.numberedNonProceedOpen(session))) {
      await this.closeOpenDialog(session)
    }
    await this.deliver(session, text, user, ts)
  }

  /** A numbered dialog is on screen and it is not a yes/no permission progress window. */
  private async numberedNonProceedOpen(session: Session): Promise<boolean> {
    if (!session.pane) return false
    const d = parseDialog(await this.tmux.capture(session.pane))
    return !!d && !isProceedDialog(d)
  }

  /** Esc until a question/plan card's terminal dialog is gone (up to 5 tries), then fold the card as "메시지로 답함". */
  private async closeOpenDialog(session: Session): Promise<void> {
    if (!session.pane) return
    for (let i = 0; i < DIALOG_CLOSE_TRIES; i++) {
      const d = parseDialog(await this.tmux.capture(session.pane))
      // Esc on a yes/no permission window means "deny": never press it there, whatever was asked.
      if (!d || isProceedDialog(d)) break
      await this.tmux.sendKeys(session.pane, ['Escape'])
      await sleep(DIALOG_CLOSE_SETTLE_MS)
    }
    if (session.openDialogTs) {
      await this.slack.update(session.openDialogTs, '💬 메시지로 답함', [{ type: 'section', text: { type: 'mrkdwn', text: '💬 메시지로 답함' } }]).catch(() => {})
      session.openDialogTs = undefined
    }
  }

  /** Push a message into the session now, and watch that it actually starts a turn. */
  private async deliver(session: Session, text: string, user: string, ts: string, via: 'channel' | 'keys' = 'channel'): Promise<void> {
    // A message reaching it wakes it (45); the person's own words are dated for the light copy (46).
    if (session.resting) session.resting = undefined
    if (ts !== session.threadTs) session.humanAt = Date.now()
    session.lastInjected = text
    session.triggerTs = ts
    // A synthetic delivery (계속해, :tell, the retraction notice itself) carries the thread's own ts;
    // `:retract` only ever means the last real reply someone typed.
    if (ts !== session.threadTs) session.lastUserMessage = { text, ts }
    await this.beginTurn(session, user)
    if (via === 'keys' && session.pane) {
      // Typed into the terminal, it is the person's own input. A channel notification that arrives while
      // Claude is working is wrapped by Claude Code as "NOT from your user", and the message is not acted on.
      try {
        await this.tmux.pasteLine(session.pane, text)
      } catch (err) {
        this.logAt('WARN', 'inject', `typing into the terminal failed, using the channel: ${describeError(err)}`, this.tag(session))
        this.send(session, { type: 'inbound', text, user, ts })
      }
    } else this.send(session, { type: 'inbound', text, user, ts })
    this.logAt('INFO', 'inject', via === 'keys' ? 'delivered by keys' : 'delivered', this.tag(session, { ts, chars: text.length }))
    // A synthetic message (the 계속해 button, :tell) carries the thread's own ts: nothing to react to.
    if (ts !== session.threadTs) {
      await this.slack.unreact(ts, 'hourglass_flowing_sand').catch(() => {})
      await this.slack.react(ts, 'eyes')
    } else session.triggerTs = undefined
    this.watchInjected(session, text, user, ts)
  }

  private async hold(session: Session, m: HeldMessage, running: string[]): Promise<void> {
    ;(session.held ??= []).push(m)
    await this.slack.react(m.ts, 'hourglass_flowing_sand').catch(() => {})
    this.logAt('INFO', 'inject', running.length ? 'held while a tool runs' : 'held while the turn runs', this.tag(session, { ts: m.ts, n: session.held.length, running: truncate(running.join(', '), 80) }))
    const { text, blocks } = heldNoticeBlocks(session.pid, session.held.length)
    session.holdNoticeTs = (await this.say(session, { ts: session.holdNoticeTs, text, blocks })) ?? session.holdNoticeTs
  }

  /**
   * Hand over what was held, all at once, if nothing is running any more.
   * From a hook, the transcript is read first so a tool that just ended is not
   * still counted; from inside the transcript handler it must not be (the
   * tailer's queue is what is running us, and waiting on it would never end).
   */
  private async releaseHeldIfIdle(session: Session, why: string, opts: { drain?: boolean } = {}): Promise<void> {
    if (!session.held?.length || session.refreshAfter || session.refreshing) return
    if (session.turn) {
      if (opts.drain) await session.tailer?.drain()
      if (session.turn?.inFlight.length) return
    }
    await this.releaseHeld(session, why)
  }

  private async releaseHeld(session: Session, why: string): Promise<void> {
    const held = session.held?.splice(0) ?? []
    if (!held.length) return
    this.logAt('INFO', 'inject', `releasing held messages (${why})`, this.tag(session, { n: held.length }))
    if (session.holdNoticeTs) {
      await this.slack.delete(session.holdNoticeTs).catch(() => {})
      session.holdNoticeTs = undefined
    }
    if (!session.conn) {
      await this.slack.post({ threadTs: session.threadTs, text: `⚠️ 세션과의 연결이 끊겨 붙잡아 둔 메시지 ${held.length}개를 전달하지 못했습니다. 세션이 다시 붙으면 그때 다시 보내 주세요.` })
      return
    }
    // One injection, as the launch prompt does: several in a row would cut each other short.
    const last = held.at(-1)!
    for (const m of held) if (m.ts !== last.ts && m.ts !== session.threadTs) await this.slack.unreact(m.ts, 'hourglass_flowing_sand').then(() => this.slack.react(m.ts, 'eyes')).catch(() => {})
    // Still mid-turn (held only until the running tool finished): type it, so it is not labelled as external.
    const midTurn = !!session.turn && !!session.pane && session.state !== 'waiting' && (this.cfg.midTurnKeys ?? true)
    await this.deliver(session, held.map((m) => m.text).join('\n\n'), last.user, last.ts, midTurn ? 'keys' : 'channel')
    // The bubbles move to where they were actually delivered, below the answers that came meanwhile (79).
    for (const m of held) this.emitEvent(session.threadTs, this.userEvent(session.threadTs, m.ts, m.text, m.user === this.defaultRecipient ? 'web' : 'slack'))
  }

  /** "지금 보내기": interrupt the turn, as Claude Code's Ctrl+Enter does, and deliver the held messages at once. */
  /** A button was pressed for messages that are no longer held: say so, and take the stale card down so it does not invite the next press. */
  private async nothingHeld(c: CommandContext): Promise<void> {
    if (c.messageTs) {
      await this.slack.delete(c.messageTs).catch(() => {})
      if (c.session.holdNoticeTs === c.messageTs) c.session.holdNoticeTs = undefined
    }
    await c.ack('붙잡아 둔 메시지가 없습니다. 이미 전달된 메시지의 안내라서 지웠습니다.')
  }

  private async sendHeldNow(session: Session, user?: string): Promise<void> {
    if (!session.held?.length) return
    this.logAt('INFO', 'inject', 'send now', this.tag(session, { n: session.held.length, user }))
    if (session.pane && session.turn) {
      await this.tmux.sendKeys(session.pane, ['Escape'])
      session.escAt = Date.now()
      await sleep(Math.min(this.cfg.escSettleMs ?? ESC_SETTLE_MS, 500))
    }
    if (session.turn) {
      await session.turn.end().catch(() => {})
      session.turn = undefined
    }
    await this.releaseHeld(session, 'send now')
  }

  private async dropHeld(session: Session, user?: string): Promise<void> {
    const held = session.held?.splice(0) ?? []
    this.logAt('INFO', 'inject', 'held messages dropped', this.tag(session, { n: held.length, user }))
    for (const m of held) await this.slack.unreact(m.ts, 'hourglass_flowing_sand').then(() => this.slack.react(m.ts, 'x')).catch(() => {})
    if (session.holdNoticeTs) {
      await this.slack.delete(session.holdNoticeTs).catch(() => {})
      session.holdNoticeTs = undefined
    }
  }

  /**
   * An injected message shows up as a UserPromptSubmit (wrapped in <channel>)
   * within seconds. If it does not, look at the screen: the text sitting in the
   * input box means it was typed but never sent, and Enter finishes the job.
   * Otherwise send it again, once, and then say so.
   */
  /**
   * `fromAttempts` carries the count across a retry: verifyInjected clears `session.injectCheck` before calling back in,
   * so inferring the count from what is still there (as a plain re-delivery does) would always read as the first attempt.
   */
  private watchInjected(session: Session, text: string, user: string, ts: string, fromAttempts?: number): void {
    if (session.injectCheck?.timer) clearTimeout(session.injectCheck.timer)
    const attempts = fromAttempts ?? (session.injectCheck?.ts === ts ? session.injectCheck.attempts + 1 : 1)
    const check = { text, ts, user, attempts, timer: undefined as ReturnType<typeof setTimeout> | undefined }
    check.timer = setTimeout(() => {
      this.verifyInjected(session, check).catch((e) => this.logAt('WARN', 'inject', `verify failed: ${describeError(e)}`, this.tag(session)))
    }, this.cfg.injectVerifyMs ?? INJECT_VERIFY_MS)
    check.timer.unref?.()
    session.injectCheck = check
  }

  /** A UserPromptSubmit or transcript user line that carries the injected text: the message landed. */
  private confirmInjected(session: Session, seen: string): void {
    const check = session.injectCheck
    if (!check) return
    const head = normalizeMessage(check.text).slice(0, 200)
    if (!normalizeMessage(seen).includes(head)) return
    if (check.timer) clearTimeout(check.timer)
    session.injectCheck = undefined
    this.logAt('DEBUG', 'inject', 'confirmed', this.tag(session, { ts: check.ts }))
  }

  private async verifyInjected(session: Session, check: NonNullable<Session['injectCheck']>): Promise<void> {
    if (session.injectCheck !== check || session.ended) return
    session.injectCheck = undefined
    if (!session.pane) return
    const screen = await this.tmux.capture(session.pane)
    const head = check.text.split('\n')[0]!.slice(0, 30)
    const typedButNotSent = inputBoxHas(screen, head)
    if (typedButNotSent) {
      // Enter did not send it, three times: something else holds the box (a dialog, a paste preview). Say so once and stop pressing.
      if (check.attempts >= INJECT_MAX_ENTERS) {
        this.logAt('WARN', 'inject', 'text still in the input box after pressing Enter; giving up', this.tag(session, { ts: check.ts, attempts: check.attempts }))
        return
      }
      this.logAt('WARN', 'inject', 'text sits in the input box unsent; pressing Enter', this.tag(session, { ts: check.ts }))
      await this.tmux.sendKeys(session.pane, ['Enter'])
      this.watchInjected(session, check.text, check.user, check.ts, check.attempts + 1)
      return
    }
    // Claude Code may simply be holding it until the turn ends; only an idle session is evidence of loss.
    if (session.turn || detectStuckState(screen)?.kind !== 'idle-prompt') return
    if (check.attempts < INJECT_MAX_ATTEMPTS && session.conn) {
      this.logAt('WARN', 'inject', 'no turn started; sending again', this.tag(session, { ts: check.ts, attempt: check.attempts + 1 }))
      this.send(session, { type: 'inbound', text: check.text, user: check.user, ts: check.ts })
      session.injectCheck = { ...check, attempts: check.attempts, timer: undefined }
      this.watchInjected(session, check.text, check.user, check.ts)
      return
    }
    this.logAt('ERROR', 'inject', 'message never started a turn', this.tag(session, { ts: check.ts }))
    await this.slack.post({ threadTs: session.threadTs, text: `⚠️ 방금 메시지가 세션에 전달되지 않은 것 같습니다 (두 번 보냈지만 응답이 시작되지 않음). \`:screen\` 으로 화면을 확인해 주세요.` })
  }

  private async launchFromSlack(m: InMsg, text: string): Promise<void> {
    const { cwd, prompt } = parseLaunchText(text, this.cfg.defaultCwd)
    await this.launchSession({ cwd, prompt, user: m.user, threadTs: m.ts })
  }

  /**
   * Conversations that can be reopened as a new thread: not one that is running, and not one that already has
   * a thread (a leftover the 잔재 tab shows, and reopens in that same thread).
   */
  private async resumable(limit: number): Promise<RecentSession[]> {
    const taken = new Set<string>()
    for (const s of this.registry.live) if (!s.ended && s.sessionId) taken.add(s.sessionId)
    for (const p of this.pendingLaunches.values()) if (p.resumeId) taken.add(p.resumeId)
    for (const o of this.orphanScan?.items ?? []) if (o.sessionId) taken.add(o.sessionId)
    // Ask for more than shown: some of what comes back is dropped.
    const all = await (this.cfg.listSessions ?? listRecentSessions)(limit + taken.size)
    // A conversation whose folder is gone (moved to the Trash) cannot be resumed there.
    const exists = this.cfg.folderExists ?? existsSync
    // "이어서 하기 비우기" hides what is older than when it was cleared; a conversation used again shows again.
    const cleared = this.groupStore.get().recentClearedAt
    // A name a person chose outlives the live session it was chosen in; the ai-title/last-prompt guess
    // listRecentSessions falls back to is only for conversations nobody ever named.
    return all
      .filter((r) => !taken.has(r.id) && exists(r.cwd) && (!cleared || r.mtime > cleared))
      .map((r) => {
        const stored = this.titles.get(r.id)
        return stored ? { ...r, title: stored } : r
      })
      .slice(0, limit)
  }

  /** The session (or a launch still coming up) that already has this conversation open, in a thread other than `exceptThread`. */
  private runningOf(sessionId: string, exceptThread?: string): { threadTs: string } | undefined {
    const live = this.registry.live.find((s) => !s.ended && s.sessionId === sessionId && s.threadTs !== exceptThread)
    if (live) return { threadTs: live.threadTs }
    for (const p of this.pendingLaunches.values()) if (p.resumeId === sessionId && p.threadTs !== exceptThread) return { threadTs: p.threadTs }
    return undefined
  }

  private async alreadyRunningText(threadTs: string): Promise<string> {
    const link = await this.slack.permalink(threadTs).catch(() => '')
    return `이미 실행 중인 대화입니다.${link ? ` <${link}|그 스레드>에서 이어가세요.` : ''} 같은 대화를 두 곳에서 열면 서로 대화 기록을 덮어써서 꼬입니다.`
  }

  /**
   * Start a Claude Code session in tmux bound to a Slack thread. Without a
   * threadTs (slash command, modal, resume) the bot posts a root message first.
   */
  async launchSession(o: { cwd: string; prompt: string; user: string; threadTs?: string; rootTs?: string; resumeId?: string; extraArgs?: string[]; queued?: HeldMessage[]; fork?: { fromThread: string; transcript?: string; fromId?: string }; title?: string }): Promise<string | undefined> {
    const cwd = o.cwd
    // One conversation, one process: two of them resuming the same session id write over each other's transcript.
    // A fork is the exception: it resumes into a new session id, and the original keeps running.
    if (o.resumeId && !o.fork) {
      const busy = this.runningOf(o.resumeId, o.threadTs)
      if (busy) {
        this.logAt('WARN', 'launch', `refused to resume ${o.resumeId.slice(0, 8)}: already running in thread ${busy.threadTs}`)
        await this.slack.postEphemeral(o.user, await this.alreadyRunningText(busy.threadTs)).catch(() => {})
        return
      }
    }
    // A revived session keeps the status line the thread already has.
    let rootTs = o.rootTs
    let threadTs = o.threadTs
    if (!threadTs) {
      rootTs = await this.slack.post({ text: `🟢 *${basename(cwd)}* · \`${shortenHome(cwd)}\` · ${o.fork ? '세션 복제' : o.resumeId ? '세션 재개' : 'Slack에서 시작'}${o.prompt ? `\n> ${truncate(o.prompt, 200)}` : ''}` })
      threadTs = rootTs
    }
    if (o.fork) this.startFork(threadTs, o.fork)
    const sessionKeyForLaunch = randomUUID()
    // A resume's transcript already has everything from its earlier runs; if the shim is slow to say hello,
    // the tailer must not start at "now" and skip whatever Claude Code writes in between. Seeding the offset
    // with the file's size at launch time, before it has even started, makes "now" mean the same thing later.
    if (o.resumeId) {
      const path = (this.cfg.transcriptPathFor ?? transcriptPathFor)(cwd, o.resumeId)
      if (path) {
        try {
          this.offsets.set(sessionKeyForLaunch, path, statSync(path).size)
        } catch {}
      }
    }
    let launched: { window: string; pane: string }
    try {
      launched = await this.tmux.launch({
        cwd,
        env: {
          CLAUDE_SLACK: '1',
          CLAUDE_SLACK_SESSION: sessionKeyForLaunch,
          CLAUDE_SLACK_THREAD_TS: threadTs,
          ...(this.cfg.socketPath ? { CLAUDE_SLACK_SOCKET: this.cfg.socketPath } : {}),
          ...(process.env.CLAUDE_SLACK_NO_CHANNEL ? { CLAUDE_SLACK_NO_CHANNEL: '1' } : {}),
        },
        command: [
          this.cfg.launcher,
          ...(o.resumeId ? ['--resume', o.resumeId] : []),
          ...(o.extraArgs ?? []),
          ...(this.webDefaultPrompt().trim() ? ['--append-system-prompt', this.webDefaultPrompt().trim()] : []),
          ...(this.statusLineSettingsPath ? ['--settings', this.statusLineSettingsPath] : []),
        ],
        name: `cs-${sessionKeyForLaunch}`,
      })
    } catch (err) {
      await this.slack.post({ threadTs, text: `❌ 세션을 띄우지 못했습니다. ${describeError(err)}` })
      return threadTs
    }
    const starting = controlPanel({ pid: 0, cwd, origin: 'slack', hasPane: true, window: launched.window, state: 'starting' })
    const statusTs = await this.slack.post({ threadTs, text: starting.text, blocks: starting.blocks })
    const argAfter = (flag: string) => {
      const i = (o.extraArgs ?? []).indexOf(flag)
      return i >= 0 ? o.extraArgs![i + 1] : undefined
    }
    this.pendingLaunches.set(threadTs, { threadTs, title: o.title, resumeId: o.resumeId, rootTs, statusTs, cwd, prompt: o.prompt, queued: [...(o.queued ?? [])], ...launched, ...(argAfter('--model') ? { model: argAfter('--model') } : {}), ...(argAfter('--effort') ? { effort: argAfter('--effort') } : {}) })
    // The startup dialogs are over once the session's shim says hello; polling past that is wasted captures.
    this.confirmDialogs(launched.pane, () => !this.pendingLaunches.has(threadTs!))
      .then((dialogs) => dialogs.length && this.logAt('INFO', 'dialog', `auto-confirmed startup dialogs: ${dialogs.join(', ')}`, { t: threadTs, window: launched.window }))
      .catch((e) => this.logAt('WARN', 'dialog', `auto-confirm failed: ${describeError(e)}`, { t: threadTs }))
    this.scheduleLaunchTimeout(threadTs, statusTs)
    return threadTs
  }

  /**
   * The new thread of a fork: the original conversation copied over at its original times (without
   * answered cards or turn marks), a line saying where the copy ends, and the original's transcript lines
   * remembered so the fork's copy of them is not replayed as new.
   */
  /**
   * The light copy (46): SESSION.md is asked for (unless the one already written is newer than the person's last
   * word), read once the turn that writes it has ended, and a new session takes it as its start. `shrink` asks
   * for a shorter file first; `cut` keeps only the first 20,000 bytes. Over 20,000 bytes and no choice given, a
   * card asks which.
   */
  private async lightforkRun(c: CommandContext, s: Session, mode: string, user: string): Promise<void> {
    const path = join(s.cwd, 'SESSION.md')
    const fresh = existsSync(path) && (s.summaryAt ?? 0) > (s.humanAt ?? 0)
    if (mode === 'shrink' || (!fresh && mode !== 'cut')) {
      await c.post(mode === 'shrink' ? '📝 SESSION.md 를 줄여 달라고 요청했어요…' : '📝 지금까지 대화를 `SESSION.md` 에 정리해 달라고 요청했어요…')
      await this.inject(s, mode === 'shrink'
        ? 'SESSION.md 를 20KB 안으로 줄여 다시 써 주세요. 다음 세션이 바로 이어받을 핵심만 남기세요.'
        : '지금까지의 대화를 이어받을 다음 세션이 읽을 SESSION.md 파일을 이 폴더에 써 주세요. 무엇을 하고 있었는지, 왜, 지금 어디까지 됐는지, 다음에 할 일을 정리해 주세요.', user, s.threadTs)
      if (!(await this.awaitTurnEnd(s, LIGHTFORK_TIMEOUT_MS))) return void (await c.post('❌ 가벼운 복제로 새 세션을 열지 못했어요. SESSION.md 를 3분 넘게 쓰지 못했어요. 직접 작성을 요청하거나 다시 시도하세요.'))
      s.summaryAt = Date.now()
    }
    if (!existsSync(path)) return void (await c.post('❌ 가벼운 복제로 새 세션을 열지 못했어요. SESSION.md 가 없어요'))
    let content = readFileSync(path, 'utf8')
    const bytes = Buffer.byteLength(content)
    if (mode !== 'cut' && bytes > LIGHTFORK_FILE_MAX) {
      // A choice, not a silent cut (46): shorten it, or keep the first 20 KB.
      await this.slack.post({
        threadTs: s.threadTs,
        text: `SESSION.md 가 ${Math.round(bytes / 1000)} KB 예요 · 줄여서 넘길까요?`,
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: `SESSION.md 가 ${Math.round(bytes / 1000)} KB 예요 · 줄여서 넘길까요?` } },
          { type: 'actions', elements: [btn('줄이기', ACTION.ctlBtn, encodeValue(s.pid, 'lightfork shrink'), 'primary'), btn('앞부분만', ACTION.ctlBtn, encodeValue(s.pid, 'lightfork cut'))] },
        ],
      }).catch(() => {})
      return
    }
    if (mode === 'cut') content = cutUtf8(content, LIGHTFORK_FILE_MAX)
    const pointer = `[이전 대화에서 이어감 — 원래 스레드: ${s.threadTs}, 필요하면 read_session 도구로 전체 맥락을 더 읽을 수 있습니다]\n\n${truncate(content, LIGHTFORK_MAX_CHARS)}`
    // The copy keeps the name without the rest suffix, and the original is named "<name> (휴면)" (46).
    const baseName = (s.manualTitle ?? s.title ?? basename(s.cwd)).replace(/ \((휴면|이어서)\)$/, '')
    const newThreadTs = await this.launchSession({ cwd: s.cwd, prompt: pointer, user, extraArgs: this.settingsArgs(s), title: baseName })
    if (!newThreadTs) return void (await c.post('❌ 가벼운 복제로 새 세션을 열지 못했어요. 세션을 띄우지 못했어요'))
    s.handedOffTo = newThreadTs
    this.copyGroup(s.threadTs, newThreadTs)
    // The original rests (45); a locked one (100 MB) is ended, since it cannot take input any more.
    s.resting = true
    s.manualTitle = `${baseName} (휴면)`
    if (s.sizeBlocked && s.pane) await this.tmux.typeLine(s.pane, '/exit')
    this.lastWebThread = newThreadTs
    this.changed()
    await c.post(`🧵 새 스레드로 넘겼어요: 거기서 이어가세요. 이 세션은 계속 떠 있지만(터미널에서는 그대로 쓸 수 있어요) Slack·웹 입력은 새 스레드로 보내세요.`)
  }

  /** Wait for the turn that was just started to end (46). Gives up after `timeoutMs`. */
  private async awaitTurnEnd(s: Session, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    let seen = false
    while (Date.now() < deadline) {
      if (s.turn) seen = true
      // A turn that never shows up (the answer came back at once) is not waited for beyond 3 s.
      else if (seen || Date.now() - (deadline - timeoutMs) > 3_000) return true
      await sleep(LIGHTFORK_POLL_MS)
    }
    return false
  }

  /** A new session goes into the group its original is in (46). */
  private copyGroup(from: string, to: string): void {
    const group = this.groupStore.get().groups.find((g) => g.items.includes(from))
    if (group) this.groupStore.apply({ op: 'move', thread: to, group: group.id })
  }

  private startFork(threadTs: string, fork: { fromThread: string; transcript?: string; fromId?: string }): void {
    if (fork.transcript) this.forkSkips.set(threadTs, transcriptUuids(fork.transcript))
    let after = 0
    for (;;) {
      const page = this.events.since(fork.fromThread, after)
      if (!page.length) break
      for (const ev of page) {
        after = ev.seq
        // Pictures ride on text and tool_end; command output is a plain msg; cards (with buttons) are not copied.
        if (ev.type === 'msg' && ev.blocks?.length) continue
        if (ev.type !== 'user' && ev.type !== 'text' && ev.type !== 'tool' && ev.type !== 'tool_end' && ev.type !== 'msg' && ev.type !== 'todos') continue
        const { seq: _s, at, ...body } = ev
        this.events.emit(threadTs, body as EventBody, at)
      }
    }
    const from = fork.fromId ? ` (${fork.fromId} 에서)` : ''
    this.emitEvent(threadTs, { type: 'notice', text: `여기까지 복제한 대화예요${from}. 이 아래부터 새 세션이에요`, icon: 'undo' })
  }

  private scheduleLaunchTimeout(threadTs: string, statusTs: string): void {
    const timer = setTimeout(() => {
      this.onLaunchTimeout(threadTs, statusTs).catch((e) => this.logAt('WARN', 'launch', `timeout check failed: ${describeError(e)}`, { t: threadTs }))
    }, this.cfg.launchTimeoutMs ?? LAUNCH_TIMEOUT_MS)
    timer.unref?.()
  }

  /**
   * The launch timeout fired: a process that is actually still coming up (a loaded host, a slow Claude Code
   * startup) gets more time rather than a second launch piling onto the same thread once it does say hello —
   * only a pane that is genuinely gone is given up on.
   */
  private async onLaunchTimeout(threadTs: string, statusTs: string): Promise<void> {
    const pending = this.pendingLaunches.get(threadTs)
    if (!pending) return
    if (await this.tmux.hasPane(pending.pane)) {
      if (!pending.warnedLate) {
        pending.warnedLate = true
        await this.slack.post({ threadTs, text: '⏳ 세션이 아직 뜨는 중입니다 (예상보다 오래 걸리고 있습니다). 터미널 창은 열려 있으니 조금만 더 기다려 주세요.' }).catch(() => {})
      }
      this.scheduleLaunchTimeout(threadTs, statusTs)
      return
    }
    this.pendingLaunches.delete(threadTs)
    if (pending.resumeId) this.refreshFailed.set(threadTs, Date.now())
    this.changed()
    await this.slack.update(statusTs, '⚠️ 세션이 연결되지 않았습니다', [{ type: 'section', text: { type: 'mrkdwn', text: '⚠️ *세션이 연결되지 않았습니다.* tmux 창을 직접 확인해 보세요: `tmux attach -t claude-slack`' } }]).catch(() => {})
    // Whatever was waiting has nowhere to go now, and silently dropping it is
    // how someone ends up wondering why their message was never answered.
    if (pending.queued.length) {
      await this.slack
        .post({ threadTs, text: `⚠️ 전달하지 못한 메시지 ${pending.queued.length}개가 있습니다. 세션이 뜨면 다시 보내주세요.` })
        .catch(() => {})
    }
  }

  /**
   * `:esc payments` / `:screen 8a01` typed in the channel rather than a thread.
   * The second word names the session (pid, id prefix, folder name, or thread
   * link); the reply goes to that session's thread, with a pointer left here.
   */
  private async runTargetedCommand(m: InMsg, cmd: string): Promise<void> {
    const [name, target, ...rest] = cmd.split(/\s+/)
    const live = this.registry.live.filter((s) => !s.ended)
    if (!name || !this.userCommands.has(name)) {
      await this.slack.postEphemeral(m.user, `채널에서는 \`:<명령> <세션> …\` 로 실행 중인 세션을 지정합니다. 예: \`:esc ${basename(live[0]?.cwd ?? 'proj')}\`, \`:screen 8a01\`. 명령 목록은 \`/cchelp\`.`, undefined).catch(() => {})
      return
    }
    // With one session running, the second word is more likely the command's argument than a name.
    const named = !!target && (!!this.findSession(target) || live.some((s) => basename(s.cwd) === target || s.title === target))
    if (!named && live.length === 1 && target) return this.runTargetedCommand(m, [name, live[0]!.sessionId.slice(0, 8), target, ...rest].join(' '))
    const byName = target ? live.filter((s) => basename(s.cwd) === target || s.title === target) : []
    if (byName.length > 1) {
      const options = byName.map((s) => `\`${s.sessionId.slice(0, 8)}\`${s.title ? ` (${s.title})` : ''}`).join(', ')
      await this.slack.postEphemeral(m.user, `\`${target}\` 이름의 세션이 ${byName.length}개입니다. 세션 id 로 지정하세요: ${options}`).catch(() => {})
      return
    }
    const session = target ? (this.findSession(target) ?? byName[0]) : live.length === 1 ? live[0] : undefined
    if (!session || session.ended) {
      const names = live.map((s) => `\`${basename(s.cwd)}\` (${s.sessionId.slice(0, 8)})`).join(', ')
      await this.slack.postEphemeral(m.user, target ? `\`${target}\` 에 해당하는 실행 중 세션이 없습니다. 실행 중: ${names || '없음'}` : `세션이 ${live.length}개라 어느 것인지 적어 주세요: ${names}`).catch(() => {})
      return
    }
    this.logAt('INFO', 'slack', 'targeted command', this.tag(session, { cmd: name, user: m.user }))
    await this.runThreadCommand(session, [name, ...rest].join(' '))
    const link = await this.slack.permalink(session.threadTs).catch(() => '')
    await this.slack.postEphemeral(m.user, `→ ${link ? `<${link}|${basename(session.cwd)}>` : basename(session.cwd)} 세션에 \`:${name}\` 을 보냈습니다. 결과는 그 스레드에 있습니다.`).catch(() => {})
  }

  /** A `:command` typed by the user: only session-control commands, never the internal ones. */
  private async runThreadCommand(session: Session, cmd: string): Promise<void> {
    const name = cmd.split(/\s+/)[0] ?? ''
    if (name.startsWith('/') || name.startsWith('!') || name === '' || this.userCommands.has(name)) return this.runCommand(session, cmd)
    const replacement = REPLACED_COMMANDS[name]
    const hint = replacement ? `\`:${name}\` 은 없어졌습니다. 대신 ${replacement.startsWith('/') ? `\`${replacement}\` 를 그대로 보내세요` : `${replacement}을 쓰세요`}.` : `알 수 없는 명령 \`:${name}\``
    await this.slack.post({ threadTs: session.threadTs, text: `${hint}\n${HELP}` })
  }

  /**
   * One command's worth of context. Handlers get a pane that is known to exist,
   * so none of them has to re-check it.
   */
  private ctx(session: Session, cmd: string, user?: string, messageTs?: string): CommandContext {
    const threadTs = session.threadTs
    const post = (text: string) => this.slack.post({ threadTs, text })
    const [, ...args] = cmd.split(/\s+/)
    return {
      session,
      pane: session.pane!,
      cmd,
      args,
      arg: args.join(' '),
      post,
      /** A button press answers the presser only; a typed command answers the thread. */
      ack: (text: string) => (user ? this.slack.postEphemeral(user, text, threadTs).catch(() => {}) : post(text)),
      fromButton: !!user,
      messageTs,
      user,
    }
  }

  /**
   * Every command in one table, each saying whether a user may type it. The
   * `:` commands used to be listed separately from the switch that implemented
   * them, which is the same shape as the action_id bug: two lists to keep in
   * step. Now the list is derived from the table.
   */
  private readonly commands: Record<string, CommandSpec> = {
    help: { user: true, run: async (c) => void (await c.post(HELP)) },

    screen: {
      user: true,
      run: async (c) => {
        // `:screen raw` for the untouched screen, including the box drawing.
        const raw = /^(raw|full|전체)$/i.test(c.arg)
        // A picture keeps the layout and the colours; text is the fallback when it cannot be drawn.
        if (await this.postScreenImage(c.session, raw ? '터미널 전체 화면' : '터미널 화면')) return
        await c.post(this.screenBlock(await this.tmux.capture(c.pane), { raw }))
      },
    },

    esc: { user: true, run: (c) => this.interrupt(c) },
    stop: { user: true, run: (c) => this.interrupt(c) },

    // Held messages: deliver now (cutting the running tool short) or forget them.
    now: { user: true, run: async (c) => void (c.session.held?.length ? await this.sendHeldNow(c.session) : await this.nothingHeld(c)) },
    sendnow: { run: async (c) => void (c.session.held?.length ? await this.sendHeldNow(c.session) : await this.nothingHeld(c)) },
    dropheld: { run: async (c) => void (c.session.held?.length ? await this.dropHeld(c.session) : await this.nothingHeld(c)) },

    /** A button from a ```choices block (22): sends that line as if the person had typed it. */
    choice: {
      run: async (c) => {
        const text = c.session.lastChoices?.[Number(c.arg)]
        if (text === undefined) {
          if (c.messageTs) await c.ack('이미 지난 선택지입니다.')
          else await c.post('이미 지난 선택지입니다.')
          return
        }
        c.session.lastChoices = undefined
        await this.deliver(c.session, text, this.defaultRecipient, c.session.threadTs)
        if (c.messageTs) {
          const label = `☑️ ${text} · <@${c.user ?? this.defaultRecipient}>`
          await this.slack.update(c.messageTs, label, [{ type: 'section', text: { type: 'mrkdwn', text: label } }]).catch(() => {})
        } else await c.ack(`☑️ ${text}`)
      },
    },

    /** The "▶️ 계속해" button on a stuck notice. */
    continue: {
      run: async (c) => {
        c.session.stuckShown = undefined
        const ts = (Date.now() / 1000).toFixed(6)
        this.emitEvent(c.session.threadTs, this.userEvent(c.session.threadTs, ts, '계속해', 'web'))
        await this.deliver(c.session, '계속해', this.defaultRecipient, c.session.threadTs)
        // The card's job is done: fold it to its result, like an answered permission card.
        if (c.messageTs) {
          const label = `▶️ 계속해 · <@${c.user ?? this.defaultRecipient}>`
          await this.slack.update(c.messageTs, label, [{ type: 'section', text: { type: 'mrkdwn', text: label } }]).catch(() => {})
        } else await c.ack('▶️ 계속하라고 보냈습니다')
      },
    },

    notify: {
      user: true,
      run: async (c) => {
        const want = c.arg.trim() as NotifyMode
        if (!['on', 'off', 'decisions'].includes(want)) return void (await c.post(`현재 알림: \`${c.session.notify ?? 'decisions'}\`. 사용법: \`:notify decisions\` (결정이 필요할 때만 멘션, 기본) · \`:notify on\` (답변이 끝날 때도) · \`:notify off\``))
        c.session.notify = want
        this.logAt('INFO', 'slack', 'notify mode', this.tag(c.session, { mode: want }))
        await c.post(`🔔 알림: \`${want}\``)
      },
    },

    view: {
      user: true,
      run: async (c) => {
        const want = c.arg.trim() as ViewMode
        if (!['summary', 'normal', 'verbose'].includes(want)) return void (await c.post(`현재 보기: \`${c.session.view ?? 'normal'}\`. 사용법: \`:view summary\` (답변과 결정만) · \`:view normal\` (도구 카드 포함) · \`:view verbose\` (도구 출력을 더 길게)`))
        c.session.view = want
        await c.post(`👁 보기: \`${want}\``)
      },
    },

    auto: {
      user: true,
      noPane: true,
      run: async (c) => {
        const want = c.arg.trim().toLowerCase()
        if (!['on', 'off', '켬', '끔'].includes(want)) return void (await c.post(`현재 전부 허용: \`${c.session.autoAllow ? 'on' : 'off'}\`. 사용법: \`:auto on\` (권한 요청을 브로커가 바로 허용) · \`:auto off\``))
        await this.setAutoAllow(c.session, want === 'on' || want === '켬')
      },
    },

    rename: {
      user: true,
      run: async (c) => {
        const title = c.arg.trim()
        if (!title) return void (await c.post('사용법: `:rename 새 이름`'))
        await this.applyTitle(c.session, title)
        await c.post(`✏️ 이름: *${title}*`)
      },
    },

    /**
     * A side question, answered from the conversation so far without becoming
     * part of it. Claude Code's /btw prints its answer on screen only, so the
     * answer is read back from the terminal once it stops changing.
     */
    btw: {
      user: true,
      run: async (c) => this.runBtw(c.session, c.arg.trim()),
    },

    /** What the last statusLine render reported — cost, model, how close to the 200k-token mark (P4-31). */
    context: {
      user: true,
      run: async (c) => {
        const s = this.status.get(c.session.key)
        if (!s) return void (await c.post('아직 상태 줄을 읽지 못했습니다. 메시지를 한 번 보낸 뒤 다시 시도하세요.'))
        const age = Math.round((Date.now() - s.at) / 1000)
        const cost = typeof s.costUsd === 'number' ? `$${s.costUsd.toFixed(2)}` : '알 수 없음'
        const lines = [`모델: ${s.model ?? '알 수 없음'}`, `누적 비용: ${cost}`, `200k 토큰 이상: ${s.exceeds200k ? '예' : '아니오'}`, `${age}초 전 상태`]
        await c.post(lines.join('\n'))
      },
    },

    /**
     * A conversation grown too big (50MB+ transcript, P4-32): ask it to write SESSION.md, then hand off
     * to a fresh thread seeded with that file plus a `read_session` pointer back to this one. The old
     * session keeps running (someone might still be reading its thread) but is marked handed-off so
     * `:lightfork` and `:tell` don't pile onto it, and new Slack/web input there is redirected.
     */
    lightfork: {
      user: true,
      run: async (c) => {
        const s = c.session
        const user = c.user ?? this.defaultRecipient
        if (s.lightforking) return void (await c.post('이미 SESSION.md 를 쓰는 중이에요. 잠시 기다려 주세요.'))
        if (s.handedOffTo) return void (await c.post('이미 다른 스레드로 넘겼어요. 그 스레드에서 이어가세요.'))
        s.lightforking = true
        try {
          await this.lightforkRun(c, s, c.arg.trim(), user)
        } finally {
          s.lightforking = false
        }
      },
    },

    /** Say something to another session, quoted as coming from this one. */
    tell: {
      user: true,
      run: async (c) => {
        const [target, ...rest] = c.args
        const message = rest.join(' ').trim()
        if (!target || !message) return void (await c.post('사용법: `:tell <세션 id 앞 8자|pid|스레드 링크> 메시지`'))
        const other = this.findSession(target)
        if (!other || other.ended) return void (await c.post(`\`${target}\` 에 해당하는 실행 중 세션이 없습니다. \`/cclist\` 로 확인하세요.`))
        if (other === c.session) return void (await c.post('이 세션 자신에게는 그냥 메시지를 쓰세요.'))
        const from = c.session.title ? `${basename(c.session.cwd)} · ${c.session.title}` : basename(c.session.cwd)
        await this.inject(other, `[다른 세션 "${from}" 에서 전달된 메시지]\n${message}`, this.defaultRecipient, other.threadTs)
        const link = await this.slack.permalink(other.threadTs).catch(() => '')
        await c.post(`📨 ${link ? `<${link}|${basename(other.cwd)}>` : basename(other.cwd)} 세션에 전달했습니다.`)
        await this.slack.post({ threadTs: other.threadTs, text: `📨 *${from}* 세션에서: ${truncate(message, 500)}` })
      },
    },

    status: {
      user: true,
      run: async (c) => {
        const screen = await this.tmux.capture(c.pane)
        const { session } = c
        const mode = detectPermissionMode(screen) ?? session.permissionMode
        if (mode) session.permissionMode = mode
        session.effort ??= detectEffort(screen) ?? undefined
        // The status line usually carries it. Asking `/context` means typing into
        // the session, so only do that when it is idle and we have nothing cached.
        const context = detectContextUsage(screen) ?? (session.turn ? null : await this.readContextUsage(c.pane)) ?? (session.contextLabel ? { percent: Number.parseInt(session.contextLabel, 10) || 0, label: session.contextLabel } : null)
        if (context) session.contextLabel = context.label
        const parts = [
          session.turn ? '⏳ 작업 중' : session.state === 'waiting' ? '⏸ 응답 대기' : '🟢 대기',
          `모델 ${session.model ?? '기본값'}`,
          `effort ${session.effort ?? '기본값'}`,
          `권한 ${mode ?? '?'}`,
          context ? `컨텍스트 ${context.label}${context.percent >= 80 ? ' ⚠️' : ''}` : '',
          `\`${shortenHome(session.cwd)}\``,
          session.window ? `tmux ${session.window}` : '',
        ].filter(Boolean)
        await c.post(parts.join(' · '))
        this.refreshRoot(session).catch(() => {})
      },
    },

    answer: {
      user: true,
      run: async (c) => {
        // `answer <questionIndex> <optionNumber> [label]` — decoded by the shared contract.
        const n = decodeAnswer(c.cmd)?.optionNumber
        if (!n) return
        // A button from a question/plan card that is no longer the open one (answered, replaced by a later
        // question set) must not touch the terminal at all: the screen may by now hold an unrelated dialog
        // that happens to offer the same number, and pressing it would answer the wrong thing.
        if (c.fromButton && c.messageTs && c.session.openDialogTs && c.messageTs !== c.session.openDialogTs) {
          await c.ack('이 선택은 이미 끝났습니다 (다른 카드로 넘어갔습니다).')
          return
        }
        // A stale button — an older card whose dialog is already answered or gone —
        // must not type the digit into the prompt, where it would be sent as a message.
        const answered = await this.dialogs.answerNumber(c.pane, n)
        this.logAt('INFO', 'dialog', 'answer', this.tag(c.session, { n, result: answered, fromButton: c.fromButton }))
        if (answered === 'gone') {
          await c.ack(`이 선택은 이미 끝났습니다 (터미널에 ${n}번 항목이 없습니다). 지금 화면은 \`:screen\` 으로 볼 수 있습니다.`)
          return
        }
        if (answered === 'unfocused') {
          await c.ack(RETRY_NOTE)
          this.retryWhenFocused(
            c.session,
            `answer:${n}`,
            () => this.dialogs.answerNumber(c.pane, n),
            async (r) => {
              if (r === 'answered') {
                await c.post(`☑️ ${n}번 선택 (프롬프트가 끝난 뒤 자동으로 눌렀습니다)`)
                if (c.session.openQuestionsRemaining !== undefined) {
                  c.session.openQuestionsRemaining = Math.max(0, c.session.openQuestionsRemaining - 1)
                  if (c.session.openQuestionsRemaining === 0) await this.dialogs.answerMatching(c.pane, /submit answers?/i)
                }
                this.clearWaiting(c.session)
                await this.setStatus(c.session, 'processing')
              } else await c.post(`⚠️ ${n}번을 누르려 했지만 그 창이 이미 사라졌습니다. \`:screen\` 으로 확인하세요.`)
            },
            () => c.ack(UNFOCUSED_NOTE),
          )
          return
        }
        if (!c.fromButton) await c.post(`☑️ ${n}번 선택`)
        // A multi-question card: once every question has a ✓, Claude Code still needs its own "Submit
        // answers" line pressed — the questions answering does not submit them on its own. Until then the
        // card (and session.openQuestionsRemaining, which clearWaiting would otherwise reset) must survive
        // past this one answer, since more are still coming to the same card.
        let moreQuestions = false
        if (c.session.openQuestionsRemaining !== undefined) {
          c.session.openQuestionsRemaining = Math.max(0, c.session.openQuestionsRemaining - 1)
          if (c.session.openQuestionsRemaining === 0) {
            c.session.openQuestionsRemaining = undefined
            const submitted = await this.dialogs.answerMatching(c.pane, /submit answers?/i)
            this.logAt('INFO', 'dialog', submitted ? 'submitted answers' : 'no submit option found', this.tag(c.session))
          } else {
            moreQuestions = true
          }
        }
        c.session.stallShown = undefined
        if (!moreQuestions) {
          this.clearWaiting(c.session)
          await this.setStatus(c.session, 'processing')
        }
        this.noteActivity(c.session)
      },
    },

    retract: {
      user: true,
      run: async (c) => {
        const last = c.session.lastUserMessage
        if (!last) return void (await c.post('철회할 메시지가 없습니다(아직 아무것도 보내지 않았거나, 이미 철회했습니다).'))
        c.session.lastUserMessage = undefined
        await this.slack.react(last.ts, 'x').catch(() => {})
        // Only when a turn is actually running: 턴이 쉬는 중이면 Esc 는 끊을 것이 없어 "이미 유휴" 로만 읽힌다.
        if (c.session.turn) {
          await this.tmux.sendKeys(c.pane, ['Escape']).catch(() => {})
          await sleep(this.cfg.escSettleMs ?? ESC_SETTLE_MS)
          const turn = c.session.turn
          if (turn) {
            await turn.end().catch(() => {})
            c.session.turn = undefined
          }
        }
        const quoted = truncate(last.text.replace(/\s+/g, ' ').trim(), 80)
        await this.inject(c.session, `[정정] 방금 보낸 "${quoted}" 는 잘못 보낸 메시지예요. 그 지시는 따르지 마세요. 이미 파일을 바꾸거나 명령을 실행했다면 무엇을 했는지만 짧게 알려 주세요.`, c.user ?? this.defaultRecipient, c.session.threadTs)
        await c.post('✖ 철회했습니다.')
      },
    },

    key: {
      user: true,
      run: async (c) => {
        if (!c.args.length) return void (await c.post('사용법: `:key Down Enter` (tmux send-keys 토큰)'))
        await this.tmux.sendKeys(c.pane, c.args)
      },
    },

    /** A keyed (no-number) dialog's own buttons: move the cursor to a choice (arg = the move count, +/-) and
     *  confirm, or `esc` to just send Escape. Internal only — panel.ts is the only thing that encodes this. */
    dlgkey: {
      run: async (c) => {
        // Look at the screen before pressing anything (41): if the window is gone, send nothing and say so.
        const keyed = parseKeyedDialog(await this.tmux.capture(c.pane))
        // `q=<tag>` names the question the button was made for (41): a different question now is not pressed into.
        const tagged = /^q=([0-9a-f]+)\s+(.*)$/.exec(c.arg.trim())
        const arg = (tagged ? tagged[2] : c.arg).trim()
        if (tagged && keyed && questionTag(keyed.question) !== tagged[1]) {
          if (c.messageTs && c.messageTs === c.session.openDialogTs) c.session.openDialogTs = undefined
          return void (await c.ack('이미 다른 질문으로 바뀌었어요. 지금 화면을 확인해 주세요'))
        }
        const label = arg.startsWith('to ') ? arg.slice(3) : undefined
        // Whitespace runs are the same as one space here: the command's words are joined that way on the way in.
        const squash = (x: string) => x.replace(/\s+/g, ' ').trim()
        const at = label === undefined ? -1 : keyed?.options.findIndex((o) => squash(o) === squash(label)) ?? -1
        // 'enter' is the confirm of a dialog with no choices (72): it presses Enter once the dialog is still there.
        if (!keyed || (arg !== 'esc' && arg !== 'enter' && at < 0)) {
          if (c.messageTs && c.messageTs === c.session.openDialogTs) {
            await this.slack.update(c.messageTs, '⌨️ 이미 닫힌 창', [{ type: 'section', text: { type: 'mrkdwn', text: '⌨️ 이미 닫힌 창' } }]).catch(() => {})
            c.session.openDialogTs = undefined
          }
          this.clearWaiting(c.session)
          return void (await c.ack('이미 닫힌 창이에요'))
        }
        // The cursor moves to the line with exactly this label, from wherever the cursor is now.
        await this.tmux.sendKeys(c.pane, arg === 'esc' ? ['Escape'] : arg === 'enter' ? ['Enter'] : cursorKeys(at - keyed.selected))
        if (c.messageTs && c.messageTs === c.session.openDialogTs) {
          await this.slack.update(c.messageTs, '⌨️ 답함', [{ type: 'section', text: { type: 'mrkdwn', text: '⌨️ 답함' } }]).catch(() => {})
          c.session.openDialogTs = undefined
        }
        c.session.stallShown = undefined
        this.clearWaiting(c.session)
        await this.setStatus(c.session, 'processing')
        this.noteActivity(c.session)
      },
    },

    type: { user: true, run: async (c) => void (await this.tmux.sendKeys(c.pane, ['-l', c.arg])) },

    /** Put to rest, or wake (45): `rest on` · `rest off`. Only the page and the panel send it. */
    rest: {
      run: async (c) => {
        const on = c.arg.trim() !== 'off'
        c.session.resting = on || undefined
        this.changed()
        this.lastWebNote = on ? '휴면으로 뒀어요' : '휴면을 풀었어요'
        await c.ack(this.lastWebNote)
      },
    },

    canvas: {
      user: true,
      run: async (c) => {
        const markdown = await this.purges.render(c.session)
        if (!markdown) return void (await c.ack('⚠️ 스레드를 읽지 못해 캔버스를 만들지 못했습니다.'))
        const link = await this.writeCanvas(c.session, markdown)
        await c.post(link ? `📄 <${link}|${basename(c.session.cwd)} 캔버스>` : '⚠️ 캔버스를 만들 권한이 없습니다. Slack 앱에 `canvases:write` 를 추가하고 재설치하세요.')
      },
    },

    refresh: {
      user: true,
      noPane: true,
      run: async (c) => {
        const s = c.session
        const mode = c.arg.trim()
        if (mode === 'cancel') return this.cancelScheduledRefresh(s, c)
        if (mode === 'later') return this.scheduleRefresh(s, c)
        if (!c.pane) return void (await c.ack('이 세션은 tmux 밖에서 실행 중이라 새로고침할 수 없습니다.'))
        if (!s.sessionId) return void (await c.ack('⚠️ 아직 세션 id를 몰라 새로고침할 수 없습니다. 잠시 뒤에 다시 해보세요.'))
        // Hold anything typed from here until the replacement is up, and before the first await: a Stop or a
        // PostToolUse in that gap must not hand held messages (or a new one) to the process about to go.
        this.waking.set(s.threadTs, [])
        s.refreshing = true
        // What dies with the process, so the relaunched session is told first thing.
        s.interrupted = await this.backgroundTasks(s).catch(() => [])
        this.logAt('INFO', 'session', 'refreshing on request', this.tag(s, { user: c.user }))
        await c.post(
          `🔄 세션을 다시 엽니다 — 대화는 그대로 이어지고, 새로 설치한 스킬·플러그인·MCP가 반영됩니다.${s.origin === 'terminal' ? ' (터미널에서 띄운 세션이라 tmux `claude-slack` 창으로 옮겨집니다)' : ''}`,
        )
        await this.tmux.killPane(c.pane)
        s.refreshAfter = undefined
      },
    },

    kill: {
      user: true,
      run: async (c) => {
        await this.tmux.killPane(c.pane)
      },
    },

    // ---- internal: reachable from panel buttons and the settings modal, not by typing

    effort: { run: (c) => this.setSetting(c, 'effort') },
    model: { run: (c) => this.setSetting(c, 'model') },

    exit: {
      run: async (c) => {
        await this.tmux.typeLine(c.pane, '/exit')
        await c.ack('→ /exit')
      },
    },

    purge: {
      run: async (c) => {
        // Live session: end it, then archive and delete once SessionEnd arrives.
        c.session.purgeOnEnd = true
        await this.tmux.typeLine(c.pane, '/exit')
        await c.ack('→ 종료 후 스레드를 보관하고 지웁니다')
      },
    },

    mode: {
      run: async (c) => {
        if (c.arg === 'autoAllow') {
          await this.setAutoAllow(c.session, true)
          this.lastWebNote = '권한 모드를 바꿨어요'
          return
        }
        // Any Claude Code mode turns 전부 허용 off (42): it is the broker's answer, not a mode of the terminal.
        if (c.session.autoAllow) await this.setAutoAllow(c.session, false)
        const { reached } = await this.cycleToMode(c.pane, c.arg)
        if (reached) {
          c.session.permissionMode = reached
          this.schedulePanelRefresh(c.session, PANEL_REFRESH_SETTLE_MS)
        }
        this.lastWebNote = c.arg && reached !== c.arg ? `${c.arg}로 못 바꿨어요` : '권한 모드를 바꿨어요'
        await c.ack(c.arg && reached !== c.arg ? `⚠️ 권한 모드를 ${c.arg}로 못 바꿨습니다 (현재 ${reached ?? '?'}). 화면을 확인하세요.` : `→ 권한 모드 ${reached ?? c.arg}`)
      },
    },

    clear: { run: (c) => this.slashThrough(c, '/clear') },
    compact: { run: (c) => this.slashThrough(c, '/compact') },
  }

  /** Commands a user may type after `:`. Derived, never hand-listed. */
  private get userCommands(): Set<string> {
    return new Set(Object.entries(this.commands).filter(([, spec]) => spec.user).map(([name]) => name))
  }

  /** A session by pid, session-id prefix, launch key prefix, or the ts inside a thread link. */
  private findSession(ref: string): Session | undefined {
    const ts = /p(\d{10})(\d{6})/.exec(ref)
    if (ts) return this.registry.byThreadTs(`${ts[1]}.${ts[2]}`)
    if (/^\d+$/.test(ref)) return this.registry.byPid(Number(ref))
    return this.registry.live.find((s) => s.sessionId.startsWith(ref) || s.key.startsWith(ref) || s.threadTs === ref)
  }

  /**
   * Ask the terminal for context usage by running `/context` and reading what it
   * prints. Only used when the status line does not already carry the number.
   */
  private async readContextUsage(pane: string): Promise<{ percent: number; label: string } | null> {
    try {
      await this.tmux.typeLine(pane, '/context')
      return detectContextUsage(await this.settledScreen(pane))
    } catch (err) {
      this.logAt('WARN', 'tmux', `context read failed: ${describeError(err)}`, { pane })
      return null
    }
  }

  /**
   * Put the session's record in a canvas. Returns its link, or undefined when
   * the app has not been granted `canvases:write` yet.
   */
  private async writeCanvas(session: Session, markdown: string): Promise<string | undefined> {
    const title = session.title ? `${basename(session.cwd)} · ${session.title}` : basename(session.cwd)
    try {
      const link = await this.slack.createCanvas(truncate(title, 70), markdown)
      if (!link) this.logAt('WARN', 'slack', 'canvas skipped: the app needs the canvases:write scope', this.tag(session))
      return link
    } catch (err) {
      this.logAt('WARN', 'slack', `canvas failed: ${describeError(err)}`, this.tag(session))
      return undefined
    }
  }

  /**
   * Esc, then a look at what it did. "Esc 전송" three times in a row with no
   * visible effect is what the user got before; now the answer says whether the
   * session stopped, was already idle, or is still drawing a work indicator.
   */
  private async interrupt(c: CommandContext): Promise<void> {
    const { session } = c
    const wasBusy = !!session.turn
    await this.tmux.sendKeys(c.pane, ['Escape'])
    if (wasBusy) session.escAt = Date.now()
    this.logAt('INFO', 'esc', 'sent', this.tag(session, { busy: wasBusy }))
    await sleep(this.cfg.escSettleMs ?? ESC_SETTLE_MS)
    const screen = await this.tmux.capture(c.pane).catch(() => '')
    const stuck = detectStuckState(screen)
    // An idle-looking screen right after Esc can still be mid-step (a tool just finished, the next
    // line has not printed): trust the transcript's own account of whether Claude has answered.
    const reallyOpen = wasBusy && stuck?.kind === 'idle-prompt' && !!session.transcriptPath && transcriptTurnLooksOpen(session.transcriptPath)
    const stopped = (stuck?.kind === 'interrupted' || (stuck?.kind === 'idle-prompt' && wasBusy)) && !reallyOpen
    this.logAt('INFO', 'esc', 'result', this.tag(session, { result: stopped ? 'stopped' : stuck?.kind ?? 'still-working' }))
    if (stopped) {
      if (session.turn) {
        await session.turn.end().catch(() => {})
        session.turn = undefined
      }
      session.stuckShown = `stuck|interrupted`
      await c.ack('⏹️ 멈췄어요. 다음 지시를 기다려요')
      this.markWaiting(session, 'instruction')
      await this.setStatus(session, 'suspended')
      // Claude Code keeps what was queued and sends it right after Esc; so do we. Not when a refresh is reserved:
      // those are for the relaunched session, and the stop may be what lets the refresh run now.
      if (session.refreshAfter) void this.maybeRunScheduledRefresh(session)
      else await this.releaseHeld(session, 'esc')
      return
    }
    if (!wasBusy && !/esc to interrupt/i.test(screen)) {
      const typed = screen.split('\n').some((l) => /^\s*❯\s*\S/.test(l))
      return void (await c.ack(`⏹️ 이미 유휴 상태였습니다. 중단할 작업이 없습니다.${typed ? ' 입력칸에 보내지 않은 글이 남아 있습니다 (`:screen` 으로 확인).' : ''}`))
    }
    await c.ack('⏹️ Esc를 보냈지만 터미널에 아직 작업 표시가 남아 있습니다. 잠시 뒤 `:screen` 으로 확인하세요.')
  }

  /** `/model` and `/effort` share a shape: type it, remember it, watch for the dialog it opens. */
  private async setSetting(c: CommandContext, which: 'model' | 'effort'): Promise<void> {
    // The value already in use: nothing is typed, and the answer is still ok (42).
    if (c.arg && c.session[which] === c.arg) return void (await c.ack(`→ /${which} ${c.arg}`))
    await this.tmux.typeLine(c.pane, `/${which} ${c.arg}`.trim())
    if (c.arg) c.session[which] = c.arg
    if (c.arg && which === 'model') c.session.launchModel = c.arg
    this.schedulePanelRefresh(c.session)
    await c.ack(`→ /${which} ${c.arg}`)
    // Mid-conversation Claude Code asks "Switch model?"; a stuck dialog would swallow the next prompt.
    await this.checkDialogSoon(c.session)
  }

  private async slashThrough(c: CommandContext, slash: string): Promise<void> {
    await this.tmux.typeLine(c.pane, slash)
    await c.ack(`→ ${slash}`)
  }

  /** Type a Claude Code command straight into the terminal and show what it prints. */
  private async passThrough(c: CommandContext): Promise<void> {
    await this.tmux.typeLine(c.pane, c.cmd)
    // "/model <x>" sent through as is: that is now the session's chosen model (a refresh must launch with it).
    const picked = /^\/model\s+(\S+)\s*$/.exec(c.cmd)?.[1]
    if (picked) {
      c.session.launchModel = picked
      this.changed()
    }
    await c.ack(`→ ${c.cmd}`)
    if (/^\/(context|usage|cost|status|help|permissions)/.test(c.cmd)) {
      // These print into the TUI; wait for the output to finish drawing, then
      // show the lines that carry content rather than the whole screen.
      await this.postCommandOutput(c, await this.settledScreen(c.pane))
    } else await this.checkDialogSoon(c.session, POST_SLASH_DIALOG_MS)
  }

  /**
   * Show what a command printed. Columnar output becomes a real table, which is
   * the difference between readable and a wall of padded text on a phone; if it
   * is not columnar, or Slack rejects the block, fall back to the plain screen.
   */
  private async postCommandOutput(c: CommandContext, screen: string): Promise<void> {
    c.session.screenShownAt = Date.now()
    const digest = screenDigest(screen, SCREEN_OUTPUT_LINES)
    // Only the commands that report numbers are laid out as tables; `/help` and
    // `/permissions` are prose and read better as they were printed.
    const rows = TABULAR_COMMANDS.test(c.cmd) ? parseColumns(digest) : null
    if (rows) {
      try {
        await this.slack.post({ threadTs: c.session.threadTs, text: `\`${c.cmd}\``, blocks: [tableBlock(rows)] })
        return
      } catch (err) {
        this.logAt('INFO', 'slack', `table block rejected, showing text instead: ${describeError(err)}`, this.tag(c.session))
      }
    }
    await c.post(this.screenBlock(screen, { maxLines: SCREEN_OUTPUT_LINES }))
  }

  /**
   * A side question (52): `/btw 질문` and `:btw 질문` both come here, not to the terminal. One card, posted at once
   * and then updated with the answer: it never enters the conversation, and the panel's Esc closes it again.
   */
  private async runBtw(session: Session, q: string): Promise<void> {
    const threadTs = session.threadTs
    if (!q) return void (await this.slack.post({ threadTs, text: '사용법: `/btw 질문` — 대화에 남기지 않고 지금까지의 맥락으로만 답해요.' }))
    if (!session.pane) return void (await this.slack.post({ threadTs, text: '이 세션은 tmux 밖에서 실행 중이라 옆길 질문을 할 수 없어요.' }))
    const head = `옆길 질문 · 대화에는 남지 않아요 — ${truncate(q, 120)}`
    const card = await this.slack.post({ threadTs, text: `${head}\n답을 기다리는 중…` })
    // A side question does not touch the main turn — typed in even while one is running.
    const before = screenDigest(await this.tmux.capture(session.pane), 200)
    await this.tmux.typeLine(session.pane, `/btw ${q}`)
    // The card shows the wait, once a second at most (52).
    const started = Date.now()
    const tick = setInterval(() => {
      this.slack.update(card, `${head}\n답을 기다리는 중… ${Math.round((Date.now() - started) / 1000)}초`).catch(() => {})
    }, 1000)
    const fresh = await this.readBtwAnswer(session.pane, before).finally(() => clearInterval(tick))
    // The answer sits in a panel that keeps the keyboard until Esc; close it so the next message is not typed into it.
    await this.tmux.sendKeys(session.pane, ['Escape'])
    const body = fresh ? '```' + truncate(fresh.replace(/```/g, "'''"), 3800) + '```' : '답을 화면에서 읽지 못했어요. 화면을 확인하세요'
    await this.slack.update(card, `${head}\n${body}`).catch(() => {})
  }

  private async runCommand(session: Session, cmd: string, user?: string, messageTs?: string): Promise<void> {
    const threadTs = session.threadTs
    const post = (text: string) => this.slack.post({ threadTs, text })
    if (cmd === '') return void (await post(HELP))
    // `/btw` is answered here, from the screen, not sent into the terminal and left there (52).
    if (/^\/btw(\s|$)/.test(cmd)) return this.runBtw(session, cmd.replace(/^\/btw\s*/, '').trim())
    const early = this.commands[cmd.split(/\s+/)[0] ?? '']
    if (early?.noPane && !session.pane) return early.run(this.ctx(session, cmd, user, messageTs))
    if (!session.pane) {
      const note = '이 세션은 tmux 밖에서 실행 중이라 키 조작을 할 수 없습니다. 메시지 전달은 됩니다.'
      return void (user ? await this.slack.postEphemeral(user, note, threadTs).catch(() => {}) : await post(note))
    }
    const name = cmd.split(/\s+/)[0] ?? ''
    const c = this.ctx(session, cmd, user, messageTs)
    const spec = this.commands[name]
    if (spec) return spec.run(c)
    if (name.startsWith('/') || name.startsWith('!')) return this.passThrough(c)
    await post(`알 수 없는 명령 \`${name}\`\n${HELP}`)
  }

  // ------------------------------------------------------------------ panel

  private get purgeScope(): PurgeScope {
    return this.cfg.userToken ? 'all' : 'bot'
  }

  private panelState(session: Session): PanelState {
    return {
      purgeScope: this.purgeScope,
      pid: session.pid,
      cwd: session.cwd,
      title: session.title,
      origin: session.origin,
      hasPane: !!session.pane,
      window: session.window,
      model: session.launchModel ?? session.model,
      effort: session.effort,
      permissionMode: session.permissionMode,
      autoAllow: !!session.autoAllow,
      resting: !!session.resting,
      state: session.ended ? 'ended' : session.state,
    }
  }

  private trackStatus(session: Session, event: HookEvent): void {
    let changed = false
    // A prompt typed in the terminal wakes a session that was put to rest (45).
    if (event.hook_event_name === 'UserPromptSubmit' && session.resting) {
      session.resting = undefined
      changed = true
    }
    const mode = event.permission_mode
    if (typeof mode === 'string' && mode !== session.permissionMode) {
      session.permissionMode = mode
      changed = true
    }
    const effort = (event.effort as { level?: string } | undefined)?.level
    if (typeof effort === 'string' && effort !== session.effort) {
      session.effort = effort
      changed = true
    }
    if (changed) this.schedulePanelRefresh(session)
  }

  private schedulePanelRefresh(session: Session, delayMs = PANEL_REFRESH_MS): void {
    this.refreshRoot(session).catch(() => {})
    if (!session.panelTs) return
    const due = Date.now() + delayMs
    if (session.panelTimer) {
      if (session.panelDue !== undefined && session.panelDue <= due) return
      clearTimeout(session.panelTimer)
    }
    session.panelDue = due
    session.panelTimer = setTimeout(() => {
      session.panelTimer = undefined
      session.panelDue = undefined
      const panel = controlPanel(this.panelState(session))
      this.slack.update(session.panelTs!, panel.text, panel.blocks).catch((e) => this.logAt('WARN', 'slack', `panel update failed: ${describeError(e)}`, this.tag(session)))
    }, delayMs)
    session.panelTimer.unref?.()
  }

  // ------------------------------------------------------------------- state

  /**
   * A session that ended leaves its conversation in the past records (47). Only the newest 100 of these are kept;
   * a conversation already archived (by a purge, say) is not written again.
   */
  private archiveEnded(session: Session): void {
    const dir = this.cfg.archiveDir
    const messages: ArchivedMessage[] = []
    // Every kind of event is kept (47), not only what people and Claude said: a tool, a card or a notice is part of the record.
    for (const e of this.events.since(session.threadTs, 0)) {
      const { seq: _seq, at, ...body } = e
      const text = 'text' in body && typeof body.text === 'string' ? body.text : 'output' in body && typeof body.output === 'string' ? body.output : 'title' in body ? String(body.title) : ''
      const user = e.type === 'user' ? e.via : undefined
      messages.push({ ts: e.type === 'user' || e.type === 'msg' ? (e.ts as string) : String(at), user, bot: e.type !== 'user', text, event: { ...body, at } as Record<string, unknown> })
    }
    if (!messages.length || findArchiveByThread(session.threadTs, dir)) return
    try {
      writeArchive({ key: `ended-${session.threadTs}`, sessionId: session.sessionId ?? '', cwd: session.cwd, title: session.manualTitle ?? session.title, threadTs: session.threadTs, origin: session.origin === 'slack' ? 'slack' : 'terminal', archivedAt: new Date().toISOString(), transcriptPath: session.transcriptPath, messages }, dir)
    } catch (err) {
      this.logAt('WARN', 'archive', `past record not written: ${describeError(err)}`, this.tag(session))
      return
    }
    const autos = listArchives(10_000, dir).filter((a) => {
      try {
        return (JSON.parse(readFileSync(a.path, 'utf8')) as SessionArchive).key.startsWith('ended-')
      } catch {
        return false
      }
    })
    for (const a of autos.slice(ENDED_ARCHIVE_MAX)) deleteArchive(a.path, dir)
  }

  private async endSession(session: Session, why: string): Promise<void> {
    if (session.ended) return
    session.ended = true
    session.reviewLoop = undefined // the loop ends with the session (75)
    this.archiveEnded(session)
    this.logAt('INFO', 'session', `ended: ${why}`, this.tag(session, { held: session.held?.length ?? 0 }))
    this.clearStall(session)
    if (session.autoAllowWatch) clearInterval(session.autoAllowWatch)
    for (const r of session.dialogRetries?.values() ?? []) r.cancel()
    if (session.waitingTimer) clearTimeout(session.waitingTimer)
    if (session.injectCheck?.timer) clearTimeout(session.injectCheck.timer)
    for (const [key, p] of this.pendingPermissions) {
      if (p.pid !== session.pid) continue
      if (p.timer) clearTimeout(p.timer)
      this.pendingPermissions.delete(key)
    }
    // A refresh reopens this very thread in a moment, so what was held rides along
    // instead of being dropped with a warning that would read as a loss.
    const carried = session.refreshing ? (session.held?.splice(0) ?? []) : []
    if (session.held?.length) {
      const n = session.held.length
      await this.dropHeld(session)
      await this.slack.post({ threadTs: session.threadTs, text: `⚠️ 세션이 끝나 붙잡아 둔 메시지 ${n}개는 전달하지 못했습니다.` }).catch(() => {})
    }
    session.waitingReason = undefined
    session.tailer?.close()
    if (session.turn) {
      await session.turn.end().catch(() => {})
      session.turn = undefined
    }
    session.conn?.close()
    session.conn = undefined
    this.offsets.forget(session.key)
    // What was kept per process (background work, skill lines) goes with it.
    const mine = `${session.key}:${session.pid}:`
    for (const k of this.bgTrackers.keys()) if (k.startsWith(mine)) this.bgTrackers.delete(k)
    for (const k of this.notifiedBgTasks) if (k.startsWith(`${session.key}:`)) this.notifiedBgTasks.delete(k)
    for (const k of this.skillReaders.keys()) if (k.startsWith(mine)) this.skillReaders.delete(k)
    this.pluginCache.delete(`${session.key}:${session.pid}`)
    // Ended on purpose, so it must not come back at the next start.
    this.revive.forget(session.key)
    // A second, still-live session can already own this thread (two Claude Code processes under one key, briefly,
    // or a race around a refresh): if so, this one ending must not read as the conversation itself ending, and the
    // thread lookup — which only ever remembers the one added last — must point back at the one still running.
    const replacement = this.registry.live.find((x) => x !== session && x.threadTs === session.threadTs && !x.ended)
    this.registry.remember(session)
    if (replacement) this.registry.add(replacement)
    this.refreshHome()
    if (session.refreshing) return this.reopenForRefresh(session, carried)
    if (replacement) {
      this.logAt('WARN', 'session', 'a live session already owns this thread; not announcing this one as ended', this.tag(session))
      return
    }
    this.emitEvent(session.threadTs, { type: 'end', why })
    await this.slack.post({ threadTs: session.threadTs, text: `⚫ 세션 ${why}` })
    if (session.rootTs) await this.slack.update(session.rootTs, this.rootText(session, '⚫', '종료됨'))
    if (session.panelTs) {
      if (session.panelTimer) clearTimeout(session.panelTimer)
      const panel = controlPanel(this.panelState(session))
      await this.slack.update(session.panelTs, panel.text, panel.blocks).catch(() => {})
    }
    await this.setStatus(session, 'closed')
    if (session.purgeOnEnd) await this.purgeThread(session)
  }

  /** Archive the whole thread to disk, then delete every message this app posted. */
  async purgeThread(session: Session, user?: string): Promise<void> {
    if (!session.ended) return
    const result = await this.purges.run(session)
    if (result.error) this.logAt('WARN', 'purge', `cannot read thread: ${describeError(result.error)}`, this.tag(session))
    else session.panelTs = undefined
    // The archive lands on the machine the broker runs on, which may not be the
    // one you are holding. A canvas keeps the record reachable from Slack.
    const canvas = result.markdown ? await this.writeCanvas(session, result.markdown) : undefined
    if (!user) return
    // Without the root the thread is gone, so the reply has nowhere to be threaded.
    const threadTs = result.error || !result.rootGone ? session.threadTs : undefined
    const note = canvas ? `${PurgeService.describe(result)}\n📄 <${canvas}|캔버스로 보기>` : PurgeService.describe(result)
    await this.slack.postEphemeral(user, note, threadTs).catch(() => {})
  }
}

/**
 * The permission relay's `input_preview` carries the tool's arguments as JSON.
 * Returns them as an object, or undefined when it is prose rather than JSON —
 * then the card falls back to showing the preview as it came.
 */
function parsePreview(preview: string): Record<string, unknown> | undefined {
  const text = preview.trim()
  if (!text.startsWith('{') || !text.endsWith('}')) return undefined
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/** opus / sonnet / haiku / fable, from an id or an alias (claude-opus-5-5, opus[1m]); undefined for default, opusplan. */
function modelFamily(m: string): string | undefined {
  return /\b(opus|sonnet|haiku|fable)\b|(?:^|-)(opus|sonnet|haiku|fable)(?:-|\[|$)/.exec(m)?.slice(1).find(Boolean)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function listDirs(root: string): Promise<string[]> {
  try {
    // withFileTypes answers "is it a directory?" from the same call, so no per-entry stat.
    const entries = await readdir(root, { withFileTypes: true })
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => resolve(root, e.name))
      .sort()
  } catch {
    return []
  }
}

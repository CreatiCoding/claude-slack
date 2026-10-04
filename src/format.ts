import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { relative, resolve } from 'node:path'

export const SLACK_MAX_CHARS = 3900

/**
 * A top-level Slack message may start with a directory to run the new
 * session in: "~/projects/foo 테스트 고쳐줘". Anything else is the prompt.
 */
export function parseLaunchText(
  text: string,
  defaultCwd: string,
  isDir: (p: string) => boolean = defaultIsDir,
): { cwd: string; prompt: string } {
  const trimmed = text.trim()
  const m = /^(~\/?[^\s]*|\/[^\s]*)(?:\s+([\s\S]*))?$/.exec(trimmed)
  if (m) {
    const candidate = expandHome(m[1]!)
    if (isDir(candidate)) return { cwd: candidate, prompt: (m[2] ?? '').trim() }
  }
  return { cwd: defaultCwd, prompt: trimmed }
}

export function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2))
  return resolve(p)
}

export function shortenHome(p: string): string {
  const home = homedir()
  return p.startsWith(home) ? '~' + p.slice(home.length) : p
}

function defaultIsDir(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isDirectory()
  } catch {
    return false
  }
}

/**
 * A Markdown table as Slack can show it. Slack mrkdwn has no tables, so the
 * pipes came through verbatim on a phone. Each body row becomes one line, the
 * first cell in bold and the rest labelled with their column header, which
 * reads on a narrow screen where a grid would not.
 */
export function tableToLines(block: string): string {
  const rows = block
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('|'))
    .map((l) => l.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()))
  if (rows.length < 2) return block
  const [header, ...body] = rows
  const dataRows = body.filter((r) => !r.every((c) => /^:?-{2,}:?$/.test(c) || c === ''))
  if (!dataRows.length) return block
  return dataRows
    .map((r) => {
      const [first, ...rest] = r
      const tail = rest.map((c, i) => (header![i + 1] && rest.length > 1 ? `${header![i + 1]} ${c}` : c)).filter(Boolean).join(' · ')
      return tail ? `• *${first}*: ${tail}` : `• *${first}*`
    })
    .join('\n')
}

const TABLE_RE = /(^|\n)((?:[ \t]*\|[^\n]*\|[ \t]*\n?){2,})/g

/** Only the table rewrite, for text Slack renders as Markdown itself (the streaming API) but still without tables. */
export function convertTables(md: string): string {
  return md
    .split(/(```[\s\S]*?```)/g)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(TABLE_RE, (_m, lead: string, table: string) => `${lead}${tableToLines(table)}${table.endsWith('\n') ? '\n' : ''}`)))
    .join('')
}

/** Best-effort Markdown -> Slack mrkdwn. Code blocks are left untouched. */
export function toMrkdwn(md: string): string {
  const parts = md.split(/(```[\s\S]*?```)/g)
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part
      return part
        .replace(TABLE_RE, (_m, lead: string, table: string) => `${lead}${tableToLines(table)}${table.endsWith('\n') ? '\n' : ''}`)
        .replace(/^(#{1,6})\s+(.+)$/gm, (_m, _h, t: string) => `*${t.trim()}*`)
        .replace(/\*\*(.+?)\*\*/g, '*$1*')
        .replace(/__(.+?)__/g, '*$1*')
        .replace(/~~(.+?)~~/g, '~$1~')
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<$2|$1>')
        .replace(/^\s*[-*]\s+/gm, '• ')
    })
    .join('')
}

// The fence starts a line, and no line inside it has a fence of its own (71): mid-sentence text is not a block.
const CHOICES_RE = /(?:^|\n)```choices[ \t]*\n((?:(?![^\n]*```)[^\n]*\n)*?)```\s*$/

/**
 * A trailing ```choices fenced block (22): up to 6 short options the person picks instead of typing a
 * reply. Pulled off the end of the answer — never mid-answer — so the text that goes to Slack and the web
 * is the same either way, with the choices carried separately for each surface to render as buttons.
 */
export function extractChoices(text: string): { text: string; choices?: string[] } {
  const m = CHOICES_RE.exec(text)
  if (!m) return { text }
  const choices = m[1]!
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 6)
  if (!choices.length) return { text }
  return { text: text.slice(0, m.index).replace(/\s+$/, ''), choices }
}

/** Split long text for Slack, keeping ``` fences balanced across chunks. */
export function chunk(text: string, max = SLACK_MAX_CHARS): string[] {
  if (text.length <= max) return [text]
  const out: string[] = []
  let current = ''
  let inFence = false
  for (const line of text.split('\n')) {
    const candidate = current ? current + '\n' + line : line
    if (candidate.length > max && current) {
      out.push(inFence ? current + '\n```' : current)
      current = inFence ? '```\n' + line : line
    } else {
      current = candidate
    }
    if (/^\s*```/.test(line)) inFence = !inFence
    // A single line longer than max: hard split.
    while (current.length > max) {
      out.push(current.slice(0, max))
      current = current.slice(max)
    }
  }
  if (current) out.push(current)
  return out
}

/** Room for a whole script without turning the expanded task into a wall. */
const DETAILS_MAX = 1500

const TOOL_ICON: Record<string, string> = {
  Bash: '⚙️',
  Edit: '✏️',
  Write: '📝',
  Read: '📖',
  Grep: '🔍',
  Glob: '🔍',
  Agent: '🤖',
  Task: '🤖',
  TodoWrite: '📋',
  Skill: '🧩',
  WebFetch: '🌐',
  WebSearch: '🌐',
  NotebookEdit: '✏️',
}

/**
 * What the one-line summary had to leave out. The summary keeps a thread
 * readable at a glance; this is what a reader gets on expanding the task, so it
 * is the whole command rather than a cleverer shortening of it.
 */
export function activityDetails(toolName: string, toolInput: unknown): string | undefined {
  const input = (toolInput ?? {}) as Record<string, unknown>
  const full =
    toolName === 'Bash'
      ? String(input.command ?? '')
      : toolName === 'Task' || toolName === 'Agent'
        ? String(input.prompt ?? input.description ?? '')
        : toolName === 'WebSearch'
          ? String(input.query ?? '')
          : ''
  const trimmed = full.trim()
  // Nothing to expand into when the summary already showed all of it.
  return trimmed.includes('\n') || trimmed.length > 80 ? truncate(trimmed, DETAILS_MAX) : undefined
}

/** Links a tool call is about, so a reader can follow them from the task itself. */
export function activitySources(toolName: string, toolInput: unknown): Array<{ type: 'url'; url: string; text: string }> | undefined {
  const input = (toolInput ?? {}) as Record<string, unknown>
  if (toolName !== 'WebFetch') return undefined
  const url = String(input.url ?? '')
  if (!/^https?:\/\//.test(url)) return undefined
  return [{ type: 'url', url, text: hostOf(url) }]
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** One compact line describing a tool call, for the activity message. */
export function activityLine(toolName: string, toolInput: unknown, cwd: string): string {
  const input = (toolInput ?? {}) as Record<string, unknown>
  const icon = TOOL_ICON[toolName] ?? '🔧'
  const name = toolName.startsWith('mcp__') ? toolName.replace(/^mcp__/, '') : toolName
  let detail = ''
  switch (toolName) {
    case 'Bash':
      detail = bashDetail(String(input.command ?? ''))
      break
    case 'Edit':
    case 'Write':
    case 'Read':
    case 'NotebookEdit':
      detail = rel(String(input.file_path ?? input.notebook_path ?? ''), cwd)
      break
    case 'Grep':
    case 'Glob':
      detail = String(input.pattern ?? '')
      break
    case 'Task':
    case 'Agent': {
      // Several subagents run at once, so the kind is what tells them apart.
      const kind = String(input.subagent_type ?? '').trim()
      const what = String(input.description ?? '').trim()
      detail = [kind, what].filter(Boolean).join(' · ')
      break
    }
    case 'TodoWrite': {
      const todos = (Array.isArray(input.todos) ? input.todos : []) as Array<Record<string, unknown>>
      const active = todos.find((t) => t.status === 'in_progress')
      const done = todos.filter((t) => t.status === 'completed').length
      const what = String(active?.activeForm ?? active?.content ?? '').trim()
      detail = what ? `${what} (${done}/${todos.length})` : `${done}/${todos.length} 완료`
      break
    }
    case 'Skill':
      detail = String(input.skill ?? '')
      break
    case 'WebFetch':
      detail = String(input.url ?? '')
      break
    case 'WebSearch':
      detail = String(input.query ?? '')
      break
    default: {
      const first = Object.values(input).find((v) => typeof v === 'string') as string | undefined
      detail = first ? firstLine(first) : ''
    }
  }
  detail = truncate(detail.replace(/`/g, "'"), 110)
  return detail ? `${icon} ${name} \`${detail}\`` : `${icon} ${name}`
}

function rel(p: string, cwd: string): string {
  if (!p) return ''
  const r = relative(cwd, p)
  return r && !r.startsWith('..') ? r : shortenHome(p)
}

function firstLine(s: string): string {
  return s.split('\n')[0] ?? ''
}

/**
 * Claude Code wraps most Bash calls in scaffolding that reads the same every
 * time: a `cd` into the project, and an interpreter fed by a heredoc. Show what
 * the call is actually doing instead, or the thread becomes one repeated line.
 */
function bashDetail(command: string): string {
  const lines = command.split('\n').map((l) => l.trim()).filter(Boolean)
  for (const [i, line] of lines.entries()) {
    const rest = stripCd(line)
    if (!rest) continue
    const opener = scriptOpener(rest)
    if (!opener) return rest
    const body = lines.slice(i + 1).filter((l) => l !== opener.terminator)
    const what = body.find((l) => !SCRIPT_PREAMBLE.test(l)) ?? body[0]
    return [opener.launcher, what].filter(Boolean).join(' · ')
  }
  return lines[0] ?? ''
}

/**
 * A line that only opens a script the following lines carry — a heredoc, or a
 * `-c "` whose quote runs past the newline. On its own it names the interpreter
 * and nothing else, which is the same text on every such call.
 */
function scriptOpener(line: string): { launcher: string; terminator: string } | undefined {
  const heredoc = /<<-?\s*['"]?(\w+)['"]?\s*$/.exec(line)
  if (heredoc) return { launcher: launcherOf(line.slice(0, heredoc.index)), terminator: heredoc[1]! }
  const quote = /(['"])\s*$/.exec(line)
  // An odd count means this quote opens rather than closes.
  if (quote && line.split(quote[1]!).length % 2 === 0) {
    return { launcher: launcherOf(line.slice(0, quote.index)), terminator: quote[1]! }
  }
  return undefined
}

/** Drop the trailing `-`, `-c`, `-e`: they only say "the script follows". */
function launcherOf(head: string): string {
  return head.replace(/\s+-[ce]?\s*$/, '').trim()
}

/** Lines every script opens with, so they say nothing about this particular one. */
const SCRIPT_PREAMBLE = /^(#|import\s|from\s+\S+\s+import\s|require\(|use\s|set\s+-|'''|""")/

function stripCd(line: string): string {
  let out = line
  for (;;) {
    const m = /^cd\s+(?:'[^']*'|"[^"]*"|\S+)\s*(?:&&|;)?\s*/.exec(out)
    if (!m?.[0]) return out
    out = out.slice(m[0].length)
  }
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

/** matches "y abcde", "yes abcde", "n abcde", "no abcde" (ID alphabet skips 'l') */
export const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

export function permissionBlocks(opts: {
  pid: number
  requestId: string
  toolName: string
  description: string
  inputPreview: string
}): { text: string; blocks: unknown[] } {
  const text = `🔐 권한 요청 · ${opts.toolName} · ${opts.requestId}`
  const preview = truncate(opts.inputPreview, 2500)
  const value = `${opts.pid}:${opts.requestId}`
  return {
    text,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `🔐 *${opts.toolName}* 권한 요청 · \`${opts.requestId}\`\n${opts.description}`,
        },
      },
      ...(preview
        ? [{ type: 'section', text: { type: 'mrkdwn', text: '```' + preview + '```' } }]
        : []),
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            style: 'primary',
            text: { type: 'plain_text', text: '허용' },
            action_id: 'perm_allow',
            value,
          },
          {
            type: 'button',
            style: 'danger',
            text: { type: 'plain_text', text: '거부' },
            action_id: 'perm_deny',
            value,
          },
        ],
      },
    ],
  }
}

/** Lines that are chrome, not content: box rules, the status line, the tip banner. */
const SCREEN_NOISE = [
  /^[\s─▔━═_╌╍│|└┘┌┐├┤┬┴┼.-]*$/, // separators and blank
  /\bTip:/i,
  /shift\+tab to cycle|esc to interrupt|for agents|to manage|\? for shortcuts/i,
  /^\s*[❯>]\s*$/, // the empty input box
  /tmux detected|scroll with PgUp/i,
]

/**
 * What is actually worth showing from a terminal screen. Claude Code draws a
 * full-height TUI, so a raw tail is mostly box rules and the status line; on
 * mobile that pushes the real content out of view. Keep the lines that say
 * something, newest last.
 */
export function screenDigest(screen: string, maxLines = 12): string {
  const lines = screen
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim() && !SCREEN_NOISE.some((re) => re.test(l)))
  return lines.slice(-maxLines).join('\n')
}

/** "96초", "2분 12초", "1시간 4분" — for telling the user how long a wait has run. */
export function duration(ms: number): string {
  const total = Math.round(ms / 1000)
  if (total < 60) return `${total}초`
  const m = Math.floor(total / 60)
  const s = total % 60
  if (m < 60) return s ? `${m}분 ${s}초` : `${m}분`
  const h = Math.floor(m / 60)
  return `${h}시간 ${m % 60}분`
}

/**
 * Claude Code injects some "user" messages itself: a Slack channel message, a
 * finished subagent, a system reminder, the echo of a slash command. They reach
 * the UserPromptSubmit hook exactly like typing does, so mirroring them raw puts
 * internal XML in the thread under a "the user typed this" label.
 */
const SYSTEM_ENVELOPE_RE = /^\s*<(channel|task-notification|system-reminder|agent-message|local-command-[a-z-]+|command-name|command-message|command-args)\b/i

export interface SystemEnvelope {
  kind: string
  /** A short human line, when the envelope carries one worth showing. */
  summary?: string
  /**
   * A routine completion ("Agent X finished", "Background command Y completed
   * (exit code 0)"): Claude's next step shows it, so the thread need not.
   * Failures are never routine.
   */
  routine?: boolean
}

const ROUTINE_SUMMARY_RE = /^(Agent .* finished|Background command .* completed \(exit code 0\))$/i

export function systemEnvelope(text: string): SystemEnvelope | null {
  const m = SYSTEM_ENVELOPE_RE.exec(text)
  if (!m) return null
  const kind = m[1]!.toLowerCase()
  if (kind !== 'task-notification') return { kind }
  const summary = /<summary>([\s\S]*?)<\/summary>/i.exec(text)?.[1]?.trim()
  const status = /<status>([\s\S]*?)<\/status>/i.exec(text)?.[1]?.trim()
  const failed = !!status && status !== 'completed'
  return {
    kind,
    summary: summary ? (failed ? `${summary} (${status})` : summary) : undefined,
    routine: !!summary && !failed && ROUTINE_SUMMARY_RE.test(summary),
  }
}

/**
 * What a failure means and what to do about it.
 *
 * The raw text of a Slack or tmux failure says `missing_scope` or
 * `can't find session`, which is precise and useless to someone looking at a
 * phone. Translate the ones that have an obvious next step, and keep the code
 * in the message so a search still finds it.
 */
const SLACK_ERRORS: Record<string, string> = {
  not_in_channel: '봇이 채널에 없습니다. 채널에서 `/invite` 로 앱을 초대하세요.',
  channel_not_found: '채널을 찾지 못했습니다. `.env` 의 `SLACK_CHANNEL_ID` 를 확인하세요.',
  not_allowed_token_type: '이 작업에는 다른 토큰이 필요합니다. 사용자 토큰(`SLACK_USER_TOKEN`)을 넣었는지 확인하세요.',
  invalid_auth: '토큰이 더 이상 유효하지 않습니다. 앱을 재설치하고 `.env` 의 토큰을 갱신하세요.',
  account_inactive: '앱이 비활성 상태입니다. 워크스페이스에 다시 설치하세요.',
  token_revoked: '토큰이 취소되었습니다. 앱을 재설치하고 `.env` 를 갱신하세요.',
  ratelimited: 'Slack이 요청 속도를 제한했습니다. 잠시 후 다시 시도하세요.',
  thread_not_found: '스레드가 이미 사라졌습니다.',
  message_not_found: '메시지가 이미 지워졌습니다.',
  cant_delete_message: 'Slack이 이 메시지는 지울 수 없게 막고 있습니다(채널 참여 알림 등).',
  is_archived: '채널이 보관 처리되어 있습니다.',
  msg_too_long: '메시지가 Slack 한도를 넘었습니다.',
}

const TMUX_ERRORS: Array<{ match: RegExp; text: string }> = [
  { match: /can't find session|no server running/i, text: 'tmux 세션이 없습니다. 브로커를 다시 띄워 보세요.' },
  { match: /can't find pane|pane not found/i, text: '이 세션의 tmux 창이 이미 닫혔습니다.' },
  { match: /duplicate session/i, text: '같은 이름의 tmux 세션이 이미 있습니다.' },
]

function errorCode(err: unknown): string | undefined {
  const data = (err as { data?: { error?: unknown } } | undefined)?.data
  return typeof data?.error === 'string' ? data.error : undefined
}

/** Whether a pid still names a running process (POSIX: signal 0 is a no-op existence check, no permission needed on the same user's own process). */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function describeError(err: unknown): string {
  const code = errorCode(err)
  if (code) {
    const needed = (err as { data?: { needed?: unknown } }).data?.needed
    if (code === 'missing_scope') {
      return `앱에 권한이 부족합니다${needed ? ` (\`${String(needed)}\` 필요)` : ''}. Slack 앱 설정에서 스코프를 추가하고 재설치하세요.`
    }
    const known = SLACK_ERRORS[code]
    return known ? `${known} (\`${code}\`)` : `Slack 오류 \`${code}\``
  }
  const e = err as { code?: unknown; stderr?: unknown; message?: unknown }
  const stderr = typeof e?.stderr === 'string' ? e.stderr.trim() : ''
  for (const { match, text } of TMUX_ERRORS) {
    if (match.test(stderr)) return `${text} (\`${firstLine(stderr)}\`)`
  }
  if (e?.code === 'ENOENT') return 'tmux 를 찾지 못했습니다. 설치되어 있는지 확인하세요. (`ENOENT`)'
  if (e?.code === 'EACCES') return '권한이 없어 실행하지 못했습니다. (`EACCES`)'
  if (stderr) return truncate(firstLine(stderr), 200)
  return truncate(firstLine(String(e?.message ?? err)), 200)
}

export interface Todo {
  content: string
  activeForm?: string
  status: 'pending' | 'in_progress' | 'completed' | string
}

export function parseTodos(input: unknown): Todo[] {
  const raw = (input as { todos?: unknown } | undefined)?.todos
  if (!Array.isArray(raw)) return []
  return raw
    .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
    .map((t) => ({ content: String(t.content ?? ''), activeForm: t.activeForm ? String(t.activeForm) : undefined, status: String(t.status ?? 'pending') }))
    .filter((t) => t.content)
}

/**
 * The plan as a checklist, kept in one message that is edited as work proceeds.
 * A long task otherwise shows only its newest tool call, which says what is
 * happening but not how much is left.
 */
export function todoList(todos: Todo[]): string {
  if (!todos.length) return ''
  const done = todos.filter((t) => t.status === 'completed').length
  const lines = todos.map((t) => {
    if (t.status === 'completed') return `✅ ~${toMrkdwn(t.content)}~`
    if (t.status === 'in_progress') return `🔵 *${toMrkdwn(t.activeForm ?? t.content)}*`
    return `⬜ ${toMrkdwn(t.content)}`
  })
  return `📋 *할 일 ${done}/${todos.length}*\n${lines.join('\n')}`
}

/**
 * Context usage as Claude Code prints it in the status line or `/context`
 * output, e.g. "37% (74k/200k)" or "Context left: 63%". Returns the share used.
 */
export function detectContextUsage(screen: string): { percent: number; label: string } | null {
  // "left"/"remaining" first: it also matches the generic "N%" pattern, and
  // reading 63% remaining as 63% used would report the opposite of the truth.
  const left = /context\s+(?:left|remaining|남음)[^\d]{0,10}(\d{1,3})\s*%/i.exec(screen)
  if (left) {
    const remaining = Number(left[1])
    if (remaining >= 0 && remaining <= 100) return { percent: 100 - remaining, label: `${100 - remaining}%` }
  }
  const used = /context[^\n]*?(\d{1,3})\s*%\s*(?:used|사용)?/i.exec(screen) ?? /(\d{1,3})\s*%\s*(?:of\s+)?context/i.exec(screen)
  if (used) {
    const percent = Number(used[1])
    if (percent >= 0 && percent <= 100) return { percent, label: `${percent}%` }
  }
  // "74k/200k tokens"
  const ratio = /(\d+(?:\.\d+)?)k\s*\/\s*(\d+(?:\.\d+)?)k/i.exec(screen)
  if (ratio) {
    const [a, b] = [Number(ratio[1]), Number(ratio[2])]
    if (b > 0) return { percent: Math.round((a / b) * 100), label: `${ratio[1]}k/${ratio[2]}k` }
  }
  return null
}

/**
 * Turn a TUI's aligned output into rows.
 *
 * `/context` and `/usage` print columns padded with spaces, which reads fine in
 * a terminal and terribly in a chat client. Two or more spaces separate columns;
 * anything that does not come out rectangular is left alone for the caller to
 * show as text.
 */
export function parseColumns(text: string, minRows = 2): string[][] | null {
  const rows = text
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim())
    .map((l) => l.trim().split(/\s{2,}/).map((c) => c.trim()))
    .filter((cells) => cells.length >= 2)
  if (rows.length < minRows) return null
  // A real table is rectangular. Prose that happens to contain a double space
  // splits into a different number of pieces per line, so requiring every row to
  // agree keeps paragraphs out of the table renderer.
  const width = rows[0]!.length
  if (rows.some((r) => r.length !== width)) return null
  return rows
}

/** A Block Kit table. Cells are plain text; the terminal's own alignment is dropped. */
export function tableBlock(rows: string[][]): unknown {
  return {
    type: 'table',
    rows: rows.map((cells) => cells.map((text) => ({ type: 'raw_text', text: text || ' ' }))),
    column_settings: rows[0]?.map((_, i) => ({ align: i === 0 ? 'left' : 'right', is_wrapped: i === 0 })),
  }
}

/**
 * The same checklist as a Slack plan block: a titled list of task cards the
 * client renders with its agent styling. Returns null for an empty plan so the
 * caller can skip the block and keep the text form as a fallback.
 */
export function todoPlanBlock(todos: Todo[]): unknown | null {
  if (!todos.length) return null
  const done = todos.filter((t) => t.status === 'completed').length
  return {
    type: 'plan',
    title: `할 일 ${done}/${todos.length}`,
    tasks: todos.map((t, i) => ({
      type: 'task_card',
      task_id: `todo_${i}`,
      title: truncate(t.status === 'in_progress' ? (t.activeForm ?? t.content) : t.content, 200),
      status: t.status === 'completed' ? 'complete' : t.status === 'in_progress' ? 'in_progress' : 'pending',
    })),
  }
}

/** A notice in Slack's own alert styling. The text is plain, not mrkdwn. */
export function alertBlock(text: string, level: 'info' | 'warning' | 'error' | 'success' = 'info'): unknown {
  return { type: 'alert', level, text: { type: 'plain_text', text: truncate(text, 900), emoji: true } }
}

/**
 * A person's message as Claude Code recorded it vs. what was sent: a multi-line paste comes back wrapped in
 * <pasted_content …>…</pasted_content>, and spacing may differ. Compared raw, the same message looked new and
 * was shown again as typed in the terminal.
 */
export function normalizeMessage(text: string): string {
  return text
    .replace(/<\/?pasted_content\b[^>]*>/g, '')
    // Claude Code's own `[Image #N]` placeholder, and our `[Image attached: <path>]`/`[File attached: <path>]`
    // marker (REQ-F-014): a message with an attachment reads differently by the time it echoes back, which
    // without this made the same message look like two different ones (held then re-sent, or mirrored twice).
    .replace(/\[Image #\d+\]/g, '')
    .replace(/\[(?:Image|File) attached: [^\]]+\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}
export function sameMessage(a: string, b: string): boolean {
  return normalizeMessage(a) === normalizeMessage(b)
}

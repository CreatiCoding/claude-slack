import { basename } from 'node:path'
import { shortenHome, truncate } from './format.ts'
import { ACTION, encodeAnswer, encodeResume, encodeValue, panelBlockId, questionBlockId, renderActionId, type ActionBase } from './actions.ts'

export const MODEL_OPTIONS: Array<{ label: string; value: string }> = [
  { label: 'Fable 5.1 (1M)', value: 'claude-fable-5-1[1m]' },
  { label: 'Fable 5.1', value: 'claude-fable-5-1' },
  { label: 'Opus 5', value: 'claude-opus-5' },
  { label: 'Sonnet 5', value: 'claude-sonnet-5' },
  { label: 'Haiku 4.5', value: 'claude-haiku-4-5-20251001' },
  { label: 'Opus plan / Sonnet work', value: 'opusplan' },
  { label: 'Default', value: 'default' },
]
export const EFFORT_OPTIONS = ['low', 'medium', 'high', 'xhigh', 'max']
/** Permission modes reachable with shift+tab, in the order Claude Code cycles them. */
export const PERMISSION_MODES: Array<{ value: string; label: string }> = [
  { value: 'default', label: 'manual · 편집·명령마다 물어봄' },
  { value: 'acceptEdits', label: 'acceptEdits · 파일 편집은 자동 승인' },
  { value: 'plan', label: 'plan · 계획만 세우고 실행 안 함' },
  { value: 'auto', label: 'auto · 거의 모두 자동 승인' },
  // Not a Claude Code mode: the broker answers the permission requests itself (42, 전부 허용).
  { value: 'autoAllow', label: '전부 허용 · 권한 요청을 브로커가 허용' },
]

/** Slack's per-actions-block element limit, minus room for the multi-select confirm button. */
const MAX_OPTIONS = 20

const opt = (text: string, value: string) => ({ text: { type: 'plain_text', text, emoji: true }, value })
/** action_id must be unique within a message; `renderActionId` handles that and the broker matches the base. */
const btn = (text: string, base: ActionBase, value: string, style?: 'primary' | 'danger') => ({
  type: 'button',
  text: { type: 'plain_text', text, emoji: true },
  action_id: renderActionId(base, value),
  value,
  ...(style ? { style } : {}),
})

export type SessionState = 'starting' | 'idle' | 'busy' | 'waiting' | 'ended'
/** What purge deletes: only the bot's messages, or the user's own too (needs SLACK_USER_TOKEN). */
export type PurgeScope = 'bot' | 'all'
export const purgeNote = (scope: PurgeScope) => (scope === 'all' ? '내가 쓴 메시지도 같이 지웁니다.' : '내가 쓴 메시지는 남습니다.')

export interface PanelState {
  pid: number
  cwd: string
  title?: string
  origin: 'terminal' | 'slack'
  hasPane: boolean
  window?: string
  model?: string
  effort?: string
  permissionMode?: string
  /** 전부 허용 is on (42): the mode radio shows its own choice. */
  autoAllow?: boolean
  state: SessionState
  purgeScope?: PurgeScope
}

const STATE_LABEL: Record<SessionState, string> = {
  starting: '🚀 시작 중',
  idle: '🟢 대기 중',
  busy: '🔵 작업 중',
  waiting: '🟡 응답 필요',
  ended: '⚫ 종료됨',
}

/**
 * The per-session status + control message. Kept deliberately small because
 * Slack mobile stacks every button vertically: one status line, one settings
 * button, one overflow menu. Everything else lives in the settings modal.
 */
export function controlPanel(s: PanelState): { text: string; blocks: unknown[] } {
  const name = s.title ? `${basename(s.cwd)} · ${s.title}` : basename(s.cwd)
  const line1 = `${STATE_LABEL[s.state]} · *${truncate(name, 70)}*`
  const line2 = [
    `\`${shortenHome(s.cwd)}\``,
    s.model ? `\`${shortModel(s.model)}\`` : '',
    s.effort ? `effort \`${s.effort}\`` : '',
    s.permissionMode ? `권한 \`${s.permissionMode}\`` : '',
    s.window ? `tmux \`${s.window}\`` : '',
  ]
    .filter(Boolean)
    .join(' · ')
  const header = { type: 'section', text: { type: 'mrkdwn', text: `${line1}\n${line2}` } }
  const text = `${STATE_LABEL[s.state]} · ${name}`
  if (s.state === 'starting') return { text, blocks: [header] }
  if (s.state === 'ended') {
    return {
      text,
      blocks: [
        header,
        { type: 'actions', block_id: panelBlockId(s.pid, true), elements: [btn('🗑 Slack에서 지우기', ACTION.ctlPurge, encodeValue(s.pid, 'confirm purge'))] },
        { type: 'context', elements: [{ type: 'mrkdwn', text: `지우기 전에 스레드 전체를 서버(\`~/.claude-slack/sessions\`)에 보관합니다. ${purgeNote(s.purgeScope ?? 'bot')}` }] },
      ],
    }
  }
  if (!s.hasPane) {
    return { text, blocks: [header, { type: 'context', elements: [{ type: 'mrkdwn', text: 'tmux 밖 세션: 메시지와 권한 응답만 됩니다.' }] }] }
  }
  const v = (cmd: string) => `${s.pid}:${cmd}`
  return {
    text,
    blocks: [
      header,
      {
        type: 'actions',
        block_id: panelBlockId(s.pid),
        elements: [
          btn('⚙️ 설정', ACTION.ctlSettings, v('settings')),
          {
            type: 'overflow',
            action_id: ACTION.ctlMore,
            options: [
              opt('🖥 터미널 화면 보기', v('screen')),
              opt('🔄 세션 새로고침 (스킬·플러그인 반영)', v('confirm refresh')),
              opt('📦 컨텍스트 압축 (/compact)', v('confirm compact')),
              opt('⚫ 세션 종료', v('confirm exit')),
              opt('🗑 종료하고 Slack에서 지우기', v('confirm purge')),
            ],
          },
        ],
      },
    ],
  }
}

export const SETTINGS_VIEW_ID = 'cs_settings'
/** Settings modal: radios render well on mobile, unlike inline selects. */
export function settingsModal(s: PanelState): unknown {
  const radio = (actionId: string, options: Array<{ label: string; value: string }>, current?: string) => ({
    type: 'radio_buttons',
    action_id: actionId,
    options: options.map((o) => opt(o.label, o.value)),
    ...(current && options.some((o) => o.value === current) ? { initial_option: opt(options.find((o) => o.value === current)!.label, current) } : {}),
  })
  return {
    type: 'modal',
    callback_id: SETTINGS_VIEW_ID,
    private_metadata: String(s.pid),
    title: { type: 'plain_text', text: '세션 설정' },
    submit: { type: 'plain_text', text: '적용' },
    close: { type: 'plain_text', text: '취소' },
    blocks: [
      { type: 'context', elements: [{ type: 'mrkdwn', text: `*${basename(s.cwd)}* · \`${shortenHome(s.cwd)}\` · 바꾼 값은 터미널과 같이 새 세션 기본값으로도 저장됩니다.` }] },
      { type: 'input', block_id: 'model', optional: true, label: { type: 'plain_text', text: '모델' }, element: radio('model', MODEL_OPTIONS, s.model) },
      { type: 'input', block_id: 'effort', optional: true, label: { type: 'plain_text', text: 'effort' }, element: radio('effort', EFFORT_OPTIONS.map((e) => ({ label: e, value: e })), s.effort) },
      {
        type: 'input',
        block_id: 'mode',
        optional: true,
        label: { type: 'plain_text', text: '권한 모드 (도구 사용 시 얼마나 물어볼지)' },
        element: radio('mode', PERMISSION_MODES, s.autoAllow ? 'autoAllow' : s.permissionMode),
      },
    ],
  }
}

/** Ephemeral confirmation for destructive commands. */
export function confirmBlocks(pid: number, cmd: string, purgeScope: PurgeScope = 'bot'): { text: string; blocks: unknown[] } {
  const label: Record<string, string> = {
    exit: '세션을 종료할까요? (/exit)',
    clear: '대화를 초기화할까요? (/clear)',
    compact: '컨텍스트를 압축할까요? (/compact)',
    refresh: '세션을 다시 열까요? 대화는 그대로 이어지고, 새로 설치한 스킬·플러그인·MCP가 반영됩니다.',
    purge: `이 스레드를 서버에 보관한 뒤 Slack에서 지울까요? ${purgeNote(purgeScope)}`,
  }
  const text = label[cmd] ?? `${cmd} 실행할까요?`
  return {
    text,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `*${text}*` } },
      { type: 'actions', elements: [btn('확인', ACTION.ctlConfirm, encodeValue(pid, cmd), cmd === 'exit' || cmd === 'purge' ? 'danger' : 'primary')] },
    ],
  }
}

/** Replace a dialog's buttons with the chosen answer. */
export function answeredBlocks(summary: string): { text: string; blocks: unknown[] } {
  return { text: summary, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: summary } }] }
}

/**
 * Replace one question's buttons with the choice, leaving every other block
 * alone. AskUserQuestion often asks several things at once, and collapsing the
 * whole message on the first answer takes the remaining questions away with it.
 * Returns null when the block is not there, so the caller can fall back.
 */
export function markAnswered(blocks: unknown[], blockId: string, summary: string): unknown[] | null {
  const list = blocks as Array<{ type?: string; block_id?: string }>
  if (!list.some((b) => b.block_id === blockId)) return null
  return list.map((b) => (b.block_id === blockId ? { type: 'context', block_id: blockId, elements: [{ type: 'mrkdwn', text: summary }] } : b))
}

export function shortModel(m?: string): string {
  if (!m) return '?'
  return m.replace(/^claude-/, '').replace(/-\d{8}$/, '')
}

/** Ephemeral picker for `/ccresume`. */
export function resumePicker(sessions: Array<{ id: string; cwd: string; title: string; when: string }>): { text: string; blocks: unknown[] } {
  if (!sessions.length) return { text: '재개할 세션이 없습니다.', blocks: [] }
  return {
    text: '재개할 세션을 고르세요',
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '*재개할 세션을 고르세요* (최근 순)' },
        accessory: {
          type: 'static_select',
          action_id: ACTION.ctlResume,
          placeholder: { type: 'plain_text', text: '세션 선택', emoji: true },
          options: sessions.slice(0, 25).map((s) => opt(truncate(`${s.when} · ${basename(s.cwd)} · ${s.title}`, 75), encodeResume(s.id, s.cwd))),
        },
      },
    ],
  }
}

export function refreshPicker(sessions: Array<{ pid: number; cwd: string; title?: string }>): unknown[] {
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '*새로고침할 세션을 고르세요* (프로세스를 종료하고 같은 대화로 다시 엽니다)' },
      accessory: {
        type: 'static_select',
        action_id: renderActionId(ACTION.ctlMore, 'refresh'),
        placeholder: { type: 'plain_text', text: '세션 선택', emoji: true },
        options: sessions.slice(0, 25).map((s) => opt(truncate(s.title ? `${basename(s.cwd)} · ${s.title}` : basename(s.cwd), 75), encodeValue(s.pid, 'refresh'))),
      },
    },
  ]
}

export interface Question {
  question: string
  header?: string
  options?: Array<{ label: string; description?: string }>
  multiSelect?: boolean
}

/**
 * A terminal dialog with nothing numbered to press. There is no option list to
 * turn into buttons, so show what it says and offer the two keys it accepts.
 */
export function keyedDialogBlocks(pid: number, d: { question: string; body?: string; footer: string; options: string[]; selected: number }, mention?: string): { text: string; blocks: unknown[] } {
  const who = mention ? `<@${mention}> ` : ''
  const text = `${who}⌨️ *터미널이 입력을 기다립니다*\n${d.question}`
  // One button per choice line, not just the one the cursor happens to sit on: moving there is
  // `dlgkey to <label>` (↑/↓ the cursor to the line with exactly that label, then Enter), handled as its own command so it can fold
  // the card and clear the wait, which a raw `:key` press never did.
  const moveButtons = d.options.slice(0, 5).map((label, i) =>
    btn(truncate(label, 75), ACTION.dlgKey, encodeValue(pid, `dlgkey to ${label}`), i === d.selected ? 'primary' : undefined),
  )
  return {
    text,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `${who}⌨️ *터미널이 입력을 기다립니다*\n${truncate(d.question, 500)}` } },
      ...(d.body ? [{ type: 'section', text: { type: 'mrkdwn', text: '```' + truncate(d.body, 1500) + '```' } }] : []),
      { type: 'context', elements: [{ type: 'mrkdwn', text: truncate(d.footer, 300) }] },
      {
        type: 'actions',
        // Esc sends just the key (`dlgkey esc`), not the `:esc` command — `:esc` means "stop the running
        // turn", which this dialog usually is not.
        elements: [...moveButtons, btn('Esc로 취소', ACTION.dlgKey, encodeValue(pid, 'dlgkey esc'))],
      },
    ],
  }
}

/**
 * Messages held while a tool call runs, with the two things a person can do
 * about it. Edited in place as the batch grows; deleted once delivered.
 */
export function heldNoticeBlocks(pid: number, count: number): { text: string; blocks: unknown[] } {
  const text = `🕓 메시지 ${count}개를 붙잡고 있습니다. 실행 중인 도구가 끝나면 전달합니다.`
  return {
    text,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `${text}\n_지금 보내면 실행 중인 작업을 끊고 바로 전달합니다 (터미널의 Ctrl+Enter)._` } },
      {
        type: 'actions',
        block_id: `held_${pid}`,
        elements: [btn('⚡ 지금 보내기', ACTION.ctlBtn, encodeValue(pid, 'sendnow'), 'primary'), btn('취소', ACTION.ctlBtn, encodeValue(pid, 'dropheld'))],
      },
    ],
  }
}

/** A stuck state, said plainly, with the one button that resolves it. */
export function stuckBlocks(pid: number, o: { text: string; actions: Array<'continue' | 'screen'>; mention?: string }): { text: string; blocks: unknown[] } {
  const who = o.mention ? `<@${o.mention}> ` : ''
  const text = `${who}⏸️ ${o.text}`
  const elements = o.actions.map((a) => (a === 'continue' ? btn('▶️ 계속해', ACTION.ctlBtn, encodeValue(pid, 'continue'), 'primary') : btn('🖥 화면', ACTION.ctlBtn, encodeValue(pid, 'screen'))))
  return {
    text,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }, ...(elements.length ? [{ type: 'actions', block_id: `stuck_${pid}`, elements }] : [])],
  }
}

/** A trailing ```choices block (22): one button per choice, pressed in place of typing it. */
export function choiceBlocks(pid: number, choices: string[], mention?: string): { text: string; blocks: unknown[] } {
  const text = `${mention ? `<@${mention}> ` : ''}🔘 ${choices.join(' · ')}`
  return {
    text,
    blocks: [{ type: 'actions', block_id: `choice_${pid}`, elements: choices.map((c, i) => btn(truncate(c, 75), ACTION.ctlBtn, encodeValue(pid, `choice ${i}`))) }],
  }
}

/** AskUserQuestion rendered as one button row per question. */
export function questionBlocks(pid: number, questions: Question[], intro?: string, mention?: string): { text: string; blocks: unknown[] } {
  const who = mention ? `<@${mention}> ` : ''
  const blocks: unknown[] = [{ type: 'section', text: { type: 'mrkdwn', text: `${who}❓ *Claude가 선택을 기다립니다*` } }]
  // A code box (what a terminal dialog is about) is kept whole in a section; a short note stays small.
  if (intro) blocks.push(intro.includes('```') ? { type: 'section', text: { type: 'mrkdwn', text: intro.slice(0, 2900) } } : { type: 'context', elements: [{ type: 'mrkdwn', text: truncate(intro, 500) }] })
  questions.forEach((q, qi) => {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*${q.header ? `[${q.header}] ` : ''}${truncate(q.question, 500)}*${q.multiSelect ? ' _(복수 선택: 번호를 차례로 누른 뒤 확정)_' : ''}` } })
    // Slack allows 25 elements in an actions block. Cutting the list silently
    // makes the last options unreachable, which is worse than a long column.
    const opts = (q.options ?? []).slice(0, MAX_OPTIONS)
    if (opts.length) {
      blocks.push({
        type: 'actions',
        block_id: questionBlockId(pid, qi),
        elements: [
          ...opts.map((o, oi) => btn(truncate(`${oi + 1}. ${o.label}`, 75), ACTION.dlgAnswer, encodeAnswer(pid, qi, oi + 1, truncate(o.label, 60)))),
          ...(q.multiSelect ? [btn('확정 (Enter)', ACTION.dlgAnswer, encodeValue(pid, 'key Enter'), 'primary')] : []),
        ],
      })
      const desc = opts.filter((o) => o.description).map((o, i) => `${i + 1}. ${o.description}`).join(' · ')
      if (desc) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: truncate(desc, 300) }] })
    }
  })
  const dropped = questions.reduce((n, q) => n + Math.max(0, (q.options?.length ?? 0) - MAX_OPTIONS), 0)
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `직접 입력하려면 \`:type 내용\` 뒤 \`:key Enter\`. 번호로 답하려면 \`:answer 3\`.${dropped ? ` 선택지 ${dropped}개는 너무 많아 생략했습니다 — \`:screen\` 으로 확인하세요.` : ''}` }],
  })
  return { text: `${who}❓ Claude가 선택을 기다립니다`, blocks }
}

/** ExitPlanMode approval dialog. Options follow Claude Code's numbering. */
/** Slack rejects a section whose text exceeds this; a long plan is split across several sections instead. */
const PLAN_SECTION_MAX = 2900

export function planApprovalBlocks(pid: number, mention?: string, plan?: string): { text: string; blocks: unknown[] } {
  const who = mention ? `<@${mention}> ` : ''
  const intro = plan ? '📋 *플랜 승인을 기다립니다.*' : '📋 *플랜 승인을 기다립니다.* 위에 스트리밍된 내용이 플랜입니다.'
  // Carrying the plan's own text on the card (not just relying on what streamed above it) means the card
  // still says what it is asking about even if the stream was summary-only or scrolled out of view.
  const planChunks: string[] = []
  for (let i = 0; plan && i < plan.length; i += PLAN_SECTION_MAX) planChunks.push(plan.slice(i, i + PLAN_SECTION_MAX))
  return {
    text: `${who}📋 플랜 승인을 기다립니다`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `${who}${intro}` } },
      ...planChunks.map((chunk) => ({ type: 'section', text: { type: 'mrkdwn', text: chunk } })),
      {
        type: 'actions',
        block_id: `dlg_plan_${pid}`,
        elements: [
          btn('✅ 승인 · 편집 자동 승인', ACTION.dlgAnswer, encodeAnswer(pid, 0, 1, '승인 (편집 자동 승인)'), 'primary'),
          btn('✅ 승인 · 편집 수동 승인', ACTION.dlgAnswer, encodeAnswer(pid, 0, 2, '승인 (편집 수동 승인)')),
          btn('✏️ 아니오 · 계속 계획', ACTION.dlgAnswer, encodeAnswer(pid, 0, 3, '계속 계획')),
          btn('🖥 화면', ACTION.ctlBtn, encodeValue(pid, 'screen')),
        ],
      },
    ],
  }
}

/** Channel-level entry point: a message with a "new session" button. */
export const NEW_SESSION_BLOCK_ID = 'cs_new_session_entry'
export function newSessionEntry(): { text: string; blocks: unknown[] } {
  return {
    text: '🆕 새 Claude Code 세션 시작',
    blocks: [
      {
        type: 'section',
        block_id: NEW_SESSION_BLOCK_ID,
        text: { type: 'mrkdwn', text: '*Claude Code* · 이 채널에 새 메시지를 쓰면 세션이 시작됩니다. 폴더를 고르고 시작하려면 →' },
        accessory: btn('🆕 새 세션', ACTION.ctlNew, 'new', 'primary'),
      },
      { type: 'context', elements: [{ type: 'mrkdwn', text: '`/ccnew <경로> <프롬프트>` · `/ccresume` 이전 세션 재개 · `/cclist` 실행 중 세션 · `/cchelp`' }] },
    ],
  }
}

export const NEW_SESSION_VIEW_ID = 'cs_new_session'
export function newSessionModal(dirs: Array<{ label: string; value: string }>): unknown {
  return {
    type: 'modal',
    callback_id: NEW_SESSION_VIEW_ID,
    title: { type: 'plain_text', text: '새 Claude Code 세션' },
    submit: { type: 'plain_text', text: '시작' },
    close: { type: 'plain_text', text: '취소' },
    blocks: [
      {
        type: 'input',
        block_id: 'dir',
        optional: true,
        label: { type: 'plain_text', text: '프로젝트 폴더' },
        element: {
          type: 'static_select',
          action_id: 'dir',
          placeholder: { type: 'plain_text', text: '폴더 선택' },
          options: dirs.slice(0, 100).map((d) => opt(d.label, d.value)),
        },
      },
      {
        type: 'input',
        block_id: 'dir_custom',
        optional: true,
        label: { type: 'plain_text', text: '또는 경로 직접 입력' },
        element: { type: 'plain_text_input', action_id: 'dir_custom', placeholder: { type: 'plain_text', text: '~/projects/foo' } },
      },
      {
        type: 'input',
        block_id: 'prompt',
        optional: true,
        label: { type: 'plain_text', text: '첫 프롬프트' },
        element: { type: 'plain_text_input', action_id: 'prompt', multiline: true, placeholder: { type: 'plain_text', text: '비워 두면 세션만 띄웁니다' } },
      },
      {
        type: 'input',
        block_id: 'model',
        optional: true,
        label: { type: 'plain_text', text: '모델' },
        element: { type: 'static_select', action_id: 'model', placeholder: { type: 'plain_text', text: '기본값' }, options: MODEL_OPTIONS.map((m) => opt(m.label, m.value)) },
      },
      {
        type: 'input',
        block_id: 'effort',
        optional: true,
        label: { type: 'plain_text', text: 'effort' },
        element: { type: 'static_select', action_id: 'effort', placeholder: { type: 'plain_text', text: '기본값' }, options: EFFORT_OPTIONS.map((e) => opt(e, e)) },
      },
    ],
  }
}

/**
 * What "항상 허용" would record, as Claude Code writes its allow rules: the tool
 * plus, for Bash, the command's first word or two. Best effort — the terminal
 * dialog is the authority — but it lets the reader see that "항상" on
 * `git push origin main` means every `git push`, before pressing it.
 */
export function alwaysRulePreview(toolName: string, input: unknown): string | undefined {
  const i = (input ?? {}) as Record<string, unknown>
  if (toolName === 'Bash') {
    const cmd = String(i.command ?? '').trim()
    if (!cmd || /[|;&`$]|\n/.test(cmd)) return undefined
    const words = cmd.split(/\s+/)
    const sub = words[1] && !/^-/.test(words[1]) && /^(git|npm|yarn|pnpm|docker|kubectl|gh|make|cargo|go|pip|brew)$/.test(words[0]!) ? ` ${words[1]}` : ''
    return `Bash(${words[0]}${sub}:*)`
  }
  if (toolName === 'Edit' || toolName === 'Write' || toolName === 'Read') return `${toolName}(${String(i.file_path ?? '…')})`
  if (toolName === 'WebFetch') {
    try {
      return `WebFetch(domain:${new URL(String(i.url)).host})`
    } catch {
      return undefined
    }
  }
  return toolName.startsWith('mcp__') ? toolName : undefined
}

/**
 * The change a permission card is really asking about. Edit shows the
 * replaced lines as a diff, Write its opening, Bash the whole command. The
 * relay's one-line preview is kept for everything else.
 */
export function permissionDetail(toolName: string, input: unknown, fallback: string): string {
  const i = (input ?? {}) as Record<string, unknown>
  const fence = (lang: string, body: string) => '```' + lang + '\n' + truncate(body.replace(/```/g, "'''"), 2400) + '\n```'
  if (toolName === 'Edit' && typeof i.old_string === 'string') {
    const minus = i.old_string.split('\n').map((l) => `- ${l}`)
    const plus = String(i.new_string ?? '').split('\n').map((l) => `+ ${l}`)
    return `\`${String(i.file_path ?? '')}\`${i.replace_all ? ' _(모두 바꾸기)_' : ''}\n` + fence('diff', [...minus, ...plus].join('\n'))
  }
  if (toolName === 'Write' && typeof i.content === 'string') {
    const lines = i.content.split('\n')
    const head = lines.slice(0, 20).join('\n')
    return `\`${String(i.file_path ?? '')}\` · ${lines.length}줄${lines.length > 20 ? ' (앞 20줄)' : ''}\n` + fence('', head)
  }
  if (toolName === 'Bash' && typeof i.command === 'string') return fence('bash', i.command)
  return fallback ? fence('', fallback) : ''
}

/** Permission prompt with allow / always / deny. */
export function permissionBlocksV2(o: { pid: number; requestId: string; toolName: string; description: string; inputPreview: string; hasPane: boolean; mention?: string; toolInput?: unknown }): { text: string; blocks: unknown[] } {
  const value = `${o.pid}:${o.requestId}`
  const detail = o.toolInput !== undefined ? permissionDetail(o.toolName, o.toolInput, o.inputPreview) : o.inputPreview ? '```' + truncate(o.inputPreview, 2500) + '```' : ''
  const rule = o.toolInput !== undefined ? alwaysRulePreview(o.toolName, o.toolInput) : undefined
  const who = o.mention ? `<@${o.mention}> ` : ''
  return {
    text: `${who}🔐 권한 요청 · ${o.toolName} · ${o.requestId}`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `${who}🔐 *${o.toolName}* 권한 요청 · \`${o.requestId}\`\n${o.description}` } },
      ...(detail ? [{ type: 'section', text: { type: 'mrkdwn', text: detail } }] : []),
      ...(rule && o.hasPane ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: `항상 허용을 누르면 \`${rule}\` 규칙이 기록됩니다 (예상)` }] }] : []),
      {
        type: 'actions',
        block_id: `perm_${o.pid}_${o.requestId}`,
        elements: [
          btn('허용', ACTION.permAllow, value, 'primary'),
          ...(o.hasPane ? [btn('항상 허용', ACTION.permAlways, value)] : []),
          btn('거부', ACTION.permDeny, value, 'danger'),
        ],
      },
    ],
  }
}

export interface HomeLiveSession {
  pid: number
  cwd: string
  title?: string
  state: SessionState
  model?: string
  link?: string
  /** Set while the session waits on a person: what for, and since when. */
  waiting?: string
}

/**
 * The Home tab: what is running right now, and one tap to start or resume.
 * The channel only shows threads, so without this there is no place that
 * answers "what do I have going" at a glance. Sessions that need a person come
 * first, and the filter narrows the list to just those.
 */
export function homeView(o: { live: HomeLiveSession[]; recent: Array<{ id: string; cwd: string; title: string; when: string }>; archived: number; channelId: string; filter?: 'all' | 'attention' }): unknown {
  const filter = o.filter ?? 'all'
  const attention = o.live.filter((s) => s.state === 'waiting')
  const shown = filter === 'attention' ? attention : [...attention, ...o.live.filter((s) => s.state !== 'waiting')]
  const blocks: unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: 'Claude Code', emoji: true } },
    {
      type: 'actions',
      block_id: 'home_actions',
      elements: [
        btn('🆕 새 세션', ACTION.ctlNew, 'new', 'primary'),
        btn(filter === 'attention' ? '👀 모두 보기' : `🟡 관심 필요만 (${attention.length})`, ACTION.ctlBtn, encodeValue(0, filter === 'attention' ? 'homefilter all' : 'homefilter attention')),
      ],
    },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `세션은 <#${o.channelId}> 의 스레드에서 진행됩니다.` }] },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: filter === 'attention' ? (attention.length ? `*응답이 필요한 세션 ${attention.length}개*` : '*응답이 필요한 세션이 없습니다*') : o.live.length ? `*실행 중 ${o.live.length}개*${attention.length ? ` · 🟡 ${attention.length}개가 응답을 기다림` : ''}` : '*실행 중인 세션이 없습니다*',
      },
    },
  ]

  for (const s of shown) {
    const name = s.title ? `${basename(s.cwd)} · ${s.title}` : basename(s.cwd)
    const meta = [`\`${shortenHome(s.cwd)}\``, s.model ? `\`${shortModel(s.model)}\`` : ''].filter(Boolean).join(' · ')
    const label = s.state === 'waiting' && s.waiting ? `🟡 ${s.waiting}` : STATE_LABEL[s.state]
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `${label} *${truncate(name, 70)}*\n${meta}` },
      ...(s.link ? { accessory: { type: 'button', action_id: renderActionId(ACTION.ctlOpen, String(s.pid)), text: { type: 'plain_text', text: '스레드 열기', emoji: true }, url: s.link } } : {}),
    })
  }

  if (o.recent.length) {
    blocks.push({ type: 'divider' }, { type: 'section', text: { type: 'mrkdwn', text: '*이어서 하기*' }, accessory: {
      type: 'static_select',
      action_id: ACTION.ctlResume,
      placeholder: { type: 'plain_text', text: '세션 선택', emoji: true },
      options: o.recent.slice(0, 25).map((r) => opt(truncate(`${r.when} · ${basename(r.cwd)} · ${r.title}`, 75), encodeResume(r.id, r.cwd))),
    } })
  }
  if (o.archived) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `보관된 세션 ${o.archived}개 · \`/cchistory\`` }] })
  }
  return { type: 'home', blocks }
}

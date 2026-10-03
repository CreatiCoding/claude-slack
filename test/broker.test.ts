import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { Broker, type BrokerConfig } from '../src/broker.ts'
import { connect, listen, type Conn } from '../src/ipc.ts'
import { slashCommandName, SLASH_COMMANDS, type SlackApi, type StreamChunk } from '../src/slack.ts'
import type { TmuxLike } from '../src/tmux.ts'
import { FakeSlack, FakeTmux, setup, shim, hook, tick, until, button, buttonWithValue, assistant, toolResult } from './helpers.ts'

test('terminal session: root message, injection, streamed turn, commands, end', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, { tmuxPane: '%3' })
  assert.match(t.slack.posts[0]!.text, /🟢 \*proj\*/)
  assert.equal(s.ack, t.slack.posts[0]!.ts)

  // A hook tells us where the transcript is.
  await hook(t.socketPath, 100, { hook_event_name: 'SessionStart', source: 'startup' }, t.transcript)

  await t.broker.handleSlackMessage({ user: 'U1', text: '테스트 돌려줘', ts: '9.1', threadTs: s.ack, channel: 'C1' })
  await tick()
  assert.deepEqual(s.inbox.at(-1), { type: 'inbound', text: '테스트 돌려줘', user: 'U1', ts: '9.1' })
  assert.ok(t.slack.reactions.includes('+eyes@9.1'))
  assert.equal(t.slack.statuses.at(-1), `processing@${s.ack}`)
  await until(() => /작업 중 · 중단하려면 `:esc`/.test(t.slack.updates.at(-1)?.text ?? ''), '루트 줄이 작업 중과 중단 방법을 말한다')

  // Claude works: text, tool call, tool result, final text land in the transcript.
  appendFileSync(t.transcript, assistant({ type: 'text', text: '테스트를 돌립니다.' }))
  appendFileSync(t.transcript, assistant({ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm test' } }))
  await tick(120)
  appendFileSync(t.transcript, toolResult('tu1', 'ok 3 tests'))
  appendFileSync(t.transcript, assistant({ type: 'text', text: '**다 됐어요**' }))
  await tick(120)
  await hook(t.socketPath, 100, { hook_event_name: 'Stop', last_assistant_message: '**다 됐어요**' })

  assert.equal(t.slack.streams.length, 1)
  const st = t.slack.streams[0]!
  assert.equal(st.recipient, 'U1')
  assert.ok(st.stopped)
  const kinds = st.chunks.map((c) => (c.type === 'task_update' ? `${c.type}:${c.status}` : c.type))
  assert.deepEqual(kinds, ['markdown_text', 'task_update:in_progress', 'task_update:complete', 'markdown_text'])
  assert.equal((st.chunks[1] as { title: string }).title, '⚙️ Bash npm test')
  assert.equal((st.chunks[2] as { output: string }).output, 'ok 3 tests')
  assert.ok(!t.slack.texts().includes('*다 됐어요*'), 'final text is streamed, not re-posted')
  assert.ok(t.slack.reactions.includes('+white_check_mark@9.1'))
  assert.equal(t.slack.statuses.at(-1), `active@${s.ack}`)

  // Channel injections fire UserPromptSubmit too, wrapped in <channel>; they must not be mirrored again.
  const before = t.slack.texts().length
  await hook(t.socketPath, 100, { hook_event_name: 'UserPromptSubmit', user_message: '<channel source="slack" user="U1" ts="9.1">\n테스트 돌려줘\n</channel>' })
  assert.equal(t.slack.texts().length, before)

  // A reply-tool message that Claude then repeats as its final text is mirrored once.
  s.conn.send({ type: 'reply', text: '같은 말' })
  await tick()
  appendFileSync(t.transcript, assistant({ type: 'text', text: '같은 말' }))
  await tick(120)
  assert.equal(t.slack.texts().filter((x) => x === '같은 말').length, 1)
  assert.ok(!t.slack.streams.some((st) => st.chunks.some((c) => c.type === 'markdown_text' && c.text === '같은 말')), 'not streamed again')

  // Double-tapped buttons are collapsed.
  const keysBefore = t.tmux.keys.length
  await t.broker.handleSlackMessage({ user: 'U1', text: ':esc', ts: '9.9', threadTs: s.ack, channel: 'C1' })
  await t.broker.handleAction({ user: 'U1', actionId: 'ctl_x', value: '100:esc', messageTs: 'm1', channel: 'C1' })
  await t.broker.handleAction({ user: 'U1', actionId: 'ctl_x', value: '100:esc', messageTs: 'm1', channel: 'C1' })
  assert.equal(t.tmux.keys.length - keysBefore, 2)

  // Terminal-typed prompts are mirrored and start a new turn.
  await hook(t.socketPath, 100, { hook_event_name: 'UserPromptSubmit', user_message: '터미널에서 친 것' })
  assert.ok(t.slack.texts().includes('⌨️ 터미널에서 친 것'))
  assert.equal(t.slack.statuses.at(-1), `processing@${s.ack}`)

  // ai-title renames the session.
  appendFileSync(t.transcript, JSON.stringify({ type: 'ai-title', aiTitle: '테스트 수정' }) + '\n')
  await tick(120)
  assert.deepEqual(t.slack.renames, ['테스트 수정'])
  assert.match(t.slack.updates.at(-1)!.text, /proj · 테스트 수정/)

  // Commands go to tmux.
  await t.broker.handleSlackMessage({ user: 'U1', text: ':esc', ts: '9.2', threadTs: s.ack, channel: 'C1' })
  assert.ok(t.tmux.keys.includes('%3:Escape'))
  await t.broker.handleSlackMessage({ user: 'U1', text: ':key Down Enter', ts: '9.3', threadTs: s.ack, channel: 'C1' })
  assert.ok(t.tmux.keys.includes('%3:Down Enter'))
  await t.broker.handleSlackMessage({ user: 'U1', text: ':screen', ts: '9.4', threadTs: s.ack, channel: 'C1' })
  assert.match(t.slack.texts().at(-1)!, /^```> hello/)
  await t.broker.handleSlackMessage({ user: 'U1', text: ':kill', ts: '9.5', threadTs: s.ack, channel: 'C1' })
  assert.ok(!t.tmux.keys.includes('%3:kill'), 'kill refused for terminal sessions')

  // Slack's native stop button is easy to hit by accident, so it explains `:esc` instead of interrupting.
  const escBefore = t.tmux.keys.filter((k) => k === '%3:Escape').length
  await t.broker.handleStop({ user: 'U1', threadTs: s.ack, channel: 'C1' })
  assert.equal(t.tmux.keys.filter((k) => k === '%3:Escape').length, escBefore, '버튼만으로는 중단되지 않는다')
  assert.match(t.slack.texts().at(-1)!, /:esc/)
  // Slack flipped its own indicator on the tap; the turn is still running, so put it back.
  assert.equal(t.slack.statuses.at(-1), `processing@${s.ack}`)

  s.conn.close()
  await tick()
  assert.ok(t.slack.updates.some((u) => /⚫ \*proj/.test(u.text)), 'root marked ended')
  assert.equal(t.slack.statuses.at(-1), `closed@${s.ack}`)
  t.close()
})

test('스트림이 닫힌 뒤 도착한 마지막 답변을 잃지 않는다 (턴이 마무리 없이 끝나 보였다)', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, {})
  await hook(t.socketPath, 100, { hook_event_name: 'SessionStart', source: 'startup' }, t.transcript)
  await t.broker.handleSlackMessage({ user: 'U1', text: 'go', ts: '1.1', threadTs: s.ack, channel: 'C1' })

  // Text mid-turn: the stream carries this one.
  appendFileSync(t.transcript, assistant({ type: 'text', text: '먼저 살펴보겠습니다.' }))
  await tick(120)

  // The answer only reaches the transcript after the turn is closed, so the
  // stream never renders it. The hook's copy is the only one left.
  await hook(t.socketPath, 100, { hook_event_name: 'Stop', last_assistant_message: '다 고쳤습니다. 배포됐습니다.' })
  const body = t.slack.posts.filter((p) => p.threadTs === s.ack).map((p) => p.text)
  assert.ok(body.includes('다 고쳤습니다. 배포됐습니다.'), `마지막 답변이 스레드에 남는다: ${body}`)

  s.conn.close()
  t.close()
})

test('이미 흘려보낸 답변은 다시 올리지 않는다', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, {})
  await hook(t.socketPath, 100, { hook_event_name: 'SessionStart', source: 'startup' }, t.transcript)
  await t.broker.handleSlackMessage({ user: 'U1', text: 'go', ts: '1.1', threadTs: s.ack, channel: 'C1' })
  appendFileSync(t.transcript, assistant({ type: 'text', text: '다 고쳤습니다.' }))
  await tick(120)
  await hook(t.socketPath, 100, { hook_event_name: 'Stop', last_assistant_message: '다 고쳤습니다.' })
  const posted = t.slack.posts.filter((p) => p.threadTs === s.ack && p.text === '다 고쳤습니다.')
  assert.equal(posted.length, 0, `스트림이 이미 실어 보냈으면 따로 올리지 않는다: ${t.slack.texts()}`)
  s.conn.close()
  t.close()
})

test('streaming unavailable falls back to an edited plain message', async () => {
  const t = await setup()
  t.slack.failStreaming = true
  const s = await shim(t.socketPath, {})
  await hook(t.socketPath, 100, { hook_event_name: 'SessionStart', source: 'startup' }, t.transcript)
  await t.broker.handleSlackMessage({ user: 'U1', text: 'go', ts: '1.1', threadTs: s.ack, channel: 'C1' })
  appendFileSync(t.transcript, assistant({ type: 'tool_use', id: 'tu1', name: 'Edit', input: { file_path: '/home/u/proj/a.ts' } }))
  await tick(120)
  appendFileSync(t.transcript, toolResult('tu1', 'edited'))
  appendFileSync(t.transcript, assistant({ type: 'text', text: '끝' }))
  await tick(120)
  await hook(t.socketPath, 100, { hook_event_name: 'Stop', last_assistant_message: '끝' })
  const body = t.slack.posts.filter((p) => p.threadTs === s.ack).map((p) => p.text)
  assert.ok(body.some((x) => x.startsWith('⏳ ✏️ Edit a.ts')), `first post: ${body}`)
  // The root line is edited too, so look at the fallback message rather than the newest edit.
  const plainEdits = () => t.slack.updates.filter((u) => u.ts !== s.ack).map((u) => u.text)
  await until(() => plainEdits().at(-1) === '✅ ✏️ Edit a.ts\n\n끝', `평문 대체 메시지 갱신 (마지막: ${JSON.stringify(plainEdits().at(-1))})`)
  s.conn.close()
  t.close()
})

test('이미지만 온 메시지는 빈 텍스트로 전달되지 않고, 다운로드한 경로가 실린다', async () => {
  const imagesDir = join(tmpdir(), `claude-slack-images-${Date.now()}`)
  process.env.CLAUDE_SLACK_IMAGES_DIR = imagesDir
  try {
    const t = await setup()
    const s = await shim(t.socketPath, {})
    await hook(t.socketPath, 100, { hook_event_name: 'SessionStart', source: 'startup' }, t.transcript)

    await t.broker.handleSlackMessage({
      user: 'U1',
      text: '',
      ts: '9.1',
      threadTs: s.ack,
      channel: 'C1',
      files: [{ url: 'https://files.slack.com/x/pic.png', mimetype: 'image/png', name: 'pic.png' }],
    })
    await tick()

    const sent = s.inbox.at(-1) as { type: 'inbound'; text: string }
    assert.notEqual(sent.text, '', '캡션이 없어도 빈 문자열이 전달되면 안 됨')
    assert.match(sent.text, /\[Image attached: .*pic\.png\]/)
    const path = /\[Image attached: (.*)\]/.exec(sent.text)![1]!
    assert.equal(readFileSync(path, 'utf8'), 'bytes-of:https://files.slack.com/x/pic.png')

    s.conn.close()
    t.close()
  } finally {
    delete process.env.CLAUDE_SLACK_IMAGES_DIR
  }
})

test('오래 걸리는 도구 호출 동안 스트림을 살려둔다 (Slack 이 닫으면 완료 표시를 잃는다)', async () => {
  const t = await setup({ heartbeatMs: 30 })
  const s = await shim(t.socketPath, {})
  await hook(t.socketPath, 100, { hook_event_name: 'SessionStart', source: 'startup' }, t.transcript)
  await t.broker.handleSlackMessage({ user: 'U1', text: 'go', ts: '1.1', threadTs: s.ack, channel: 'C1' })

  // A tool call starts and then says nothing for a while: the gap Slack closes the stream in.
  appendFileSync(t.transcript, assistant({ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'sleep 60\n' + 'echo hi\n'.repeat(20).trim() } }))
  await until(() => t.slack.streams.length === 1, '스트림 시작')
  const beats = () => t.slack.streams[0]!.chunks.filter((c) => c.type === 'task_update' && c.status === 'in_progress').length
  const before = beats()
  await tick(150)
  assert.ok(beats() > before, `진행 중인 동안 스트림을 두드려야 한다 (${before} → ${beats()})`)

  // When the result finally lands the stream is still open, so the task completes.
  appendFileSync(t.transcript, toolResult('tu1', 'done'))
  await until(
    () => t.slack.streams[0]!.chunks.some((c) => c.type === 'task_update' && c.status === 'complete'),
    '결과가 완료로 찍힌다',
  )

  // The summary stays short, but what it cut is carried along to expand into —
  // and a heartbeat must not strip it back to a bare title.
  const sent = t.slack.streams[0]!.chunks.filter((c) => c.type === 'task_update' && c.id === 'tu1')
  assert.ok(sent.length > 1, '두드림이 있었다')
  for (const c of sent) assert.equal((c as { details?: string }).details, 'sleep 60\n' + 'echo hi\n'.repeat(20).trim())

  // Once nothing is running the pinging stops, rather than beating for the life of the session.
  const idle = beats()
  await tick(150)
  assert.equal(beats(), idle, '할 일이 없으면 두드리지 않는다')

  s.conn.close()
  t.close()
})

test('permission requests render buttons, suspend the session, and verdicts flow back', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, {})
  s.conn.send({ type: 'permission_request', requestId: 'abcde', toolName: 'Bash', description: 'Run tests', inputPreview: '{"command":"npm test"}' })
  await tick()
  const prompt = t.slack.posts.at(-1)!
  assert.match(prompt.text, /권한 요청/)
  assert.ok(prompt.blocks)
  assert.equal(t.slack.statuses.at(-1), `suspended@${s.ack}`)

  // Slack delivers the rendered action_id (btn() adds a uniqueness suffix), not the base name.
  const allow = button(prompt.blocks, 'perm_allow')
  assert.notEqual(allow.actionId, 'perm_allow', 'action_id carries a suffix')
  await t.broker.handleAction({ user: 'U1', ...allow, messageTs: prompt.ts, channel: 'C1' })
  await tick()
  assert.deepEqual(s.inbox.at(-1), { type: 'permission', requestId: 'abcde', behavior: 'allow' })
  assert.match(t.slack.updates.at(-1)!.text, /✅ 허용/)

  await t.broker.handleSlackMessage({ user: 'U1', text: 'no fghij', ts: '1.1', threadTs: s.ack, channel: 'C1' })
  await tick()
  assert.deepEqual(s.inbox.at(-1), { type: 'permission', requestId: 'fghij', behavior: 'deny' })
  await t.broker.handleAction({ user: 'U2', actionId: 'perm_allow', value: '100:zzzzz', messageTs: '1', channel: 'C1' })
  await t.broker.handleSlackMessage({ user: 'U2', text: 'hi', ts: '1.2', threadTs: s.ack, channel: 'C1' })
  await tick()
  assert.equal((s.inbox.at(-1) as { requestId: string }).requestId, 'fghij')
  s.conn.close()
  t.close()
})

test('AskUserQuestion hook renders the options with key hints', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, { tmuxPane: '%1' })
  await hook(t.socketPath, 100, {
    hook_event_name: 'PreToolUse',
    tool_name: 'AskUserQuestion',
    tool_input: { questions: [{ question: '어느 쪽?', header: '방식', options: [{ label: 'A', description: '빠름' }, { label: 'B' }] }] },
  })
  const blocks = JSON.stringify(t.slack.posts.at(-1)!.blocks)
  assert.ok(blocks.includes('[방식] 어느 쪽?'))
  assert.ok(blocks.includes('1. A'))
  assert.ok(blocks.includes('2. B'))
  assert.equal(t.slack.statuses.at(-1), `suspended@${s.ack}`)
  s.conn.close()
  t.close()
})

test('top-level Slack message launches a tmux session bound to its thread', async () => {
  const t = await setup()
  const dir = tmpdir()
  await t.broker.handleSlackMessage({ user: 'U1', text: `${dir} 새 기능 만들어줘`, ts: '5.0', channel: 'C1' })
  assert.equal(t.tmux.launches.length, 1)
  assert.equal(t.tmux.launches[0]!.cwd, dir)
  assert.equal(t.tmux.launches[0]!.env.CLAUDE_SLACK_THREAD_TS, '5.0')
  assert.match(t.tmux.launches[0]!.env.CLAUDE_SLACK_SESSION!, /^[0-9a-f-]{36}$/)
  assert.equal(t.tmux.launches[0]!.name, `cs-${t.tmux.launches[0]!.env.CLAUDE_SLACK_SESSION}`)
  assert.equal(t.tmux.launches[0]!.command[0], '/bin/claude-slack')
  const status = t.slack.posts.at(-1)!
  assert.match(status.text, /시작 중/)

  // 준비 중에 보낸 것은 버리지 않고 들고 있다가 붙을 때 함께 전달한다.
  await t.broker.handleSlackMessage({ user: 'U1', text: '빨리', ts: '5.1', threadTs: '5.0', channel: 'C1' })
  assert.match(t.slack.texts().at(-1)!, /준비 중/)
  assert.ok(t.slack.reactions.includes('+eyes@5.1'), '받았다는 표시는 바로 남긴다')

  // Hooks may arrive before the shim says hello; the transcript path is kept.
  await hook(t.socketPath, 200, { hook_event_name: 'SessionStart', source: 'startup' }, t.transcript)
  const s = await shim(t.socketPath, { pid: 200, threadTs: '5.0' })
  assert.equal(s.ack, '5.0')
  await tick()
  // 시작 프롬프트와 기다리던 메시지가 한 턴으로 들어간다. 하나씩 넣으면 앞 턴이 잘린다.
  assert.deepEqual(s.inbox.at(-1), { type: 'inbound', text: '새 기능 만들어줘\n\n빨리', user: 'U1', ts: '5.1' })
  assert.equal(s.inbox.filter((m) => (m as { type: string }).type === 'inbound').length, 1, '한 번만 주입한다')
  assert.ok(!t.slack.texts().some((x) => x.includes('세션 연결됨')), 'no extra connected message')
  assert.match(t.slack.updates.filter((u) => u.ts === status.ts).at(-1)!.text, /대기 중|작업 중/, 'status message became the panel')
  appendFileSync(t.transcript, assistant({ type: 'text', text: '시작합니다' }))
  await tick(120)
  assert.equal(t.slack.streams.length, 1, 'early transcript path was used')

  await t.broker.handleSlackMessage({ user: 'U1', text: ':kill', ts: '5.2', threadTs: '5.0', channel: 'C1' })
  assert.ok(t.tmux.keys.includes('%9:kill'))
  s.conn.close()
  t.close()
})

test('control panel: compact status message, settings modal, overflow with confirmation', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, { tmuxPane: '%3' })
  const panel = t.slack.posts.find((p) => p.threadTs === s.ack && p.text.includes('대기 중'))!
  assert.ok(panel, 'panel posted')
  const json = JSON.stringify(panel.blocks)
  assert.ok(json.includes('ctl_settings') && json.includes('ctl_more'), 'settings + overflow only')
  assert.equal((panel.blocks as unknown[]).length, 2, 'status + one actions row')

  // Settings modal opens with the current state and applies changes as slash commands.
  await t.broker.handleAction({ user: 'U1', ...button(panel.blocks, 'ctl_settings'), messageTs: panel.ts, channel: 'C1', triggerId: 'trig' })
  assert.equal(t.slack.modals.length, 1)
  await t.broker.handleView({
    user: 'U1',
    callbackId: 'cs_settings',
    privateMetadata: '100',
    values: { model: { model: { selected_option: { value: 'claude-sonnet-5' } } }, effort: { effort: { selected_option: { value: 'low' } } }, mode: { mode: { selected_option: { value: 'plan' } } } },
  })
  assert.ok(t.tmux.keys.includes('%3:/model claude-sonnet-5⏎'))
  assert.ok(t.tmux.keys.includes('%3:/effort low⏎'))
  // Screen says auto → one shift+tab moves on; the fake never reaches plan, so it stops after 5 tries and reports.
  assert.ok(t.tmux.keys.filter((k) => k === '%3:BTab').length >= 1)

  // Destructive overflow items ask for confirmation first.
  await t.broker.handleAction({ user: 'U1', actionId: 'ctl_more', value: '100:confirm exit', messageTs: panel.ts, channel: 'C1' })
  assert.ok(!t.tmux.keys.includes('%3:/exit⏎'), 'not executed yet')
  const confirm = t.slack.ephemerals.at(-1)!
  assert.ok(JSON.stringify(confirm.blocks).includes('100:exit'))
  await t.broker.handleAction({ user: 'U1', actionId: 'ctl_confirm_x', value: '100:exit', messageTs: '', channel: 'C1' })
  assert.ok(t.tmux.keys.includes('%3:/exit⏎'))

  // Busy / idle state flips the status line in place.
  await t.broker.handleSlackMessage({ user: 'U1', text: 'go', ts: '9.1', threadTs: s.ack, channel: 'C1' })
  await tick(600)
  assert.match(JSON.stringify(t.slack.updates.filter((u) => u.ts === panel.ts).at(-1)!.blocks), /작업 중/)
  await hook(t.socketPath, 100, { hook_event_name: 'Stop', last_assistant_message: 'ok', permission_mode: 'auto', effort: { level: 'low' } })
  await tick(600)
  const last = JSON.stringify(t.slack.updates.filter((u) => u.ts === panel.ts).at(-1)!.blocks)
  assert.match(last, /대기 중/)
  assert.match(last, /effort `low`/)
  s.conn.close()
  await tick()
  t.close()
})

test('AskUserQuestion and plan approval render buttons that answer via keys', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, { tmuxPane: '%1' })
  await hook(t.socketPath, 100, {
    hook_event_name: 'PreToolUse',
    tool_name: 'AskUserQuestion',
    tool_input: { questions: [{ question: '어느 쪽?', header: '방식', options: [{ label: 'A', description: '빠름' }, { label: 'B' }] }] },
  })
  const q = t.slack.posts.at(-1)!
  assert.match(q.text, /선택을 기다립니다/)
  assert.ok(JSON.stringify(q.blocks).includes('100:answer 0 2 B'))
  // The terminal shows the matching numbered dialog, as it does in a real session.
  t.tmux.screen = ' 어느 쪽?\n ❯ 1. A\n   2. B\n'
  await t.broker.handleAction({ user: 'U1', ...buttonWithValue(q.blocks, 'dlg_answer', '100:answer 0 2 B'), messageTs: q.ts, channel: 'C1' })
  assert.deepEqual(t.tmux.keys.slice(-2), ['%1:2', '%1:Enter'])
  assert.match(t.slack.updates.filter((u) => u.ts === q.ts).at(-1)!.text, /선택: \*B\*/)

  await hook(t.socketPath, 100, { hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode', tool_input: {} })
  const plan = t.slack.posts.at(-1)!
  assert.match(plan.text, /플랜 승인/)
  t.tmux.screen = ' Would you like to proceed?\n ❯ 1. Yes\n   2. No, keep planning\n'
  await t.broker.handleAction({ user: 'U1', ...buttonWithValue(plan.blocks, 'dlg_answer', '100:answer 0 1 승인 (편집 자동 승인)'), messageTs: plan.ts, channel: 'C1' })
  assert.deepEqual(t.tmux.keys.slice(-2), ['%1:1', '%1:Enter'])
  s.conn.close()
  t.close()
})

test('"always allow" picks the don\'t-ask-again option on screen, else falls back to allow', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, { tmuxPane: '%2' })
  s.conn.send({ type: 'permission_request', requestId: 'abcde', toolName: 'Bash', description: 'Run', inputPreview: 'npm test' })
  await tick()
  const prompt = t.slack.posts.at(-1)!
  assert.ok(JSON.stringify(prompt.blocks).includes('perm_always'))
  t.tmux.screen = "Allow Bash?\n❯ 1. Yes\n  2. Yes, and don't ask again for npm commands in /home/u/proj\n  3. No, and tell Claude what to do differently\n"
  await t.broker.handleAction({ user: 'U1', ...button(prompt.blocks, 'perm_always'), messageTs: prompt.ts, channel: 'C1' })
  assert.deepEqual(t.tmux.keys.slice(-2), ['%2:2', '%2:Enter'])
  assert.match(t.slack.updates.at(-1)!.text, /항상 허용/)

  s.conn.send({ type: 'permission_request', requestId: 'fghij', toolName: 'Write', description: 'Write', inputPreview: 'x' })
  await tick()
  t.tmux.screen = 'Allow?\n❯ 1. Yes\n  2. No\n'
  await t.broker.handleAction({ user: 'U1', ...button(t.slack.posts.at(-1)!.blocks, 'perm_always'), messageTs: t.slack.posts.at(-1)!.ts, channel: 'C1' })
  await tick()
  assert.deepEqual(s.inbox.at(-1), { type: 'permission', requestId: 'fghij', behavior: 'allow' })
  s.conn.close()
  t.close()
})

test('/ccresume, /cclist, /ccnew and the modal launch sessions', async () => {
  const t = await setup()
  await t.broker.handleCommand({ user: 'U1', name: 'resume', text: '', channel: 'C1', triggerId: 'trig' })
  const picker = t.slack.ephemerals.at(-1)!
  assert.ok(JSON.stringify(picker.blocks).includes('resume:sess-1:/home/u/proj'))
  await t.broker.handleAction({ user: 'U1', actionId: 'ctl_resume', value: 'resume:sess-1:/home/u/proj', messageTs: '', channel: 'C1' })
  assert.equal(t.tmux.launches.length, 1)
  assert.deepEqual(t.tmux.launches[0]!.command, ['/bin/claude-slack', '--resume', 'sess-1'])
  const root = t.slack.posts.find((p) => !p.threadTs && p.text.includes('세션 재개'))!
  assert.equal(t.tmux.launches[0]!.env.CLAUDE_SLACK_THREAD_TS, root.ts)

  await t.broker.handleCommand({ user: 'U1', name: 'new', text: '', channel: 'C1', triggerId: 'trig' })
  assert.equal(t.slack.modals.length, 1)
  const dir = tmpdir()
  await t.broker.handleView({
    user: 'U1',
    callbackId: 'cs_new_session',
    values: { dir_custom: { dir_custom: { value: dir } }, prompt: { prompt: { value: '안녕' } }, model: { model: { selected_option: { value: 'claude-sonnet-5' } } }, effort: { effort: {} } },
  })
  assert.equal(t.tmux.launches.length, 2)
  assert.deepEqual(t.tmux.launches[1]!.command, ['/bin/claude-slack', '--model', 'claude-sonnet-5'])
  assert.equal(t.tmux.launches[1]!.cwd, dir)

  const s = await shim(t.socketPath, { pid: 300, threadTs: t.tmux.launches[1]!.env.CLAUDE_SLACK_THREAD_TS })
  await tick()
  assert.deepEqual(s.inbox.at(-1), { type: 'inbound', text: '안녕', user: 'U1', ts: s.ack })
  await t.broker.handleCommand({ user: 'U1', name: 'list', text: '', channel: 'C1', triggerId: 'trig' })
  assert.match(t.slack.ephemerals.at(-1)!.text, /실행 중인 세션 1개/)
  await t.broker.handleCommand({ user: 'U2', name: 'list', text: '', channel: 'C1', triggerId: 'trig' })
  assert.match(t.slack.ephemerals.at(-1)!.text, /실행 중인 세션 1개/, 'non-allowlisted user ignored')
  s.conn.close()
  t.close()
})

test('a Stop hook that outruns the transcript poller does not duplicate the answer', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, {})
  await hook(t.socketPath, 100, { hook_event_name: 'SessionStart', source: 'startup' }, t.transcript)
  await t.broker.handleSlackMessage({ user: 'U1', text: 'ㅎㅇ', ts: '1.1', threadTs: s.ack, channel: 'C1' })
  // Text lands and the Stop hook arrives immediately, before any poll tick.
  appendFileSync(t.transcript, assistant({ type: 'text', text: '안녕하세요! 무엇을 도와드릴까요?' }))
  await hook(t.socketPath, 100, { hook_event_name: 'Stop', last_assistant_message: '안녕하세요! 무엇을 도와드릴까요?' })
  await tick(700)
  const streamed = t.slack.streams.flatMap((st) => st.chunks).filter((c) => c.type === 'markdown_text' && c.text.includes('안녕하세요')).length
  const posted = t.slack.texts().filter((x) => x.includes('안녕하세요')).length
  assert.equal(streamed + posted, 1, `streamed=${streamed} posted=${posted}`)
  assert.equal(t.slack.statuses.at(-1), `active@${s.ack}`)
  s.conn.close()
  t.close()
})

test('the same hook delivered twice (user + project config) is handled once', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, {})
  await hook(t.socketPath, 100, { hook_event_name: 'UserPromptSubmit', user_message: '두 번 온다' })
  await hook(t.socketPath, 100, { hook_event_name: 'UserPromptSubmit', user_message: '두 번 온다' })
  assert.equal(t.slack.texts().filter((x) => x === '⌨️ 두 번 온다').length, 1)
  await hook(t.socketPath, 100, { hook_event_name: 'Stop', last_assistant_message: '답' })
  await hook(t.socketPath, 100, { hook_event_name: 'Stop', last_assistant_message: '답' })
  assert.equal(t.slack.texts().filter((x) => x === '답').length, 1)
  s.conn.close()
  t.close()
})

test('purge archives the thread to disk and deletes only the bot messages', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, { tmuxPane: '%5' })
  await hook(t.socketPath, 100, { hook_event_name: 'SessionStart', source: 'startup' }, t.transcript)
  t.slack.userMessages.push({ ts: '3.5', user: 'U1', text: '내 질문', threadTs: s.ack })
  await hook(t.socketPath, 100, { hook_event_name: 'Stop', last_assistant_message: '답변' })

  // Live session: overflow → confirm → /exit; purge happens after SessionEnd.
  await t.broker.handleAction({ user: 'U1', actionId: 'ctl_more', value: '100:confirm purge', messageTs: '', channel: 'C1' })
  assert.ok(JSON.stringify(t.slack.ephemerals.at(-1)!.blocks).includes('100:purge'))
  assert.match(t.slack.ephemerals.at(-1)!.text, /내가 쓴 메시지는 남습니다/)
  await t.broker.handleAction({ user: 'U1', actionId: 'ctl_confirm_x', value: '100:purge', messageTs: '', channel: 'C1' })
  assert.ok(t.tmux.keys.includes('%5:/exit⏎'))
  assert.equal(t.slack.deleted.length, 0, 'nothing deleted while alive')
  await hook(t.socketPath, 100, { hook_event_name: 'SessionEnd', reason: 'other' })
  await tick(100)

  const files = readdirSync(t.archiveDir)
  assert.ok(files.some((f) => f.endsWith('.json')) && files.some((f) => f.endsWith('.md')), `archive written: ${files}`)
  const archive = JSON.parse(readFileSync(join(t.archiveDir, files.find((f) => f.endsWith('.json'))!), 'utf8'))
  assert.equal(archive.key, '100')
  assert.ok(archive.messages.some((m: { text: string }) => m.text === '내 질문'), 'user message archived')
  assert.ok(archive.messages.some((m: { text: string }) => m.text === '답변'), 'bot answer archived')
  assert.ok(!t.slack.deleted.includes('3.5'), 'user message kept')
  assert.ok(t.slack.deleted.includes(s.ack), 'bot-owned root deleted last')
  assert.equal(t.slack.deleted.at(-1), s.ack)
  const botTs = t.slack.posts.filter((p) => p.threadTs === s.ack).map((p) => p.ts)
  for (const ts of botTs) assert.ok(t.slack.deleted.includes(ts), `deleted ${ts}`)

  await t.broker.handleCommand({ user: 'U1', name: 'history', text: '', channel: 'C1', triggerId: 'trig' })
  assert.match(t.slack.ephemerals.at(-1)!.text, /보관된 세션 1개/)
  s.conn.close()
  t.close()
})

test('an ended panel still offers purge', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, { tmuxPane: '%6' })
  s.conn.close()
  await tick(100)
  // 루트 메시지도 종료됨을 표시하므로, 블록이 있는 쪽(패널)을 고른다.
  const ended = t.slack.updates.filter((u) => /종료됨/.test(u.text) && u.blocks).at(-1)!
  assert.ok(JSON.stringify(ended.blocks).includes('100:confirm purge'))
  await t.broker.handleAction({ user: 'U1', actionId: 'ctl_confirm_x', value: '100:purge', messageTs: '', channel: 'C1' })
  await tick(50)
  assert.ok(t.slack.deleted.includes(s.ack))
  t.close()
})

test('with a user token, purge deletes the user\'s own messages as well', async () => {
  const t = await setup({ userToken: 'xoxp-test' })
  t.slack.userToken = true
  const s = await shim(t.socketPath, { tmuxPane: '%7' })
  await t.broker.handleAction({ user: 'U1', actionId: 'ctl_more', value: '100:confirm purge', messageTs: '', channel: 'C1' })
  assert.match(t.slack.ephemerals.at(-1)!.text, /내가 쓴 메시지도 같이 지웁니다/)
  t.slack.userMessages.push({ ts: '3.5', user: 'U1', text: '내 질문', threadTs: s.ack })
  s.conn.close()
  await tick(100)
  await t.broker.handleAction({ user: 'U1', actionId: 'ctl_confirm_x', value: '100:purge', messageTs: '', channel: 'C1' })
  await tick(50)
  assert.ok(t.slack.deletedAsUser.includes('3.5'))
  assert.ok(t.slack.deleted.includes(s.ack))
  assert.match(t.slack.ephemerals.at(-1)!.text, /지우고 서버에 보관/)
  assert.ok(!/남음/.test(t.slack.ephemerals.at(-1)!.text))
  t.close()
})

test('a reply arriving in the same chunk as hello is not lost while attaching', async () => {
  const t = await setup()
  const conn = await connect(t.socketPath)
  const hello = { type: 'hello', role: 'channel', key: '100', pid: 100, sessionId: 's1', cwd: '/home/u/proj' }
  const reply = { type: 'reply', text: '바로 답장' }
  // One write, two lines: the broker sees both messages in a single data event.
  conn.socket.write(JSON.stringify(hello) + '\n' + JSON.stringify(reply) + '\n')
  await tick(150)
  const root = t.slack.posts[0]!.ts
  assert.ok(t.slack.posts.some((p) => p.threadTs === root && p.text === '바로 답장'), `posts: ${t.slack.texts()}`)
  conn.close()
  t.close()
})

test('reply with files uploads them to the thread, caption attached', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, {})
  s.conn.send({ type: 'reply', text: '스크린샷입니다', files: ['/tmp/shot.png'] })
  await tick()
  assert.deepEqual(t.slack.uploads, [{ threadTs: s.ack, paths: ['/tmp/shot.png'], text: '스크린샷입니다' }])
  assert.ok(!t.slack.texts().includes('스크린샷입니다'), 'caption is not posted a second time')

  // Without files:write the caption still arrives, with a hint about the scope.
  t.slack.filesScope = false
  s.conn.send({ type: 'reply', text: '두 번째', files: ['/tmp/shot.png'] })
  await tick()
  assert.ok(t.slack.texts().includes('두 번째'))
  assert.match(t.slack.texts().at(-1)!, /files:write/)
  t.close()
})

test('도구 카드도 메시지 분량에 넣어 센다 (msg_too_long 으로 닫히기 전에 나눈다)', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, {})
  await hook(t.socketPath, 100, { hook_event_name: 'SessionStart', source: 'startup' }, t.transcript)
  await t.broker.handleSlackMessage({ user: 'U1', text: 'go', ts: '1.1', threadTs: s.ack, channel: 'C1' })

  // Cards carrying a long command are most of what a busy turn weighs.
  const script = 'cd /p\npython3 - <<\'EOF\'\n' + 'print("x" * 40)\n'.repeat(60) + 'EOF'
  for (let i = 0; i < 12; i++) {
    appendFileSync(t.transcript, assistant({ type: 'tool_use', id: `tu${i}`, name: 'Bash', input: { command: script } }))
    appendFileSync(t.transcript, toolResult(`tu${i}`, 'ok'))
    await tick(60)
  }
  await hook(t.socketPath, 100, { hook_event_name: 'Stop', last_assistant_message: '끝' })

  assert.ok(t.slack.streams.length > 1, `분량이 차면 새 메시지로 나눈다 (스트림 ${t.slack.streams.length}개)`)
  s.conn.close()
  t.close()
})

test('두드림은 분량을 늘리지 않는다 (같은 카드를 갈아끼우는 것뿐)', async () => {
  const t = await setup({ heartbeatMs: 30 })
  const s = await shim(t.socketPath, {})
  await hook(t.socketPath, 100, { hook_event_name: 'SessionStart', source: 'startup' }, t.transcript)
  await t.broker.handleSlackMessage({ user: 'U1', text: 'go', ts: '1.1', threadTs: s.ack, channel: 'C1' })

  // One long-running call, beaten on repeatedly. Counting each beat as growth
  // would split the message again and again for a single tool call.
  const script = 'cd /p\npython3 - <<\'EOF\'\n' + 'print("x" * 40)\n'.repeat(60) + 'EOF'
  appendFileSync(t.transcript, assistant({ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: script } }))
  await until(() => t.slack.streams.length === 1, '스트림 시작')
  await tick(400)

  const beats = t.slack.streams[0]!.chunks.filter((c) => c.type === 'task_update').length
  assert.ok(beats > 3, `여러 번 두드렸다 (${beats})`)
  assert.equal(t.slack.streams.length, 1, '그래도 메시지는 하나다')
  s.conn.close()
  t.close()
})

test('스트림이 닫히면 새 스트림으로 이어간다 (턴 전체가 평문으로 강등되지 않는다)', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, {})
  await hook(t.socketPath, 100, { hook_event_name: 'SessionStart', source: 'startup' }, t.transcript)
  await t.broker.handleSlackMessage({ user: 'U1', text: 'go', ts: '1.1', threadTs: s.ack, channel: 'C1' })
  appendFileSync(t.transcript, assistant({ type: 'text', text: '첫 배치' }))
  await tick(120)

  // Slack closed the stream under us, the way it does after a long quiet tool call.
  t.slack.failAppend = true
  appendFileSync(t.transcript, assistant({ type: 'text', text: '둘째 배치' }))
  await tick(120)
  await hook(t.socketPath, 100, { hook_event_name: 'Stop', last_assistant_message: '둘째 배치' })

  assert.ok(t.slack.streams[0]!.stopped, '닫힌 스트림은 정리한다')
  assert.equal(t.slack.streams.length, 2, '새 스트림으로 이어간다')
  const carried = t.slack.streams[1]!.chunks.some((c) => c.type === 'markdown_text' && c.text.includes('둘째 배치'))
  assert.ok(carried, `못 보낸 배치를 새 스트림이 싣는다: ${JSON.stringify(t.slack.streams[1]!.chunks)}`)
  s.conn.close()
  t.close()
})

test('새 스트림도 열리지 않으면 그때는 평문으로 떨어뜨린다 (배치를 잃지 않는다)', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, {})
  await hook(t.socketPath, 100, { hook_event_name: 'SessionStart', source: 'startup' }, t.transcript)
  await t.broker.handleSlackMessage({ user: 'U1', text: 'go', ts: '1.1', threadTs: s.ack, channel: 'C1' })
  appendFileSync(t.transcript, assistant({ type: 'text', text: '첫 배치' }))
  await tick(120)

  t.slack.failAppend = true
  t.slack.failStreaming = true
  appendFileSync(t.transcript, assistant({ type: 'text', text: '둘째 배치' }))
  await tick(120)
  await hook(t.socketPath, 100, { hook_event_name: 'Stop', last_assistant_message: '둘째 배치' })

  const body = t.slack.posts.filter((p) => p.threadTs === s.ack).map((p) => p.text)
  assert.ok(body.includes('둘째 배치'), `평문으로라도 전달된다: ${body}`)
  s.conn.close()
  t.close()
})

test('purge reports into the thread when the root message could not be deleted', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, { tmuxPane: '%8' })
  t.slack.failDelete.add(s.ack)
  s.conn.close()
  await tick(100)
  await t.broker.handleAction({ user: 'U1', actionId: 'ctl_confirm_x', value: '100:purge', messageTs: '', channel: 'C1' })
  await tick(50)
  assert.ok(!t.slack.deleted.includes(s.ack))
  assert.match(t.slack.ephemerals.at(-1)!.text, /1개 남음/)
  assert.equal(t.slack.ephemerals.at(-1)!.threadTs, s.ack, 'notice goes to the still-existing thread')
  t.close()
})

test('slash command names: short and full forms map to the same sub-command', () => {
  assert.equal(slashCommandName('/ccnew'), 'new')
  assert.equal(slashCommandName('/claude-code-new'), 'new')
  assert.equal(slashCommandName('/cchistory'), 'history')
  assert.equal(SLASH_COMMANDS.length, 12)
})

test('/ccresume <id prefix> launches the session directly', async () => {
  const t = await setup()
  await t.broker.handleCommand({ user: 'U1', name: 'resume', text: 'sess', channel: 'C1', triggerId: 'trig' })
  assert.equal(t.tmux.launches.length, 1)
  assert.deepEqual(t.tmux.launches[0]!.command, ['/bin/claude-slack', '--resume', 'sess-1'])
  assert.equal(t.tmux.launches[0]!.cwd, '/home/u/proj')
  await t.broker.handleCommand({ user: 'U1', name: 'resume', text: 'nope', channel: 'C1', triggerId: 'trig' })
  assert.match(t.slack.ephemerals.at(-1)!.text, /찾지 못했습니다/)
  assert.equal(t.tmux.launches.length, 1)
  t.close()
})

test('in a thread, / and ! pass through to the terminal and retired :commands point to them', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, { tmuxPane: '%4' })
  await t.broker.handleSlackMessage({ user: 'U1', text: '/compact', ts: '2.1', threadTs: s.ack, channel: 'C1' })
  assert.ok(t.tmux.keys.includes('%4:/compact⏎'))
  await t.broker.handleSlackMessage({ user: 'U1', text: '/model opus', ts: '2.2', threadTs: s.ack, channel: 'C1' })
  assert.ok(t.tmux.keys.includes('%4:/model opus⏎'))
  assert.ok(!s.inbox.some((m) => (m as { type: string }).type === 'inbound'), 'slash commands are not prompts')

  await t.broker.handleSlackMessage({ user: 'U1', text: '!npm test', ts: '2.25', threadTs: s.ack, channel: 'C1' })
  assert.ok(t.tmux.keys.includes('%4:!npm test⏎'), 'bash mode passes through')
  await t.broker.handleSlackMessage({ user: 'U1', text: ':/context', ts: '2.26', threadTs: s.ack, channel: 'C1' })
  assert.ok(t.tmux.keys.includes('%4:/context⏎'), ': escapes a slash command Slack would intercept')

  const before = t.tmux.keys.length
  await t.broker.handleSlackMessage({ user: 'U1', text: ':compact', ts: '2.3', threadTs: s.ack, channel: 'C1' })
  assert.equal(t.tmux.keys.length, before, 'retired command sends nothing')
  assert.match(t.slack.posts.at(-1)!.text, /`:compact` 은 없어졌습니다.*`\/compact`/)

  await t.broker.handleSlackMessage({ user: 'U1', text: ':status', ts: '2.4', threadTs: s.ack, channel: 'C1' })
  assert.match(t.slack.posts.at(-1)!.text, /🟢 대기 · 모델 기본값 · effort 기본값 · 권한 auto/)
  s.conn.close()
  t.close()
})

test('/model from the settings modal answers the "Switch model?" dialog', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, { tmuxPane: '%11' })
  t.tmux.screen = '   Switch model?\n   ❯ 1. Yes, switch to Sonnet 5\n     2. No, go back\n'
  await t.broker.handleView({ user: 'U1', callbackId: 'cs_settings', privateMetadata: '100', values: { model: { model: { selected_option: { value: 'claude-sonnet-5' } } }, effort: { effort: {} }, mode: { mode: {} } } })
  assert.ok(t.tmux.keys.includes('%11:/model claude-sonnet-5⏎'))
  assert.ok(t.tmux.keys.includes('%11:Enter'), `dialog confirmed: ${t.tmux.keys}`)
  s.conn.close()
  t.close()
})

test('stall watchdog: an unknown terminal dialog becomes buttons, a known one is auto-confirmed', async () => {
  const t = await setup({ stallMs: 60 })
  const s = await shim(t.socketPath, { tmuxPane: '%12' })
  await hook(t.socketPath, 100, { hook_event_name: 'SessionStart', source: 'startup' }, t.transcript)
  await t.broker.handleSlackMessage({ user: 'U1', text: 'go', ts: '3.1', threadTs: s.ack, channel: 'C1' })
  t.tmux.screen = '   Restart required\n   ❯ 1. Restart now\n     2. Later\n'
  await tick(200)
  const dlg = t.slack.posts.filter((p) => p.threadTs === s.ack).at(-1)!
  assert.match(dlg.text, /선택을 기다립니다/)
  const json = JSON.stringify(dlg.blocks)
  assert.ok(json.includes('Restart required') && json.includes('100:answer 0 1 Restart now') && json.includes('100:answer 0 2 Later'), json)
  const count = t.slack.posts.length
  await tick(200)
  assert.equal(t.slack.posts.length, count, 'same dialog is not posted twice')

  // Answering presses the number, then a known dialog shows up and is confirmed without asking.
  await t.broker.handleAction({ user: 'U1', actionId: 'dlg_answer_x', value: '100:answer 0 2 Later', messageTs: '', channel: 'C1' })
  assert.ok(t.tmux.keys.includes('%12:2') && t.tmux.keys.includes('%12:Enter'))
  t.tmux.screen = '   Switch model?\n   ❯ 1. Yes, switch to Sonnet 5\n     2. No, go back\n'
  await tick(200)
  assert.match(t.slack.posts.at(-1)!.text, /자동으로 넘겼습니다/)

  // Normal quiet work (no dialog) stays silent.
  t.tmux.screen = '⏺ Bash(npm test)\n  ⎿  Running…\n'
  const before = t.slack.posts.length
  await tick(250)
  assert.equal(t.slack.posts.length, before)
  s.conn.close()
  t.close()
})

test('a session reconnecting after a broker restart reuses the panel already in the thread', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, { tmuxPane: '%13' })
  const panels = () => t.slack.posts.filter((p) => p.threadTs === s.ack && JSON.stringify(p.blocks ?? []).includes('ctl_100'))
  assert.equal(panels().length, 1)
  // Simulate a fresh broker: same thread, new connection, nothing remembered.
  appendFileSync(t.transcript, assistant({ type: 'text', text: '이전 답' }).replace('"role":"assistant"', '"role":"assistant","model":"claude-sonnet-5"'))
  t.tmux.screen = '▝▜██████▀  Sonnet 5 with high effort · Claude Max\n> \n  ⏵⏵ accept edits on (shift+tab to cycle)\n'
  const t2 = { ...t, broker: new Broker({ channelId: 'C1', allowedUsers: new Set(['U1']), defaultCwd: '/default', launcher: '/bin/claude-slack', flushMs: 20, transcriptPathFor: () => t.transcript, archiveDir: t.archiveDir, offsetsPath: t.offsetsPath, revivePath: t.revivePath }, t.slack, t.tmux) }
  t2.broker.log = () => {}
  const socketPath = t.socketPath + '.2'
  const server = await listen(socketPath, (c) => t2.broker.onConn(c))
  const s2 = await shim(socketPath, { tmuxPane: '%13', threadTs: s.ack })
  assert.equal(s2.ack, s.ack)
  assert.equal(panels().length, 1, 'no second panel posted')
  assert.equal(t.slack.updates.at(-1)!.ts, panels()[0]!.ts, 'existing panel refreshed instead')
  const refreshed = t.slack.updates.at(-1)!.text + JSON.stringify(t.slack.updates.at(-1)!.blocks)
  assert.match(refreshed, /sonnet-5/, 'model recovered from the transcript')
  assert.match(refreshed, /effort `high`/, 'effort recovered from the screen')
  assert.match(refreshed, /권한 `acceptEdits`/, 'permission mode recovered from the screen')
  s.conn.close()
  s2.conn.close()
  server.close()
  t.close()
})

test('허용 also answers a terminal classifier dialog gating the same action', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, { tmuxPane: '%14' })
  // The shim asks for permission (MCP), and the terminal is on the auto-mode classifier dialog.
  s.conn.send({ type: 'permission_request', requestId: 'zbcij', toolName: 'Bash', description: 'List home', inputPreview: 'ls ~' })
  await tick()
  t.tmux.screen = ' Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, allow reading from /Users/me from this project\n   3. No\n'
  await t.broker.handleAction({ user: 'U1', actionId: 'perm_allow', value: '100:zbcij', messageTs: '', channel: 'C1' })
  // MCP verdict sent to the shim...
  assert.ok(s.inbox.some((m) => (m as any).type === 'permission' && (m as any).behavior === 'allow'))
  // ...and the terminal's plain "Yes" (option 1, not the project-wide option 2) is pressed.
  assert.ok(t.tmux.keys.includes('%14:1') && t.tmux.keys.includes('%14:Enter'), `keys: ${t.tmux.keys}`)
  s.conn.close()
  t.close()
})

test('an agent_needs_input notification surfaces the terminal dialog as buttons', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, { tmuxPane: '%15' })
  t.tmux.screen = ' Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, allow reading from /Users/me/.claude from this project\n   3. No\n'
  await hook(t.socketPath, 100, { hook_event_name: 'Notification', notification_type: 'agent_needs_input', message: '입력이 필요합니다' })
  const last = t.slack.posts.filter((p) => p.threadTs === s.ack).at(-1)!
  assert.match(last.text, /선택을 기다립니다/)
  const json = JSON.stringify(last.blocks)
  assert.ok(json.includes('Do you want to proceed') && json.includes('100:answer 0 1 Yes'), json)
  s.conn.close()
  t.close()
})

test('rendered action ids (with their uniqueness suffix) reach every handler', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, { tmuxPane: '%16' })
  // deny, through the real button id
  s.conn.send({ type: 'permission_request', requestId: 'deny1', toolName: 'Bash', description: 'rm', inputPreview: '{}' })
  await tick()
  const card = t.slack.posts.at(-1)!
  const deny = button(card.blocks, 'perm_deny')
  await t.broker.handleAction({ user: 'U1', ...deny, messageTs: card.ts, channel: 'C1' })
  await tick()
  assert.deepEqual(s.inbox.at(-1), { type: 'permission', requestId: 'deny1', behavior: 'deny' })

  // always-allow, through the real button id
  s.conn.send({ type: 'permission_request', requestId: 'alw1', toolName: 'Bash', description: 'ls', inputPreview: '{}' })
  await tick()
  const card2 = t.slack.posts.at(-1)!
  t.tmux.screen = ' Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, don\'t ask again for Bash\n   3. No\n'
  const always = button(card2.blocks, 'perm_always')
  await t.broker.handleAction({ user: 'U1', ...always, messageTs: card2.ts, channel: 'C1' })
  await tick()
  assert.ok(t.tmux.keys.includes('%16:2'), `always-allow picked option 2: ${t.tmux.keys}`)
  s.conn.close()
  t.close()
})

test('a stale dialog button does not type its digit into the prompt', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, { tmuxPane: '%17' })
  // The dialog is gone: the terminal is back at a normal prompt.
  t.tmux.screen = '⏺ 다 됐어요\n❯ \n  ⏵⏵ auto mode on (shift+tab to cycle)\n'
  await t.broker.handleAction({ user: 'U1', actionId: 'dlg_answer_answer_0_1_Yes_9', value: '100:answer 0 1 Yes', messageTs: '', channel: 'C1' })
  assert.ok(!t.tmux.keys.some((k) => k === '%17:1'), `no digit typed: ${t.tmux.keys}`)
  assert.match(t.slack.ephemerals.at(-1)!.text, /이미 끝났습니다/)

  // With the dialog actually on screen it still works.
  t.tmux.screen = ' Do you want to proceed?\n ❯ 1. Yes\n   2. No\n'
  await t.broker.handleAction({ user: 'U1', actionId: 'dlg_answer_answer_0_1_Yes_10', value: '100:answer 0 1 Yes', messageTs: '', channel: 'C1' })
  assert.ok(t.tmux.keys.includes('%17:1'), `digit sent when the dialog is up: ${t.tmux.keys}`)
  s.conn.close()
  t.close()
})

test('거부는 "Don\'t ask again"(영구 허용)을 절대 고르지 않는다', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, { tmuxPane: '%18' })
  s.conn.send({ type: 'permission_request', requestId: 'dn1', toolName: 'Bash', description: 'rm -rf', inputPreview: '{}' })
  await tick()
  const card = t.slack.posts.at(-1)!
  // The always-allow option is listed before the plain No, and its label starts with "Don't".
  t.tmux.screen = ' Do you want to proceed?\n ❯ 1. Yes\n   2. Don\'t ask again for Bash\n   3. No\n'
  await t.broker.handleAction({ user: 'U1', ...button(card.blocks, 'perm_deny'), messageTs: card.ts, channel: 'C1' })
  await tick()
  assert.ok(!t.tmux.keys.includes('%18:2'), `영구 허용(2번)을 누르면 안 됨: ${t.tmux.keys}`)
  assert.ok(t.tmux.keys.includes('%18:3'), `거부(3번)를 눌러야 함: ${t.tmux.keys}`)
  s.conn.close()
  t.close()
})

test('허용은 프로젝트 전체 허용이 아니라 일회 Yes를 고른다', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, { tmuxPane: '%19' })
  s.conn.send({ type: 'permission_request', requestId: 'al1', toolName: 'Bash', description: 'ls', inputPreview: '{}' })
  await tick()
  const card = t.slack.posts.at(-1)!
  t.tmux.screen = ' Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, allow reading from /Users/me from this project\n   3. No\n'
  await t.broker.handleAction({ user: 'U1', ...button(card.blocks, 'perm_allow'), messageTs: card.ts, channel: 'C1' })
  await tick()
  assert.ok(t.tmux.keys.includes('%19:1'), `일회 허용(1번): ${t.tmux.keys}`)
  assert.ok(!t.tmux.keys.includes('%19:2'), `프로젝트 전체 허용(2번)을 누르면 안 됨: ${t.tmux.keys}`)
  s.conn.close()
  t.close()
})

test('조용할 때: 실행 중인 작업을 이름으로 알리고, 한 메시지를 갱신한다', async () => {
  const t = await setup({ stallMs: 60, quietMs: 60 })
  const s = await shim(t.socketPath, { tmuxPane: '%20' })
  await hook(t.socketPath, 100, { hook_event_name: 'SessionStart', source: 'startup' }, t.transcript)
  await t.broker.handleSlackMessage({ user: 'U1', text: 'go', ts: '4.1', threadTs: s.ack, channel: 'C1' })
  // A long tool call is in flight, and the terminal is all chrome.
  appendFileSync(t.transcript, assistant({ type: 'tool_use', id: 'tu9', name: 'Bash', input: { command: 'uv run python -c "..."' } }))
  t.tmux.screen = '─────────\n❯ \n  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt\n'
  await tick(300)

  const notices = t.slack.posts.filter((p) => p.threadTs === s.ack && /⏳/.test(p.text))
  assert.equal(notices.length, 1, `한 번만 올린다: ${notices.length}`)
  assert.match(notices[0]!.text, /작업 중입니다/)
  assert.match(notices[0]!.text, /실행 중:.*Bash/, `무엇이 도는지 이름을 말한다: ${notices[0]!.text}`)
  assert.ok(!/⏵⏵|─────/.test(notices[0]!.text), `TUI 장식은 넣지 않는다: ${notices[0]!.text}`)

  // Later stalls edit that message instead of posting again.
  await tick(300)
  assert.equal(t.slack.posts.filter((p) => p.threadTs === s.ack && /⏳/.test(p.text)).length, 1, '새 메시지를 만들지 않는다')
  assert.ok(t.slack.updates.some((u) => u.ts === notices[0]!.ts && /⏳/.test(u.text)), '같은 메시지를 갱신한다')
  s.conn.close()
  t.close()
})

test('서브에이전트 완료 알림은 사용자가 친 것처럼 미러링되지 않는다', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, { tmuxPane: '%21' })
  const notification = [
    '<task-notification>',
    '<task-id>a06d66d31c4d4c9b2</task-id>',
    '<output-file>/private/tmp/tasks/a06d66d31c4d4c9b2.output</output-file>',
    '<status>completed</status>',
    '<summary>Agent "Academic literature on stock prediction" finished</summary>',
    '<result>I have enough. Here is the report.\n\n# Machine Learning for Stock Return Prediction\n...</result>',
    '</task-notification>',
  ].join('\n')
  await hook(t.socketPath, 100, { hook_event_name: 'UserPromptSubmit', user_message: notification })

  const posts = t.slack.posts.filter((p) => p.threadTs === s.ack)
  assert.ok(!posts.some((p) => /task-notification|<task-id>|output-file/.test(p.text)), `내부 XML을 흘리지 않는다: ${posts.map((p) => p.text.slice(0, 40))}`)
  assert.ok(!posts.some((p) => p.text.startsWith('⌨️')), '사용자 입력으로 표시하지 않는다')
  // A routine completion is noise: Claude's next step shows it. Nothing is posted.
  assert.ok(!posts.some((p) => /Agent "Academic literature on stock prediction" finished/.test(p.text)), '완료 알림은 올리지 않는다')

  // A failure is not routine; it is said in one line.
  const failed = notification.replace('<status>completed</status>', '<status>failed</status>')
  await hook(t.socketPath, 100, { hook_event_name: 'UserPromptSubmit', user_message: failed })
  assert.match(t.slack.posts.at(-1)!.text, /🤖 Agent "Academic literature on stock prediction" finished \(failed\)/)

  // 진짜 사용자 입력은 그대로 미러링된다.
  await hook(t.socketPath, 100, { hook_event_name: 'UserPromptSubmit', user_message: '테스트 돌려줘' })
  assert.match(t.slack.posts.at(-1)!.text, /^⌨️ 테스트 돌려줘/)
  s.conn.close()
  t.close()
})

test(':screen 은 장식을 걷어내고, raw 는 화면 그대로 보여준다', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, { tmuxPane: '%22' })
  t.tmux.screen = ['  └ Tip: /btw 를 써보세요', '────────────', '❯ ', '  ⏵⏵ auto mode on (shift+tab to cycle)', '  ○ general-purpose  조사 중  1m 13s'].join('\n')

  await t.broker.handleSlackMessage({ user: 'U1', text: ':screen', ts: '6.1', threadTs: s.ack, channel: 'C1' })
  const digest = t.slack.posts.at(-1)!.text
  assert.match(digest, /general-purpose/, '내용 있는 줄은 남긴다')
  assert.ok(!/Tip:|auto mode on|────/.test(digest), `장식은 뺀다: ${digest}`)

  await t.broker.handleSlackMessage({ user: 'U1', text: ':screen raw', ts: '6.2', threadTs: s.ack, channel: 'C1' })
  const raw = t.slack.posts.at(-1)!.text
  assert.match(raw, /auto mode on/, 'raw 는 상태줄까지 그대로')
  assert.match(raw, /────/, 'raw 는 구분선까지 그대로')
  s.conn.close()
  t.close()
})

test('슬래시 명령 출력은 화면이 그려지길 기다렸다가 보여준다', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, { tmuxPane: '%23' })
  // 처음 두 번은 그리는 중, 그 뒤로 안정된다.
  const frames = ['컨텍스트 계산 중…', '컨텍스트 계산 중…\n  system prompt   2.1k', '  system prompt   2.1k\n  tools           8.4k\n  대화            31.0k']
  let i = 0
  t.tmux.capture = async () => frames[Math.min(i++, frames.length - 1)]!

  await t.broker.handleSlackMessage({ user: 'U1', text: ':/context', ts: '6.3', threadTs: s.ack, channel: 'C1' })
  // 칼럼으로 출력되므로 코드 블록이 아니라 표로 온다.
  const out = JSON.stringify(t.slack.posts.at(-1)!.blocks)
  assert.match(out, /"type":"table"/, `표로 보여준다: ${out}`)
  assert.match(out, /대화/)
  assert.match(out, /31\.0k/, `완성된 출력을 보여준다: ${out}`)
  assert.ok(!/계산 중/.test(out), '그리는 중인 화면을 보여주지 않는다')
  s.conn.close()
  t.close()
})

test('할 일 목록은 카드가 아니라 갱신되는 체크리스트 한 개로 보인다', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, { tmuxPane: '%24' })
  await hook(t.socketPath, 100, { hook_event_name: 'SessionStart', source: 'startup' }, t.transcript)
  await t.broker.handleSlackMessage({ user: 'U1', text: 'go', ts: '7.1', threadTs: s.ack, channel: 'C1' })

  const write = (todos: unknown[], id: string) => assistant({ type: 'tool_use', id, name: 'TodoWrite', input: { todos } })
  appendFileSync(t.transcript, write([{ content: '스키마', status: 'in_progress', activeForm: '스키마 정리 중' }, { content: '핸들러', status: 'pending' }], 'td1'))
  await tick(150)
  const first = t.slack.posts.filter((p) => p.threadTs === s.ack && /할 일/.test(p.text))
  assert.equal(first.length, 1, '체크리스트는 하나')
  assert.match(first[0]!.text, /할 일 0\/2/)

  // 진척이 생기면 같은 메시지를 고친다.
  appendFileSync(t.transcript, toolResult('td1', 'ok'))
  appendFileSync(t.transcript, write([{ content: '스키마', status: 'completed' }, { content: '핸들러', status: 'in_progress', activeForm: '핸들러 작성 중' }], 'td2'))
  await tick(150)
  assert.equal(t.slack.posts.filter((p) => p.threadTs === s.ack && /할 일/.test(p.text)).length, 1, '새로 올리지 않는다')
  const edit = t.slack.updates.filter((u) => u.ts === first[0]!.ts).at(-1)!
  assert.match(edit.text, /할 일 1\/2/)
  assert.match(edit.text, /🔵 \*핸들러 작성 중\*/)

  // TodoWrite 는 도구 카드로도, 결과 카드로도 나오지 않는다.
  await hook(t.socketPath, 100, { hook_event_name: 'Stop', last_assistant_message: '끝' })
  const kinds = (t.slack.streams[0]?.chunks ?? []).map((c) => (c.type === 'task_update' ? c.title : c.type))
  assert.ok(!kinds.some((k) => typeof k === 'string' && /TodoWrite/.test(k)), `도구 카드 없음: ${kinds}`)
  s.conn.close()
  t.close()
})

test('앱 홈은 실행 중인 세션과 이어서 하기를 보여준다', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, { tmuxPane: '%25' })
  await t.broker.handleHomeOpened('U1')

  const view = JSON.stringify(t.slack.homeViews.at(-1))
  assert.match(view, /"type":"home"/)
  assert.match(view, /실행 중 1개/)
  assert.match(view, /proj/, '어떤 폴더인지 보인다')
  assert.match(view, /resume:sess-1:/, '이어서 하기 목록이 있다')
  assert.match(view, /ctl_new/, '새 세션 버튼이 있다')

  // 허용되지 않은 사용자에게는 아무것도 게시하지 않는다.
  const before = t.slack.homeViews.length
  await t.broker.handleHomeOpened('U9')
  assert.equal(t.slack.homeViews.length, before)

  // 세션이 끝나면 목록에서 빠진다.
  s.conn.close()
  await tick(120)
  await t.broker.handleHomeOpened('U1')
  assert.match(JSON.stringify(t.slack.homeViews.at(-1)), /실행 중인 세션이 없습니다/)
  t.close()
})

test('2초 안에 같은 짧은 답이 반복돼도 두 번째 턴을 삼키지 않는다', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, { tmuxPane: '%26' })
  await hook(t.socketPath, 100, { hook_event_name: 'SessionStart', source: 'startup' }, t.transcript)

  const turn = async (ts: string) => {
    await t.broker.handleSlackMessage({ user: 'U1', text: 'ok', ts, threadTs: s.ack, channel: 'C1' })
    appendFileSync(t.transcript, assistant({ type: 'text', text: '네' }))
    await tick(120)
    await hook(t.socketPath, 100, { hook_event_name: 'Stop', last_assistant_message: '네' })
  }
  await turn('8.1')
  await turn('8.2')

  // 두 턴 모두 끝나야 한다. 삼켜지면 세션이 작업 중으로 멈춘다.
  assert.equal(t.slack.statuses.filter((x) => x.startsWith('active@')).length, 2, `두 번 다 완료: ${t.slack.statuses}`)
  s.conn.close()
  t.close()
})

test('같은 훅이 두 설정에서 두 번 와도 한 번만 처리한다', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, { tmuxPane: '%27' })
  await hook(t.socketPath, 100, { hook_event_name: 'SessionStart', source: 'startup' }, t.transcript)
  // 트랜스크립트가 자라지 않은 채 같은 이벤트가 두 번 = 중복 배달.
  await hook(t.socketPath, 100, { hook_event_name: 'UserPromptSubmit', user_message: '같은 프롬프트' })
  await hook(t.socketPath, 100, { hook_event_name: 'UserPromptSubmit', user_message: '같은 프롬프트' })
  assert.equal(t.slack.posts.filter((p) => p.text.includes('같은 프롬프트')).length, 1)
  s.conn.close()
  t.close()
})

test('사용자가 칠 수 있는 명령은 표에서 파생된다 (내부 전용은 거절)', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, { tmuxPane: '%28' })

  // 표에 user 로 표시된 것은 그대로 실행된다.
  await t.broker.handleSlackMessage({ user: 'U1', text: ':esc', ts: '9.1', threadTs: s.ack, channel: 'C1' })
  assert.ok(t.tmux.keys.includes('%28:Escape'))

  // 내부 전용(패널 버튼에서만 쓰는 것)은 쳐도 실행되지 않는다.
  const before = t.tmux.keys.length
  await t.broker.handleSlackMessage({ user: 'U1', text: ':mode plan', ts: '9.2', threadTs: s.ack, channel: 'C1' })
  assert.equal(t.tmux.keys.length, before, '내부 명령은 타이핑으로 실행되지 않는다')
  assert.match(t.slack.posts.at(-1)!.text, /없어졌습니다|알 수 없는 명령/)

  // 같은 명령이 패널 버튼 경로로는 동작한다.
  await t.broker.handleAction({ user: 'U1', actionId: 'ctl_x_1', value: '100:exit', messageTs: '', channel: 'C1' })
  assert.ok(t.tmux.keys.includes('%28:/exit⏎'), `버튼 경로는 내부 명령을 실행한다: ${t.tmux.keys}`)
  s.conn.close()
  t.close()
})

test('루트 메시지가 상태줄 역할을 한다', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, { tmuxPane: '%29' })
  const root = t.slack.posts[0]!
  assert.match(root.text, /🟢 \*proj\*/)

  // 모델·effort·권한·컨텍스트를 알게 되면 루트에 붙는다.
  t.tmux.screen = '▝▜██████▀  Sonnet 5 with high effort\n  Context: 42% used\n  ⏵⏵ accept edits on (shift+tab to cycle)\n'
  await t.broker.handleSlackMessage({ user: 'U1', text: ':status', ts: '10.1', threadTs: s.ack, channel: 'C1' })
  await tick(80)
  const line = t.slack.updates.filter((u) => u.ts === root.ts).at(-1)!.text
  assert.match(line, /effort `high`/)
  assert.match(line, /권한 `acceptEdits`/)
  assert.match(line, /컨텍스트 `42%`/)

  // 같은 내용이면 다시 보내지 않는다.
  const before = t.slack.updates.filter((u) => u.ts === root.ts).length
  await t.broker.handleSlackMessage({ user: 'U1', text: ':status', ts: '10.2', threadTs: s.ack, channel: 'C1' })
  await tick(80)
  assert.equal(t.slack.updates.filter((u) => u.ts === root.ts).length, before, '바뀐 게 없으면 갱신하지 않는다')
  s.conn.close()
  t.close()
})

test(':status 는 컨텍스트 사용량을 알려주고 많이 찼으면 표시한다', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, { tmuxPane: '%30' })
  t.tmux.screen = '  Context: 87% used\n  ⏵⏵ auto mode on (shift+tab to cycle)\n'
  await t.broker.handleSlackMessage({ user: 'U1', text: ':status', ts: '11.1', threadTs: s.ack, channel: 'C1' })
  const out = t.slack.posts.at(-1)!.text
  assert.match(out, /컨텍스트 87% ⚠️/, `가득 차가면 경고: ${out}`)
  s.conn.close()
  t.close()
})

test('세션 캔버스: 스레드 기록을 Slack 에서 볼 수 있게 남긴다', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, { tmuxPane: '%31' })
  t.slack.userMessages.push({ ts: '3.5', user: 'U1', text: '이름 지어줘', threadTs: s.ack })
  await hook(t.socketPath, 100, { hook_event_name: 'Stop', last_assistant_message: 'QuantBench 어때요' })

  await t.broker.handleSlackMessage({ user: 'U1', text: ':canvas', ts: '12.1', threadTs: s.ack, channel: 'C1' })
  await tick(80)
  assert.equal(t.slack.canvases.length, 1)
  assert.match(t.slack.canvases[0]!.markdown, /이름 지어줘/, '사용자 말이 들어간다')
  assert.match(t.slack.canvases[0]!.markdown, /QuantBench/, '답도 들어간다')
  assert.match(t.slack.posts.at(-1)!.text, /📄 <https:\/\/slack\.example\/docs\/1\|/)

  // 권한이 없으면 무엇을 해야 하는지 알려준다.
  t.slack.canvasScope = false
  await t.broker.handleSlackMessage({ user: 'U1', text: ':canvas', ts: '12.2', threadTs: s.ack, channel: 'C1' })
  await tick(80)
  assert.match(t.slack.posts.at(-1)!.text, /canvases:write/)
  s.conn.close()
  t.close()
})

test('purge 는 지우기 전에 캔버스로도 남긴다', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, { tmuxPane: '%32' })
  await hook(t.socketPath, 100, { hook_event_name: 'Stop', last_assistant_message: '끝났습니다' })
  s.conn.close()
  await tick(120)
  await t.broker.handleAction({ user: 'U1', actionId: 'ctl_confirm_x', value: '100:purge', messageTs: '', channel: 'C1' })
  await tick(120)
  assert.equal(t.slack.canvases.length, 1, '지우기 전에 캔버스를 만든다')
  assert.match(t.slack.canvases[0]!.markdown, /끝났습니다/)
  assert.match(t.slack.ephemerals.at(-1)!.text, /캔버스로 보기/)
  t.close()
})

test('조용함 시계는 턴 나이가 아니라 침묵 길이를 잰다', async () => {
  const t = await setup({ stallMs: 60, quietMs: 250 })
  const s = await shim(t.socketPath, { tmuxPane: '%33' })
  await hook(t.socketPath, 100, { hook_event_name: 'SessionStart', source: 'startup' }, t.transcript)
  await t.broker.handleSlackMessage({ user: 'U1', text: 'go', ts: '13.1', threadTs: s.ack, channel: 'C1' })
  t.tmux.screen = '⏺ 작업 중\n'

  // 계속 활동하면 침묵이 quietMs 를 넘지 않으므로 알림이 없어야 한다.
  for (let i = 0; i < 4; i++) {
    appendFileSync(t.transcript, assistant({ type: 'text', text: `진행 ${i}` }))
    await tick(120)
  }
  assert.equal(t.slack.posts.filter((p) => /⏳/.test(p.text)).length, 0, '활동 중에는 조용하다고 하지 않는다')

  // 활동이 멈추면 그때부터 재기 시작한다.
  await tick(400)
  assert.equal(t.slack.posts.filter((p) => /⏳/.test(p.text)).length, 1, '멈추면 알린다')
  s.conn.close()
  t.close()
})

test('홈 갱신은 사용자 수와 무관하게 한 번만 만든다', async () => {
  const t = await setup()
  ;(t.broker as unknown as { cfg: { allowedUsers: Set<string> } }).cfg.allowedUsers = new Set(['U1', 'U2', 'U3'])
  const s = await shim(t.socketPath, { tmuxPane: '%34' })
  const before = t.slack.permalinks
  await tick(1300) // refreshHome 디바운스
  assert.equal(t.slack.homeViews.length, 3, '사용자마다 게시한다')
  assert.ok(t.slack.permalinks - before <= 1, `링크 조회는 한 번: ${t.slack.permalinks - before}`)
  s.conn.close()
  t.close()
})

test('/clear 직후의 진짜 종료를 중복으로 삼키지 않는다', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, { tmuxPane: '%35' })
  // /clear 는 세션을 끝내지 않는다. 곧이어 오는 진짜 종료는 처리돼야 한다.
  await hook(t.socketPath, 100, { hook_event_name: 'SessionEnd', reason: 'clear' })
  await hook(t.socketPath, 100, { hook_event_name: 'SessionEnd', reason: 'other' })
  await tick(80)
  assert.ok(
    t.slack.posts.some((p) => /⚫ 세션 종료/.test(p.text)),
    `종료가 전달돼야 한다: ${t.slack.texts().slice(-3)}`,
  )
  t.close()
})

test('/help 처럼 산문인 출력은 표로 만들지 않는다', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, { tmuxPane: '%36' })
  t.tmux.screen = '  이건 도움말 문장입니다  정말로\n  두 번째 문장도  있습니다\n'
  await t.broker.handleSlackMessage({ user: 'U1', text: ':/help', ts: '14.1', threadTs: s.ack, channel: 'C1' })
  const last = t.slack.posts.at(-1)!
  assert.equal(JSON.stringify(last.blocks ?? []).includes('"type":"table"'), false, '산문은 화면 그대로')
  assert.match(last.text, /도움말 문장/)
  s.conn.close()
  t.close()
})

test('질문이 여러 개일 때 하나를 답해도 나머지 버튼이 남는다', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, { tmuxPane: '%37' })
  await hook(t.socketPath, 100, {
    hook_event_name: 'PreToolUse',
    tool_name: 'AskUserQuestion',
    tool_input: {
      questions: [
        { question: '규칙을 어떻게 넣나요?', header: '규칙 입력', options: [{ label: '리포에 커밋' }, { label: '웹에서 작성' }] },
        { question: '실행 흐름은?', header: '실행 흐름', options: [{ label: '큐에 넣기' }, { label: '기다렸다 보기' }] },
        { question: '첫 화면은?', header: '첫 화면', options: [{ label: '실험 목록' }, { label: '새 실험' }] },
      ],
    },
  })
  const card = t.slack.posts.at(-1)!
  const blocks = card.blocks as Array<{ block_id?: string }>
  assert.equal(blocks.filter((b) => /^dlg_q\d+_100$/.test(b.block_id ?? '')).length, 3, '질문 세 개가 각자 블록을 갖는다')

  // 첫 질문에 답한다. Slack 은 현재 블록을 함께 보낸다.
  t.tmux.screen = ' 규칙을 어떻게 넣나요?\n ❯ 1. 리포에 커밋\n   2. 웹에서 작성\n'
  const first = button(card.blocks, 'dlg_answer')
  await t.broker.handleAction({ user: 'U1', ...first, messageTs: card.ts, channel: 'C1', blocks: card.blocks })

  const edited = t.slack.updates.filter((u) => u.ts === card.ts).at(-1)!
  const after = edited.blocks as Array<{ block_id?: string; type?: string }>
  assert.match(JSON.stringify(after), /선택:/, '답한 질문은 선택 결과로 바뀐다')
  assert.equal(
    after.filter((b) => b.block_id === 'dlg_q1_100' || b.block_id === 'dlg_q2_100').filter((b) => b.type === 'actions').length,
    2,
    `나머지 두 질문의 버튼이 남아야 한다: ${JSON.stringify(after.map((b) => [b.block_id, b.type]))}`,
  )
  s.conn.close()
  t.close()
})

test('블록을 모르면 예전처럼 메시지 전체를 결과로 바꾼다', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, { tmuxPane: '%38' })
  await hook(t.socketPath, 100, { hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode', tool_input: {} })
  const plan = t.slack.posts.at(-1)!
  t.tmux.screen = ' Would you like to proceed?\n ❯ 1. Yes\n   2. No\n'
  await t.broker.handleAction({ user: 'U1', ...button(plan.blocks, 'dlg_answer'), messageTs: plan.ts, channel: 'C1' })
  assert.match(t.slack.updates.filter((u) => u.ts === plan.ts).at(-1)!.text, /선택:/)
  s.conn.close()
  t.close()
})

test('세션이 끝내 붙지 못하면 기다리던 메시지를 조용히 버리지 않는다', async () => {
  const t = await setup({ launchTimeoutMs: 60 })
  const dir = tmpdir()
  await t.broker.handleSlackMessage({ user: 'U1', text: `${dir} 시작해줘`, ts: '7.0', channel: 'C1' })
  await t.broker.handleSlackMessage({ user: 'U1', text: '이것도 봐줘', ts: '7.1', threadTs: '7.0', channel: 'C1' })

  // shim 이 끝내 붙지 않는다.
  await tick(150)
  const texts = t.slack.texts()
  assert.ok(
    texts.some((x) => /전달하지 못한 메시지 1개/.test(x)),
    `버렸다는 사실을 알린다: ${texts.slice(-3)}`,
  )
  t.close()
})

test('번호 없는 창도 버튼으로 올린다 (여기서 세션이 조용히 서 있었다)', async () => {
  const t = await setup({ stallMs: 60, quietMs: 100_000 })
  const s = await shim(t.socketPath, { tmuxPane: '%61' })
  await tick(100)

  t.tmux.screen = [
    '  Teach auto mode about your environment?',
    '  Claude Code reads this project and your recent sessions.',
    '  ❯ Also scan shell history   [ ]',
    '    Continue',
    '  ←/→ to change usage · Enter to continue · Esc to cancel',
  ].join('\n')
  await tick(250)

  const posted = t.slack.posts.filter((p) => /입력을 기다립니다/.test(p.text))
  assert.equal(posted.length, 1, `번호가 없어도 떠야 한다: ${t.slack.texts().slice(-2)}`)
  assert.match(JSON.stringify(posted[0]!.blocks), /Teach auto mode/)

  // 두 버튼을 각각 집는다. 같은 버튼을 연달아 누르면 중복 클릭 방지에 먼저 걸려
  // 정작 확인하려는 방어 장치를 지나치게 된다.
  const row = (posted[0]!.blocks as Array<{ type: string; elements?: Array<{ action_id: string; value: string }> }>).find((b) => b.type === 'actions')!
  const buttons = row.elements!.map((e) => ({ actionId: e.action_id, value: e.value }))
  assert.equal(buttons.length, 3, '두 선택지(현재 커서 포함)마다 버튼 + Esc 버튼')
  const enterBtn = buttons[0]!
  const escBtn = buttons.at(-1)!

  const keysBefore = t.tmux.keys.length
  await t.broker.handleAction({ user: 'U1', ...enterBtn!, messageTs: posted[0]!.ts, channel: 'C1' })
  await tick(80)
  assert.ok(t.tmux.keys.length > keysBefore, `키를 보낸다: ${t.tmux.keys.slice(-3)}`)

  // 창이 닫힌 뒤의 늦은 클릭은 프롬프트로 새지 않는다.
  t.tmux.screen = '⏺ 진행 중\n❯ \n'
  const after = t.tmux.keys.length
  await t.broker.handleAction({ user: 'U1', ...escBtn!, messageTs: posted[0]!.ts, channel: 'C1' })
  await tick(80)
  assert.equal(t.tmux.keys.length, after, '이미 닫힌 창의 버튼은 아무것도 보내지 않는다')

  s.conn.close()
  t.close()
})

test('번호 있는 창은 Enter 힌트가 있어도 선택지 버튼으로 올린다', async () => {
  const t = await setup({ stallMs: 60, quietMs: 100_000 })
  const s = await shim(t.socketPath, { tmuxPane: '%62' })
  await tick(100)

  // Enter 힌트가 붙은 번호 창. 새 파서가 이걸 가로채면 선택지가 버튼에서 사라진다.
  t.tmux.screen = [
    '  Restart required',
    '  ❯ 1. Restart now',
    '    2. Later',
    '  Enter to confirm · Esc to cancel',
  ].join('\n')
  await tick(250)

  const asked = t.slack.posts.filter((p) => /선택을 기다립니다/.test(p.text))
  assert.equal(asked.length, 1, `번호 창은 기존 경로로 간다: ${t.slack.texts().slice(-2)}`)
  assert.match(JSON.stringify(asked[0]!.blocks), /Restart now/, '선택지가 버튼으로 남는다')
  assert.equal(t.slack.posts.filter((p) => /입력을 기다립니다/.test(p.text)).length, 0, 'Enter/Esc 두 개짜리로 대체되지 않는다')

  s.conn.close()
  t.close()
})

test('자동으로 넘길 수 있는 창은 버튼으로 올리지 않는다', async () => {
  const t = await setup({ stallMs: 60, quietMs: 100_000 })
  const s = await shim(t.socketPath, { tmuxPane: '%63' })
  await tick(100)

  // model-switch 는 아는 창이고 번호도 있다. Enter 힌트가 붙어 있어도 자동 응답이 먼저다.
  t.tmux.screen = [
    '  Switch model?',
    '  ❯ 1. Yes, switch to Sonnet 5',
    '    2. No, go back',
    '  Enter to confirm · Esc to cancel',
  ].join('\n')
  await tick(250)

  assert.equal(t.slack.posts.filter((p) => /기다립니다/.test(p.text)).length, 0, '사람에게 묻지 않는다')
  assert.ok(t.slack.texts().some((x) => /자동으로 넘겼습니다/.test(x)), `자동으로 넘긴다: ${t.slack.texts().slice(-2)}`)

  s.conn.close()
  t.close()
})

test('턴이 없어도 다이얼로그는 계속 감시한다 (재시작 후 이어지는 질문)', async () => {
  const t = await setup({ stallMs: 60, quietMs: 100_000 })
  // 브로커 재시작 직후처럼, 진행 중인 턴 없이 붙은 세션.
  const s = await shim(t.socketPath, { tmuxPane: '%39' })
  await tick(100)

  // 첫 질문이 뜬다.
  t.tmux.screen = ' 규칙 충돌은?\n ❯ 1. 먼저 쓴 것\n   2. 전부 실행\n'
  await tick(200)
  const first = t.slack.posts.filter((p) => /선택을 기다립니다/.test(p.text))
  assert.equal(first.length, 1, `턴이 없어도 떠야 한다: ${t.slack.texts().slice(-2)}`)

  // 답하면 터미널이 다음 질문으로 넘어간다. 그것도 떠야 한다.
  await t.broker.handleAction({ user: 'U1', ...button(first[0]!.blocks, 'dlg_answer'), messageTs: first[0]!.ts, channel: 'C1', blocks: first[0]!.blocks })
  t.tmux.screen = ' 규칙은 몇 개까지?\n ❯ 1. 제한 없음\n   2. 다섯 개까지\n'
  await tick(250)
  const all = t.slack.posts.filter((p) => /선택을 기다립니다/.test(p.text))
  assert.equal(all.length, 2, `다음 질문도 떠야 한다: ${all.map((p) => JSON.stringify(p.blocks).slice(0, 60))}`)
  assert.match(JSON.stringify(all[1]!.blocks), /규칙은 몇 개까지/)

  // 다이얼로그가 없으면 조용하다.
  t.tmux.screen = '⏺ 진행 중\n❯ \n'
  const before = t.slack.posts.length
  await tick(250)
  assert.equal(t.slack.posts.length, before, '할 말이 없으면 아무것도 올리지 않는다')
  s.conn.close()
  t.close()
})

test('할 일은 plan 블록으로, Slack 이 거부하면 글자로 되돌아간다', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, { tmuxPane: '%40' })
  await hook(t.socketPath, 100, { hook_event_name: 'SessionStart', source: 'startup' }, t.transcript)
  await t.broker.handleSlackMessage({ user: 'U1', text: 'go', ts: '15.1', threadTs: s.ack, channel: 'C1' })
  const write = (todos: unknown[], id: string) => assistant({ type: 'tool_use', id, name: 'TodoWrite', input: { todos } })

  appendFileSync(t.transcript, write([{ content: '스키마', status: 'in_progress', activeForm: '스키마 정리 중' }, { content: '핸들러', status: 'pending' }], 'p1'))
  await tick(150)
  const card = t.slack.posts.filter((p) => /할 일/.test(p.text)).at(-1)!
  const plan = (card.blocks as Array<{ type: string }>)[0]!
  assert.equal(plan.type, 'plan', `plan 블록으로 보낸다: ${JSON.stringify(card.blocks)}`)
  assert.match(card.text, /할 일 0\/2/, '알림 본문은 글자로 남는다')

  // 클라이언트가 블록을 거부하면 같은 내용을 글자로 다시 보낸다.
  t.slack.rejectBlocks = true
  appendFileSync(t.transcript, toolResult('p1', 'ok'))
  appendFileSync(t.transcript, write([{ content: '스키마', status: 'completed' }, { content: '핸들러', status: 'in_progress', activeForm: '핸들러 작성 중' }], 'p2'))
  await tick(200)
  const retried = t.slack.updates.filter((u) => u.ts === card.ts).at(-1)!
  assert.equal(retried.blocks, undefined, '블록 없이 다시 보낸다')
  assert.match(retried.text, /할 일 1\/2/, '내용은 그대로 전달된다')
  s.conn.close()
  t.close()
})

test('재부팅으로 죽은 세션을 원래 스레드에 대화 그대로 되살린다', async () => {
  const revivePath = join(tmpdir(), `cs-live-${process.pid}-${Math.random().toString(36).slice(2)}.json`)
  const t = await setup({ revivePath })
  const s = await shim(t.socketPath, { tmuxPane: '%51', sessionId: 'sess-abc', cwd: '/home/u/proj' })
  t.broker.saveState()

  // 기계가 내려가 세션 프로세스까지 사라진다. 시늉만 하는 게 아니라 붙을 수 있는 게 하나도 없는 상태다.
  s.conn.close()
  t.close()
  await tick(80)

  const t2 = await setup({ revivePath, reviveAfterMs: 20 })
  await t2.broker.reviveSessions()

  const launched = t2.tmux.launches.at(-1)
  assert.ok(launched, '세션을 다시 띄운다')
  assert.ok(launched!.command.includes('--resume'), `대화를 이어서 연다: ${launched!.command.join(' ')}`)
  assert.ok(launched!.command.includes('sess-abc'), `원래 세션을 지목한다: ${launched!.command.join(' ')}`)
  assert.equal(launched!.cwd, '/home/u/proj')
  // 새 스레드를 파지 않는다: 원래 스레드에 그대로 올라온다.
  assert.ok(
    t2.slack.posts.some((p) => p.threadTs === s.ack && /재시작으로 끊긴 세션/.test(p.text)),
    `원래 스레드에 알린다: ${JSON.stringify(t2.slack.posts.map((p) => [p.threadTs, p.text.slice(0, 30)]))}`,
  )
  t2.close()
})

test('브로커만 재시작해 세션이 스스로 돌아오면 다시 띄우지 않는다', async () => {
  const revivePath = join(tmpdir(), `cs-live-${process.pid}-${Math.random().toString(36).slice(2)}.json`)
  const t = await setup({ revivePath })
  const s = await shim(t.socketPath, { tmuxPane: '%52', sessionId: 'sess-xyz', cwd: '/home/u/proj' })
  t.broker.saveState()
  s.conn.close()
  t.close()
  await tick(80)

  // 이번엔 프로세스가 살아 있어서 shim 이 스스로 다시 붙는다.
  const t2 = await setup({ revivePath, reviveAfterMs: 20 })
  await shim(t2.socketPath, { tmuxPane: '%52', sessionId: 'sess-xyz', cwd: '/home/u/proj', threadTs: s.ack })
  await t2.broker.reviveSessions()

  assert.equal(t2.tmux.launches.length, 0, `스스로 돌아온 세션을 중복으로 띄우지 않는다: ${JSON.stringify(t2.tmux.launches)}`)
  t2.close()
})

test('정상 종료한 세션은 되살리지 않는다', async () => {
  const revivePath = join(tmpdir(), `cs-live-${process.pid}-${Math.random().toString(36).slice(2)}.json`)
  const t = await setup({ revivePath })
  const s = await shim(t.socketPath, { tmuxPane: '%53', sessionId: 'sess-done', cwd: '/home/u/proj' })
  t.broker.saveState()
  // 세션이 스스로 끝난다 (연결이 끊기면 브로커가 종료로 처리한다).
  s.conn.close()
  await tick(120)
  t.broker.saveState()
  t.close()
  await tick(80)

  const t2 = await setup({ revivePath, reviveAfterMs: 20 })
  await t2.broker.reviveSessions()
  assert.equal(t2.tmux.launches.length, 0, `끝낸 세션은 그대로 둔다: ${JSON.stringify(t2.tmux.launches)}`)
  t2.close()
})

test(':refresh 는 같은 스레드에서 대화 그대로 세션을 다시 연다', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, { tmuxPane: '%51', sessionId: 'sess-refresh', cwd: '/home/u/proj' })
  const panelTs = t.slack.posts.find((p) => JSON.stringify(p.blocks ?? []).includes('"ctl_'))?.ts

  await t.broker.handleSlackMessage({ user: 'U1', text: ':refresh', ts: '9.1', threadTs: s.ack, channel: 'C1' })
  assert.ok(t.tmux.keys.includes('%51:kill'), `프로세스를 내린다: ${t.tmux.keys}`)

  // 내려간 뒤 뜨기 전에 쓴 글을 버리거나 "종료되었습니다" 로 답하지 않는다.
  await t.broker.handleSlackMessage({ user: 'U1', text: '그동안 이것도', ts: '9.2', threadTs: s.ack, channel: 'C1' })
  assert.ok(!t.slack.texts().some((x) => /종료되었습니다/.test(x)), `posts: ${t.slack.texts()}`)

  // 프로세스가 사라지면 같은 대화로 다시 뜬다.
  s.conn.close()
  await tick(150)
  const launched = t.tmux.launches.at(-1)!
  assert.deepEqual(launched.command, ['/bin/claude-slack', '--resume', 'sess-refresh'])
  assert.equal(launched.env.CLAUDE_SLACK_THREAD_TS, s.ack, '새 스레드를 파지 않는다')
  assert.ok(!t.slack.texts().some((x) => x.startsWith('⚫ 세션')), `종료로 알리지 않는다: ${t.slack.texts()}`)
  assert.ok(panelTs && t.slack.deleted.includes(panelTs), '죽은 pid 를 가리키는 낡은 패널은 지운다')

  // 새 세션이 붙으면 그 사이에 쓴 글이 전달된다.
  const s2 = await shim(t.socketPath, { pid: 101, tmuxPane: '%9', sessionId: 'sess-refresh', cwd: '/home/u/proj', threadTs: s.ack })
  await tick(150)
  assert.ok(JSON.stringify(s2.inbox).includes('그동안 이것도'), `들고 있던 메시지를 넘긴다: ${JSON.stringify(s2.inbox)}`)
  t.close()
})

test('되살리지 않은 세션은 그 스레드에 글을 쓰면 깨어난다', async () => {
  const revivePath = join(tmpdir(), `cs-live-${process.pid}-${Math.random().toString(36).slice(2)}.json`)
  const now = Date.now()
  const entry = (i: number, lastSeen: number) => ({ sessionId: `sess-${i}`, cwd: '/home/u/proj', threadTs: `50.${i}`, recipient: 'U1', lastSeen })
  // 일곱 개가 살아 있다가 기계가 꺼졌고, 하나(9)는 그보다 한 시간 전에 이미 끊겨 있었다.
  const live: Record<string, unknown> = { 'key-9': entry(9, now - 60 * 60 * 1000) }
  for (let i = 1; i <= 7; i++) live[`key-${i}`] = entry(i, now - i * 1000)
  writeFileSync(revivePath, JSON.stringify(live))

  const t = await setup({ revivePath, reviveAfterMs: 20 })
  await t.broker.reviveSessions()
  const resumed = () => t.tmux.launches.map((l) => l.command[l.command.indexOf('--resume') + 1])
  assert.deepEqual(resumed(), ['sess-1', 'sess-2', 'sess-3', 'sess-4', 'sess-5'], '가장 최근 다섯 개만 바로 띄운다')

  // 밀려난 스레드에 글을 쓰면 "연결된 세션이 없습니다" 대신 그 세션이 대화 그대로 열린다.
  await t.broker.handleSlackMessage({ user: 'U1', text: '이어서 하자', ts: '50.61', threadTs: '50.6', channel: 'C1' })
  assert.equal(resumed().at(-1), 'sess-6')
  assert.ok(!t.slack.texts().some((x) => /연결된 세션이 없습니다/.test(x)), `posts: ${t.slack.texts()}`)
  assert.ok(t.slack.posts.some((p) => p.threadTs === '50.6' && /다시 엽니다/.test(p.text)))

  // 꺼지기 한참 전에 끊긴 세션은 재부팅 때 멋대로 띄우지 않지만, 찾아오면 깨운다.
  assert.ok(!resumed().includes('sess-9'))
  await t.broker.handleSlackMessage({ user: 'U1', text: '여기도', ts: '50.91', threadTs: '50.9', channel: 'C1' })
  assert.equal(resumed().at(-1), 'sess-9')

  // 한 번 깨운 스레드를 또 띄우지 않는다.
  const count = t.tmux.launches.length
  await t.broker.handleSlackMessage({ user: 'U1', text: '하나 더', ts: '50.62', threadTs: '50.6', channel: 'C1' })
  assert.equal(t.tmux.launches.length, count)
  t.close()
})

test('재시작해도 그 사이 나온 출력을 건너뛰지 않는다', async () => {
  const offsetsPath = join(tmpdir(), `cs-offsets-${process.pid}-${Math.random().toString(36).slice(2)}.json`)
  const t = await setup({ offsetsPath })
  const s = await shim(t.socketPath, { tmuxPane: '%41' })
  await hook(t.socketPath, 100, { hook_event_name: 'SessionStart', source: 'startup' }, t.transcript)
  await t.broker.handleSlackMessage({ user: 'U1', text: 'go', ts: '16.1', threadTs: s.ack, channel: 'C1' })
  appendFileSync(t.transcript, assistant({ type: 'text', text: '첫 번째 답' }))
  await tick(150)
  t.broker.saveState()
  s.conn.close()
  t.close()
  await tick(80)

  // 브로커가 내려간 사이에 답이 더 쌓인다.
  appendFileSync(t.transcript, assistant({ type: 'text', text: '내려간 사이에 나온 답' }))

  // 같은 세션으로 새 브로커가 뜬다.
  const t2 = await setup({ offsetsPath, transcript: t.transcript })
  const logs: string[] = []
  t2.broker.log = (m: string) => logs.push(m)
  const s2 = await shim(t2.socketPath, { tmuxPane: '%41' })
  await hook(t2.socketPath, 100, { hook_event_name: 'SessionStart', source: 'startup' }, t2.transcript)
  await tick(250)

  const seen = JSON.stringify(t2.slack.streams.flatMap((x) => x.chunks)) + JSON.stringify(t2.slack.texts())
  assert.match(seen, /내려간 사이에 나온 답/, `재시작 중 출력이 살아나야 한다: ${seen.slice(0, 200)} | 로그: ${logs.join(' / ')}`)
  assert.ok(!/첫 번째 답/.test(seen), '이미 보낸 것을 다시 보내지는 않는다')
  s2.conn.close()
  t2.close()
})

test('/ccrefresh: 세션이 하나면 바로 새로고침하고, 여럿이면 고르게 한다', async () => {
  const t = await setup()
  await t.broker.handleCommand({ user: 'U1', name: 'refresh', text: '', channel: 'C1', triggerId: 'trig' })
  assert.match(t.slack.ephemerals.at(-1)!.text, /새로고침할 수 있는 세션이 없습니다/)

  await shim(t.socketPath, { tmuxPane: '%61', sessionId: 'sess-a', cwd: '/home/u/a' })
  await t.broker.handleCommand({ user: 'U1', name: 'refresh', text: '', channel: 'C1', triggerId: 'trig' })
  assert.ok(t.tmux.keys.includes('%61:kill'), `하나뿐이면 바로 내린다: ${t.tmux.keys}`)
  t.close()

  const t2 = await setup()
  await shim(t2.socketPath, { pid: 162, tmuxPane: '%62', sessionId: 'sess-b', cwd: '/home/u/b' })
  await shim(t2.socketPath, { pid: 163, tmuxPane: '%63', sessionId: 'sess-c', cwd: '/home/u/c' })
  await tick(50)
  await t2.broker.handleCommand({ user: 'U1', name: 'refresh', text: '', channel: 'C1', triggerId: 'trig' })
  assert.ok(!t2.tmux.keys.some((k) => k.endsWith(':kill')), `여럿이면 고르기 전에는 아무것도 내리지 않는다: ${t2.tmux.keys}`)
  assert.match(JSON.stringify(t2.slack.ephemerals.at(-1)!.blocks), /ctl_more.*:refresh|:refresh/)
  t2.close()
})

test('어드민 스레드 삭제: 실행 중이면 /exit 로 종료하고, tmux 밖 세션과 없는 세션은 거부한다', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, { pid: 171, tmuxPane: '%71', sessionId: 'sess-purge', cwd: '/home/u/proj' })
  await tick(50)
  const r = await t.broker.adminPurge(171)
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.match(r.note, /종료하는 중/)
  assert.ok(t.tmux.keys.includes('%71:/exit⏎'), `/exit 를 보낸다: ${t.tmux.keys}`)

  assert.equal((await t.broker.adminPurge(999999)).ok, false, 'unknown session')

  const outside = await shim(t.socketPath, { pid: 172, sessionId: 'sess-nopane', cwd: '/home/u/other' })
  await tick(50)
  const r2 = await t.broker.adminPurge(172)
  assert.equal(r2.ok, false, 'no tmux pane')
  assert.match(r2.note, /tmux 밖/)
  void s
  void outside
  t.close()
})

test('어드민 이어서 하기: 목록에 있는 세션만 resume 으로 띄운다', async () => {
  const t = await setup({ listSessions: () => [{ id: 'sess-1', cwd: tmpdir(), title: '테스트 수정', mtime: 1, when: '5분 전' }] })
  const r = await t.broker.adminResume('sess-1')
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.deepEqual(t.tmux.launches.at(-1)!.command, ['/bin/claude-slack', '--resume', 'sess-1'])
  const before = t.tmux.launches.length
  assert.equal((await t.broker.adminResume('nope')).ok, false)
  assert.equal(t.tmux.launches.length, before, 'unknown id launches nothing')
  t.close()
})

test('어드민 이어서 하기: 보관된 세션의 id 로도 같은 대화를 다시 연다', async () => {
  const { writeArchive } = await import('../src/archive.ts')
  const t = await setup({ listSessions: () => [] })
  writeArchive({ key: 'k', sessionId: 'arch-sess', cwd: tmpdir(), title: '보관된 것', threadTs: '1.0', origin: 'slack', archivedAt: '2026-09-24T00:00:00Z', messages: [] }, t.archiveDir)
  const r = await t.broker.adminResume('arch-sess')
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.deepEqual(t.tmux.launches.at(-1)!.command, ['/bin/claude-slack', '--resume', 'arch-sess'])
  t.close()
})

test('어드민 저장된 대화 삭제: 목록에 있는 것만, 실행 중인 세션은 거부한다', async () => {
  const removed: string[] = []
  const t = await setup({
    listSessions: () => [
      { id: 'old-1', cwd: tmpdir(), title: '옛 대화', mtime: 1, when: '1일 전' },
      { id: 'sess-live', cwd: tmpdir(), title: '지금 대화', mtime: 2, when: '방금' },
    ],
    deleteSession: async (id: string) => (removed.push(id), true),
  })
  await shim(t.socketPath, { pid: 181, tmuxPane: '%81', sessionId: 'sess-live', cwd: tmpdir() })
  await tick(50)
  assert.equal((await t.broker.adminDeleteRecent('old-1')).ok, true)
  assert.deepEqual(removed, ['old-1'])
  const live = await t.broker.adminDeleteRecent('sess-live')
  assert.equal(live.ok, false)
  assert.match(live.note, /실행 중/)
  assert.equal((await t.broker.adminDeleteRecent('not-listed')).ok, false)
  assert.deepEqual(removed, ['old-1'], 'nothing else was deleted')
  t.close()
})

test('잔재 스레드: 살아 있는 세션·채널 입구·사람이 쓴 글은 빼고, 끊긴 것과 기록 없는 것만 찾아 정리한다', async () => {
  const { NEW_SESSION_BLOCK_ID } = await import('../src/panel.ts')
  const t = await setup()
  const s = await shim(t.socketPath, { pid: 191, tmuxPane: '%91', sessionId: 'sess-orphan', cwd: '/home/u/proj' })
  await tick(50)
  // a leftover thread nothing knows about, with one reply
  t.slack.posts.push({ ts: '50.001', text: '👻 옛 세션 · 종료됨' }, { ts: '50.002', text: '남은 답글', threadTs: '50.001' })
  // the channel's "new session" entry, and a thread a person started: neither is ours to clean up
  t.slack.posts.push({ ts: '51.001', text: '새 세션', blocks: [{ type: 'actions', block_id: NEW_SESSION_BLOCK_ID }] })
  t.slack.userMessages.push({ ts: '52.001', user: 'U1', text: '사람이 시작한 글' })

  let orphans = await t.broker.adminOrphans(true)
  assert.deepEqual(orphans.map((o) => [o.ts, o.kind]), [['50.001', 'unknown']], 'the running session, the entry and the person\'s post are left out')
  assert.equal(orphans[0]!.replies, 1)

  // once the session ends, its thread is a leftover too
  s.conn.close()
  await tick(150)
  orphans = await t.broker.adminOrphans(true)
  assert.deepEqual(orphans.map((o) => [o.ts, o.kind]).sort(), [['50.001', 'unknown'], [s.ack, 'ended']].sort())

  const started = await t.broker.adminPurgeOrphan('50.001')
  assert.equal(started.ok, true, JSON.stringify(started))
  await until(() => t.slack.deleted.includes('50.001'), 'the leftover thread is deleted, root last')
  assert.ok(t.slack.deleted.includes('50.002'))
  assert.ok(t.slack.deleted.indexOf('50.002') < t.slack.deleted.indexOf('50.001'), 'replies before the root')
  assert.equal((await t.broker.adminPurgeOrphan('99.999')).ok, false, 'a thread that is not a leftover is refused')
  t.close()
})

test(':screen 은 터미널 화면을 이미지로 올리고, 그릴 수 없으면 텍스트로 대신한다', async () => {
  const { existsSync } = await import('node:fs')
  const t = await setup({ screenImages: true, renderScreen: async () => Buffer.from('PNG') })
  const s = await shim(t.socketPath, { tmuxPane: '%5' })
  t.tmux.screen = '● 작업 결과입니다\n  요약 한 줄\n'
  await t.broker.handleSlackMessage({ user: 'U1', text: ':screen', ts: '7.1', threadTs: s.ack, channel: 'C1' })
  await tick(80)
  assert.equal(t.slack.uploads.length, 1, '이미지 한 장')
  assert.equal(t.slack.uploads[0]!.text, '터미널 화면')
  assert.match(t.slack.uploads[0]!.paths[0]!, /screen-\d+\.png$/)
  assert.ok(!existsSync(t.slack.uploads[0]!.paths[0]!), '올린 뒤 임시 파일은 지운다')
  assert.ok(!t.slack.posts.some((p) => p.text.includes('```')), '텍스트 화면은 올리지 않는다')
  assert.deepEqual(t.tmux.growths, ['%5:80'], '아무도 보고 있지 않은 창은 80줄로 키워서 더 많은 맥락을 담는다')
  t.close()

  const f = await setup({ screenImages: true, renderScreen: async () => { throw new Error('no browser') } })
  const s2 = await shim(f.socketPath, { tmuxPane: '%6' })
  f.tmux.screen = '● 작업 결과입니다\n'
  await f.broker.handleSlackMessage({ user: 'U1', text: ':screen', ts: '7.2', threadTs: s2.ack, channel: 'C1' })
  await tick(80)
  assert.equal(f.slack.uploads.length, 0)
  assert.ok(f.slack.posts.some((p) => p.text.includes('```') && p.text.includes('작업 결과입니다')), '렌더링에 실패하면 예전처럼 텍스트로')
  f.close()
})

test('새 출력이 없다는 알림은 처음에만 화면을 이미지로 올리고, 이후에는 시간만 갱신한다', async () => {
  const t = await setup({ stallMs: 60, quietMs: 60, screenImages: true, renderScreen: async () => Buffer.from('PNG') })
  const s = await shim(t.socketPath, { tmuxPane: '%22' })
  await hook(t.socketPath, 100, { hook_event_name: 'SessionStart', source: 'startup' }, t.transcript)
  await t.broker.handleSlackMessage({ user: 'U1', text: 'go', ts: '4.1', threadTs: s.ack, channel: 'C1' })
  t.tmux.screen = '● 잠깐 멈춘 화면입니다\n'
  await tick(300)
  assert.equal(t.slack.uploads.length, 1, '처음 한 번만 이미지')
  assert.match(t.slack.uploads[0]!.text ?? '', /새 출력이 없습니다/)
  await tick(300)
  assert.equal(t.slack.uploads.length, 1, '이후에는 새 이미지를 올리지 않는다')
  const notice = t.slack.posts.find((p) => p.threadTs === s.ack && /⏳/.test(p.text))!
  assert.ok(!notice.text.includes('```'), '알림에는 텍스트 화면을 넣지 않는다')
  assert.match(notice.text, /위 이미지/)
  s.conn.close()
  t.close()
})

test(':screen 은 오른쪽 패널이 있으면 대화와 패널을 그림 두 장으로 한 메시지에 올린다', async () => {
  const { existsSync } = await import('node:fs')
  const t = await setup({
    screenImages: true,
    renderScreen: async () => [
      { part: 'conversation' as const, png: Buffer.from('A') },
      { part: 'panel' as const, png: Buffer.from('B') },
    ],
  })
  const s = await shim(t.socketPath, { tmuxPane: '%7' })
  t.tmux.screen = '● 대화\n'
  await t.broker.handleSlackMessage({ user: 'U1', text: ':screen', ts: '7.3', threadTs: s.ack, channel: 'C1' })
  await tick(80)
  assert.equal(t.slack.uploads.length, 1, '한 메시지')
  const [upload] = t.slack.uploads
  assert.equal(upload!.paths.length, 2)
  assert.match(upload!.paths[0]!, /screen-\d+-conversation\.png$/)
  assert.match(upload!.paths[1]!, /screen-\d+-panel\.png$/)
  assert.match(upload!.text ?? '', /두 장/)
  assert.ok(upload!.paths.every((p) => !existsSync(p)), '올린 뒤 임시 파일은 모두 지운다')
  t.close()
})

test('같은 대화를 이미 실행 중이면 이어서 하기는 새로 띄우지 않고, 이어서 목록에서도 빠진다', async () => {
  const t = await setup({ listSessions: () => [{ id: 'sess-dup', cwd: tmpdir(), title: '중복', mtime: 1, when: '방금' }, { id: 'sess-free', cwd: tmpdir(), title: '한가한 대화', mtime: 0, when: '어제' }] })
  await shim(t.socketPath, { pid: 201, tmuxPane: '%d1', sessionId: 'sess-dup', cwd: tmpdir() })
  await tick(50)
  const before = t.tmux.launches.length

  // 어드민 페이지의 버튼
  const r = await t.broker.adminResume('sess-dup')
  assert.equal(r.ok, false)
  assert.match(r.note, /이미 실행 중인 대화/)
  // Slack 의 /ccresume <id>
  await t.broker.handleCommand({ user: 'U1', name: 'resume', text: 'sess-dup', channel: 'C1', triggerId: 'x' })
  assert.match(t.slack.ephemerals.at(-1)!.text, /이미 실행 중인 대화/)
  // 선택 메뉴에서 고른 경우 (launchSession 이 마지막 관문이다)
  await t.broker.launchSession({ cwd: tmpdir(), prompt: '', resumeId: 'sess-dup', user: 'U1' })
  assert.equal(t.tmux.launches.length, before, '어느 길로도 두 번째 프로세스는 뜨지 않는다')

  const state = await t.broker.adminState()
  assert.deepEqual(state.recent.map((x) => x.id), ['sess-free'], '실행 중인 대화는 이어서 목록에 없다')
  t.close()
})

test('뜨는 중인 대화를 연달아 이어서 하기 해도 한 번만 뜬다', async () => {
  const t = await setup({ listSessions: () => [{ id: 'sess-x', cwd: tmpdir(), title: 'x', mtime: 1, when: '방금' }] })
  const a = await t.broker.adminResume('sess-x')
  const b = await t.broker.adminResume('sess-x')
  assert.equal(a.ok, true, JSON.stringify(a))
  assert.equal(b.ok, false, '아직 뜨는 중이어도 두 번째는 거절한다')
  assert.equal(t.tmux.launches.length, 1)
  t.close()
})

test('스레드만 남은 대화는 이어서 목록에서 빠지고, 잔재 탭에서 그 스레드 안에서 다시 열린다', async () => {
  const t = await setup({ listSessions: () => [{ id: 'sess-left', cwd: tmpdir(), title: '끊긴 대화', mtime: 1, when: '방금' }] })
  const s = await shim(t.socketPath, { pid: 202, tmuxPane: '%d2', sessionId: 'sess-left', cwd: tmpdir() })
  await tick(50)
  s.conn.close()
  await tick(150)

  const orphans = await t.broker.adminOrphans(true)
  const mine = orphans.find((o) => o.ts === s.ack)!
  assert.deepEqual([mine.kind, mine.sessionId], ['ended', 'sess-left'], '끝난 세션의 스레드는 어떤 대화였는지 안다')
  const state = await t.broker.adminState()
  assert.ok(!state.recent.some((x) => x.id === 'sess-left'), '스레드가 남아 있는 대화는 이어서 목록에 없다')

  const roots = () => t.slack.posts.filter((p) => !p.threadTs).length
  const before = { launches: t.tmux.launches.length, roots: roots() }
  const r = await t.broker.adminResumeOrphan(s.ack)
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(t.tmux.launches.length, before.launches + 1)
  const launched = t.tmux.launches.at(-1)!
  assert.deepEqual(launched.command.slice(-2), ['--resume', 'sess-left'])
  assert.equal(launched.env.CLAUDE_SLACK_THREAD_TS, s.ack, '새 스레드를 만들지 않고 같은 스레드에서 연다')
  assert.equal(roots(), before.roots, '새 루트 메시지도 없다')

  // 기록이 없는 스레드는 이어서 할 수 없고, 이유를 말한다
  t.slack.posts.push({ ts: '60.001', text: '👻 옛 스레드' })
  await t.broker.adminOrphans(true)
  const none = await t.broker.adminResumeOrphan('60.001')
  assert.equal(none.ok, false)
  assert.match(none.note, /이어서 할 대화 정보가 없는/)
  t.close()
})

test('스레드 열기: 스레드의 마지막 댓글로 이동하는 링크를 만든다', async () => {
  const t = await setup()
  t.slack.userMessages.push({ ts: '5.1', user: 'U1', text: '루트', threadTs: undefined }, { ts: '5.3', user: 'U1', text: '마지막', threadTs: '5.1' }, { ts: '5.2', user: 'U1', text: '중간', threadTs: '5.1' })
  assert.equal(await t.broker.adminThreadLink('5.1'), 'https://slack.example/5.3')
  assert.equal(await t.broker.adminThreadLink('9.9'), 'https://slack.example/9.9', '댓글이 없으면 루트 링크')
  assert.equal(await t.broker.adminThreadLink('../x'), undefined, 'ts 모양이 아니면 거절')
})

test('로컬 명령의 출력과 오류는 스레드에 올라오고, 화면으로 이미 보여준 명령은 다시 올리지 않는다', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, { tmuxPane: '%3' })
  await hook(t.socketPath, 100, { hook_event_name: 'SessionStart', source: 'startup' }, t.transcript)
  const local = (tag: string, text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: `<local-command-${tag}>${text}</local-command-${tag}>` } }) + '\n'
  appendFileSync(t.transcript, local('stdout', 'Set model to `Sonnet 5`'))
  await until(() => t.slack.posts.some((p) => p.threadTs === s.ack && p.text.includes('Set model to')), '출력이 스레드에 올라온다')
  appendFileSync(t.transcript, local('stderr', 'Unknown command: /x'))
  await until(() => t.slack.posts.some((p) => p.threadTs === s.ack && p.text.includes('명령 오류') && p.text.includes('Unknown command')), '오류도 올라온다')
  appendFileSync(t.transcript, local('stdout', '   '))
  await tick()
  assert.equal(t.slack.posts.filter((p) => p.text.includes('```')).length, 2, '빈 출력은 올리지 않는다')
})

test('스레드 열기 링크: 한 번의 조회로 마지막 댓글을 찾고, 링크 주소는 처음 한 번만 Slack 에 묻는다', async () => {
  const t = await setup()
  t.slack.userMessages.push({ ts: '5.1', user: 'U1', text: '루트' }, { ts: '5.3', user: 'U1', text: '마지막', threadTs: '5.1' })
  let asked = 0
  t.slack.permalink = async (ts: string) => (asked++, `https://ws.slack.com/archives/C1/p${ts.replace('.', '')}`)
  assert.equal(await t.broker.adminThreadLink('5.1'), 'https://ws.slack.com/archives/C1/p53')
  const again = await t.broker.adminThreadLink('5.1')
  assert.match(again ?? '', /^https:\/\/ws\.slack\.com\/archives\/C1\/p53\?thread_ts=5\.1&cid=/)
  assert.equal(asked, 1, '주소 모양을 배운 뒤에는 permalink 를 묻지 않는다')
  assert.equal(t.slack.latestCalls, 2)
})

test('실행 중 세션의 스레드 링크는 오간 마지막 메시지를 가리키고, 그때그때 갱신된다', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, { tmuxPane: '%3' })
  t.slack.permalink = async (ts: string) => `https://ws.slack.com/archives/C1/p${ts.replace('.', '')}`
  await t.broker.adminState() // learns the link's shape in the background
  await tick()
  const linkOf = async () => (await t.broker.adminState()).live.find((x) => x.threadTs === s.ack)?.link ?? ''
  await t.slack.post({ text: '답', threadTs: s.ack })
  assert.match(await linkOf(), /\?thread_ts=/, '봇이 쓴 메시지가 기록되어 스레드 맨 위가 아니라 그 메시지를 가리킨다')
  await t.broker.handleSlackMessage({ user: 'U1', text: '안녕', ts: '99999.5', threadTs: s.ack, channel: 'C1' })
  assert.match(await linkOf(), /\/archives\/C1\/p999995\?thread_ts=/, '내가 보낸 메시지도 반영된다')
})

test('기록 보기: 실행 중인 세션의 스레드도 Slack 대화를 채팅처럼 보여준다', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, { tmuxPane: '%3' })
  await t.broker.handleSlackMessage({ user: 'U1', text: '안녕', ts: '99999.5', threadTs: s.ack, channel: 'C1' })
  t.slack.userMessages.push({ ts: '99999.5', user: 'U1', text: '안녕', threadTs: s.ack })
  const view = await t.broker.adminOrphanThread(s.ack)
  assert.ok(view, '실행 중인 스레드도 열린다')
  assert.ok(view!.messages.some((m) => m.text === '안녕'))
  assert.equal(await t.broker.adminOrphanThread('123.456'), undefined, '모르는 스레드는 없다')
})

test('관리 페이지 상태: tmux 창을 읽을 수 있는 세션은 canScreen 으로 알린다', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, { tmuxPane: '%3' })
  const live = (await t.broker.adminState()).live.find((x) => x.threadTs === s.ack)
  assert.equal(live?.canScreen, true)
  s.conn.close()
  t.close()
})

test('이어서 하기 선택 상자: ~ 로 줄인 경로를 홈으로 펼쳐서 띄운다 (SPEC REQ-F-074 §4단계)', async () => {
  const { encodeResume } = await import('../src/actions.ts')
  const home = process.env.HOME ?? '/Users/u'
  const t = await setup({ listSessions: () => [{ id: 'sess-1', cwd: `${home}/projects/my-long-project-name`, title: '제목', mtime: 1, when: '5분 전' }] })
  await t.broker.handleAction({ user: 'U1', actionId: 'ctl_resume', value: encodeResume('sess-1', `${home}/projects/my-long-project-name`), messageTs: 'm1', channel: 'C1' })
  await tick()
  assert.equal(t.tmux.launches.at(-1)?.cwd, `${home}/projects/my-long-project-name`, '~ 는 홈으로 펼친다')
  t.close()
})

test('이어서 하기 선택 상자: 길이 제한으로 잘린(…) 경로는 최근 목록에서 같은 id 의 실제 cwd 를 찾아 쓴다 (SPEC REQ-F-074 §4단계)', async () => {
  const home = process.env.HOME ?? '/Users/u'
  const t = await setup({ listSessions: () => [{ id: 'sess-2', cwd: `${home}/projects/my-long-project-name`, title: '제목', mtime: 1, when: '5분 전' }] })
  await t.broker.handleAction({ user: 'U1', actionId: 'ctl_resume', value: 'resume:sess-2:…ng-project-name', messageTs: 'm1', channel: 'C1' })
  await tick()
  assert.equal(t.tmux.launches.at(-1)?.cwd, `${home}/projects/my-long-project-name`, '잘린 경로는 목록에서 실제 경로를 찾는다')
  t.close()
})

test('이어서 하기 선택 상자: 잘린 경로인데 목록에 없으면 누른 사람에게만 알리고 세션을 안 띄운다', async () => {
  const t = await setup({ listSessions: () => [] })
  await t.broker.handleAction({ user: 'U1', actionId: 'ctl_resume', value: 'resume:sess-missing:…one', messageTs: 'm1', channel: 'C1' })
  await tick()
  assert.equal(t.tmux.launches.length, 0)
  assert.ok(t.slack.ephemerals.some((e) => e.text.includes('이어서 할 수 있는 세션 목록에 없습니다')))
})

test('주입 확인: Enter 로 다시 거는 재시도는 횟수가 이어져 3번째에서 멈춘다 (SPEC REQ-F-013 §3단계·경계값)', async () => {
  const t = await setup({ injectVerifyMs: 20 })
  const s = await shim(t.socketPath, { tmuxPane: '%3' })
  await hook(t.socketPath, 100, { hook_event_name: 'SessionStart', source: 'startup' }, t.transcript)
  const rule = '─'.repeat(60)
  t.tmux.screen = `⏺ 이전 답변\n\n${rule}\n❯ 안 보내진 글입니다\n${rule}\n  ⏵⏵ auto mode on\n`
  await t.broker.handleSlackMessage({ user: 'U1', text: '안 보내진 글입니다', ts: '9.1', threadTs: s.ack, channel: 'C1' })
  // attempts 는 1부터 시작해 Enter 를 누를 때마다 이어진다: 1→Enter(→2)→Enter(→3), 3에서는 더 누르지 않고 멈춘다. 즉 Enter 는 두 번만 간다.
  await until(() => t.tmux.keys.filter((k) => k === '%3:Enter').length >= 2, 'Enter 를 두 번 누른다')
  await tick(200)
  assert.equal(t.tmux.keys.filter((k) => k === '%3:Enter').length, 2, '시도 횟수가 3 이 된 뒤로는 더 누르지 않는다')
  s.conn.close()
  t.close()
})

test('브로커 재시작 직후 몇 초 동안은, 다시 붙기 전에 온 답글을 버리지 않고 기다렸다가 전달한다 (claude-web 이관: REQ-F-050)', async () => {
  const revivePath = join(tmpdir(), `cs-live-${process.pid}-${Math.random().toString(36).slice(2)}.json`)
  const t = await setup({ revivePath })
  const s = await shim(t.socketPath, { tmuxPane: '%3', sessionId: 'sess-wait', cwd: '/home/u/proj' })
  t.broker.saveState()
  s.conn.close() // 프로세스는 살아 있지만(실제로는 재시작 중), 아직 붙지 않았다.
  t.close()

  const t2 = await setup({ revivePath, startupGraceMs: 2000, reattachPollMs: 20 })
  // 답글이 재시작 직후, 아직 아무도 다시 붙기 전에 도착한다.
  const replied = t2.broker.handleSlackMessage({ user: 'U1', text: '아직 거기 있어?', ts: '9.9', threadTs: s.ack, channel: 'C1' })
  await tick(10)
  assert.ok(t2.slack.reactions.includes('+eyes@9.9'), '기다리는 동안 👀 를 단다')
  assert.ok(!t2.slack.posts.some((p) => /연결된 세션이 없습니다/.test(p.text)), '아직 포기하지 않는다')

  // 그 사이 셰임(같은 실행 키 아님, 재시작된 프로세스)이 같은 스레드로 다시 붙는다.
  const s2 = await shim(t2.socketPath, { tmuxPane: '%3', sessionId: 'sess-wait', cwd: '/home/u/proj', threadTs: s.ack })
  await replied
  await until(() => s2.inbox.some((m) => (m as { text?: string }).text === '아직 거기 있어?'), '다시 붙은 세션으로 전달된다')
  s2.conn.close()
  t2.close()
})

test('브로커 재시작 직후라도, 재시작 기록에 없는(원래 없었던) 스레드는 바로 "연결된 세션 없음"이라고 말한다', async () => {
  const t = await setup({ startupGraceMs: 2000, reattachPollMs: 20 })
  await t.broker.handleSlackMessage({ user: 'U1', text: '아무 스레드', ts: '9.9', threadTs: '1.234', channel: 'C1' })
  assert.ok(t.slack.posts.some((p) => /연결된 세션이 없습니다/.test(p.text)))
  assert.ok(!t.slack.reactions.includes('+eyes@9.9'), '기록에 없으니 기다리지 않는다')
})

test('기다려도 끝내 다시 붙지 않으면, 유예 시간이 끝난 뒤 포기하고 알린다', async () => {
  const revivePath = join(tmpdir(), `cs-live-${process.pid}-${Math.random().toString(36).slice(2)}.json`)
  const t = await setup({ revivePath })
  const s = await shim(t.socketPath, { tmuxPane: '%3', sessionId: 'sess-gone', cwd: '/home/u/proj' })
  t.broker.saveState()
  s.conn.close()
  t.close()

  const t2 = await setup({ revivePath, startupGraceMs: 60, reattachPollMs: 10 })
  await t2.broker.handleSlackMessage({ user: 'U1', text: '아무도 안 옴', ts: '9.9', threadTs: s.ack, channel: 'C1' })
  assert.ok(t2.slack.posts.some((p) => /연결된 세션이 없습니다/.test(p.text)), '유예 시간이 끝나면 결국 알린다')
})

test('같은 실행 키로 두 번째 Claude 프로세스가 붙으려 하면: 기존 pid 가 살아 있으면 거절(bye)하고 기존 연결을 그대로 둔다', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, { tmuxPane: '%3', pid: process.pid }) // 지금 테스트 프로세스 자신의 pid: 틀림없이 살아 있다.
  await hook(t.socketPath, process.pid, { hook_event_name: 'SessionStart', source: 'startup' }, t.transcript)

  const intruder = await connect(t.socketPath)
  const intruderInbox: unknown[] = []
  intruder.on('message', (m) => intruderInbox.push(m))
  intruder.send({ type: 'hello', role: 'channel', key: String(process.pid), pid: 999999, sessionId: 's1', cwd: '/home/u/proj', threadTs: s.ack })
  await until(() => intruderInbox.length > 0, 'bye 를 받는다')
  assert.deepEqual(intruderInbox, [{ type: 'bye', reason: `another Claude Code process (pid ${process.pid}) already owns this run` }])
  assert.ok(t.slack.posts.some((p) => p.threadTs === s.ack && /같은 대화가 다른 Claude 프로세스로도 떠 있어요/.test(p.text)), '스레드에 경고')

  // 기존 연결은 멀쩡해서, 거기로 보낸 메시지는 그대로 전달된다.
  await t.broker.handleSlackMessage({ user: 'U1', text: '여전히 살아있니', ts: '9.1', threadTs: s.ack, channel: 'C1' })
  await until(() => s.inbox.some((m) => (m as { text?: string }).text === '여전히 살아있니'), '기존 연결로 전달된다')
  s.conn.close()
  intruder.close()
  t.close()
})

test('같은 실행 키인데 기존 pid 가 이미 죽었으면, 새 프로세스가 넘겨받고 session.pid 를 바꾼다', async () => {
  const t = await setup()
  const deadPid = 999998 // 거의 확실히 존재하지 않는 pid.
  const s = await shim(t.socketPath, { tmuxPane: '%3', pid: deadPid })
  const s2 = await shim(t.socketPath, { tmuxPane: '%3', pid: 999997, key: String(deadPid), threadTs: s.ack })
  assert.equal(s2.ack, s.ack, '같은 스레드를 넘겨받는다')
  await t.broker.handleSlackMessage({ user: 'U1', text: '새 프로세스로 전달돼?', ts: '9.1', threadTs: s.ack, channel: 'C1' })
  await until(() => s2.inbox.some((m) => (m as { text?: string }).text === '새 프로세스로 전달돼?'), '새 연결로 전달된다')
  s2.conn.close()
  t.close()
})

test('되살리기 전에 그 세션의 tmux 창이 아직 있으면, 다시 띄우지 않고 기다린다 (claude-web 이관: P0-5)', async () => {
  const revivePath = join(tmpdir(), `cs-live-${process.pid}-${Math.random().toString(36).slice(2)}.json`)
  const t = await setup({ revivePath })
  const s = await shim(t.socketPath, { tmuxPane: '%51', sessionId: 'sess-slow', cwd: '/home/u/proj' })
  t.broker.saveState()
  s.conn.close() // 소켓 연결만 끊겼다. tmux 창(프로세스)은 실제로 살아 있다고 가정.
  t.close()

  const t2 = await setup({ revivePath, reviveAfterMs: 20 })
  t2.tmux.alivePanes = new Set(['%51']) // 그 창은 아직 있다.
  await t2.broker.reviveSessions()

  assert.equal(t2.tmux.launches.length, 0, '다시 띄우지 않는다')
  assert.ok(t2.slack.posts.some((p) => p.threadTs === s.ack && /세션 창이 아직 살아 있어/.test(p.text)), '기다린다고 알린다')
  // 기록은 지우지 않았으니, 다음 되살리기 시도에서도 여전히 후보다.
  const revive = JSON.parse(readFileSync(revivePath, 'utf8')) as Record<string, unknown>
  assert.equal(Object.keys(revive).length, 1, '기록을 지우지 않는다')
  t2.close()
})

test('되살리기: tmux 창이 이미 없으면 평소처럼 다시 띄운다', async () => {
  const revivePath = join(tmpdir(), `cs-live-${process.pid}-${Math.random().toString(36).slice(2)}.json`)
  const t = await setup({ revivePath })
  const s = await shim(t.socketPath, { tmuxPane: '%52', sessionId: 'sess-dead', cwd: '/home/u/proj' })
  t.broker.saveState()
  s.conn.close()
  t.close()

  const t2 = await setup({ revivePath, reviveAfterMs: 20 })
  t2.tmux.alivePanes = new Set() // 창이 없다.
  await t2.broker.reviveSessions()
  assert.ok(t2.tmux.launches.length > 0, '다시 띄운다')
  t2.close()
})

test('유령 프로세스가 끝나도, 같은 스레드에 살아 있는 세션이 있으면 "종료됨"으로 보이지 않는다 (claude-web 이관: P0-6)', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, { tmuxPane: '%3', sessionId: 'sess-a', cwd: '/home/u/proj' })
  await hook(t.socketPath, 100, { hook_event_name: 'SessionStart', source: 'startup' }, t.transcript)
  // 두 번째(유령) 세션이, 같은 스레드를 가리키며 다른 키로 등록된다(레지스트리 수준의 레이스를 그대로 재현).
  ;(t.broker as unknown as { registry: { add: (s: unknown) => void } }).registry.add({
    key: '54321',
    pid: 54321,
    sessionId: 'sess-ghost',
    cwd: '/home/u/proj',
    threadTs: s.ack,
    origin: 'terminal',
    ended: false,
    recipient: 'U1',
    statusCreated: false,
    state: 'idle',
    startedAt: Date.now(),
  })
  // 유령이 끝난다.
  await hook(t.socketPath, 54321, { hook_event_name: 'SessionEnd', reason: 'exit' })
  // 끝남 안내나 "종료됨" 갱신이 없어야 한다.
  assert.ok(!t.slack.posts.some((p) => p.threadTs === s.ack && /⚫ 세션/.test(p.text)), '끝남 안내를 올리지 않는다')
  assert.ok(!t.slack.updates.some((u) => /종료됨/.test(u.text)), '루트를 종료됨으로 바꾸지 않는다')
  // 진짜 살아 있는 세션은 여전히 그 스레드의 주인이고, 메시지도 계속 간다.
  await t.broker.handleSlackMessage({ user: 'U1', text: '아직 살아있지', ts: '9.1', threadTs: s.ack, channel: 'C1' })
  await until(() => s.inbox.some((m) => (m as { text?: string }).text === '아직 살아있지'), '진짜 세션으로 전달된다')
  s.conn.close()
  t.close()
})

test('세션 연결이 늦어도, tmux 창이 아직 있으면 포기하지 않고 기다린다 (claude-web 이관: P0-7)', async () => {
  const t = await setup({ launchTimeoutMs: 40 })
  const dir = tmpdir()
  t.tmux.alivePanes = new Set(['%9']) // FakeTmux.launch 는 항상 pane '%9' 를 돌려준다.
  await t.broker.handleSlackMessage({ user: 'U1', text: `${dir} 시작해줘`, ts: '7.0', channel: 'C1' })
  await t.broker.handleSlackMessage({ user: 'U1', text: '이것도 봐줘', ts: '7.1', threadTs: '7.0', channel: 'C1' })
  await tick(200) // 제한 시간을 여러 번 넘긴다.
  assert.ok(t.slack.texts().some((x) => /세션이 아직 뜨는 중입니다/.test(x)), '포기하지 않고 기다린다는 안내')
  assert.ok(!t.slack.texts().some((x) => /전달하지 못한 메시지/.test(x)), '아직 버리지 않았다')
  // 창이 늦게라도 붙으면 쌓인 메시지를 받는다.
  const s = await shim(t.socketPath, { tmuxPane: '%9', threadTs: '7.0' })
  await until(() => s.inbox.some((m) => (m as { text?: string }).text?.includes('이것도 봐줘')), '뒤늦게 붙어도 쌓인 메시지를 받는다')
  s.conn.close()
  t.close()
})

test('재개로 띄울 때 이미 있던 트랜스크립트 크기를 기억해 두어, 늦게 붙어도 지난 내용을 다시 읽지 않고 새로 쓰인 것만 읽는다', async () => {
  const transcript = join(mkdtempSync(join(tmpdir(), 'resume-')), 'existing.jsonl')
  writeFileSync(transcript, assistant({ type: 'text', text: '이전 회차의 마지막 말' }))
  const t = await setup({ transcriptPathFor: () => transcript })
  await t.broker.launchSession({ cwd: '/home/u/proj', prompt: '', user: 'U1', resumeId: 'existing' })
  const key = t.tmux.launches.at(-1)!.env.CLAUDE_SLACK_SESSION!
  const threadTs = t.slack.posts[0]!.ts
  const s = await shim(t.socketPath, { key, pid: 1, tmuxPane: '%9', threadTs })
  appendFileSync(transcript, assistant({ type: 'text', text: '새로 쓰인 대답' }))
  const seenInStreams = (needle: string) => t.slack.streams.some((st) => JSON.stringify(st.chunks).includes(needle))
  await until(() => seenInStreams('새로 쓰인 대답'), '새로 쓰인 것은 읽는다')
  assert.ok(!seenInStreams('이전 회차의 마지막 말'), '지난 내용은 다시 읽지 않는다')
  s.conn.close()
  t.close()
})

test('전부 허용은 터미널을 manual 모드로 돌릴 수 있을 때만 켜진다 (claude-web 이관: P1-8)', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, { tmuxPane: '%3' })
  // 기본 화면은 auto 모드: shift+tab 네 번으로 manual 에 닿을 수 있다.
  await t.broker.handleSlackMessage({ user: 'U1', text: ':auto on', ts: '9.1', threadTs: s.ack, channel: 'C1' })
  await tick(50)
  assert.ok(t.slack.texts().some((x) => /전부 허용.*켬/.test(x)), '켜졌다')
  assert.equal((t.broker as unknown as { registry: { byThreadTs: (t: string) => { autoAllow?: boolean } | undefined } }).registry.byThreadTs(s.ack)?.autoAllow, true)
  s.conn.close()
  t.close()
})

test('전부 허용: manual 로 못 돌리면 켜지지 않고 이유를 알린다', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, { tmuxPane: '%3' })
  // 모드 문구가 아예 없는 화면: shift+tab 을 눌러도 바뀌지 않는다(끝내 manual 에 닿지 못함을 흉내).
  t.tmux.screen = '❯ 뭔가 입력 중\n'
  await t.broker.handleSlackMessage({ user: 'U1', text: ':auto on', ts: '9.1', threadTs: s.ack, channel: 'C1' })
  await tick(50)
  assert.ok(t.slack.texts().some((x) => /전부 허용을 켜지 않았습니다/.test(x)))
  assert.ok(!t.slack.texts().some((x) => /전부 허용.*켬/.test(x)), '켜졌다는 안내는 없다')
  s.conn.close()
  t.close()
})

test('전부 허용: 켜진 동안 터미널이 manual 을 벗어나면 되돌리거나(성공) 전부 허용을 끈다(실패) (claude-web 이관: P1-8)', async () => {
  const t = await setup({ autoAllowCheckMs: 30 })
  const s = await shim(t.socketPath, { tmuxPane: '%3' })
  await t.broker.handleSlackMessage({ user: 'U1', text: ':auto on', ts: '9.1', threadTs: s.ack, channel: 'C1' })
  await tick(50)
  // 터미널이 혼자 auto 모드로 돌아갔다(예: /mode 를 직접 쳤거나 세션이 재시작됨). 되돌릴 수 있는 상황.
  t.tmux.screen = '  ⏵⏵ auto mode on (shift+tab to cycle)\n❯ \n'
  await until(() => t.slack.texts().some((x) => /manual 로 되돌렸습니다/.test(x)), '되돌리고 알린다')

  // 이번엔 되돌릴 수 없는 상황(문구가 아예 없음): 전부 허용을 끈다.
  t.tmux.screen = '❯ 입력 중이라 아무 문구도 없음\n'
  await until(() => t.slack.texts().some((x) => /전부 허용을 껐습니다/.test(x)), '포기하고 끈다', 8000)
  await tick(50)
  assert.equal((t.broker as unknown as { registry: { byThreadTs: (t: string) => { autoAllow?: boolean } | undefined } }).registry.byThreadTs(s.ack)?.autoAllow, undefined)
  s.conn.close()
  t.close()
})

test('질문 카드가 열린 채 글로 답하면, Esc 로 터미널 다이얼로그를 닫고 카드를 접은 뒤 메시지를 전달한다 (claude-web 이관: P1-9)', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, { tmuxPane: '%7' })
  await hook(t.socketPath, 100, {
    hook_event_name: 'PreToolUse',
    tool_name: 'AskUserQuestion',
    tool_input: { questions: [{ question: '어느 쪽?', header: '방식', options: [{ label: 'A' }, { label: 'B' }] }] },
  })
  const card = t.slack.posts.at(-1)!
  assert.equal(t.slack.statuses.at(-1), `suspended@${s.ack}`)

  // 터미널에는 아직 다이얼로그가 떠 있다가, Esc 두 번 뒤 사라진다.
  const dialogScreen = '어느 쪽?\n❯ 1. A\n  2. B\n'
  const closedScreen = '❯ \n'
  let captures = 0
  t.tmux.capture = async () => (++captures <= 2 ? dialogScreen : closedScreen)

  await t.broker.handleSlackMessage({ user: 'U1', text: '그냥 B 로 해줘', ts: '9.1', threadTs: s.ack, channel: 'C1' })
  assert.ok(t.tmux.keys.filter((k) => k === '%7:Escape').length >= 2, `Esc 를 다이얼로그가 사라질 때까지 누른다: ${t.tmux.keys}`)
  assert.ok(t.tmux.keys.filter((k) => k === '%7:Escape').length <= 5, '최대 5번까지만 누른다')
  const folded = t.slack.updates.find((u) => u.ts === card.ts)
  assert.ok(folded && /메시지로 답함/.test(folded.text), '카드를 접는다')
  await until(() => s.inbox.some((m) => (m as { text?: string }).text === '그냥 B 로 해줘'), '메시지가 전달된다')
  s.conn.close()
  t.close()
})

test('권한 요청(예/아니오) 카드가 열려 있을 때는 글로 답해도 Esc 를 누르지 않는다 (거기서 Esc 는 거부가 된다)', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, { tmuxPane: '%8' })
  s.conn.send({ type: 'permission_request', requestId: 'abcde', toolName: 'Bash', description: 'rm x', inputPreview: '{}' })
  await tick()
  assert.equal(t.slack.statuses.at(-1), `suspended@${s.ack}`)
  await t.broker.handleSlackMessage({ user: 'U1', text: '아무 글', ts: '9.1', threadTs: s.ack, channel: 'C1' })
  assert.ok(!t.tmux.keys.includes('%8:Escape'), 'Esc 는 누르지 않는다')
  s.conn.close()
  t.close()
})

test('질문이 여러 개면 모두 답한 뒤 터미널의 "Submit answers" 를 찾아 누른다 (claude-web 이관: P1-10)', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, { tmuxPane: '%1' })
  await hook(t.socketPath, 100, {
    hook_event_name: 'PreToolUse',
    tool_name: 'AskUserQuestion',
    tool_input: {
      questions: [
        { question: '규칙 충돌?', header: 'Q1', options: [{ label: 'A' }, { label: 'B' }] },
        { question: '진입 방식?', header: 'Q2', options: [{ label: 'C' }, { label: 'D' }] },
      ],
    },
  })
  const q = t.slack.posts.at(-1)!
  t.tmux.screen = ' 규칙 충돌?\n ❯ 1. A\n   2. B\n'
  await t.broker.handleAction({ user: 'U1', ...buttonWithValue(q.blocks, 'dlg_answer', '100:answer 0 1 A'), messageTs: q.ts, channel: 'C1' })
  assert.ok(!t.tmux.keys.some((k) => /submit/i.test(k)), '하나만 답했을 땐 아직 Submit 을 찾지 않는다')

  // D(2번)를 고르면 다이얼로그가 사라지고(선택했으니), 화면이 요약·제출 화면으로 바뀐다.
  // 뒤이어 "Submit answers" 선택지를 찾아 누른다.
  const qdScreen = ' 진입 방식?\n ❯ 1. C\n   2. D\n'
  const submitScreen = ' 답을 확인하세요\n ❯ 1. Submit answers\n   2. Edit an answer\n'
  let qdCaptures = 0
  t.tmux.capture = async () => (qdCaptures++ < 2 ? qdScreen : submitScreen)
  await t.broker.handleAction({ user: 'U1', ...buttonWithValue(q.blocks, 'dlg_answer', '100:answer 1 2 D'), messageTs: q.ts, channel: 'C1' })
  assert.deepEqual(t.tmux.keys.slice(-4), ['%1:2', '%1:Enter', '%1:1', '%1:Enter'], 'D(2번) 선택 뒤, Submit answers(1번)도 누른다')
  s.conn.close()
  t.close()
})

test('예전(이미 넘어간) 질문 카드의 버튼은, 화면에 같은 번호가 있어도 누르지 않는다 (claude-web 이관: P1-10)', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, { tmuxPane: '%1' })
  await hook(t.socketPath, 100, {
    hook_event_name: 'PreToolUse',
    tool_name: 'AskUserQuestion',
    tool_input: { questions: [{ question: '첫 번째 질문?', header: 'Q1', options: [{ label: 'A' }, { label: 'B' }] }] },
  })
  const firstCard = t.slack.posts.at(-1)!
  t.tmux.screen = '❯ 1. A\n  2. B\n'
  await t.broker.handleAction({ user: 'U1', ...buttonWithValue(firstCard.blocks, 'dlg_answer', '100:answer 0 1 A'), messageTs: firstCard.ts, channel: 'C1' })

  // 두 번째 질문이 새로 뜬다(카드가 다시 올라간다 = openDialogTs 가 새 카드로 넘어간다).
  await hook(t.socketPath, 100, {
    hook_event_name: 'PreToolUse',
    tool_name: 'AskUserQuestion',
    tool_input: { questions: [{ question: '두 번째 질문?', header: 'Q2', options: [{ label: 'C' }, { label: 'D' }] }] },
  })
  const keysBefore = t.tmux.keys.length
  // 화면은 마침 두 번째 질문의 다이얼로그라, 번호만 보면 구분이 안 된다 — 그래도 예전 카드(firstCard)의 버튼은 거절되어야 한다.
  t.tmux.screen = '❯ 1. C\n  2. D\n'
  await t.broker.handleAction({ user: 'U1', ...buttonWithValue(firstCard.blocks, 'dlg_answer', '100:answer 0 2 B'), messageTs: firstCard.ts, channel: 'C1' })
  assert.equal(t.tmux.keys.length, keysBefore, '터미널에 아무 키도 보내지 않는다')
  assert.ok(t.slack.ephemerals.some((e) => /이미 끝났습니다/.test(e.text)))
  s.conn.close()
  t.close()
})

test('번호 없는 창: 여러 선택지를 각각 누를 수 있고, Esc 는 작업 중단이 아니라 키만 보내며, 누른 뒤 카드를 접고 대기를 푼다 (claude-web 이관: P1-11)', async () => {
  const t = await setup({ stallMs: 60, quietMs: 100_000 })
  const s = await shim(t.socketPath, { tmuxPane: '%61' })
  await tick(100)
  t.tmux.screen = [
    '  Permission needed',
    '  ❯ Open System Settings',
    '    Try again',
    '  Enter to confirm · Esc to cancel',
  ].join('\n')
  await tick(250)
  const posted = t.slack.posts.find((p) => /입력을 기다립니다/.test(p.text))!
  const row = (posted.blocks as Array<{ type: string; elements?: Array<{ action_id: string; value: string; text: { text: string } }> }>).find((b) => b.type === 'actions')!
  const labels = row.elements!.map((e) => e.text.text)
  assert.deepEqual(labels, ['Open System Settings', 'Try again', 'Esc로 취소'], '커서 줄만이 아니라 둘째 선택지도 버튼이 된다')

  // 둘째 선택지("Try again")를 고른다: 커서를 한 칸 내리고 Enter.
  const tryAgain = { actionId: row.elements![1]!.action_id, value: row.elements![1]!.value }
  await t.broker.handleAction({ user: 'U1', ...tryAgain, messageTs: posted.ts, channel: 'C1' })
  assert.deepEqual(t.tmux.keys.slice(-1), ['%61:Down Enter'])
  assert.match(t.slack.updates.find((u) => u.ts === posted.ts)!.text, /답함/, '카드를 접는다')
  assert.equal(t.slack.statuses.at(-1), `processing@${s.ack}`, '대기를 풀고 processing 으로 돌아간다')
  s.conn.close()
  t.close()
})

test('번호 없는 창의 Esc 버튼은 `:esc`(작업 중단) 가 아니라 Escape 키만 보낸다', async () => {
  const t = await setup({ stallMs: 60, quietMs: 100_000 })
  const s = await shim(t.socketPath, { tmuxPane: '%62' })
  await tick(100)
  t.tmux.screen = ['  Permission needed', '  ❯ Open System Settings', '  Enter to confirm · Esc to cancel'].join('\n')
  await tick(250)
  const posted = t.slack.posts.find((p) => /입력을 기다립니다/.test(p.text))!
  const row = (posted.blocks as Array<{ type: string; elements?: Array<{ action_id: string; value: string }> }>).find((b) => b.type === 'actions')!
  const escBtn = row.elements!.at(-1)!
  await t.broker.handleAction({ user: 'U1', actionId: escBtn.action_id, value: escBtn.value, messageTs: posted.ts, channel: 'C1' })
  assert.deepEqual(t.tmux.keys.slice(-1), ['%62:Escape'], 'Escape 키만 보낸다(Enter 를 덧붙이지 않는다)')
  assert.ok(!t.slack.texts().some((x) => /멈췄습니다/.test(x)), '작업 중단으로 처리되지 않는다')
  s.conn.close()
  t.close()
})

test('전부 허용: 터미널 확인 창을 누르다 한 번 실패해도 바로 사람에게 묻지 않고 1초 간격으로 3번까지 다시 누른다 (claude-web 이관: P1-12)', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, { tmuxPane: '%96' })
  await t.broker.handleSlackMessage({ user: 'U1', text: ':auto on', ts: '5.1', threadTs: s.ack, channel: 'C1' })
  await tick()
  t.tmux.screen = [' Allow Bash?', ' ❯ 1. Yes', '   2. No'].join('\n')
  let calls = 0
  const dialogs = (t.broker as unknown as { dialogs: { answerProceed: (...a: unknown[]) => Promise<string> } }).dialogs
  const real = dialogs.answerProceed.bind(dialogs)
  dialogs.answerProceed = async (...a: unknown[]) => (calls++ < 2 ? 'unfocused' : real(...(a as [string, string])))
  const t0 = Date.now()
  await hook(t.socketPath, 100, { hook_event_name: 'Notification', notification_type: 'agent_needs_input', message: '확인' })
  await until(() => t.slack.posts.some((p) => /자동 허용 · 터미널 확인 창/.test(p.text)), '세 번째 시도에서 성공해 자동 허용으로 끝난다', 6000)
  assert.ok(Date.now() - t0 >= 1900, `1초 간격으로 두 번 기다린 뒤 세 번째를 쳤다: ${Date.now() - t0}ms`)
  assert.equal(calls, 3)
  s.conn.close()
  t.close()
})

test('전부 허용: 세 번 다 실패하면 포기하고 이유를 로그에 남긴 뒤 평소처럼 카드로 묻는다', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, { tmuxPane: '%97' })
  await t.broker.handleSlackMessage({ user: 'U1', text: ':auto on', ts: '5.1', threadTs: s.ack, channel: 'C1' })
  await tick()
  t.tmux.screen = [' Allow Bash?', ' ❯ 1. Yes', '   2. No'].join('\n')
  const dialogs = (t.broker as unknown as { dialogs: { answerProceed: (...a: unknown[]) => Promise<string> } }).dialogs
  let calls = 0
  dialogs.answerProceed = async () => (calls++, 'unfocused')
  await hook(t.socketPath, 100, { hook_event_name: 'Notification', notification_type: 'agent_needs_input', message: '확인' })
  await tick(3200)
  assert.equal(calls, 3, '세 번만 시도하고 더 누르지 않는다')
  assert.ok(!t.slack.posts.some((p) => /자동 허용 · 터미널 확인 창/.test(p.text)))
  assert.ok(t.slack.posts.some((p) => /선택을 기다립니다/.test(p.text)), '사람에게 카드로 묻는다')
  s.conn.close()
  t.close()
})

test('새 턴이 시작되면, 화면에서 사라진 열린 질문/플랜 카드도 접는다 (claude-web 이관: P1-12)', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, { tmuxPane: '%1' })
  await hook(t.socketPath, 100, {
    hook_event_name: 'PreToolUse',
    tool_name: 'AskUserQuestion',
    tool_input: { questions: [{ question: '어느 쪽?', header: '방식', options: [{ label: 'A' }, { label: 'B' }] }] },
  })
  const card = t.slack.posts.at(-1)!
  await hook(t.socketPath, 100, { hook_event_name: 'SessionStart', source: 'startup' }, t.transcript)
  // 카드에 답하지 않고 다른 경로로 새 턴이 시작된다(예: 터미널에서 직접 타이핑).
  appendFileSync(t.transcript, assistant({ type: 'text', text: '다른 얘기를 시작합니다.' }))
  await tick(150)
  assert.ok(t.slack.updates.some((u) => u.ts === card.ts && /넘어감/.test(u.text)), '카드를 접는다')
  s.conn.close()
  t.close()
})

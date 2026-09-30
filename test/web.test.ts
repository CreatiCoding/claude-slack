/**
 * The web app (/app): the same session as the Slack thread, fed by a numbered event log.
 * What matters is that the web does nothing Slack does not: its buttons reach the same handler,
 * and what either side does shows up on the other.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setup, shim, hook, tick, until, assistant, toolResult } from './helpers.ts'
import { EventLog } from '../src/events.ts'

test('EventLog: 스레드마다 1부터 번호를 붙이고, 파일에서 다시 읽고, N 이후만 준다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ev-'))
  const log = new EventLog(dir)
  const seen: number[] = []
  log.subscribe((_, ev) => seen.push(ev.seq))
  log.emit('1.1', { type: 'text', text: 'a' })
  log.emit('1.1', { type: 'text', text: 'b' })
  log.emit('2.2', { type: 'text', text: 'c' })
  assert.deepEqual(seen, [1, 2, 1])
  assert.deepEqual(log.since('1.1', 1).map((e) => e.seq), [2])
  // A new broker (restart) continues the numbering from the file.
  const again = new EventLog(dir)
  assert.equal(again.last('1.1'), 2)
  assert.equal(again.emit('1.1', { type: 'text', text: 'd' })!.seq, 3)
  assert.deepEqual(again.since('1.1', 0).map((e) => (e as { text: string }).text), ['a', 'b', 'd'])
  // Anything that is not a thread ts never becomes a path.
  assert.equal(again.emit('../x', { type: 'text', text: 'no' }), undefined)
  assert.deepEqual(again.since('../x', 0), [])
})

test('웹에서 보낸 메시지는 스레드에 🌐 로 남고 스레드 답글과 똑같이 전달된다', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, { tmuxPane: '%1' })
  const r = await t.broker.webSend(100, '안녕')
  assert.ok(r.ok)
  await tick()
  const posted = t.slack.posts.find((p) => p.text === '🌐 웹: 안녕')
  assert.ok(posted, 'Slack 에도 보인다')
  assert.ok(s.inbox.some((m) => (m as { type: string; text?: string }).type === 'inbound' && (m as { text: string }).text === '안녕'), '세션에 들어간다')
  const evs = t.broker.events.since(s.ack, 0)
  assert.ok(evs.some((e) => e.type === 'user' && e.via === 'web' && e.ts === posted!.ts))
  assert.ok(evs.some((e) => e.type === 'react' && e.ts === posted!.ts && e.name === 'eyes' && e.on), '전달 표시가 웹에도')
  // The web post is its own event, not also a copied Slack message.
  assert.ok(!evs.some((e) => e.type === 'msg' && e.ts === posted!.ts))
  // `/` goes to the terminal as is: no `:` needed on the web.
  await t.broker.webSend(100, '/compact')
  await tick()
  assert.ok(t.tmux.keys.some((k) => k.includes('/compact')), String(t.tmux.keys))
  assert.equal((await t.broker.webSend(999, 'x')).ok, false)
  s.conn.close()
  t.close()
})

test('권한 카드는 웹에 버튼째 오고, 웹의 허용은 Slack 버튼과 같은 처리로 카드를 접는다', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, {})
  s.conn.send({ type: 'permission_request', requestId: 'abcde', toolName: 'Bash', description: 'Run tests', inputPreview: '{"command":"npm test"}' })
  await tick()
  const card = t.slack.posts.at(-1)!
  const ev = t.broker.events.since(s.ack, 0).find((e) => e.type === 'msg' && e.ts === card.ts)
  assert.ok(ev && ev.type === 'msg' && ev.blocks, '카드가 블록째 이벤트로')
  const actions = (ev.blocks as Array<{ type: string; elements?: Array<{ action_id: string; value: string }> }>).find((b) => b.type === 'actions')!
  const allow = actions.elements!.find((x) => x.action_id.startsWith('perm_allow'))!
  assert.equal(t.broker.webSessions()[0]!.waiting, '권한 대기')

  await t.broker.webAction({ actionId: allow.action_id, value: allow.value, messageTs: card.ts })
  await tick()
  assert.deepEqual(s.inbox.at(-1), { type: 'permission', requestId: 'abcde', behavior: 'allow' })
  assert.match(t.slack.updates.at(-1)!.text, /✅ 허용/, 'Slack 카드도 접힌다')
  const upd = t.broker.events.since(s.ack, 0).find((e) => e.type === 'msg_update' && e.ts === card.ts)
  assert.ok(upd, '접힌 카드가 웹에도')
  s.conn.close()
  t.close()
})

test('답변·도구·할 일은 자기 이벤트로 가고 Slack 스트림 메시지를 두 번 싣지 않는다', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, {})
  await hook(t.socketPath, 100, { hook_event_name: 'SessionStart', source: 'startup' }, t.transcript)
  await t.broker.handleSlackMessage({ user: 'U1', text: '해 줘', ts: '9.1', threadTs: s.ack, channel: 'C1' })
  appendFileSync(t.transcript, assistant({ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm test' } }))
  appendFileSync(t.transcript, assistant({ type: 'tool_use', id: 'tu2', name: 'TodoWrite', input: { todos: [{ content: '하나', status: 'in_progress', activeForm: '하나 중' }] } }))
  appendFileSync(t.transcript, toolResult('tu1', 'ok 1'))
  appendFileSync(t.transcript, assistant({ type: 'text', text: '**끝**' }))
  await until(() => t.broker.events.since(s.ack, 0).some((e) => e.type === 'text'), '답변 이벤트')
  const evs = t.broker.events.since(s.ack, 0)
  const types = evs.map((e) => e.type)
  assert.ok(types.includes('user'), 'Slack 에서 온 내 메시지')
  assert.ok(evs.some((e) => e.type === 'tool' && e.id === 'tu1' && e.name === 'Bash'))
  assert.ok(evs.some((e) => e.type === 'tool_end' && e.id === 'tu1' && e.ok && e.output === 'ok 1'))
  assert.ok(evs.some((e) => e.type === 'todos' && e.todos[0]!.activeForm === '하나 중'))
  assert.ok(!evs.some((e) => e.type === 'tool' && e.name === 'TodoWrite'), '할 일은 도구 줄이 아니다')
  assert.ok(evs.some((e) => e.type === 'text' && e.text === '**끝**'))
  assert.ok(!evs.some((e) => e.type === 'msg' && /하나/.test(e.text)), '할 일 메시지는 msg 로 다시 싣지 않는다')
  // Seq has no holes.
  assert.deepEqual(evs.map((e) => e.seq), evs.map((_, i) => i + 1))
  s.conn.close()
  t.close()
})

test('웹 이름은 Claude Code 자동 제목에 덮이지 않고, Slack 은 지금처럼 자동 제목을 따른다', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, {})
  await hook(t.socketPath, 100, { hook_event_name: 'SessionStart', source: 'startup' }, t.transcript)
  await t.broker.adminRename(100, '내 이름')
  appendFileSync(t.transcript, JSON.stringify({ type: 'ai-title', aiTitle: '자동 제목' }) + '\n')
  await until(() => t.slack.updates.some((u) => u.text.includes('자동 제목')), 'Slack 상태줄은 자동 제목으로')
  assert.equal(t.broker.webSessions()[0]!.title, '내 이름')
  s.conn.close()
  t.close()
})

test('전부 허용: 켜면 대기 중인 요청까지 허용하고, 이후 요청은 묻지 않고 허용하며 무엇을 허용했는지 남긴다', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, {})
  s.conn.send({ type: 'permission_request', requestId: 'aaaaa', toolName: 'Bash', description: 'Run', inputPreview: '{"command":"ls"}' })
  await tick()
  await t.broker.handleSlackMessage({ user: 'U1', text: ':auto on', ts: '5.1', threadTs: s.ack, channel: 'C1' })
  await tick()
  assert.deepEqual(s.inbox.at(-1), { type: 'permission', requestId: 'aaaaa', behavior: 'allow' }, '켜는 순간 기다리던 요청도 허용')
  assert.ok(t.slack.posts.some((p) => /전부 허용\* 켬/.test(p.text)))
  assert.equal(t.broker.webSessions()[0]!.autoAllow, true)

  s.conn.send({ type: 'permission_request', requestId: 'bbbbb', toolName: 'Bash', description: 'Run tests', inputPreview: '{"command":"npm test"}' })
  await until(() => s.inbox.some((m) => (m as { requestId?: string }).requestId === 'bbbbb'), '바로 허용')
  assert.deepEqual(s.inbox.at(-1), { type: 'permission', requestId: 'bbbbb', behavior: 'allow' })
  const record = t.slack.posts.find((p) => /자동 허용/.test(p.text))!
  assert.ok(record, '기록 카드')
  assert.ok(!JSON.stringify(record.blocks).includes('perm_allow'), '누를 버튼은 없다')
  assert.ok(JSON.stringify(record.blocks).includes('npm test'), '무엇을 허용했는지 보인다')
  assert.notEqual(t.broker.webSessions()[0]!.waiting, '권한 대기')

  await t.broker.handleSlackMessage({ user: 'U1', text: ':auto off', ts: '5.2', threadTs: s.ack, channel: 'C1' })
  s.conn.send({ type: 'permission_request', requestId: 'ccccc', toolName: 'Bash', description: 'Run', inputPreview: '{"command":"rm x"}' })
  await tick()
  assert.ok(!s.inbox.some((m) => (m as { requestId?: string }).requestId === 'ccccc'), '끄면 다시 묻는다')
  assert.match(t.slack.posts.at(-1)!.text, /권한 요청/)
  s.conn.close()
  t.close()
})

test('전부 허용: 터미널에만 뜬 확인 창(매뉴얼 모드의 권한 질문)도 "예"를 누르고 기록한다; 질문은 사람에게 둔다', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, { tmuxPane: '%21' })
  await t.broker.handleSlackMessage({ user: 'U1', text: ':auto on', ts: '6.1', threadTs: s.ack, channel: 'C1' })
  await tick()
  t.tmux.screen = ' Bash command\n\n   rm -rf build\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and don\'t ask again for rm commands\n   3. No\n'
  await hook(t.socketPath, 100, { hook_event_name: 'Notification', notification_type: 'agent_needs_input', message: '권한' })
  await until(() => t.slack.posts.some((p) => /자동 허용 · 터미널 확인 창/.test(p.text)), '자동 허용 기록')
  assert.ok(t.tmux.keys.includes('%21:1') && t.tmux.keys.includes('%21:Enter'), `once 만 누른다: ${t.tmux.keys}`)
  assert.ok(t.slack.posts.some((p) => /자동 허용 · 터미널 확인 창/.test(p.text)), '기록')
  assert.ok(!t.slack.posts.some((p) => /선택을 기다립니다/.test(p.text)), '버튼 카드는 올리지 않는다')

  // A numbered question that is not a permission still goes to the person.
  t.tmux.keys.length = 0
  t.tmux.screen = ' 어느 쪽으로 할까요?\n ❯ 1. A 안\n   2. B 안\n'
  await hook(t.socketPath, 100, { hook_event_name: 'Notification', notification_type: 'agent_needs_input', message: '질문' })
  await until(() => t.slack.posts.some((p) => /선택을 기다립니다/.test(p.text)), '질문 카드')
  assert.ok(!t.tmux.keys.includes('%21:1'), '질문은 누르지 않는다')
  assert.ok(t.slack.posts.some((p) => /선택을 기다립니다/.test(p.text)))
  s.conn.close()
  t.close()
})

test('EventLog.since: 개수만이 아니라 약 1MB 로도 자르고, 아무리 커도 최소 한 건은 준다', () => {
  const log = new EventLog(mkdtempSync(join(tmpdir(), 'ev-')))
  const big = 'x'.repeat(400_000)
  for (let i = 0; i < 5; i++) log.emit('3.3', { type: 'text', text: big })
  const first = log.since('3.3', 0)
  assert.equal(first.length, 2, '400KB 짜리는 한 번에 두 건까지(1MB 안)')
  assert.deepEqual(log.since('3.3', 2).map((e) => e.seq), [3, 4])
  const huge = new EventLog(mkdtempSync(join(tmpdir(), 'ev-')))
  huge.emit('4.4', { type: 'text', text: 'y'.repeat(2_000_000) })
  huge.emit('4.4', { type: 'text', text: 'z' })
  assert.equal(huge.since('4.4', 0).length, 1, '1MB 넘는 한 건도 준다')
})

test('되돌려 받기: 붙잡아 둔 메시지 하나를 빼고 글을 돌려준다(전달하지 않음, 취소함 표시)', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, { tmuxPane: '%31' })
  await hook(t.socketPath, 100, { hook_event_name: 'SessionStart', source: 'startup' }, t.transcript)
  await t.broker.handleSlackMessage({ user: 'U1', text: '돌려 줘', ts: '9.1', threadTs: s.ack, channel: 'C1' })
  appendFileSync(t.transcript, assistant({ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'sleep 9' } }))
  await tick(150)
  await t.broker.handleSlackMessage({ user: 'U1', text: '첫째', ts: '9.2', threadTs: s.ack, channel: 'C1' })
  await t.broker.handleSlackMessage({ user: 'U1', text: '둘째', ts: '9.3', threadTs: s.ack, channel: 'C1' })
  await tick()
  const r = await t.broker.webUnhold(100, '9.2')
  assert.deepEqual(r, { ok: true, note: '대기열에서 뺐습니다.', text: '첫째' })
  assert.ok(t.slack.reactions.includes('+x@9.2'), '취소함 표시')
  assert.match(t.slack.updates.at(-1)!.text, /1개/, '안내는 남은 개수로')
  assert.equal((await t.broker.webUnhold(100, '9.2')).ok, false, '두 번은 안 된다')
  appendFileSync(t.transcript, toolResult('tu1', 'ok'))
  await until(() => t.tmux.keys.some((k) => k.includes('둘째')), '남은 것만 전달')
  assert.ok(!t.tmux.keys.some((k) => k.includes('첫째')))
  s.conn.close()
  t.close()
})

test('잘못 보냄: Esc 로 멈추고, 따르지 말라는 정정을 보낸다', async () => {
  const t = await setup({ escSettleMs: 1 })
  const s = await shim(t.socketPath, { tmuxPane: '%32' })
  await hook(t.socketPath, 100, { hook_event_name: 'SessionStart', source: 'startup' }, t.transcript)
  await t.broker.handleSlackMessage({ user: 'U1', text: '데이터베이스 지워', ts: '9.5', threadTs: s.ack, channel: 'C1' })
  await tick()
  const r = await t.broker.webRetract(100, '9.5')
  assert.ok(r.ok, r.note)
  assert.ok(t.tmux.keys.includes('%32:Escape'), '멈춘다')
  await until(() => s.inbox.some((m) => /^\[정정\]/.test((m as { text?: string }).text ?? '')), '정정 전달')
  const sent = s.inbox.filter((m) => (m as { type: string }).type === 'inbound').map((m) => (m as { text: string }).text)
  assert.ok(sent.some((x) => /^\[정정\] 방금 보낸 '데이터베이스 지워' 는 잘못 보낸 거예요/.test(x)), sent.join(' | '))
  assert.ok(t.slack.posts.some((p) => /잘못 보냈다고 알렸습니다/.test(p.text)))
  assert.equal((await t.broker.webRetract(100, '0.0')).ok, false, '모르는 메시지')
  s.conn.close()
  t.close()
})

test('복제: --fork-session 으로 새 세션, 원래 대화는 원래 시각으로 옮기고 복사된 transcript 줄은 다시 쏟지 않는다', async () => {
  const { writeFileSync } = await import('node:fs')
  const t = await setup()
  const s = await shim(t.socketPath, { tmuxPane: '%41', sessionId: 's1' })
  await hook(t.socketPath, 100, { hook_event_name: 'SessionStart', source: 'startup' }, t.transcript)
  const line = (uuid: string, text: string) => JSON.stringify({ type: 'assistant', uuid, message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n'
  await t.broker.handleSlackMessage({ user: 'U1', text: '원래 질문', ts: '9.1', threadTs: s.ack, channel: 'C1' })
  appendFileSync(t.transcript, line('11111111-1111-1111-1111-111111111111', '원래 답'))
  await until(() => t.broker.events.since(s.ack, 0).some((e) => e.type === 'text'), '원래 답')
  const originalAt = t.broker.events.since(s.ack, 0).find((e) => e.type === 'text')!.at

  const r = await t.broker.webFork(100)
  assert.ok(r.ok && r.thread && r.thread !== s.ack, r.note)
  const cmd = t.tmux.launches.at(-1)!.command
  assert.deepEqual(cmd.slice(-3), ['--resume', 's1', '--fork-session'])
  const copied = t.broker.events.since(r.thread!, 0)
  assert.deepEqual(copied.map((e) => e.type), ['user', 'text', 'notice'])
  assert.equal(copied[1]!.at, originalAt, '원래 시각 그대로')
  assert.ok(copied[2]!.type === 'notice' && copied[2]!.text === '여기까지 복제한 대화')

  // The fork's own transcript starts with the original's lines (same uuid), then goes on.
  const forkTranscript = t.transcript + '.fork.jsonl'
  writeFileSync(forkTranscript, '')
  const f = await shim(t.socketPath, { pid: 200, key: '200', tmuxPane: '%42', sessionId: 's2', threadTs: r.thread })
  await hook(t.socketPath, 200, { hook_event_name: 'SessionStart', source: 'resume', session_id: 's2' }, forkTranscript)
  appendFileSync(forkTranscript, line('11111111-1111-1111-1111-111111111111', '원래 답'))
  appendFileSync(forkTranscript, line('22222222-2222-2222-2222-222222222222', '복제에서 새 답'))
  await until(() => t.broker.events.since(r.thread!, 0).some((e) => e.type === 'text' && e.text === '복제에서 새 답'), '새 답')
  const texts = t.broker.events.since(r.thread!, 0).filter((e) => e.type === 'text').map((e) => (e as { text: string }).text)
  assert.deepEqual(texts, ['원래 답', '복제에서 새 답'], '복사된 줄은 다시 싣지 않는다')
  s.conn.close()
  f.conn.close()
  t.close()
})

test('새 세션: 없는 폴더는 알려 주고, 만들라고 하면 홈 아래에만 만들어 모델·effort 와 함께 띄운다; 폴더 목록은 홈 아래만', async () => {
  const { mkdirSync, existsSync } = await import('node:fs')
  const home = mkdtempSync(join(tmpdir(), 'home-'))
  mkdirSync(join(home, 'projects', 'a', '.git'), { recursive: true })
  mkdirSync(join(home, 'projects', 'b'), { recursive: true })
  const t = await setup({ homeDir: home, defaultCwd: join(home, 'projects') })
  const missing = await t.broker.adminNew({ cwd: join(home, 'projects', 'new') })
  assert.deepEqual([missing.ok, missing.missing], [false, true])
  assert.ok(!existsSync(join(home, 'projects', 'new')), '묻지 않고 만들지 않는다')
  const made = await t.broker.adminNew({ cwd: join(home, 'projects', 'new'), create: true, model: 'claude-haiku-4-5-20251001', effort: 'high', prompt: '안녕' })
  assert.ok(made.ok && made.thread, made.note)
  assert.ok(existsSync(join(home, 'projects', 'new')))
  const cmd = t.tmux.launches.at(-1)!.command
  assert.deepEqual(cmd.slice(-4), ['--model', 'claude-haiku-4-5-20251001', '--effort', 'high'])
  const odd = await t.broker.adminNew({ cwd: join(home, 'projects', 'a'), model: '; rm -rf /', effort: 'huge' })
  assert.ok(odd.ok)
  assert.ok(!t.tmux.launches.at(-1)!.command.includes('--model'), '목록에 없는 값은 버린다')
  assert.equal((await t.broker.adminNew({ cwd: join(tmpdir(), 'outside-home-' + Date.now()), create: true })).ok, false, '홈 밖에는 만들지 않는다')

  const list = t.broker.webFolders(join(home, 'projects'))
  assert.deepEqual(list.dirs, [{ name: 'a', git: true }, { name: 'b', git: false }, { name: 'new', git: false }])
  assert.equal(list.parent, home)
  assert.equal(t.broker.webFolders('/etc').ok, false, '홈 밖은 보이지 않는다')
  t.close()
})

test('붙여넣은 여러 줄은 <pasted_content> 로 감싸여 돌아와도 같은 메시지로 본다(터미널 입력으로 한 번 더 뜨지 않게)', async () => {
  const { sameMessage } = await import('../src/format.ts')
  assert.ok(sameMessage('첫 줄\n둘째 줄\n\n셋째', '<pasted_content id="1">\n첫 줄\n둘째 줄\n셋째\n</pasted_content>'))
  assert.ok(!sameMessage('첫 줄', '다른 줄'))
  const t = await setup()
  const s = await shim(t.socketPath, {})
  await t.broker.webSend(100, '첫 줄\n둘째 줄')
  await tick()
  await hook(t.socketPath, 100, { hook_event_name: 'UserPromptSubmit', prompt: '<pasted_content>\n첫 줄\n둘째 줄 \n</pasted_content>' }, t.transcript)
  const terminal = t.broker.events.since(s.ack, 0).filter((e) => e.type === 'user' && e.via === 'terminal')
  assert.equal(terminal.length, 0, JSON.stringify(terminal))
  s.conn.close()
  t.close()
})

test('터미널 확인 창 카드: 질문 위의 도구·명령·설명을 코드 칸으로 보인다(창의 윗 테두리까지)', async () => {
  const { parseDialog } = await import('../src/dialog.ts')
  const screen = [
    '⏺ 빌드 폴더를 지울게요.',
    '',
    '────────────────────────────────',
    ' Bash command',
    '',
    '   rm -rf build',
    '   Remove the build directory',
    '',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    '   2. No',
  ].join('\n')
  const d = parseDialog(screen)!
  assert.equal(d.question, 'Do you want to proceed?')
  assert.equal(d.context, 'Bash command\n\n  rm -rf build\n  Remove the build directory')
  assert.ok(!d.context!.includes('빌드 폴더'), '대화 줄 위로는 읽지 않는다')

  const t = await setup()
  const s = await shim(t.socketPath, { tmuxPane: '%61' })
  t.tmux.screen = screen
  await hook(t.socketPath, 100, { hook_event_name: 'Notification', notification_type: 'agent_needs_input', message: '확인' })
  await until(() => t.slack.posts.some((p) => /선택을 기다립니다/.test(p.text)), '카드')
  const card = JSON.stringify(t.slack.posts.find((p) => /선택을 기다립니다/.test(p.text))!.blocks)
  assert.ok(card.includes('rm -rf build') && card.includes('```'), card)
  s.conn.close()
  t.close()
})

test('같은 확인 창이 되풀이되면(MCP 인증 메뉴처럼) 카드를 계속 올리지 않고 원인과 새로고침을 한 번 알린다', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, { tmuxPane: '%71' })
  const menu = ' notion MCP Server\n\n Status: ✘ failed\n\n ❯ 1. Authenticate\n   2. Reconnect\n   3. Disable\n'
  const cards = () => t.slack.posts.filter((p) => /선택을 기다립니다/.test(p.text)).length
  for (let i = 0; i < 4; i++) {
    t.tmux.screen = menu
    await hook(t.socketPath, 100, { hook_event_name: 'Notification', notification_type: 'agent_needs_input', message: 'mcp' })
    // The dialog closes and comes back (a new turn resets what was shown).
    await t.broker.handleSlackMessage({ user: 'U1', text: `다시 ${i}`, ts: `8.${i}`, threadTs: s.ack, channel: 'C1' })
    await tick()
  }
  assert.equal(cards(), 2, '두 번까지는 카드')
  const notes = t.slack.posts.filter((p) => /되풀이/.test(p.text))
  assert.equal(notes.length, 1, '그 뒤로는 한 번만 알린다')
  assert.match(notes[0]!.text, /MCP/)
  assert.ok(JSON.stringify(notes[0]!.blocks).includes('100:refresh'), '새로고침 버튼')
  s.conn.close()
  t.close()
})

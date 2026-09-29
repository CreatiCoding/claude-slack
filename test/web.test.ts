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

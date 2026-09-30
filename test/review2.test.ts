/** 두 번째 리뷰(5ce52c3..c788193): 되돌아간 것, 새로 생긴 결함, claude-web 의 교훈. 재현부터. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { setup, shim, hook, tick, until } from './helpers.ts'

const bgStart = (id: string, cmd: string) =>
  JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command: cmd } }] } }) +
  '\n' +
  JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { content: [{ type: 'tool_result', tool_use_id: id, content: `Command running in background with ID: ${id}x.` }] } }) +
  '\n'
const bgEnd = (id: string) => JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: new Date().toISOString(), content: `<task-notification>\n<tool-use-id>${id}</tool-use-id>\n<status>completed</status>\n</task-notification>` }) + '\n'

test('1 재시작 전 기록은 한 번만 적용한다: 예약한 새로고침이 재시작 뒤 한 번 돌고, 다시 뜬 세션을 또 죽이지 않는다', async () => {
  const facts = async () => ({ startedAt: 0, shells: 5 })
  const t = await setup({ processFacts: facts })
  const s = await shim(t.socketPath, { tmuxPane: '%81', sessionId: 's1' })
  await hook(t.socketPath, 100, { hook_event_name: 'SessionStart', source: 'startup' }, t.transcript)
  appendFileSync(t.transcript, bgStart('b1', 'sleep 99'))
  await tick(150)
  await t.broker.webAction({ actionId: 'ctl_btn_web', value: '100:refresh later' })
  t.broker.saveState()
  s.conn.close()
  t.close()
  const cfg = (t.broker as unknown as { cfg: { revivePath: string; offsetsPath: string } }).cfg
  const t2 = await setup({ revivePath: cfg.revivePath, offsetsPath: cfg.offsetsPath, transcript: t.transcript, processFacts: facts })
  void t2.broker.reviveSessions()
  const s2 = await shim(t2.socketPath, { tmuxPane: '%81', threadTs: s.ack, sessionId: 's1' })
  await until(() => t2.broker.webSessions()[0]?.refreshAfter === true, '예약이 남아 있다')
  // The background job ends: the reserved refresh runs once.
  appendFileSync(t.transcript, bgEnd('b1'))
  await hook(t2.socketPath, 100, { hook_event_name: 'Stop', last_assistant_message: '' }, t.transcript)
  await until(() => t2.tmux.keys.includes('%81:kill'), '예약한 새로고침')
  s2.conn.close()
  await until(() => t2.tmux.launches.length === 1, '다시 띄운다')
  // The relaunched session (same thread, new key) attaches: the old record must not reserve it again.
  const s3 = await shim(t2.socketPath, { pid: 201, key: '201', tmuxPane: '%82', threadTs: s.ack, sessionId: 's1' })
  await tick(300)
  assert.ok(!t2.broker.webSessions().find((r) => r.pid === 201)?.refreshAfter, '옛 기록의 예약이 다시 붙지 않는다')
  await hook(t2.socketPath, 201, { hook_event_name: 'Stop', last_assistant_message: '' }, t.transcript)
  await tick(300)
  assert.ok(!t2.tmux.keys.includes('%82:kill'), `다시 뜬 세션을 또 죽이지 않는다: ${t2.tmux.keys}`)
  assert.ok(!t2.broker.webSessions().find((r) => r.thread === s.ack)?.refreshAfter)
  s3.conn.close()
  t2.close()
})

test('1 재시작 뒤에 끈 전부 허용이 다음 새로고침 때 다시 켜지지 않는다', async () => {
  const t = await setup({ processFacts: async () => ({ startedAt: 0, shells: 0 }) })
  const s = await shim(t.socketPath, { tmuxPane: '%83', sessionId: 's1' })
  await t.broker.handleSlackMessage({ user: 'U1', text: ':auto on', ts: '3.1', threadTs: s.ack, channel: 'C1' })
  await tick()
  t.broker.saveState()
  s.conn.close()
  t.close()
  const cfg = (t.broker as unknown as { cfg: { revivePath: string; offsetsPath: string } }).cfg
  const t2 = await setup({ revivePath: cfg.revivePath, offsetsPath: cfg.offsetsPath, processFacts: async () => ({ startedAt: 0, shells: 0 }) })
  void t2.broker.reviveSessions()
  const s2 = await shim(t2.socketPath, { tmuxPane: '%83', threadTs: s.ack, sessionId: 's1' })
  await until(() => t2.broker.webSessions()[0]?.autoAllow === true, '되살아남')
  await t2.broker.handleSlackMessage({ user: 'U1', text: ':auto off', ts: '3.2', threadTs: s.ack, channel: 'C1' })
  await t2.broker.handleSlackMessage({ user: 'U1', text: ':refresh', ts: '3.3', threadTs: s.ack, channel: 'C1' })
  s2.conn.close()
  await until(() => t2.tmux.launches.length === 1, '다시 띄운다')
  const s3 = await shim(t2.socketPath, { pid: 202, key: '202', tmuxPane: '%84', threadTs: s.ack, sessionId: 's1' })
  await until(() => t2.broker.webSessions().some((r) => r.pid === 202), '다시 붙음')
  assert.equal(t2.broker.webSessions().find((r) => r.pid === 202)!.autoAllow, false, '끈 것이 다시 켜지지 않는다')
  s3.conn.close()
  t2.close()
})

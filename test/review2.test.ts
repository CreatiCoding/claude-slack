/** 두 번째 리뷰(5ce52c3..c788193): 되돌아간 것, 새로 생긴 결함. 재현부터. */
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

const answerWith = (model: string) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', model, content: [{ type: 'text', text: '네' }] } }) + '\n'
test('2B opus[1m] 으로 띄운 뒤 스레드에서 /model 로 바꾸면(passThrough) 새로고침은 바꾼 모델로', async () => {
  const t = await setup()
  const th = await t.broker.launchSession({ cwd: '/tmp', prompt: '', user: 'U1', extraArgs: ['--model', 'opus[1m]'] })
  const s = await shim(t.socketPath, { tmuxPane: '%85', sessionId: 's1', threadTs: th })
  await hook(t.socketPath, 100, { hook_event_name: 'SessionStart', source: 'startup' }, t.transcript)
  await t.broker.handleSlackMessage({ user: 'U1', text: ':/model claude-sonnet-5-5', ts: '3.4', threadTs: th!, channel: 'C1' })
  await t.broker.webAction({ actionId: 'ctl_btn_web', value: '100:refresh now' })
  s.conn.close()
  await until(() => t.tmux.launches.length === 2, '다시 띄운다')
  assert.ok(t.tmux.launches.at(-1)!.command.join(' ').includes('--model claude-sonnet-5-5'), t.tmux.launches.at(-1)!.command.join(' '))
  t.close()
})

test('2B′ 터미널에서 친 /model 처럼 대화 기록의 모델 계열이 바뀌면 launchModel 을 비우고 지금 모델로', async () => {
  const t = await setup()
  const th = await t.broker.launchSession({ cwd: '/tmp', prompt: '', user: 'U1', extraArgs: ['--model', 'opus[1m]'] })
  const s = await shim(t.socketPath, { tmuxPane: '%86', sessionId: 's1', threadTs: th })
  await hook(t.socketPath, 100, { hook_event_name: 'SessionStart', source: 'startup' }, t.transcript)
  appendFileSync(t.transcript, answerWith('claude-opus-5-5'))
  await tick(150)
  assert.equal(t.broker.webSessions()[0]!.model, 'opus[1m]', '같은 계열이면 1M 을 그대로 보인다')
  appendFileSync(t.transcript, answerWith('claude-sonnet-5-5'))
  await until(() => t.broker.webSessions()[0]!.model === 'claude-sonnet-5-5', '계열이 바뀌면 지금 모델을 보인다')
  await t.broker.webAction({ actionId: 'ctl_btn_web', value: '100:refresh now' })
  s.conn.close()
  await until(() => t.tmux.launches.length === 2, '다시 띄운다')
  assert.ok(t.tmux.launches.at(-1)!.command.join(' ').includes('--model claude-sonnet-5-5'), t.tmux.launches.at(-1)!.command.join(' '))
  t.close()
})

test('2C launchModel 이 없으면(터미널에서 띄운 세션·옛 기록) 지금 쓰는 모델로 다시 띄운다; 기록에는 launchModel ?? model', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, { tmuxPane: '%87', sessionId: 's1' })
  await hook(t.socketPath, 100, { hook_event_name: 'SessionStart', source: 'startup' }, t.transcript)
  appendFileSync(t.transcript, answerWith('claude-opus-5-5'))
  await until(() => t.broker.webSessions()[0]?.model === 'claude-opus-5-5', '모델')
  t.broker.saveState()
  const { readFileSync } = await import('node:fs')
  const rec = JSON.parse(readFileSync((t.broker as unknown as { cfg: { revivePath: string } }).cfg.revivePath, 'utf8')) as Record<string, { launchModel?: string }>
  assert.equal(Object.values(rec)[0]!.launchModel, 'claude-opus-5-5')
  await t.broker.webAction({ actionId: 'ctl_btn_web', value: '100:refresh now' })
  s.conn.close()
  await until(() => t.tmux.launches.length === 1, '다시 띄운다')
  assert.ok(t.tmux.launches.at(-1)!.command.join(' ').includes('--model claude-opus-5-5'), t.tmux.launches.at(-1)!.command.join(' '))
  t.close()
})

test('2 설정 모달은 launchModel 과 비교해, 바꾸지 않은 모델로 /model 을 다시 보내지 않는다', async () => {
  const t = await setup()
  const th = await t.broker.launchSession({ cwd: '/tmp', prompt: '', user: 'U1', extraArgs: ['--model', 'claude-fable-5-1[1m]'] })
  const s = await shim(t.socketPath, { tmuxPane: '%88', sessionId: 's1', threadTs: th })
  await hook(t.socketPath, 100, { hook_event_name: 'SessionStart', source: 'startup' }, t.transcript)
  appendFileSync(t.transcript, answerWith('claude-fable-5-1'))
  await tick(150)
  await t.broker.handleView({ user: 'U1', callbackId: 'cs_settings', privateMetadata: '100', values: { model: { model: { selected_option: { value: 'claude-fable-5-1[1m]' } } } } })
  assert.ok(!t.tmux.keys.some((k) => k.includes('/model')), String(t.tmux.keys))
  s.conn.close()
  t.close()
})

test('7-5 "allow all edits during this session (shift+tab)" 는 other 로 분류한다', async () => {
  const { classifyOption } = await import('../src/dialog.ts')
  assert.equal(classifyOption('Yes, allow all edits during this session (shift+tab)'), 'other')
  assert.equal(classifyOption('Allow all actions on example.com for this session'), 'allow-session')
})

test('실제 확인 중 발견: 재시작 직후 아직 다시 붙지 않은 세션에 누른 버튼은 "눌렀습니다"라고 거짓말하지 않는다', async () => {
  const t = await setup()
  const r = await t.broker.webAction({ actionId: 'ctl_btn_web', value: '4242:refresh now' })
  assert.equal(r.ok, false)
  assert.match(r.note, /아직 다시 붙지 않았/)
  t.close()
})

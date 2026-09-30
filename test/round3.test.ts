/** 이번 묶음: 재시작·새로고침 버그, 새로고침 예약, 백그라운드 작업, 전부 허용 확인 창. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setup, shim, hook, tick, until } from './helpers.ts'

const proceed = ' Bash command\n\n   rm -rf build\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and don\'t ask again for rm commands\n   3. No\n'

async function restartWith(prepare: (t: Awaited<ReturnType<typeof setup>>, s: Awaited<ReturnType<typeof shim>>) => Promise<void>, screen: string) {
  const t = await setup()
  const s = await shim(t.socketPath, { tmuxPane: '%91' })
  await hook(t.socketPath, 100, { hook_event_name: 'SessionStart', source: 'startup' }, t.transcript)
  await prepare(t, s)
  t.broker.saveState()
  s.conn.close()
  t.close()
  const cfg = (t.broker as unknown as { cfg: { revivePath: string; offsetsPath: string } }).cfg
  const t2 = await setup({ revivePath: cfg.revivePath, offsetsPath: cfg.offsetsPath, transcript: t.transcript })
  t2.tmux.screen = screen
  void t2.broker.reviveSessions()
  const s2 = await shim(t2.socketPath, { tmuxPane: '%91', threadTs: s.ack })
  return { t: t2, s: s2, thread: s.ack }
}

test('재시작 순간 확인 창이 떠 있어도 전부 허용 세션이면 카드를 올리지 않고 "이번만"을 누른다', async () => {
  const { t, s } = await restartWith(async (t, s) => {
    await t.broker.handleSlackMessage({ user: 'U1', text: ':auto on', ts: '7.1', threadTs: s.ack, channel: 'C1' })
    await tick()
  }, proceed)
  await until(() => t.tmux.keys.includes('%91:1'), '예(이번만)를 누른다')
  assert.ok(!t.tmux.keys.includes('%91:2'), '"다시 묻지 않기"는 누르지 않는다')
  assert.ok(!t.slack.posts.some((p) => /선택을 기다립니다/.test(p.text)), '카드는 올리지 않는다')
  s.conn.close()
  t.close()
})

test('모델·effort 는 재시작 기록에 남고, 새로고침은 지금 값을 --model/--effort 로 넘긴다', async () => {
  const { t, s } = await restartWith(async (t, s) => {
    t.tmux.screen = ''
    await t.broker.webAction({ actionId: 'ctl_btn_web', value: '100:model claude-sonnet-5-5' })
    await t.broker.webAction({ actionId: 'ctl_btn_web', value: '100:effort high' })
    await tick()
  }, '')
  await until(() => t.broker.webSessions().length === 1, '다시 붙음')
  const row = t.broker.webSessions()[0]!
  assert.equal(row.model, 'claude-sonnet-5-5', '재시작 직후에도 모델을 안다')
  assert.equal(row.effort, 'high')
  await t.broker.handleSlackMessage({ user: 'U1', text: ':refresh', ts: '7.4', threadTs: row.thread, channel: 'C1' })
  s.conn.close()
  await until(() => t.tmux.launches.length > 0, '다시 띄운다')
  const cmd = t.tmux.launches.at(-1)!.command
  assert.ok(cmd.join(' ').includes('--model claude-sonnet-5-5') && cmd.join(' ').includes('--effort high'), cmd.join(' '))
  t.close()
})

import { mock } from 'node:test'
import { appendFileSync } from 'node:fs'

const bgStart = (id: string, cmd: string) =>
  JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command: cmd, run_in_background: true } }] } }) +
  '\n' +
  JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { content: [{ type: 'tool_result', tool_use_id: id, content: `Command running in background with ID: ${id}x. Output …` }] } }) +
  '\n'
const bgEnd = (id: string) => JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { content: `<task-notification>\n<tool-use-id>${id}</tool-use-id>\n<status>completed</status>\n</task-notification>` } }) + '\n'

test('끝나면 새로고침: 그동안 온 메시지는 붙잡고, 작업·백그라운드가 끝난 뒤(1분마다 다시 보며) 새로고침해 넘긴다', async () => {
  mock.timers.enable({ apis: ['setInterval'] })
  try {
    const t = await setup({ processFacts: async () => ({ startedAt: 0, shells: 5 }), escSettleMs: 1 })
    const s = await shim(t.socketPath, { tmuxPane: '%92', sessionId: 's1' })
    await hook(t.socketPath, 100, { hook_event_name: 'SessionStart', source: 'startup' }, t.transcript)
    await t.broker.handleSlackMessage({ user: 'U1', text: '빌드 돌려', ts: '6.1', threadTs: s.ack, channel: 'C1' })
    appendFileSync(t.transcript, bgStart('bg1', 'npm run build'))
    await tick(150)
    assert.deepEqual((await t.broker.webRefreshInfo(100)).tasks.map((x) => x.label), ['npm run build'], '새로고침 전에 끊길 작업을 안다')
    await t.broker.webAction({ actionId: 'ctl_btn_web', value: '100:refresh later' })
    assert.equal(t.broker.webSessions()[0]!.refreshAfter, true)
    await t.broker.handleSlackMessage({ user: 'U1', text: '다시 열면 이것부터', ts: '6.2', threadTs: s.ack, channel: 'C1' })
    await tick()
    assert.ok(!s.inbox.some((m) => (m as { text?: string }).text === '다시 열면 이것부터'), '붙잡는다')
    // The turn ends, but the background build still runs: no refresh yet.
    await hook(t.socketPath, 100, { hook_event_name: 'Stop', last_assistant_message: '빌드 걸었어요' }, t.transcript)
    await tick(100)
    assert.ok(!t.tmux.keys.includes('%92:kill'), '백그라운드가 도는 동안은 하지 않는다')
    assert.ok(!s.inbox.some((m) => (m as { text?: string }).text === '다시 열면 이것부터'), '턴이 끝나도 흘려보내지 않는다')
    // The build ends quietly (no new turn): the one-minute look catches it.
    appendFileSync(t.transcript, bgEnd('bg1'))
    mock.timers.tick(60_000)
    await until(() => t.tmux.keys.includes('%92:kill'), '1분 뒤 다시 보고 새로고침')
    s.conn.close()
    await until(() => t.tmux.launches.length === 1, '다시 띄운다')
    const s2 = await shim(t.socketPath, { pid: 101, key: '101', tmuxPane: '%93', sessionId: 's1', threadTs: s.ack })
    await until(() => s2.inbox.some((m) => (m as { text?: string }).text === '다시 열면 이것부터'), '붙잡은 메시지를 새 세션에')
    s2.conn.close()
    t.close()
  } finally {
    mock.timers.reset()
  }
})

test('예약 취소하면 붙잡은 메시지를 바로 흘려보낸다; 지금 새로고침은 끊긴 백그라운드 작업을 새 세션에 먼저 알린다; 그동안 목록 줄은 "뜨는 중"으로 남는다', async () => {
  const t = await setup({ processFacts: async () => ({ startedAt: 0, shells: 5 }), escSettleMs: 1 })
  const s = await shim(t.socketPath, { tmuxPane: '%94', sessionId: 's1' })
  await hook(t.socketPath, 100, { hook_event_name: 'SessionStart', source: 'startup' }, t.transcript)
  // Idle and nothing running would refresh at once; keep a background command so the reservation stays.
  appendFileSync(t.transcript, bgStart('bg2', 'tail -f app.log'))
  await tick(150)
  await t.broker.webAction({ actionId: 'ctl_btn_web', value: '100:refresh later' })
  assert.ok(!t.tmux.keys.includes('%94:kill'), '백그라운드가 있으면 기다린다')
  await t.broker.handleSlackMessage({ user: 'U1', text: '취소하면 바로 가라', ts: '6.3', threadTs: s.ack, channel: 'C1' })
  await tick()
  await t.broker.webAction({ actionId: 'ctl_btn_web', value: '100:refresh cancel' })
  // Released the usual way: into the channel, or typed into the terminal while a turn is open.
  await until(() => s.inbox.some((m) => (m as { text?: string }).text === '취소하면 바로 가라') || t.tmux.keys.some((k) => k.includes('취소하면 바로 가라')), '취소하면 흘려보낸다')
  assert.ok(!t.broker.webSessions()[0]!.refreshAfter)

  await t.broker.webAction({ actionId: 'ctl_btn_web', value: '100:refresh now' })
  await until(() => t.tmux.keys.includes('%94:kill'), '지금 새로고침')
  s.conn.close()
  await until(() => t.tmux.launches.length === 1, '다시 띄운다')
  const row = t.broker.webSessions().find((r) => r.thread === s.ack)
  assert.equal(row?.state, 'starting', '다시 붙기 전까지 같은 줄이 뜨는 중으로 남는다')
  const s2 = await shim(t.socketPath, { pid: 102, key: '102', tmuxPane: '%95', sessionId: 's1', threadTs: s.ack })
  await until(() => s2.inbox.some((m) => /^\[새로고침\]/.test((m as { text?: string }).text ?? '')), '끊긴 작업을 먼저')
  const first = s2.inbox.find((m) => (m as { type: string }).type === 'inbound') as { text: string }
  assert.match(first.text, /백그라운드 명령: tail -f app\.log/)
  assert.match(first.text, /필요한 것만 다시 걸고, 걸었으면 짧게 알려 줘요/)
  s2.conn.close()
  t.close()
})

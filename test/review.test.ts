/** 코드 리뷰(75e82d6..5ce52c3)에서 나온 결함: 하나씩 "이 입력이면 이렇게 틀린다"를 먼저 고정한다. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { setup, shim, hook, tick, until } from './helpers.ts'

test('1-1 opus[1m] 으로 띄운 세션은 답을 한 번 한 뒤 새로고침해도 --model opus[1m] 으로 다시 뜬다', async () => {
  const t = await setup()
  const thread = await t.broker.launchSession({ cwd: '/tmp', prompt: '', user: 'U1', extraArgs: ['--model', 'opus[1m]'] })
  const s = await shim(t.socketPath, { tmuxPane: '%61', sessionId: 's1', threadTs: thread })
  await hook(t.socketPath, 100, { hook_event_name: 'SessionStart', source: 'startup' }, t.transcript)
  // The transcript names the model without [1m].
  appendFileSync(t.transcript, JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: '네' }] } }) + '\n')
  await until(() => t.broker.events.since(thread!, 0).some((e) => e.type === 'text'), '답')
  await t.broker.webAction({ actionId: 'ctl_btn_web', value: '100:refresh now' })
  s.conn.close()
  await until(() => t.tmux.launches.length === 2, '다시 띄운다')
  const cmd = t.tmux.launches.at(-1)!.command.join(' ')
  assert.ok(cmd.includes('--model opus[1m]'), cmd)
  t.close()
})

test('1-2 새로고침 직후: 이전 프로세스 때의 "Base directory for this skill" 줄은 증거가 아니다(헤더에 "새로고침하면"이 또 뜨지 않게)', async () => {
  const { mkdirSync, mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { sessionPlugins } = await import('../src/plugins.ts')
  const dir = mkdtempSync(join(tmpdir(), 'plug-'))
  writeFileSync(join(dir, 'known_marketplaces.json'), JSON.stringify({ kit: { source: { repo: 'me/kit' } } }))
  mkdirSync(join(dir, 'cache', 'kit', 'kit', '0.4.2'), { recursive: true })
  await new Promise((r) => setTimeout(r, 30))
  mkdirSync(join(dir, 'cache', 'kit', 'kit', '0.5.0'), { recursive: true })
  await new Promise((r) => setTimeout(r, 30))
  const refreshedAt = Date.now()
  // --resume appends to the same file: the old process's skill line (0.4.2) is still in it, written before the refresh.
  const t = join(dir, 't.jsonl')
  writeFileSync(t, JSON.stringify({ type: 'user', timestamp: new Date(refreshedAt - 60_000).toISOString(), message: { content: [{ type: 'text', text: `Base directory for this skill: ${dir}/cache/kit/kit/0.4.2/skills/x` }] } }) + '\n')
  assert.deepEqual(sessionPlugins({ pluginsDir: dir, user: 'me', processStart: refreshedAt, transcript: t }), [{ market: 'kit', version: '0.5.0' }])
  // A line this process wrote wins (autoUpdate or /reload-plugins can load another version mid-process).
  writeFileSync(t, JSON.stringify({ type: 'user', timestamp: new Date(refreshedAt + 5_000).toISOString(), message: { content: [{ type: 'text', text: `Base directory for this skill: ${dir}/cache/kit/kit/0.4.2/skills/x` }] } }) + '\n')
  assert.deepEqual(sessionPlugins({ pluginsDir: dir, user: 'me', processStart: refreshedAt, transcript: t }), [{ market: 'kit', version: '0.4.2', latest: '0.5.0' }])
})

async function autoSession(pane: string) {
  const t = await setup()
  const s = await shim(t.socketPath, { tmuxPane: pane })
  await t.broker.handleSlackMessage({ user: 'U1', text: ':auto on', ts: '5.1', threadTs: s.ack, channel: 'C1' })
  await tick()
  return { t, s }
}

test('1-5 전부 허용: Edit 확인 창의 "allow all edits during this session (shift+tab)" 은 누르지 않는다(acceptEdits 로 바뀌어 끈 뒤에도 남는다)', async () => {
  const { t, s } = await autoSession('%62')
  t.tmux.screen = [' Edit file', '   src/a.ts', '', ' Do you want to make this edit to a.ts?', ' ❯ 1. Yes', '   2. Yes, allow all edits during this session (shift+tab)', '   3. No, and tell Claude what to do differently (esc)'].join('\n')
  await hook(t.socketPath, 100, { hook_event_name: 'Notification', notification_type: 'agent_needs_input', message: '확인' })
  await until(() => t.tmux.keys.includes('%62:1'), '이번만(1)')
  assert.ok(!t.tmux.keys.includes('%62:2'), String(t.tmux.keys))
  s.conn.close()
  t.close()
})

test('1-5 전부 허용: Bash "Yes / don\'t ask again / No" 는 1번', async () => {
  const { t, s } = await autoSession('%63')
  t.tmux.screen = [' Bash command', '   ls', '', ' Do you want to proceed?', ' ❯ 1. Yes', "   2. Yes, and don't ask again for ls commands in /x", '   3. No'].join('\n')
  await hook(t.socketPath, 100, { hook_event_name: 'Notification', notification_type: 'agent_needs_input', message: '확인' })
  await until(() => t.tmux.keys.includes('%63:1'), '이번만(1)')
  assert.ok(!t.tmux.keys.includes('%63:2'))
  s.conn.close()
  t.close()
})

import { mock } from 'node:test'
const bgStart = (id: string, cmd: string) =>
  JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command: cmd } }] } }) +
  '\n' +
  JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { content: [{ type: 'tool_result', tool_use_id: id, content: `Command running in background with ID: ${id}x.` }] } }) +
  '\n'
const bgEnd = (id: string) => JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { content: `<task-notification>\n<tool-use-id>${id}</tool-use-id>\n<status>completed</status>\n</task-notification>` } }) + '\n'
const said = (s: { inbox: unknown[] }, t: Awaited<ReturnType<typeof setup>>, text: string) => s.inbox.some((m) => (m as { text?: string }).text?.includes(text)) || t.tmux.keys.some((k) => k.includes(text))

test('2-1 지금 새로고침: 백그라운드 작업을 묻는 동안 온 메시지는 곧 죽을 프로세스로 가지 않는다', async () => {
  let release!: () => void
  const slow = new Promise<void>((r) => (release = r))
  const t = await setup({ processFacts: async () => (await slow, { startedAt: 0, shells: 0 }) })
  const s = await shim(t.socketPath, { tmuxPane: '%64', sessionId: 's1' })
  await hook(t.socketPath, 100, { hook_event_name: 'SessionStart', source: 'startup' }, t.transcript)
  const refresh = t.broker.webAction({ actionId: 'ctl_btn_web', value: '100:refresh now' })
  await tick()
  await t.broker.handleSlackMessage({ user: 'U1', text: '새로고침 중에 보냄', ts: '4.1', threadTs: s.ack, channel: 'C1' })
  await tick()
  assert.ok(!said(s, t, '새로고침 중에 보냄'), '옛 프로세스로 넘기지 않는다')
  release()
  await refresh
  s.conn.close()
  t.close()
})

test('2-2 예약한 새로고침은 턴 끝과 1분 확인이 겹쳐도 한 번만 돈다', async () => {
  mock.timers.enable({ apis: ['setInterval'] })
  try {
    let gate: Promise<void> = Promise.resolve()
    const t = await setup({ processFacts: async () => (await gate, { startedAt: 0, shells: 5 }) })
    const s = await shim(t.socketPath, { tmuxPane: '%65', sessionId: 's1' })
    await hook(t.socketPath, 100, { hook_event_name: 'SessionStart', source: 'startup' }, t.transcript)
    appendFileSync(t.transcript, bgStart('b1', 'sleep 9'))
    await tick(150)
    await t.broker.webAction({ actionId: 'ctl_btn_web', value: '100:refresh later' })
    appendFileSync(t.transcript, bgEnd('b1'))
    // Both checks start while the background lookup is slow, so both pass the guard before either finishes.
    let open!: () => void
    gate = new Promise<void>((r) => (open = r))
    await t.broker.handleSlackMessage({ user: 'U1', text: '진행', ts: '4.2', threadTs: s.ack, channel: 'C1' })
    await hook(t.socketPath, 100, { hook_event_name: 'Stop', last_assistant_message: '' }, t.transcript)
    mock.timers.tick(60_000)
    await tick(50)
    open()
    await until(() => t.tmux.keys.includes('%65:kill'), '새로고침')
    await tick(200)
    assert.equal(t.tmux.keys.filter((k) => k === '%65:kill').length, 1, 'killPane 한 번')
    assert.equal(t.slack.posts.filter((p) => /세션을 다시 엽니다/.test(p.text)).length, 1, '안내 한 번')
    s.conn.close()
    t.close()
  } finally {
    mock.timers.reset()
  }
})

test('2-3 Esc 뒤(지시 대기)에도 예약한 새로고침이 돌고, 붙잡은 메시지는 옛 프로세스로 가지 않는다', async () => {
  const t = await setup({ processFacts: async () => ({ startedAt: 0, shells: 5 }), escSettleMs: 1 })
  const s = await shim(t.socketPath, { tmuxPane: '%66', sessionId: 's1' })
  await hook(t.socketPath, 100, { hook_event_name: 'SessionStart', source: 'startup' }, t.transcript)
  await t.broker.handleSlackMessage({ user: 'U1', text: '일해', ts: '4.3', threadTs: s.ack, channel: 'C1' })
  appendFileSync(t.transcript, bgStart('b2', 'npm run watch'))
  await tick(150)
  await t.broker.webAction({ actionId: 'ctl_btn_web', value: '100:refresh later' })
  await t.broker.handleSlackMessage({ user: 'U1', text: '새 세션에 줄 말', ts: '4.4', threadTs: s.ack, channel: 'C1' })
  await tick()
  appendFileSync(t.transcript, bgEnd('b2'))
  t.tmux.screen = '⏺ 하던 일\n  ⎿  Interrupted · What should Claude do instead?\n\n────────\n❯ \n────────'
  await t.broker.webAction({ actionId: 'ctl_btn_web', value: '100:esc' })
  await until(() => t.tmux.keys.includes('%66:kill'), '지시 대기도 쉬는 것으로 보고 새로고침')
  assert.ok(!said(s, t, '새 세션에 줄 말'), '붙잡은 메시지는 옛 프로세스로 가지 않는다')
  s.conn.close()
  t.close()
})

test('2-4 tmux 밖 세션: 끝나면 새로고침은 바로 거절하고 메시지를 붙잡지 않는다', async () => {
  const t = await setup({ processFacts: async () => ({ startedAt: 0, shells: 5 }) })
  const s = await shim(t.socketPath, { sessionId: 's1' })
  await t.broker.webAction({ actionId: 'ctl_btn_web', value: '100:refresh later' })
  await t.broker.handleSlackMessage({ user: 'U1', text: '그냥 전달', ts: '4.5', threadTs: s.ack, channel: 'C1' })
  await until(() => said(s, t, '그냥 전달'), '붙잡지 않고 전달')
  assert.ok(!t.broker.webSessions()[0]!.refreshAfter)
  s.conn.close()
  t.close()
})

test('2-5 끊긴 작업 안내 뒤에 메시지가 와도 스레드 첫 글에 👀 를 달지 않는다', async () => {
  const t = await setup({ processFacts: async () => ({ startedAt: 0, shells: 5 }) })
  const s = await shim(t.socketPath, { tmuxPane: '%67', sessionId: 's1' })
  await hook(t.socketPath, 100, { hook_event_name: 'SessionStart', source: 'startup' }, t.transcript)
  appendFileSync(t.transcript, bgStart('b3', 'tail -f x'))
  await tick(150)
  await t.broker.webAction({ actionId: 'ctl_btn_web', value: '100:refresh now' })
  s.conn.close()
  await until(() => t.tmux.launches.length === 1, '다시 띄운다')
  await t.broker.handleSlackMessage({ user: 'U1', text: '뜨는 동안 보냄', ts: '4.6', threadTs: s.ack, channel: 'C1' })
  await tick()
  const s2 = await shim(t.socketPath, { pid: 103, key: '103', tmuxPane: '%68', sessionId: 's1', threadTs: s.ack })
  await until(() => s2.inbox.some((m) => /뜨는 동안 보냄/.test((m as { text?: string }).text ?? '')), '전달')
  assert.ok(!t.slack.reactions.includes(`+eyes@${s.ack}`), String(t.slack.reactions))
  s2.conn.close()
  t.close()
})

test('2-6 재시작 되살리기·복제도 모델과 effort 를 넘긴다', async () => {
  const t = await setup()
  const thread = await t.broker.launchSession({ cwd: '/tmp', prompt: '', user: 'U1', extraArgs: ['--model', 'opus[1m]', '--effort', 'high'] })
  const s = await shim(t.socketPath, { tmuxPane: '%69', sessionId: 's1', threadTs: thread })
  await hook(t.socketPath, 100, { hook_event_name: 'SessionStart', source: 'startup' }, t.transcript)
  await t.broker.webFork(100)
  assert.ok(t.tmux.launches.at(-1)!.command.join(' ').includes('--model opus[1m] --effort high'), '복제: ' + t.tmux.launches.at(-1)!.command.join(' '))
  t.broker.saveState()
  s.conn.close()
  t.close()
  const cfg = (t.broker as unknown as { cfg: { revivePath: string; offsetsPath: string } }).cfg
  const t2 = await setup({ revivePath: cfg.revivePath, offsetsPath: cfg.offsetsPath, reviveAfterMs: 5 })
  await t2.broker.reviveSessions()
  const cmd = t2.tmux.launches.at(-1)?.command.join(' ') ?? ''
  assert.ok(cmd.includes('--model opus[1m]') && cmd.includes('--effort high'), '되살리기: ' + cmd)
  t2.close()
})

test('2-7 재시작 직후 등록되자마자 온 권한 요청도 전부 허용으로 처리한다(기록을 먼저 되살린다)', async () => {
  const t = await setup()
  const s = await shim(t.socketPath, { tmuxPane: '%70' })
  await t.broker.handleSlackMessage({ user: 'U1', text: ':auto on', ts: '4.7', threadTs: s.ack, channel: 'C1' })
  await tick()
  t.broker.saveState()
  s.conn.close()
  t.close()
  const cfg = (t.broker as unknown as { cfg: { revivePath: string; offsetsPath: string } }).cfg
  const t2 = await setup({ revivePath: cfg.revivePath, offsetsPath: cfg.offsetsPath })
  // The thread search is slow: a permission request arrives in that gap.
  const orig = t2.slack.replies.bind(t2.slack)
  t2.slack.replies = async (ts: string) => (await new Promise((r) => setTimeout(r, 200)), orig(ts))
  void t2.broker.reviveSessions()
  // The dialog is on screen, and its Notification hook comes in right after registration, before the slow search ends.
  t2.tmux.screen = ' Bash command\n\n   ls\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n'
  const s2p = shim(t2.socketPath, { tmuxPane: '%70', threadTs: s.ack })
  await tick(60)
  await hook(t2.socketPath, 100, { hook_event_name: 'Notification', notification_type: 'agent_needs_input', message: '확인' })
  const s2 = await s2p
  await until(() => t2.tmux.keys.includes('%70:1'), '전부 허용으로 누른다')
  assert.ok(!t2.slack.posts.some((p) => /선택을 기다립니다/.test(p.text)), '카드는 올리지 않는다')
  s2.conn.close()
  t2.close()
})

test('2-8 예약한 새로고침은 브로커를 재시작해도 남는다; 2-9 늦게 붙은 세션에는 유령 "끝남" 줄이 남지 않는다', async () => {
  const t = await setup({ processFacts: async () => ({ startedAt: 0, shells: 5 }) })
  const s = await shim(t.socketPath, { tmuxPane: '%71', sessionId: 's1' })
  await hook(t.socketPath, 100, { hook_event_name: 'SessionStart', source: 'startup' }, t.transcript)
  appendFileSync(t.transcript, bgStart('b4', 'sleep 99'))
  await tick(150)
  await t.broker.webAction({ actionId: 'ctl_btn_web', value: '100:refresh later' })
  t.broker.saveState()
  s.conn.close()
  t.close()
  const cfg = (t.broker as unknown as { cfg: { revivePath: string; offsetsPath: string } }).cfg
  const t2 = await setup({ revivePath: cfg.revivePath, offsetsPath: cfg.offsetsPath, transcript: t.transcript, processFacts: async () => ({ startedAt: 0, shells: 5 }) })
  void t2.broker.reviveSessions()
  const s2 = await shim(t2.socketPath, { tmuxPane: '%71', threadTs: s.ack, sessionId: 's1' })
  await until(() => t2.broker.webSessions().length === 1, '다시 붙음')
  assert.equal(t2.broker.webSessions()[0]!.refreshAfter, true, '예약이 남는다')
  s2.conn.close()
  t2.close()

  // 2-9: a relaunch that timed out and attached later, then ended: no leftover "끝남" line.
  const t3 = await setup({ launchTimeoutMs: 30 })
  const th = await t3.broker.launchSession({ cwd: '/tmp', prompt: '', user: 'U1', resumeId: 's9' })
  await tick(80)
  const s3 = await shim(t3.socketPath, { tmuxPane: '%72', sessionId: 's9', threadTs: th })
  await until(() => t3.broker.webSessions().some((r) => r.thread === th && r.state !== 'ended'), '늦게 붙음')
  s3.conn.close()
  await until(() => !t3.broker.webSessions().some((r) => r.thread === th && r.state !== 'ended'), '끝남')
  // The session that ended is listed as ended (43), never as alive.
  assert.ok(!t3.broker.webSessions().some((r) => r.thread === th && r.state !== 'ended'), JSON.stringify(t3.broker.webSessions()))
  t3.close()
})

test('3-4 세션이 끝나면 백그라운드 추적기(key+pid+path)를 지운다', async () => {
  const t = await setup({ processFacts: async () => ({ startedAt: 0, shells: 0 }) })
  const s = await shim(t.socketPath, { tmuxPane: '%73', sessionId: 's1' })
  await hook(t.socketPath, 100, { hook_event_name: 'SessionStart', source: 'startup' }, t.transcript)
  await t.broker.webRefreshInfo(100)
  const maps = t.broker as unknown as { bgTrackers: Map<string, unknown>; skillReaders: Map<string, unknown> }
  assert.equal(maps.bgTrackers.size, 1)
  await hook(t.socketPath, 100, { hook_event_name: 'SessionEnd', reason: 'exit' }, t.transcript)
  await until(() => t.broker.webSessions().length === 0, '끝남')
  assert.equal(maps.bgTrackers.size, 0)
  s.conn.close()
  t.close()
})

test('4-6 채널 안내문에 HTML 은 스크립트 없이 그린다는 말이 있다', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../src/channel.ts', import.meta.url), 'utf8')
  assert.match(src, /```html blocks and attached \.html files \(read-only, no scripts\)/)
})

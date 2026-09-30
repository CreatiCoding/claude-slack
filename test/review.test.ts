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
  // A line from this process counts, but the newer of it and the cache's pick wins.
  writeFileSync(t, JSON.stringify({ type: 'user', timestamp: new Date(refreshedAt + 5_000).toISOString(), message: { content: [{ type: 'text', text: `Base directory for this skill: ${dir}/cache/kit/kit/0.4.2/skills/x` }] } }) + '\n')
  assert.deepEqual(sessionPlugins({ pluginsDir: dir, user: 'me', processStart: refreshedAt, transcript: t }), [{ market: 'kit', version: '0.5.0' }])
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

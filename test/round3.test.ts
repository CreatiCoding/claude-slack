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

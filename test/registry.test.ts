import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SessionRegistry } from '../src/registry.ts'
import { RecentKeys } from '../src/dedupe.ts'
import type { Session } from '../src/session.ts'

function session(key: string, pid: number, threadTs: string): Session {
  return { key, pid, sessionId: 's', cwd: '/p', threadTs, origin: 'slack', ended: false, recipient: 'U1', statusCreated: false, state: 'idle', startedAt: 0 }
}

test('a session is findable by launch key, thread and pid', () => {
  const r = new SessionRegistry()
  const s = session('k1', 100, '1.0')
  r.add(s)
  assert.equal(r.byLaunchKey('k1'), s)
  assert.equal(r.byThreadTs('1.0'), s)
  assert.equal(r.byPid(100), s)
  assert.deepEqual(r.live, [s])
})

test('an ended session stays findable by pid so its panel buttons still work', () => {
  const r = new SessionRegistry()
  const s = session('k1', 100, '1.0')
  r.add(s)
  s.ended = true
  r.remember(s)
  assert.deepEqual(r.live, [], 'no longer live')
  assert.equal(r.byLaunchKey('k1'), undefined)
  assert.equal(r.byPid(100), s, 'purge from the leftover panel still resolves')
})

test('a live session wins over an ended one that reused the pid', () => {
  const r = new SessionRegistry()
  const old = session('k1', 100, '1.0')
  r.add(old)
  old.ended = true
  r.remember(old)
  const fresh = session('k2', 100, '2.0')
  r.add(fresh)
  assert.equal(r.byPid(100), fresh)
})

test('only the most recent ended sessions are remembered', () => {
  const r = new SessionRegistry()
  for (let i = 0; i < 60; i++) {
    const s = session(`k${i}`, i, `${i}.0`)
    r.add(s)
    r.remember(s)
  }
  assert.equal(r.byPid(0), undefined, 'the oldest was dropped')
  assert.ok(r.byPid(59), 'the newest is kept')
})

test('RecentKeys suppresses a repeat inside the window and allows it after', () => {
  const d = new RecentKeys(1000)
  assert.equal(d.isRepeat('a', 0), false, 'first time')
  assert.equal(d.isRepeat('a', 500), true, 'inside the window')
  assert.equal(d.isRepeat('b', 500), false, 'a different key is unaffected')
  assert.equal(d.isRepeat('a', 2000), false, 'outside the window')
})

test('RecentKeys keeps suppressing a sustained burst', () => {
  const d = new RecentKeys(1000)
  d.isRepeat('a', 0)
  // Each repeat refreshes the timestamp, so a steady stream never slips through.
  for (let t = 500; t <= 5000; t += 500) assert.equal(d.isRepeat('a', t), true, `t=${t}`)
})

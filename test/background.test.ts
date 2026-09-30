import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BackgroundTracker } from '../src/background.ts'

const T0 = Date.parse('2026-10-01T10:00:00Z')
const at = (s: number) => new Date(T0 + s * 1000).toISOString()
const use = (id: string, name: string, input: object, t: number) => JSON.stringify({ type: 'assistant', timestamp: at(t), message: { content: [{ type: 'tool_use', id, name, input }] } }) + '\n'
const result = (id: string, text: string, t: number) => JSON.stringify({ type: 'user', timestamp: at(t), message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] } }) + '\n'
const notice = (id: string, status: string, t: number) => JSON.stringify({ type: 'user', timestamp: at(t), message: { content: `<task-notification>\n<task-id>x</task-id>\n<tool-use-id>${id}</tool-use-id>\n<status>${status}</status>\n</task-notification>` } }) + '\n'

function file(): string {
  const f = join(mkdtempSync(join(tmpdir(), 'bg-')), 't.jsonl')
  writeFileSync(f, '')
  return f
}

test('시작은 도구 결과 첫머리의 문구로만(명령 출력 속 같은 글자는 아니다), 끝은 알림·TaskStop', () => {
  const f = file()
  appendFileSync(f, use('u1', 'Bash', { command: 'npm run dev', run_in_background: true }, 0))
  appendFileSync(f, result('u1', 'Command running in background with ID: bab12. Output is being written to: /tmp/x', 1))
  appendFileSync(f, use('u2', 'Bash', { command: 'cat log' }, 2))
  appendFileSync(f, result('u2', 'line 1\nCommand running in background with ID: fake9.', 3))
  appendFileSync(f, use('u3', 'Task', { description: '문서 조사' }, 4))
  appendFileSync(f, result('u3', 'Async agent launched successfully.\nagentId: a77 (internal)', 5))
  appendFileSync(f, use('u4', 'Bash', { command: 'sleep 999' }, 6))
  appendFileSync(f, result('u4', 'Command was manually backgrounded; moved to the background (ID: bmv1). Output…', 7))
  const bg = new BackgroundTracker(f)
  bg.scan()
  assert.deepEqual(bg.open({ now: T0 + 60_000 }).map((t) => [t.kind, t.id, t.label]), [
    ['bash', 'bab12', 'npm run dev'],
    ['agent', 'a77', '문서 조사'],
    ['bash', 'bmv1', 'sleep 999'],
  ])
  // Ends: a notification that is not "running" for u1, a TaskStop for bmv1; a "running" notice ends nothing.
  appendFileSync(f, notice('u3', 'running', 8))
  appendFileSync(f, notice('u1', 'completed', 9))
  appendFileSync(f, use('u5', 'TaskStop', { task_id: 'bmv1' }, 10))
  bg.scan()
  assert.deepEqual(bg.open({ now: T0 + 60_000 }).map((t) => t.id), ['a77'])
})

test('Monitor 는 timeout_ms 가 지나면 끝(가짜 시계), 프로세스 시작 전 작업은 빼고, 열린 셸 수만큼 최신 것만', () => {
  mock.timers.enable({ apis: ['Date'], now: T0 })
  try {
    const f = file()
    appendFileSync(f, use('m1', 'Monitor', { command: 'tail -f x', timeout_ms: 300_000 }, 0))
    appendFileSync(f, result('m1', 'Monitor started (task b3ai, expires in 5m unless the source ends first; …)', 0))
    appendFileSync(f, use('old', 'Bash', { command: 'old one' }, -100))
    appendFileSync(f, result('old', 'Command running in background with ID: bold.', -100))
    appendFileSync(f, use('b1', 'Bash', { command: 'a' }, 10))
    appendFileSync(f, result('b1', 'Command running in background with ID: b1.', 10))
    appendFileSync(f, use('b2', 'Bash', { command: 'b' }, 20))
    appendFileSync(f, result('b2', 'Command running in background with ID: b2.', 20))
    const bg = new BackgroundTracker(f)
    bg.scan()
    const ids = () => bg.open({ now: Date.now(), processStart: T0 - 1000, shells: 2 }).map((t) => t.id)
    assert.deepEqual(ids(), ['b1', 'b2'], '셸은 2개: 최신 둘(b1·b2), Monitor 는 더 오래돼 빠진다; 시작 전 작업(bold)도 빠진다')
    assert.deepEqual(bg.open({ now: Date.now(), processStart: T0 - 1000 }).map((t) => t.id), ['b3ai', 'b1', 'b2'])
    mock.timers.tick(301_000)
    assert.deepEqual(bg.open({ now: Date.now(), processStart: T0 - 1000 }).map((t) => t.id), ['b1', 'b2'], '5분 지나면 Monitor 는 끝')
  } finally {
    mock.timers.reset()
  }
})

test('긴 파일은 끝 16MB 만 처음 읽고, 이어서 읽는다(줄 중간부터 시작한 조각은 버린다)', () => {
  const f = file()
  const filler = JSON.stringify({ type: 'user', message: { content: 'x'.repeat(1000) } }) + '\n'
  appendFileSync(f, use('early', 'Bash', { command: 'early' }, 0) + result('early', 'Command running in background with ID: early.', 0))
  appendFileSync(f, filler.repeat(17 * 1024))
  const bg = new BackgroundTracker(f)
  bg.scan()
  assert.deepEqual(bg.open({ now: T0 }), [], '16MB 밖의 시작은 모른다')
  appendFileSync(f, use('late', 'Bash', { command: 'late' }, 5) + result('late', 'Command running in background with ID: late.', 5))
  bg.scan()
  assert.deepEqual(bg.open({ now: T0 + 10_000 }).map((t) => t.id), ['late'])
})

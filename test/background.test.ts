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
  appendFileSync(f, result('u5', '{"message":"Successfully stopped task: bmv1 (sleep 999)"}', 10))
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
  // The label as well as the id: dropping the first new line would lose the tool call's name tag.
  assert.deepEqual(bg.open({ now: T0 + 10_000 }).map((t) => [t.id, t.label]), [['late', 'late']])
})

// ---- 코드 리뷰에서 나온 결함

test('3-1 도구 사용이 없는 짧은 파일을 한 번 읽은 뒤 이어 쓴 첫 줄을 버리지 않는다', () => {
  const f = file()
  appendFileSync(f, JSON.stringify({ type: 'user', timestamp: at(0), message: { content: '안녕' } }) + '\n')
  const bg = new BackgroundTracker(f)
  bg.scan()
  appendFileSync(f, use('u9', 'Bash', { command: 'npm run dev' }, 1))
  appendFileSync(f, result('u9', 'Command running in background with ID: b9.', 2))
  bg.scan()
  assert.deepEqual(bg.open({ now: T0 + 5000 }).map((t) => [t.id, t.label]), [['b9', 'npm run dev']])
})

test('3-2 zsh 로 도는 셸도 센다(-c 로 뜬 셸 자식 모두)', async () => {
  const { countShells } = await import('../src/background.ts')
  const ps = ['  7 100 /bin/zsh -c -l source ~/.zshrc && npm run dev', '  8 100 /bin/bash -c sleep 9', '  9 100 zsh -c tail -f x', '  10 100 sh -c ls', '  11 100 node server.js', '  12 200 /bin/zsh -c other'].join('\n')
  assert.equal(countShells(ps, 100), 4)
})

test('3-3 한국어 로케일에서도 프로세스 시작 시각을 읽는다(ps 는 LC_ALL=C 로)', async () => {
  const { processFacts } = await import('../src/background.ts')
  const { chmodSync } = await import('node:fs')
  const dir = mkdtempSync(join(tmpdir(), 'ps-'))
  const ps = join(dir, 'ps')
  // A fake ps: Korean dates unless LC_ALL=C, as the real one does with a Korean LC_TIME.
  writeFileSync(ps, `#!/bin/sh\nif [ "$2" = "lstart=" ]; then if [ "$LC_ALL" = "C" ]; then echo "Wed Oct  1 10:00:00 2026"; else echo "수 10  1 10:00:00 2026"; fi; else echo "  1 1 /bin/zsh -c x"; fi\n`)
  chmodSync(ps, 0o755)
  const prev = process.env.LC_ALL
  process.env.LC_ALL = 'ko_KR.UTF-8'
  try {
    const f = await processFacts(1, ps)
    assert.equal(f.startedAt, new Date(2026, 9, 1, 10, 0, 0).getTime())
    assert.equal(f.shells, 1)
  } finally {
    if (prev === undefined) delete process.env.LC_ALL
    else process.env.LC_ALL = prev
  }
})

test('3-4 도구 입력을 쌓아 두지 않는다(이름표만, 결과가 오면 지운다)', () => {
  const f = file()
  appendFileSync(f, use('w1', 'Write', { file_path: '/x', content: 'y'.repeat(100_000) }, 0))
  appendFileSync(f, result('w1', 'File created', 1))
  appendFileSync(f, use('w2', 'Write', { file_path: '/z', content: 'z'.repeat(100_000) }, 2))
  const bg = new BackgroundTracker(f)
  bg.scan()
  const uses = (bg as unknown as { uses: Map<string, unknown> }).uses
  assert.equal(uses.size, 1, '결과가 온 것은 지운다')
  assert.ok(JSON.stringify([...uses.values()]).length < 400, '파일 내용은 남기지 않는다')
})

test('3-5 판정 세부: "moved to the background" 는 첫머리만, timeout_ms 없는 Monitor 는 5분, 실패한 TaskStop 은 무시, 끝은 task-id 로도', () => {
  mock.timers.enable({ apis: ['Date'], now: T0 })
  try {
    const f = file()
    appendFileSync(f, use('o1', 'Bash', { command: 'cat log' }, 0))
    appendFileSync(f, result('o1', 'log line: moved to the background (ID: fake1) earlier', 0))
    appendFileSync(f, use('mv', 'Bash', { command: 'long job' }, 1))
    appendFileSync(f, result('mv', 'Command did not complete within its 120s timeout and was moved to the background (ID: bmv). Output…', 1))
    appendFileSync(f, use('m2', 'Monitor', { command: 'watch' }, 2))
    appendFileSync(f, result('m2', 'Monitor started (task bmon, you get one notice at expiry)', 2))
    appendFileSync(f, use('st', 'TaskStop', { task_id: 'bmv' }, 3))
    appendFileSync(f, JSON.stringify({ type: 'user', timestamp: at(3), message: { content: [{ type: 'tool_result', tool_use_id: 'st', is_error: true, content: 'No task found with ID: bmv' }] } }) + '\n')
    const bg = new BackgroundTracker(f)
    bg.scan()
    assert.deepEqual(bg.open({ now: Date.now() }).map((t) => t.id), ['bmv', 'bmon'], '출력 속 문구는 아니다; 실패한 TaskStop 은 끝이 아니다')
    // A notification with only <task-id> ends it too.
    appendFileSync(f, JSON.stringify({ type: 'user', timestamp: at(4), message: { content: '<task-notification>\n<task-id>bmv</task-id>\n<status>completed</status>\n</task-notification>' } }) + '\n')
    bg.scan()
    assert.deepEqual(bg.open({ now: Date.now() }).map((t) => t.id), ['bmon'])
    mock.timers.tick(299_000)
    assert.deepEqual(bg.open({ now: Date.now() }).map((t) => t.id), ['bmon'], '5분 전에는 열림')
    mock.timers.tick(5_000)
    assert.deepEqual(bg.open({ now: Date.now() }).map((t) => t.id), [], 'timeout_ms 가 없으면 5분')
  } finally {
    mock.timers.reset()
  }
})

test('실제 기록 형식: 완료 알림은 queue-operation(enqueue)·attachment(queued_command) 줄로도 온다', () => {
  const f = file()
  appendFileSync(f, use('q1', 'Bash', { command: 'measure' }, 0))
  appendFileSync(f, result('q1', 'Command running in background with ID: bq1. Output …', 0))
  appendFileSync(f, use('q2', 'Bash', { command: 'other' }, 1))
  appendFileSync(f, result('q2', 'Command running in background with ID: bq2. Output …', 1))
  const bg = new BackgroundTracker(f)
  bg.scan()
  assert.equal(bg.open({ now: T0 + 5000 }).length, 2)
  const notice = (id: string, tid: string) => `<task-notification>\n<task-id>${tid}</task-id>\n<tool-use-id>${id}</tool-use-id>\n<status>completed</status>\n</task-notification>`
  appendFileSync(f, JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: at(9), content: notice('q1', 'bq1') }) + '\n')
  appendFileSync(f, JSON.stringify({ type: 'attachment', timestamp: at(9), attachment: { type: 'queued_command', prompt: notice('q2', 'bq2') } }) + '\n')
  bg.scan()
  assert.deepEqual(bg.open({ now: T0 + 10_000 }), [])
})

test('4 TaskStop 성공은 문구의 첫머리("Successfully stopped")로: 설명에 failed·not found 가 있어도 성공', () => {
  const f = file()
  appendFileSync(f, use('g1', 'Bash', { command: 'grep failed log' }, 0))
  appendFileSync(f, result('g1', 'Command running in background with ID: bg1.', 0))
  appendFileSync(f, use('st1', 'TaskStop', { task_id: 'bg1' }, 1))
  appendFileSync(f, result('st1', '{"message":"Successfully stopped task: bg1 (grep failed log | not found)"}', 1))
  const bg = new BackgroundTracker(f)
  bg.scan()
  assert.deepEqual(bg.open({ now: T0 + 5000 }), [])
})

test('백그라운드 셸 수(75): Claude 프로세스 아래의 셸을 센다. 채널 심의 pid 면 부모(Claude)로 올라간다', async () => {
  const { countShells, claudeRoot } = await import('../src/background.ts')
  const ps = [
    '  100     1 /usr/bin/tmux',
    '  200   100 claude --resume x',
    '  300   200 /usr/bin/node channel-shim.js',
    '  400   200 /bin/zsh -c npm test',
    '  401   200 /bin/sh -c tail -f log',
    '  402   300 /bin/sh -c not counted, child of the shim',
  ].join('\n')
  assert.equal(claudeRoot(ps, 200), 200, 'Claude 자신이면 그대로')
  assert.equal(claudeRoot(ps, 300), 200, '채널 심이면 부모 Claude')
  assert.equal(countShells(ps, claudeRoot(ps, 300)), 2, 'Claude 아래의 셸 둘')
})

test('Claude 판정(60): 실행 파일로 가리고, 채널 심 경로에 claude 가 있어도 Claude 가 아니다', async () => {
  const { isClaudeCommand } = await import('../src/background.ts')
  assert.equal(isClaudeCommand('claude --chrome --resume a0845832'), true)
  assert.equal(isClaudeCommand('/opt/homebrew/bin/claude --dangerously-load-development-channels server:slack'), true)
  assert.equal(isClaudeCommand('/opt/homebrew/Cellar/node/26.8.1/bin/node /Users/me/projects/claude-slack/src/channel.ts'), false, '채널 심은 Claude 가 아니다')
  assert.equal(isClaudeCommand('/bin/zsh -l'), false)
  assert.equal(isClaudeCommand('/usr/bin/node /usr/local/bin/claude --resume x'), true, 'node 로 실행되는 claude 스크립트')
})

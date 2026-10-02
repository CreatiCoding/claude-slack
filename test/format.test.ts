import { test } from 'node:test'
import assert from 'node:assert/strict'
import { activityDetails, activityLine, activitySources, chunk, describeError, processAlive, detectContextUsage, duration, parseColumns, parseLaunchText, parseTodos, PERMISSION_REPLY_RE, screenDigest, systemEnvelope, tableBlock, todoList, toMrkdwn } from '../src/format.ts'
import { decodeAnswer, decodeResume, encodeResume, OPTION_VALUE_MAX } from '../src/actions.ts'
import { alertBlock, todoPlanBlock } from '../src/format.ts'

test('parseLaunchText picks a leading directory', () => {
  const isDir = (p: string) => p.endsWith('/projects/foo')
  assert.deepEqual(parseLaunchText('~/projects/foo 테스트 고쳐줘', '/default', isDir), {
    cwd: `${process.env.HOME}/projects/foo`,
    prompt: '테스트 고쳐줘',
  })
  assert.deepEqual(parseLaunchText('/tmp/projects/foo', '/default', isDir), { cwd: '/tmp/projects/foo', prompt: '' })
})

test('parseLaunchText falls back to default cwd', () => {
  assert.deepEqual(parseLaunchText('그냥 프롬프트', '/default', () => false), { cwd: '/default', prompt: '그냥 프롬프트' })
  assert.deepEqual(parseLaunchText('/not/a/dir 프롬프트', '/default', () => false), { cwd: '/default', prompt: '/not/a/dir 프롬프트' })
})

test('toMrkdwn converts bold, headers, links, bullets and leaves code alone', () => {
  const md = '# Title\n**bold** and [x](https://e.com)\n- item\n```js\n**not bold**\n```'
  assert.equal(toMrkdwn(md), '*Title*\n*bold* and <https://e.com|x>\n• item\n```js\n**not bold**\n```')
})

test('chunk splits on lines and keeps fences balanced', () => {
  const text = 'a\n```\n' + 'x'.repeat(30) + '\n' + 'y'.repeat(30) + '\n```\nz'
  const parts = chunk(text, 45)
  assert.ok(parts.length >= 2)
  for (const p of parts) assert.equal((p.match(/```/g) ?? []).length % 2, 0, `unbalanced: ${p}`)
  assert.equal(parts.join('\n').replace(/```\n```\n/g, ''), text.replace(/```\n```\n/g, ''))
})

test('chunk leaves short text alone', () => {
  assert.deepEqual(chunk('hi'), ['hi'])
})

test('activityLine formats common tools', () => {
  assert.equal(activityLine('Bash', { command: 'npm test\necho done' }, '/p'), '⚙️ Bash `npm test`')
  assert.equal(activityLine('Edit', { file_path: '/p/src/a.ts' }, '/p'), '✏️ Edit `src/a.ts`')
  assert.equal(activityLine('Grep', { pattern: 'foo' }, '/p'), '🔍 Grep `foo`')
  assert.equal(activityLine('mcp__slack__reply', { text: 'hello' }, '/p'), '🔧 slack__reply `hello`')
  assert.equal(activityLine('Weird', {}, '/p'), '🔧 Weird')
})

test('activityLine 은 cd 로 시작하는 Bash 호출에서 실제로 실행된 명령을 보여준다', () => {
  const line = (command: string) => activityLine('Bash', { command }, '/p')
  // The shape that made every call in a Slack thread read "Bash cd /Users/me/projects/app".
  assert.equal(line('cd /Users/me/projects/app\nnpm test'), '⚙️ Bash `npm test`')
  assert.equal(line('cd /p && npm test'), '⚙️ Bash `npm test`')
  assert.equal(line('cd /p; npm test'), '⚙️ Bash `npm test`')
  assert.equal(line("cd '/p with space' && ls"), '⚙️ Bash `ls`')
  assert.equal(line('cd /a && cd /b && ls'), '⚙️ Bash `ls`')
  // Nothing but the hop: keep it rather than showing an empty line.
  assert.equal(line('cd /p'), '⚙️ Bash `cd /p`')
})

test('activityLine 은 히어독 껍데기 대신 안에서 무엇을 하는지 보여준다', () => {
  const line = (command: string) => activityLine('Bash', { command }, '/p')
  // The shape that made a whole thread read "Bash python3 - <<'PYEOF'".
  assert.equal(
    line("python3 - <<'PYEOF'\nimport json\nrows = json.load(open('runs.json'))\nprint(len(rows))\nPYEOF"),
    "⚙️ Bash `python3 · rows = json.load(open('runs.json'))`",
  )
  // The cd hop and the heredoc together, which is how they usually arrive.
  assert.equal(line("cd /p && node - <<'EOF'\nconsole.log(1)\nEOF"), '⚙️ Bash `node · console.log(1)`')
  // A heredoc writing a file already says what it does on the launcher line.
  assert.match(line("cat > /p/a.py <<'EOF'\nprint(1)\nEOF"), /cat > \/p\/a\.py · print\(1\)/)
  // Nothing but preamble: show the first body line rather than dropping to nothing.
  assert.equal(line("python3 - <<'EOF'\nimport os\nEOF"), '⚙️ Bash `python3 · import os`')
  // A plain command still reads as itself.
  assert.equal(line('npm test'), '⚙️ Bash `npm test`')
})

test('activityLine 은 -c 로 넘긴 스크립트도 히어독과 같게 다룬다', () => {
  const line = (command: string) => activityLine('Bash', { command }, '/p')
  // The shape that rendered as a bare `uv run python -c "` with the script cut off.
  assert.equal(
    line('cd /p\nuv run python -c "\nfrom alphabench.rules.observables import get\nfor k in (\'a\',\'b\'):\n    print(k)\n"'),
    "⚙️ Bash `uv run python · for k in ('a','b'):`",
  )
  // A quote that closes on the same line is just part of the command.
  assert.equal(line('grep -n "type=checkbox" run.html'), '⚙️ Bash `grep -n "type=checkbox" run.html`')
  assert.equal(line('echo "=== 확인"'), '⚙️ Bash `echo "=== 확인"`')
  assert.equal(line("sed -i '' 's/a/b/' x.css"), "⚙️ Bash `sed -i '' 's/a/b/' x.css`")
})

test('activityDetails 는 한 줄 요약이 버린 것만 담는다', () => {
  const script = 'cd /p\nuv run python -c "\nfor k in (1,2):\n    print(k)\n"'
  assert.equal(activityDetails('Bash', { command: script }), script)
  // A command the summary already showed whole has nothing to expand into.
  assert.equal(activityDetails('Bash', { command: 'npm test' }), undefined)
  assert.equal(activityDetails('Read', { file_path: '/p/a.ts' }), undefined)
})

test('activitySources 는 가져온 주소를 링크로 넘긴다', () => {
  assert.deepEqual(activitySources('WebFetch', { url: 'https://docs.slack.dev/messaging' }), [
    { type: 'url', url: 'https://docs.slack.dev/messaging', text: 'docs.slack.dev' },
  ])
  assert.equal(activitySources('WebFetch', { url: 'not-a-url' }), undefined)
  assert.equal(activitySources('Bash', { command: 'ls' }), undefined)
})

test('PERMISSION_REPLY_RE matches the documented forms', () => {
  assert.ok(PERMISSION_REPLY_RE.test('yes abcde'))
  assert.ok(PERMISSION_REPLY_RE.test('N ABCDE'))
  assert.ok(!PERMISSION_REPLY_RE.test('yes'))
  assert.ok(!PERMISSION_REPLY_RE.test('yes abcle'))
})

const TUI_SCREEN = [
  "   \u2514  Tip: Use /btw to ask a quick side question without interrupting Claude's current work",
  '',
  '\u2500'.repeat(40),
  '\u2500'.repeat(40),
  '',
  '\u276f ',
  '\u2500'.repeat(40),
  '',
  '  \u25b6\u25b6 auto mode on (shift+tab to cycle) \u00b7 esc to interrupt \u00b7 \u2190 for agents \u00b7 \u2193 to manage',
  '',
  '  \u25c9 main',
  '   \u25cb general-purpose      Searching backtest overfitting literature   1m 13s',
  '   \u25cb general-purpose (+3) Launching systematic funds research agent   58s',
].join('\n')

test('screenDigest keeps the progress lines and drops the TUI chrome', () => {
  const out = screenDigest(TUI_SCREEN)
  assert.match(out, /general-purpose/)
  assert.match(out, /Searching backtest overfitting/)
  assert.ok(!/Tip:/.test(out), 'tip banner dropped')
  assert.ok(!/auto mode on/.test(out), 'status line dropped')
  assert.ok(!/\u2500\u2500/.test(out), 'separators dropped')
  assert.ok(!/^\s*\u276f\s*$/m.test(out), 'empty input box dropped')
})

test('screenDigest keeps the newest lines and caps the count', () => {
  const many = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')
  const out = screenDigest(many, 5).split('\n')
  assert.equal(out.length, 5)
  assert.equal(out.at(-1), 'line 29')
})

test('duration reads as a person would say it', () => {
  assert.equal(duration(45_000), '45초')
  assert.equal(duration(96_000), '1분 36초')
  assert.equal(duration(120_000), '2분')
  assert.equal(duration(3_900_000), '1시간 5분')
})

const TASK_NOTIFICATION = `<task-notification>
<task-id>a06d66d31c4d4c9b2</task-id>
<tool-use-id>toolu_013R5nujeTwsSzeQ2r4rxJJW</tool-use-id>
<output-file>/private/tmp/claude-501/tasks/a06d66d31c4d4c9b2.output</output-file>
<status>completed</status>
<summary>Agent "Academic literature on stock prediction" finished</summary>
<result>I have enough. Here's the report.

# Machine Learning for Stock Return Prediction: A Literature Review
...lots more...</result>
</task-notification>`

test('systemEnvelope recognizes what Claude Code injects, and summarizes a finished agent', () => {
  const e = systemEnvelope(TASK_NOTIFICATION)!
  assert.equal(e.kind, 'task-notification')
  assert.equal(e.summary, 'Agent "Academic literature on stock prediction" finished')
  assert.equal(systemEnvelope('<channel source="slack">안녕</channel>')!.kind, 'channel')
  assert.equal(systemEnvelope('<system-reminder>…</system-reminder>')!.kind, 'system-reminder')
  assert.equal(systemEnvelope('<local-command-stdout>ok</local-command-stdout>')!.kind, 'local-command-stdout')
})

test('systemEnvelope leaves real typing alone, including text that merely mentions a tag', () => {
  assert.equal(systemEnvelope('테스트 돌려줘'), null)
  assert.equal(systemEnvelope('<div>는 왜 안 되지?'), null)
  assert.equal(systemEnvelope('이 <task-notification> 은 뭐야?'), null, '문장 중간의 태그는 봉투가 아니다')
})

test('a failed agent keeps its status in the summary', () => {
  const failed = TASK_NOTIFICATION.replace('<status>completed</status>', '<status>failed</status>')
  assert.match(systemEnvelope(failed)!.summary!, /\(failed\)$/)
})

test('activityLine tells subagents apart by kind', () => {
  const line = activityLine('Agent', { subagent_type: 'general-purpose', description: 'Searching backtest overfitting literature' }, '/p')
  assert.match(line, /general-purpose/)
  assert.match(line, /Searching backtest overfitting/)
  // Older transcripts name the same tool Task.
  assert.match(activityLine('Task', { subagent_type: 'Explore', description: '코드 찾기' }, '/p'), /Explore · 코드 찾기/)
})

test('activityLine summarizes a todo update instead of dumping its payload', () => {
  const todos = [
    { content: '스키마 정리', status: 'completed' },
    { content: '핸들러 작성', activeForm: '핸들러 작성 중', status: 'in_progress' },
    { content: '테스트', status: 'pending' },
  ]
  assert.match(activityLine('TodoWrite', { todos }, '/p'), /핸들러 작성 중 \(1\/3\)/)
  assert.match(activityLine('TodoWrite', { todos: [] }, '/p'), /0\/0/)
})

test('describeError turns a Slack failure into something to act on', () => {
  const missing = { data: { error: 'missing_scope', needed: 'chat:write' } }
  assert.match(describeError(missing), /스코프를 추가하고 재설치/)
  assert.match(describeError(missing), /chat:write/, '무엇이 필요한지 말한다')

  assert.match(describeError({ data: { error: 'not_in_channel' } }), /초대/)
  assert.match(describeError({ data: { error: 'not_in_channel' } }), /not_in_channel/, '원래 코드도 남긴다')
  assert.match(describeError({ data: { error: 'ratelimited' } }), /잠시 후/)
  // An unknown Slack code still reads as a Slack problem, not a stack trace.
  assert.equal(describeError({ data: { error: 'weird_new_code' } }), 'Slack 오류 `weird_new_code`')
})

test('describeError explains tmux failures', () => {
  assert.match(describeError({ code: 1, stderr: "can't find session: claude-slack\n" }), /tmux 세션이 없습니다/)
  assert.match(describeError({ code: 'ENOENT', message: 'spawn tmux ENOENT' }), /tmux 를 찾지 못했습니다/)
})

test('describeError falls back to one readable line, never a wall of text', () => {
  const long = new Error('첫 줄이 중요하다\n'.repeat(50))
  const out = describeError(long)
  assert.ok(!out.includes('\n'), '여러 줄을 쏟지 않는다')
  assert.ok(out.length <= 200, `길이 ${out.length}`)
})

test('todoList shows progress at a glance', () => {
  const out = todoList([
    { content: '스키마 정리', status: 'completed' },
    { content: '핸들러 작성', activeForm: '핸들러 작성 중', status: 'in_progress' },
    { content: '테스트', status: 'pending' },
  ])
  assert.match(out, /할 일 1\/3/)
  assert.match(out, /✅ ~스키마 정리~/, '끝난 것은 지워 보인다')
  assert.match(out, /🔵 \*핸들러 작성 중\*/, '진행 중인 것은 굵게, 진행형으로')
  assert.match(out, /⬜ 테스트/)
  assert.equal(todoList([]), '', '빈 목록은 아무것도 만들지 않는다')
})

test('parseTodos ignores junk in the payload', () => {
  assert.deepEqual(parseTodos({ todos: [{ content: 'a', status: 'pending' }, null, { status: 'pending' }, 'x'] }), [{ content: 'a', activeForm: undefined, status: 'pending' }])
  assert.deepEqual(parseTodos({}), [])
  assert.deepEqual(parseTodos(undefined), [])
})

test('detectContextUsage reads the shapes Claude Code prints', () => {
  assert.equal(detectContextUsage('  Context: 37% used  ')?.label, '37%')
  assert.equal(detectContextUsage('Context left: 63%')?.percent, 37)
  assert.equal(detectContextUsage('  74k/200k tokens')?.percent, 37)
  assert.equal(detectContextUsage('  74k/200k tokens')?.label, '74k/200k')
  assert.equal(detectContextUsage('아무 관련 없는 화면'), null)
  assert.equal(detectContextUsage('context 999%'), null, '말이 안 되는 값은 버린다')
})

test('parseColumns recognizes aligned output and refuses prose', () => {
  const rows = parseColumns('  system prompt   2.1k\n  tools           8.4k\n  대화            31.0k')!
  assert.deepEqual(rows, [['system prompt', '2.1k'], ['tools', '8.4k'], ['대화', '31.0k']])
  // 문장은 우연히 공백이 겹쳐도 표가 아니다.
  assert.equal(parseColumns('이건 그냥 설명입니다.\n한 줄 더 있습니다.'), null)
  assert.equal(parseColumns('한 줄만  두 칸'), null, '행이 하나뿐이면 표로 보지 않는다')
  // 줄마다 칸 수가 다르면 표가 아니다 — 산문이 우연히 갈라진 경우다.
  assert.equal(parseColumns('a  b  c\nd  e'), null, '직사각형이 아니면 거절한다')
})

test('tableBlock fills ragged rows so Slack gets a rectangle', () => {
  const b = tableBlock([['a', 'b', 'c'], ['d', '', '']]) as { rows: Array<Array<{ text: string }>> }
  assert.equal(b.rows[0]!.length, 3)
  assert.equal(b.rows[1]!.length, 3)
  assert.ok(b.rows[1]!.every((c) => c.text.length >= 1), '빈 셀도 Slack 최소 길이를 지킨다')
})

test('decodeAnswer 는 버튼이 만든 형태와 사람이 치는 짧은 형태를 모두 받는다', () => {
  assert.deepEqual(decodeAnswer('answer 0 2 B안'), { questionIndex: 0, optionNumber: '2', label: 'B안' })
  assert.equal(decodeAnswer('answer 2 1 A')!.questionIndex, 2, '몇 번째 질문인지도 알아야 그 블록만 바꾼다')
  // HELP 가 안내하는 형태. 전에는 null 이 되어 조용히 무시됐다.
  assert.deepEqual(decodeAnswer('answer 2'), { questionIndex: 0, optionNumber: '2', label: '2' })
  assert.equal(decodeAnswer('answer'), null)
  assert.equal(decodeAnswer('screen'), null)
})

test('encodeResume 은 Slack 의 옵션 값 한도를 넘지 않는다', () => {
  const long = encodeResume('0199f2c4-1a2b-4c3d-9e8f-1122334455aa', '/Users/me/very/deeply/nested/projects/some-long-project-name', '/Users/me')
  assert.ok(long.length <= OPTION_VALUE_MAX, `${long.length}자: ${long}`)
  assert.ok(decodeResume(long)!.sessionId === '0199f2c4-1a2b-4c3d-9e8f-1122334455aa', '세션 id 는 온전히 남는다')
  // 홈 디렉터리는 ~ 로 줄이고, 그래도 길면 앞을 자른다.
  assert.match(encodeResume('s1', '/Users/me/projects/foo', '/Users/me'), /~\/projects\/foo$/)
})

test('todoPlanBlock 은 Slack 이 그리는 plan 블록 모양이다', () => {
  const plan = todoPlanBlock([
    { content: '스키마 정리', status: 'completed' },
    { content: '핸들러 작성', activeForm: '핸들러 작성 중', status: 'in_progress' },
    { content: '테스트', status: 'pending' },
  ]) as { type: string; title: string; tasks: Array<{ type: string; task_id: string; title: string; status: string }> }
  assert.equal(plan.type, 'plan')
  assert.equal(plan.title, '할 일 1/3')
  assert.deepEqual(
    plan.tasks.map((t) => t.status),
    ['complete', 'in_progress', 'pending'],
  )
  assert.equal(plan.tasks[1]!.title, '핸들러 작성 중', '진행 중인 항목은 진행형으로')
  assert.ok(new Set(plan.tasks.map((t) => t.task_id)).size === 3, 'task_id 는 겹치지 않는다')
  assert.equal(todoPlanBlock([]), null, '빈 계획은 블록을 만들지 않는다')
})

test('alertBlock 은 단계를 갖는 알림이다', () => {
  const a = alertBlock('12분째 작업 중', 'info') as { type: string; level: string; text: { type: string; text: string } }
  assert.equal(a.type, 'alert')
  assert.equal(a.level, 'info')
  assert.equal(a.text.type, 'plain_text', 'alert 는 mrkdwn 을 받지 않는다')
  assert.match(a.text.text, /12분째/)
})

test('toMrkdwn 은 표를 줄 목록으로 바꾼다 (폰에서 | 가 그대로 보였다)', () => {
  const md = '검증\n\n| 항목 | 결과 |\n|---|---|\n| 테스트 | 176개 통과 |\n| 커밋 | 3개 추가 |\n\n끝.'
  const out = toMrkdwn(md)
  assert.ok(!out.includes('|'), out)
  assert.match(out, /• \*테스트\*: 176개 통과\n• \*커밋\*: 3개 추가/)
  assert.match(out, /^검증\n\n•/)
  assert.match(out, /3개 추가\n\n끝\.$/)
  // Three columns keep their headers as labels.
  assert.match(toMrkdwn('| 이름 | 전 | 후 |\n|--|--|--|\n| a | 1 | 2 |'), /• \*a\*: 전 1 · 후 2/)
  // Tables inside code fences are left alone.
  assert.match(toMrkdwn('```\n| a | b |\n|--|--|\n| 1 | 2 |\n```'), /\| a \| b \|/)
})

test('processAlive: 지금 살아 있는 프로세스는 참, 없는 pid 는 거짓', () => {
  assert.equal(processAlive(process.pid), true)
  assert.equal(processAlive(999999), false)
})

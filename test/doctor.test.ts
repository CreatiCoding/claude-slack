import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseClaudeProcessLine } from '../scripts/doctor.ts'

test('parseClaudeProcessLine: 실제 claude 실행만 잡고, claude-slack 경로를 가진 자식 프로세스는 거른다 (claude-web 이관: P4-29)', () => {
  const real = '59305 Fri Oct  3 09:00:00 2026 CLAUDE_SLACK_SESSION=4965937a-4a09-4896-8f0a-8f9a10fe089c CLAUDE_SLACK_THREAD_TS=1790234076.094219 /opt/homebrew/bin/claude --resume abc'
  const hit = parseClaudeProcessLine(real)
  assert.ok(hit)
  assert.equal(hit!.pid, 59305)
  assert.equal(hit!.key, '4965937a-4a09-4896-8f0a-8f9a10fe089c')
  assert.equal(hit!.threadTs, '1790234076.094219')

  // 자식 프로세스: 같은 env 를 물려받았지만 claude 자신이 아니다(bash, MCP 서버 등).
  const child = '59392 Fri Oct  3 09:00:01 2026 CLAUDE_SLACK_SESSION=4965937a-4a09-4896-8f0a-8f9a10fe089c /bin/zsh -c cd /Users/creco/projects/claude-slack && npm test'
  assert.equal(parseClaudeProcessLine(child), undefined, '경로의 claude-slack 을 claude 실행으로 잘못 보지 않는다')

  const unrelated = '100 Fri Oct  3 09:00:00 2026 /usr/bin/ssh-agent'
  assert.equal(parseClaudeProcessLine(unrelated), undefined, '우리 env 가 없는 줄은 무시한다')
})

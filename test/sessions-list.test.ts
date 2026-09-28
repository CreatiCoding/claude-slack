import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { deleteRecentSession, firstUserMessage } from '../src/sessions-list.ts'

const line = (o: unknown) => JSON.stringify(o)

test('firstUserMessage: 첫 사용자 메시지를 돌려주고, Claude Code 자체 래퍼와 메타 줄은 건너뛴다', () => {
  const head = [
    line({ type: 'summary', summary: 'x' }),
    line({ type: 'user', isMeta: true, message: { content: 'meta line' } }),
    line({ type: 'user', message: { content: '<local-command-caveat>Caveat</local-command-caveat>' } }),
    line({ type: 'user', message: { content: [{ type: 'text', text: '  이 저장소 구조를 설명해줘  ' }] } }),
    line({ type: 'user', message: { content: '두 번째 메시지' } }),
  ].join('\n')
  assert.equal(firstUserMessage(head), '이 저장소 구조를 설명해줘')
})

test('firstUserMessage: Slack 에서 보낸 메시지(<channel> 메타 항목)는 안쪽 내용을 돌려준다', () => {
  const slack = line({ type: 'user', isMeta: true, message: { content: '<channel source="slack" user="U1" ts="1.2">\n네이버 들어가서 캡처해줘\n</channel>' } })
  assert.equal(firstUserMessage(slack), '네이버 들어가서 캡처해줘')
  assert.equal(firstUserMessage(line({ type: 'user', isMeta: true, message: { content: '시스템 메타' } })), undefined)
})

test('firstUserMessage: 잘린 마지막 줄은 무시하고, 길면 줄여서 돌려준다', () => {
  assert.equal(firstUserMessage(`${line({ type: 'user', message: { content: 'ok' } })}\n{"type":"user","message":{"conte`), 'ok')
  const long = firstUserMessage(line({ type: 'user', message: { content: 'a'.repeat(1000) } }))!
  assert.ok(long.length <= 241 && long.endsWith('…'))
  assert.equal(firstUserMessage(`{"type":"user","message":{"conte`), undefined)
})

test('deleteRecentSession: 그 세션의 .jsonl 과 같은 이름의 폴더만 지우고, 이상한 id 는 거부한다', async () => {
  const root = mkdtempSync(`${tmpdir()}/projects-`)
  mkdirSync(`${root}/-p-one/abc123/subagents`, { recursive: true })
  writeFileSync(`${root}/-p-one/abc123.jsonl`, '{}')
  writeFileSync(`${root}/-p-one/abc123/subagents/x.jsonl`, '{}')
  writeFileSync(`${root}/-p-one/other.jsonl`, '{}')
  writeFileSync(`${tmpdir()}/outside-${process.pid}.jsonl`, '{}')
  assert.equal(await deleteRecentSession('../outside-' + process.pid, root), false, 'path escape')
  assert.equal(await deleteRecentSession('a/b', root), false, 'slash')
  assert.equal(await deleteRecentSession('nope', root), false, 'unknown id')
  assert.equal(await deleteRecentSession('abc123', root), true)
  assert.ok(!existsSync(`${root}/-p-one/abc123.jsonl`) && !existsSync(`${root}/-p-one/abc123`))
  assert.ok(existsSync(`${root}/-p-one/other.jsonl`), 'the other conversation stays')
  assert.ok(existsSync(`${tmpdir()}/outside-${process.pid}.jsonl`), 'nothing outside the projects dir')
})

test('countUserMessages: 내가 보낸 메시지만 세고, 늘어난 부분만 더 읽는다', async () => {
  const { countUserMessages } = await import('../src/sessions-list.ts')
  const { appendFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const path = join(mkdtempSync(join(tmpdir(), 'count-')), 't.jsonl')
  const user = (content: unknown, extra = {}) => JSON.stringify({ type: 'user', message: { role: 'user', content }, ...extra }) + '\n'
  writeFileSync(path, user('첫 질문') + user([{ type: 'tool_result', tool_use_id: 't', content: 'x' }]) + user('<local-command-stdout>hi</local-command-stdout>') + user('<channel source="slack" user="U1">슬랙 메시지</channel>', { isMeta: true }) + user('메타', { isMeta: true }) + JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [] } }) + '\n')
  assert.equal(await countUserMessages(path), 2)
  appendFileSync(path, user('세 번째'))
  assert.equal(await countUserMessages(path), 3)
  assert.equal(await countUserMessages(path + '.none'), 0)
})

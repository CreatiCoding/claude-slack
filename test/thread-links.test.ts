import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ThreadLinks } from '../src/thread-links.ts'

const path = () => join(mkdtempSync(join(tmpdir(), 'links-')), 'links.json')

test('ThreadLinks: 모양을 배우기 전에는 링크가 없고, 배운 뒤엔 마지막 메시지 링크를 만든다', () => {
  const l = new ThreadLinks('C1', path())
  assert.equal(l.linkTo('5.1'), undefined)
  l.learn('https://ws.slack.com/archives/C1/p51?thread_ts=5.0&cid=C1')
  assert.equal(l.linkTo('5.1'), 'https://ws.slack.com/archives/C1/p51', '댓글이 없으면 스레드 맨 위')
  l.note('5.1', '5.3')
  l.note('5.1', '5.2')
  assert.equal(l.linkTo('5.1'), 'https://ws.slack.com/archives/C1/p53?thread_ts=5.1&cid=C1', '더 오래된 메시지는 덮어쓰지 않는다')
})

test('ThreadLinks: 기록은 파일에 남아 다시 켜도 그대로다', () => {
  const p = path()
  const a = new ThreadLinks('C1', p)
  a.learn('https://ws.slack.com/archives/C1/p1')
  a.note('7.1', '7.9')
  a.flush()
  const b = new ThreadLinks('C1', p)
  assert.equal(b.linkTo('7.1'), 'https://ws.slack.com/archives/C1/p79?thread_ts=7.1&cid=C1')
  assert.equal(b.has('9.9'), false)
})

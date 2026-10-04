import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ThreadInfoStore, parseSlackLink } from '../src/thread-info.ts'

test('스레드 링크 정보(51): 링크에서 채널·ts 를 읽고, 알게 된 것은 파일에 남고, 실패는 기다렸다가 다시 묻는다', () => {
  assert.deepEqual(parseSlackLink('https://x.slack.com/archives/C1ABC/p1000000100000001?thread_ts=1'), { channel: 'C1ABC', ts: '1000000100.000001' })
  assert.equal(parseSlackLink('https://example.com/none'), undefined)
  const dir = mkdtempSync(join(tmpdir(), 'cs-tinfo-'))
  const file = join(dir, 'thread-info.json')
  const store = new ThreadInfoStore(file)
  assert.equal(store.wanted('1.000001'), true)
  store.set('1.000001', { channel: 'general', user: 'Kim', text: '첫 글' })
  assert.equal(store.wanted('1.000001'), false, '알게 된 것은 다시 묻지 않는다')
  store.markFailed('2.000001', 30 * 60_000, 1000)
  assert.equal(store.wanted('2.000001', 1000), false, '실패하면 기다린다')
  assert.equal(store.wanted('2.000001', 1000 + 30 * 60_000 + 1), true)
  const again = new ThreadInfoStore(file)
  assert.deepEqual(again.get('1.000001'), { channel: 'general', user: 'Kim', text: '첫 글' }, '재시작 뒤에도 남는다')
  rmSync(dir, { recursive: true, force: true })
})

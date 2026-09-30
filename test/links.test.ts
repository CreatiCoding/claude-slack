import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { linksIn, repos } from '../src/links.ts'

test('대화에 나온 PR·Slack 스레드 주소를 처음 나온 순서로 한 번씩', () => {
  const texts = ['PR https://github.com/a/b/pull/12 올렸어요.', '이것도 https://github.com/a/b/pull/13, 그리고 https://github.com/a/b/pull/12', '<https://creco.slack.com/archives/C01ABC/p1790681234661739|스레드>']
  assert.deepEqual(linksIn(texts, 'pr'), ['https://github.com/a/b/pull/12', 'https://github.com/a/b/pull/13'])
  assert.deepEqual(linksIn(texts, 'slack'), ['https://creco.slack.com/archives/C01ABC/p1790681234661739'])
})

test('폴더 안의 저장소(자신과 두 단계 아래)', () => {
  const root = mkdtempSync(join(tmpdir(), 'links-'))
  mkdirSync(join(root, 'a', 'b'), { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: join(root, 'a', 'b') })
  execFileSync('git', ['init', '-q'], { cwd: root })
  assert.deepEqual(repos(root).sort(), [root, join(root, 'a', 'b')].sort())
})

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

test('PR 정렬: 열린 것부터, 번호가 큰 순', async () => {
  const { sortPrs } = await import('../src/links.ts')
  const got = sortPrs([
    { url: 'a', label: '#3', state: 'MERGED', number: 3 },
    { url: 'b', label: '#5', state: 'OPEN', number: 5 },
    { url: 'c', label: '#9', state: 'CLOSED', number: 9 },
    { url: 'd', label: '#7', state: 'OPEN', number: 7 },
  ])
  assert.deepEqual(got.map((p) => p.url), ['d', 'b', 'c', 'a'])
})

test('PR 상태: gh 를 4개씩 병렬로 묻고, 머지·닫힘은 계속 기억한다', async () => {
  const { prInfo } = await import('../src/links.ts')
  const { mkdtempSync, writeFileSync, chmodSync, readFileSync } = await import('node:fs')
  const dir = mkdtempSync(join(tmpdir(), 'gh-'))
  const log = join(dir, 'calls')
  const gh = join(dir, 'gh')
  // A fake gh: records each call; PR 1 is merged, the rest open; each answer takes 500ms.
  writeFileSync(gh, `#!/usr/bin/env node
const fs = require('fs')
const url = process.argv[4]
fs.appendFileSync(${JSON.stringify(log)}, 'call ' + url + '\\n')
const n = Number(url.split('/pull/')[1])
setTimeout(() => console.log(JSON.stringify({ title: 't' + n, number: n, state: n === 1 ? 'MERGED' : 'OPEN' })), 500)
`)
  chmodSync(gh, 0o755)
  const urls = [1, 2, 3, 4, 5].map((n) => `https://github.com/a/b/pull/${n}`)
  const t0 = Date.now()
  const got = await prInfo(urls, gh)
  const took = Date.now() - t0
  assert.deepEqual(got.map((p) => p.state), ['MERGED', 'OPEN', 'OPEN', 'OPEN', 'OPEN'])
  // Two rounds (4 + 1) of ~0.5s; one by one would be five (2.5s and more).
  assert.ok(took >= 1000 && took < 2300, `4개 한 묶음 + 1개: ${took}ms`)
  await prInfo([urls[0]!], gh)
  const calls = readFileSync(log, 'utf8').trim().split('\n').filter((l) => l.endsWith('/pull/1')).length
  assert.equal(calls, 1, '머지된 PR 은 다시 묻지 않는다')
})

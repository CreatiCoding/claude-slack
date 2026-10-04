import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PAGE_CHARS, prPages } from '../src/pr-view.ts'

const pr = { number: 7, title: '긴 변경', state: 'OPEN', isDraft: false, body: '**설명**입니다', author: { login: 'me' }, headRefName: 'f', baseRefName: 'main', createdAt: '2026-01-02T00:00:00Z', additions: 1, deletions: 0, changedFiles: 3, files: [] }
// One file block of about 30,000 characters, three of them: they must not be cut to fit a page.
const block = (n: number) => `diff --git a/f${n}.ts b/f${n}.ts\n+${'x'.repeat(30_000)}\n`
const diff = [block(1), block(2), block(3)].join('')

test('PR 화면(50): 설명은 마크다운으로 그리고, 변경 내용은 60,000자 쪽으로 나누되 파일 블록을 자르지 않는다', () => {
  const { title, pages } = prPages(pr, diff)
  assert.equal(title, '#7 긴 변경')
  assert.ok(pages.length >= 2, '세 파일은 한 쪽에 들어가지 않는다')
  for (const p of pages) assert.ok(p.length <= PAGE_CHARS + 2_000, `쪽은 60,000자 안(${p.length})`)
  assert.ok(pages[0]!.includes('<strong>설명</strong>'), '설명은 마크다운으로 그린다')
  assert.ok(pages.every((p) => p.startsWith('<!doctype html>')), '쪽마다 문서가 완전하다')
  assert.equal(pages.join('').split('<details').length - 1, 3, '파일 블록은 세 개 그대로')
})

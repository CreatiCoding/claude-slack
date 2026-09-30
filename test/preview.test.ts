import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writingPreview } from '../src/preview.ts'

const box = ['', '────────────────────────────────', '❯ ', '────────────────────────────────', '  ⏵⏵ auto mode on']

test('쓰는 중인 글: 입력칸 위, 스피너·Tip 을 걷고 가장 아래 ⏺ 문단을 두 칸 들여쓰기 떼어', () => {
  const screen = [
    '⏺ Bash(ls)',
    '  ⎿  a b c',
    '',
    '⏺ 테스트를 돌렸고 결과는 이래요.',
    '  모두 통과했습니다.',
    '',
    '✢ Pollinating… (esc to interrupt)',
    '  ⎿  Tip: Use /btw to ask a side question',
    ...box,
  ].join('\n')
  assert.equal(writingPreview(screen), '테스트를 돌렸고 결과는 이래요.\n모두 통과했습니다.')
})

test('글 뒤에 도구가 돌고 있으면 빈 글', () => {
  const screen = ['⏺ 테스트를 돌릴게요.', '', '⏺ Bash(npm test)', '  ⎿  Running…', '', '✻ Brewing… (esc to interrupt)', ...box].join('\n')
  assert.equal(writingPreview(screen), '')
  const ran = ['⏺ Read(src/a.ts)', '  ⎿  Read 20 lines', '', '✶ Thinking…', ...box].join('\n')
  assert.equal(writingPreview(ran), '')
})

test('0열에서 시작하는 다른 줄(❯ 프롬프트)을 먼저 만나면 빈 글; 입력칸이 없으면 빈 글', () => {
  const screen = ['⏺ 이전 답', '', '❯ 새 질문', '', '✽ Thinking…', ...box].join('\n')
  assert.equal(writingPreview(screen), '')
  assert.equal(writingPreview('⏺ 글만 있고 입력칸이 없다'), '')
})

test('끝 160자 안팎만', () => {
  const long = '가'.repeat(500)
  const screen = [`⏺ ${long}`, '', '✢ Writing…', ...box].join('\n')
  const out = writingPreview(screen)
  assert.ok(out.length <= 160 && out.length >= 150, String(out.length))
  assert.ok(long.endsWith(out))
})

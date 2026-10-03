import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writingPreview } from '../src/preview.ts'

const box = ['', '────────────────────────────────', '❯ ', '────────────────────────────────', '  ⏵⏵ auto mode on']
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`
const code = (s: string) => `\x1b[38;5;153m${s}\x1b[0m`
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`

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

test('더 이상 160자로 자르지 않는다 — 전체를 돌려준다 (15)', () => {
  const long = '가'.repeat(500)
  const screen = [`⏺ ${long}`, '', '✢ Writing…', ...box].join('\n')
  assert.equal(writingPreview(screen), long)
})

test('SGR 굵게(1) 는 ** 로, 안쪽 공백은 밖으로 뺀다 (15)', () => {
  const screen = [`⏺ 이건 ${bold('중요')} 합니다.`, '', '✢ Writing…', ...box].join('\n')
  assert.equal(writingPreview(screen), '이건 **중요** 합니다.')
})

test('인라인 코드 색(256색 153번) 은 백틱으로 (15)', () => {
  const screen = [`⏺ 명령 ${code('npm test')} 를 돌려요.`, '', '✢ Writing…', ...box].join('\n')
  assert.equal(writingPreview(screen), '명령 `npm test` 를 돌려요.')
})

test('다른 256색은 코드로 보지 않는다', () => {
  const other = (s: string) => `\x1b[38;5;200m${s}\x1b[0m`
  const screen = [`⏺ 이건 ${other('빨강')} 입니다.`, '', '✢ Writing…', ...box].join('\n')
  assert.equal(writingPreview(screen), '이건 빨강 입니다.')
})

test('흐린(2) 언어 이름 줄은 그 언어의 코드 펜스로, 빈 줄까지만 (15)', () => {
  const screen = ['⏺ 이렇게 하세요.', '', `  ${dim('typescript')}`, '  const x = 1', '  console.log(x)', '', '  그 다음 설명.', '', '✢ Writing…', ...box].join('\n')
  assert.equal(writingPreview(screen), '이렇게 하세요.\n\n```typescript\nconst x = 1\nconsole.log(x)\n```\n\n그 다음 설명.')
})

test('언어 이름처럼 보여도 흐리지(dim) 않으면 펜스로 보지 않는다', () => {
  const screen = ['⏺ 이렇게 하세요.', '', '  typescript', '  const x = 1', '', '✢ Writing…', ...box].join('\n')
  assert.equal(writingPreview(screen), '이렇게 하세요.\n\ntypescript\nconst x = 1')
})

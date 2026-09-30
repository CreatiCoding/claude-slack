/** The web app's markdown: code fences by CommonMark's rules, the cases that broke before. */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { md } = (await import('../src/web/markdown.js' as string)) as { md: (t: string) => string }
const codes = (html: string) => [...html.matchAll(/<pre[^>]*><code>([\s\S]*?)<\/code><\/pre>/g)].map((m) => m[1])

test('줄 가운데의 ``` 는 울타리가 아니다', () => {
  const html = md('앞 글 ``` 가운데\n다음 줄')
  assert.equal(codes(html).length, 0)
  assert.match(html, /다음 줄/)
})

test('백틱 5개 울타리 안의 3개·4개 백틱은 코드로 남는다', () => {
  const html = md('`````\n```js\nx\n```\n````\n`````\n뒤 글')
  assert.deepEqual(codes(html), ['```js\nx\n```\n````'])
  assert.match(html, /<p>뒤 글<\/p>/)
})

test('블럭 두 개 연달아, 빈 블럭', () => {
  assert.deepEqual(codes(md('```\na\n```\n```\nb\n```')), ['a', 'b'])
  assert.deepEqual(codes(md('```\n```\n끝')), [''])
})

test('문장 속 ```…``` 는 인라인 코드', () => {
  const html = md('이건 ```inline``` 이에요')
  assert.equal(codes(html).length, 0)
  assert.match(html, /<code>inline<\/code>/)
})

test('들여쓴 블럭(목록 안): 코드 줄에서도 그만큼 걷어 낸다', () => {
  const html = md('- 단계\n   ```sh\n   npm test\n     --watch\n   ```\n- 다음')
  assert.deepEqual(codes(html), ['npm test\n  --watch'])
  assert.match(html, /다음/)
})

test('닫는 울타리는 연 것과 같은 개수 이상이어야 한다', () => {
  assert.deepEqual(codes(md('````\na\n```\nb\n````')), ['a\n```\nb'])
})

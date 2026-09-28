import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stableNodePath } from '../src/node-path.ts'

const CELLAR = '/opt/homebrew/Cellar/node/26.8.1/bin/node'
const same = () => '/opt/homebrew/Cellar/node/26.8.1/bin/node'

test('Homebrew 의 버전 폴더 경로는 업그레이드 뒤에도 남는 opt/ 경로로 바꾼다', () => {
  assert.equal(stableNodePath(CELLAR, () => true, same), '/opt/homebrew/opt/node/bin/node')
  assert.equal(stableNodePath('/usr/local/Cellar/node@22/22.11.0/bin/node', () => true, () => '/usr/local/Cellar/node@22/22.11.0/bin/node'), '/usr/local/opt/node@22/bin/node', 'node@22 같은 버전 고정 formula 도')
})

test('바꿔도 같은 node 가 아니거나 경로가 없으면 원래 경로를 그대로 쓴다', () => {
  assert.equal(stableNodePath(CELLAR, () => false, same), CELLAR, 'opt 경로가 없으면')
  assert.equal(stableNodePath(CELLAR, () => true, (p) => (p.includes('/opt/node/') ? '/opt/homebrew/Cellar/node/27.0.0/bin/node' : CELLAR)), CELLAR, '다른 버전을 가리키면')
  assert.equal(stableNodePath(CELLAR, () => { throw new Error('fs') }, same), CELLAR, '확인하다 실패해도')
})

test('Homebrew 가 아닌 경로(nvm, 시스템 등)는 손대지 않는다', () => {
  for (const p of ['/usr/local/bin/node', '/Users/u/.nvm/versions/node/v22.11.0/bin/node', '/usr/bin/node']) assert.equal(stableNodePath(p, () => true, same), p)
})

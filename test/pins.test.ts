import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PinStore } from '../src/pins.ts'

const path = () => join(mkdtempSync(join(tmpdir(), 'pins-')), 'pins.json')

test('PinStore: 고정과 해제가 파일에 남아, 새로 만들어도(재시작) 그대로 복원된다', () => {
  const file = path()
  const a = new PinStore(file)
  assert.deepEqual(a.list(), [])
  assert.equal(a.set('s:abc', true), true)
  assert.equal(a.set('t:1789777832.716679', true), true)
  assert.equal(a.set('s:abc', true), true, 'twice is fine')
  assert.deepEqual(new PinStore(file).list().sort(), ['s:abc', 't:1789777832.716679'])
  a.set('s:abc', false)
  assert.deepEqual(new PinStore(file).list(), ['t:1789777832.716679'])
})

test('PinStore: 이상한 키와 너무 많은 고정은 거부한다', () => {
  const s = new PinStore(path())
  for (const bad of ['', 'a b', '<script>', 'x'.repeat(301), 'a;rm -rf']) assert.equal(s.set(bad, true), false, JSON.stringify(bad))
  for (let i = 0; i < 200; i++) assert.equal(s.set(`s:${i}`, true), true)
  assert.equal(s.set('s:one-too-many', true), false, 'limit')
  assert.equal(s.set('s:5', false), true, 'unpinning always works')
  assert.equal(s.set('s:one-too-many', true), true, 'room again')
})

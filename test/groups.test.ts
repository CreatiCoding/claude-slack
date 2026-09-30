import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GroupStore } from '../src/groups.ts'

test('그룹: 만들기·이름 바꾸기·넣고 빼기·순서·지우기(세션은 밖으로), 파일에 남아 다른 기기도 같게', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'grp-')), 'groups.json')
  const g = new GroupStore(path)
  const a = g.apply({ op: 'create', name: '업무' }).id!
  const b = g.apply({ op: 'create', name: '개인' }).id!
  assert.equal(g.apply({ op: 'create', name: '  ' }).ok, false)
  g.apply({ op: 'rename', id: b, name: '사이드' })
  g.apply({ op: 'move', thread: '1.1', group: a })
  g.apply({ op: 'move', thread: '2.2', group: a, before: '1.1' })
  g.apply({ op: 'move', thread: '3.3', group: null })
  assert.deepEqual(g.get().groups.map((x) => [x.name, x.items]), [['업무', ['2.2', '1.1']], ['사이드', []]])
  // Moving takes it out of wherever it was.
  g.apply({ op: 'move', thread: '1.1', group: b })
  g.apply({ op: 'order', id: b, before: a })
  assert.deepEqual(g.get().groups.map((x) => [x.name, x.items]), [['사이드', ['1.1']], ['업무', ['2.2']]])
  g.apply({ op: 'move', thread: '2.2', group: null, before: '3.3' })
  assert.deepEqual(g.get().loose, ['2.2', '3.3'])
  g.apply({ op: 'delete', id: b })
  assert.deepEqual(g.get().loose, ['2.2', '3.3', '1.1'], '지운 그룹의 세션은 밖으로')
  assert.equal(g.apply({ op: 'move', thread: '../x', group: null }).ok, false)
  g.apply({ op: 'move', thread: '4.4', group: a })
  g.apply({ op: 'loose', order: ['4.4', '3.3', 'bad', '2.2'] })
  assert.deepEqual(g.get().loose, ['4.4', '3.3', '2.2'], '밖의 순서를 통째로, 끌어온 것은 그룹에서 빠진다')
  assert.deepEqual(g.get().groups[0]!.items, [])
  g.apply({ op: 'clearRecent' })
  const again = new GroupStore(path).get()
  assert.deepEqual(again.groups.map((x) => x.name), ['업무'])
  assert.ok(again.recentClearedAt! > 0)
})

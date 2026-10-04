import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { moveToTrash, refuseReason, repoStates } from '../src/trash.ts'

test('버릴 수 없는 폴더: 루트, 보호 폴더 자신, 보호 폴더를 품은 상위, 없는 폴더', () => {
  const root = mkdtempSync(join(tmpdir(), 'trash-'))
  const home = join(root, 'home')
  const proj = join(home, 'proj')
  mkdirSync(proj, { recursive: true })
  const protectedDirs = [home, join(home, 'projects', 'claude-slack')]
  assert.match(refuseReason('/', protectedDirs)!, /루트/)
  assert.match(refuseReason(home, protectedDirs)!, /버릴 수 없는 폴더/)
  assert.match(refuseReason(root, protectedDirs)!, /상위 폴더/)
  assert.match(refuseReason(join(home, 'projects'), protectedDirs)!, /상위 폴더/)
  assert.match(refuseReason(join(home, 'nope'), protectedDirs)!, /없습니다/)
  assert.equal(refuseReason(proj, protectedDirs), undefined)
})

test('저장소마다 커밋 안 한 변경과 push 안 한 커밋을 센다(폴더 안 여러 저장소)', () => {
  const root = mkdtempSync(join(tmpdir(), 'trash-'))
  const g = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', ...args], { cwd, stdio: 'ignore' })
  const a = join(root, 'a')
  mkdirSync(a)
  g(a, 'init', '-q')
  writeFileSync(join(a, 'x'), '1')
  g(a, 'add', '.')
  g(a, 'commit', '-qm', 'one')
  writeFileSync(join(a, 'y'), 'new')
  const b = join(root, 'libs', 'b')
  mkdirSync(b, { recursive: true })
  g(b, 'init', '-q')
  const states = repoStates(root).sort((x, y) => x.path.localeCompare(y.path))
  assert.deepEqual(states.map((s) => [s.path, s.uncommitted, s.unpushed]), [
    [a, 1, 1],
    [b, 0, 0],
  ])
})

test('휴지통으로 옮긴다(지우지 않는다); 같은 이름이 있으면 시각을 붙인다', () => {
  const root = mkdtempSync(join(tmpdir(), 'trash-'))
  const trash = join(root, 'Trash')
  const p = join(root, 'proj')
  mkdirSync(p)
  writeFileSync(join(p, 'f'), 'x')
  const dest = moveToTrash(p, trash)
  assert.equal(dest, join(trash, 'proj'))
  assert.ok(existsSync(join(dest, 'f')) && !existsSync(p))
  mkdirSync(p)
  const again = moveToTrash(p, trash)
  assert.notEqual(again, dest)
  assert.ok(existsSync(again))
})

test('브로커: 폴더 버리고 종료는 보호 폴더를 거부하고, 저장소 상태를 보여 준 뒤 휴지통으로 옮긴다; 사라진 폴더의 대화는 이어서 하기에서 빠진다', async () => {
  const { setup, shim } = await import('./helpers.ts')
  const root = mkdtempSync(join(tmpdir(), 'trash-'))
  const proj = join(root, 'proj')
  mkdirSync(proj)
  execFileSync('git', ['init', '-q'], { cwd: proj })
  writeFileSync(join(proj, 'a'), '1')
  const t = await setup({ homeDir: dirname(root), trashDir: join(root, 'Trash'), folderExists: existsSync, listSessions: async () => [{ id: 'gone', cwd: join(root, 'gone'), title: 'x', mtime: 1, when: '' }, { id: 'here', cwd: proj, title: 'y', mtime: 1, when: '' }] })
  const s = await shim(t.socketPath, { tmuxPane: '%51', cwd: proj })
  const info = t.broker.webTrashInfo(100)
  assert.ok(info.ok)
  assert.equal(info.repos?.length, 1)
  assert.deepEqual({ ...info.repos![0], branch: undefined }, { path: proj, uncommitted: 1, unpushed: 0, branch: undefined }, '저장소 상태 (브랜치는 확인 창에 보인다, 48)')
  assert.deepEqual((await t.broker.adminState()).recent.map((r) => r.id), ['here'], '폴더가 없는 대화는 빠진다')
  const r = await t.broker.webTrash(100)
  assert.ok(r.ok, r.note)
  assert.ok(t.tmux.keys.includes('%51:kill'), '세션을 끝낸다')
  assert.ok(!existsSync(proj) && existsSync(join(root, 'Trash', 'proj', 'a')))
  s.conn.close()
  t.close()

  const u = await setup()
  const home = await shim(u.socketPath, { tmuxPane: '%52', cwd: (await import('node:os')).homedir() })
  assert.equal(u.broker.webTrashInfo(100).ok, false, '홈 폴더는 거부')
  assert.equal((await u.broker.webTrash(100)).ok, false)
  home.conn.close()
  u.close()
})

test('휴지통 거절 순서(48): 없음 → 홈 밖·홈 자체 → 홈 바로 아래 → 휴지통 안 → 기본 폴더 → 다른 살아 있는 세션 폴더', async () => {
  const { trashRefusal } = await import('../src/trash.ts')
  const root = mkdtempSync(join(tmpdir(), 'trash48-'))
  const home = join(root, 'home')
  const deep = join(home, 'works', 'app')
  const direct = join(home, 'works')
  mkdirSync(deep, { recursive: true })
  const trashDir = join(home, 'works', 'Trash')
  mkdirSync(join(trashDir, 'x'), { recursive: true })
  const base = { home, trashDir, defaultCwd: join(home, 'works', 'default'), livingFolders: [] as string[] }
  assert.match(trashRefusal(join(home, 'missing'), base)!, /없어요/)
  assert.match(trashRefusal(root, base)!, /홈 폴더 밖/)
  assert.match(trashRefusal(home, base)!, /홈 폴더 자체/)
  mkdirSync(join(home, 'top'))
  assert.match(trashRefusal(join(home, 'top'), base)!, /홈 바로 아래/)
  assert.match(trashRefusal(join(trashDir, 'x'), base)!, /휴지통 안/)
  mkdirSync(base.defaultCwd, { recursive: true })
  assert.match(trashRefusal(base.defaultCwd, base)!, /기본 세션/)
  assert.equal(trashRefusal(deep, base), undefined)
  assert.match(trashRefusal(deep, { ...base, livingFolders: [deep] })!, /살아 있는/)
  rmSync(root, { recursive: true, force: true })
})

import { test } from 'node:test'
import assert from 'node:assert/strict'


test('deleteArchive: 보관 폴더 안의 .json 만 지우고 옆의 .md 도 함께 지운다', async () => {
  const { mkdtempSync, writeFileSync, existsSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { deleteArchive } = await import('../src/archive.ts')
  const dir = mkdtempSync(`${tmpdir()}/arch-`)
  const outside = mkdtempSync(`${tmpdir()}/other-`)
  writeFileSync(`${dir}/a.json`, '{}'); writeFileSync(`${dir}/a.md`, '#')
  writeFileSync(`${outside}/b.json`, '{}')
  assert.equal(deleteArchive(`${outside}/b.json`, dir), false, 'other directory')
  assert.equal(deleteArchive(`${dir}/a.md`, dir), false, 'not a .json')
  assert.equal(deleteArchive(`${dir}/../${outside.split('/').pop()}/b.json`, dir), false, 'path escape')
  assert.ok(existsSync(`${outside}/b.json`))
  assert.equal(deleteArchive(`${dir}/a.json`, dir), true)
  assert.ok(!existsSync(`${dir}/a.json`) && !existsSync(`${dir}/a.md`))
})

test('renameArchive: 제목을 .json 과 .md 제목 줄에 함께 반영하고, 폴더 밖이나 빈 이름은 거부한다', async () => {
  const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { renameArchive } = await import('../src/archive.ts')
  const dir = mkdtempSync(`${tmpdir()}/arch-`)
  const a = { key: 'k', sessionId: 's1', cwd: '/home/u/proj', title: '옛 이름', threadTs: '1.0', origin: 'slack', archivedAt: '2026-09-24T00:00:00Z', messages: [] }
  writeFileSync(`${dir}/a.json`, JSON.stringify(a))
  assert.equal(renameArchive(`${dir}/a.json`, '  ', dir), false, 'empty title')
  assert.equal(renameArchive('/etc/hosts', '새 이름', dir), false, 'outside the archive dir')
  assert.equal(renameArchive(`${dir}/a.json`, ' 새 이름 ', dir), true)
  assert.equal(JSON.parse(readFileSync(`${dir}/a.json`, 'utf8')).title, '새 이름')
  assert.match(readFileSync(`${dir}/a.md`, 'utf8'), /^# 새 이름/)
})

test('listArchives: 첫 사용자 메시지를 preview 로 돌려주고, 봇 메시지는 건너뛴다', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { writeArchive, listArchives } = await import('../src/archive.ts')
  const dir = mkdtempSync(`${tmpdir()}/arch-`)
  writeArchive(
    { key: 'k', sessionId: 's9', cwd: '/home/u/proj', title: '제목', threadTs: '1.0', origin: 'slack', archivedAt: '2026-09-24T00:00:00Z',
      messages: [{ ts: '1.1', bot: true, text: '세션이 시작되었습니다' }, { ts: '1.2', user: 'U1', bot: false, text: '  로그인 버그 좀 봐줘  ' }, { ts: '1.3', user: 'U1', bot: false, text: '두 번째' }] },
    dir,
  )
  assert.equal(listArchives(5, dir)[0]!.preview, '로그인 버그 좀 봐줘')
})

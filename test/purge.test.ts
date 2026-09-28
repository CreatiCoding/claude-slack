import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PurgeService } from '../src/purge.ts'
import type { SessionArchive } from '../src/archive.ts'
import { FakeSlack } from './helpers.ts'

const shell = (threadTs: string): SessionArchive => ({ key: 'k', sessionId: 's', cwd: '/p', title: 't', threadTs, origin: 'slack', archivedAt: '2026-09-24T00:00:00Z', messages: [] })

/** A Slack with `n` bot replies under a root, so a purge has something to delete. */
function slackWith(n: number) {
  const slack = new FakeSlack()
  slack.posts.push({ ts: '1.000', text: 'root' })
  for (let i = 1; i <= n; i++) slack.posts.push({ ts: `1.${String(i).padStart(3, '0')}`, text: `m${i}`, threadTs: '1.000' })
  return slack
}
const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), 'purge-'))
  const sleeps: number[] = []
  const make = (slack: FakeSlack) => new PurgeService(slack, { archiveDir: join(dir, 'arch'), pendingFile: join(dir, 'pending.json'), gapMs: 0, sleep: async (ms) => void sleeps.push(ms) })
  return { dir, sleeps, make }
}
const rateLimit = () => Object.assign(new Error('A rate limit was exceeded'), { code: 'slack_webapi_rate_limited', retryAfter: 10 })

test('삭제가 속도 제한(Retry-After)에 걸리면 기다렸다가 계속하고, 하나도 빠뜨리지 않는다', async () => {
  const { sleeps, make } = setup()
  const slack = slackWith(5)
  let calls = 0
  const real = slack.delete.bind(slack)
  slack.delete = async (ts: string) => {
    // the 3rd and 4th calls are rate limited (as Slack did at message 24 of 137)
    if (++calls === 3 || calls === 4) throw rateLimit()
    return real(ts)
  }
  const r = await make(slack).runThread('1.000', shell('1.000'))
  assert.equal(r.deleted, 6, 'all five replies and the root')
  assert.equal(r.kept, 0)
  assert.ok(r.rootGone)
  assert.equal(slack.deleted.at(-1), '1.000', 'the root goes last')
  assert.deepEqual(sleeps.filter((ms) => ms > 1000), [10250, 10250], 'waited out Retry-After (10s + margin) twice')
})

test('실패한 메시지는 대기열에 남고, resume() 이 이어서 지운다 (재시작해도 반쯤 지워진 채 남지 않는다)', async () => {
  const { dir, make } = setup()
  const slack = slackWith(4)
  slack.failDelete.add('1.002')
  const service = make(slack)
  const r = await service.runThread('1.000', shell('1.000'))
  assert.equal(r.pending, 1, 'one message failed and is queued')
  assert.ok(!slack.deleted.includes('1.002'))
  assert.equal(service.pendingThreads(), 1)

  // a "restart": a fresh service reads the queue from the file
  slack.failDelete.clear()
  const after = make(slack)
  assert.equal(after.pendingThreads(), 1)
  const resumed = await after.resume()
  assert.equal(resumed.deleted, 1)
  assert.ok(slack.deleted.includes('1.002'))
  assert.equal(after.pendingThreads(), 0)
  assert.ok(existsSync(join(dir, 'pending.json')))
})

test('같은 스레드를 동시에 두 번 정리하려 하면 두 번째는 시작하지 않는다', async () => {
  const { make } = setup()
  const slack = slackWith(3)
  const service = make(slack)
  const [a, b] = await Promise.all([service.runThread('1.000', shell('1.000')), service.runThread('1.000', shell('1.000'))])
  assert.equal([a, b].filter((r) => r.skipped === 'running').length, 1)
  assert.equal(slack.deleted.length, 4, 'each message was deleted once')
})

test('다시 정리해도 보관 파일은 하나이고, 앞서 지워진 메시지도 그 안에 남는다', async () => {
  const { dir, make } = setup()
  const slack = slackWith(3)
  slack.failDelete.add('1.002')
  const service = make(slack)
  await service.runThread('1.000', shell('1.000'))
  // the first run deleted 1.001 and 1.003; only 1.002 and the root are still in Slack
  const stillThere = slack.posts.filter((p) => !slack.deleted.includes(p.ts))
  slack.posts = stillThere
  slack.failDelete.clear()
  await service.runThread('1.000', shell('1.000'))
  const files = readdirSync(join(dir, 'arch')).filter((f) => f.endsWith('.json'))
  assert.equal(files.length, 1, 'no second copy')
  const { readFileSync } = await import('node:fs')
  const archived = JSON.parse(readFileSync(join(dir, 'arch', files[0]!), 'utf8')) as SessionArchive
  assert.deepEqual(archived.messages.map((m) => m.ts), ['1.000', '1.001', '1.002', '1.003'], 'the merged thread, in order')
})

test('Slack 이 지우지 못하게 막는 메시지(cant_delete_message)는 다시 시도하지 않고 남긴 채 끝낸다', async () => {
  const { dir, make } = setup()
  const slack = slackWith(4)
  const real = slack.delete.bind(slack)
  slack.delete = async (ts: string) => {
    if (ts === '1.002') throw Object.assign(new Error('An API error occurred: cant_delete_message'), { data: { error: 'cant_delete_message' } })
    return real(ts)
  }
  const service = make(slack)
  const r = await service.runThread('1.000', shell('1.000'))
  assert.equal(r.refused, 1)
  assert.equal(r.pending, 0, '재시도 대기열에 넣지 않는다')
  assert.equal(r.kept, 1)
  assert.equal(r.deleted, 4, '나머지는 모두 지운다 (답글 셋과 루트)')
  assert.equal(service.pendingThreads(), 0, '다음 재시작에서 다시 두드리지 않는다')
  assert.deepEqual((await service.resume()), { threads: 0, deleted: 0, left: 0 })
  assert.match(PurgeService.describe(r), /1개는 Slack 이 지우지 못하게 막아 남겼습니다/)
  void dir
})

test('앱을 통해 사용자 이름으로 쓴 메시지(봇 토큰은 거절)는 사용자 토큰으로 지운다', async () => {
  const { make } = setup()
  const slack = slackWith(4)
  slack.userToken = true
  const real = slack.delete.bind(slack)
  // 1.002 and 1.003 were written as the person through the app: they carry a bot_id, the bot token may not delete them
  slack.delete = async (ts: string) => {
    if (ts === '1.002' || ts === '1.003') throw Object.assign(new Error('An API error occurred: cant_delete_message'), { data: { error: 'cant_delete_message' } })
    return real(ts)
  }
  const r = await make(slack).runThread('1.000', shell('1.000'))
  assert.equal(r.deleted, 5, '루트와 답글 넷 모두')
  assert.equal(r.kept, 0)
  assert.equal(r.refused, 0)
  assert.deepEqual(slack.deletedAsUser.sort(), ['1.002', '1.003'], '사용자 토큰으로 지운 것')
  assert.equal(slack.deleted.at(-1), '1.000', '루트는 마지막')
})

test('봇 토큰도 사용자 토큰도 거절하면 남기고, 사용자 토큰이 없으면 봇이 거절한 것만 남긴다', async () => {
  const both = slackWith(2)
  both.userToken = true
  const refuse = (ts: string) => Object.assign(new Error(`cant_delete_message ${ts}`), { data: { error: 'cant_delete_message' } })
  both.delete = async (ts: string) => { if (ts === '1.001') throw refuse(ts); both.deleted.push(ts) }
  both.deleteAsUser = async (ts: string) => { if (ts === '1.001') throw refuse(ts); return true }
  const a = await setup().make(both).runThread('1.000', shell('1.000'))
  assert.deepEqual([a.deleted, a.refused, a.pending], [2, 1, 0], '둘 다 거절하면 남기되 다시 시도하지 않는다')

  const noToken = slackWith(2)
  noToken.userToken = false
  noToken.delete = async (ts: string) => { if (ts === '1.001') throw refuse(ts); noToken.deleted.push(ts) }
  const b = await setup().make(noToken).runThread('1.000', shell('1.000'))
  assert.deepEqual([b.deleted, b.refused], [2, 1], '사용자 토큰이 없으면 봇이 거절한 것은 남는다')
})

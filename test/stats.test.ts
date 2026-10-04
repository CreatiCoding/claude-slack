import { test } from 'node:test'
import assert from 'node:assert/strict'
import { busyAndPeak, computeStats, quantile, turnSpans } from '../src/stats.ts'

const MIN = 60_000
test('사용 통계(53): 턴은 busy 부터 다음 비-busy 까지, 열린 턴은 조용하면 마지막 활동+1분, 30분을 넘지 않는다', () => {
  const now = 10 * MIN
  const threads = [{ thread: '1.0', cwd: '/a', events: [{ type: 'status', at: 0, state: 'busy' }, { type: 'status', at: 4 * MIN, state: 'idle' }] }]
  assert.deepEqual(turnSpans(threads, now, 0), [{ start: 0, end: 4 * MIN, cwd: '/a' }])
  const open = [{ thread: '2.0', cwd: '/b', events: [{ type: 'status', at: 0, state: 'busy' }, { type: 'tool', at: MIN }] }]
  assert.equal(turnSpans(open, now, 0)[0]!.end, now, '마지막 활동이 30분 안이면 지금까지')
  const stale = [{ thread: '3.0', cwd: '/c', events: [{ type: 'status', at: 0, state: 'busy' }, { type: 'tool', at: MIN }] }]
  assert.equal(turnSpans(stale, 60 * MIN, 0)[0]!.end, 2 * MIN, '마지막 활동이 30분 전이면 마지막+1분까지')
})

test('사용 통계(53): 바쁜 시간은 겹친 구간을 한 번만 세고, 최대 동시는 가장 많이 겹친 수, 분위수는 floor(q·n)', () => {
  const spans = [{ start: 0, end: 10, cwd: 'a' }, { start: 5, end: 15, cwd: 'b' }, { start: 20, end: 25, cwd: 'c' }]
  assert.deepEqual(busyAndPeak(spans), { busy: 20, peak: 2 })
  assert.equal(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5), 6)
  assert.equal(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 10)
  assert.equal(quantile([], 0.5), undefined)
})

test('사용 통계(53): 계산 결과에 총·바쁜·평균 동시성, 일별, 요일×시 히트맵, 폴더·도구 상위가 있다', () => {
  const now = Date.UTC(2026, 9, 4, 12)
  const threads = [
    { thread: '1.0', cwd: '/w/a', events: [{ type: 'status', at: now - 60 * MIN, state: 'busy' }, { type: 'user', at: now - 59 * MIN, via: 'web' }, { type: 'tool', at: now - 58 * MIN, name: 'Bash' }, { type: 'status', at: now - 50 * MIN, state: 'idle' }] },
  ]
  const r = computeStats(threads, now, 1)
  assert.equal(r.totals.work, 10 * MIN)
  assert.equal(r.tools, 1)
  assert.equal(r.turns.count, 1)
  assert.equal(r.heat.length, 7)
  assert.equal(r.topFolders[0]!.cwd, '/w/a')
  assert.equal(r.topTools[0]!.name, 'Bash')
  assert.equal(r.series.length, 96, '1일은 15분 칸 96개')
})

test('사용 통계(53): PR 절 — 머지·생성 수, 머지까지 시간(머지 시각 − 생성 시각), 최근 20개', async () => {
  const { prSummary } = await import('../src/stats.ts')
  const now = Date.UTC(2026, 9, 4)
  const day = 86_400_000
  const prs = [
    { url: 'a', createdAt: new Date(now - 2 * day).toISOString(), mergedAt: new Date(now - day).toISOString() },
    { url: 'b', createdAt: new Date(now - 1 * day).toISOString() },
  ]
  const r = prSummary(prs, now, 7)
  assert.equal(r.merged, 1)
  assert.equal(r.created, 2)
  assert.equal(r.medianMergeMs, day)
  assert.equal(r.recent.length, 2)
})

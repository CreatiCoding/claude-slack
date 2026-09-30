/**
 * Measurement for the web app's traffic, so each performance change can be compared before and after.
 * The broker counts what it sends; the page reports what it received and how long it took to show.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { createAdminServer, type AdminApi } from '../src/admin.ts'
import { TrafficMeter } from '../src/meter.ts'
import { EventLog } from '../src/events.ts'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('TrafficMeter: 1분 동안 종류별 건수·바이트를 모아 한 줄로 내고 비운다; 50만 바이트 넘는 한 건은 바로 남긴다', () => {
  const lines: string[] = []
  const m = new TrafficMeter((l) => lines.push(l), { bigBytes: 500_000 })
  m.add('sessions', 1200)
  m.add('sessions', 800)
  m.add('ev:text', 300)
  m.add('events', 600_000, 'thread=1.1 after=0')
  assert.equal(lines.length, 1, '큰 한 건은 바로')
  assert.match(lines[0]!, /big events 600000B thread=1\.1 after=0/)
  const line = m.flush()!
  assert.match(line, /total=4\/602300B/)
  assert.match(line, /sessions=2\/2000B/)
  assert.match(line, /ev:text=1\/300B/)
  assert.match(line, /events=1\/600000B/)
  assert.equal(m.flush(), undefined, '비운 뒤엔 낼 것이 없다')
})

function fakeApi(): AdminApi {
  const events = new EventLog(mkdtempSync(join(tmpdir(), 'meter-')))
  const listeners = new Set<() => void>()
  return {
    async adminState() {
      return { channelId: 'C1', pins: [], live: [], recent: [], archives: [] }
    },
    async adminKill() {
      return { ok: true, note: '' }
    },
    async adminPurge() {
      return { ok: true, note: '' }
    },
    webSessions: () => [],
    events,
    onChange(l) {
      listeners.add(l)
      return () => listeners.delete(l)
    },
  }
}

test('SSE 로 보낸 것과 따라잡기 응답이 미터에 잡히고, 페이지가 보낸 측정은 로그 한 줄이 된다', async () => {
  const logs: string[] = []
  const api = fakeApi()
  const server = createAdminServer(api, { port: 0, log: (m) => logs.push(m) })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as { port: number }
  const base = `http://127.0.0.1:${port}`
  try {
    // Open the stream, let an event through, close.
    await new Promise<void>((resolve) => {
      const req = request(`${base}/api/stream`, (res) => {
        res.once('data', () => {
          (api.events as EventLog).emit('1.1', { type: 'text', text: '안녕' } as never)
          res.once('data', () => {
            req.destroy()
            resolve()
          })
        })
      })
      req.end()
    })
    await fetch(`${base}/api/events?thread=1.1&after=0`).then((r) => r.json())
    const r = await fetch(`${base}/api/metrics`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tab: 'ab12', view: 'phone', recvBytes: 5000, recvEvents: 12, apply: { n: 3, sum: 30, max: 20 }, catchups: [{ rounds: 2, events: 1500, ms: 480 }], stalls: { n: 1, max: 350 }, dom: 2400 }),
    })
    assert.equal(r.status, 204)
    const page = logs.find((l) => l.startsWith('page '))
    assert.ok(page, logs.join('\n'))
    assert.match(page!, /tab=ab12 view=phone recv=5000B\/12ev apply=3×avg10ms\/max20ms catchup=1×2rounds\/1500ev\/480ms stalls=1\/max350ms dom=2400/)
    const sent = (server as unknown as { meter: TrafficMeter }).meter.flush()!
    assert.match(sent, /sessions=1\//)
    assert.match(sent, /ev:text=1\//)
    assert.match(sent, /events=1\//)
    // Anything that is not a small JSON object is refused, like every other POST.
    const bad = await fetch(`${base}/api/metrics`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' })
    assert.equal(bad.status, 415)
  } finally {
    server.close()
  }
})

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
      let buf = ''
      let subscribed = false
      const req = request(`${base}/api/stream`, (res) => {
        res.on('data', async (c) => {
          buf += String(c)
          const hello = /event: hello\ndata: (.*)\n/.exec(buf)
          if (hello && !subscribed) {
            subscribed = true
            const conn = JSON.parse(hello[1]!).conn
            await fetch(`${base}/api/subscribe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ conn, thread: '1.1' }) })
            ;(api.events as EventLog).emit('1.1', { type: 'text', text: '안녕' } as never)
          }
          if (buf.includes('event: ev')) {
            req.destroy()
            resolve()
          }
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

test('세션 목록: 내용이 같으면 보내지 않고, 바뀐 세션만 순서(키 배열)와 함께 보낸다', async () => {
  const { sessionsDelta } = await import('../src/admin.ts')
  const a = { pid: 1, thread: '1.1', cwd: '/a', state: 'idle', startedAt: 1, held: 0, canKeys: true, autoAllow: false, lastSeq: 1, lastAt: 1 }
  const b = { ...a, pid: 2, thread: '2.2' }
  const sent = new Map<string, string>()
  const first = sessionsDelta(sent, [a, b] as never)
  assert.deepEqual(first, { order: ['1.1', '2.2'], changed: [a, b] }, '처음엔 전부')
  assert.equal(sessionsDelta(sent, [a, b] as never), undefined, '같으면 보내지 않는다')
  const a2 = { ...a, lastSeq: 2 }
  assert.deepEqual(sessionsDelta(sent, [a2, b] as never), { order: ['1.1', '2.2'], changed: [a2] }, '바뀐 것만')
  assert.deepEqual(sessionsDelta(sent, [b, a2] as never), { order: ['2.2', '1.1'], changed: [] }, '순서만 바뀌어도 순서는 보낸다')
  assert.deepEqual(sessionsDelta(sent, [b] as never), { order: ['2.2'], changed: [] }, '빠진 것은 순서에서 빠진다')
})

test('SSE: 붙을 때 전체 목록 한 번, 그 뒤로는 바뀐 세션만(같으면 아무것도)', async () => {
  let list: unknown[] = [{ pid: 1, thread: '1.1', cwd: '/a', state: 'idle', lastSeq: 0 }, { pid: 2, thread: '2.2', cwd: '/b', state: 'idle', lastSeq: 0 }]
  const listeners = new Set<() => void>()
  const api = { ...fakeApi(), webSessions: () => list as never, onChange: (l: () => void) => (listeners.add(l), () => listeners.delete(l)) }
  const server = createAdminServer(api, { port: 0 })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as { port: number }
  const frames: string[] = []
  const req = request(`http://127.0.0.1:${port}/api/stream`, (res) => res.on('data', (c) => frames.push(String(c))))
  req.end()
  try {
    const until = async (f: () => boolean) => {
      for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 10))
    }
    await until(() => frames.join('').includes('event: sessions\n'))
    assert.ok(frames.join('').includes('"thread":"2.2"'), '처음엔 전체')
    frames.length = 0
    for (const l of listeners) l()
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(frames.join(''), '', '같은 내용이면 보내지 않는다')
    list = [{ ...(list[0] as object), lastSeq: 5 }, list[1]!]
    for (const l of listeners) l()
    await until(() => frames.join('').includes('sessions_delta'))
    const data = JSON.parse(/event: sessions_delta\ndata: (.*)\n/.exec(frames.join(''))![1]!)
    assert.deepEqual(data.order, ['1.1', '2.2'])
    assert.equal(data.changed.length, 1)
    assert.equal(data.changed[0].lastSeq, 5)
  } finally {
    req.destroy()
    server.close()
  }
})

test('구독: 페이지가 보고 있는 스레드의 이벤트만 그 페이지로 간다; 구독 전에는 이벤트가 없다', async () => {
  const api = fakeApi()
  const log = api.events as EventLog
  const server = createAdminServer(api, { port: 0 })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as { port: number }
  const base = `http://127.0.0.1:${port}`
  const frames: string[] = []
  const req = request(`${base}/api/stream`, (res) => res.on('data', (c) => frames.push(String(c))))
  req.end()
  const until = async (f: () => boolean) => {
    for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 10))
  }
  try {
    await until(() => frames.join('').includes('event: hello'))
    const conn = JSON.parse(/event: hello\ndata: (.*)\n/.exec(frames.join(''))![1]!).conn as string
    assert.match(conn, /^[a-z0-9]{8,}$/)
    log.emit('1.1', { type: 'text', text: 'A1' } as never)
    await new Promise((r) => setTimeout(r, 30))
    assert.ok(!frames.join('').includes('A1'), '구독 전에는 받지 않는다')

    const r = await fetch(`${base}/api/subscribe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ conn, thread: '2.2' }) })
    assert.equal(r.status, 204)
    log.emit('1.1', { type: 'text', text: 'A2' } as never)
    log.emit('2.2', { type: 'text', text: 'B1' } as never)
    await until(() => frames.join('').includes('B1'))
    assert.ok(frames.join('').includes('B1'))
    assert.ok(!frames.join('').includes('A2'), '다른 스레드는 받지 않는다')

    await fetch(`${base}/api/subscribe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ conn, thread: null }) })
    log.emit('2.2', { type: 'text', text: 'B2' } as never)
    await new Promise((r) => setTimeout(r, 30))
    assert.ok(!frames.join('').includes('B2'), '구독을 풀면 받지 않는다')
    const unknown = await fetch(`${base}/api/subscribe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ conn: 'nope', thread: '2.2' }) })
    assert.equal(unknown.status, 404, '모르는 연결')
  } finally {
    req.destroy()
    server.close()
  }
})

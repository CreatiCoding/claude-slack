/**
 * Measurement for the web app's traffic, so each performance change can be compared before and after.
 * The broker counts what it sends; the page reports what it received and how long it took to show.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { createAdminServer, _resetAuthStateForTests, type AdminApi } from '../src/admin.ts'
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

test('화면 오류: 한 줄 요약과 그 아래 들여쓴 스택으로 남긴다', async () => {
  const entries: string[] = []
  const server = createAdminServer(fakeApi(), { port: 0, clientLog: (e) => entries.push(e) })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as { port: number }
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/client-error`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ where: 'sse:sessions', message: 'Unexpected token x\nin JSON', stack: 'SyntaxError: x\n    at JSON.parse\n    at on', view: 'phone', url: '/#1.1' }) })
    assert.equal(r.status, 204)
    assert.equal(entries.length, 1)
    const [head, ...stack] = entries[0]!.split('\n')
    assert.equal(head, '화면 오류 [phone] sse:sessions: Unexpected token x in JSON (/#1.1)')
    assert.deepEqual(stack, ['    SyntaxError: x', '    at JSON.parse', '    at on'])
  } finally {
    server.close()
  }
})

test('4-3 화면 오류: where·view·url 의 줄바꿈으로 로그 줄을 꾸며 넣을 수 없고, 서버는 분당 상한을 둔다', async () => {
  const entries: string[] = []
  const server = createAdminServer(fakeApi(), { port: 0, clientLog: (e) => entries.push(e) })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as { port: number }
  const post = (b: object) => fetch(`http://127.0.0.1:${port}/api/client-error`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })
  try {
    await post({ where: 'sse\n2026-10-01 [INFO] [admin] 가짜 줄', view: 'pc\nX', message: 'm', url: '/#1\n가짜' })
    const [head, ...rest] = entries[0]!.split('\n')
    assert.ok(!rest.length, entries[0])
    assert.ok(head!.includes('sse 2026-10-01'), head)
    let refused = 0
    for (let i = 0; i < 70; i++) if ((await post({ where: 'w', message: `m${i}` })).status === 429) refused++
    assert.ok(entries.length <= 61 && refused >= 9, `기록 ${entries.length}, 거절 ${refused}`)
  } finally {
    server.close()
  }
})

test('4-4 QR: 토큰은 QR 에 넣지 않고 5분짜리 일회용 코드로, 폰이 그 코드로 들어오면 한 번만 통과; 설정된 외부 주소를 쓴다', async () => {
  const { mock } = await import('node:test')
  const server = createAdminServer(fakeApi(), { port: 0, token: 'SECRET-TOKEN', publicUrl: 'https://claude.example.dev' })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as { port: number }
  const base = `http://127.0.0.1:${port}`
  try {
    const r = await fetch(`${base}/api/qr-code`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': 'SECRET-TOKEN' }, body: '{}' })
    const { url } = (await r.json()) as { url: string }
    assert.ok(!url.includes('SECRET-TOKEN'), url)
    assert.match(url, /^https:\/\/claude\.example\.dev\/login\?c=[0-9a-f]{32}$/)
    const code = new URL(url).searchParams.get('c')
    const first = await fetch(`${base}/login?c=${code}`, { redirect: 'manual' })
    assert.equal(first.status, 302)
    assert.equal(first.headers.get('location'), '/', '토큰은 더 이상 주소에 실리지 않는다(P4-33)')
    const cookie = first.headers.get('set-cookie') ?? ''
    assert.match(cookie, /^cs_admin=[0-9a-f]{32}; HttpOnly; SameSite=Lax; Max-Age=\d+; Path=\//)
    assert.ok(!cookie.includes('SECRET-TOKEN'), '쿠키 값은 토큰이 아니라 무작위 id 다')
    // 그 쿠키만으로 토큰 없이도 들어간다.
    const cookieValue = cookie.split(';')[0]!
    assert.equal((await fetch(`${base}/api/state`, { headers: { cookie: cookieValue } })).status, 200)
    assert.equal((await fetch(`${base}/api/state`)).status, 401, '쿠키도 토큰도 없으면 거절')
    assert.equal((await fetch(`${base}/login?c=${code}`, { redirect: 'manual' })).status, 403, '한 번만')
    // Expired after five minutes.
    const r2 = await fetch(`${base}/api/qr-code`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': 'SECRET-TOKEN' }, body: '{}' })
    const code2 = new URL(((await r2.json()) as { url: string }).url).searchParams.get('c')
    mock.timers.enable({ apis: ['Date'], now: Date.now() + 5 * 60_000 + 1000 })
    try {
      assert.equal((await fetch(`${base}/login?c=${code2}`, { redirect: 'manual' })).status, 403, '5분이 지나면')
    } finally {
      mock.timers.reset()
    }
    assert.equal((await fetch(`${base}/api/qr-code`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401, '코드는 토큰이 있어야 만든다')
  } finally {
    server.close()
    _resetAuthStateForTests()
  }
})

test('4-4 토큰 틀림 10번이면 1분간 모두 거절(P4-33)', async () => {
  const server = createAdminServer(fakeApi(), { port: 0, token: 'SECRET-TOKEN' })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as { port: number }
  const base = `http://127.0.0.1:${port}`
  try {
    for (let i = 0; i < 10; i++) assert.equal((await fetch(`${base}/api/state`, { headers: { 'x-admin-token': 'wrong' } })).status, 401)
    const blocked = await fetch(`${base}/api/state`, { headers: { 'x-admin-token': 'wrong' } })
    assert.equal(blocked.status, 429)
    // 맞는 토큰을 줘도 막힌 동안은 통과하지 못한다.
    assert.equal((await fetch(`${base}/api/state`, { headers: { 'x-admin-token': 'SECRET-TOKEN' } })).status, 429)
  } finally {
    server.close()
    // 이 테스트가 다음 테스트들의 127.0.0.1 요청까지 막아두지 않도록 모듈 전역 상태를 비운다.
    _resetAuthStateForTests()
  }
})

test('4-4 QR: 토큰이 없으면 외부 주소 그대로; 알려진 벡터로 디코딩(Apple 판독기로 확인한 행렬)', async () => {
  const server = createAdminServer(fakeApi(), { port: 0, publicUrl: 'https://claude.example.dev' })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as { port: number }
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/qr-code`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    assert.equal(((await r.json()) as { url: string }).url, 'https://claude.example.dev/')
  } finally {
    server.close()
  }
  const { qrMatrix } = (await import('../src/web/qr.js' as string)) as { qrMatrix: (t: string) => number[][] }
  const { readFileSync } = await import('node:fs')
  const vectors = JSON.parse(readFileSync(new URL('./fixtures/qr-vectors.json', import.meta.url), 'utf8')) as Array<{ text: string; rows: string[] }>
  for (const v of vectors) assert.deepEqual(qrMatrix(v.text).map((r) => r.join('')), v.rows, v.text)
})

test('7-4 QR: 토큰은 있는데 외부 주소가 없고 localhost 로 열렸으면 localhost QR 대신 안내', async () => {
  const server = createAdminServer(fakeApi(), { port: 0, token: 'T' })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as { port: number }
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/qr-code`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': 'T' }, body: '{}' })
    const body = (await r.json()) as { url?: string; local?: boolean }
    assert.equal(body.local, true, JSON.stringify(body))
  } finally {
    server.close()
  }
})

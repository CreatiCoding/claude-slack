import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAdminServer, isTailscaleAddress, type AdminApi } from '../src/admin.ts'
import type { AdminState } from '../src/broker.ts'

function fakeApi(overrides: Partial<AdminApi> = {}): AdminApi & { killed: number[]; purged: number[] } {
  const killed: number[] = []
  const purged: number[] = []
  return {
    killed,
    purged,
    async adminState(): Promise<AdminState> {
      return {
        channelId: 'C1',
        pins: [],
        live: [{ pid: 100, key: 'k', cwd: '/home/u/proj', state: 'idle', startedAt: Date.now(), busy: false, threadTs: '1.000' }],
        recent: [{ id: 's1', cwd: '/home/u/proj', title: '지난 작업', mtime: 1, when: '5분 전' }],
        archives: [{ path: '/tmp/nope.json', title: '보관된 것', cwd: '/home/u/proj', sessionId: 's0', archivedAt: '2026-09-13T00:00:00Z' }],
      }
    },
    async adminKill(pid) {
      killed.push(pid)
      return { ok: true, note: '종료를 요청했습니다.' }
    },
    async adminPurge(pid) {
      purged.push(pid)
      return { ok: true, note: '지웠습니다.' }
    },
    ...overrides,
  }
}

async function listening(api: AdminApi, opts = {}) {
  const server = createAdminServer(api, { port: 0, ...opts })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as { port: number }
  return { server, base: `http://127.0.0.1:${port}`, close: () => server.close() }
}

test('상태와 동작을 제공한다', async () => {
  const api = fakeApi()
  const s = await listening(api)

  const page = await fetch(s.base + '/')
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-type') ?? '', /text\/html/)

  const state = await (await fetch(s.base + '/api/state')).json()
  assert.equal(state.live[0].pid, 100)
  assert.equal(state.recent[0].title, '지난 작업')

  const killed = await (await fetch(s.base + '/api/session/100/kill', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json()
  assert.equal(killed.ok, true)
  assert.deepEqual(api.killed, [100])

  await fetch(s.base + '/api/session/100/purge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  assert.deepEqual(api.purged, [100])

  assert.equal((await fetch(s.base + '/없는길')).status, 404)
  s.close()
})

test('아카이브는 목록에 있는 파일만 읽는다', async () => {
  const s = await listening(fakeApi())
  const r = await fetch(s.base + '/api/archive?path=' + encodeURIComponent('/etc/passwd'))
  assert.equal(r.status, 404, '목록에 없는 경로는 거절한다')
  s.close()
})

test('루프백이 아니면 토큰 없이 뜨지 않는다', () => {
  assert.throws(() => createAdminServer(fakeApi(), { host: '0.0.0.0' }), /CLAUDE_SLACK_WEB_TOKEN/)
  // 토큰이 있으면 허용된다.
  const ok = createAdminServer(fakeApi(), { host: '0.0.0.0', token: 'secret' })
  ok.close()
})

test('토큰을 걸면 헤더나 쿼리로만 들어올 수 있다', async () => {
  const s = await listening(fakeApi(), { token: 'secret' })
  assert.equal((await fetch(s.base + '/api/state')).status, 401, '토큰 없이 상태를 못 본다')
  assert.equal((await fetch(s.base + '/api/session/100/kill', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401, '토큰 없이 종료할 수 없다')
  assert.equal((await fetch(s.base + '/api/state', { headers: { 'x-admin-token': 'secret' } })).status, 200)
  assert.equal((await fetch(s.base + '/api/state?t=secret')).status, 200, '휴대폰에서 링크로 열 수 있게')
  s.close()
})

test('POST 는 JSON 본문과 같은 출처만 받는다 (로컬 웹페이지의 CSRF 로 세션을 띄울 수 없다)', async () => {
  const s = await listening(fakeApi())
  // A form-encoded "simple request" a hostile page could send without a preflight.
  const plain = await fetch(s.base + '/api/session/new', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"cwd":"/tmp"}' })
  assert.equal(plain.status, 415)
  const foreign = await fetch(s.base + '/api/session/100/kill', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example' }, body: '{}' })
  assert.equal(foreign.status, 403)
  s.close()
})

test('Tailscale 대역 주소는 토큰 없이 열 수 있고, 그 밖의 주소는 못 연다', () => {
  assert.equal(isTailscaleAddress('100.101.102.103'), true)
  assert.equal(isTailscaleAddress('100.64.0.1'), true)
  assert.equal(isTailscaleAddress('100.63.0.1'), false)
  assert.equal(isTailscaleAddress('100.128.0.1'), false)
  assert.equal(isTailscaleAddress('192.168.0.5'), false)
  const server = createAdminServer(fakeApi(), { host: '100.101.102.103' })
  server.close()
  assert.throws(() => createAdminServer(fakeApi(), { host: '192.168.0.5' }), /CLAUDE_SLACK_WEB_TOKEN/)
})

test('TLS 인증서를 주면 HTTPS 로 응답한다', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { execFileSync } = await import('node:child_process')
  const { tmpdir } = await import('node:os')
  const { request } = await import('node:https')
  const dir = mkdtempSync(`${tmpdir()}/admin-tls-`)
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', `${dir}/k.pem`, '-out', `${dir}/c.pem`, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' })
  const server = createAdminServer(fakeApi(), { port: 0, tlsCert: `${dir}/c.pem`, tlsKey: `${dir}/k.pem` })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as { port: number }
  const status = await new Promise<number>((resolve, reject) => {
    request({ host: '127.0.0.1', port, path: '/', rejectUnauthorized: false }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    }).on('error', reject).end()
  })
  assert.equal(status, 200)
  server.close()
})

test('페이지의 스크립트는 문법 오류가 없다 (오류가 있으면 화면이 "불러오는 중" 에서 멈춘다)', async () => {
  const { Script } = await import('node:vm')
  const s = await listening(fakeApi())
  const html = await (await fetch(s.base + '/')).text()
  const js = /<script[^>]*>([\s\S]*)<\/script>/.exec(html)?.[1]
  assert.ok(js, 'script tag')
  assert.doesNotThrow(() => new Script(js))
  s.close()
})

test('보관 기록 삭제: JSON 본문이 있어야 하고, 성공하면 API 결과를 그대로 돌려준다', async () => {
  const deleted: string[] = []
  const s = await listening(fakeApi({ adminDeleteArchive: async (p) => (deleted.push(p), { ok: true, note: '삭제' }) }))
  const noJson = await fetch(s.base + '/api/archive/delete', { method: 'POST', body: JSON.stringify({ path: '/x.json' }) })
  assert.notEqual(noJson.status, 200, 'preflight-free requests are refused')
  const ok = await fetch(s.base + '/api/archive/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/x.json' }) })
  assert.equal(ok.status, 200)
  assert.deepEqual(deleted, ['/x.json'])
  s.close()
})

test('이름 변경: 실행 중 세션과 보관 기록 모두 JSON 본문으로만 받는다', async () => {
  const calls: string[] = []
  const s = await listening(
    fakeApi({
      adminRename: async (pid, t) => (calls.push(`s${pid}:${t}`), { ok: true, note: 'ok' }),
      adminRenameArchive: async (p, t) => (calls.push(`a${p}:${t}`), { ok: true, note: 'ok' }),
    }),
  )
  const post = (path: string, body: unknown, json = true) =>
    fetch(s.base + path, { method: 'POST', ...(json ? { headers: { 'content-type': 'application/json' } } : {}), body: JSON.stringify(body) })
  assert.notEqual((await post('/api/session/100/rename', { title: 'x' }, false)).status, 200, 'no preflight-free writes')
  assert.equal((await post('/api/session/100/rename', { title: '새 이름' })).status, 200)
  assert.equal((await post('/api/archive/rename', { path: '/a.json', title: '기록' })).status, 200)
  assert.deepEqual(calls, ['s100:새 이름', 'a/a.json:기록'])
  s.close()
})

test('이어서 하기: JSON 본문으로 세션 id 를 받아 API 에 넘긴다', async () => {
  const ids: string[] = []
  const s = await listening(fakeApi({ adminResume: async (id) => (ids.push(id), { ok: true, note: 'ok' }) }))
  const r = await fetch(s.base + '/api/session/resume', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 's1' }) })
  assert.equal(r.status, 200)
  assert.deepEqual(ids, ['s1'])
  s.close()
})

test('표 UI: 탭·검색·정렬이 되고, 세 그룹이 같은 버튼 구성(해당 없는 것은 비활성화)을 갖는다', async () => {
  const { createContext, runInContext } = await import('node:vm')
  const s = await listening(fakeApi())
  const html = await (await fetch(s.base + '/')).text()
  s.close()
  const js = /<script[^>]*>([\s\S]*)<\/script>/.exec(html)![1]!
  const els: Record<string, { textContent: string; innerHTML: string; value: string; style: Record<string, string> }> = {}
  const el = (id: string) => (els[id] ??= { textContent: '', innerHTML: '', value: '', style: {} })
  const ctx = createContext({
    document: { getElementById: el },
    location: { search: '' },
    fetch: async () => ({ status: 200, json: async () => ({}) }),
    setInterval: () => 0,
    setTimeout: () => 0,
    clearTimeout: () => {},
    window: {},
    URLSearchParams,
    encodeURIComponent,
    confirm: () => false,
    Date,
    Math,
    String,
  })
  runInContext(js, ctx)
  runInContext(
    `render({
      live: [{ pid: 7, cwd: '/p/alpha', state: 'idle', startedAt: Date.now() - 60000, busy: false, threadTs: '1.0', preview: '첫 메시지 A', model: 'claude-opus-5' }],
      recent: [{ id: 'r1', cwd: '/p/beta', title: 'R', mtime: Date.now() - 3600000, preview: '첫 메시지 B' }],
      archives: [{ path: '/a/x.json', title: 'A', cwd: '/p/gamma', sessionId: 's1', archivedAt: '2026-09-24T00:00:00Z', preview: '첫 메시지 C' }],
    })`,
    ctx,
  )
  const rowsOf = () => els.list!.innerHTML.split('<tr data-group="').slice(1)
  const buttons = (row: string) => [...row.matchAll(/<button([^>]*)>([^<]+)<\/button>/g)].filter((m) => !/class="pin/.test(m[1]!)).map((m) => ({ label: m[2]!, enabled: !/disabled/.test(m[1]!) }))

  // 탭 개수
  assert.match(els.tabs!.innerHTML, /전체<span>3<\/span>/)
  assert.match(els.tabs!.innerHTML, /실행 중<span>1<\/span>/)
  assert.equal(rowsOf().length, 3, '전체 탭: 세 그룹이 한 표에')

  // 그룹별 버튼: 앞에 대표 버튼 하나, 나머지는 ⋯ 메뉴. 순서는 모든 그룹이 같다.
  const byGroup = Object.fromEntries(rowsOf().map((r) => [r.split('"')[0]!, buttons(r)]))
  const live = byGroup.live!
  const recent = byGroup.recent!
  const archive = byGroup.archive!
  assert.deepEqual(live.map((b) => b.label), ['스레드 열기', '화면', '기록 보기', '이어서 하기', '이름 변경', '상단에 고정', '세션 종료', '스레드 삭제'])
  assert.deepEqual(recent.map((b) => b.label), ['이어서 하기', '스레드 열기', '화면', '기록 보기', '이름 변경', '상단에 고정', '세션 종료', '삭제'])
  assert.deepEqual(archive.map((b) => b.label), recent.map((b) => b.label))
  assert.deepEqual(live.filter((b) => b.enabled).map((b) => b.label), ['스레드 열기', '기록 보기', '이름 변경', '상단에 고정', '세션 종료', '스레드 삭제'], 'live: tmux 창이 없고 이미 실행 중')
  assert.deepEqual(recent.filter((b) => b.enabled).map((b) => b.label), ['이어서 하기', '상단에 고정', '삭제'], 'recent: 이어서 하기와 대화 삭제')
  assert.deepEqual(archive.filter((b) => b.enabled).map((b) => b.label), ['이어서 하기', '기록 보기', '이름 변경', '상단에 고정', '삭제'], 'archive')

  // 첫 메시지·폴더·모델
  for (const p of ['첫 메시지 A', '첫 메시지 B', '첫 메시지 C', 'alpha', 'claude-opus-5']) assert.match(els.list!.innerHTML, new RegExp(p), p)

  // 탭 전환
  runInContext(`setTab('live')`, ctx)
  assert.deepEqual(rowsOf().map((r) => r.split('"')[0]), ['live'])
  runInContext(`setTab('archive')`, ctx)
  assert.deepEqual(rowsOf().map((r) => r.split('"')[0]), ['archive'])
  runInContext(`setTab('all')`, ctx)

  // 검색: 첫 메시지·폴더·이름에서 찾는다
  runInContext(`setQuery('첫 메시지 B')`, ctx)
  assert.deepEqual(rowsOf().map((r) => r.split('"')[0]), ['recent'])
  runInContext(`setQuery('GAMMA')`, ctx)
  assert.deepEqual(rowsOf().map((r) => r.split('"')[0]), ['archive'], '대소문자 무시, 폴더로도 찾는다')
  runInContext(`setQuery('없는-검색어')`, ctx)
  assert.match(els.list!.innerHTML, /검색 결과가 없습니다/)
  runInContext(`setQuery('')`, ctx)

  // 정렬: 기본은 시각 최신순, 열 제목을 누르면 그 열로, 다시 누르면 반대로
  assert.deepEqual(rowsOf().map((r) => r.split('"')[0]), ['live', 'recent', 'archive'], '최신순')
  runInContext(`setSort('name')`, ctx)
  assert.match(els.list!.innerHTML, /이름 ▲/)
  runInContext(`setSort('name')`, ctx)
  assert.match(els.list!.innerHTML, /이름 ▼/)
})

test('저장된 대화 삭제: JSON 본문으로 세션 id 를 받아 API 에 넘긴다', async () => {
  const ids: string[] = []
  const s = await listening(fakeApi({ adminDeleteRecent: async (id) => (ids.push(id), { ok: true, note: 'ok' }) }))
  const noJson = await fetch(s.base + '/api/recent/delete', { method: 'POST', body: JSON.stringify({ id: 'abc' }) })
  assert.notEqual(noJson.status, 200, 'preflight-free writes are refused')
  const r = await fetch(s.base + '/api/recent/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'abc' }) })
  assert.equal(r.status, 200)
  assert.deepEqual(ids, ['abc'])
  s.close()
})

test('브로커가 재시작 중일 때(502)는 표를 그대로 두고 자동 재연결 문구를 보여준다', async () => {
  const { createContext, runInContext } = await import('node:vm')
  const s = await listening(fakeApi())
  const html = await (await fetch(s.base + '/')).text()
  s.close()
  const js = /<script[^>]*>([\s\S]*)<\/script>/.exec(html)![1]!
  const els: Record<string, { textContent: string; innerHTML: string; value: string; style: Record<string, string> }> = {}
  const el = (id: string) => (els[id] ??= { textContent: '', innerHTML: '', value: '', style: {} })
  let mode: 'ok' | 'down' = 'ok'
  const ctx = createContext({
    document: { getElementById: el },
    location: { search: '' },
    fetch: async () =>
      mode === 'ok'
        ? { status: 200, ok: true, json: async () => ({ live: [], recent: [], archives: [{ path: '/a/x.json', title: '보관본', cwd: '/p/c', sessionId: 's1', archivedAt: '2026-09-24T00:00:00Z' }] }) }
        : { status: 502, ok: false, text: async () => 'Bad Gateway', json: async () => { throw new SyntaxError('Unexpected token B') } },
    setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => {}, window: {},
    URLSearchParams, encodeURIComponent, confirm: () => false, Date, Math, String, JSON,
  })
  runInContext(js, ctx)
  await runInContext('refresh()', ctx)
  assert.match(els.list!.innerHTML, /보관본/, 'first load draws the table')
  mode = 'down'
  await runInContext('refresh()', ctx)
  assert.match(els.sub!.textContent, /다시 시작되는 중/)
  assert.match(els.list!.innerHTML, /보관본/, 'the table stays while reconnecting')
  mode = 'ok'
  await runInContext('refresh()', ctx)
  assert.match(els.sub!.textContent, /보관 1개/, 'and recovers by itself')
  // an action that hits the restarting proxy gets a readable note, not "Unexpected token B"
  const note = await runInContext(`noteOf({ status: 502, text: async () => 'Bad Gateway' })`, ctx)
  assert.match(note, /다시 시작되는 중/)
})

test('잔재 탭: 끊긴 스레드가 표로 보이고, 정리 버튼이 앞에 있으며, 전체 탭에는 섞이지 않는다', async () => {
  const { createContext, runInContext } = await import('node:vm')
  const s = await listening(fakeApi())
  const html = await (await fetch(s.base + '/')).text()
  s.close()
  const js = /<script[^>]*>([\s\S]*)<\/script>/.exec(html)![1]!
  const els: Record<string, { textContent: string; innerHTML: string; value: string; style: Record<string, string> }> = {}
  const el = (id: string) => (els[id] ??= { textContent: '', innerHTML: '', value: '', style: {} })
  const orphans = [
    { ts: '50.001', kind: 'ended', title: ':black_circle: *cs-smoke* · 종료됨', replies: 12, at: Date.now() - 86400000, link: 'https://x/y' },
    { ts: '50.002', kind: 'dormant', title: '대기 중인 스레드', replies: 3, at: Date.now() - 3600000 },
    { ts: '50.003', kind: 'unknown', title: '기록 없는 스레드', replies: 0, at: Date.now() - 7200000 },
  ]
  const ctx = createContext({
    document: { getElementById: el },
    location: { search: '' },
    fetch: async (url: string) => ({ status: 200, ok: true, json: async () => (String(url).startsWith('/api/orphans') ? { orphans } : { live: [], recent: [], archives: [{ path: '/a/x.json', title: 'A', cwd: '/p/c', sessionId: 's1', archivedAt: '2026-09-24T00:00:00Z' }] }) }),
    setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => {}, window: {},
    URLSearchParams, encodeURIComponent, confirm: () => false, Date, Math, String, JSON,
  })
  runInContext(js, ctx)
  await new Promise((r) => setTimeout(r, 20)) // the page's own first refresh and the first load of the orphan list
  assert.match(els.tabs!.innerHTML, /잔재<span>3<\/span>/, 'the tab shows how many')
  assert.equal(els.list!.innerHTML.split('<tr data-group="').length - 1, 1, '전체 탭에는 잔재가 섞이지 않는다')

  runInContext(`setTab('orphan')`, ctx)
  await new Promise((r) => setImmediate(r))
  const rows = els.list!.innerHTML.split('<tr data-group="').slice(1)
  assert.equal(rows.length, 3)
  assert.match(els.list!.innerHTML, /끊김/)
  assert.match(els.list!.innerHTML, /미확인/)
  assert.match(els.list!.innerHTML, /⚫ cs-smoke/, 'Slack 표기(:emoji: *굵게*)는 보기 좋게 바뀐다')
  const buttons = (row: string) => [...row.matchAll(/<button([^>]*)>([^<]+)<\/button>/g)].filter((m) => !/class="pin/.test(m[1]!)).map((m) => ({ label: m[2]!, enabled: !/disabled/.test(m[1]!) }))
  const ended = buttons(rows.find((r) => r.startsWith('orphan') && r.includes('cs-smoke'))!)
  assert.equal(ended[0]!.label, '스레드 정리', '대표 버튼은 정리')
  assert.deepEqual(ended.filter((b) => b.enabled).map((b) => b.label), ['스레드 정리', '스레드 열기', '기록 보기', '상단에 고정'])
  assert.match(els.bulk!.innerHTML, /끊긴 스레드 모두 정리 \(2\)/, '대기 중인 것은 모두 정리에서 빠진다')
})

async function viewerContext() {
  const { readFileSync } = await import('node:fs')
  const { createContext, runInContext } = await import('node:vm')
  const html = readFileSync(new URL('../src/viewer.html', import.meta.url), 'utf8')
  const js = /<script>([\s\S]*)<\/script>/.exec(html)![1]!
  const els: Record<string, { textContent: string; innerHTML: string; hidden?: boolean; href?: string }> = {}
  const el = (id: string) => (els[id] ??= { textContent: '', innerHTML: '' })
  const ctx = createContext({
    document: { getElementById: el, title: '' },
    location: { search: '?kind=archive&path=/a/x.json' },
    fetch: async () => ({ status: 404, ok: false, json: async () => ({ error: 'none' }) }),
    URLSearchParams, encodeURIComponent, Date, Math, String, JSON, Set, RegExp, NodeFilter: {},
  })
  runInContext(js, ctx)
  return { ctx, els, run: (code: string) => runInContext(code, ctx) as string }
}

test('대화 화면: Slack 서식을 HTML 로 바꾼다', async () => {
  const { run } = await viewerContext()
  const m = (text: string) => run(`mrkdwn(${JSON.stringify(text)})`)
  assert.equal(m('*굵게* 와 _기울임_ 와 ~취소~'), '<b>굵게</b> 와 <i>기울임</i> 와 <s>취소</s>')
  assert.equal(m('snake_case_word 와 2*3*4 는 그대로'), 'snake_case_word 와 2*3*4 는 그대로', '단어 안쪽의 _ 와 * 는 서식이 아니다')
  assert.equal(m('`npm test` 실행'), '<code>npm test</code> 실행')
  assert.match(m('```\nconst a = *1*\n```'), /<pre><code>const a = \*1\*<\/code><\/pre>/, '코드 블록 안은 서식을 적용하지 않는다')
  assert.equal(m('<https://a.com/x?y=1&amp;z=2|라벨> 보기'), '<a href="https://a.com/x?y=1&amp;z=2" target="_blank" rel="noopener">라벨</a> 보기')
  assert.match(m('<@U123> 확인해주세요'), /<span class="mention">@사용자<\/span> 확인해주세요/)
  assert.equal(m(':white_check_mark: 완료 :black_circle:'), '✅ 완료 ⚫')
  assert.equal(m(':unknown_emoji: 그대로'), ':unknown_emoji: 그대로')
  assert.match(m('&gt; 인용문\n본문'), /^<blockquote>인용문<\/blockquote>본문$/)
  assert.equal(m('한 줄\n두 줄'), '한 줄<br>두 줄')
  assert.equal(m('a &amp; b &lt; c'), 'a &amp; b &lt; c', 'Slack 이 이미 이스케이프한 글자는 그대로 둔다')
})

test('대화 화면: 스크립트나 위험한 링크가 섞인 메시지도 실행되지 않는다', async () => {
  const { run } = await viewerContext()
  const m = (text: string) => run(`mrkdwn(${JSON.stringify(text)})`)
  for (const bad of ['<script>alert(1)</script>', '&lt;script&gt;alert(1)&lt;/script&gt;', '<img src=x onerror=alert(1)>', '"><svg onload=alert(1)>']) {
    const out = m(bad)
    assert.ok(!/<(script|img|svg)\b/i.test(out), `${bad} → ${out}`)
  }
  assert.ok(!/href="javascript:/i.test(m('<javascript:alert(1)|클릭>')), 'javascript: 링크는 만들지 않는다')
  assert.ok(!/href="javascript:/i.test(m('<https://a.com|x> <javascript:alert(1)>')))
  // a code block keeps angle brackets as text
  assert.match(m('```\n<b>x</b>\n```'), /&lt;b&gt;x&lt;\/b&gt;/)
})

test('대화 화면: 카드(blocks)와 상태 메시지를 구분하고, 주소와 API 가 동작한다', async () => {
  const { run } = await viewerContext()
  const card = JSON.stringify({ ts: '1', bot: true, text: '요약', blocks: [{ type: 'header', text: { type: 'plain_text', text: '권한 요청' } }, { type: 'section', text: { type: 'mrkdwn', text: '*Bash* 를 실행할까요?' } }, { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: '허용' }, style: 'primary' }] }] })
  const html = run(`cardHtml(${card})`)
  assert.match(html, /class="h">권한 요청/)
  assert.match(html, /<b>Bash<\/b> 를 실행할까요\?/)
  assert.match(html, /class="chip primary">허용/)
  assert.equal(run(`isStatus({ bot: true, text: ':black_circle: 종료됨 · projects' })`), true)
  assert.equal(run(`isStatus({ bot: true, text: '안녕하세요! 무엇을 도와드릴까요?' })`), false)
  assert.equal(run(`isStatus({ bot: false, text: ':keyboard: 사용자가 쓴 글' })`), false, '사람이 쓴 글은 상태 메시지가 아니다')

  const s = await listening(fakeApi({
    adminArchiveThread: async (p) => (p === '/a/x.json' ? { title: 'T', cwd: '~/p', sessionId: 's', archivedAt: '2026-09-24T00:00:00Z', messages: [{ ts: '1', bot: false, text: '안녕' }] } : undefined),
  }))
  const page = await fetch(s.base + '/view?kind=archive&path=/a/x.json')
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-type') ?? '', /text\/html/)
  assert.match(await page.text(), /<title>대화 기록<\/title>/)
  const ok = await (await fetch(s.base + '/api/thread?kind=archive&path=%2Fa%2Fx.json')).json()
  assert.equal(ok.messages[0].text, '안녕')
  assert.match(ok.markdownUrl, /^\/api\/archive\?path=/)
  assert.equal((await fetch(s.base + '/api/thread?kind=archive&path=%2Fetc%2Fpasswd')).status, 404, '목록에 없는 경로는 열지 않는다')
  s.close()
})

test('상단 고정: 고정한 행은 어느 정렬에서도 맨 위에 오고, 고정과 해제가 API 로 간다', async () => {
  const { createContext, runInContext } = await import('node:vm')
  const calls: Array<[string, boolean]> = []
  const s = await listening(fakeApi({ adminPin: async (k, p) => (calls.push([k, p]), { ok: true, note: 'ok' }) }))
  const noJson = await fetch(s.base + '/api/pin', { method: 'POST', body: JSON.stringify({ key: 's:a', pinned: true }) })
  assert.notEqual(noJson.status, 200, 'preflight-free writes are refused')
  assert.equal((await fetch(s.base + '/api/pin', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 's:a', pinned: true }) })).status, 200)
  assert.deepEqual(calls, [['s:a', true]])
  const html = await (await fetch(s.base + '/')).text()
  s.close()

  const js = /<script[^>]*>([\s\S]*)<\/script>/.exec(html)![1]!
  const els: Record<string, { textContent: string; innerHTML: string; value: string; style: Record<string, string> }> = {}
  const el = (id: string) => (els[id] ??= { textContent: '', innerHTML: '', value: '', style: {} })
  const state = {
    pins: ['s:old-arch'],
    live: [{ pid: 7, cwd: '/p/alpha', state: 'idle', startedAt: Date.now() - 1000, busy: false, threadTs: '1.0', sessionId: 'live-1' }],
    recent: [{ id: 'r1', cwd: '/p/beta', title: 'R', mtime: Date.now() - 5000 }],
    archives: [{ path: '/a/old.json', title: 'A 오래된', cwd: '/p/c', sessionId: 'old-arch', archivedAt: '2020-01-01T00:00:00Z' }],
  }
  const posted: Array<{ url: string; body: string }> = []
  const ctx = createContext({
    document: { getElementById: el },
    location: { search: '' },
    fetch: async (url: string, o?: { body?: string }) => (o?.body ? (posted.push({ url, body: o.body }), { status: 200, ok: true, text: async () => '{}', json: async () => ({}) }) : { status: 200, ok: true, json: async () => state }),
    setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => {}, window: {},
    URLSearchParams, encodeURIComponent, confirm: () => false, Date, Math, String, JSON, Set,
  })
  runInContext(js, ctx)
  await new Promise((r) => setTimeout(r, 20))
  const order = () => els.list!.innerHTML.split('<tr data-group="').slice(1).map((r) => r.split('"')[0])
  assert.deepEqual(order(), ['archive', 'live', 'recent'], '가장 오래된 보관본이지만 고정되어 있어 맨 위')
  assert.match(els.list!.innerHTML, /class="pinned"/)
  assert.match(els.list!.innerHTML, /class="pin on"[^>]*aria-pressed="true"/)
  runInContext(`setSort('time')`, ctx) // 시각 오름차순으로 뒤집어도
  assert.equal(order()[0], 'archive', '정렬을 바꿔도 고정은 맨 위')

  // 살아 있는 세션을 고정하면 세션 id 로 기억한다 (그 세션이 보관본이 되어도 이어진다)
  await runInContext(`togglePin('s:live-1')`, ctx)
  assert.deepEqual(JSON.parse(posted.at(-1)!.body), { key: 's:live-1', pinned: true })
  assert.equal(posted.at(-1)!.url, '/api/pin')
  assert.deepEqual(order().slice(0, 2).sort(), ['archive', 'live'])
})

test('화면 이미지: 실행 중인 세션은 PNG 로, 없는 세션은 404 로 답하고, part 로 대화/패널을 고른다', async () => {
  const asked: string[] = []
  const s = await listening(fakeApi({ adminScreenPng: async (pid, part) => (asked.push(String(part)), pid === 7 && part !== 'panel' ? Buffer.from([0x89, 0x50, 0x4e, 0x47]) : undefined) }))
  assert.equal((await fetch(s.base + '/api/session/7/screen.png?part=panel')).status, 404, '패널이 없으면 404')
  await fetch(s.base + '/api/session/7/screen.png?part=conversation')
  await fetch(s.base + '/api/session/7/screen.png?part=unknown')
  assert.deepEqual(asked, ['panel', 'conversation', 'screen'], '알 수 없는 part 는 화면 전체로')
  const page = await (await fetch(s.base + '/screen/7?t=abc')).text()
  assert.match(page, /screen\.png\?part=conversation&t=abc/)
  assert.match(page, /screen\.png\?part=panel&t=abc/)
  const ok = await fetch(s.base + '/api/session/7/screen.png')
  assert.equal(ok.status, 200)
  assert.equal(ok.headers.get('content-type'), 'image/png')
  assert.deepEqual([...new Uint8Array(await ok.arrayBuffer())], [0x89, 0x50, 0x4e, 0x47])
  assert.equal((await fetch(s.base + '/api/session/99/screen.png')).status, 404)
  s.close()
})

test('listenWithRetry: 주소가 아직 없으면(EADDRNOTAVAIL) 기다렸다가 다시 시도하고, 횟수를 넘기면 포기하며, 있는 주소는 바로 붙는다', async () => {
  const { listenWithRetry } = await import('../src/admin.ts')
  // 192.0.2.1 is TEST-NET-1: no interface owns it, like the Tailscale address before tailscaled is up.
  const waited: number[] = []
  const gaveUp = await new Promise<Error>((resolve) => {
    const server = createAdminServer(fakeApi(), { host: '127.0.0.1' })
    listenWithRetry(server, 0, '192.0.2.1', { retryMs: 5, maxTries: 3, onWaiting: (n) => waited.push(n), onGiveUp: resolve })
  })
  assert.deepEqual(waited, [1, 2, 3], '세 번 기다렸다')
  assert.match((gaveUp as NodeJS.ErrnoException).code ?? '', /EADDRNOTAVAIL/)

  // an address that exists is bound at once, with no waiting
  const ok = await new Promise<{ port: number; waits: number }>((resolve, reject) => {
    let waits = 0
    const server = createAdminServer(fakeApi(), { host: '127.0.0.1' })
    listenWithRetry(server, 0, '127.0.0.1', { retryMs: 5, onWaiting: () => waits++, onGiveUp: reject, onListening: () => { resolve({ port: (server.address() as { port: number }).port, waits }); server.close() } })
  })
  assert.ok(ok.port > 0)
  assert.equal(ok.waits, 0)
})

test('모바일 스타일: 값 없는 칸 숨김이 고정 카드에서도 이기고, 메뉴는 아래에서 올라오는 시트이며, 탭은 한 줄로 스크롤된다', async () => {
  const s = await listening(fakeApi())
  const html = await (await fetch(s.base + '/')).text()
  s.close()
  const css = /@media \(max-width:820px\) \{([\s\S]*?)\n  \}\n/.exec(html)?.[1] ?? ''
  assert.ok(css, '모바일 미디어 쿼리가 있다')
  // The pinned-row rule is more specific than `.grid td.none`; hiding must be repeated for it or a pinned card shows "–".
  assert.match(css, /\.grid tr\.pinned td\.none[^{]*\{[^}]*display:none/)
  // a menu spilled off the left of the screen when it opened from a narrow button: a fixed sheet cannot
  assert.match(css, /\.menu-list[^{]*\{[^}]*position:fixed;[^}]*bottom:/)
  assert.match(css, /\.menu\[open\]::before[^{]*\{[^}]*position:fixed/)
  // five tabs on one scrolling row, not two rows that double the sticky bar
  assert.match(css, /\.tabs \{[^}]*flex-wrap:nowrap;[^}]*overflow-x:auto/)
  // iOS zooms into inputs under 16px
  assert.match(css, /input, #q \{[^}]*font-size:16px/)
  // tapping the dimmed backdrop (the menu's own ::before) closes it
  assert.match(html, /e\.target === inside\) inside\.removeAttribute\('open'\)/)
})

test('스레드 열기: 다리 페이지는 바로 오고, 링크는 따로 찾는다', async () => {
  let looked = 0
  const s = await listening(fakeApi({ adminThreadLink: async (ts) => (looked++, ts === '1.0' ? 'https://slack.example/last' : undefined) }))
  const page = await fetch(s.base + '/go/thread?ts=1.0')
  assert.equal(page.status, 200)
  assert.equal(looked, 0, '페이지를 내주는 데 Slack 을 기다리지 않는다')
  const body = await page.text()
  assert.match(body, /fetch\("\/go\/thread\.json"\+location\.search\)/)
  assert.match(body, /window\.close\(\)/, '스스로 닫는다')
  assert.match(body, /background:#14161a/, '흰 화면이 아니다')
  const ok = await fetch(s.base + '/go/thread.json?ts=1.0')
  assert.deepEqual(await ok.json(), { link: 'https://slack.example/last' })
  assert.equal((await fetch(s.base + '/go/thread.json?ts=2.0')).status, 404)
  s.close()
})

test('버튼의 onclick 이 부르는 함수는 모두 window 에 노출되어 있다 (모듈 스크립트라 빠지면 눌러도 아무 일이 없다)', async () => {
  const s = await listening(fakeApi())
  const page = await (await fetch(s.base + '/')).text()
  const exposed = new Set([...page.matchAll(/window\.(\w+)\s*=/g)].map((m) => m[1]))
  const called = new Set([...page.matchAll(/(?:o\.\w+\s*=[^\n]*?|btn\([^\n]*?)["'](\w+)\(/g)].map((m) => m[1]))
  assert.ok(called.has('openLink') && called.has('showOrphan'), '핸들러를 찾아야 한다')
  const missing = [...called].filter((n) => !exposed.has(n))
  assert.deepEqual(missing, [])
  s.close()
})

test('첫 화면: 상태가 페이지에 실려 오고, gzip 을 받을 수 있으면 압축해서 보낸다', async () => {
  const s = await listening(fakeApi())
  const plain = await (await fetch(s.base + '/', { headers: { 'accept-encoding': 'identity' } })).text()
  assert.match(plain, /const initial = \{.*"live":/, '첫 그림에 필요한 상태가 들어 있다')
  assert.doesNotMatch(plain, /\*INITIAL_STATE\*/)
  const zipped = await fetch(s.base + '/api/state', { headers: { 'accept-encoding': 'gzip' } })
  assert.equal(zipped.headers.get('content-encoding'), 'gzip')
  assert.deepEqual(Object.keys(await zipped.json()).includes('live'), true, 'fetch 가 풀어서 읽는다')
  s.close()
})

test('기록 보기는 별도 창이 아니라 페이지 안의 패널(iframe)로 열린다', async () => {
  const s = await listening(fakeApi())
  const page = await (await fetch(s.base + '/')).text()
  assert.match(page, /id="panel" hidden/)
  assert.match(page, /function showOrphan\(ts\) \{\n  openPanel\(/)
  assert.match(page, /function showArchive\(path\) \{\n  openPanel\(/)
  assert.match(page, /window\.closePanel = closePanel/)
  assert.doesNotMatch(page, /window\.open\('\/view/)
  s.close()
})

/**
 * A small admin page for the sessions this broker is relaying.
 *
 * Slack shows one session per thread, which is the right shape while you are
 * working but a poor one for "what do I have running, and what can I clean up".
 * This serves that view, plus the two destructive actions, from the machine the
 * broker runs on.
 *
 * It binds to loopback by default. Binding anywhere else requires a token,
 * because ending a session and deleting a thread are not things a stranger on
 * the network should be able to do.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import type { AdminState, Orphan, ThreadView, WebSession } from './broker.ts'
import type { SessionEvent } from './events.ts'
import { pageMetricsLine, TrafficMeter } from './meter.ts'

export interface AdminApi {
  adminState(): Promise<AdminState>
  adminKill(pid: number): Promise<{ ok: boolean; note: string }>
  adminPurge(pid: number): Promise<{ ok: boolean; note: string }>
  adminDeleteArchive?(path: string): Promise<{ ok: boolean; note: string }>
  adminResume?(id: string): Promise<{ ok: boolean; note: string }>
  adminDeleteRecent?(id: string): Promise<{ ok: boolean; note: string }>
  adminPin?(key: string, pinned: boolean): Promise<{ ok: boolean; note: string }>
  adminScreenPng?(pid: number, part?: 'screen' | 'conversation' | 'panel'): Promise<Buffer | undefined>
  adminOrphans?(force?: boolean): Promise<Orphan[]>
  /** A Slack link that opens the thread at its newest reply. */
  adminThreadLink?(threadTs: string): Promise<string | undefined>
  adminArchiveThread?(path: string): Promise<ThreadView | undefined>
  adminOrphanThread?(ts: string): Promise<ThreadView | undefined>
  adminPurgeOrphan?(ts: string): Promise<{ ok: boolean; note: string }>
  adminResumeOrphan?(ts: string): Promise<{ ok: boolean; note: string }>
  adminPurgeOrphans?(): Promise<{ ok: boolean; note: string }>
  adminRename?(pid: number, title: string): Promise<{ ok: boolean; note: string }>
  adminRenameArchive?(path: string, title: string): Promise<{ ok: boolean; note: string }>
  adminNew?(o: { cwd: string; prompt?: string }): Promise<{ ok: boolean; note: string }>
  adminScreen?(pid: number): Promise<{ ok: boolean; screen: string }>
  // The web app (/app). Absent in older fakes: the routes then answer 404.
  webSessions?(): WebSession[]
  webOptions?(): { models: Array<{ label: string; value: string }>; efforts: string[]; modes: Array<{ label: string; value: string }> }
  webSend?(pid: number, text: string): Promise<{ ok: boolean; note: string }>
  webAction?(a: { actionId: string; value: string; messageTs?: string; blocks?: unknown[] }): Promise<{ ok: boolean; note: string }>
  readonly events?: { since(thread: string, after: number): SessionEvent[]; last(thread: string): number; subscribe(l: (thread: string, ev: SessionEvent) => void): () => void }
  onChange?(l: () => void): () => void
}

/** A comment line every so often keeps proxies and phones from calling an idle stream dead. */
const SSE_PING_MS = 25_000
/** The web app's files, served as they are: no build step. */
const WEB_FILES: Record<string, string> = {
  '/': 'index.html',
  '/app': 'index.html',
  '/web/app.js': 'app.js',
  '/web/app.css': 'app.css',
  '/web/markdown.js': 'markdown.js',
  '/web/icons.js': 'icons.js',
}
const WEB_TYPES: Record<string, string> = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8' }

export interface AdminOptions {
  host?: string
  port?: number
  /** Required unless the server is on loopback. */
  token?: string
  log?: (m: string) => void
  /** PEM paths. Both set: serve HTTPS (a `.dev` name is HSTS-preloaded, so browsers refuse plain http or a self-signed cert). */
  tlsCert?: string
  tlsKey?: string
}

/** Re-read the certificate this often, so a renewal is picked up without restarting the broker. */
const TLS_RELOAD_MS = 6 * 60 * 60 * 1000

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])

/** Tailscale hands out 100.64.0.0/10 (CGNAT). Only devices on the tailnet can reach an address there. */
export function isTailscaleAddress(host: string): boolean {
  const m = /^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host)
  return !!m && Number(m[1]) >= 64 && Number(m[1]) <= 127
}

/**
 * Start listening, and keep trying while the address is not there yet. After a boot the Tailscale address
 * (100.x) only exists once tailscaled has brought its interface up, which can be after the broker starts;
 * without a retry the admin page stays down until someone restarts the broker.
 */
export function listenWithRetry(
  server: Server | HttpsServer,
  port: number,
  host: string,
  opts: { retryMs?: number; maxTries?: number; onListening?: () => void; onWaiting?: (tries: number) => void; onGiveUp?: (err: Error) => void } = {},
): void {
  const retryMs = opts.retryMs ?? 5000
  const maxTries = opts.maxTries ?? 180 // fifteen minutes at the default pace
  let tries = 0
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRNOTAVAIL' && ++tries <= maxTries) {
      opts.onWaiting?.(tries)
      setTimeout(() => server.listen(port, host), retryMs).unref?.()
      return
    }
    opts.onGiveUp?.(err)
  })
  server.listen(port, host, opts.onListening)
}

export function createAdminServer(api: AdminApi, opts: AdminOptions = {}): Server | HttpsServer {
  const host = opts.host ?? '127.0.0.1'
  const token = opts.token
  const log = opts.log ?? (() => {})
  if (!LOOPBACK.has(host) && !isTailscaleAddress(host) && !token) {
    throw new Error(`admin: refusing to listen on ${host} without CLAUDE_SLACK_WEB_TOKEN — anyone who can reach it could end sessions (only loopback and Tailscale addresses may go without one)`)
  }

  // What the web app costs: counted as it is sent, logged once a minute.
  const meter = new TrafficMeter((l) => log(`web ${l}`))
  meter.start()
  const onRequest = (req: IncomingMessage, res: ServerResponse) => {
    handle(req, res, api, token, log, meter).catch((err) => {
      log(`admin request failed: ${err}`)
      send(res, 500, { error: String(err) })
    })
  }
  const { tlsCert, tlsKey } = opts
  if (!tlsCert || !tlsKey) return Object.assign(createServer(onRequest), { meter })

  const read = () => ({ cert: readFileSync(tlsCert), key: readFileSync(tlsKey) })
  const server = createHttpsServer(read(), onRequest)
  setInterval(() => {
    try {
      server.setSecureContext(read())
    } catch (err) {
      log(`admin: could not reload the TLS certificate: ${err}`)
    }
  }, TLS_RELOAD_MS).unref()
  return Object.assign(server, { meter })
}

async function handle(req: IncomingMessage, res: ServerResponse, api: AdminApi, token: string | undefined, log: (m: string) => void, meter: TrafficMeter): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  // A token, when configured, may travel as a header or as `?t=` so a phone can
  // just open a bookmarked link.
  if (token && req.headers['x-admin-token'] !== token && url.searchParams.get('t') !== token) {
    return send(res, 401, { error: 'unauthorized' })
  }

  // A browser page on the same machine could otherwise POST here as a "simple request"
  // (no preflight) and start or kill sessions. Requiring a JSON body forces a preflight,
  // which we never answer, and a foreign Origin is refused outright.
  if (req.method === 'POST') {
    const origin = req.headers.origin
    const host = req.headers.host
    if (origin && host && new URL(origin).host !== host) return send(res, 403, { error: 'cross-origin request refused' })
    if (!/^application\/json/i.test(String(req.headers['content-type'] ?? ''))) return send(res, 415, { error: 'content-type must be application/json' })
  }

  // The previous admin page, kept until the web app has everything it had.
  if (req.method === 'GET' && url.pathname === '/admin') {
    // The state rides along in the page, so the first paint needs no second round trip.
    const state = await api.adminState().catch(() => undefined)
    const html = PAGE.replace('/*INITIAL_STATE*/null', state ? JSON.stringify(state).replace(/</g, '\\u003c') : 'null')
    return sendText(req, res, 'text/html; charset=utf-8', html)
  }
  const webFile = WEB_FILES[url.pathname]
  if (req.method === 'GET' && webFile) {
    const body = readFileSync(new URL(`./web/${webFile}`, import.meta.url), 'utf8')
    return sendText(req, res, WEB_TYPES[webFile.split('.').pop()!]!, body)
  }
  // Live updates for the web app: the session list whenever it changes, and every session event as it happens.
  // One way (server → page); anything the page does is a POST, answered on its own.
  if (req.method === 'GET' && url.pathname === '/api/stream' && api.webSessions && api.events && api.onChange) {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' })
    const write = (event: string, data: unknown, kind = event) => {
      const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
      meter.add(kind, Buffer.byteLength(frame))
      res.write(frame)
    }
    res.write('retry: 2000\n\n')
    write('sessions', api.webSessions())
    const offChange = api.onChange(() => write('sessions', api.webSessions!()))
    const offEvent = api.events.subscribe((thread, ev) => write('ev', { thread, ev }, `ev:${ev.type}`))
    const ping = setInterval(() => res.write(`: ping ${Date.now()}\n\n`), SSE_PING_MS)
    req.on('close', () => {
      clearInterval(ping)
      offChange()
      offEvent()
    })
    return
  }
  if (req.method === 'GET' && url.pathname === '/api/options' && api.webOptions) return send(res, 200, api.webOptions())
  if (req.method === 'GET' && url.pathname === '/api/events' && api.events) {
    const thread = url.searchParams.get('thread') ?? ''
    const after = Math.max(0, Number(url.searchParams.get('after') ?? 0) || 0)
    const body = JSON.stringify({ events: api.events.since(thread, after), last: api.events.last(thread) })
    meter.add('events', Buffer.byteLength(body), `thread=${thread} after=${after}`)
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(body)
    return
  }
  // A page's own numbers for its last minute (received, time to show, catch-ups, stalls, DOM size), into the log.
  if (req.method === 'POST' && url.pathname === '/api/metrics') {
    log(pageMetricsLine(await readJson(req)))
    res.writeHead(204)
    res.end()
    return
  }
  const sendTo = /^\/api\/session\/(\d+)\/send$/.exec(url.pathname)
  if (req.method === 'POST' && sendTo && api.webSend) {
    const body = await readJson(req)
    const result = await api.webSend(Number(sendTo[1]), String(body.text ?? ''))
    return send(res, result.ok ? 200 : 400, result)
  }
  if (req.method === 'POST' && url.pathname === '/api/action' && api.webAction) {
    const body = await readJson(req)
    const result = await api.webAction({
      actionId: String(body.actionId ?? ''),
      value: String(body.value ?? ''),
      ...(typeof body.messageTs === 'string' ? { messageTs: body.messageTs } : {}),
      ...(Array.isArray(body.blocks) ? { blocks: body.blocks } : {}),
    })
    log(`web action ${String(body.actionId ?? '')}: ${result.note}`)
    return send(res, result.ok ? 200 : 400, result)
  }
  if (req.method === 'GET' && url.pathname === '/api/state') {
    return sendText(req, res, 'application/json; charset=utf-8', JSON.stringify(await api.adminState()))
  }
  if (req.method === 'GET' && url.pathname === '/api/archive') {
    // Only files the state listing already offered, so this cannot read the disk at large.
    const path = url.searchParams.get('path') ?? ''
    const known = (await api.adminState()).archives.some((a) => a.path === path)
    if (!known) return send(res, 404, { error: 'unknown archive' })
    try {
      return send(res, 200, { markdown: readFileSync(path.replace(/\.json$/, '.md'), 'utf8') })
    } catch (err) {
      return send(res, 404, { error: String(err) })
    }
  }
  const screen = /^\/api\/session\/(\d+)\/screen$/.exec(url.pathname)
  if (req.method === 'GET' && screen && api.adminScreen) return send(res, 200, await api.adminScreen(Number(screen[1])))
  if (req.method === 'POST' && url.pathname === '/api/archive/rename' && api.adminRenameArchive) {
    const body = await readJson(req)
    const result = await api.adminRenameArchive(String(body.path ?? ''), String(body.title ?? ''))
    log(`admin rename archive: ${result.note}`)
    return send(res, result.ok ? 200 : 400, result)
  }
  const rename = /^\/api\/session\/(\d+)\/rename$/.exec(url.pathname)
  if (req.method === 'POST' && rename && api.adminRename) {
    const body = await readJson(req)
    const result = await api.adminRename(Number(rename[1]), String(body.title ?? ''))
    log(`admin rename ${rename[1]}: ${result.note}`)
    return send(res, result.ok ? 200 : 400, result)
  }
  // Open a thread at its newest reply. The page comes back at once and finds the link itself: looking it up takes a call to
  // Slack, and waiting for that before answering left a blank tab.
  if (req.method === 'GET' && url.pathname === '/go/thread.json' && api.adminThreadLink) {
    const link = await api.adminThreadLink(url.searchParams.get('ts') ?? '').catch(() => undefined)
    if (!link || !/^https:\/\//.test(link)) return send(res, 404, { error: '열 Slack 스레드를 찾지 못했습니다.' })
    return send(res, 200, { link })
  }
  if (req.method === 'GET' && url.pathname === '/go/thread' && api.adminThreadLink) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
    res.end(
      '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Slack 스레드 열기</title>' +
        '<style>html{background:#14161a}body{font:16px/1.6 system-ui;color:#e6e9ef;padding:32px 20px;text-align:center}a{color:#8ab4ff;font-size:18px}</style>' +
        '<p id="m">Slack 스레드를 여는 중입니다…</p><p><a id="a" hidden>열리지 않으면 여기를 누르세요</a></p>' +
        '<script>var m=document.getElementById("m"),a=document.getElementById("a");' +
        'fetch("/go/thread.json"+location.search).then(function(r){return r.ok?r.json():Promise.reject()}).then(function(d){' +
        'a.href=d.link;a.hidden=false;location.href=d.link;' +
        'setTimeout(function(){window.close();setTimeout(function(){m.textContent="이 탭은 닫아도 됩니다"},300)},300)' +
        '}).catch(function(){m.textContent="열 Slack 스레드를 찾지 못했습니다."})</script>',
    )
    return
  }
  // The conversation as a chat: the page itself, and the messages it draws.
  if (req.method === 'GET' && url.pathname === '/view') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(readFileSync(new URL('./viewer.html', import.meta.url), 'utf8'))
    return
  }
  if (req.method === 'GET' && url.pathname === '/api/thread') {
    const kind = url.searchParams.get('kind')
    const view =
      kind === 'orphan' ? await api.adminOrphanThread?.(url.searchParams.get('ts') ?? '') : await api.adminArchiveThread?.(url.searchParams.get('path') ?? '')
    if (!view) return send(res, 404, { error: '대화를 찾지 못했습니다. 목록을 새로고침한 뒤 다시 여세요.' })
    return send(res, 200, kind === 'orphan' ? view : { ...view, markdownUrl: '/api/archive?path=' + encodeURIComponent(url.searchParams.get('path') ?? '') })
  }
  // The screen of a running session: the conversation, and beside it the panel when Claude Code has one open.
  const screenPage = /^\/screen\/(\d+)$/.exec(url.pathname)
  if (req.method === 'GET' && screenPage && api.adminScreenPng) {
    const pid = screenPage[1]
    const t = url.searchParams.get('t')
    const src = (part: string) => `/api/session/${pid}/screen.png?part=${part}${t ? `&t=${encodeURIComponent(t)}` : ''}`
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>터미널 화면</title>
<style>body{margin:0;padding:12px;background:#14161a;color:#8b93a1;font:13px -apple-system,system-ui,sans-serif}img{display:block;max-width:100%;height:auto;margin:0 auto 14px;border-radius:10px}#note{text-align:center;padding:30px 0}</style>
<div id="note">화면을 그리는 중…</div>
<img alt="대화" src="${src('conversation')}" onload="document.getElementById('note').remove()" onerror="document.getElementById('note').textContent='화면을 가져오지 못했습니다. 실행 중인 tmux 세션인지 확인하세요.'">
<img alt="변경 내용" src="${src('panel')}" onerror="this.remove()">`)
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/pin' && api.adminPin) {
    const body = await readJson(req)
    const result = await api.adminPin(String(body.key ?? ''), body.pinned === true)
    return send(res, result.ok ? 200 : 400, result)
  }
  const png = /^\/api\/session\/(\d+)\/screen\.png$/.exec(url.pathname)
  if (req.method === 'GET' && png && api.adminScreenPng) {
    let image: Buffer | undefined
    const asked = url.searchParams.get('part')
    try {
      image = await api.adminScreenPng(Number(png[1]), asked === 'conversation' || asked === 'panel' ? asked : 'screen')
    } catch (err) {
      return send(res, 503, { error: '화면을 그리지 못했습니다: ' + String(err) })
    }
    if (!image) return send(res, 404, { error: '실행 중인 tmux 세션이 아니거나 이미 끝났습니다.' })
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
    res.end(image)
    return
  }
  if (req.method === 'GET' && url.pathname === '/api/orphans' && api.adminOrphans) {
    return send(res, 200, { orphans: await api.adminOrphans(url.searchParams.get('force') === '1') })
  }
  if (req.method === 'POST' && url.pathname === '/api/orphans/purge' && api.adminPurgeOrphans) {
    const result = await api.adminPurgeOrphans()
    log(`admin purge orphans: ${result.note}`)
    return send(res, result.ok ? 200 : 400, result)
  }
  if (req.method === 'POST' && url.pathname === '/api/orphan/resume' && api.adminResumeOrphan) {
    const body = await readJson(req)
    const result = await api.adminResumeOrphan(String(body.ts ?? ''))
    log(`admin resume orphan: ${result.note}`)
    return send(res, result.ok ? 200 : 400, result)
  }
  if (req.method === 'POST' && url.pathname === '/api/orphan/purge' && api.adminPurgeOrphan) {
    const body = await readJson(req)
    const result = await api.adminPurgeOrphan(String(body.ts ?? ''))
    log(`admin purge orphan: ${result.note}`)
    return send(res, result.ok ? 200 : 400, result)
  }
  if (req.method === 'POST' && url.pathname === '/api/recent/delete' && api.adminDeleteRecent) {
    const body = await readJson(req)
    const result = await api.adminDeleteRecent(String(body.id ?? ''))
    log(`admin delete conversation: ${result.note}`)
    return send(res, result.ok ? 200 : 400, result)
  }
  if (req.method === 'POST' && url.pathname === '/api/archive/delete' && api.adminDeleteArchive) {
    const body = await readJson(req)
    const result = await api.adminDeleteArchive(String(body.path ?? ''))
    log(`admin delete archive: ${result.note}`)
    return send(res, result.ok ? 200 : 404, result)
  }
  if (req.method === 'POST' && url.pathname === '/api/session/resume' && api.adminResume) {
    const body = await readJson(req)
    const result = await api.adminResume(String(body.id ?? ''))
    log(`admin resume: ${result.note}`)
    return send(res, result.ok ? 200 : 400, result)
  }
  if (req.method === 'POST' && url.pathname === '/api/session/new' && api.adminNew) {
    const body = await readJson(req)
    const result = await api.adminNew({ cwd: String(body.cwd ?? ''), prompt: typeof body.prompt === 'string' ? body.prompt : '' })
    log(`admin new ${String(body.cwd ?? '')}: ${result.note}`)
    return send(res, result.ok ? 200 : 400, result)
  }
  const action = /^\/api\/session\/(\d+)\/(kill|purge)$/.exec(url.pathname)
  if (req.method === 'POST' && action) {
    const pid = Number(action[1])
    const result = action[2] === 'kill' ? await api.adminKill(pid) : await api.adminPurge(pid)
    log(`admin ${action[2]} ${pid}: ${result.note}`)
    return send(res, 200, result)
  }
  send(res, 404, { error: 'not found' })
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > 64 * 1024) throw new Error('body too large')
  }
  try {
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** A text body, gzipped when the browser accepts it: the page and its state are tens of kilobytes over a phone connection. */
function sendText(req: IncomingMessage, res: ServerResponse, type: string, text: string): void {
  const headers: Record<string, string | number> = { 'content-type': type, 'cache-control': 'no-store', vary: 'accept-encoding' }
  if (/\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) {
    const body = gzipSync(text)
    res.writeHead(200, { ...headers, 'content-encoding': 'gzip', 'content-length': body.length })
    res.end(body)
    return
  }
  res.writeHead(200, headers)
  res.end(text)
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/** One self-contained page: no build step, no assets to serve. */
const PAGE = `<!doctype html>
<html lang="ko">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>claude-slack</title>
<style>
  html { background:#14161a }
  /* No rubber-band on iOS: pulling past the top or bottom must not drag the sticky tabs away and show the canvas behind them. */
  html, body { overscroll-behavior:none }
  .panel-body iframe, .panel-body { overscroll-behavior:contain }
  :root { color-scheme: dark light; --bg:#14161a; --card:#1d2026; --line:#2c313a; --dim:#8b93a1; --fg:#e6e9ef; --busy:#4f8cff; --idle:#3fb950; --wait:#d29922; --danger:#f85149 }
  * { box-sizing: border-box }
  body { margin:0; padding:16px; background:var(--bg); color:var(--fg); font:15px/1.55 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo",system-ui,sans-serif }
  h1 { font-size:18px; margin:0 0 4px }
  h2 { font-size:14px; color:var(--dim); margin:24px 0 8px; font-weight:600 }
  .sub { color:var(--dim); font-size:13px; margin-bottom:8px }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:12px 14px; margin-bottom:10px }
  .row { display:flex; gap:10px; align-items:baseline; flex-wrap:wrap }
  .title { font-weight:600 }
  .meta { color:var(--dim); font-size:13px; word-break:break-all }
  .preview { margin-top:6px; padding:8px 10px; border-radius:8px; background:rgba(255,255,255,.04); font-size:13px; line-height:1.5; white-space:pre-wrap; word-break:break-word; display:-webkit-box; -webkit-line-clamp:4; -webkit-box-orient:vertical; overflow:hidden }
  .dot { width:8px; height:8px; border-radius:50%; display:inline-block; flex:0 0 auto }
  .busy{background:var(--busy)} .idle{background:var(--idle)} .wait{background:var(--wait)} .ended{background:var(--dim)}
  button { font:inherit; padding:7px 12px; border-radius:8px; border:1px solid var(--line); background:#262b33; color:var(--fg); cursor:pointer }
  button:hover { border-color:#3d444f }
  button.danger { color:var(--danger); border-color:#472b2b }
  button:disabled { opacity:.45; cursor:not-allowed }
  button:focus-visible, summary:focus-visible, #q:focus-visible, th.sortable:focus-visible { outline:2px solid var(--busy); outline-offset:2px }
  body.busy, body.busy * { cursor:progress }
  .bulk { display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin:0 0 10px; padding:10px 12px; border:1px solid var(--line); border-radius:10px; background:var(--card) }
  .bulk .dim { flex:1; min-width:220px; color:var(--dim); font-size:13px }
  .grid .pin { border:0; background:transparent; padding:0 6px 0 0; margin:0; cursor:pointer; opacity:.25; filter:grayscale(1); font-size:13px; line-height:1 }
  .grid .pin:hover, .grid .pin:focus-visible { opacity:.7 }
  .grid .pin.on { opacity:1; filter:none }
  .grid tr.pinned td { background:rgba(79,140,255,.07) }
  .bar { position:sticky; top:0; z-index:30; background:var(--bg); padding:10px 0; margin:0 0 4px }
  .grid thead th { position:sticky; top:var(--bar-h, 56px); z-index:20; background:var(--card); box-shadow:0 1px 0 var(--line) }
  .menu-list.up { top:auto; bottom:calc(100% + 4px) }
  a { color:var(--busy); text-decoration:none }
  .actions { display:flex; gap:8px; margin-top:10px; flex-wrap:wrap }
  .empty { color:var(--dim); padding:8px 0 }
  #panel[hidden] { display:none }
  .panel-back { position:fixed; inset:0; background:rgba(0,0,0,.55); z-index:40 }
  .panel-body { position:fixed; top:0; right:0; bottom:0; width:min(760px,100vw); background:var(--bg); border-left:1px solid var(--line); z-index:41; display:flex; flex-direction:column; box-shadow:-12px 0 32px rgba(0,0,0,.45) }
  .panel-body header { display:flex; justify-content:space-between; align-items:center; padding:8px 12px; border-bottom:1px solid var(--line) }
  .panel-body header a { color:var(--dim); font-size:13px }
  .panel-body header button { padding:4px 12px }
  .panel-body iframe { flex:1; width:100%; border:0; background:var(--bg) }
  body.panel-open { overflow:hidden }
  #note { position:sticky; top:0; background:#23303f; border:1px solid #2f4a66; border-radius:10px; padding:10px 12px; margin-bottom:12px; display:none }
  .bar { display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin:18px 0 10px }
  .tabs { display:flex; gap:6px; flex-wrap:wrap }
  .tabs button { padding:6px 12px; border-radius:999px }
  .tabs button.on { background:#2d3a52; border-color:#3f5a86; color:#fff }
  .tabs button span { color:var(--dim); margin-left:4px; font-size:12px }
  #q { flex:1; min-width:180px; font:inherit; padding:7px 12px; border-radius:999px; border:1px solid var(--line); background:#0f1115; color:var(--fg) }
  .grid { width:100%; border-collapse:collapse; background:var(--card); border:1px solid var(--line); border-radius:12px; overflow:visible }
  .grid th { text-align:left; color:var(--dim); font-size:12px; font-weight:600; padding:9px 10px; border-bottom:1px solid var(--line); white-space:nowrap; user-select:none }
  .grid th.sortable { cursor:pointer }
  .grid td { padding:9px 10px; border-bottom:1px solid var(--line); vertical-align:top; font-size:14px }
  .grid tr:last-child td { border-bottom:0 }
  .grid tr:hover td { background:rgba(255,255,255,.025) }
  .grid .name { font-weight:600; word-break:break-word }
  .grid .dim { color:var(--dim); font-size:13px }
  .grid .nowrap { white-space:nowrap }
  .grid .snippet { color:var(--dim); font-size:13px; line-height:1.45; white-space:pre-wrap; word-break:break-word; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; max-width:420px }
  .badge { display:inline-flex; align-items:center; gap:6px; font-size:12px; padding:2px 8px; border-radius:999px; background:rgba(255,255,255,.06); white-space:nowrap }
  .cell-actions { display:flex; gap:6px; align-items:flex-start; justify-content:flex-end; white-space:nowrap }
  .menu { position:relative }
  .menu summary { list-style:none; cursor:pointer; padding:7px 12px; border-radius:8px; border:1px solid var(--line); background:#262b33; user-select:none }
  .menu summary::-webkit-details-marker { display:none }
  .menu[open] summary { border-color:#3d444f }
  .menu-list { position:absolute; right:0; top:calc(100% + 4px); z-index:10; min-width:190px; padding:6px; background:#20242b; border:1px solid var(--line); border-radius:10px; box-shadow:0 8px 24px rgba(0,0,0,.4) }
  .menu-list button { display:block; width:100%; text-align:left; margin:2px 0; border-color:transparent; background:transparent }
  .menu-list button:hover:not(:disabled) { background:#2c313a }
  @media (max-width:820px) {
    body { padding:12px max(14px, env(safe-area-inset-right)) calc(28px + env(safe-area-inset-bottom)) max(14px, env(safe-area-inset-left)) }
    h1 { font-size:17px }
    .sub { margin-bottom:10px }
    /* iOS zooms into any input under 16px when it is tapped */
    input, #q { font-size:16px !important }
    .card { padding:10px; margin-bottom:0 }
    .bar { flex-direction:column; align-items:stretch; gap:8px; margin:14px 0 8px; padding:8px 0 6px }
    /* five tabs on one row that scrolls, instead of wrapping onto a second row and doubling the bar */
    .tabs { flex-wrap:nowrap; overflow-x:auto; gap:6px; margin:0 -14px; padding:0 14px; scrollbar-width:none; -webkit-overflow-scrolling:touch }
    .tabs::-webkit-scrollbar { display:none }
    .tabs button { flex:0 0 auto; padding:6px 13px; font-size:14px }
    #q { min-height:40px; padding:8px 14px }
    .bulk { padding:10px; gap:8px }
    .bulk .dim { min-width:0; flex-basis:100% }

    .grid thead { display:none }
    .grid, .grid tbody { display:block; background:none; border:0 }
    /* a card is a grid: status and time on top, then the name, the first message, folder and model, the buttons */
    .grid tr { display:grid; grid-template-columns:1fr auto auto; grid-template-areas:"status status time" "name name name" "preview preview preview" "folder messages model" "actions actions actions"; column-gap:10px; row-gap:4px; background:var(--card); border:1px solid var(--line); border-radius:14px; margin-bottom:10px; padding:12px 14px }
    .grid tr.pinned { background:linear-gradient(0deg, rgba(79,140,255,.10), rgba(79,140,255,.10)), var(--card); border-color:#2f4a76 }
    .grid td, .grid tr.pinned td, .grid tr:hover td { display:block; border:0; padding:0; background:transparent; min-width:0 }
    .grid td::before { content:none !important }
    .grid td.none, .grid tr.pinned td.none, .grid tr:hover td.none { display:none }
    .c-status { grid-area:status; align-self:center }
    .c-time { grid-area:time; align-self:center; text-align:right; font-size:12px }
    .c-name { grid-area:name; font-size:16px; line-height:1.35; margin-top:2px }
    .c-preview { grid-area:preview }
    .grid .snippet { max-width:none; -webkit-line-clamp:3; font-size:14px; line-height:1.5 }
    .c-folder { grid-area:folder; font-size:12px }
    .c-model { grid-area:model; font-size:12px; text-align:right }
    .c-messages { grid-area:messages; font-size:12px; text-align:right }
    .grid .nowrap { white-space:normal; word-break:break-all }
    .c-actions { grid-area:actions; margin-top:8px }
    /* thumb-sized: the main button takes the width, the menu is a square beside it */
    .cell-actions { justify-content:stretch; gap:8px; width:100% }
    .cell-actions > button { flex:1; min-height:44px }
    .cell-actions .menu summary { min-width:48px; min-height:44px; display:grid; place-items:center; padding:0 }
    .grid .pin { min-width:32px; min-height:32px; padding:0 4px 0 0; margin:-6px 0 -6px -4px; font-size:15px }
    /* The menu was anchored to the right edge of a narrow button and spilled off the left of the screen:
       on a phone it is a sheet from the bottom, with the rest of the page dimmed behind it. */
    .menu { position:static }
    .menu[open]::before { content:""; position:fixed; inset:0; background:rgba(0,0,0,.5); z-index:40 }
    .menu-list, .menu-list.up { position:fixed; left:10px; right:10px; top:auto; bottom:max(10px, env(safe-area-inset-bottom)); z-index:41; min-width:0; max-height:72vh; overflow-y:auto; padding:8px; border-radius:16px; box-shadow:0 -6px 30px rgba(0,0,0,.5) }
    .menu-list button { min-height:48px; font-size:16px; padding:10px 14px }
    #note { margin:0 0 10px }
  }
  pre { white-space:pre-wrap; word-break:break-word; background:#0f1115; border:1px solid var(--line); border-radius:10px; padding:12px; max-height:60vh; overflow:auto; font-size:13px }
</style>
<h1>claude-slack</h1>
<div class="sub" id="sub">불러오는 중…</div>
<div id="note"></div>
<div id="form"></div>
<div class="bar"><div class="tabs" id="tabs"></div><input id="q" type="search" placeholder="이름 · 폴더 · 첫 메시지 검색" oninput="setQuery(this.value)"></div>
<div id="bulk"></div>
<div id="list"></div>
<div id="foot"></div>
<div id="panel" hidden>
  <div class="panel-back" onclick="closePanel()"></div>
  <aside class="panel-body" role="dialog" aria-label="대화 기록">
    <header><a id="panel-new" target="_blank" rel="noopener">새 탭에서 열기 ↗</a><button onclick="closePanel()" aria-label="닫기">✕</button></header>
    <iframe id="panel-frame" title="대화 기록"></iframe>
  </aside>
</div>
<script type="module">
const q = new URLSearchParams(location.search).get('t')
const auth = q ? { 'x-admin-token': q } : {}
const $ = (id) => document.getElementById(id)
let busyAction = false

function note(text, ms = 6000) {
  const n = $('note'); n.textContent = text; n.style.display = 'block'
  clearTimeout(note.t); note.t = setTimeout(() => (n.style.display = 'none'), ms)
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]))
const ago = (ms) => {
  const m = Math.round((Date.now() - ms) / 60000)
  if (m < 60) return m + '분째'
  const h = Math.floor(m / 60)
  return h + '시간 ' + (m % 60) + '분째'
}
// A restarting broker answers through the proxy with a plain "Bad Gateway", which is not JSON.
async function noteOf(r) {
  const text = await r.text()
  try { return JSON.parse(text).note ?? '완료' } catch { return r.status >= 500 ? '브로커가 다시 시작되는 중입니다. 잠시 뒤 다시 시도하세요. (HTTP ' + r.status + ')' : '응답을 읽지 못했습니다. (HTTP ' + r.status + ')' }
}
// Names and first messages come from Slack text (:emoji:, bold and code marks); in a table cell show them as plain text.
const EMOJI = { black_circle: '⚫', white_check_mark: '✅', x: '❌', keyboard: '⌨️', pencil2: '✏️', hourglass_flowing_sand: '⏳', eyes: '👀', large_blue_circle: '🔵', large_green_circle: '🟢', large_yellow_circle: '🟡', red_circle: '🔴', warning: '⚠️', wastebasket: '🗑', arrows_counterclockwise: '🔄', memo: '📝', gear: '⚙️', robot_face: '🤖', rocket: '🚀', package: '📦', broom: '🧹', bulb: '💡', tada: '🎉', sparkles: '✨', thumbsup: '👍', slightly_smiling_face: '🙂', new: '🆕', lock: '🔒', unlock: '🔓', link: '🔗', bar_chart: '📊', hammer_and_wrench: '🛠️', mag: '🔍', clipboard: '📋', repeat: '🔁' }
const plain = (t) => String(t ?? '')
  .replace(/<(?:https?:[^|>]+)\\|([^>]+)>/g, '$1').replace(/<(https?:[^>]+)>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  .replace(/:([a-z0-9_+-]+):/g, (m, n) => EMOJI[n] ?? m).replace(/[*_~\\u0060]/g, '').replace(/\\s+/g, ' ').trim()
const preview = (t) => (t ? '<div class="preview">' + esc(t) + '</div>' : '')
const btn = (label, js, why, danger) => js
  ? '<button' + (danger ? ' class="danger"' : '') + ' onclick="' + js + '">' + label + '</button>'
  : '<button disabled title="' + esc(why) + '">' + label + '</button>'
const DOT = { busy:'busy', idle:'idle', waiting:'wait', starting:'busy', ended:'ended' }

// A real link click in a new tab that cannot reach back into this one: window.open left this page blank on some browsers.
function openLink(href) {
  const a = document.createElement('a')
  a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'
  document.body.appendChild(a); a.click(); a.remove()
}
async function act(pid, what, label) {
  if (!confirm(label + ' 하시겠습니까?')) return
  busyAction = true; document.body?.classList?.add('busy')
  try {
    const r = await fetch('/api/session/' + pid + '/' + what, { method:'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{}' })
    note(await noteOf(r))
  } catch (e) { note('실패: ' + e) } finally { busyAction = false; document.body?.classList?.remove('busy'); refresh() }
}
async function newSession() {
  const cwd = $('new-cwd').value.trim(), prompt = $('new-prompt').value
  busyAction = true; document.body?.classList?.add('busy')
  try {
    const r = await fetch('/api/session/new', { method:'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ cwd, prompt }) })
    note(await noteOf(r))
    if (r.ok) $('new-prompt').value = ''
  } catch (e) { note('실패: ' + e) } finally { busyAction = false; document.body?.classList?.remove('busy'); refresh() }
}
function showScreen(pid) {
  window.open('/screen/' + pid + (q ? '?t=' + encodeURIComponent(q) : ''), '_blank')
}
// The conversation opens over the list, on the right (a full sheet on a phone), so the list stays where it was.
function openPanel(url) {
  const framed = url + '&embed=1'
  // replace(), not src: a plain src adds an entry to the page's history and Back would then walk the frame instead of closing it.
  try { $('panel-frame').contentWindow.location.replace(framed) } catch { $('panel-frame').src = framed }
  $('panel-new').href = url
  $('panel').hidden = false
  document.body.classList.add('panel-open')
  // Back (a phone's swipe or button) closes the panel rather than leaving the page.
  if (!history.state?.panel) history.pushState({ panel: 1 }, '')
}
function hidePanel() {
  $('panel').hidden = true
  try { $('panel-frame').contentWindow.location.replace('about:blank') } catch { $('panel-frame').src = 'about:blank' }
  document.body.classList.remove('panel-open')
}
function closePanel() {
  if (history.state?.panel) history.back()
  else hidePanel()
}
window.addEventListener?.('popstate', () => { if (!$('panel').hidden) hidePanel() })
function showArchive(path) {
  openPanel('/view?kind=archive&path=' + encodeURIComponent(path) + (q ? '&t=' + encodeURIComponent(q) : ''))
}
function showOrphan(ts) {
  openPanel('/view?kind=orphan&ts=' + encodeURIComponent(ts) + (q ? '&t=' + encodeURIComponent(q) : ''))
}
async function rename(url, current) {
  const title = prompt('새 이름', current)
  if (title === null || !title.trim() || title.trim() === current) return
  busyAction = true; document.body?.classList?.add('busy')
  try {
    const r = await fetch(url, { method:'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ title: title.trim() }) })
    note(await noteOf(r))
  } catch (e) { note('실패: ' + e) } finally { busyAction = false; document.body?.classList?.remove('busy'); refresh() }
}
async function renameSession(pid, current) { return rename('/api/session/' + pid + '/rename', current) }
async function renameArchive(path, current) {
  const title = prompt('새 이름', current)
  if (title === null || !title.trim() || title.trim() === current) return
  busyAction = true; document.body?.classList?.add('busy')
  try {
    const r = await fetch('/api/archive/rename', { method:'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ path, title: title.trim() }) })
    note(await noteOf(r))
  } catch (e) { note('실패: ' + e) } finally { busyAction = false; document.body?.classList?.remove('busy'); refresh() }
}
async function resumeSession(id) {
  busyAction = true; document.body?.classList?.add('busy')
  try {
    const r = await fetch('/api/session/resume', { method:'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ id }) })
    note(await noteOf(r))
  } catch (e) { note('실패: ' + e) } finally { busyAction = false; document.body?.classList?.remove('busy'); refresh() }
}
async function delRecent(id, title) {
  if (!confirm('대화 "' + title + '" 을(를) 완전히 삭제할까요? Claude Code 에 저장된 이 대화 파일이 지워져서 더 이상 이어서 할 수 없고, 되돌릴 수 없습니다.')) return
  busyAction = true; document.body?.classList?.add('busy')
  try {
    const r = await fetch('/api/recent/delete', { method:'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ id }) })
    note(await noteOf(r))
  } catch (e) { note('실패: ' + e) } finally { busyAction = false; document.body?.classList?.remove('busy'); refresh() }
}
async function delArchive(path, title) {
  if (!confirm('보관 기록 "' + title + '" 을(를) 완전히 삭제할까요? 되돌릴 수 없습니다.')) return
  busyAction = true; document.body?.classList?.add('busy')
  try {
    const r = await fetch('/api/archive/delete', { method:'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ path }) })
    note(await noteOf(r))
  } catch (e) { note('실패: ' + e) } finally { busyAction = false; document.body?.classList?.remove('busy'); refresh() }
}
window.act = act; window.closePanel = closePanel; window.openLink = openLink; window.showOrphan = showOrphan; window.delRecent = delRecent; window.resumeSession = resumeSession; window.renameSession = renameSession; window.renameArchive = renameArchive; window.delArchive = delArchive; window.showArchive = showArchive; window.showScreen = showScreen; window.newSession = newSession

// ---- one table for every group, with tabs, search and sorting
let lastState = null
let pinned = new Set()
let tab = 'all'
let query = ''
let sortKey = 'time'
let sortDir = -1
let drewShell = false
const TABS = [['all', '전체'], ['live', '실행 중'], ['recent', '이어서'], ['archive', '보관'], ['orphan', '잔재']]
const GROUP_ORDER = { live: 0, recent: 1, archive: 2, orphan: 3 }
const KIND = { ended: ['끊김', 'ended'], dormant: ['대기', 'wait'], unknown: ['미확인', 'ended'] }
const COLUMNS = [['group', '상태'], ['name', '이름'], ['preview', '첫 메시지'], ['cwd', '폴더'], ['model', '모델'], ['messages', '대화'], ['time', '시각'], ['', '']]
const base = (p) => String(p ?? '').split('/').filter(Boolean).pop() || String(p ?? '')
const stamp = (ms) => {
  const m = Math.round((Date.now() - ms) / 60000)
  if (m < 1) return '방금'
  if (m < 60) return m + '분 전'
  const h = Math.floor(m / 60)
  if (h < 24) return h + '시간 전'
  return Math.floor(h / 24) + '일 전'
}

function saveView() {
  try { localStorage.setItem('claude-slack-admin', JSON.stringify({ tab, query, sortKey, sortDir })) } catch {}
}
function loadView() {
  try {
    const v = JSON.parse(localStorage.getItem('claude-slack-admin') || '{}')
    if (TABS.some((t) => t[0] === v.tab)) tab = v.tab
    if (typeof v.query === 'string') query = v.query
    if (COLUMNS.some((c) => c[0] && c[0] === v.sortKey)) sortKey = v.sortKey
    if (v.sortDir === 1 || v.sortDir === -1) sortDir = v.sortDir
  } catch {}
}

// A pin names a conversation: the session id when there is one, so it follows the session from running to archived.
const pinKeyOf = (group, x) => group === 'live' ? (x.sessionId ? 's:' + x.sessionId : 'k:' + x.key) : group === 'recent' ? 's:' + x.id : group === 'archive' ? (x.sessionId ? 's:' + x.sessionId : 'a:' + x.path) : 't:' + x.ts
function toRows(s) {
  const rows = []
  for (const x of s.live) rows.push({ group: 'live', name: x.title || base(x.cwd), preview: x.preview, cwd: x.cwd, model: x.model, messages: x.messages, time: x.startedAt, status: x.busy ? '작업 중' : x.state === 'waiting' ? '입력 대기' : '대기', dot: DOT[x.state] ?? 'idle', src: x })
  for (const r of s.recent) rows.push({ group: 'recent', name: r.title, preview: r.preview, cwd: r.cwd, messages: r.messages, time: r.mtime, status: '이어서', src: r })
  for (const a of s.archives) rows.push({ group: 'archive', name: a.title, preview: a.preview, cwd: a.cwd, messages: a.messages, time: Date.parse(a.archivedAt) || 0, status: '보관', src: a })
  for (const o of orphans ?? []) rows.push({ group: 'orphan', name: o.title || '(제목 없음)', preview: o.replies ? '답글 ' + o.replies + '개' : '답글 없음', cwd: '', messages: o.replies, time: o.at, status: KIND[o.kind][0], dot: KIND[o.kind][1], src: o })
  for (const r of rows) r.pin = pinKeyOf(r.group, r.src)
  return rows
}

// The buttons of a row, in one fixed order for every group. One that does not apply is greyed out with the reason.
function actionsOf(r) {
  const x = r.src
  const o = { delLabel: '삭제' }
  if (r.group === 'live') {
    const dir = esc(base(x.cwd))
    o.delLabel = '스레드 삭제'
    o.thread = x.threadTs && ("openLink('" + (x.link ? esc(x.link) : '/go/thread?ts=' + encodeURIComponent(x.threadTs)) + "')")
    o.screen = (x.canScreen || x.window) && ("showScreen(" + x.pid + ",'" + dir + "')")
    o.log = x.threadTs && ("showOrphan('" + esc(x.threadTs) + "')")
    o.rename = "renameSession(" + x.pid + ",'" + esc(x.title ?? base(x.cwd)) + "')"
    o.kill = "act(" + x.pid + ",'kill','세션 종료')"
    o.del = "act(" + x.pid + ",'purge','세션을 종료하고 Slack 스레드를 삭제(대화는 보관됨)')"
  } else if (r.group === 'orphan') {
    o.threadWhy = 'Slack 스레드 링크를 만들지 못했습니다'
    o.thread = x.ts && ("openLink('/go/thread?ts=" + encodeURIComponent(x.ts) + "')")
    o.log = "showOrphan('" + esc(x.ts) + "')"
    o.delLabel = '스레드 정리'
    o.resume = x.sessionId && ("resumeOrphan('" + esc(x.ts) + "')")
    o.resumeWhy = '이어서 할 대화 정보가 없는 스레드입니다'
    o.del = "purgeOrphan('" + esc(x.ts) + "','" + esc(plain(r.name)) + "')"
  } else if (r.group === 'recent') {
    o.threadWhy = '이어서 하기를 누르면 새 스레드가 생깁니다'
    o.resume = "resumeSession('" + esc(x.id) + "')"
    o.del = "delRecent('" + esc(x.id) + "','" + esc(x.title) + "')"
  } else {
    o.threadWhy = '보관될 때 Slack 스레드는 지워졌습니다'
    o.log = "showArchive('" + esc(x.path) + "','" + esc(x.title) + "')"
    o.resume = "resumeSession('" + esc(x.sessionId) + "')"
    o.rename = "renameArchive('" + esc(x.path) + "','" + esc(x.title) + "')"
    o.del = "delArchive('" + esc(x.path) + "','" + esc(x.title) + "')"
  }
  const items = [
    ['thread', '스레드 열기', o.thread, o.threadWhy || '열 Slack 스레드가 없습니다'],
    ['screen', '화면', o.screen, '실행 중인 tmux 세션만 볼 수 있습니다'],
    ['log', '기록 보기', o.log, '이 항목에는 볼 기록이 없습니다'],
    ['resume', '이어서 하기', o.resume, o.resumeWhy || '이미 실행 중입니다'],
    ['rename', '이름 변경', o.rename, '이름을 저장할 곳이 없습니다. 이어서 하기로 연 뒤 바꾸세요.'],
    ['pin', pinned.has(r.pin) ? '고정 해제' : '상단에 고정', "togglePin('" + esc(r.pin) + "')", ''],
    ['kill', '세션 종료', o.kill, '실행 중인 세션만 종료할 수 있습니다', true],
    ['del', o.delLabel, o.del, '지울 스레드나 기록이 없습니다', true],
  ]
  // The one button worth a click for this group stands in front; everything else is in the menu.
  const primary = r.group === 'live' ? 'thread' : r.group === 'orphan' ? 'del' : 'resume'
  const main = items.find((i) => i[0] === primary)
  const rest = items.filter((i) => i[0] !== primary)
  return '<div class="cell-actions">' + btn(main[1], main[2], main[3], main[4]) +
    '<details class="menu"><summary title="더 보기">⋯</summary><div class="menu-list">' + rest.map((i) => btn(i[1], i[2], i[3], i[4])).join('') + '</div></details></div>'
}

function compare(a, b) {
  // Pinned rows stay on top whatever the sort is.
  if (pinned.has(a.pin) !== pinned.has(b.pin)) return pinned.has(a.pin) ? -1 : 1
  let d
  if (sortKey === 'time') d = a.time - b.time
  else if (sortKey === 'group') d = GROUP_ORDER[a.group] - GROUP_ORDER[b.group]
  else d = String(a[sortKey] ?? '').localeCompare(String(b[sortKey] ?? ''), 'ko')
  return d * sortDir || b.time - a.time
}
function visibleRows() {
  const needle = query.trim().toLowerCase()
  return toRows(lastState)
    .filter((r) => (tab === 'all' ? r.group !== 'orphan' : r.group === tab) && (!needle || [plain(r.name), plain(r.preview), r.cwd, r.model].some((v) => String(v ?? '').toLowerCase().includes(needle))))
    .sort(compare)
}

function drawTabs() {
  const n = { all: lastState.live.length + lastState.recent.length + lastState.archives.length, live: lastState.live.length, recent: lastState.recent.length, archive: lastState.archives.length, orphan: orphans ? orphans.length : '…' }
  $('tabs').innerHTML = TABS.map((t) => '<button class="' + (tab === t[0] ? 'on' : '') + '" onclick="setTab(\\'' + t[0] + '\\')">' + t[1] + '<span>' + n[t[0]] + '</span></button>').join('')
}
function drawBulk() {
  const cleanable = (orphans ?? []).filter((o) => o.kind !== 'dormant').length
  $('bulk').innerHTML = tab === 'orphan'
    ? '<div class="bulk"><span class="dim">세션과 연결이 끊겼거나 기록이 없는 Slack 스레드입니다. 정리하면 대화는 서버에 보관되고 Slack 메시지는 지워집니다. 대기 중(되살릴 수 있는) 스레드는 하나씩만 정리합니다.</span>' +
      btn('끊긴 스레드 모두 정리 (' + cleanable + ')', cleanable ? 'purgeAllOrphans()' : '', '정리할 잔재 스레드가 없습니다', true) +
      btn('다시 찾기', 'loadOrphans(true)', '') + '</div>'
    : ''
}
function drawList() {
  const rows = visibleRows()
  if (!rows.length) { $('list').innerHTML = '<div class="empty">' + (query.trim() ? '검색 결과가 없습니다.' : tab === 'orphan' ? (orphans ? '정리할 잔재 스레드가 없습니다. 🎉' : '잔재 스레드를 찾는 중…') : '표시할 항목이 없습니다.') + '</div>'; return }
  const head = COLUMNS.map((c) => c[0]
    ? '<th class="sortable" onclick="setSort(\\'' + c[0] + '\\')">' + c[1] + (sortKey === c[0] ? (sortDir < 0 ? ' ▼' : ' ▲') : '') + '</th>'
    : '<th></th>').join('')
  const body = rows.slice(0, 300).map((r) =>
    '<tr data-group="' + r.group + '"' + (pinned.has(r.pin) ? ' class="pinned"' : '') + '>' +
    '<td class="c-status" data-label="상태"><span class="badge">' + (r.dot ? '<span class="dot ' + r.dot + '"></span>' : '') + esc(r.status) + '</span></td>' +
    '<td class="name c-name"><button class="pin' + (pinned.has(r.pin) ? ' on' : '') + '" title="' + (pinned.has(r.pin) ? '상단 고정 해제' : '상단에 고정') + '" aria-pressed="' + pinned.has(r.pin) + '" onclick="togglePin(\\'' + esc(r.pin) + '\\')">📌</button>' + esc(plain(r.name)) + '</td>' +
    '<td class="c-preview' + (r.preview ? '' : ' none') + '">' + (r.preview ? '<div class="snippet">' + esc(plain(r.preview)) + '</div>' : '<span class="dim">–</span>') + '</td>' +
    '<td class="dim nowrap c-folder' + (r.cwd ? '' : ' none') + '" data-label="폴더" title="' + esc(r.cwd) + '">' + esc(base(r.cwd)) + '</td>' +
    '<td class="dim nowrap c-model' + (r.model ? '' : ' none') + '" data-label="모델">' + (r.model ? esc(r.model) : '–') + '</td>' +
    '<td class="dim nowrap c-messages' + (r.messages == null ? ' none' : '') + '" data-label="대화" title="주고받은 대화(내가 보낸 메시지) 수">' + (r.messages == null ? '–' : '💬 ' + r.messages) + '</td>' +
    '<td class="dim c-time" data-label="시각">' + esc(stamp(r.time)) + '</td>' +
    '<td class="c-actions">' + actionsOf(r) + '</td></tr>').join('')
  $('list').innerHTML = '<table class="grid"><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table>'
}
// A menu is closed by a click anywhere else, by Esc, and by choosing an item in it; opening one closes the others.
function closeMenus(except) {
  for (const d of document.querySelectorAll?.('details.menu[open]') ?? []) if (d !== except) d.removeAttribute('open')
}
document.addEventListener?.('click', (e) => {
  const inside = e.target.closest?.('details.menu')
  closeMenus(inside)
  if (inside && e.target.closest('.menu-list button')) inside.removeAttribute('open')
  // the dimmed backdrop is the menu's own ::before, so a tap on it lands on the menu element itself
  if (inside && e.target === inside) inside.removeAttribute('open')
})
document.addEventListener?.('keydown', (e) => { if (e.key === 'Escape') { closeMenus(); if (!$('panel').hidden) closePanel() } })
// the toggle event does not bubble, so listen while it travels down. A menu near the bottom of the window opens upwards.
document.addEventListener?.('toggle', (e) => {
  const d = e.target
  if (!d.open || !d.classList?.contains('menu')) return
  const list = d.querySelector('.menu-list')
  list.classList.remove('up')
  if (list.getBoundingClientRect().bottom > window.innerHeight - 8) list.classList.add('up')
}, true)
function redraw() {
  if (!lastState) return
  drawTabs(); drawBulk(); drawList()
  // The table head sticks right under the tab bar, whatever height the bar has (it wraps on a phone).
  const bar = document.querySelector?.('.bar')
  // Overlap by two pixels: the bar is drawn above the head, so no sliver of the rows scrolling by shows in between.
  if (bar) document.documentElement.style.setProperty('--bar-h', Math.ceil(bar.getBoundingClientRect().height) - 2 + 'px')
}
let orphans = null
let orphansAt = 0
let orphansBusy = false
async function loadOrphans(force) {
  if (orphansBusy) return
  orphansBusy = true
  try {
    const r = await fetch('/api/orphans' + (force ? '?force=1' : ''), { headers: auth })
    if (r.ok) { orphans = (await r.json()).orphans; orphansAt = Date.now() }
  } catch {} finally { orphansBusy = false }
  redraw()
}
async function purgeOrphan(ts, title) {
  if (!confirm('"' + title + '" 스레드를 정리할까요? 대화는 서버에 보관되고(보관됨 탭), Slack 메시지는 지워집니다. 메시지가 많으면 몇 분 걸립니다.')) return
  busyAction = true; document.body?.classList?.add('busy')
  try {
    const r = await fetch('/api/orphan/purge', { method:'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ ts }) })
    note(await noteOf(r), 12000)
  } catch (e) { note('실패: ' + e) } finally { busyAction = false; document.body?.classList?.remove('busy'); setTimeout(() => loadOrphans(true), 1500) }
}
async function resumeOrphan(ts) {
  busyAction = true; document.body?.classList?.add('busy')
  try {
    const r = await fetch('/api/orphan/resume', { method:'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ ts }) })
    note(await noteOf(r), 10000)
  } catch (e) { note('실패: ' + e) } finally { busyAction = false; document.body?.classList?.remove('busy'); setTimeout(() => loadOrphans(true), 1500) }
}
async function purgeAllOrphans() {
  const n = (orphans ?? []).filter((o) => o.kind !== 'dormant').length
  if (!confirm('세션이 끊겼거나 기록이 없는 스레드 ' + n + '개를 모두 정리할까요? 대화는 서버에 보관되고 Slack 메시지는 지워집니다. 차례로 진행되어 몇 분 걸릴 수 있습니다.')) return
  busyAction = true; document.body?.classList?.add('busy')
  try {
    const r = await fetch('/api/orphans/purge', { method:'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{}' })
    note(await noteOf(r), 12000)
  } catch (e) { note('실패: ' + e) } finally { busyAction = false; document.body?.classList?.remove('busy'); setTimeout(() => loadOrphans(true), 1500) }
}
window.resumeOrphan = resumeOrphan; window.loadOrphans = loadOrphans; window.purgeOrphan = purgeOrphan; window.purgeAllOrphans = purgeAllOrphans
async function togglePin(key) {
  const want = !pinned.has(key)
  if (want) pinned.add(key); else pinned.delete(key)
  redraw()
  try {
    const r = await fetch('/api/pin', { method:'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ key, pinned: want }) })
    if (!r.ok) throw new Error(await noteOf(r))
  } catch (e) {
    if (want) pinned.delete(key); else pinned.add(key)
    redraw()
    note('고정하지 못했습니다: ' + (e.message ?? e))
  }
}
window.togglePin = togglePin
function setTab(t) { tab = t; saveView(); redraw(); if (t === 'orphan') loadOrphans(true) }
function setQuery(v) { query = v; saveView(); redraw() }
function setSort(k) { if (sortKey === k) sortDir = -sortDir; else { sortKey = k; sortDir = k === 'time' ? -1 : 1 } saveView(); redraw() }
window.setTab = setTab; window.setQuery = setQuery; window.setSort = setSort

function render(s) {
  lastState = s
  pinned = new Set(s.pins ?? [])
  $('sub').textContent = '실행 중 ' + s.live.length + '개 · 이어서 ' + s.recent.length + '개 · 보관 ' + s.archives.length + '개'
  if (!drewShell) {
    // Drawn once: refreshing every few seconds must not wipe what is being typed.
    loadView()
    $('q').value = query
    $('form').innerHTML = '<div class="card"><div class="row"><input id="new-cwd" placeholder="폴더 (비우면 기본)" style="flex:1;min-width:200px;font:inherit;padding:7px 10px;border-radius:8px;border:1px solid var(--line);background:#0f1115;color:var(--fg)"></div><div class="row" style="margin-top:8px"><input id="new-prompt" placeholder="첫 프롬프트 (선택)" style="flex:1;min-width:200px;font:inherit;padding:7px 10px;border-radius:8px;border:1px solid var(--line);background:#0f1115;color:var(--fg)"><button onclick="newSession()">🆕 새 세션</button></div></div>'
    drewShell = true
    loadOrphans(false)
  }
  if (tab === 'orphan' && Date.now() - orphansAt > 30000) loadOrphans(true)
  redraw()
}

let lostAt = 0
async function refresh() {
  if (busyAction) return
  if (document.querySelector?.('details.menu[open]')) return
  try {
    const r = await fetch('/api/state', { headers: auth })
    if (r.status === 401) { $('sub').textContent = '토큰이 필요합니다. 주소에 ?t=... 를 붙이세요.'; return }
    if (!r.ok) throw new Error('HTTP ' + r.status)
    const state = await r.json()
    lostAt = 0
    // A menu opened while this answer was on its way must not be redrawn out from under the finger.
    if (busyAction || document.querySelector?.('details.menu[open]')) return
    render(state)
  } catch (e) {
    // The broker is restarting for a few seconds. Keep what is on screen and reconnect by itself.
    lostAt = lostAt || Date.now()
    const secs = Math.round((Date.now() - lostAt) / 1000)
    $('sub').textContent = secs < 120 ? '브로커가 다시 시작되는 중입니다… 자동으로 다시 연결합니다 (' + secs + '초)' : '브로커에 연결하지 못했습니다: ' + e
  }
}
const initial = /*INITIAL_STATE*/null
if (initial) render(initial)
refresh()
setInterval(refresh, 4000)
</script>
</html>`

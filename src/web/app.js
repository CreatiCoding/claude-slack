// The web app: the same sessions as the Slack threads, driven through the broker that serves this page.
// Server → page: one EventSource (/api/stream) with the session list and every session event.
// Page → server: plain POSTs. Buttons on broker cards post their Slack action, so a press here runs
// exactly what a click in Slack runs.
import { esc, linkify, md, mrkdwn } from './markdown.js'
import { icon, takeEmoji, toolIcon } from './icons.js'
import { getImage, loadTimeline, putImage, saveTimeline } from './idb.js'
import { qrSvg } from './qr.js'

const $ = (id) => document.getElementById(id)
const params = new URLSearchParams(location.search)
const token = params.get('t') || ''
const authHeaders = token ? { 'x-admin-token': token } : {}
const withToken = (path) => (token ? path + (path.includes('?') ? '&' : '?') + 't=' + encodeURIComponent(token) : path)
const narrow = matchMedia('(max-width: 899px)')
const isPhone = () => narrow.matches
// Enter sends only where there is a mouse; a phone keyboard's Enter is a newline.
const hasMouse = matchMedia('(hover: hover) and (pointer: fine)').matches
const isMac = /Mac|iPhone|iPad/.test(navigator.platform)

const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem(k)
      return v === null ? d : JSON.parse(v)
    } catch {
      return d
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v))
    } catch {}
  },
  del(k) {
    try {
      localStorage.removeItem(k)
    } catch {}
  },
}

// Static icons in the frame.
$('btn-back').innerHTML = icon('back')
$('btn-collapse').innerHTML = icon('sidebar')
$('btn-more').innerHTML = icon('more')
$('btn-new').innerHTML = `${icon('plus')}<span>새 세션</span>`
$('btn-send').innerHTML = icon('up')
$('btn-attach').innerHTML = icon('attach')
$('jump').firstElementChild.innerHTML = `${icon('chevron', 'down')}새 메시지`

// ------------------------------------------------------------------ state
let sessions = []
let groups = store.get('groups-cache', { groups: [], loose: [] })
let recent = []
let notices = []
let archives = []
let options = { models: [], efforts: [], modes: [] }
/** thread → { events: [], last: 0, loading } */
const threads = new Map()
let current = null // thread ts
const seen = store.get('seen', {})
const folded = store.get('folded', {}) // every section opens by default (47)

function thread(ts) {
  let t = threads.get(ts)
  // `buf`: events that arrived over SSE while a catch-up (GET) for this thread was in flight. The two
  // requests race, so an event from after the GET's snapshot can land before the GET's response does;
  // dropping it (the old behavior) could leave a turn's last `text`/`turn_end` missing until the next
  // event happened to arrive. Buffered here instead, and applied once the catch-up finishes.
  if (!t) threads.set(ts, (t = { events: [], last: 0, loading: null, buf: [] }))
  return t
}
const sessionOf = (ts) => sessions.find((s) => s.thread === ts)

/**
 * GET and POST to the broker. When the broker is away (restart, deploy) the proxy in front answers 502/503/504:
 * the command never reached it, so it waits and is sent once the broker is back (within a minute). A network
 * error is different: it may have arrived, and sending it again could run it twice, so it is only reported.
 */
const AWAY = new Set([502, 503, 504])
const waitingCommands = []
// A command that gets no answer in 30 s fails with 응답이 없어요, not a spinner that never stops (40). Sends are
// left out: a send that timed out may still have reached Claude, so it says 전달됐는지 확인할 수 없어요 instead.
const COMMAND_TIMEOUT_MS = 30_000
async function api(path, body, { timeout = body !== undefined } = {}) {
  let r
  const ac = new AbortController()
  const timer = timeout ? setTimeout(() => ac.abort(), COMMAND_TIMEOUT_MS) : null
  try {
    r = await fetch(withToken(path), body === undefined ? { headers: authHeaders } : { method: 'POST', headers: { ...authHeaders, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ac.signal })
  } catch {
    clearTimeout(timer)
    if (ac.signal.aborted) throw new Error('응답이 없어요')
    throw new Error(body === undefined ? '연결할 수 없어요' : '전달됐는지 확인할 수 없어요. 대화를 보고 필요하면 다시 보내 주세요')
  }
  if (AWAY.has(r.status) && body !== undefined) {
    clearTimeout(timer)
    brokerAway()
    return new Promise((resolve, reject) => {
      const job = { path, body, resolve, reject, until: Date.now() + 60_000 }
      waitingCommands.push(job)
    })
  }
  let data = {}
  try {
    data = await r.json()
  } catch {} finally {
    clearTimeout(timer)
  }
  if (!r.ok) throw Object.assign(new Error(data.note || data.error || `HTTP ${r.status}`), { data })
  return data
}
/** The broker is back: send what it refused while away, in order, once each. */
async function flushWaiting() {
  while (waitingCommands.length) {
    const job = waitingCommands[0]
    if (Date.now() > job.until) {
      waitingCommands.shift()
      job.reject(new Error('브로커가 돌아오지 않아 보내지 못했어요'))
      continue
    }
    let r
    try {
      r = await fetch(withToken(job.path), { method: 'POST', headers: { ...authHeaders, 'content-type': 'application/json' }, body: JSON.stringify(job.body) })
    } catch {
      return // still unreachable: try again on the next tick
    }
    if (AWAY.has(r.status)) return
    waitingCommands.shift()
    let data = {}
    try {
      data = await r.json()
    } catch {}
    r.ok ? job.resolve(data) : job.reject(new Error(data.note || data.error || `HTTP ${r.status}`))
  }
}
setInterval(() => waitingCommands.length && flushWaiting(), 3000)

function toast(text, kind = 'ok', ms = 2600) {
  const el = $('toast')
  el.innerHTML = `${icon(kind === 'ok' ? 'check' : 'alert')}<span></span>`
  el.lastElementChild.textContent = text
  el.hidden = false
  clearTimeout(toast.t)
  toast.t = setTimeout(() => (el.hidden = true), ms)
}

// ------------------------------------------------------------------ screen errors
// What went wrong on this screen goes to the broker's log (web-client.log), not only to a toast nobody reads
// on a phone. The same error is sent once a minute at most.
const reported = new Map()
/** At most 20 a minute from this page, whatever they are: a loop of different errors must not flood the broker. */
const reportTimes = []
/**
 * Queued in localStorage first, not sent straight off (21): an error while offline — the exact moment one
 * is more likely — used to just drop silently (the `fetch` failing is caught and ignored). Up to 50 wait
 * here; `flushErrorQueue` sends what it can whenever the connection looks like it might be back.
 */
const ERR_QUEUE_KEY = 'errq'
function queueError(entry) {
  const q = store.get(ERR_QUEUE_KEY, [])
  q.push(entry)
  store.set(ERR_QUEUE_KEY, q.slice(-50))
}
// Guards re-entry: `reportError` calls this on every new error with no await, so a burst (a loop of
// distinct errors, say) used to start one overlapping flush per error — each reading/writing `errq` off
// its own stale snapshot, racing each other into losing or duplicating entries.
let flushingErrors = false
async function flushErrorQueue() {
  if (flushingErrors) return
  flushingErrors = true
  try {
    for (;;) {
      const q = store.get(ERR_QUEUE_KEY, [])
      if (!q.length) return
      try {
        const r = await fetch(withToken('/api/client-error'), { method: 'POST', headers: { ...authHeaders, 'content-type': 'application/json' }, body: JSON.stringify(q[0]) })
        if (!r.ok) return // rejected (rate limit, say) — leave the queue as-is for the next trigger
      } catch {
        return // offline — leave the queue as-is
      }
      // Sent: drop exactly that one off the front of the *current* queue (re-read, not the `q` above —
      // another tab, or this one mid-await, may have queued more since).
      store.set(ERR_QUEUE_KEY, store.get(ERR_QUEUE_KEY, []).slice(1))
    }
  } finally {
    flushingErrors = false
  }
}
function reportError(where, err) {
  const message = String(err?.message ?? err ?? '알 수 없는 오류').slice(0, 500)
  const key = where + '|' + message
  const now = Date.now()
  if (now - (reported.get(key) ?? 0) < 60_000) return
  while (reportTimes.length && now - reportTimes[0] > 60_000) reportTimes.shift()
  if (reportTimes.length >= 20) return
  reportTimes.push(now)
  reported.set(key, now)
  if (reported.size > 200) reported.delete(reported.keys().next().value)
  queueError({ where, message, stack: String(err?.stack ?? '').slice(0, 4000), view: isPhone() ? 'phone' : 'pc', url: location.pathname + location.hash, ua: navigator.userAgent.slice(0, 200) })
  flushErrorQueue()
}
addEventListener('error', (e) => reportError('window', e.error ?? e.message))
addEventListener('unhandledrejection', (e) => reportError('promise', e.reason))
addEventListener('online', () => flushErrorQueue())

/**
 * A heartbeat written every 5,000 ms and cleared on a clean `pagehide` (21): if one is still there when
 * the page opens again, nothing cleared it last time — a crash or a forced-closed tab, not a normal close
 * or reload (those fire `pagehide`). Reported once, the same way a caught error is.
 */
const HEARTBEAT_KEY = 'heartbeat'
if (store.get(HEARTBEAT_KEY, null)) {
  queueError({ where: 'crash', message: '지난번에 정리되지 않고 끝났어요(하트비트가 남아 있었어요)', view: isPhone() ? 'phone' : 'pc', url: location.pathname + location.hash, ua: navigator.userAgent.slice(0, 200) })
  flushErrorQueue()
}
setInterval(() => store.set(HEARTBEAT_KEY, Date.now()), 5000)
setInterval(() => flushErrorQueue(), 60_000) // a safety net in case 'online' never fires (some proxies, some phones)
addEventListener('pagehide', () => store.del(HEARTBEAT_KEY))

// ------------------------------------------------------------------ measurement
// Once a minute the page tells the broker what it received and what showing it cost, for the log.
const metrics = { recvBytes: 0, recvEvents: 0, apply: { n: 0, sum: 0, max: 0 }, catchups: [], stalls: { n: 0, max: 0 } }
const tabId = Math.random().toString(36).slice(2, 8)
function noteApply(ms) {
  metrics.apply.n++
  metrics.apply.sum += ms
  metrics.apply.max = Math.max(metrics.apply.max, ms)
}
// A timer that fires 200ms late means the main thread was blocked that long.
;(() => {
  let expect = performance.now() + 100
  setInterval(() => {
    const late = performance.now() - expect
    expect = performance.now() + 100
    if (late > 200 && document.visibilityState === 'visible') {
      metrics.stalls.n++
      metrics.stalls.max = Math.max(metrics.stalls.max, Math.round(late))
    }
  }, 100)
})()
setInterval(() => {
  if (!metrics.recvEvents && !metrics.apply.n && !metrics.catchups.length && !metrics.stalls.n) return
  const body = { tab: tabId, view: isPhone() ? 'phone' : 'pc', ...metrics, dom: document.getElementsByTagName('*').length }
  metrics.recvBytes = metrics.recvEvents = 0
  metrics.apply = { n: 0, sum: 0, max: 0 }
  metrics.catchups = []
  metrics.stalls = { n: 0, max: 0 }
  api('/api/metrics', body).catch(() => {})
}, 60_000)

// ------------------------------------------------------------------ theme
function applyTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t
  else delete document.documentElement.dataset.theme
  store.set('theme', t)
  // iOS takes the bar colour and the keyboard's look from these, so they follow a theme picked in the menu too.
  for (const m of document.querySelectorAll('meta[name="theme-color"]')) {
    if (t === 'auto') m.content = m.media.includes('dark') ? '#1f1e1d' : '#f3f1ea'
    else m.content = t === 'dark' ? '#1f1e1d' : '#f3f1ea'
  }
  document.querySelector('meta[name="color-scheme"]').content = t === 'auto' ? 'light dark' : t
}
applyTheme(store.get('theme', 'auto'))

// ------------------------------------------------------------------ live connection
let es = null
let connected = false
// A short gap is not worth a red line: say "끊겼어요" only after 8s, or 30s while the broker is restarting.
let lostAt = 0
let restarting = false
function brokerAway() {
  restarting = true
}
let connId = null
let phoneAccess = true // from the broker's hello (60)
let webHash = null // this load's baseline (21); a later `hello` with a different one means new code is up
let newVersionSeen = false
async function subscribe(ts) {
  if (!connId) return
  try {
    await api('/api/subscribe', { conn: connId, thread: ts })
  } catch {
    connect() // the broker does not know this stream any more: a fresh one says hello again
  }
}
function connect() {
  if (!lostAt && !connected) lostAt = Date.now()
  if (es) es.close()
  es = new EventSource(withToken('/api/stream'))
  // Each listener on its own: one frame that fails (a parse, a draw) is recorded and the rest keep coming.
  const on = (name, fn) =>
    es.addEventListener(name, (e) => {
      try {
        fn(e)
      } catch (err) {
        reportError(`sse:${name}`, err)
      }
    })
  on('open', () => {
    connected = true
    lostAt = 0
    restarting = false
    renderConn()
    flushWaiting()
  })
  // Each stream has an id; the page tells the broker which thread it shows, and only that thread's events come.
  on('hello', (e) => {
    const hello = JSON.parse(e.data)
    connId = hello.conn
    // The broker says whether a phone can reach it (60): the setting decides, not where this page was opened.
    if (hello.caps) phoneAccess = !!hello.caps.phoneAccess
    // The broker restarting with new code (21): a tab open from before has no reason to notice on its
    // own otherwise. First value seen this load is the baseline — a later, different one is the new code.
    if (hello.webHash) {
      if (!webHash) webHash = hello.webHash
      else if (hello.webHash !== webHash && !newVersionSeen) {
        newVersionSeen = true
        $('btn-more').classList.add('dot')
      }
    }
    if (current) subscribe(current).then(() => catchUp(current))
  })
  on('error', () => {
    if (connected || !lostAt) lostAt = Date.now()
    connected = false
    renderConn()
    // Is it the broker that is gone (the proxy answers) or the network? The first is a restart.
    fetch(withToken('/api/options'), { headers: authHeaders }).then((r) => AWAY.has(r.status) && brokerAway(), () => {})
  })
  on('sessions', (e) => {
    metrics.recvBytes += e.data.length
    metrics.recvEvents++
    applySessions(JSON.parse(e.data))
  })
  on('groups', (e) => {
    groups = JSON.parse(e.data)
    store.set('groups-cache', groups)
    renderList()
  })
  on('notices', (e) => {
    notices = JSON.parse(e.data)
    renderNotices()
  })
  // After the first full list, only the sessions that changed, with the order as thread keys. One that cannot be
  // read leaves this page out of step with what the server thinks it has: start over (a new stream sends it all).
  es.addEventListener('sessions_delta', (e) => {
    let delta
    try {
      delta = JSON.parse(e.data)
    } catch (err) {
      reportError('sse:sessions_delta', err)
      return void connect()
    }
    try {
      applyDelta(delta, e.data.length)
    } catch (err) {
      reportError('sse:sessions_delta', err)
    }
  })
  const applyDelta = ({ order, changed }, bytes) => {
    metrics.recvBytes += bytes
    metrics.recvEvents++
    const by = new Map(sessions.map((s) => [s.thread, s]))
    for (const s of changed) by.set(s.thread, s)
    applySessions(order.map((k) => by.get(k)).filter(Boolean))
  }
  // What is being written right now (not stored): the activity box shows it as markdown, growing as it comes
  // in (15). `text` with `from`: grew — append. `text` alone, no `from`: either the first chunk, or the
  // block changed shape (a thinking pause broke it up) — replace. `thinking`: busy, no block on screen right
  // now; keep showing what's there and let the "생각 중 · n초" line (renderActivity) carry the wait.
  on('live', (e) => {
    const { thread: ts, text, from, thinking } = JSON.parse(e.data)
    if (ts !== current || !view) return
    if (thinking) {
      view.thinkingAt ??= Date.now()
      renderActivity()
      return
    }
    view.thinkingAt = null
    if (from !== undefined && view.live && from === view.live.length) view.live += text
    else view.live = text
    if (!view.live) view.liveAt = null
    else view.liveAt ??= Date.now()
    renderActivity()
  })
  on('ev', (e) => {
    metrics.recvBytes += e.data.length
    metrics.recvEvents++
    const { thread: ts, ev } = JSON.parse(e.data)
    if (ts !== current) return // switched away a moment ago; its catch-up covers it next time
    const t = thread(ts)
    if (t.loading) return void t.buf.push(ev) // applied once the catch-up it raced finishes (14)
    if (ev.seq <= t.last) return
    if (ev.seq !== t.last + 1) return void catchUp(ts)
    addEvents(ts, [ev], { live: true })
  })
}
function applySessions(list) {
  sessions = list
  store.set('sessions-cache', list)
  queueMicrotask(checkPermissionModal)
  for (const s of sessions) if (!(s.thread in seen)) seen[s.thread] = s.lastSeq // a session seen for the first time counts as read
  store.set('seen', seen)
  renderList()
  renderHeader()
  renderComposerBits()
  renderActivity()
}
// A tab nobody looks at should not keep receiving: after 30s hidden the stream closes, and showing the
// tab opens it again and catches up from the last event it has.
const HIDDEN_CLOSE_MS = Number(params.get('hiddenMs')) || 30_000
let hiddenTimer = null
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') {
    hiddenTimer = setTimeout(() => {
      hiddenTimer = null
      es?.close()
      es = null
      connId = null
      connected = false
    }, HIDDEN_CLOSE_MS)
    return
  }
  if (hiddenTimer) clearTimeout(hiddenTimer), (hiddenTimer = null)
  if (!es || es.readyState === EventSource.CLOSED || !connected) connect()
  else if (current) catchUp(current)
})
addEventListener('online', () => connect())
// The phone keyboard covers the home-indicator safe area itself, so the composer's own bottom padding for
// it (`env(safe-area-inset-bottom)`) would otherwise leave a blank strip between the input and the keyboard
// (20). `visualViewport` shrinking by more than 150px (a keyboard, not just a browser chrome sliver) zeroes it.
if (visualViewport) {
  let maxHeight = visualViewport.height // the keyboard-closed height; a rotation or the browser chrome
  // showing/hiding also resizes this, so the baseline tracks the largest seen rather than only the first.
  visualViewport.addEventListener('resize', () => {
    maxHeight = Math.max(maxHeight, visualViewport.height)
    document.documentElement.classList.toggle('kbd-open', maxHeight - visualViewport.height > 150)
  })
}
/** The empty right pane: how to start the broker when it is off (only after 2.5s: a page just opened has heard nothing yet), and a QR to open this page on a phone. */
function renderEmpty() {
  const off = !connected && lostAt && Date.now() - lostAt > 2500
  const box = $('offline')
  if (off && box.hidden) {
    const step = (n, title, cmd, note) => `<li><div class="step-title">${n}. ${title}</div>${cmd ? `<div class="codebox"><pre><code>${esc(cmd)}</code></pre><button class="copy" type="button" aria-label="복사">${icon('copy')}<span>복사</span></button></div>` : ''}${note ? `<div class="step-note">${note}</div>` : ''}</li>`
    box.innerHTML = `<div class="off-title">${icon('alert')}브로커가 꺼져 있어요</div><ol class="steps">${step(1, '맥에서 브로커 켜기', 'launchctl kickstart gui/$(id -u)/com.claude-slack', '안 되면 <code>cd ~/projects/claude-slack && npm start</code>')}${step(2, '처음이라면 로그인', 'claude', 'Claude Code 를 한 번 띄워 로그인하고, .env 에 Slack 토큰을 넣어요.')}${step(3, '연결 확인', 'tail -f ~/.claude-slack/logs/broker.log', '<code>[broker] up</code> 이 보이면 이 화면이 저절로 다시 붙어요.')}</ol>`
  }
  box.hidden = !off
  if (!$('qr-box').firstChild) drawQr()
}
/**
 * The phone QR: the address a phone can reach (the configured one, not a PC's localhost) and, when a token is
 * needed, a one-time code in place of the token: a screen share or a photo must not leak it. Codes last five
 * minutes, so the QR is redrawn every four.
 */
let qrTimer = null
let qrDrawing = false
async function drawQr() {
  // One at a time, one chain: calls that overlapped each started their own four-minute chain, and a hidden tab
  // kept making login codes. Hidden: stop; shown again: draw once more.
  if (qrDrawing) return
  if (document.visibilityState !== 'visible') return void (qrTimer = null)
  qrDrawing = true
  const box = $('qr-box')
  clearTimeout(qrTimer)
  try {
    const r = await api('/api/qr-code', {})
    if (r.local || !phoneAccess) {
      box.innerHTML = `<div class="qr-note">폰에서 열 주소가 설정되지 않았어요 (CLAUDE_SLACK_WEB_PUBLIC_URL)</div>`
      return
    }
    box.innerHTML = `${qrSvg(r.url, 176)}<div class="qr-note">폰으로 열기</div>`
    box.dataset.url = r.url
    if (r.expiresAt) qrTimer = setTimeout(drawQr, 4 * 60_000)
  } catch {
    box.innerHTML = ''
  } finally {
    qrDrawing = false
  }
}
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && !qrTimer && $('qr-box').firstChild && drawQr())
function renderConn() {
  renderEmpty()
  const quiet = connected || (lostAt && Date.now() - lostAt < (restarting ? 30_000 : 8_000))
  // Mirrored into the topbar too (20): the sidebar's own #conn is hidden on a phone's convo screen and
  // behind a collapsed sidebar on a PC, so a dropped connection there went unseen until a send failed.
  for (const el of [$('conn'), $('conn-top')]) {
    el.textContent = quiet ? '' : '연결이 끊겼어요 · 다시 붙는 중…'
    el.classList.toggle('bad', !quiet)
  }
  $('conn-top').hidden = quiet // empty, it would still nibble width from the centered title otherwise
}
setInterval(() => !connected && renderConn(), 1000)

async function catchUp(ts) {
  const t = thread(ts)
  if (t.loading) return t.loading
  t.loading = (async () => {
    const started = performance.now()
    let rounds = 0
    let got = 0
    try {
      // Fetch every page first and draw once: drawing each page as it came pushed the view down again and again.
      const all = []
      let after = t.last
      for (;;) {
        const { events, more } = await api(`/api/events?thread=${encodeURIComponent(ts)}&after=${after}`)
        rounds++
        const fresh = events.filter((e) => e.seq > after)
        if (!fresh.length) break
        all.push(...fresh)
        after = fresh.at(-1).seq
        if (!more) break
      }
      got = all.length
      if (all.length) addEvents(ts, all)
      metrics.catchups.push({ rounds, events: got, ms: Math.round(performance.now() - started) })
    } catch (err) {
      toast('대화를 불러오지 못했어요: ' + err.message, 'err')
    } finally {
      const buffered = t.buf
      t.buf = []
      t.loading = null
      // Only what is still newer than the catch-up's own events (addEvents already applied those and
      // moved t.last); sorted, since they may have queued out of order while this was in flight.
      const extra = buffered.filter((e) => e.seq > t.last).sort((a, b) => a.seq - b.seq)
      if (extra.length) addEvents(ts, extra, { live: true })
    }
  })()
  return t.loading
}

function addEvents(ts, evs, { live = false } = {}) {
  const t = thread(ts)
  const fresh = []
  for (const ev of evs) {
    if (ev.seq <= t.last) continue
    t.events.push(ev)
    t.last = ev.seq
    fresh.push(ev)
  }
  if (ts === current) {
    renderConvo(fresh, { live })
    markSeen(ts)
    keepTimeline(ts)
  }
  renderList()
}
let keepTimer = null
function keepTimeline(ts) {
  clearTimeout(keepTimer)
  // The device keeps a conversation 1,500 ms after the last change (59).
  keepTimer = setTimeout(() => saveTimeline(ts, thread(ts).events), 1500)
}

function markSeen(ts) {
  const t = threads.get(ts)
  if (!t || document.visibilityState !== 'visible') return
  if ((seen[ts] ?? 0) < t.last) {
    seen[ts] = t.last
    store.set('seen', seen)
  }
}

async function loadSideLists() {
  try {
    const st = await api('/api/state')
    recent = st.recent || []
    archives = st.archives || []
    renderList()
  } catch {}
}

// ------------------------------------------------------------------ time
function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 60) return '방금'
  if (s < 3600) return `${Math.floor(s / 60)}분 전`
  const d = new Date(ms)
  const today = new Date()
  const days = Math.floor((new Date(today.toDateString()) - new Date(d.toDateString())) / 86400000)
  if (days === 0) return `${Math.floor(s / 3600)}시간 전`
  if (days === 1) return '어제'
  if (days < 7) return `${days}일 전`
  return `${d.getMonth() + 1}/${d.getDate()}`
}
const hhmm = (at) => new Date(at).toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' })

// ------------------------------------------------------------------ list
const STATE = { starting: '뜨는 중', idle: '대기', busy: '작업 중', waiting: '응답 대기', ended: '종료됨' }
const nameOf = (s) => s.title || (s.cwd || '').split('/').pop() || s.cwd || '세션'
const folderOf = (cwd) => (cwd || '').replace(/^\/Users\/[^/]+/, '~')
function waitedFor(s) {
  if (!s.waitingSince) return s.waiting || STATE.waiting
  const m = Math.floor((Date.now() - s.waitingSince) / 60000)
  return m < 1 ? `${s.waiting || '응답 대기'}` : `${m}분째 기다리는 중`
}
function badgeHtml(s) {
  // Put to rest and not working: a grey 휴면 badge (45).
  if (s.resting && s.state !== 'busy') return `<span class="badge resting">휴면</span>`
  const text = s.state === 'waiting' ? (isPhone() ? s.waiting || STATE.waiting : waitedFor(s)) : STATE[s.state] || s.state
  return `<span class="badge ${s.state}">${esc(text)}</span>`
}

function secHead(key, label, n, { group, dropOut, menu: sectionMenu } = {}) {
  const open = group ? !(groups.collapsed || []).includes(group.id) : !folded[key]
  const el = document.createElement('div')
  el.className = 'sec-head' + (open ? ' open' : '') + (group ? ' group' : '')
  el.setAttribute('role', 'button')
  el.tabIndex = 0 // 20: a section head collapses/expands, so it needs to be reachable by Tab too
  el.setAttribute('aria-expanded', String(open))
  el.innerHTML = `<span class="tw">${icon('chevron')}</span><span class="gname"></span><span class="n">${n}</span>${group || sectionMenu ? `<button class="gmore" type="button" aria-label="${group ? '그룹 메뉴' : '메뉴'}">${icon('more')}</button>` : ''}`
  el.querySelector('.gname').textContent = label
  el.addEventListener('click', (e) => {
    if (e.target.closest('.gmore')) return
    if (group) return void groupOp({ op: 'fold', id: group.id, open: !open })
    folded[key] = open
    store.set('folded', folded)
    renderList()
  })
  el.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && !e.target.closest('.gmore')) (e.preventDefault(), el.click())
  })
  if (sectionMenu) {
    const menu = (at) => openMenu(at, sectionMenu)
    longPress(el, () => menu(null))
    el.querySelector('.gmore').addEventListener('click', (e) => {
      const r = e.currentTarget.getBoundingClientRect()
      menu({ x: r.right, y: r.bottom + 4, end: true })
    })
    el.addEventListener('contextmenu', (e) => (e.preventDefault(), menu({ x: e.clientX, y: e.clientY })))
  }
  if (group) {
    const menu = (at) => openMenu(at, groupItems(group))
    longPress(el, () => menu(null))
    el.querySelector('.gmore').addEventListener('click', (e) => {
      const r = e.currentTarget.getBoundingClientRect()
      menu({ x: r.left, y: r.bottom + 4 })
    })
    el.addEventListener('contextmenu', (e) => (e.preventDefault(), menu({ x: e.clientX, y: e.clientY })))
    // A group head is dragged to reorder groups, and takes a session dropped on it.
    el.draggable = hasMouse
    el.addEventListener('dragstart', (e) => startDrag(e, { group: group.id }, group.name))
    dropTarget(el, { kind: 'head', group: group.id })
  } else if (dropOut) dropTarget(el, { kind: 'head', group: null })
  return { el, open }
}

// ---- drag and drop (PC): a session onto a row (that place, that row's group), onto a group head (into it),
// onto "진행 중"/"이어서 하기" (out of groups); a group head onto another (group order). A 2px accent line marks
// where it lands, an outline a group it goes into; the pointer carries a small pill with the name.
let dragging = null
function startDrag(e, what, name) {
  dragging = what
  e.dataTransfer.effectAllowed = 'move'
  e.dataTransfer.setData('text/plain', name)
  const pill = document.createElement('div')
  pill.className = 'drag-pill'
  pill.textContent = name
  document.body.append(pill)
  e.dataTransfer.setDragImage(pill, 12, 14)
  setTimeout(() => pill.remove(), 0)
  e.currentTarget.classList.add('dragging')
  e.currentTarget.addEventListener('dragend', () => {
    e.currentTarget?.classList?.remove('dragging')
    dragging = null
    clearDropMarks()
  }, { once: true })
}
function clearDropMarks() {
  for (const x of document.querySelectorAll('.drop-before, .drop-after, .drop-into')) x.classList.remove('drop-before', 'drop-after', 'drop-into')
}
function dropTarget(el, spot) {
  el.addEventListener('dragover', (e) => {
    if (!dragging) return
    // A group head moves only among group heads.
    if (dragging.group && !(spot.kind === 'head' && spot.group)) return
    e.preventDefault()
    clearDropMarks()
    const r = el.getBoundingClientRect()
    const after = e.clientY > r.top + r.height / 2
    if (dragging.group) el.classList.add(after ? 'drop-after' : 'drop-before')
    else if (spot.kind === 'head') el.classList.add('drop-into')
    else el.classList.add(after ? 'drop-after' : 'drop-before')
  })
  el.addEventListener('dragleave', () => el.classList.remove('drop-before', 'drop-after', 'drop-into'))
  el.addEventListener('drop', async (e) => {
    if (!dragging) return
    e.preventDefault()
    const after = el.classList.contains('drop-after')
    clearDropMarks()
    const what = dragging
    dragging = null
    let op
    if (what.group) {
      const ids = groups.groups.map((g) => g.id).filter((id) => id !== what.group)
      const at = ids.indexOf(spot.group)
      op = { op: 'order', id: what.group, before: after ? (ids[at + 1] ?? null) : spot.group }
    } else if (spot.kind === 'head') op = { op: 'move', thread: what.thread, group: spot.group }
    else {
      const bucket = spot.group ? groups.groups.find((g) => g.id === spot.group)?.items ?? [] : [...$('list').querySelectorAll('.row[data-loose]')].map((x) => x.dataset.thread)
      const rest = bucket.filter((t) => t !== what.thread)
      const at = rest.indexOf(spot.thread) + (after ? 1 : 0)
      if (spot.group) op = { op: 'move', thread: what.thread, group: spot.group, before: rest[at] ?? null }
      // Outside groups the shown order is partly the default one: send the whole order as it now looks.
      else op = { op: 'loose', order: [...rest.slice(0, at), what.thread, ...rest.slice(at)] }
    }
    try {
      await api('/api/groups', op)
    } catch (err) {
      toast(err.message, 'err')
    }
  })
}

function groupItems(g) {
  return [
    { label: '이름 바꾸기', icon: 'edit', run: () => {
      const name = prompt('그룹 이름', g.name)
      if (name && name.trim()) groupOp({ op: 'rename', id: g.id, name })
    } },
    { label: '위로 이동', icon: 'up', run: () => moveGroup(g, -1) },
    { label: '아래로 이동', icon: 'down', run: () => moveGroup(g, 1) },
    { label: '그룹 삭제', icon: 'deny', danger: true, run: () => confirm(`"${g.name}" 그룹을 지울까요? 안의 세션은 그대로 남아요.`) && groupOp({ op: 'delete', id: g.id }) },
  ]
}
// Up one place: before the group above; down one place: before the group after the next (54).
function moveGroup(g, dir) {
  const i = groups.groups.findIndex((x) => x.id === g.id)
  const j = i + dir
  if (i < 0 || j < 0 || j >= groups.groups.length) return
  const before = dir < 0 ? groups.groups[j].id : (groups.groups[j + 1]?.id ?? null)
  groupOp({ op: 'order', id: g.id, before })
}
async function groupOp(op) {
  try {
    return await api('/api/groups', op)
  } catch (err) {
    toast(err.message, 'err')
  }
}
async function newGroup(thenThread) {
  const name = prompt('새 그룹 이름')
  if (!name || !name.trim()) return
  const r = await groupOp({ op: 'create', name })
  if (r?.id && thenThread) groupOp({ op: 'move', thread: thenThread, group: r.id })
}

function renderList() {
  const q = $('search').value.trim().toLowerCase()
  const match = (...vals) => !q || vals.some((v) => (v || '').toLowerCase().includes(q))
  const list = $('list')
  const keepScroll = list.scrollTop
  // Rebuilt below from scratch; remember what had the keyboard's focus so Tab/Enter navigation is not
  // thrown back to the top of the page by a session simply changing state while busy (19).
  const focusedThread = list.contains(document.activeElement) ? document.activeElement.dataset.thread : null
  list.innerHTML = ''

  const shown = sessions.filter((s) => match(s.title, s.preview, s.cwd, s.last?.text))
  const byThread = new Map(shown.map((s) => [s.thread, s]))
  const grouped = new Set(groups.groups.flatMap((g) => g.items))
  // Groups first, each in its own order; then the rest: the order they were put in, then waiting first, newest first.
  for (const g of groups.groups) {
    const members = g.items.map((t) => byThread.get(t)).filter(Boolean)
    const h = secHead('g:' + g.id, g.name, members.length, { group: g })
    // A group's folded state is the broker's, shared by every device (54).
    const waiting = members.filter((s) => s.state === 'waiting').length
    if (waiting) h.el.querySelector('.n').textContent = `${members.length} · ${waiting}개 대기`
    list.append(h.el)
    if (h.open) for (const s of members) list.append(liveRow(s, g.id))
    if (h.open && !members.length) list.insertAdjacentHTML('beforeend', `<div class="empty-note">${isPhone() ? '비어 있어요 · 대화를 밀어 더보기로 넣으세요' : '비어 있어요 · 대화를 우클릭해 넣으세요'}</div>`)
  }
  const loose = groups.loose || []
  const rank = (s) => (loose.includes(s.thread) ? loose.indexOf(s.thread) : Infinity)
  // Only two keys (19; `waiting` and `lastAt` used to be a third and fourth): a row's own position in the
  // list no longer shifts while it works, which used to move whatever a person was about to click out from
  // under the pointer and drop keyboard focus. "기다리는 중" shows as a badge/colour (liveRow), not a move.
  const live = shown.filter((s) => !grouped.has(s.thread)).sort((a, b) => rank(a) - rank(b) || a.startedAt - b.startedAt)
  const h = secHead('live', '진행 중', live.length, { dropOut: true })
  list.append(h.el)
  if (h.open) {
    for (const s of live) list.append(liveRow(s, null))
    if (!live.length) list.insertAdjacentHTML('beforeend', `<div class="empty-note">${q ? '찾는 세션이 없어요' : '실행 중인 세션이 없어요'}</div>`)
  }

  // The list shows up to 15 of the recent conversations and 20 of the past records (47).
  const rec = recent.filter((r) => match(r.title, r.preview, r.cwd))
  const hr = secHead('recent', '이어서 하기', rec.length, { dropOut: true, menu: [clearRecentItem()] })
  list.append(hr.el)
  if (hr.open && !rec.length) list.insertAdjacentHTML('beforeend', `<div class="empty-note">이어서 할 대화가 없어요</div>`)
  if (hr.open)
    for (const r of rec.slice(0, 15))
      list.append(
        plainRow({ lead: icon('play'), name: r.title, sub: r.preview, where: `${folderOf(r.cwd)} · ${ago(r.mtime)}`, when: ago(r.mtime), title: `${r.cwd}\n${r.preview || ''}` }, () => resume(r), (at) => openMenu(at, [{ label: '이어서 하기', icon: 'play', run: () => resume(r) }])),
      )

  const arc = archives.filter((a) => match(a.title, a.preview, a.cwd))
  const ha = secHead('archives', '지난 기록', arc.length, { menu: [clearArchivesItem()] })
  list.append(ha.el)
  if (ha.open)
    for (const a of arc.slice(0, 20)) {
      const at = Date.parse(a.archivedAt)
      list.append(plainRow({ lead: icon('clipboard'), name: a.title || folderOf(a.cwd), sub: a.preview, where: `${folderOf(a.cwd)} · ${ago(at)}`, when: ago(at), title: a.cwd }, () => viewArchive(a), (p) => openMenu(p, [{ label: '기록 보기', icon: 'file', run: () => viewArchive(a) }])))
    }
  list.scrollTop = keepScroll
  if (focusedThread) list.querySelector(`.row[data-thread="${focusedThread}"]`)?.focus()
}

function liveRow(s, groupId) {
  const row = document.createElement('div')
  const unread = (seen[s.thread] ?? 0) < s.lastSeq && s.thread !== current
  row.className = 'row' + (s.thread === current ? ' active' : '') + (unread ? ' unread' : '')
  row.setAttribute('role', 'button')
  row.tabIndex = 0
  row.dataset.thread = s.thread
  row.title = `${s.cwd}${s.preview ? '\n' + s.preview : ''}`
  const last = s.last?.text || s.preview || ''
  row.innerHTML = `<span class="lead"><span class="sdot ${s.state}"></span></span><span class="name"></span>${
    s.state === 'waiting' && !isPhone() ? `<span class="badge waiting">${esc(s.waiting || '응답 대기')}</span>` : `<span class="when">${ago(s.lastAt)}</span>`
  }<span class="sub last"></span><span class="sub where"></span>${isPhone() ? badgeHtml(s) : ''}<span class="chev">${icon('chevron')}</span>`
  row.querySelector('.name').textContent = nameOf(s)
  row.querySelector('.sub.last').textContent = last
  row.querySelector('.sub.where').textContent = `${folderOf(s.cwd)} · ${ago(s.lastAt)}`
  wireRow(row, () => open(s.thread), (at) => openMenu(at, sessionItems(s)))
  if (groupId === null) row.dataset.loose = '1'
  if (hasMouse) {
    row.draggable = true
    row.addEventListener('dragstart', (e) => startDrag(e, { thread: s.thread }, nameOf(s)))
    dropTarget(row, { kind: 'row', group: groupId, thread: s.thread })
  }
  return row
}

function plainRow(o, onOpen, onMenu) {
  const row = document.createElement('div')
  row.className = 'row'
  row.setAttribute('role', 'button')
  row.tabIndex = 0
  row.title = o.title || ''
  row.innerHTML = `<span class="lead">${o.lead}</span><span class="name"></span><span class="when"></span><span class="sub last"></span><span class="sub where"></span><span class="chev">${icon('chevron')}</span>`
  row.querySelector('.name').textContent = o.name || '(제목 없음)'
  row.querySelector('.when').textContent = o.when || ''
  row.querySelector('.sub.last').textContent = o.sub || ''
  row.querySelector('.sub.where').textContent = o.where || ''
  wireRow(row, onOpen, onMenu)
  return row
}

// Click opens; right-click (PC), a long press or a swipe to the left (phone) opens the row's menu.
function wireRow(row, onOpen, onMenu) {
  row.addEventListener('click', onOpen)
  row.addEventListener('keydown', (e) => e.key === 'Enter' && onOpen())
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    onMenu({ x: e.clientX, y: e.clientY })
  })
  longPress(row, () => onMenu(null), { swipeLeft: true })
}

/**
 * A long press (or a swipe to the left): moving more than 10px any way cancels it, as scrolling does, and so does
 * touchcancel. The click the release makes is swallowed once, document-wide and for 800ms at most: on the row it
 * would open the session, on the sheet's backdrop it would close the menu just opened; and one that never comes
 * must not eat the next real tap.
 */
function longPress(el, onPress, { swipeLeft = false } = {}) {
  let timer = null
  let x0 = 0
  let y0 = 0
  let fired = false
  const cancel = () => timer && (clearTimeout(timer), (timer = null))
  const fire = () => {
    if (fired) return
    fired = true
    cancel()
    swallowNextClick()
    onPress()
  }
  el.addEventListener('touchstart', (e) => {
    fired = false
    x0 = e.touches[0].clientX
    y0 = e.touches[0].clientY
    cancel()
    timer = setTimeout(fire, 500)
  }, { passive: true })
  el.addEventListener('touchmove', (e) => {
    const dx = e.touches[0].clientX - x0
    const dy = e.touches[0].clientY - y0
    if (swipeLeft && dx < -60 && Math.abs(dy) < 30 && !fired) return fire()
    if (Math.hypot(dx, dy) > 10) cancel()
  }, { passive: true })
  el.addEventListener('touchend', cancel)
  el.addEventListener('touchcancel', cancel)
}
function swallowNextClick() {
  const eat = (e) => {
    e.preventDefault()
    e.stopPropagation()
    stop()
  }
  const stop = () => {
    document.removeEventListener('click', eat, true)
    clearTimeout(t)
  }
  document.addEventListener('click', eat, true)
  const t = setTimeout(stop, 800)
}
$('search').addEventListener('input', renderList)
setInterval(() => {
  renderList()
  renderHeader()
}, 30_000)

async function resume(r) {
  // 19: a confirm first (this codebase's own convention for a start-something action, not a separate
  // sheet component), then go straight to the thread — success or "already running" both land somewhere.
  if (!confirm(`"${r.title || folderOf(r.cwd)}" 대화를 이어서 할까요?`)) return
  try {
    const res = await api('/api/session/resume', { id: r.id })
    toast(res.note)
    if (res.thread) {
      if (res.thread === current) await catchUp(res.thread) // already there: just make sure it's fresh
      else open(res.thread)
    }
  } catch (err) {
    toast(err.message, 'err')
  }
}
function viewArchive(a) {
  location.href = withToken('/view?kind=archive&path=' + encodeURIComponent(a.path))
}

// ------------------------------------------------------------------ opening a session
async function open(ts, { push = true } = {}) {
  closeNewSession()
  if (current && current !== ts) saveDraft()
  listScrollTop = $('list').scrollTop // leaving the list (or another thread) for this one
  current = ts
  // Guards every 'scroll' this causes (resetting #log, streaming in events, catching up) from being
  // mistaken for the person scrolling and overwriting the remembered position below before it is applied.
  positioning = true
  try {
    $('app').classList.add('in-convo')
    $('empty').hidden = true
    $('convo').hidden = false
    if (push) history.pushState({ thread: ts }, '', location.pathname + location.search + '#' + ts)
    else history.replaceState({ thread: ts }, '', location.pathname + location.search + '#' + ts)
    resetConvo()
    renderHeader()
    renderComposerBits()
    loadDraft()
    renderPending()
    const t = thread(ts)
    // After a reload: draw what the page kept, then fetch only what came after it.
    if (!t.events.length) {
      const kept = await loadTimeline(ts)
      if (current !== ts) return
      if (kept.length && !t.events.length) {
        t.events = kept
        t.last = kept.at(-1).seq
      }
    }
    if (t.events.length) renderConvo(t.events)
    await subscribe(ts)
    const opened = sessionOf(ts)
    if (opened) loadLinks(opened)
    await catchUp(ts)
    // Back to where this session was left (16), not always the bottom — unless it was at the bottom, or
    // this is the first time it is opened in this tab (nothing remembered yet).
    const remembered = scrollMemory.get(ts)
    if (remembered) {
      for (let guard = 0; view.start > 0 && scroller.scrollHeight - scroller.clientHeight < remembered && guard < 40; guard++) showOlder()
      scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight - remembered)
      $('jump').hidden = atBottom()
    } else {
      scrollToBottom()
    }
  } finally {
    positioning = false
  }
  markSeen(ts)
  renderList()
  renderActivity()
  if (hasMouse) $('input').focus()
}
function closeConvo() {
  saveDraft()
  current = null
  subscribe(null)
  $('app').classList.remove('in-convo')
  $('empty').hidden = false
  $('convo').hidden = true
  renderHeader()
  renderList()
  $('list').scrollTop = listScrollTop // the list's own scroll position, from before a thread was opened (16)
}
$('btn-back').addEventListener('click', () => (history.state?.thread ? history.back() : closeConvo()))
addEventListener('popstate', (e) => {
  if (e.state?.thread) open(e.state.thread, { push: false })
  else closeConvo()
})

// The gauges above the composer (44). Tokens read as 1M, 200K, 1K. Each gauge: a ring, its value, and an
// explanation that a hover or focus shows on PC (a tap on the phone shows it as one toast line).
const tokens = (n) => (n >= 1e6 ? `${Math.round(n / 1e5) / 10}M` : `${Math.max(1, Math.round(n / 1000))}K`)
const GAUGE_RING = 16
const fine = matchMedia('(pointer: fine)')
function gaugeHtml(g) {
  const dash = 2 * Math.PI * GAUGE_RING
  const shown = g.ratio === null ? 0 : Math.min(1, g.ratio)
  const cls = g.ratio === null ? '' : g.ratio >= g.bad ? ' bad' : g.ratio >= g.warn ? ' warn' : ''
  return `<button type="button" class="gauge${cls}" data-gauge="${g.key}" aria-label="${g.name} ${g.value}"><svg viewBox="0 0 40 40" aria-hidden="true"><circle class="bg" cx="20" cy="20" r="${GAUGE_RING}"/><circle class="fg" cx="20" cy="20" r="${GAUGE_RING}" stroke-dasharray="${dash}" stroke-dashoffset="${dash * (1 - shown)}"/></svg><span>${g.value}</span><span class="tip"><span>${g.name}</span><b>${g.big}</b><span class="bar"><i style="width:${Math.round(shown * 100)}%"></i></span><span>${g.rows.map(([k, v]) => `${k} ${v}`).join(' · ')}</span><small>${g.hint}</small></span></button>`
}
/** The gauges for the open session (44). Hidden when there is nothing to show. */
function gaugesFor(s) {
  const out = []
  const ctxPct = s.context ? parseInt(s.context, 10) : NaN
  const size = s.contextWindow?.size ?? 200_000
  out.push({ key: 'ctx', name: '컨텍스트', value: Number.isFinite(ctxPct) ? `${ctxPct}% / ${tokens(size)}` : `– / ${tokens(size)}`, ratio: Number.isFinite(ctxPct) ? ctxPct / 100 : null, warn: 0.6, bad: 0.8, big: Number.isFinite(ctxPct) ? `${ctxPct}%` : '–', rows: [['사용', s.contextWindow ? tokens(s.contextWindow.used) : '–'], ['창', tokens(size)]], hint: '컨텍스트가 차면 가벼운 복제를 생각해 보세요' })
  if (s.usage?.fiveHour !== undefined) out.push({ key: '5h', name: '5시간', value: `${s.usage.fiveHour}%`, ratio: s.usage.fiveHour / 100, warn: 0.7, bad: 0.9, big: `${s.usage.fiveHour}%`, rows: [], hint: '이 계정의 5시간 사용량' })
  if (s.usage?.sevenDay !== undefined) out.push({ key: '7d', name: '주간', value: `${s.usage.sevenDay}%`, ratio: s.usage.sevenDay / 100, warn: 0.7, bad: 0.9, big: `${s.usage.sevenDay}%`, rows: [], hint: '이 계정의 주간 사용량' })
  if (s.transcriptMb !== undefined) out.push({ key: 'log', name: '기록', value: `${s.transcriptMb}MB`, ratio: s.transcriptMb / 100, warn: 0.5, bad: 1, big: `${s.transcriptMb}MB`, rows: [], hint: '대화 기록 크기. 50MB 를 넘으면 가벼운 복제를 권해요' })
  if (s.sessionMd) out.push({ key: 'md', name: 'SESSION.md', value: `${Math.round(s.sessionMd.bytes / 1000)}KB`, ratio: s.sessionMd.bytes / s.sessionMd.max, warn: 0.75, bad: 1, big: `${Math.round(s.sessionMd.bytes / 1000)}KB`, rows: [], hint: '세션 메모 크기. 20KB 를 넘으면 줄여서 넘겨요' })
  return out
}
function renderGauges(s) {
  const box = $('gauges')
  const list = s && !s.ended ? gaugesFor(s) : []
  box.hidden = !list.length
  box.innerHTML = list.map(gaugeHtml).join('')
  for (const b of box.querySelectorAll('.gauge')) {
    b.addEventListener('click', () => {
      if (fine.matches) return
      const g = list.find((x) => x.key === b.dataset.gauge)
      toast(`${g.name} ${g.value}${g.hint ? ' · ' + g.hint : ''}`)
    })
  }
  renderSizeBanner(s)
}
/** Over 50 MB: a banner with the light copy. Over 100 MB the composer is locked (44). */
function renderSizeBanner(s) {
  const banner = $('size-banner')
  const mb = s?.transcriptMb ?? 0
  const locked = mb >= 100
  const input = $('input')
  input.disabled = locked
  input.placeholder = locked ? '대화 기록이 너무 커서 입력을 막았어요 · 가벼운 복제로 이어가요' : ''
  banner.hidden = !(mb >= 50)
  if (mb >= 50) {
    banner.innerHTML = locked
      ? `<span>대화 기록이 ${Math.round(mb)}MB 로 너무 커서 입력을 막았어요 · 가벼운 복제만 할 수 있어요</span><button type="button" class="ghost" data-act="lightfork">가벼운 복제</button>`
      : `<span>대화 기록이 ${Math.round(mb)}MB 로 너무 길어졌어요 · 가벼운 복제로 이어가요</span><button type="button" class="ghost" data-act="lightfork">가벼운 복제</button>`
    banner.querySelector('[data-act]').addEventListener('click', () => s && command(s, 'lightfork'))
    // Over 50 MB, once per session: a window that asks, remembered on this device (last 200 sessions) (44).
    const seen = store.get('size-seen', [])
    if (!locked && !seen.includes(s.thread)) {
      store.set('size-seen', [s.thread, ...seen].slice(0, 200))
      showSizeWindow(s, Math.round(mb), false)
    }
    if (locked && !document.querySelector('.size-window')) showSizeWindow(s, Math.round(mb), true)
  } else document.querySelector('.size-window')?.remove()
}
/** The window for a long conversation (44). Over 100 MB it cannot be closed: a light copy is the only way on. */
function showSizeWindow(s, mb, locked) {
  document.querySelector('.size-window')?.remove()
  const win = document.createElement('div')
  win.className = 'size-window'
  win.innerHTML = `<div class="size-card" role="dialog" aria-modal="true"><p><b>대화 기록이 ${mb}MB 예요</b></p><p>${locked ? '입력을 막았어요. 가벼운 복제로 이어가 주세요.' : '너무 길면 답이 느려져요. 가벼운 복제로 이어가면 좋아요.'}</p><div class="size-actions"><button type="button" class="primary" data-act="lightfork">가벼운 복제</button>${locked ? '' : '<button type="button" class="ghost" data-act="close">나중에</button>'}</div></div>`
  win.querySelector('[data-act="lightfork"]').addEventListener('click', () => {
    win.remove()
    command(s, 'lightfork')
  })
  win.querySelector('[data-act="close"]')?.addEventListener('click', () => win.remove())
  document.body.append(win)
}

function renderHeader() {
  const s = current && sessionOf(current)
  renderGauges(s)
  const title = $('title')
  title.textContent = s ? nameOf(s) : current ? '종료된 세션' : 'Claude'
  title.disabled = !s
  title.title = s ? '이름 변경' : ''
  const sub = $('subbar')
  sub.hidden = !current
  if (current) {
    $('badge').innerHTML = s ? badgeHtml(s) + (s.autoAllow ? ` <span class="badge auto">${icon('bolt')}전부 허용</span>` : '') : `<span class="badge ended">${STATE.ended}</span>`
    renderMeta(s)
    // A reserved refresh is shown where the session's state is, with a way to take it back.
    let plan = $('subbar').querySelector('.refresh-plan')
    if (s?.refreshAfter) {
      if (!plan) {
        plan = document.createElement('span')
        plan.className = 'refresh-plan'
        plan.innerHTML = `${icon('refresh')}<span>끝나면 새로고침해요</span><button class="linkish" type="button">취소</button>`
        plan.querySelector('button').addEventListener('click', () => command(sessionOf(current), 'refresh cancel'))
        $('subbar').append(plan)
      }
    } else plan?.remove()
  }
  const waiting = sessions.filter((x) => x.state === 'waiting').length
  document.title = waiting ? `(${waiting}) 응답 대기 · Claude` : 'Claude'
}
/** claude-opus-5-5 → opus 5.5 on a phone; the full id on a PC. */
function shortModel(m) {
  if (!m || !isPhone()) return m
  const x = /^claude-(opus|sonnet|haiku|fable)-(\d+)-(\d+)/.exec(m)
  return x ? `${x[1]} ${x[2]}.${x[3]}` : m.replace(/^claude-/, '')
}
/**
 * The line under the title: model · effort · permission mode · context · the user's plugins as this process
 * runs them. It stays the same while working (what runs is in the tool lines); only a long silence is added.
 */
function renderMeta(s) {
  const meta = $('meta')
  if (!s) return void (meta.textContent = '')
  meta.innerHTML = ''
  const parts = [shortModel(s.model), s.effort, s.permissionMode, s.contextLabel].filter(Boolean)
  meta.append(document.createTextNode(parts.join(' · ')))
  for (const p of s.plugins || []) {
    meta.append(document.createTextNode(`${meta.textContent ? ' · ' : ''}${p.market} ${p.version}`))
    if (p.latest) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'linkish plugin-new'
      b.textContent = p.latest === '최신' ? '새로고침하면 최신' : `새로고침하면 ${p.market} ${p.latest}`
      b.addEventListener('click', () => refreshSession(s))
      meta.append(document.createTextNode(' '), b)
    }
  }
  const quietMin = s.state === 'busy' && view?.lastAt ? Math.floor((Date.now() - view.lastAt) / 60_000) : 0
  if (quietMin >= 2) meta.append(document.createTextNode(` · ${quietMin}분째 새 출력 없음`))
}
$('title').addEventListener('click', () => {
  const s = current && sessionOf(current)
  if (s) renameSession(s)
})
async function renameSession(s) {
  const name = prompt('세션 이름', nameOf(s))
  if (!name || !name.trim() || name.trim() === nameOf(s)) return
  try {
    const r = await api(`/api/session/${s.pid}/rename`, { title: name.trim() })
    toast(r.note)
  } catch (err) {
    toast(err.message, 'err')
  }
}

// ------------------------------------------------------------------ sidebar: collapse and width
function setCollapsed(on) {
  $('app').classList.toggle('collapsed', on)
  store.set('collapsed', on)
  $('btn-collapse').title = on ? '사이드바 펼치기 (⌘\\)' : '사이드바 접기 (⌘\\)'
}
setCollapsed(store.get('collapsed', false))
$('btn-collapse').addEventListener('click', () => setCollapsed(!$('app').classList.contains('collapsed')))
;(() => {
  const set = (w) => document.documentElement.style.setProperty('--side-w', Math.max(200, Math.min(520, Math.round(w))) + 'px')
  set(store.get('sideW', 272))
  const r = $('resizer')
  r.addEventListener('dblclick', () => {
    set(272)
    store.set('sideW', 272)
  })
  r.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    r.setPointerCapture(e.pointerId)
    r.classList.add('dragging')
    const left = $('app').getBoundingClientRect().left
    const move = (m) => set(m.clientX - left)
    r.addEventListener('pointermove', move)
    r.addEventListener(
      'pointerup',
      () => {
        r.classList.remove('dragging')
        r.removeEventListener('pointermove', move)
        store.set('sideW', parseInt(getComputedStyle(document.documentElement).getPropertyValue('--side-w')))
      },
      { once: true },
    )
  })
})()

// ------------------------------------------------------------------ conversation
// Events are applied to a model of rows first; only the newest rows get elements (150, more when the
// view is scrolled to the top). A long session of thousands of events then costs the same to open as a
// short one, and an update (a tool's result, an answered card) finds its row by id, not by walking.
const WINDOW = 150
let view
function resetConvo() {
  if (optimistic) clearTimeout(optimistic.timer), (optimistic = null) // its #log is about to be wiped below
  $('log').innerHTML = ''
  $('todos').hidden = true
  view = { rows: [], tools: new Map(), msgs: new Map(), users: new Map(), reacts: new Map(), todos: null, turnAt: 0, lastAt: 0, start: 0, dirty: new Set(), opened: false }
}

const scroller = $('scroller')
const atBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60
function scrollToBottom() {
  scroller.scrollTop = scroller.scrollHeight // no smooth-scroll on this element: this lands at once
  $('jump').hidden = true
}
/** Is the view following the bottom? Set by the person's scrolling, not by content growing. */
let stuck = true
// Where each session was left scrolled (distance up from the bottom; 0 means "was at the bottom"), so
// coming back to it goes back to that spot instead of always to the bottom (16). Per tab, not persisted.
const scrollMemory = new Map()
// The session list's own scroll position, from just before a thread was opened — restored on going back
// to it (16; matters most on a phone, where the list is its own full screen).
let listScrollTop = 0
// True while `open()` is actively placing the scroll position: the swap to a new session's empty/then-
// refilled #log fires its own 'scroll' events, which must not be mistaken for the person scrolling and
// overwrite the very position `open()` is about to apply.
let positioning = false
scroller.addEventListener('scroll', () => {
  stuck = atBottom()
  const dist = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
  if (stuck) $('jump').hidden = true
  else if (dist > scroller.clientHeight) $('jump').hidden = false
  if (scroller.scrollTop < 200 && view?.start > 0) showOlder()
  if (!positioning && current) scrollMemory.set(current, stuck ? 0 : dist)
})
$('jump').firstElementChild.addEventListener('click', scrollToBottom)

// Dragging the conversation a real distance drops the phone keyboard (37) — a long pull to read something
// above is treated the same as deliberately tapping away from the input. A short flick (reading a line or
// two) and the inertia after letting go (no more touchmove fires) do not count, only the active drag.
const KEYBOARD_DROP_DRAG_PX = 120
let kbdDragY = null
scroller.addEventListener(
  'touchstart',
  (e) => {
    kbdDragY = e.touches.length === 1 ? e.touches[0].clientY : null
  },
  { passive: true },
)
scroller.addEventListener(
  'touchmove',
  (e) => {
    if (kbdDragY == null) return
    if (Math.abs(e.touches[0].clientY - kbdDragY) > KEYBOARD_DROP_DRAG_PX) {
      input.blur()
      kbdDragY = null // once per touch, not every px past the threshold
    }
  },
  { passive: true },
)
scroller.addEventListener('touchend', () => (kbdDragY = null))

function timeEl(at) {
  const d = document.createElement('div')
  d.className = 'time'
  d.textContent = hhmm(at)
  d.title = new Date(at).toLocaleString('ko-KR')
  return d
}

function renderConvo(evs, opts = {}) {
  try {
    drawConvo(evs, opts)
    // Drawn fine: a cover left by an earlier failed draw goes.
    $('main').querySelector('.crash')?.remove()
  } catch (err) {
    reportError('draw', err)
    showCrash(err)
  }
}
/** The conversation could not be drawn: a short Korean note with the error's number, a way to reopen, a way back. */
function showCrash(err) {
  const code = 'E-' + (String(err?.message ?? err).split('').reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 65536).toString(16)
  let box = $('main').querySelector('.crash')
  if (!box) {
    box = document.createElement('div')
    box.className = 'crash'
    $('main').append(box)
  }
  box.innerHTML = `<p>${icon('alert')} 대화를 그리다 문제가 생겼어요. (오류 ${code})</p><p><button class="btn primary" type="button" data-x="reload">다시 열기</button> <button class="btn" type="button" data-x="list">세션 목록으로</button></p>`
  box.querySelector('[data-x="reload"]').addEventListener('click', () => location.reload())
  box.querySelector('[data-x="list"]').addEventListener('click', () => (box.remove(), closeConvo()))
}
function drawConvo(evs, { live = false } = {}) {
  const t0 = performance.now()
  const follow = atBottom()
  const before = view.rows.length
  for (const ev of evs) apply(ev, live)
  // The first draw of a session shows only the newest rows.
  if (!view.opened) {
    view.opened = true
    view.start = Math.max(0, view.rows.length - WINDOW)
  }
  flush(before)
  renderTodos()
  renderWaitingNote()
  renderActivity()
  renderChoiceChips()
  if (follow) scrollToBottom()
  else if (view.rows.length > before) $('jump').hidden = false
  noteApply(performance.now() - t0)
}

function addRow(kind, ev, extra = {}) {
  const row = { kind, ev, at: ev.at, el: null, ...extra }
  view.rows.push(row)
  return row
}
function touch(row) {
  if (row.el) view.dirty.add(row)
}

function apply(ev, live) {
  view.lastAt = ev.at
  switch (ev.type) {
    case 'user': {
      view.turnAt = ev.at
      view.live = ''
      view.liveAt = null
      view.thinkingAt = null
      // The real echo of a message this page itself just sent (17): image-only sends match the first
      // one after, a text send matches on trimmed text so an earlier identical message is not mistaken.
      if (optimistic && ev.seq > optimistic.after && (optimistic.text ? ev.text?.trim() === optimistic.text : true)) dropOptimisticBubble()
      view.users.set(ev.ts, addRow('user', ev))
      return
    }
    case 'text':
      addRow('text', ev)
      view.lastText = ev.text
      view.live = ''
      view.liveAt = null
      view.thinkingAt = null
      return
    case 'tool':
      view.tools.set(ev.id, addRow('tool', ev, { end: null, closed: false }))
      return
    case 'tool_end': {
      const row = view.tools.get(ev.id)
      if (row) {
        row.end = ev
        touch(row)
      }
      return
    }
    case 'todos':
      view.todos = ev.todos
      return
    case 'msg': {
      // A note only for the presser (a button's answer): a toast while it is fresh, nothing in the timeline.
      if (ev.ephemeral && !hasActions(ev.blocks)) {
        if (live) toast(takeEmoji(plainText(ev.text)).rest)
        return
      }
      view.msgs.set(ev.ts, addRow('msg', ev))
      return
    }
    case 'msg_update': {
      const row = view.msgs.get(ev.ts)
      if (row) {
        row.ev = { ...ev, at: row.at }
        touch(row)
      }
      return
    }
    case 'msg_delete': {
      const row = view.msgs.get(ev.ts)
      if (row) {
        row.deleted = true
        view.msgs.delete(ev.ts)
        touch(row)
      }
      return
    }
    case 'react': {
      const set = view.reacts.get(ev.ts) ?? new Set()
      ev.on ? set.add(ev.name) : set.delete(ev.name)
      view.reacts.set(ev.ts, set)
      const row = view.users.get(ev.ts)
      if (row) touch(row)
      return
    }
    case 'status':
      if (ev.state === 'busy' && !view.turnAt) view.turnAt = ev.at
      if (ev.state !== 'busy') closeRunningTools()
      return
    case 'end':
      closeRunningTools()
      addRow('notice', ev, { icon: 'ended', text: `세션 ${ev.why}` })
      return
    case 'notice':
      addRow('notice', ev, { icon: ev.icon || 'bell', text: ev.text })
      return
  }
}

// A turn that ended leaves no tool "running": the ones without a result are closed.
function closeRunningTools() {
  for (const row of view.tools.values())
    if (!row.end && !row.closed) {
      row.closed = true
      touch(row)
    }
}

/** Put what changed on the page: edited rows in place, new rows at the end (within the window). */
function flush(before) {
  const log = $('log')
  for (const row of view.dirty) {
    if (!row.el) continue
    if (row.deleted) {
      row.el.remove()
      row.el = null
    } else if (row.kind === 'tool') updateTool(row)
    else {
      const el = draw(row)
      row.el.replaceWith(el)
      row.el = el
    }
  }
  view.dirty.clear()
  const frag = document.createDocumentFragment()
  for (let i = Math.max(before, view.start); i < view.rows.length; i++) {
    const row = view.rows[i]
    if (row.el || row.deleted) continue
    row.el = draw(row)
    frag.append(row.el)
  }
  // On the first draw everything in the window is new; after that only what came after `before`.
  if (before === 0 || view.start >= before) {
    for (let i = view.start; i < Math.max(before, view.start); i++) {
      const row = view.rows[i]
      if (!row.el && !row.deleted) frag.prepend((row.el = draw(row)))
    }
  }
  log.append(frag)
}

/**
 * A trailing ```choices block (22): buttons under the last answer only — not every answer that ever had
 * one, which is why this redraws on every `drawConvo`, not just when the choices themselves arrive.
 * Picking one sends it as a message (§4.3.14's chips do the same: `sendText` directly, no composer round
 * trip); the X remembers (`dismissed-choices`, last 50) so a closed set does not come back on reopen.
 */
function renderChoiceChips() {
  $('log').querySelector('.choice-chips')?.remove()
  const last = view.rows.at(-1)
  if (!last || last.deleted || last.kind !== 'text' || !last.ev.choices?.length || !last.el) return
  if (store.get('dismissed-choices', []).includes(last.ev.ts)) return
  const box = document.createElement('div')
  box.className = 'choice-chips'
  for (const c of last.ev.choices) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'chip'
    b.textContent = c
    b.addEventListener('click', () => {
      dismissChoices(last.ev.ts)
      const s = current && sessionOf(current)
      if (s) sendText(s, c)
    })
    box.append(b)
  }
  const x = document.createElement('button')
  x.type = 'button'
  x.className = 'chip-x icon-btn'
  x.setAttribute('aria-label', '닫기')
  x.innerHTML = icon('close')
  x.addEventListener('click', () => dismissChoices(last.ev.ts))
  box.append(x)
  last.el.after(box)
}
function dismissChoices(ts) {
  $('log').querySelector('.choice-chips')?.remove()
  const dismissed = store.get('dismissed-choices', [])
  if (!dismissed.includes(ts)) store.set('dismissed-choices', [...dismissed, ts].slice(-50))
}

/** Scrolled to the top: draw the previous 150 rows above, keeping what is on screen where it is. */
function showOlder() {
  const from = Math.max(0, view.start - WINDOW)
  const frag = document.createDocumentFragment()
  for (let i = from; i < view.start; i++) {
    const row = view.rows[i]
    if (!row.deleted && !row.el) frag.append((row.el = draw(row)))
  }
  view.start = from
  const h = scroller.scrollHeight
  $('log').prepend(frag)
  scroller.scrollTop += scroller.scrollHeight - h
}

function draw(row) {
  switch (row.kind) {
    case 'user':
      return userEl(row)
    case 'text': {
      const el = document.createElement('div')
      el.className = 'item text'
      const pictured = new Set([...(row.ev.images || []).map((im) => im.name), ...(row.ev.html || []).map((h) => h.name)])
      const others = (row.ev.files || []).map((f) => f.split('/').pop()).filter((n) => !pictured.has(n))
      const whole = isHtmlDocument(row.ev.text)
      el.innerHTML = `<div class="md">${whole ? '' : md(row.ev.text)}</div>${imagesHtml(row.ev.images)}${others.length ? `<div class="files">${icon('attach')} ${others.map(esc).join(', ')}</div>` : ''}`
      // HTML is drawn, read-only: an answer that is a whole document, each ```html block, each attached .html.
      if (whole) el.firstElementChild.append(htmlPreview(row.ev.text, row.ev.text))
      for (const pre of el.querySelectorAll('pre[data-lang="html"]')) {
        const box = pre.closest('.codebox')
        const code = pre.querySelector('code').textContent
        box.before(htmlPreview(code, null, box))
        box.hidden = true
      }
      for (const h of row.ev.html || []) el.firstElementChild.after(htmlPreview(h.content, h.content, null, h.name))
      el.append(timeEl(row.ev.at))
      return el
    }
    case 'tool':
      return toolEl(row)
    case 'msg':
      return msgEl(row.ev)
    case 'notice':
      return noticeEl(row.icon, row.text)
  }
}

function userEl(row) {
  const ev = row.ev
  const el = document.createElement('div')
  el.className = 'item user'
  el.innerHTML = `<div class="bubble"></div><div class="meta"></div>`
  // A long message (over 12 lines or 1200 characters) shows its first 8 lines, with "펼치기 (N줄 더)".
  const lines = ev.text.split('\n')
  const long = lines.length > 12 || ev.text.length > 1200
  const head = long ? (lines.length > 12 ? lines.slice(0, 8).join('\n') : ev.text.slice(0, 600) + '…') : ev.text
  el.firstElementChild.innerHTML = linkify(head)
  if (long) {
    const more = Math.max(1, lines.length - 8)
    const t = document.createElement('button')
    t.type = 'button'
    t.className = 'linkish more-toggle'
    t.textContent = lines.length > 12 ? `펼치기 (${more}줄 더)` : '펼치기'
    let openNow = false
    t.addEventListener('click', () => {
      openNow = !openNow
      el.firstElementChild.innerHTML = linkify(openNow ? ev.text : head)
      t.textContent = openNow ? '접기' : lines.length > 12 ? `펼치기 (${more}줄 더)` : '펼치기'
    })
    el.firstElementChild.after(t)
  }
  if (!ev.text) el.firstElementChild.remove()
  if (ev.images?.length) el.insertAdjacentHTML('afterbegin', imagesHtml(ev.images))
  const via = ev.via === 'terminal' ? `<span title="터미널에서 입력">${icon('keyboard')}</span>` : ev.via === 'slack' ? `<span title="Slack 에서 보냄">${icon('chat')}</span>` : ''
  const set = view.reacts.get(ev.ts)
  const held = set?.has('hourglass_flowing_sand')
  const delivered = !held && !set?.has('x') && (set?.has('eyes') || set?.has('white_check_mark'))
  const st = !set
    ? ''
    : held
      ? `<span class="held">대기 중</span><span class="desc" title="실행 중인 도구가 끝나면 전달해요">실행 중인 도구가 끝나면 전달해요</span><button class="linkish" type="button" data-act="unhold" data-ts="${esc(ev.ts)}">수정</button>`
      : set.has('x')
        ? '<span class="failed">취소함</span>'
        : delivered
          ? `<span>전달됨</span>${ev.via !== 'terminal' ? `<button class="linkish" type="button" data-act="retract" data-ts="${esc(ev.ts)}" title="멈추고 무시하라고 하기">잘못 보냄</button>` : ''}`
          : ''
  el.lastElementChild.innerHTML = `${via}<span class="t" title="${esc(new Date(ev.at).toLocaleString('ko-KR'))}">${hhmm(ev.at)}</span>${st}`
  return el
}

function toolStatus(row) {
  return row.end ? (row.end.ok ? ['ok', '완료'] : ['fail', '실패']) : row.closed ? ['ok', '끝남'] : ['run', '실행 중']
}
function toolEl(row) {
  const el = document.createElement('div')
  el.className = 'item tool'
  const [cls, label] = toolStatus(row)
  el.innerHTML = `<div class="head" role="button" tabindex="0" aria-expanded="false"><span class="st ${cls}">${label}</span><span class="label"></span></div>`
  el.querySelector('.label').innerHTML = icon(toolIcon(row.ev.name)) + linkify(takeEmoji(row.ev.title).rest)
  if (row.end?.images?.length) el.insertAdjacentHTML('beforeend', imagesHtml(row.end.images))
  const head = el.querySelector('.head')
  head.addEventListener('click', (e) => {
    if (e.target.closest('a')) return // a link in the row opens the link, not the row
    let d = el.querySelector('.detail')
    if (d) { d.hidden = !d.hidden; head.setAttribute('aria-expanded', String(!d.hidden)); return }
    d = document.createElement('div')
    d.className = 'detail'
    el.append(d)
    fillTool(row, d) // drawn the first time it is opened, so a long conversation stays light
    head.setAttribute('aria-expanded', 'true')
  })
  head.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.target.closest('a') || (e.preventDefault(), head.click())))
  return el
}
function updateTool(row) {
  if (row.end?.images?.length && !row.el.querySelector('.imgs')) row.el.querySelector('.head').insertAdjacentHTML('afterend', imagesHtml(row.end.images))
  const st = row.el.querySelector('.st')
  const [cls, label] = toolStatus(row)
  st.className = 'st ' + cls
  st.textContent = label
  const d = row.el.querySelector('.detail')
  if (d) fillTool(row, d)
}
function fillTool(row, d) {
  const parts = []
  if (row.ev.detail) parts.push(`<div class="k">입력</div>${codeBoxHtml(linkify(row.ev.detail))}`)
  if (row.end) parts.push(`<div class="k">${row.end.ok ? '출력' : '오류'}</div>${codeBoxHtml(linkify(row.end.output || '(출력 없음)'))}`)
  else parts.push(`<div class="k">${row.closed ? '결과 없이 끝났어요' : '실행 중…'}</div>`)
  d.innerHTML = parts.join('')
}
// ---- pictures: sized from their real dimensions so a late one does not push the page; a large one is
// fetched only when it comes within 800px of the view.
function imagesHtml(images) {
  if (!images?.length) return ''
  return `<div class="imgs">${images
    .map((im) => {
      const w = im.w || 320
      const h = im.h || 240
      const src = im.data || ''
      return `<button class="img" type="button" style="aspect-ratio:${w}/${h};width:min(100%,${Math.min(w, 480)}px)" aria-label="${esc(im.name || '그림')} 크게 보기"><img alt="${esc(im.name || '')}" ${src ? `src="${src}"` : `data-src="${esc(withToken(im.src))}" data-key="${esc(`${current}:${im.id}`)}"`} decoding="async"></button>`
    })
    .join('')}</div>`
}
const lazy = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue
      const img = e.target
      lazy.unobserve(img)
      if (img.dataset.src) loadPicture(img)
    }
  },
  { root: $('scroller'), rootMargin: '800px 0px' },
)
/** A referenced picture: from the page's cache when it has it, else fetched once and kept. */
async function loadPicture(img) {
  const key = img.dataset.key
  try {
    let blob = key ? await getImage(key) : undefined
    if (!blob) {
      const r = await fetch(img.dataset.src)
      if (!r.ok) throw new Error(String(r.status))
      blob = await r.blob()
      if (key) putImage(key, blob)
    }
    img.src = URL.createObjectURL(blob)
  } catch {
    img.src = img.dataset.src
  }
}
new MutationObserver((muts) => {
  for (const m of muts) for (const n of m.addedNodes) if (n.querySelectorAll) for (const img of n.querySelectorAll('img[data-src]')) lazy.observe(img)
}).observe($('log'), { childList: true, subtree: true })
document.addEventListener('click', (e) => {
  const b = e.target.closest('.img')
  if (!b) return
  const img = b.querySelector('img')
  openViewer(img.currentSrc || img.src || img.dataset.src)
})

/** A picture full-screen inside the page: pinch or wheel to zoom, drag to move, double tap for 2.5×, tap outside or Esc to close. */
function openViewer(src) {
  if (!src) return
  const box = document.createElement('div')
  box.className = 'viewer'
  box.innerHTML = `<img alt=""><button class="icon-btn close" type="button" aria-label="닫기">${icon('close')}</button>`
  const img = box.querySelector('img')
  img.src = src
  let scale = 1
  let x = 0
  let y = 0
  const pts = new Map()
  let pinch = null
  let moved = false
  let lastTap = 0
  const draw = () => (img.style.transform = `translate(${x}px, ${y}px) scale(${scale})`)
  const zoomAt = (cx, cy, next) => {
    next = Math.max(1, Math.min(8, next))
    const r = box.getBoundingClientRect()
    const px = cx - r.width / 2 - x
    const py = cy - r.height / 2 - y
    x -= px * (next / scale - 1)
    y -= py * (next / scale - 1)
    scale = next
    if (scale === 1) x = y = 0
    draw()
  }
  const close = () => {
    box.remove()
    removeEventListener('keydown', onKey)
  }
  const onKey = (e) => e.key === 'Escape' && close()
  addEventListener('keydown', onKey)
  box.addEventListener('wheel', (e) => {
    e.preventDefault()
    zoomAt(e.clientX, e.clientY, scale * Math.exp(-e.deltaY / 300))
  }, { passive: false })
  box.addEventListener('pointerdown', (e) => {
    box.setPointerCapture(e.pointerId)
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY })
    moved = false
    if (pts.size === 2) {
      const [a, b] = [...pts.values()]
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), scale }
    }
  })
  box.addEventListener('pointermove', (e) => {
    const p = pts.get(e.pointerId)
    if (!p) return
    const dx = e.clientX - p.x
    const dy = e.clientY - p.y
    if (Math.abs(dx) + Math.abs(dy) > 3) moved = true
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pts.size === 2 && pinch) {
      const [a, b] = [...pts.values()]
      zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, (pinch.scale * Math.hypot(a.x - b.x, a.y - b.y)) / pinch.d)
    } else if (pts.size === 1 && scale > 1) {
      x += dx
      y += dy
      draw()
    }
  })
  const up = (e) => {
    pts.delete(e.pointerId)
    if (pts.size < 2) pinch = null
    if (pts.size || moved) return
    const now = Date.now()
    if (now - lastTap < 300) {
      lastTap = 0
      zoomAt(e.clientX, e.clientY, scale > 1 ? 1 : 2.5)
      return
    }
    lastTap = now
    // A single tap on the backdrop (not the picture) closes, once it is clear no second tap follows.
    if (e.target === box) setTimeout(() => lastTap === now && close(), 300)
  }
  box.addEventListener('pointerup', up)
  box.addEventListener('pointercancel', (e) => pts.delete(e.pointerId))
  box.querySelector('.close').addEventListener('pointerdown', (e) => e.stopPropagation())
  box.querySelector('.close').addEventListener('click', close)
  document.body.append(box)
}

// ---- HTML preview: a sandboxed frame (no scripts, same origin only so its height can be measured), a CSP
// that allows nothing but inline styles and data: images, links opening outside, no meta refresh. The frame
// is written into rather than given srcdoc: some app web views block navigating it to about:srcdoc.
const isHtmlDocument = (t) => /^\s*(<!doctype html|<html[\s>])/i.test(t || '')
const CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'none'; form-action 'none'"><base target="_blank">`
function safeHtml(html) {
  const body = String(html).replace(/<meta[^>]+http-equiv\s*=\s*["']?refresh[^>]*>/gi, '')
  const doctype = /^\s*<!doctype[^>]*>/i.exec(body)
  // The policy must come before anything it governs: right after the doctype.
  return doctype ? doctype[0] + CSP + body.slice(doctype[0].length) : CSP + body
}
function writeFrame(frame, html, zoom = 1) {
  const doc = frame.contentDocument
  if (!doc) return
  doc.open()
  doc.write(safeHtml(html))
  doc.close()
  if (zoom !== 1) doc.documentElement.style.zoom = String(zoom)
  const fit = () => (frame.style.height = Math.min(4000, Math.max(60, doc.documentElement.scrollHeight || doc.body?.scrollHeight || 0)) + 'px')
  fit()
  for (const img of doc.images) img.addEventListener('load', fit)
  setTimeout(fit, 300)
  wireCopyButtons(doc)
}
/**
 * `<button data-copy="x">복사</button>` + `<textarea id="x">…</textarea>` (or any element) inside a preview
 * (35): the frame's own `onclick`/`<script>` never runs (the sandbox has no `allow-scripts`), so a button
 * Claude drew in there otherwise does nothing. This is the one thing the outer page does for it.
 */
function wireCopyButtons(doc) {
  doc.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-copy]')
    if (!btn) return
    const target = doc.getElementById(btn.getAttribute('data-copy'))
    if (!target) return
    const text = 'value' in target ? target.value : target.textContent
    navigator.clipboard
      .writeText(text ?? '')
      .then(() => {
        const prev = btn.textContent
        btn.textContent = '복사했어요'
        setTimeout(() => btn.isConnected && (btn.textContent = prev), 1500)
      })
      .catch(() => {})
  })
}
function htmlPreview(html, code, codeBox, name) {
  const wrap = document.createElement('div')
  wrap.className = 'htmlprev'
  wrap.innerHTML = `<div class="hp-bar">${icon('globe')}<span>${esc(name || 'HTML 미리보기')}</span><button class="linkish hp-code" type="button">코드 보기</button><button class="linkish hp-big" type="button">크게 보기</button></div>`
  const frame = document.createElement('iframe')
  frame.setAttribute('sandbox', 'allow-same-origin')
  frame.setAttribute('referrerpolicy', 'no-referrer')
  frame.title = name || 'HTML 미리보기'
  wrap.append(frame)
  // Written once it is in the page (an iframe has no document before that).
  requestAnimationFrame(() => writeFrame(frame, html))
  let codeEl = codeBox
  wrap.querySelector('.hp-code').addEventListener('click', (e) => {
    if (!codeEl) {
      codeEl = document.createElement('div')
      codeEl.innerHTML = codeBoxHtml(esc(code ?? html))
      codeEl = codeEl.firstElementChild
      codeEl.hidden = true
      wrap.after(codeEl)
    }
    codeEl.hidden = !codeEl.hidden
    e.target.textContent = codeEl.hidden ? '코드 보기' : '코드 숨기기'
  })
  wrap.querySelector('.hp-big').addEventListener('click', () => openHtmlViewer(html, name))
  return wrap
}
function openHtmlViewer(html, name) {
  const box = document.createElement('div')
  box.className = 'hp-full'
  box.innerHTML = `<div class="hp-bar">${icon('globe')}<span>${esc(name || 'HTML 미리보기')}</span><button class="icon-btn hp-minus" type="button" aria-label="작게">−</button><span class="hp-zoom">100%</span><button class="icon-btn hp-plus" type="button" aria-label="크게">+</button><button class="icon-btn hp-close" type="button" aria-label="닫기">${icon('close')}</button></div>`
  const frame = document.createElement('iframe')
  frame.setAttribute('sandbox', 'allow-same-origin')
  frame.setAttribute('referrerpolicy', 'no-referrer')
  box.append(frame)
  document.body.append(box)
  let zoom = 1
  const draw = () => {
    writeFrame(frame, html, zoom)
    frame.style.height = '100%'
    box.querySelector('.hp-zoom').textContent = Math.round(zoom * 100) + '%'
  }
  draw()
  box.querySelector('.hp-minus').addEventListener('click', () => ((zoom = Math.max(0.3, zoom - 0.1)), draw()))
  box.querySelector('.hp-plus').addEventListener('click', () => ((zoom = Math.min(3, zoom + 0.1)), draw()))
  const close = () => (box.remove(), removeEventListener('keydown', onKey))
  const onKey = (e) => e.key === 'Escape' && close()
  addEventListener('keydown', onKey)
  box.querySelector('.hp-close').addEventListener('click', close)
}

const codeBoxHtml = (inner) => `<div class="codebox"><pre><code>${inner}</code></pre><button class="copy" type="button" aria-label="복사">${icon('copy')}<span>복사</span></button></div>`

function noticeEl(ic, text, { markdown = false } = {}) {
  const el = document.createElement('div')
  el.className = 'item notice'
  el.innerHTML = `${icon(ic)}<div class="${markdown ? 'md' : ''}"></div>`
  if (markdown) el.lastElementChild.innerHTML = mrkdwn(text)
  else el.lastElementChild.textContent = text
  return el
}

function renderTodos() {
  const box = $('todos')
  const todos = view.todos
  if (!todos?.length || todos.every((x) => x.status === 'completed')) {
    box.hidden = true
    return
  }
  const done = todos.filter((x) => x.status === 'completed').length
  box.hidden = false
  box.innerHTML = `<details open><summary>${icon('plan')}할 일 ${done}/${todos.length}</summary>${todos
    .map((x) => `<div class="t ${x.status === 'completed' ? 'done' : x.status === 'in_progress' ? 'now' : ''}">${icon(x.status === 'completed' ? 'check' : x.status === 'in_progress' ? 'play' : 'ring')}<span>${esc(x.status === 'in_progress' && x.activeForm ? x.activeForm : x.content)}</span></div>`)
    .join('')}</details>`
}

// ---- broker messages: cards (with Slack blocks), folded answers, notices
const plainText = (t) => String(t ?? '').replace(/<@[A-Z0-9]+>\s*/g, '').trim()
const hasActions = (blocks) => Array.isArray(blocks) && blocks.some((b) => b.type === 'actions' || b.accessory?.type === 'button')
const textOf = (t) => (!t ? '' : t.type === 'plain_text' ? esc(t.text) : mrkdwn(plainText(t.text)))

function msgEl(ev) {
  const blocks = Array.isArray(ev.blocks) ? ev.blocks : null
  const first = plainText(blocks?.find((b) => b.type === 'section' || b.type === 'context')?.text?.text ?? blocks?.find((b) => b.type === 'context')?.elements?.[0]?.text ?? ev.text)
  const lead = takeEmoji(first)
  // A side question (52) is a dashed card: it is not in the conversation.
  if (/^옆길 질문 · 대화에는 남지 않아요/.test(ev.text ?? '')) {
    const side = document.createElement('div')
    side.className = 'side-card'
    side.innerHTML = `<div class="sc-head">${esc(ev.text.split('\n')[0])}</div><div class="sc-body md">${md(ev.text.split('\n').slice(1).join('\n'))}</div>`
    return side
  }
  // What 전부 허용 allowed: a line like a tool's, not a card.
  if (/^⚡\s*자동 허용/.test(first)) return autoAllowEl(ev, lead.rest)
  // An answered card: one line, an accent check (or a deny mark) and what was chosen.
  if (blocks && !hasActions(blocks) && !ev.ephemeral && (lead.icon === 'check' || lead.icon === 'deny' || lead.icon === 'play') && blocks.length <= 2) {
    const el = document.createElement('div')
    el.className = 'item folded'
    el._at = ev.at
    el.innerHTML = `${icon(lead.icon === 'deny' ? 'deny' : 'check')}<div class="md"></div>`
    el.lastElementChild.innerHTML = mrkdwn(lead.rest)
    return el
  }
  // A plain notice from the broker (cleared, compacted, auto-confirmed, ended): centred, small.
  if (!blocks && !ev.files?.length && first.length <= 240 && !first.includes('\n')) {
    const el = noticeEl(lead.icon === 'alert' ? 'alert' : lead.icon || 'bell', lead.rest, { markdown: true })
    el._at = ev.at
    return el
  }
  if (!blocks && !ev.files?.length) {
    // Longer text the broker posted (command output, a subagent's report): as a message, not a card.
    const el = document.createElement('div')
    el.className = 'item text'
    el._at = ev.at
    el.innerHTML = `<div class="md">${mrkdwn(plainText(ev.text))}</div>`
    el.append(timeEl(ev.at))
    return el
  }
  return cardEl(ev, blocks)
}

function autoAllowEl(ev, rest) {
  const el = document.createElement('div')
  el.className = 'item tool'
  el._at = ev.at
  el.innerHTML = `<div class="head"><span class="st allow">허용함</span><span class="label"></span></div>`
  el.querySelector('.label').innerHTML = icon('bolt') + mrkdwn(rest.replace(/^·\s*/, '')).replace(/^<p>|<\/p>$/g, '')
  const detail = (ev.blocks || []).slice(1)
  el.querySelector('.head').addEventListener('click', (e) => {
    if (e.target.closest('a')) return
    let d = el.querySelector('.detail')
    if (d) return void (d.hidden = !d.hidden)
    d = document.createElement('div')
    d.className = 'detail md'
    d.innerHTML = detail.map((b) => textOf(b.text) || (b.elements || []).map(textOf).join(' ')).join('') || '<div class="k">내용 없음</div>'
    el.append(d)
  })
  return el
}

function cardEl(ev, blocks) {
  const el = document.createElement('div')
  el.className = 'item card' + (ev.ephemeral ? ' eph' : '') + (hasActions(blocks) ? ' decision' : '')
  el._at = ev.at
  let titled = false
  for (const b of blocks || []) {
    const blk = blockEl(b, ev, blocks, titled)
    if (!blk) continue
    if (!titled && blk.classList.contains('ttl')) titled = true
    el.append(blk)
  }
  if (!el.childElementCount) el.innerHTML = `<div class="blk md">${mrkdwn(plainText(ev.text))}</div>`
  if (ev.files?.length) el.insertAdjacentHTML('beforeend', `<div class="files">${icon('attach')} ${ev.files.map((f) => esc(f.split('/').pop())).join(', ')}</div>`)
  return el
}
function blockEl(b, ev, all, titled) {
  const d = document.createElement('div')
  d.className = 'blk md'
  switch (b.type) {
    case 'section': {
      const raw = plainText(b.text?.text ?? '')
      if (!titled && b.text) {
        // The card's first line is its title: the icon in place of the emoji, then the rest as body.
        const { icon: ic, rest } = takeEmoji(raw)
        const [head, ...body] = rest.split('\n')
        d.className = 'blk ttl'
        d.innerHTML = `${icon(ic || 'question')}<div><div class="md">${mrkdwn(head)}</div>${body.length ? `<div class="md" style="font-weight:400">${mrkdwn(body.join('\n'))}</div>` : ''}</div>`
      } else d.innerHTML = textOf(b.text)
      if (b.fields) d.insertAdjacentHTML('beforeend', `<div class="fields">${b.fields.map((f) => `<div>${textOf(f)}</div>`).join('')}</div>`)
      if (b.accessory?.type === 'button') {
        const row = document.createElement('div')
        row.className = 'actions'
        row.append(buttonEl(b.accessory, ev, all))
        d.append(row)
      }
      return d
    }
    case 'context':
      d.className = 'blk ctx md'
      d.innerHTML = (b.elements || []).map((x) => (x.type === 'image' ? '' : textOf(x))).join(' ')
      return d
    case 'header':
      d.className = 'blk ttl'
      d.innerHTML = `${icon('bell')}<div>${textOf(b.text)}</div>`
      return d
    case 'divider':
      d.innerHTML = '<hr>'
      return d
    case 'markdown':
      d.innerHTML = md(b.text)
      return d
    case 'actions': {
      d.className = 'blk actions'
      for (const x of b.elements || []) {
        if (x.type === 'button') d.append(buttonEl(x, ev, all))
        else if ((x.type === 'static_select' || x.type === 'overflow') && x.options) for (const o of x.options) d.append(buttonEl({ text: o.text, action_id: x.action_id, value: o.value }, ev, all))
      }
      return d.childElementCount ? d : null
    }
    case 'table': {
      const rows = b.rows || []
      const cell = (c) => esc(c?.text ?? '')
      d.innerHTML = `<div class="table-wrap"><table>${rows.map((r, i) => `<tr>${r.map((c) => (i === 0 ? `<th>${cell(c)}</th>` : `<td>${cell(c)}</td>`)).join('')}</tr>`).join('')}</table></div>`
      return d
    }
    default:
      if (b.text?.text) {
        d.innerHTML = textOf(b.text)
        return d
      }
      return null
  }
}
function buttonEl(x, ev, all) {
  const btn = document.createElement(x.url ? 'a' : 'button')
  btn.className = 'btn' + (x.style ? ' ' + x.style : '')
  btn.textContent = takeEmoji(x.text?.text ?? '버튼').rest
  if (x.url) {
    btn.href = x.url
    btn.target = '_blank'
    btn.rel = 'noopener noreferrer'
    return btn
  }
  btn.type = 'button'
  if (x.style === 'primary' && /^perm_allow/.test(x.action_id) && hasMouse) btn.insertAdjacentHTML('beforeend', `<span class="kbd">${isMac ? '⌘↵' : 'Ctrl↵'}</span>`)
  btn.dataset.action = x.action_id
  btn.addEventListener('click', async () => {
    const row = btn.closest('.actions')
    row?.querySelectorAll('button').forEach((b) => (b.disabled = true))
    try {
      const r = await api('/api/action', { actionId: x.action_id, value: x.value ?? '', ...(ev.ephemeral || String(ev.ts).startsWith('up-') ? {} : { messageTs: ev.ts }), blocks: all })
      if (r.note && r.note !== '눌렀어요') toast(r.note) // the press's own result (42)
    } catch (err) {
      toast(err.message, 'err')
    } finally {
      setTimeout(() => row?.querySelectorAll('button').forEach((b) => (b.disabled = false)), 1500)
    }
  })
  return btn
}

// "수정" on a held message takes it back into the field; "잘못 보냄" stops Claude and tells it not to follow.
$('log').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]')
  const s = current && sessionOf(current)
  if (!b || !s) return
  const ts = b.dataset.ts
  if (b.dataset.act === 'unhold') {
    try {
      const r = await api(`/api/session/${s.pid}/unhold`, { ts })
      input.value = r.text + (input.value ? '\n' + input.value : '')
      autosize()
      saveDraft()
      input.focus()
      toast('대기열에서 빼서 입력칸에 넣었어요')
    } catch (err) {
      toast(err.message, 'err')
    }
  } else if (b.dataset.act === 'retract') {
    if (!confirm('잘못 보냈다고 알릴까요?\n작업을 멈추고, 이 메시지를 따르지 말라고 보내요. 이미 한 일은 무엇인지 알려 달라고 해요.')) return
    try {
      toast((await api(`/api/session/${s.pid}/retract`, { ts })).note)
    } catch (err) {
      toast(err.message, 'err')
    }
  }
})

// Copy buttons on every code box, wherever it is.
document.addEventListener('click', async (e) => {
  const b = e.target.closest('.copy')
  if (!b) return
  e.stopPropagation()
  const code = b.closest('.codebox')?.querySelector('code')?.innerText ?? ''
  try {
    await navigator.clipboard.writeText(code)
    b.classList.add('done')
    b.lastElementChild.textContent = '복사됨'
    setTimeout(() => {
      b.classList.remove('done')
      b.lastElementChild.textContent = '복사'
    }, 1200)
  } catch {
    toast('복사하지 못했어요', 'err')
  }
})

// ------------------------------------------------------------------ activity box
// One box at the bottom while the session works; only its header changes. The "쓰는 중" body (15) is
// Claude's own markdown (restored from the terminal's SGR colours in src/preview.ts), not a plain-text
// tail: it grows as the block is written, and a thinking pause between blocks shows as a small line
// under the text already there rather than clearing it.
function renderActivity() {
  const box = $('activity')
  const s = current && sessionOf(current)
  if (!s || s.state !== 'busy' || !view) {
    box.hidden = true
    box.dataset.key = ''
    return
  }
  // Only this turn's tools: one left without a result from an earlier turn is not "running".
  let running = null
  for (const t of view.tools.values()) if (!t.end && !t.closed && t.ev.at >= (view.turnAt || 0)) running = t
  // Text already in the timeline that the terminal still shows is not "being written".
  const live = view.live && !(view.lastText && view.lastText.replace(/\s+/g, ' ').includes(view.live.replace(/\s+/g, ' ').slice(0, 60))) ? view.live : ''
  const thinking = !running && !!view.thinkingAt
  const since = running ? running.ev.at : live && view.liveAt ? view.liveAt : thinking ? view.thinkingAt : Math.max(view.lastAt || 0, view.turnAt || 0) || Date.now()
  const secs = Math.max(0, Math.round((Date.now() - since) / 1000))
  const key = running ? 'tool:' + running.ev.id : live ? 'write' : 'think'
  if (box.dataset.key !== key) {
    box.dataset.key = key
    typed = ''
    box.innerHTML = running
      ? `<div class="ahead" role="button" tabindex="0" aria-expanded="false">${icon('chevron')}<span class="txt"></span><span class="secs"></span></div>`
      : live
        ? `<div class="tail md"></div><div class="think-sub" hidden>${icon('spark')}<span>생각 중</span> <span class="think-secs"></span></div>`
        : `<div class="ahead">${icon('spark')}<span class="txt">생각 중…</span><span class="secs"></span></div>`
    if (running) {
      box.querySelector('.txt').textContent = `도구 실행 중 · ${takeEmoji(running.ev.title).rest}`
      const ahead = box.querySelector('.ahead')
      ahead.addEventListener('click', () => {
        let now = box.querySelector('.now')
        if (now) return void (now.remove(), ahead.setAttribute('aria-expanded', 'false'))
        now = document.createElement('div')
        now.className = 'now'
        now.innerHTML = codeBoxHtml(linkify(running.ev.detail || takeEmoji(running.ev.title).rest))
        box.append(now)
        ahead.setAttribute('aria-expanded', 'true')
      })
      ahead.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), ahead.click()))
    }
  }
  box.hidden = false
  const secsEl = box.querySelector('.secs') // the 쓰는 중 view has none: its text is the answer itself (15)
  if (secsEl) secsEl.textContent = `· ${secs}초`
  if (live) {
    typeInto(box.querySelector('.tail'), live)
    const sub = box.querySelector('.think-sub')
    if (sub) {
      sub.hidden = !thinking
      if (thinking) sub.querySelector('.think-secs').textContent = `· ${Math.max(0, Math.round((Date.now() - view.thinkingAt) / 1000))}초`
    }
  }
}

/** Close a mark a still-mid-write block left open, for display only — never changes the stored text. */
function closeOpenMarkup(s) {
  let out = s
  if ((out.match(/```/g) || []).length % 2 === 1) out += '\n```'
  if ((out.match(/\*\*/g) || []).length % 2 === 1) out += '**'
  if ((out.match(/(?<!`)`(?!`)/g) || []).length % 2 === 1) out += '`'
  return out
}

// The preview grows on: only what is new since the last draw is kept track of (`typed`), not the whole
// text redrawn from scratch each frame. When the window slid (the start of the block moved, e.g. a
// thinking pause reshaped it), find where the old tail's end sits in the new one.
// Note: the exact reveal speed here (how many characters per animation frame) is a simplified stand-in
// for matching the speed characters actually arrive at — reproducing that pacing precisely needs the
// reference implementation's own constants, which this codebase does not have access to.
let typed = ''
let typing = null
// Pace (39): the reveal runs at the speed the text actually arrives — characters per ms, smoothed
// (previous 0.6 + new 0.4, never below 0.02) — and a backlog is caught up within 1,200 ms.
let paceRate = 0
let paceAt = 0
let paceLen = 0
function typeInto(el, target) {
  if (!el) return
  let keep = typed
  if (!target.startsWith(keep)) {
    const probe = keep.slice(-24)
    const at = probe ? target.lastIndexOf(probe) : -1
    keep = at >= 0 ? target.slice(0, at + probe.length) : ''
  }
  const firstReveal = keep === ''
  typed = keep
  const now = performance.now()
  if (target.length > paceLen && paceAt) {
    const fresh = (target.length - paceLen) / Math.max(1, now - paceAt)
    paceRate = paceRate ? 0.6 * paceRate + 0.4 * fresh : fresh
  }
  paceLen = target.length
  paceAt = now
  paceRate = Math.max(paceRate, 0.02)
  const draw = () => (el.innerHTML = md(closeOpenMarkup(typed)))
  draw()
  cancelAnimationFrame(typing)
  // A long first chunk (opening a turn already mid-write, or the window having slid right past an anchor)
  // shows whole rather than typing from nothing up to 400+ characters.
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || (firstReveal && target.length > 400)) {
    typed = target
    draw()
    return
  }
  let last = performance.now()
  const step = (t) => {
    if (typed.length >= target.length) return
    const elapsed = Math.max(0, t - last)
    last = t
    const backlog = target.length - typed.length
    const advance = Math.max(paceRate * elapsed, (backlog * elapsed) / 1200)
    typed = target.slice(0, typed.length + Math.min(backlog, Math.max(1, Math.ceil(advance))))
    draw()
    typing = requestAnimationFrame(step)
  }
  typing = requestAnimationFrame(step)
}

// Stuck to the bottom, stay there when something below grows late (a picture, the activity box) or the
// scroll pane itself shrinks (the composer growing — todos, chips, the phone keyboard — pushes it up
// from below; watching only #log/#activity missed that, so the last line went under the composer, 16).
const stayDown = new ResizeObserver(() => {
  if (view && stuck) scroller.scrollTop = scroller.scrollHeight
})
stayDown.observe($('log'))
stayDown.observe($('activity'))
stayDown.observe(scroller)
setInterval(() => current && renderActivity(), 1000)

// ------------------------------------------------------------------ composer: chips, waiting note, held
function renderWaitingNote() {
  let n = 0
  // Cards above can out-survive the session actually waiting (one answered through Slack, say, while
  // the page had not caught up yet) — the note should only show while the session itself is really
  // waiting on a person, not just "some card up there still looks unanswered" (20).
  const s = current && sessionOf(current)
  if (s?.state === 'waiting') for (const row of view.msgs.values()) if (!row.deleted && hasActions(row.ev.blocks) && !row.ev.ephemeral) n++
  const el = $('waiting-note')
  el.hidden = !n
  if (n) el.innerHTML = `${icon('ring')}위 카드 ${n}개가 응답을 기다려요`
}

function renderComposerBits() {
  const s = current && sessionOf(current)
  const chips = $('chips')
  chips.innerHTML = ''
  if (!s) return
  const chip = (ic, label, run, { hot = false, href, cls = '' } = {}) => {
    const c = document.createElement(href ? 'a' : 'button')
    c.className = 'chip' + (hot ? ' hot' : '') + (cls ? ' ' + cls : '')
    c.innerHTML = `${icon(ic)}<span></span>`
    c.lastElementChild.textContent = label
    if (href) {
      c.href = href
      c.target = '_blank'
      c.rel = 'noopener'
    } else {
      c.type = 'button'
      c.addEventListener('click', run)
    }
    chips.append(c)
  }
  // PR and Slack thread: one link opens at once, several open a small list (above the chip on a PC, a sheet on a phone).
  const linkChip = (ic, label, list, fallback) => {
    if (!list?.length && !fallback) return
    if (!list?.length || (list.length === 1 && !fallback)) return chip(ic, label, null, { href: list?.[0]?.url ?? fallback, cls: list?.[0]?.state ? 'pr-' + list[0].state.toLowerCase() : '' })
    chip(ic, `${label} ${list.length}`, (e) => {
      const r = e.currentTarget.getBoundingClientRect()
      openMenu({ x: r.left, y: r.top, above: true }, list.map((l) => ({ label: l.label, icon: ic, cls: l.state ? 'pr-' + l.state.toLowerCase() : '', run: () => window.open(l.url, '_blank', 'noopener') })))
    })
  }
  const links = linkCache.get(s.pid)
  linkChip('pr', 'PR', links?.prs)
  linkChip('link', 'Slack 스레드', links?.threads, links ? undefined : withToken('/go/thread?ts=' + encodeURIComponent(s.thread)))
  if (s.held) chip('play', `지금 보내기 (${s.held})`, () => command(s, 'sendnow'), { hot: true })
  if (s.state === 'busy' || s.state === 'waiting') chip('stop', hasMouse ? '중단 · Esc' : '중단', () => command(s, 'esc'))
  if (s.canKeys) chip('screen', '화면', () => showScreen(s))
  chip('spark', '스킬', (e) => pickSkill(s, e.currentTarget))
  chip('image', '이미지 붙여넣기', pasteFromClipboard)
  chip('chat', '/btw', () => prefill(':btw '))
  chip('clipboard', '/compact', () => sendText(s, '/compact'))
  chip('search', '/context', () => sendText(s, '/context'))
  chip('refresh', '/clear', () => confirm('대화를 비울까요? (/clear)') && sendText(s, '/clear'))
}
/** "스킬": what this folder can call, the ones called by hand most often first. Picking fills "/name ". */
async function pickSkill(s, chipEl) {
  let m
  try {
    m = await api(`/api/session/${s.pid}/skills`)
  } catch (err) {
    return toast(err.message, 'err')
  }
  const item = (x) => ({ label: `/${x.name}`, icon: x.kind === 'command' ? 'terminal' : 'spark', end: x.count ? `${x.count}회` : '', run: () => prefill(`/${x.name} `) })
  const items = [
    ...(m.direct.length ? [{ head: '직접 부른 스킬' }, ...m.direct.map(item)] : []),
    ...(m.auto.length ? ['sep', { head: '자동으로 쓰인 스킬' }, ...m.auto.map(item)] : []),
    ...(m.other.length ? ['sep', { head: '그 밖의 스킬' }, ...m.other.map(item)] : []),
  ].filter((x, i, a) => !(x === 'sep' && i === 0))
  if (!items.length) return toast('이 폴더에서 쓸 수 있는 스킬이 없어요', 'err')
  const r = chipEl.getBoundingClientRect()
  openMenu({ x: r.left, y: r.top, above: true }, items)
}
async function pasteFromClipboard() {
  try {
    const files = []
    for (const item of await navigator.clipboard.read())
      for (const type of item.types.filter((t) => t.startsWith('image/'))) files.push(new File([await item.getType(type)], `붙여넣기.${type.split('/')[1]}`, { type }))
    if (!files.length) return toast('클립보드에 이미지가 없어요', 'err')
    addPictures(files)
  } catch {
    toast('클립보드를 읽지 못했어요. 입력칸을 길게 눌러 붙여넣어 보세요', 'err')
  }
}
const linkCache = new Map()
async function loadLinks(s) {
  try {
    linkCache.set(s.pid, await api(`/api/session/${s.pid}/links`))
    if (current === s.thread) renderComposerBits()
  } catch {}
}
function prefill(text) {
  input.value = text
  autosize()
  input.focus()
  input.setSelectionRange(text.length, text.length)
}
async function command(s, cmd) {
  try {
    await api('/api/action', { actionId: 'ctl_btn_web', value: `${s.pid}:${cmd}` })
  } catch (err) {
    toast(err.message, 'err')
  }
}

// The terminal as a picture, inside the page (an app's web view may refuse a new tab).
function showScreen(s) {
  const scrim = document.createElement('div')
  scrim.className = 'scrim dim'
  scrim.style.display = 'grid'
  scrim.style.placeItems = 'center'
  scrim.style.padding = '16px'
  scrim.innerHTML = `<img alt="터미널 화면" style="max-width:100%;max-height:100%;border-radius:10px;box-shadow:var(--shadow)">`
  scrim.firstElementChild.src = withToken(`/api/session/${s.pid}/screen.png?part=screen&_=${Date.now()}`)
  scrim.firstElementChild.onerror = () => {
    scrim.remove()
    toast('화면을 가져오지 못했어요', 'err')
  }
  scrim.addEventListener('click', () => scrim.remove())
  addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') scrim.remove(), removeEventListener('keydown', esc)
  })
  document.body.append(scrim)
}

// ------------------------------------------------------------------ composer: pictures to send
// Picked, pasted or dropped; shown small above the field with a remove button; shrunk before sending.
// Kept in memory per session (a reload drops them; the text draft survives).
const pending = new Map() // thread → [{ name, type, data, url }]
$('btn-attach').hidden = false
const picker = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/*', multiple: true, hidden: true })
document.body.append(picker)
$('btn-attach').addEventListener('click', () => picker.click())
picker.addEventListener('change', () => {
  addPictures([...picker.files])
  picker.value = ''
})
$('input').addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'))
  if (files.length) {
    e.preventDefault()
    addPictures(files)
  }
})
$('convo').addEventListener('dragover', (e) => {
  if ([...(e.dataTransfer?.items || [])].some((i) => i.type.startsWith('image/'))) e.preventDefault()
})
$('convo').addEventListener('drop', (e) => {
  const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/'))
  if (!files.length) return
  e.preventDefault()
  addPictures(files)
})
// 18: limits also enforced in src/broker.ts webSend — a page is never the only thing that can reach that call.
const PIC_MAX = 8
const PIC_BASE64_MAX = 3_145_728
const PIC_BYTES_MAX = 10 * 1024 * 1024
const PIC_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
/** True while a batch is being read/shrunk: blocks sending (a half-attached message should not go). */
let addingPictures = false
async function addPictures(files) {
  if (!current || addingPictures) return
  const thread = current // fixed for this whole batch: switching sessions mid-read must not misfile a picture
  addingPictures = true
  renderPending()
  try {
    const list = pending.get(thread) ?? []
    for (const f of files) {
      if (list.length >= PIC_MAX) {
        toast(`이미지는 한 번에 ${PIC_MAX}장까지 보낼 수 있어요`, 'err')
        break
      }
      if (!PIC_TYPES.has(f.type)) {
        toast(`${f.name}: 지원하지 않는 그림 형식이에요`, 'err')
        continue
      }
      if (f.size > PIC_BYTES_MAX) {
        toast(`${f.name}: 10MiB 를 넘어요`, 'err')
        continue
      }
      try {
        const pic = await shrinkPicture(f)
        const total = list.reduce((n, p) => n + p.data.length, 0) + pic.data.length
        if (total > PIC_BASE64_MAX) {
          toast(`${f.name}: 이 메시지에 그림을 더 담을 수 없어요`, 'err')
          continue
        }
        list.push(pic)
      } catch {
        toast(`이미지를 읽지 못했어요: ${f.name}`, 'err')
      }
    }
    pending.set(thread, list)
  } finally {
    addingPictures = false
    renderPending()
  }
}
/** Long side 1,568px at most, JPEG 0.85 on a white backing (a transparent PNG must not turn black),
 *  unless the original is already small (a GIF keeps its frames). */
async function shrinkPicture(f) {
  const dataOf = (blob) => new Promise((res, rej) => Object.assign(new FileReader(), { onload: (e) => res(e.target.result), onerror: rej }).readAsDataURL(blob))
  if (f.size <= 300_000 || f.type === 'image/gif') return { name: f.name, type: f.type, data: await dataOf(f), url: URL.createObjectURL(f) }
  const bmp = await createImageBitmap(f)
  const scale = Math.min(1, 1568 / Math.max(bmp.width, bmp.height))
  const c = Object.assign(document.createElement('canvas'), { width: Math.round(bmp.width * scale), height: Math.round(bmp.height * scale) })
  const ctx = c.getContext('2d')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, c.width, c.height)
  ctx.drawImage(bmp, 0, 0, c.width, c.height)
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85))
  const small = blob && blob.size < f.size ? blob : f
  return { name: f.name, type: small.type, data: await dataOf(small), url: URL.createObjectURL(small) }
}
function renderPending() {
  let box = $('pending')
  if (!box) {
    box = Object.assign(document.createElement('div'), { id: 'pending', className: 'pending' })
    $('chips').before(box)
  }
  const list = (current && pending.get(current)) || []
  box.hidden = !list.length
  box.innerHTML = ''
  list.forEach((p, i) => {
    const t = document.createElement('div')
    t.className = 'thumb'
    t.innerHTML = `<img alt=""><button type="button" aria-label="빼기">${icon('close')}</button>`
    t.firstElementChild.src = p.url
    t.lastElementChild.addEventListener('click', () => {
      list.splice(i, 1)
      renderPending()
    })
    box.append(t)
  })
  // While a batch of pictures is still being read/shrunk (18), sending is blocked — a message should not
  // go out half-attached.
  $('btn-send').disabled = addingPictures || (!input.value.trim() && !list.length)
}

// ------------------------------------------------------------------ composer: input
const input = $('input')
const drafts = store.get('drafts', {})
function saveDraft() {
  if (!current) return
  if (input.value) drafts[current] = input.value
  else delete drafts[current]
  store.set('drafts', drafts)
}
function loadDraft() {
  input.value = drafts[current] ?? ''
  histIndex = null // a different session's history, starting fresh
  autosize()
}
function autosize() {
  input.style.height = 'auto'
  input.style.height = Math.min(input.scrollHeight, 140) + 'px'
  $('btn-send').disabled = addingPictures || (!input.value.trim() && !(current && pending.get(current)?.length))
}
input.addEventListener('input', () => {
  histIndex = null // a real keystroke (programmatic value-setting below fires no 'input' event) leaves history browsing
  repeatArmed = null // edited since the "같은 메시지" warning: no longer the same send
  autosize()
  saveDraft()
})
/** Position while walking ↑/↓ through this session's sent-message history; `null` = not walking it. */
let histIndex = null
input.addEventListener('keydown', (e) => {
  // ↑/↓ walk this session's own sent messages, one at a time, oldest-first on the way back (20; it used
  // to recall only the single last one). Only once the field is empty, or already mid-walk — otherwise a
  // real edit in progress should not be clobbered by the arrow key moving the caret.
  if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && current && !e.isComposing && (histIndex !== null || !input.value)) {
    const hist = store.get('history:' + current, [])
    if (!hist.length) return
    if (e.key === 'ArrowUp') {
      if (histIndex !== null && histIndex >= hist.length - 1) return
      histIndex = histIndex === null ? 0 : histIndex + 1
    } else {
      if (histIndex === null) return
      histIndex = histIndex === 0 ? null : histIndex - 1
    }
    e.preventDefault()
    input.value = histIndex === null ? '' : hist[hist.length - 1 - histIndex]
    autosize()
    return
  }
  if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return
  if (e.metaKey || e.ctrlKey) return // ⌘↵ is "allow", never "send"
  if (e.shiftKey || !hasMouse) return // a newline (a phone keyboard's Enter is always a newline)
  e.preventDefault()
  sendNow()
})
$('btn-send').addEventListener('click', sendNow)
/**
 * Shown the instant "보내기" is pressed, before the broker has echoed the message back over SSE (17):
 * otherwise a slow connection left the composer looking like nothing happened for up to a second. Dropped
 * once a matching real `user` event arrives (apply(), case 'user'), at once on failure, or 5,000 ms after the
 * send was accepted with no match (a `/`·`!` command, say, that never comes back as a `user` row).
 */
let optimistic = null
function showOptimisticBubble(text, imageCount) {
  dropOptimisticBubble()
  const el = document.createElement('div')
  el.className = 'item user optimistic'
  el.innerHTML = `<div class="bubble"></div>`
  el.firstElementChild.textContent = text || `이미지 ${imageCount}장`
  $('log').append(el)
  if (stuck) scrollToBottom()
  optimistic = { text, after: thread(current).last, el, timer: null }
  return optimistic
}
function dropOptimisticBubble() {
  if (!optimistic) return
  clearTimeout(optimistic.timer)
  optimistic.el.remove()
  optimistic = null
}
/** The thread a repeated identical send was just allowed through for — consumed by the next send (20). */
let repeatArmed = null
function shakeComposer() {
  const box = input.closest('.input-box')
  box?.classList.remove('shake')
  void box?.offsetWidth // restart the animation if it's already mid-shake
  box?.classList.add('shake')
}
async function sendNow() {
  const s = current && sessionOf(current)
  const text = input.value.trim()
  const pics = pending.get(current) ?? []
  if (!text && !pics.length) return
  if (!s) return toast('이미 종료된 세션이에요.', 'err')
  const hist = store.get('history:' + current, [])
  // The same text, no pictures, right after itself: probably a double-tap, not two separate messages (20).
  if (!pics.length && hist.at(-1) === text && repeatArmed !== current) {
    repeatArmed = current
    shakeComposer()
    toast('직전 메시지와 같은 메시지예요 · 한 번 더 누르면 보내요')
    return
  }
  repeatArmed = null
  const keep = input.value
  input.value = ''
  pending.delete(current)
  renderPending()
  autosize()
  saveDraft()
  histIndex = null
  if (text && hist.at(-1) !== text) store.set('history:' + current, [...hist, text].slice(-50))
  const bubble = showOptimisticBubble(text, pics.length)
  if (await sendText(s, text, pics)) {
    if (optimistic === bubble) bubble.timer = setTimeout(dropOptimisticBubble, 5000)
    return
  }
  dropOptimisticBubble()
  if (!input.value) input.value = keep // not if something new was typed meanwhile
  if (!pending.get(current)?.length) pending.set(current, pics) // not over pictures picked meanwhile
  renderPending()
  autosize()
  saveDraft()
}
async function sendText(s, text, pics = []) {
  // `/btw` answers from the screen, which the broker's :btw reads back; typed raw it would stay in the terminal.
  const body = /^\/btw\s/.test(text) ? ':' + text.slice(1) : text
  try {
    // By thread (40): a row still starting, waking or dormant has no live pid, but its thread is always there.
    await api(`/api/thread/${encodeURIComponent(s.thread)}/send`, { text: body, ...(pics.length ? { images: pics.map(({ name, type, data }) => ({ name, type, data })) } : {}) }, { timeout: false })
    return true
  } catch (err) {
    toast('보내지 못했어요: ' + err.message, 'err')
    return false
  }
}

// ------------------------------------------------------------------ menus
let menuState = null
function closeMenu() {
  menuState?.scrim.remove()
  menuState?.menu.remove()
  menuState = null
}
/**
 * A bottom sheet (20): starting a touch within 24px of its own top edge (where a drag handle would be —
 * elsewhere is left alone so scrolling a long menu or a textarea inside still works) and dragging down
 * past 80px closes it; less than that snaps back.
 */
function wireSheetDrag(el, close) {
  let y0 = null
  el.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length !== 1 || e.touches[0].clientY - el.getBoundingClientRect().top > 24) return
      y0 = e.touches[0].clientY
    },
    { passive: true },
  )
  el.addEventListener(
    'touchmove',
    (e) => {
      if (y0 == null) return
      const dy = e.touches[0].clientY - y0
      el.style.transform = dy > 0 ? `translateY(${dy}px)` : ''
    },
    { passive: true },
  )
  el.addEventListener('touchend', (e) => {
    if (y0 == null) return
    const dy = (e.changedTouches[0]?.clientY ?? y0) - y0
    el.style.transform = ''
    y0 = null
    if (dy > 80) close()
  })
}

/** A menu at a point (PC) or as a bottom sheet (phone, or no point). Items: {label, icon, run, danger, on, end, sub}, 'sep', {head}. */
function openMenu(at, items, { title } = {}) {
  closeMenu()
  const sheet = isPhone() || !at
  const scrim = document.createElement('div')
  scrim.className = 'scrim' + (sheet ? ' dim' : '')
  const menu = document.createElement('div')
  menu.className = 'menu' + (sheet ? ' sheet' : '')
  menu.setAttribute('role', 'menu')
  const stack = []
  const draw = (list, head) => {
    menu.innerHTML = ''
    if (stack.length) {
      const back = document.createElement('button')
      back.className = 'mi'
      back.type = 'button'
      back.innerHTML = `${icon('back')}<span>${esc(head || '뒤로')}</span>`
      back.addEventListener('click', () => {
        const prev = stack.pop()
        draw(prev.list, prev.head)
      })
      menu.append(back, Object.assign(document.createElement('div'), { className: 'sep' }))
    } else if (title) menu.insertAdjacentHTML('beforeend', `<div class="mhead">${esc(title)}</div>`)
    for (const it of list) {
      if (it === 'sep') {
        menu.insertAdjacentHTML('beforeend', '<div class="sep"></div>')
        continue
      }
      if (it.head) {
        menu.insertAdjacentHTML('beforeend', `<div class="mhead">${esc(it.head)}</div>`)
        continue
      }
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'mi' + (it.danger ? ' danger' : '') + (it.on ? ' on' : '')
      b.setAttribute('role', 'menuitem')
      if (it.cls) b.classList.add(it.cls)
      b.innerHTML = `${icon(it.icon || 'dot')}<span></span>${it.sub ? `<span class="end">${esc(it.end || '')}${icon('chevron')}</span>` : it.on ? `<span class="end">${icon('check')}</span>` : it.end ? `<span class="end">${esc(it.end)}</span>` : ''}`
      b.children[1].textContent = it.label
      b.addEventListener('click', () => {
        if (it.sub) {
          stack.push({ list, head })
          draw(typeof it.sub === 'function' ? it.sub() : it.sub, it.label)
          return
        }
        closeMenu()
        it.run?.()
      })
      menu.append(b)
    }
    if (!sheet) place()
  }
  const place = () => {
    const r = menu.getBoundingClientRect()
    // `end`: the menu's right edge at x (a button at the right). `above`: its bottom edge at y, opening upward.
    const x = at.end ? at.x - r.width : Math.min(at.x, innerWidth - r.width - 8)
    const y = at.above ? Math.max(8, at.y - 6 - r.height) : at.y + r.height > innerHeight - 8 ? Math.max(8, at.y - r.height) : at.y
    menu.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + 'px'
    menu.style.top = y + 'px'
    if (at.above) menu.style.maxHeight = Math.max(160, at.y - 14) + 'px'
  }
  scrim.addEventListener('click', closeMenu)
  scrim.addEventListener('contextmenu', (e) => (e.preventDefault(), closeMenu()))
  if (sheet) wireSheetDrag(menu, closeMenu)
  document.body.append(scrim, menu)
  menuState = { scrim, menu }
  draw(items)
  menu.querySelector('.mi')?.focus({ preventScroll: true })
}

function sessionItems(s) {
  const opt = (list, cur, cmd) => list.map((o) => ({ label: o.label ?? o, icon: 'dot', on: (o.value ?? o) === cur, run: () => command(s, `${cmd} ${o.value ?? o}`) }))
  return [
    { label: '열기', icon: 'chat', run: () => open(s.thread) },
    { label: '이름 변경', icon: 'edit', run: () => renameSession(s) },
    {
      label: '설정 (모델·권한)',
      icon: 'tool',
      sub: () => [
        { label: '모델', icon: 'bot', end: s.model || '', sub: () => opt(options.models, s.model, 'model') },
        { label: 'effort', icon: 'spark', end: s.effort || '', sub: () => opt(options.efforts, s.effort, 'effort') },
        { label: '권한 모드', icon: 'lock', end: s.permissionMode || '', sub: () => opt(options.modes, s.permissionMode, 'mode') },
        'sep',
        { label: '상태 새로 읽기', icon: 'refresh', run: () => command(s, 'status') },
      ],
    },
    { label: '복제', icon: 'copy', run: () => forkSession(s) },
    { label: '가벼운 복제', icon: 'copy', run: () => command(s, 'lightfork') },
    { label: s.resting ? '휴면 풀기' : '휴면으로 두기', icon: 'dot', run: () => command(s, s.resting ? 'rest off' : 'rest on') },
    { label: '새로고침', icon: 'refresh', run: () => refreshSession(s) },
    {
      label: `그룹: ${groups.groups.find((g) => g.items.includes(s.thread))?.name ?? '없음'}`,
      icon: 'folder',
      sub: () => [
        ...groups.groups.map((g) => ({ label: g.name, icon: 'folder', on: g.items.includes(s.thread), run: () => groupOp({ op: 'move', thread: s.thread, group: g.id }) })),
        ...(groups.groups.some((g) => g.items.includes(s.thread)) ? [{ label: '그룹에서 빼기', icon: 'undo', run: () => groupOp({ op: 'move', thread: s.thread, group: null }) }] : []),
        'sep',
        { label: '새 그룹…', icon: 'plus', run: () => newGroup(s.thread) },
      ],
    },
    { label: s.autoAllow ? '전부 허용 끄기' : '전부 허용 켜기', icon: 'bolt', on: s.autoAllow, run: () => toggleAuto(s) },
    'sep',
    { label: '종료', icon: 'ended', danger: true, run: () => confirm(`"${nameOf(s)}" 세션을 종료할까요?`) && command(s, 'exit') },
    { label: '폴더 버리고 종료', icon: 'folder', danger: true, run: () => trashFolder(s) },
    { label: '강제 종료', icon: 'deny', danger: true, run: () => confirm('tmux 창을 닫아 강제로 끝낼까요?') && api(`/api/session/${s.pid}/kill`, {}).then((r) => toast(r.note), (e) => toast(e.message, 'err')) },
  ]
}
/** Say what would be lost (per repository), then end the session and move its folder to the Trash. */
async function trashFolder(s) {
  let info
  try {
    info = await api(`/api/session/${s.pid}/trash-info`)
  } catch (err) {
    return toast(err.message, 'err')
  }
  if (!info.ok) return toast(info.note, 'err')
  const home = (p) => p.replace(/^\/Users\/[^/]+/, '~')
  const lines = (info.repos || []).map((r) => `• ${home(r.path)}: ${r.uncommitted ? `커밋 안 한 변경 ${r.uncommitted}개` : '변경 없음'}, ${r.unpushed ? `push 안 한 커밋 ${r.unpushed}개` : 'push 안 한 커밋 없음'}`)
  const risky = (info.repos || []).some((r) => r.uncommitted || r.unpushed)
  const msg = [`${home(info.folder)} 폴더를 휴지통으로 옮기고 세션을 끝낼까요?`, '', ...(lines.length ? lines : ['(git 저장소 없음)']), ...(risky ? ['', '⚠ 저장하지 않은 작업이 있어요. 휴지통에서 되살릴 수는 있어요.'] : [])].join('\n')
  if (!confirm(msg)) return
  try {
    toast((await api(`/api/session/${s.pid}/trash`, { path: info.folder })).note)
  } catch (err) {
    toast(err.message, 'err')
  }
}
async function forkSession(s) {
  try {
    const r = await api(`/api/session/${s.pid}/fork`, {})
    toast(r.note)
    if (r.thread) open(r.thread)
  } catch (err) {
    toast(err.message, 'err')
  }
}
/**
 * A refresh ends the Claude process and reopens the conversation; background commands, Monitors and agents it
 * started die with it. While it works (or has such work), offer "끝나면 새로고침" (default) or "지금 새로고침".
 */
async function refreshSession(s) {
  let info = { busy: s.state === 'busy', tasks: [] }
  try {
    info = await api(`/api/session/${s.pid}/refresh-info`)
  } catch {}
  if (!info.busy && !info.tasks.length) return command(s, 'refresh now')
  const scrim = document.createElement('div')
  scrim.className = 'scrim dim'
  const el = document.createElement('div')
  el.className = 'menu sheet choice-sheet'
  el.setAttribute('role', 'dialog')
  el.setAttribute('aria-modal', 'true')
  const kinds = { bash: '명령', monitor: 'Monitor', agent: '에이전트' }
  const list = info.tasks.map((t) => `<li>${esc(kinds[t.kind] ?? t.kind)}: ${esc(t.label)}</li>`).join('')
  el.innerHTML = `<div class="ns-head"><h2>새로고침</h2></div>
    <p class="hint">${info.busy ? '지금 작업 중이에요. ' : ''}${info.tasks.length ? `지금 하면 백그라운드 작업 ${info.tasks.length}개가 끊겨요.` : ''}</p>
    ${list ? `<ul class="bg-list">${list}</ul>` : ''}
    <div class="choice-actions"><button class="btn primary" type="button" data-x="later">끝나면 새로고침</button><button class="btn" type="button" data-x="now">지금 새로고침</button></div>`
  const close = () => (scrim.remove(), el.remove())
  scrim.addEventListener('click', close)
  el.querySelector('[data-x="later"]').addEventListener('click', () => (close(), command(s, 'refresh later')))
  el.querySelector('[data-x="now"]').addEventListener('click', () => (close(), command(s, 'refresh now')))
  wireSheetDrag(el, close)
  document.body.append(scrim, el)
  el.querySelector('[data-x="later"]').focus()
}
async function toggleAuto(s) {
  const on = !s.autoAllow
  if (on && !confirm('전부 허용을 켤까요?\n권한 요청을 묻지 않고 브로커가 바로 허용합니다. 허용한 내용은 대화에 남아요.')) return
  await command(s, on ? 'auto on' : 'auto off')
}

// Usage statistics (53): the numbers the broker works out from the logs, for 1, 7, 30 or 90 days.
async function openStats(days) {
  document.querySelector('.stats-window')?.remove()
  const win = document.createElement('div')
  win.className = 'stats-window'
  const fmt = (ms) => (ms == null ? '–' : ms >= 3_600_000 ? `${Math.floor(ms / 3_600_000)}시간 ${Math.round((ms % 3_600_000) / 60_000)}분` : ms >= 60_000 ? `${Math.round(ms / 60_000)}분` : `${Math.round(ms / 1000)}초`)
  win.innerHTML = `<div class="stats-card" role="dialog" aria-modal="true"><div class="stats-head"><b>사용 통계</b><div class="stats-days">${[1, 7, 30, 90].map((d) => `<button type="button" data-d="${d}" class="${d === days ? 'on' : ''}">${d}일</button>`).join('')}</div><button type="button" class="icon-btn" data-act="close" aria-label="닫기">${icon('close')}</button></div><div class="stats-body">불러오는 중…</div></div>`
  win.querySelector('[data-act="close"]').addEventListener('click', () => win.remove())
  win.querySelectorAll('[data-d]').forEach((b) => b.addEventListener('click', () => openStats(Number(b.dataset.d))))
  document.body.append(win)
  try {
    const s = await api(`/api/stats?days=${days}`)
    const max = Math.max(1, ...s.daily.map((d) => d.workMs))
    win.querySelector('.stats-body').innerHTML = `
      <div class="stats-grid">
        <div><span>총 작업 시간</span><b>${fmt(s.totals.work)}</b></div>
        <div><span>바쁜 시간</span><b>${fmt(s.totals.busy)}</b></div>
        <div><span>평균 동시성</span><b>${s.totals.avgConcurrency}</b></div>
        <div><span>최대 동시</span><b>${s.totals.peakConcurrency}</b></div>
        <div><span>턴 길이 중앙값</span><b>${fmt(s.turns.medianMs)}</b></div>
        <div><span>턴 p90</span><b>${fmt(s.turns.p90Ms)}</b></div>
        <div><span>도구 호출</span><b>${s.tools}</b></div>
        <div><span>권한 요청</span><b>${s.permissions}</b></div>
      </div>
      <h4>날마다</h4>
      ${s.daily.map((d) => `<div class="stats-row"><span>${d.day.slice(5)}</span><i style="width:${Math.round((d.workMs / max) * 100)}%"></i><em>${fmt(d.workMs)} · 내 글 ${d.mine} · 세션 ${d.sessions}</em></div>`).join('') || '<p class="stats-none">기록이 없어요</p>'}
      <h4>많이 쓴 폴더</h4>
      ${s.topFolders.map((f) => `<div class="stats-row"><span>${esc(folderOf(f.cwd))}</span><em>${fmt(f.workMs)}</em></div>`).join('') || '<p class="stats-none">없어요</p>'}
      <h4>많이 쓴 도구</h4>
      ${s.topTools.map((t) => `<div class="stats-row"><span>${esc(t.name)}</span><em>${t.count}회</em></div>`).join('') || '<p class="stats-none">없어요</p>'}`
  } catch (err) {
    win.querySelector('.stats-body').textContent = err.message
  }
}
function globalItems() {
  const theme = store.get('theme', 'auto')
  const items = [
    { label: '새 세션', icon: 'plus', run: newSession },
    { label: '사용 통계', icon: 'spark', run: () => openStats(7) },
    { label: '문제가 생겼을 때 · 복구 가이드', icon: 'undo', run: () => window.open('/recovery', '_blank') },
    { label: '새 그룹', icon: 'folder', run: () => newGroup() },
    { label: '기본 프롬프트', icon: 'edit', run: editDefaultPrompt },
    {
      label: '테마',
      icon: theme === 'dark' ? 'moon' : 'sun',
      end: { auto: '자동', light: '밝게', dark: '어둡게' }[theme],
      sub: () => [
        { label: '자동', icon: 'refresh', on: theme === 'auto', run: () => applyTheme('auto') },
        { label: '밝게', icon: 'sun', on: theme === 'light', run: () => applyTheme('light') },
        { label: '어둡게', icon: 'moon', on: theme === 'dark', run: () => applyTheme('dark') },
      ],
    },
    { label: '이전 관리 화면', icon: 'screen', run: () => (location.href = withToken('/admin')) },
    ...(newVersionSeen ? [{ label: '새 버전이 나왔어요 · 새로고침', icon: 'refresh', run: () => location.reload() }] : []),
  ]
  const s = current && sessionOf(current)
  // This session's items, without the destructive ones (강제 종료, 폴더 버리고 종료): those stay in its own menu.
  if (s) items.push('sep', { head: '이 세션' }, ...sessionItems(s).filter((x) => x !== 'sep' && x.label !== '열기' && x.label !== '강제 종료' && x.label !== '폴더 버리고 종료'))
  return items
}
// ---- ⌘K: find a session. "새 세션" first, then running sessions filtered by name, state, folder, first message.
function openFinder() {
  closeMenu()
  const scrim = document.createElement('div')
  scrim.className = 'scrim dim'
  const el = document.createElement('div')
  el.className = 'finder'
  el.setAttribute('role', 'dialog')
  el.setAttribute('aria-modal', 'true')
  el.innerHTML = `<input class="search" placeholder="세션 찾기" aria-label="세션 찾기"><div class="finder-list" role="listbox"></div>`
  const q = el.querySelector('input')
  let items = []
  let sel = 0
  const draw = () => {
    const t = q.value.trim().toLowerCase()
    const found = sessions.filter((s) => !t || [nameOf(s), STATE[s.state], s.waiting, s.cwd, s.preview].some((v) => (v || '').toLowerCase().includes(t)))
    items = [{ label: '새 세션', icon: 'plus', run: newSession }, ...found.map((s) => ({ label: nameOf(s), sub: `${STATE[s.state] ?? ''} · ${folderOf(s.cwd)}`, icon: 'chat', run: () => open(s.thread) }))]
    sel = Math.max(0, Math.min(sel, items.length - 1))
    const box = el.querySelector('.finder-list')
    box.innerHTML = ''
    items.forEach((it, i) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'mi' + (i === sel ? ' sel' : '')
      b.innerHTML = `${icon(it.icon)}<span class="fl"></span><span class="end"></span>`
      b.querySelector('.fl').textContent = it.label
      b.querySelector('.end').textContent = it.sub ?? ''
      b.addEventListener('click', () => (close(), it.run()))
      box.append(b)
    })
    box.children[sel]?.scrollIntoView({ block: 'nearest' })
  }
  const close = () => (scrim.remove(), el.remove())
  // Typing a query highlights its first match; "새 세션" stays at the top, one ↑ away.
  q.addEventListener('input', () => ((sel = q.value.trim() ? 1 : 0), draw()))
  q.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
      draw()
    } else if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault()
      const it = items[sel]
      close()
      it?.run()
    } else if (e.key === 'Escape') close()
  })
  scrim.addEventListener('click', close)
  document.body.append(scrim, el)
  draw()
  q.focus()
}

// ---- Another session waits for a permission: ask here, whatever screen this is. Dismissed by tapping outside,
// that request is not asked again. The session on screen shows its own card instead.
let permModal = null
// Kept across reloads: a request dismissed once is not asked again.
const dismissedPerms = new Set(store.get('dismissed-perms', []))
const dismissPerm = (ts) => {
  dismissedPerms.add(ts)
  store.set('dismissed-perms', [...dismissedPerms].slice(-200))
}
function checkPermissionModal() {
  if (permModal) {
    const still = sessions.some((s) => s.permission?.ts === permModal.dataset.ts && s.thread !== current)
    if (still) return
    permModal.remove()
    permModal.scrim?.remove()
    permModal = null
  }
  const s = sessions.find((x) => x.permission && x.thread !== current && !dismissedPerms.has(x.permission.ts))
  if (!s) return
  const scrim = document.createElement('div')
  scrim.className = 'scrim dim'
  const el = document.createElement('div')
  el.className = 'perm-modal'
  el.setAttribute('role', 'dialog')
  el.setAttribute('aria-modal', 'true')
  el.dataset.ts = s.permission.ts
  el.innerHTML = `<div class="pm-head">${icon('lock')}<div><div class="pm-name"></div><div class="pm-where"></div></div></div>`
  el.querySelector('.pm-name').textContent = nameOf(s)
  el.querySelector('.pm-where').textContent = folderOf(s.cwd)
  el.append(cardEl({ ts: s.permission.ts, text: s.permission.text, blocks: s.permission.blocks, at: Date.now() }, s.permission.blocks))
  const go = document.createElement('button')
  go.type = 'button'
  go.className = 'btn'
  go.textContent = '세션으로 가기'
  go.addEventListener('click', () => {
    dismissPerm(s.permission.ts)
    open(s.thread)
  })
  el.querySelector('.actions')?.append(go)
  scrim.addEventListener('click', () => {
    dismissPerm(s.permission.ts)
    scrim.remove()
    el.remove()
    permModal = null
    checkPermissionModal()
  })
  el.scrim = scrim
  document.body.append(scrim, el)
  permModal = el
}

/** The instruction every new or reopened session gets, edited in a sheet. */
async function editDefaultPrompt() {
  let text = ''
  let isDefault = false
  try {
    const info = await api('/api/default-prompt')
    text = info.text
    isDefault = !!info.isDefault
  } catch {}
  const scrim = document.createElement('div')
  scrim.className = 'scrim dim'
  const el = document.createElement('div')
  el.className = 'menu sheet prompt-sheet'
  el.setAttribute('role', 'dialog')
  el.setAttribute('aria-modal', 'true')
  el.innerHTML = `<div class="ns-head"><h2>기본 프롬프트</h2></div><p class="hint">모든 세션에 넣는 지시예요(예: "한국어로 답해"). 새로 띄우거나 다시 연 세션부터 적용돼요. 비우면 넣지 않아요.</p><textarea class="ns-prompt" rows="6"></textarea><div class="ns-actions"><button class="btn" type="button" data-x="cancel">취소</button><button class="btn primary" type="button" data-x="save">저장</button></div>`
  el.querySelector('textarea').value = text
  // The built-in prompt is marked, and a button takes the edit back to it (54).
  el.querySelector('.ns-head').insertAdjacentHTML('beforeend', `<span class="hint">${isDefault ? '기본값' : ''}</span><button type="button" class="ghost" data-x="reset">기본값으로</button>`)
  el.querySelector('[data-x="reset"]').addEventListener('click', async () => {
    // A blank save is the built-in prompt again; the page shows what it now holds.
    try {
      await api('/api/default-prompt', { text: '' })
      el.querySelector('textarea').value = (await api('/api/default-prompt')).text
      el.querySelector('.hint').textContent = '기본값'
    } catch (err) {
      toast(err.message, 'err')
    }
  })
  const close = () => (scrim.remove(), el.remove())
  scrim.addEventListener('click', close)
  el.querySelector('[data-x="cancel"]').addEventListener('click', close)
  el.querySelector('[data-x="save"]').addEventListener('click', async () => {
    try {
      toast((await api('/api/default-prompt', { text: el.querySelector('textarea').value })).note)
      close()
    } catch (err) {
      toast(err.message, 'err')
    }
  })
  wireSheetDrag(el, close)
  document.body.append(scrim, el)
  el.querySelector('textarea').focus()
}
// Under the button, right edges lined up (bottom-end).
$('btn-more').addEventListener('click', (e) => {
  const r = e.currentTarget.getBoundingClientRect()
  openMenu({ x: r.right, y: r.bottom + 4, end: true }, globalItems())
})
const clearRecentItem = () => ({ label: '이어서 하기 비우기', icon: 'undo', run: () => confirm('이어서 하기 목록을 비울까요?\n맥의 대화 파일은 지우지 않고, 지금까지의 것을 목록에서만 숨겨요(다시 쓰면 다시 보여요).') && groupOp({ op: 'clearRecent' }).then(loadSideLists) })
const clearArchivesItem = () => ({ label: '지난 기록 모두 지우기', icon: 'deny', danger: true, run: () => confirm('지난 기록을 모두 지울까요? 실행 중인 세션의 기록은 남겨요.') && api('/api/archives/clear', {}).then((r) => (toast(r.note), loadSideLists()), (e) => toast(e.message, 'err')) })
// ------------------------------------------------------------------ notification center (49)
// The newest three show at the top right (PC) or top (phone), then "N개 더". A tap opens the session and clears
// the notice; a drag to the left of 80 px, or the close button, clears it without opening anything.
function renderNotices() {
  let box = document.getElementById('notices')
  if (!box) {
    box = document.createElement('div')
    box.id = 'notices'
    box.className = 'notices'
    box.setAttribute('aria-live', 'polite')
    document.body.append(box)
  }
  box.hidden = !notices.length
  box.innerHTML = ''
  const shownNotices = showAllNotices ? notices : notices.slice(0, 3)
  for (const n of shownNotices) {
    const el = document.createElement('div')
    el.className = `notice-card ${n.tone}`
    el.innerHTML = `<button type="button" class="nc-body"><b>${esc(n.title)}</b><span>${esc(n.text)}</span></button><button type="button" class="nc-x" aria-label="지우기">×</button>`
    el.querySelector('.nc-body').addEventListener('click', () => {
      api('/api/notices/dismiss', { id: n.id }).catch(() => {})
      open(n.thread)
    })
    el.querySelector('.nc-x').addEventListener('click', () => api('/api/notices/dismiss', { id: n.id }).catch(() => {}))
    let x0 = null
    el.addEventListener('pointerdown', (e) => (x0 = e.clientX))
    el.addEventListener('pointerup', (e) => {
      if (x0 !== null && x0 - e.clientX > 80) api('/api/notices/dismiss', { id: n.id }).catch(() => {})
      x0 = null
    })
    box.append(el)
  }
  if (notices.length > 3 && !showAllNotices) {
    const more = document.createElement('button')
    more.type = 'button'
    more.className = 'nc-more'
    more.textContent = `${notices.length - 3}개 더`
    more.addEventListener('click', () => {
      showAllNotices = true
      renderNotices()
    })
    box.append(more)
  }
}
let showAllNotices = false

// ------------------------------------------------------------------ new session
// A PC gets it as the right-hand pane (not a sheet), a phone as a sheet from the bottom.
let newForm = null
function closeNewSession() {
  if (!newForm) return
  newForm.close()
  newForm = null
}
function newSession() {
  closeNewSession()
  closeMenu()
  const el = document.createElement('section')
  el.className = 'newsess'
  el.innerHTML = `
    <div class="ns-head"><h2>새 세션</h2><button class="icon-btn ns-close" type="button" aria-label="닫기">${icon('close')}</button></div>
    <textarea class="ns-prompt" rows="4" placeholder="무엇을 할까요? (비워 두고 시작해도 돼요)"></textarea>
    <label class="ns-label">폴더</label>
    <div class="ns-path"><button class="icon-btn ns-up" type="button" aria-label="상위 폴더">${icon('up')}</button><input class="search ns-cwd" spellcheck="false" autocomplete="off"></div>
    <div class="ns-dirs" role="listbox" aria-label="하위 폴더"></div>
    <div class="ns-row">
      <label>모델 <select class="ns-model"><option value="">기본</option>${options.models.map((m) => `<option value="${esc(m.value)}">${esc(m.label)}</option>`).join('')}</select></label>
      <label>effort <select class="ns-effort"><option value="">기본</option>${options.efforts.map((e) => `<option>${esc(e)}</option>`).join('')}</select></label>
    </div>
    <div class="ns-missing" hidden></div>
    <div class="ns-actions"><button class="btn primary ns-start" type="button">시작</button></div>`
  const q = (c) => el.querySelector(c)
  const cwdInput = q('.ns-cwd')
  let parent = null
  const browse = async (path) => {
    let r
    try {
      r = await api('/api/folders' + (path ? '?path=' + encodeURIComponent(path) : ''))
    } catch (err) {
      return toast(err.message, 'err')
    }
    if (!r.ok) return toast(r.note, 'err')
    cwdInput.value = r.path
    parent = r.parent ?? null
    q('.ns-up').disabled = !parent
    const box = q('.ns-dirs')
    box.innerHTML = r.dirs.length ? '' : '<div class="empty-note">하위 폴더가 없어요</div>'
    for (const d of r.dirs) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'row'
      b.innerHTML = `<span class="lead">${icon('folder')}</span><span class="name"></span>${d.git ? '<span class="badge idle">git</span>' : ''}`
      b.querySelector('.name').textContent = d.name
      b.addEventListener('click', () => browse(r.path + '/' + d.name))
      box.append(b)
    }
    q('.ns-missing').hidden = true
  }
  q('.ns-up').addEventListener('click', () => parent && browse(parent))
  cwdInput.addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), browse(cwdInput.value.trim())))
  const start = async (create = false) => {
    const body = { cwd: cwdInput.value.trim(), prompt: q('.ns-prompt').value, model: q('.ns-model').value, effort: q('.ns-effort').value, ...(create ? { create: true } : {}) }
    q('.ns-start').disabled = true
    try {
      const r = await api('/api/session/new', body)
      toast(r.note)
      closeNewSession()
      if (r.thread) open(r.thread)
    } catch (err) {
      if (err.data?.missing) {
        const m = q('.ns-missing')
        m.hidden = false
        m.innerHTML = `<span>${icon('alert')} 폴더가 없어요</span>`
        const make = document.createElement('button')
        make.type = 'button'
        make.className = 'btn'
        make.textContent = '폴더를 만들고 시작'
        make.addEventListener('click', () => confirm(`${cwdInput.value.trim()} 폴더를 만들고 시작할까요?`) && start(true))
        m.append(make)
      } else toast(err.message, 'err')
    } finally {
      q('.ns-start').disabled = false
    }
  }
  q('.ns-start').addEventListener('click', () => start())
  q('.ns-prompt').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && hasMouse && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault()
      start()
    }
  })
  q('.ns-close').addEventListener('click', closeNewSession)
  if (isPhone()) {
    const scrim = document.createElement('div')
    scrim.className = 'scrim dim'
    el.classList.add('menu', 'sheet')
    scrim.addEventListener('click', closeNewSession)
    wireSheetDrag(el, closeNewSession)
    document.body.append(scrim, el)
    newForm = { close: () => (scrim.remove(), el.remove()) }
  } else {
    const hidden = [$('empty'), $('convo'), $('subbar')].map((x) => [x, x.hidden])
    for (const [x] of hidden) x.hidden = true
    $('main').append(el)
    $('title').textContent = '새 세션'
    newForm = { close: () => (el.remove(), hidden.forEach(([x, h]) => (x.hidden = h)), renderHeader()) }
  }
  browse('')
  q('.ns-prompt').focus()
}
$('btn-new').addEventListener('click', newSession)
$('btn-new-big').addEventListener('click', newSession)

// ------------------------------------------------------------------ keys
/** Anything on top that Esc should close instead: a menu, a dialog or sheet, a picture or HTML shown large. */
const overlayOpen = () => !!document.querySelector('[role="dialog"], [role="menu"], [aria-modal="true"], .viewer, .hp-full, .finder, .newsess.sheet')
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && menuState) return closeMenu()
  // Esc on a PC stops the session being watched, like the 중단 chip: not over a menu or dialog, not while
  // composing Korean, not a held-down key.
  // Only a busy session: waiting on a permission or a question, Esc would cancel or deny that dialog. And not from
  // a text field, where Esc belongs to the field.
  const inField = e.target instanceof HTMLElement && (e.target.matches('input, textarea, select') || e.target.isContentEditable)
  if (e.key === 'Escape' && hasMouse && current && !e.isComposing && !e.repeat && !overlayOpen() && !inField) {
    const s = sessionOf(current)
    if (s && s.state === 'busy') {
      e.preventDefault()
      command(s, 'esc')
      toast('중단했어요')
      return
    }
  }
  const mod = isMac ? e.metaKey : e.ctrlKey
  if (mod && e.key === '\\') {
    e.preventDefault()
    setCollapsed(!$('app').classList.contains('collapsed'))
    return
  }
  if (mod && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    return openFinder()
  }
  // ⌥↑ / ⌥↓: the previous or next session, in the order the sidebar shows them.
  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    const order = [...$('list').querySelectorAll('.row[data-thread]')].map((r) => r.dataset.thread)
    if (!order.length) return
    e.preventDefault()
    const i = order.indexOf(current)
    const next = order[(i < 0 ? 0 : i + (e.key === 'ArrowDown' ? 1 : -1) + order.length) % order.length]
    if (next && next !== current) open(next)
    return
  }
  // In the permission modal, ⌘↵ allows what it asks.
  if (e.key === 'Enter' && mod && permModal) {
    e.preventDefault()
    permModal.querySelector('button[data-action^="perm_allow"]')?.click()
    return
  }
  // ⌘/Ctrl+Enter presses "허용" on the newest permission card of the open session.
  if (e.key === 'Enter' && mod && current) {
    const b = [...$('log').querySelectorAll('button[data-action^="perm_allow"]:not(:disabled)')].at(-1)
    if (b) {
      e.preventDefault()
      b.click()
    }
  }
})

// ------------------------------------------------------------------ start
window.__ready = true
// A boot cover shown for an error that turned out not to stop the app goes away.
document.getElementById('boot-crash')?.remove()
// Draw the last known list before the stream answers, so a reload never starts empty.
sessions = store.get('sessions-cache', [])
renderList()
connect()
renderConn()
loadSideLists()
setInterval(loadSideLists, 60_000)
api('/api/options').then((o) => (options = o), () => {})
const start = location.hash.slice(1)
if (/^\d+\.\d+$/.test(start)) open(start, { push: false })

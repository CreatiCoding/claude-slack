// The web app: the same sessions as the Slack threads, driven through the broker that serves this page.
// Server → page: one EventSource (/api/stream) with the session list and every session event.
// Page → server: plain POSTs. Buttons on broker cards post their Slack action, so a press here runs
// exactly what a click in Slack runs.
import { esc, linkify, md, mrkdwn } from './markdown.js'
import { icon, takeEmoji, toolIcon } from './icons.js'
import { getImage, loadTimeline, putImage, saveTimeline } from './idb.js'

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
let archives = []
let options = { models: [], efforts: [], modes: [] }
/** thread → { events: [], last: 0, loading } */
const threads = new Map()
let current = null // thread ts
const seen = store.get('seen', {})
const folded = store.get('folded', { recent: true, archives: true })

function thread(ts) {
  let t = threads.get(ts)
  if (!t) threads.set(ts, (t = { events: [], last: 0, loading: null }))
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
async function api(path, body) {
  let r
  try {
    r = await fetch(withToken(path), body === undefined ? { headers: authHeaders } : { method: 'POST', headers: { ...authHeaders, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  } catch {
    throw new Error(body === undefined ? '연결할 수 없어요' : '전달됐는지 확인할 수 없어요. 대화를 보고 필요하면 다시 보내 주세요')
  }
  if (AWAY.has(r.status) && body !== undefined) {
    brokerAway()
    return new Promise((resolve, reject) => {
      const job = { path, body, resolve, reject, until: Date.now() + 60_000 }
      waitingCommands.push(job)
    })
  }
  let data = {}
  try {
    data = await r.json()
  } catch {}
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
function reportError(where, err) {
  const message = String(err?.message ?? err ?? '알 수 없는 오류').slice(0, 500)
  const key = where + '|' + message
  if (Date.now() - (reported.get(key) ?? 0) < 60_000) return
  reported.set(key, Date.now())
  try {
    fetch(withToken('/api/client-error'), {
      method: 'POST',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ where, message, stack: String(err?.stack ?? '').slice(0, 4000), view: isPhone() ? 'phone' : 'pc', url: location.pathname + location.hash, ua: navigator.userAgent.slice(0, 200) }),
    }).catch(() => {})
  } catch {}
}
addEventListener('error', (e) => reportError('window', e.error ?? e.message))
addEventListener('unhandledrejection', (e) => reportError('promise', e.reason))

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
    connId = JSON.parse(e.data).conn
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
  // After the first full list, only the sessions that changed, with the order as thread keys.
  on('sessions_delta', (e) => {
    metrics.recvBytes += e.data.length
    metrics.recvEvents++
    const { order, changed } = JSON.parse(e.data)
    const by = new Map(sessions.map((s) => [s.thread, s]))
    for (const s of changed) by.set(s.thread, s)
    applySessions(order.map((k) => by.get(k)).filter(Boolean))
  })
  // What is being written right now (not stored): the activity box shows its last two lines.
  on('live', (e) => {
    const { thread: ts, text } = JSON.parse(e.data)
    if (ts !== current || !view) return
    view.live = text
    view.liveAt ??= Date.now()
    if (!text) view.liveAt = null
    renderActivity()
  })
  on('ev', (e) => {
    metrics.recvBytes += e.data.length
    metrics.recvEvents++
    const { thread: ts, ev } = JSON.parse(e.data)
    if (ts !== current) return // switched away a moment ago; its catch-up covers it next time
    const t = thread(ts)
    if (t.loading) return
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
function renderConn() {
  const el = $('conn')
  const quiet = connected || (lostAt && Date.now() - lostAt < (restarting ? 30_000 : 8_000))
  el.textContent = quiet ? '' : '연결이 끊겼어요 · 다시 붙는 중…'
  el.classList.toggle('bad', !quiet)
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
      t.loading = null
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
  keepTimer = setTimeout(() => saveTimeline(ts, thread(ts).events), 1000)
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
  const text = s.state === 'waiting' ? (isPhone() ? s.waiting || STATE.waiting : waitedFor(s)) : STATE[s.state] || s.state
  return `<span class="badge ${s.state}">${esc(text)}</span>`
}

function secHead(key, label, n, { group, dropOut } = {}) {
  const open = !folded[key]
  const el = document.createElement('div')
  el.className = 'sec-head' + (open ? ' open' : '') + (group ? ' group' : '')
  el.setAttribute('role', 'button')
  el.innerHTML = `<span class="tw">${icon('chevron')}</span><span class="gname"></span><span class="n">${n}</span>${group ? `<button class="gmore" type="button" aria-label="그룹 메뉴">${icon('more')}</button>` : ''}`
  el.querySelector('.gname').textContent = label
  el.addEventListener('click', (e) => {
    if (e.target.closest('.gmore')) return
    folded[key] = open
    store.set('folded', folded)
    renderList()
  })
  if (group) {
    const menu = (at) => openMenu(at, groupItems(group))
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
    { label: '그룹 삭제', icon: 'deny', danger: true, run: () => confirm(`"${g.name}" 그룹을 지울까요? 안의 세션은 그대로 남아요.`) && groupOp({ op: 'delete', id: g.id }) },
  ]
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
  list.innerHTML = ''

  const shown = sessions.filter((s) => match(s.title, s.preview, s.cwd, s.last?.text))
  const byThread = new Map(shown.map((s) => [s.thread, s]))
  const grouped = new Set(groups.groups.flatMap((g) => g.items))
  // Groups first, each in its own order; then the rest: the order they were put in, then waiting first, newest first.
  for (const g of groups.groups) {
    const members = g.items.map((t) => byThread.get(t)).filter(Boolean)
    const h = secHead('g:' + g.id, g.name, members.length, { group: g })
    list.append(h.el)
    if (h.open) for (const s of members) list.append(liveRow(s, g.id))
  }
  const loose = groups.loose || []
  const rank = (s) => (loose.includes(s.thread) ? loose.indexOf(s.thread) : Infinity)
  const live = shown.filter((s) => !grouped.has(s.thread)).sort((a, b) => rank(a) - rank(b) || (b.state === 'waiting') - (a.state === 'waiting') || b.lastAt - a.lastAt)
  const h = secHead('live', '진행 중', live.length, { dropOut: true })
  list.append(h.el)
  if (h.open) {
    for (const s of live) list.append(liveRow(s, null))
    if (!live.length) list.insertAdjacentHTML('beforeend', `<div class="empty-note">${q ? '찾는 세션이 없어요' : '떠 있는 세션이 없어요'}</div>`)
  }

  const rec = recent.filter((r) => match(r.title, r.preview, r.cwd))
  const hr = secHead('recent', '이어서 하기', rec.length, { dropOut: true })
  list.append(hr.el)
  if (hr.open)
    for (const r of rec)
      list.append(
        plainRow({ lead: icon('play'), name: r.title, sub: r.preview, where: `${folderOf(r.cwd)} · ${ago(r.mtime)}`, when: ago(r.mtime), title: `${r.cwd}\n${r.preview || ''}` }, () => resume(r), (at) => openMenu(at, [{ label: '이어서 하기', icon: 'play', run: () => resume(r) }])),
      )

  const arc = archives.filter((a) => match(a.title, a.preview, a.cwd))
  const ha = secHead('archives', '지난 기록', arc.length)
  list.append(ha.el)
  if (ha.open)
    for (const a of arc) {
      const at = Date.parse(a.archivedAt)
      list.append(plainRow({ lead: icon('clipboard'), name: a.title || folderOf(a.cwd), sub: a.preview, where: `${folderOf(a.cwd)} · ${ago(at)}`, when: ago(at), title: a.cwd }, () => viewArchive(a), (p) => openMenu(p, [{ label: '기록 보기', icon: 'file', run: () => viewArchive(a) }])))
    }
  list.scrollTop = keepScroll
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
  let press = null
  let startX = 0
  let swiped = false
  row.addEventListener('click', () => {
    if (swiped) return void (swiped = false)
    onOpen()
  })
  row.addEventListener('keydown', (e) => e.key === 'Enter' && onOpen())
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    onMenu({ x: e.clientX, y: e.clientY })
  })
  row.addEventListener('touchstart', (e) => {
    startX = e.touches[0].clientX
    press = setTimeout(() => {
      press = null
      swiped = true
      onMenu(null)
    }, 500)
  }, { passive: true })
  row.addEventListener('touchmove', (e) => {
    const dx = e.touches[0].clientX - startX
    if (Math.abs(dx) > 10 && press) clearTimeout(press), (press = null)
    if (dx < -60 && !swiped) {
      swiped = true
      onMenu(null)
    }
  }, { passive: true })
  row.addEventListener('touchend', () => press && (clearTimeout(press), (press = null)))
}
$('search').addEventListener('input', renderList)
setInterval(() => {
  renderList()
  renderHeader()
}, 30_000)

async function resume(r) {
  try {
    const res = await api('/api/session/resume', { id: r.id })
    toast(res.note)
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
  current = ts
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
  scrollToBottom()
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
}
$('btn-back').addEventListener('click', () => (history.state?.thread ? history.back() : closeConvo()))
addEventListener('popstate', (e) => {
  if (e.state?.thread) open(e.state.thread, { push: false })
  else closeConvo()
})

function renderHeader() {
  const s = current && sessionOf(current)
  const title = $('title')
  title.textContent = s ? nameOf(s) : current ? '종료된 세션' : 'Claude'
  title.disabled = !s
  title.title = s ? '이름 변경' : ''
  const sub = $('subbar')
  sub.hidden = !current
  if (current) {
    $('badge').innerHTML = s ? badgeHtml(s) + (s.autoAllow ? ` <span class="badge auto">${icon('bolt')}전부 허용</span>` : '') : `<span class="badge ended">${STATE.ended}</span>`
    $('meta').textContent = s ? [s.model, s.effort, s.permissionMode, s.contextLabel].filter(Boolean).join(' · ') : ''
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
  $('log').innerHTML = ''
  $('todos').hidden = true
  view = { rows: [], tools: new Map(), msgs: new Map(), users: new Map(), reacts: new Map(), todos: null, turnAt: 0, lastAt: 0, start: 0, dirty: new Set(), opened: false }
}

const scroller = $('scroller')
const atBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60
function scrollToBottom() {
  scroller.scrollTop = scroller.scrollHeight
  $('jump').hidden = true
}
/** Is the view following the bottom? Set by the person's scrolling, not by content growing. */
let stuck = true
scroller.addEventListener('scroll', () => {
  stuck = atBottom()
  if (stuck) $('jump').hidden = true
  if (scroller.scrollTop < 200 && view?.start > 0) showOlder()
})
$('jump').firstElementChild.addEventListener('click', scrollToBottom)

function timeEl(at) {
  const d = document.createElement('div')
  d.className = 'time'
  d.textContent = hhmm(at)
  d.title = new Date(at).toLocaleString('ko-KR')
  return d
}

function renderConvo(evs, { live = false } = {}) {
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
      view.users.set(ev.ts, addRow('user', ev))
      return
    }
    case 'text':
      addRow('text', ev)
      view.lastText = ev.text
      view.live = ''
      view.liveAt = null
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
      ? `<span class="held" title="실행 중인 도구가 끝나면 전달해요">대기 중</span><button class="linkish" type="button" data-act="unhold" data-ts="${esc(ev.ts)}">수정</button>`
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
  el.innerHTML = `<div class="head"><span class="st ${cls}">${label}</span><span class="label"></span></div>`
  el.querySelector('.label').innerHTML = icon(toolIcon(row.ev.name)) + linkify(takeEmoji(row.ev.title).rest)
  if (row.end?.images?.length) el.insertAdjacentHTML('beforeend', imagesHtml(row.end.images))
  el.querySelector('.head').addEventListener('click', (e) => {
    if (e.target.closest('a')) return // a link in the row opens the link, not the row
    let d = el.querySelector('.detail')
    if (d) return void (d.hidden = !d.hidden)
    d = document.createElement('div')
    d.className = 'detail'
    el.append(d)
    fillTool(row, d) // drawn the first time it is opened, so a long conversation stays light
  })
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
      if (r.note && r.note !== '눌렀습니다.') toast(r.note)
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
    if (!confirm('잘못 보냈다고 알릴까요?\n작업을 멈추고, 이 메시지를 따르지 말라고 보냅니다. 이미 한 일은 무엇인지 알려 달라고 합니다.')) return
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
// One box at the bottom while the session works; only its header changes.
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
  const since = running ? running.ev.at : live && view.liveAt ? view.liveAt : Math.max(view.lastAt || 0, view.turnAt || 0) || Date.now()
  const secs = Math.max(0, Math.round((Date.now() - since) / 1000))
  const key = running ? 'tool:' + running.ev.id : live ? 'write' : 'think'
  if (box.dataset.key !== key) {
    box.dataset.key = key
    typed = ''
    box.innerHTML = running
      ? `<div class="ahead" role="button">${icon('chevron')}<span class="txt"></span><span class="secs"></span></div>`
      : live
        ? `<div class="ahead">${icon('edit')}<span class="txt">쓰는 중…</span><span class="secs"></span></div><div class="tail"></div>`
        : `<div class="ahead">${icon('spark')}<span class="txt">생각 중…</span><span class="secs"></span></div>`
    if (running) {
      box.querySelector('.txt').textContent = `도구 실행 중 · ${takeEmoji(running.ev.title).rest}`
      box.querySelector('.ahead').addEventListener('click', () => {
        let now = box.querySelector('.now')
        if (now) return void now.remove()
        now = document.createElement('div')
        now.className = 'now'
        now.innerHTML = codeBoxHtml(linkify(running.ev.detail || takeEmoji(running.ev.title).rest))
        box.append(now)
      })
    }
  }
  box.hidden = false
  box.querySelector('.secs').textContent = `· ${secs}초`
  if (live) typeInto(box.querySelector('.tail'), live)
}

// The preview types on: only the characters that are new since the last one, not the whole text again.
// When the window slid (the start of the tail moved), find where the old tail's end sits in the new one.
let typed = ''
let typing = null
function typeInto(el, target) {
  if (!el) return
  let keep = typed
  if (!target.startsWith(keep)) {
    const probe = keep.slice(-24)
    const at = probe ? target.lastIndexOf(probe) : -1
    keep = at >= 0 ? target.slice(0, at + probe.length) : ''
  }
  typed = keep
  el.textContent = typed
  cancelAnimationFrame(typing)
  const step = () => {
    if (typed.length >= target.length) return
    typed = target.slice(0, typed.length + Math.max(1, Math.ceil((target.length - typed.length) / 20)))
    el.textContent = typed
    typing = requestAnimationFrame(step)
  }
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) (typed = target), (el.textContent = typed)
  else typing = requestAnimationFrame(step)
}

// Stuck to the bottom, stay there when something below grows late (a picture, the activity box).
const stayDown = new ResizeObserver(() => {
  if (view && stuck) scroller.scrollTop = scroller.scrollHeight
})
stayDown.observe($('log'))
stayDown.observe($('activity'))
setInterval(() => current && renderActivity(), 1000)

// ------------------------------------------------------------------ composer: chips, waiting note, held
function renderWaitingNote() {
  let n = 0
  for (const row of view.msgs.values()) if (!row.deleted && hasActions(row.ev.blocks) && !row.ev.ephemeral) n++
  const el = $('waiting-note')
  el.hidden = !n
  if (n) el.innerHTML = `${icon('ring')}위 카드 ${n}개가 응답을 기다려요`
}

function renderComposerBits() {
  const s = current && sessionOf(current)
  const chips = $('chips')
  chips.innerHTML = ''
  if (!s) return
  const chip = (ic, label, run, { hot = false, href } = {}) => {
    const c = document.createElement(href ? 'a' : 'button')
    c.className = 'chip' + (hot ? ' hot' : '')
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
    if (!list?.length || (list.length === 1 && !fallback)) return chip(ic, label, null, { href: list?.[0]?.url ?? fallback })
    chip(ic, `${label} ${list.length}`, (e) => {
      const r = e.currentTarget.getBoundingClientRect()
      openMenu({ x: r.left, y: r.top - 8 - Math.min(list.length, 8) * 34 }, list.map((l) => ({ label: l.label, icon: ic, run: () => window.open(l.url, '_blank', 'noopener') })))
    })
  }
  const links = linkCache.get(s.pid)
  linkChip('pr', 'PR', links?.prs)
  linkChip('link', 'Slack 스레드', links?.threads, links ? undefined : withToken('/go/thread?ts=' + encodeURIComponent(s.thread)))
  if (s.held) chip('play', `지금 보내기 (${s.held})`, () => command(s, 'sendnow'), { hot: true })
  if (s.state === 'busy' || s.state === 'waiting') chip('stop', '중단', () => command(s, 'esc'))
  if (s.canKeys) chip('screen', '화면', () => showScreen(s))
  chip('image', '이미지 붙여넣기', pasteFromClipboard)
  chip('chat', '/btw', () => prefill(':btw '))
  chip('clipboard', '/compact', () => sendText(s, '/compact'))
  chip('search', '/context', () => sendText(s, '/context'))
  chip('refresh', '/clear', () => confirm('대화를 비울까요? (/clear)') && sendText(s, '/clear'))
}
async function pasteFromClipboard() {
  try {
    const files = []
    for (const item of await navigator.clipboard.read())
      for (const type of item.types.filter((t) => t.startsWith('image/'))) files.push(new File([await item.getType(type)], `붙여넣기.${type.split('/')[1]}`, { type }))
    if (!files.length) return toast('클립보드에 그림이 없어요', 'err')
    addPictures(files)
  } catch {
    toast('클립보드를 읽지 못했어요. 입력칸에 붙여넣어 보세요', 'err')
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
async function addPictures(files) {
  if (!current) return
  const list = pending.get(current) ?? []
  for (const f of files.slice(0, 10 - list.length)) {
    try {
      list.push(await shrinkPicture(f))
    } catch {
      toast(`${f.name} 을(를) 읽지 못했어요`, 'err')
    }
  }
  pending.set(current, list)
  renderPending()
}
/** Width 1600 at most, JPEG 0.85, unless the original is already small (a GIF keeps its frames). */
async function shrinkPicture(f) {
  const dataOf = (blob) => new Promise((res, rej) => Object.assign(new FileReader(), { onload: (e) => res(e.target.result), onerror: rej }).readAsDataURL(blob))
  if (f.size <= 300_000 || f.type === 'image/gif') return { name: f.name, type: f.type, data: await dataOf(f), url: URL.createObjectURL(f) }
  const bmp = await createImageBitmap(f)
  const scale = Math.min(1, 1600 / bmp.width)
  const c = Object.assign(document.createElement('canvas'), { width: Math.round(bmp.width * scale), height: Math.round(bmp.height * scale) })
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height)
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
  $('btn-send').disabled = !input.value.trim() && !list.length
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
  autosize()
}
function autosize() {
  input.style.height = 'auto'
  input.style.height = Math.min(input.scrollHeight, 140) + 'px'
  $('btn-send').disabled = !input.value.trim() && !(current && pending.get(current)?.length)
}
input.addEventListener('input', () => {
  autosize()
  saveDraft()
})
input.addEventListener('keydown', (e) => {
  // ↑ in an empty field brings back the last message sent in this session.
  if (e.key === 'ArrowUp' && !input.value && current && !e.isComposing) {
    const last = store.get('lastSent:' + current, '')
    if (last) {
      e.preventDefault()
      input.value = last
      autosize()
    }
    return
  }
  if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return
  if (e.metaKey || e.ctrlKey) return // ⌘↵ is "allow", never "send"
  if (e.shiftKey || !hasMouse) return // a newline (a phone keyboard's Enter is always a newline)
  e.preventDefault()
  sendNow()
})
$('btn-send').addEventListener('click', sendNow)
async function sendNow() {
  const s = current && sessionOf(current)
  const text = input.value.trim()
  const pics = pending.get(current) ?? []
  if (!text && !pics.length) return
  if (!s) return toast('이미 종료된 세션이에요.', 'err')
  const keep = input.value
  input.value = ''
  pending.delete(current)
  renderPending()
  autosize()
  saveDraft()
  if (text) store.set('lastSent:' + current, text)
  if (!(await sendText(s, text, pics))) {
    input.value = keep
    pending.set(current, pics)
    renderPending()
    autosize()
    saveDraft()
  }
}
async function sendText(s, text, pics = []) {
  // `/btw` answers from the screen, which the broker's :btw reads back; typed raw it would stay in the terminal.
  const body = /^\/btw\s/.test(text) ? ':' + text.slice(1) : text
  try {
    await api(`/api/session/${s.pid}/send`, { text: body, ...(pics.length ? { images: pics.map(({ name, type, data }) => ({ name, type, data })) } : {}) })
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
    const x = Math.min(at.x, innerWidth - r.width - 8)
    const y = at.y + r.height > innerHeight - 8 ? Math.max(8, at.y - r.height) : at.y
    menu.style.left = Math.max(8, x) + 'px'
    menu.style.top = y + 'px'
  }
  scrim.addEventListener('click', closeMenu)
  scrim.addEventListener('contextmenu', (e) => (e.preventDefault(), closeMenu()))
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
    toast((await api(`/api/session/${s.pid}/trash`, {})).note)
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
  document.body.append(scrim, el)
  el.querySelector('[data-x="later"]').focus()
}
async function toggleAuto(s) {
  const on = !s.autoAllow
  if (on && !confirm('전부 허용을 켤까요?\n권한 요청을 묻지 않고 브로커가 바로 허용합니다. 허용한 내용은 대화에 남아요.')) return
  await command(s, on ? 'auto on' : 'auto off')
}

function globalItems() {
  const theme = store.get('theme', 'auto')
  const items = [
    { label: '새 세션', icon: 'plus', run: newSession },
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
    'sep',
    { label: '이어서 하기 비우기', icon: 'undo', run: () => confirm('이어서 하기 목록을 비울까요?\n맥의 대화 파일은 지우지 않고, 지금까지의 것을 목록에서만 숨겨요(다시 쓰면 다시 보여요).') && groupOp({ op: 'clearRecent' }).then(loadSideLists) },
    { label: '지난 기록 모두 지우기', icon: 'deny', danger: true, run: () => confirm('지난 기록을 모두 지울까요? 실행 중인 세션의 기록은 남겨요.') && api('/api/archives/clear', {}).then((r) => (toast(r.note), loadSideLists()), (e) => toast(e.message, 'err')) },
    { label: '이전 관리 화면', icon: 'screen', run: () => (location.href = withToken('/admin')) },
  ]
  const s = current && sessionOf(current)
  if (s) items.push('sep', { head: '이 세션' }, ...sessionItems(s).filter((x) => x.label !== '열기'))
  return items
}
// ---- ⌘K: find a session. "새 세션" first, then running sessions filtered by name, state, folder, first message.
function openFinder() {
  closeMenu()
  const scrim = document.createElement('div')
  scrim.className = 'scrim dim'
  const el = document.createElement('div')
  el.className = 'finder'
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
  try {
    text = (await api('/api/default-prompt')).text
  } catch {}
  const scrim = document.createElement('div')
  scrim.className = 'scrim dim'
  const el = document.createElement('div')
  el.className = 'menu sheet prompt-sheet'
  el.innerHTML = `<div class="ns-head"><h2>기본 프롬프트</h2></div><p class="hint">모든 세션에 넣는 지시예요(예: "한국어로 답해"). 새로 띄우거나 다시 연 세션부터 적용돼요. 비우면 넣지 않아요.</p><textarea class="ns-prompt" rows="6"></textarea><div class="ns-actions"><button class="btn" type="button" data-x="cancel">취소</button><button class="btn primary" type="button" data-x="save">저장</button></div>`
  el.querySelector('textarea').value = text
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
  document.body.append(scrim, el)
  el.querySelector('textarea').focus()
}
$('btn-more').addEventListener('click', (e) => {
  const r = e.currentTarget.getBoundingClientRect()
  openMenu({ x: r.right - 240, y: r.bottom + 4 }, globalItems())
})
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
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && menuState) return closeMenu()
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

// The web app: the same sessions as the Slack threads, driven through the broker that serves this page.
// Server → page: one EventSource (/api/stream) with the session list and every session event.
// Page → server: plain POSTs. Buttons on broker cards post their Slack action, so a press here runs
// exactly what a click in Slack runs.
import { esc, linkify, md, mrkdwn } from './markdown.js'
import { icon, takeEmoji, toolIcon } from './icons.js'

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

async function api(path, body) {
  const r = await fetch(withToken(path), body === undefined ? { headers: authHeaders } : { method: 'POST', headers: { ...authHeaders, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  let data = {}
  try {
    data = await r.json()
  } catch {}
  if (!r.ok) throw new Error(data.note || data.error || `HTTP ${r.status}`)
  return data
}

function toast(text, kind = 'ok', ms = 2600) {
  const el = $('toast')
  el.innerHTML = `${icon(kind === 'ok' ? 'check' : 'alert')}<span></span>`
  el.lastElementChild.textContent = text
  el.hidden = false
  clearTimeout(toast.t)
  toast.t = setTimeout(() => (el.hidden = true), ms)
}

// ------------------------------------------------------------------ theme
function applyTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t
  else delete document.documentElement.dataset.theme
  store.set('theme', t)
}

// ------------------------------------------------------------------ live connection
let es = null
let connected = false
function connect() {
  if (es) es.close()
  es = new EventSource(withToken('/api/stream'))
  es.addEventListener('open', () => {
    connected = true
    renderConn()
    if (current) catchUp(current)
  })
  es.addEventListener('error', () => {
    connected = false
    renderConn()
  })
  es.addEventListener('sessions', (e) => {
    sessions = JSON.parse(e.data)
    for (const s of sessions) if (!(s.thread in seen)) seen[s.thread] = s.lastSeq // a session seen for the first time counts as read
    store.set('seen', seen)
    renderList()
    renderHeader()
    renderComposerBits()
    renderActivity()
  })
  es.addEventListener('ev', (e) => {
    const { thread: ts, ev } = JSON.parse(e.data)
    const t = threads.get(ts)
    if (!t || (!t.events.length && !t.loading && ts !== current)) return
    if (t.loading) return
    if (ev.seq <= t.last) return
    if (ev.seq !== t.last + 1) return void catchUp(ts)
    addEvents(ts, [ev], { live: true })
  })
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return
  if (!es || es.readyState === EventSource.CLOSED || !connected) connect()
  else if (current) catchUp(current)
})
addEventListener('online', () => connect())
function renderConn() {
  const el = $('conn')
  el.textContent = connected ? '' : '연결이 끊겼어요 · 다시 붙는 중…'
  el.classList.toggle('bad', !connected)
}

async function catchUp(ts) {
  const t = thread(ts)
  if (t.loading) return t.loading
  t.loading = (async () => {
    try {
      for (;;) {
        const { events } = await api(`/api/events?thread=${encodeURIComponent(ts)}&after=${t.last}`)
        const fresh = events.filter((e) => e.seq > t.last)
        if (!fresh.length) break
        addEvents(ts, fresh)
        if (events.length < 1000) break
      }
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
  }
  renderList()
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

function secHead(key, label, n) {
  const open = !folded[key]
  const el = document.createElement('div')
  el.className = 'sec-head' + (open ? ' open' : '')
  el.setAttribute('role', 'button')
  el.innerHTML = `<span class="tw">${icon('chevron')}</span><span>${esc(label)}</span><span class="n">${n}</span>`
  el.addEventListener('click', () => {
    folded[key] = open
    store.set('folded', folded)
    renderList()
  })
  return { el, open }
}

function renderList() {
  const q = $('search').value.trim().toLowerCase()
  const match = (...vals) => !q || vals.some((v) => (v || '').toLowerCase().includes(q))
  const list = $('list')
  const keepScroll = list.scrollTop
  list.innerHTML = ''

  const live = sessions.filter((s) => match(s.title, s.preview, s.cwd, s.last?.text)).sort((a, b) => (b.state === 'waiting') - (a.state === 'waiting') || b.lastAt - a.lastAt)
  const h = secHead('live', '진행 중', live.length)
  list.append(h.el)
  if (h.open) {
    for (const s of live) list.append(liveRow(s))
    if (!live.length) list.insertAdjacentHTML('beforeend', `<div class="empty-note">${q ? '찾는 세션이 없어요' : '떠 있는 세션이 없어요'}</div>`)
  }

  const rec = recent.filter((r) => match(r.title, r.preview, r.cwd))
  const hr = secHead('recent', '이어서 하기', rec.length)
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

function liveRow(s) {
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
  const t = thread(ts)
  if (t.events.length) renderConvo(t.events)
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
let view
function resetConvo() {
  $('log').innerHTML = ''
  $('todos').hidden = true
  view = { msgs: new Map(), tools: new Map(), users: new Map(), reacts: new Map(), todos: null, turnAt: 0, lastAt: 0 }
}

const scroller = $('scroller')
const atBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60
function scrollToBottom() {
  scroller.scrollTop = scroller.scrollHeight
  $('jump').hidden = true
}
scroller.addEventListener('scroll', () => atBottom() && ($('jump').hidden = true))
$('jump').firstElementChild.addEventListener('click', scrollToBottom)

function timeEl(at) {
  const d = document.createElement('div')
  d.className = 'time'
  d.textContent = hhmm(at)
  d.title = new Date(at).toLocaleString('ko-KR')
  return d
}

function renderConvo(evs, { live = false } = {}) {
  const follow = atBottom()
  const log = $('log')
  for (const ev of evs) {
    const el = renderEvent(ev, live)
    if (el) log.append(el)
  }
  renderTodos()
  renderWaitingNote()
  renderActivity()
  if (follow) scrollToBottom()
  else if (evs.length) $('jump').hidden = false
}

function renderEvent(ev, live) {
  view.lastAt = ev.at
  switch (ev.type) {
    case 'user': {
      view.turnAt = ev.at
      const el = document.createElement('div')
      el.className = 'item user'
      el.innerHTML = `<div class="bubble"></div><div class="meta"></div>`
      el.firstElementChild.innerHTML = linkify(ev.text)
      const via = ev.via === 'terminal' ? `<span title="터미널에서 입력">${icon('keyboard')}</span>` : ev.via === 'slack' ? `<span title="Slack 에서 보냄">${icon('chat')}</span>` : ''
      el.lastElementChild.innerHTML = `${via}<span class="t" title="${esc(new Date(ev.at).toLocaleString('ko-KR'))}">${hhmm(ev.at)}</span><span class="state"></span>`
      view.users.set(ev.ts, el)
      applyReacts(ev.ts)
      return el
    }
    case 'text': {
      const el = document.createElement('div')
      el.className = 'item text'
      el.innerHTML = `<div class="md">${md(ev.text)}</div>${ev.files?.length ? `<div class="files">${icon('attach')} ${ev.files.map((f) => esc(f.split('/').pop())).join(', ')}</div>` : ''}`
      el.append(timeEl(ev.at))
      return el
    }
    case 'tool':
      return toolEl(ev)
    case 'tool_end': {
      const t = findTool(ev.id)
      if (t) {
        t.end = ev
        t.st.className = 'st ' + (ev.ok ? 'ok' : 'fail')
        t.st.textContent = ev.ok ? '완료' : '실패'
        if (t.detail && !t.detail.hidden) fillTool(t)
      }
      return null
    }
    case 'todos':
      view.todos = ev.todos
      return null
    case 'msg': {
      // A note only for the presser (a button's answer): a toast while it is fresh, nothing in the timeline.
      if (ev.ephemeral && !hasActions(ev.blocks)) {
        if (live) toast(takeEmoji(plainText(ev.text)).rest)
        return null
      }
      const el = msgEl(ev)
      view.msgs.set(ev.ts, el)
      return el
    }
    case 'msg_update': {
      const old = view.msgs.get(ev.ts)
      if (old) {
        const el = msgEl({ ...ev, at: old._at ?? ev.at })
        old.replaceWith(el)
        view.msgs.set(ev.ts, el)
      }
      return null
    }
    case 'msg_delete': {
      view.msgs.get(ev.ts)?.remove()
      view.msgs.delete(ev.ts)
      return null
    }
    case 'react': {
      const set = view.reacts.get(ev.ts) ?? new Set()
      ev.on ? set.add(ev.name) : set.delete(ev.name)
      view.reacts.set(ev.ts, set)
      applyReacts(ev.ts)
      return null
    }
    case 'status':
      if (ev.state === 'busy' && !view.turnAt) view.turnAt = ev.at
      if (ev.state !== 'busy') closeRunningTools()
      return null
    case 'end':
      closeRunningTools()
      return noticeEl('ended', `세션 ${ev.why}`)
    default:
      return null
  }
}

// Newest first, stop at the first hit: a tool result belongs to a recent call.
function findTool(id) {
  return view.tools.get(id)
}
function closeRunningTools() {
  for (const t of view.tools.values())
    if (!t.end && t.st.classList.contains('run')) {
      t.st.className = 'st ok'
      t.st.textContent = '끝남'
    }
}

function applyReacts(ts) {
  const el = view.users.get(ts)
  const set = view.reacts.get(ts)
  if (!el || !set) return
  const st = el.querySelector('.state')
  if (set.has('hourglass_flowing_sand')) {
    st.className = 'state held'
    st.textContent = '대기 중'
    st.title = '실행 중인 도구가 끝나면 전달해요'
  } else if (set.has('x')) {
    st.className = 'state failed'
    st.textContent = '취소함'
  } else if (set.has('eyes') || set.has('white_check_mark')) {
    st.className = 'state'
    st.textContent = '전달됨'
  }
}

function toolEl(ev) {
  const el = document.createElement('div')
  el.className = 'item tool'
  el.innerHTML = `<div class="head"><span class="st run">실행 중</span><span class="label"></span></div>`
  el.querySelector('.label').innerHTML = icon(toolIcon(ev.name)) + linkify(takeEmoji(ev.title).rest)
  const t = { ev, el, st: el.querySelector('.st'), detail: null, end: null }
  view.tools.set(ev.id, t)
  el.querySelector('.head').addEventListener('click', (e) => {
    if (e.target.closest('a')) return // a link in the row opens the link, not the row
    if (!t.detail) {
      t.detail = document.createElement('div')
      t.detail.className = 'detail'
      el.append(t.detail)
      fillTool(t) // drawn the first time it is opened, so a long conversation stays light
    } else t.detail.hidden = !t.detail.hidden
  })
  return el
}
function fillTool(t) {
  const parts = []
  if (t.ev.detail) parts.push(`<div class="k">입력</div>${codeBoxHtml(linkify(t.ev.detail))}`)
  if (t.end) parts.push(`<div class="k">${t.end.ok ? '출력' : '오류'}</div>${codeBoxHtml(linkify(t.end.output || '(출력 없음)'))}`)
  else parts.push('<div class="k">실행 중…</div>')
  t.detail.innerHTML = parts.join('')
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
  let running = null
  for (const t of view.tools.values()) if (!t.end && t.st.classList.contains('run')) running = t
  const since = running ? running.ev.at : Math.max(view.lastAt || 0, view.turnAt || 0) || Date.now()
  const secs = Math.max(0, Math.round((Date.now() - since) / 1000))
  const key = running ? 'tool:' + running.ev.id : 'think'
  if (box.dataset.key !== key) {
    box.dataset.key = key
    box.innerHTML = running
      ? `<div class="ahead" role="button">${icon('chevron')}<span class="txt"></span><span class="secs"></span></div>`
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
}
setInterval(() => current && renderActivity(), 1000)

// ------------------------------------------------------------------ composer: chips, waiting note, held
function renderWaitingNote() {
  const n = $('log').querySelectorAll('.card.decision').length
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
  if (s.held) chip('play', `지금 보내기 (${s.held})`, () => command(s, 'sendnow'), { hot: true })
  if (s.state === 'busy' || s.state === 'waiting') chip('stop', '중단', () => command(s, 'esc'))
  chip('link', 'Slack 스레드', null, { href: withToken('/go/thread?ts=' + encodeURIComponent(s.thread)) })
  if (s.canKeys) chip('screen', '화면', () => showScreen(s))
  chip('chat', '/btw', () => prefill(':btw '))
  chip('clipboard', '/compact', () => sendText(s, '/compact'))
  chip('search', '/context', () => sendText(s, '/context'))
  chip('refresh', '/clear', () => confirm('대화를 비울까요? (/clear)') && sendText(s, '/clear'))
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
  $('btn-send').disabled = !input.value.trim()
}
input.addEventListener('input', () => {
  autosize()
  saveDraft()
})
input.addEventListener('keydown', (e) => {
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
  if (!text) return
  if (!s) return toast('이미 종료된 세션이에요.', 'err')
  const keep = input.value
  input.value = ''
  autosize()
  saveDraft()
  store.set('lastSent:' + current, text)
  if (!(await sendText(s, text))) {
    input.value = keep
    autosize()
    saveDraft()
  }
}
async function sendText(s, text) {
  // `/btw` answers from the screen, which the broker's :btw reads back; typed raw it would stay in the terminal.
  const body = /^\/btw\s/.test(text) ? ':' + text.slice(1) : text
  try {
    await api(`/api/session/${s.pid}/send`, { text: body })
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
    { label: s.autoAllow ? '전부 허용 끄기' : '전부 허용 켜기', icon: 'bolt', on: s.autoAllow, run: () => toggleAuto(s) },
    { label: '새로고침', icon: 'refresh', run: () => (s.state !== 'busy' || confirm('작업 중이에요. 다시 열까요?')) && command(s, 'refresh') },
    'sep',
    { label: '종료', icon: 'ended', danger: true, run: () => confirm(`"${nameOf(s)}" 세션을 종료할까요?`) && command(s, 'exit') },
    { label: '강제 종료', icon: 'deny', danger: true, run: () => confirm('tmux 창을 닫아 강제로 끝낼까요?') && api(`/api/session/${s.pid}/kill`, {}).then((r) => toast(r.note), (e) => toast(e.message, 'err')) },
  ]
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
  ]
  const s = current && sessionOf(current)
  if (s) items.push('sep', { head: '이 세션' }, ...sessionItems(s).filter((x) => x.label !== '열기'))
  return items
}
$('btn-more').addEventListener('click', (e) => {
  const r = e.currentTarget.getBoundingClientRect()
  openMenu({ x: r.right - 240, y: r.bottom + 4 }, globalItems())
})
function newSession() {
  location.href = withToken('/admin') // the new-session screen comes with item 19; until then the old page has it
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
connect()
renderConn()
loadSideLists()
setInterval(loadSideLists, 60_000)
api('/api/options').then((o) => (options = o), () => {})
const start = location.hash.slice(1)
if (/^\d+\.\d+$/.test(start)) open(start, { push: false })

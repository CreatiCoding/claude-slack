// The web app: the same sessions as the Slack threads, driven through the broker that serves this page.
// Server → page: one EventSource (/api/stream) with the session list and every session event.
// Page → server: plain POSTs. Buttons on broker cards post their Slack action, so a press here runs
// exactly what a click in Slack runs.
import { esc, linkify, md, mrkdwn } from './markdown.js'

const $ = (id) => document.getElementById(id)
const params = new URLSearchParams(location.search)
const token = params.get('t') || ''
const authHeaders = token ? { 'x-admin-token': token } : {}
const withToken = (path) => (token ? path + (path.includes('?') ? '&' : '?') + 't=' + encodeURIComponent(token) : path)
const isPhone = () => matchMedia('(max-width: 899px)').matches
const coarse = matchMedia('(pointer: coarse)').matches

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

// ------------------------------------------------------------------ state
let sessions = []
/** thread → { events: [], last: 0, loading } */
const threads = new Map()
let current = null // thread ts
const seen = store.get('seen', {})

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

function toast(text, ms = 2600) {
  const el = $('toast')
  el.textContent = text
  el.hidden = false
  clearTimeout(toast.t)
  toast.t = setTimeout(() => (el.hidden = true), ms)
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
    // Whatever happened while we were away: fetch from the last event we have.
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
    renderHeld()
  })
  es.addEventListener('ev', (e) => {
    const { thread: ts, ev } = JSON.parse(e.data)
    const t = threads.get(ts)
    if (!t || (!t.events.length && !t.loading && ts !== current)) return // not open: the list's lastSeq is enough
    if (t.loading) return // the catch-up in flight will include it
    if (ev.seq <= t.last) return
    if (ev.seq !== t.last + 1) return void catchUp(ts) // a gap: ask again from the last one we have
    addEvents(ts, [ev])
  })
}
// Come back at once when the tab is shown again or the network returns, instead of waiting for the retry timer.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && (!es || es.readyState === EventSource.CLOSED || !connected)) connect()
  else if (document.visibilityState === 'visible' && current) catchUp(current)
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
      toast('대화를 불러오지 못했어요: ' + err.message)
    } finally {
      t.loading = null
    }
  })()
  return t.loading
}

function addEvents(ts, evs) {
  const t = thread(ts)
  for (const ev of evs) {
    if (ev.seq <= t.last) continue
    t.events.push(ev)
    t.last = ev.seq
  }
  if (ts === current) {
    renderConvo(evs)
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

// ------------------------------------------------------------------ list
const STATE_LABEL = { starting: '뜨는 중', idle: '쉬는 중', busy: '작업 중', waiting: '응답 대기', ended: '끝남' }
function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 60) return '방금'
  if (s < 3600) return `${Math.floor(s / 60)}분`
  if (s < 86400) return `${Math.floor(s / 3600)}시간`
  return `${Math.floor(s / 86400)}일`
}
const nameOf = (s) => s.title || s.cwd.split('/').pop() || s.cwd

function renderList() {
  const q = $('search').value.trim().toLowerCase()
  const shown = sessions
    .filter((s) => !q || [s.title, s.preview, s.cwd].some((v) => (v || '').toLowerCase().includes(q)))
    .sort((a, b) => (b.state === 'waiting') - (a.state === 'waiting') || b.lastAt - a.lastAt)
  const list = $('list')
  list.innerHTML = ''
  const head = document.createElement('div')
  head.className = 'section-head'
  head.textContent = `진행 중 ${shown.length}`
  list.append(head)
  for (const s of shown) {
    const row = document.createElement('div')
    row.className = 'row' + (s.thread === current ? ' active' : '') + ((seen[s.thread] ?? 0) < s.lastSeq && s.thread !== current ? ' unread' : '')
    row.setAttribute('role', 'button')
    row.tabIndex = 0
    row.dataset.thread = s.thread
    row.title = `${s.cwd}${s.preview ? '\n' + s.preview : ''}`
    row.innerHTML = `<span class="dot ${s.state}" title="${STATE_LABEL[s.state] || s.state}"></span><span class="name">${esc(nameOf(s))}</span>${s.autoAllow ? '<span class="auto" title="전부 허용">⚡</span>' : ''}${
      s.waiting ? `<span class="badge">${esc(s.waiting)}</span>` : `<span class="when">${ago(s.lastAt)}</span>`
    }`
    row.addEventListener('click', () => open(s.thread))
    row.addEventListener('keydown', (e) => e.key === 'Enter' && open(s.thread))
    list.append(row)
  }
  if (!shown.length) {
    const none = document.createElement('div')
    none.className = 'section-head'
    none.textContent = q ? '찾는 세션이 없어요' : '떠 있는 세션이 없어요'
    list.append(none)
  }
}
$('search').addEventListener('input', renderList)
setInterval(renderList, 30_000) // the "N분" labels

// ------------------------------------------------------------------ opening a session
async function open(ts, { push = true } = {}) {
  if (current && current !== ts) saveDraft()
  current = ts
  $('app').classList.add('in-convo')
  $('empty').hidden = true
  $('convo').hidden = false
  if (push && isPhone()) history.pushState({ thread: ts }, '', location.pathname + location.search + '#' + ts)
  else history.replaceState({ thread: ts }, '', location.pathname + location.search + '#' + ts)
  resetConvo()
  renderHeader()
  renderHeld()
  loadDraft()
  const t = thread(ts)
  if (t.events.length) renderConvo(t.events)
  await catchUp(ts)
  scrollToBottom()
  markSeen(ts)
  renderList()
  if (!coarse) $('input').focus()
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
  $('title').textContent = s ? nameOf(s) : current ? '끝난 세션' : 'Claude'
  $('meta').textContent = s ? [STATE_LABEL[s.state], s.model, s.effort, s.permissionMode, s.contextLabel].filter(Boolean).join(' · ') : ''
  const auto = $('btn-auto')
  auto.hidden = !s
  auto.setAttribute('aria-pressed', String(!!s?.autoAllow))
  document.title = (() => {
    const n = sessions.filter((x) => x.state === 'waiting').length
    return n ? `(${n}) 응답 대기 · Claude` : 'Claude'
  })()
}
$('btn-auto').addEventListener('click', async () => {
  const s = current && sessionOf(current)
  if (!s) return
  const on = !s.autoAllow
  if (on && !confirm('전부 허용을 켤까요?\n권한 요청을 묻지 않고 브로커가 바로 허용합니다. 허용한 내용은 대화에 남아요.')) return
  await command(s, on ? 'auto on' : 'auto off')
})
$('title').addEventListener('click', async () => {
  const s = current && sessionOf(current)
  if (!s) return
  const name = prompt('세션 이름', nameOf(s))
  if (!name || !name.trim() || name.trim() === nameOf(s)) return
  try {
    const r = await api(`/api/session/${s.pid}/rename`, { title: name.trim() })
    toast(r.note)
  } catch (err) {
    toast(err.message)
  }
})

// ------------------------------------------------------------------ conversation
// The view is rebuilt from events: a message edited later (a card answered) is replaced in place.
let view // { items: Map<key, el>, tools: Map<id, {...}>, users: Map<ts, el> }
function resetConvo() {
  $('log').innerHTML = ''
  $('todos').hidden = true
  view = { msgs: new Map(), tools: new Map(), users: new Map(), reacts: new Map(), todos: null, lastTextKey: null }
}

const scroller = $('scroller')
const atBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60
function scrollToBottom() {
  scroller.scrollTop = scroller.scrollHeight
  $('jump').hidden = true
}
scroller.addEventListener('scroll', () => atBottom() && ($('jump').hidden = true))
$('jump').querySelector('button').addEventListener('click', scrollToBottom)

const hhmm = (at) => new Date(at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
function timeEl(at) {
  const d = document.createElement('div')
  d.className = 'time'
  d.textContent = hhmm(at)
  d.title = new Date(at).toLocaleString('ko-KR')
  return d
}

function renderConvo(evs) {
  const follow = atBottom()
  const log = $('log')
  for (const ev of evs) {
    const el = renderEvent(ev)
    if (el) log.append(el)
  }
  renderTodos()
  if (follow) scrollToBottom()
  else if (evs.length) $('jump').hidden = false
}

function renderEvent(ev) {
  switch (ev.type) {
    case 'user': {
      const el = document.createElement('div')
      el.className = 'item user'
      const via = ev.via === 'terminal' ? '<span class="via">⌨️ 터미널</span>' : ev.via === 'web' ? '' : '<span class="via">Slack</span>'
      el.innerHTML = `<div class="body">${linkify(ev.text)}</div>`
      const t = timeEl(ev.at)
      t.innerHTML = via + t.innerHTML + '<span class="state"></span>'
      el.append(t)
      view.users.set(ev.ts, el)
      applyReacts(ev.ts)
      return el
    }
    case 'text': {
      const el = document.createElement('div')
      el.className = 'item text'
      el.innerHTML = `<div class="body">${md(ev.text)}${ev.files?.length ? `<div class="card plain files">📎 ${ev.files.map((f) => esc(f.split('/').pop())).join(', ')}</div>` : ''}</div>`
      el.append(timeEl(ev.at))
      return el
    }
    case 'tool':
      return toolEl(ev)
    case 'tool_end': {
      const t = view.tools.get(ev.id)
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
      const el = cardEl(ev)
      view.msgs.set(ev.ts, el)
      return el
    }
    case 'msg_update': {
      const old = view.msgs.get(ev.ts)
      if (old) {
        const el = cardEl({ ...ev, at: old._at ?? ev.at })
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
    case 'end': {
      const el = document.createElement('div')
      el.className = 'notice'
      el.textContent = `⚫ 세션 ${ev.why}`
      return el
    }
    default:
      return null
  }
}

// What happened to a message the person sent, from the reactions the broker put on it.
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
    st.className = 'state dropped'
    st.textContent = '취소함'
  } else if (set.has('white_check_mark')) {
    st.className = 'state'
    st.textContent = '✓'
  } else if (set.has('eyes')) {
    st.className = 'state'
    st.textContent = '전달됨'
  }
}

function toolEl(ev) {
  const el = document.createElement('div')
  el.className = 'item tool'
  el.innerHTML = `<div class="head"><span class="label"></span><span class="st run">실행 중</span></div>`
  el.querySelector('.label').innerHTML = linkify(ev.title)
  const t = { ev, el, st: el.querySelector('.st'), detail: null, end: null }
  view.tools.set(ev.id, t)
  el.querySelector('.head').addEventListener('click', (e) => {
    if (e.target.closest('a')) return // a link inside the row opens the link, not the row
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
  if (t.ev.detail) parts.push(`<div class="k">입력</div><pre>${linkify(t.ev.detail)}</pre>`)
  if (t.end) parts.push(`<div class="k">${t.end.ok ? '출력' : '오류'}</div><pre>${linkify(t.end.output || '(출력 없음)')}</pre>`)
  else parts.push('<div class="k">실행 중…</div>')
  t.detail.innerHTML = parts.join('')
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
  box.innerHTML = `<details open><summary>할 일 ${done}/${todos.length}</summary>${todos
    .map((x) => `<div class="t ${x.status === 'completed' ? 'done' : x.status === 'in_progress' ? 'now' : ''}">${x.status === 'completed' ? '☑' : x.status === 'in_progress' ? '▶' : '☐'} <span>${esc(x.status === 'in_progress' && x.activeForm ? x.activeForm : x.content)}</span></div>`)
    .join('')}</details>`
}

// ---- broker cards: Slack blocks drawn as HTML, buttons posted back as Slack actions
const textOf = (t) => (!t ? '' : t.type === 'plain_text' ? esc(t.text) : mrkdwn(t.text))
function cardEl(ev) {
  const el = document.createElement('div')
  const blocks = Array.isArray(ev.blocks) ? ev.blocks : null
  const hasButtons = !!blocks?.some((b) => b.type === 'actions' || b.accessory?.type === 'button')
  el.className = 'item card' + (ev.ephemeral ? ' eph' : '') + (hasButtons ? ' decision' : '') + (!blocks && !ev.ephemeral && !ev.files ? ' plain' : '')
  el._at = ev.at
  if (!blocks) el.innerHTML = `<div class="body">${mrkdwn(ev.text)}</div>`
  else {
    for (const b of blocks) {
      const blk = blockEl(b, ev, blocks)
      if (blk) el.append(blk)
    }
    if (!el.childElementCount) el.innerHTML = `<div class="body">${mrkdwn(ev.text)}</div>`
  }
  if (ev.files?.length) el.insertAdjacentHTML('beforeend', `<div class="files">📎 ${ev.files.map((f) => esc(f.split('/').pop())).join(', ')}</div>`)
  el.append(timeEl(ev.at))
  return el
}
function blockEl(b, ev, all) {
  const d = document.createElement('div')
  d.className = 'blk body'
  switch (b.type) {
    case 'section':
      d.innerHTML = textOf(b.text) + (b.fields ? `<div class="fields">${b.fields.map((f) => `<div>${textOf(f)}</div>`).join('')}</div>` : '')
      if (b.accessory?.type === 'button') {
        const row = document.createElement('div')
        row.className = 'actions'
        row.append(buttonEl(b.accessory, ev, all))
        d.append(row)
      }
      return d
    case 'context':
      d.className = 'blk ctx'
      d.innerHTML = (b.elements || []).map((x) => (x.type === 'image' ? '' : textOf(x))).join(' ')
      return d
    case 'header':
      d.className = 'blk hdr'
      d.innerHTML = textOf(b.text)
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
        else if ((x.type === 'static_select' || x.type === 'overflow') && x.options) {
          // A menu becomes one button per option.
          for (const o of x.options) d.append(buttonEl({ text: o.text, action_id: x.action_id, value: o.value }, ev, all))
        }
      }
      return d.childElementCount ? d : null
    }
    case 'table': {
      const rows = b.rows || []
      const cell = (c) => esc(c?.text ?? (c?.elements ? JSON.stringify(c.elements) : ''))
      d.innerHTML = `<div class="table-wrap"><table>${rows.map((r, i) => `<tr>${r.map((c) => (i === 0 ? `<th>${cell(c)}</th>` : `<td>${cell(c)}</td>`)).join('')}</tr>`).join('')}</table></div>`
      return d
    }
    case 'rich_text':
    case 'plan':
    case 'alert':
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
  btn.className = 'b' + (x.style ? ' ' + x.style : '')
  btn.textContent = x.text?.text ?? '버튼'
  if (x.url) {
    btn.href = x.url
    btn.target = '_blank'
    btn.rel = 'noopener noreferrer'
    return btn
  }
  btn.type = 'button'
  if (x.style === 'primary' && /^perm_allow/.test(x.action_id) && !coarse) btn.insertAdjacentHTML('beforeend', `<span class="kbd">${navigator.platform.startsWith('Mac') ? '⌘↵' : 'Ctrl↵'}</span>`)
  btn.dataset.action = x.action_id
  btn.addEventListener('click', async () => {
    const row = btn.closest('.actions')
    row?.querySelectorAll('button').forEach((b) => (b.disabled = true))
    try {
      const r = await api('/api/action', { actionId: x.action_id, value: x.value ?? '', ...(ev.ephemeral || String(ev.ts).startsWith('up-') ? {} : { messageTs: ev.ts }), blocks: all })
      if (r.note && r.note !== '눌렀습니다.') toast(r.note)
    } catch (err) {
      toast(err.message)
    } finally {
      // The card is edited (answered) by the broker when it took; a card that stays means press again is fine.
      setTimeout(() => row?.querySelectorAll('button').forEach((b) => (b.disabled = false)), 1500)
    }
  })
  return btn
}

// ⌘/Ctrl+Enter presses "허용" on the newest permission card of the open session.
addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey) || !current) return
  const btns = [...$('log').querySelectorAll('button[data-action^="perm_allow"]:not(:disabled)')]
  const b = btns.at(-1)
  if (b) {
    e.preventDefault()
    b.click()
  }
})

// ------------------------------------------------------------------ held messages
function renderHeld() {
  const box = $('held')
  const s = current && sessionOf(current)
  if (!s || !s.held) {
    box.hidden = true
    return
  }
  box.hidden = false
  box.innerHTML = `<span class="msg">🕓 대기 중 ${s.held}개 · 실행 중인 도구가 끝나면 전달해요</span>`
  const now = document.createElement('button')
  now.className = 'b primary'
  now.type = 'button'
  now.textContent = `지금 보내기 (${s.held})`
  now.addEventListener('click', () => command(s, 'sendnow'))
  const drop = document.createElement('button')
  drop.className = 'b'
  drop.type = 'button'
  drop.textContent = '보낸 것 취소'
  drop.addEventListener('click', () => command(s, 'dropheld'))
  box.append(now, drop)
}
async function command(s, cmd) {
  try {
    await api('/api/action', { actionId: 'ctl_btn_web', value: `${s.pid}:${cmd}` })
  } catch (err) {
    toast(err.message)
  }
}

// ------------------------------------------------------------------ composer
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
  input.style.height = Math.min(input.scrollHeight, innerHeight * 0.4) + 'px'
  $('btn-send').disabled = !input.value.trim()
}
input.addEventListener('input', () => {
  autosize()
  saveDraft()
})
input.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return
  if (e.metaKey || e.ctrlKey) return // ⌘↵ is "allow", never "send"
  if (e.shiftKey || coarse) return // a newline (on a phone Enter is always a newline)
  e.preventDefault()
  sendNow()
})
$('btn-send').addEventListener('click', sendNow)
async function sendNow() {
  const s = current && sessionOf(current)
  const text = input.value.trim()
  if (!text) return
  if (!s) return toast('이미 끝난 세션이에요.')
  const keep = input.value
  input.value = ''
  autosize()
  saveDraft()
  store.set('lastSent:' + current, text)
  try {
    await api(`/api/session/${s.pid}/send`, { text })
  } catch (err) {
    input.value = keep
    autosize()
    saveDraft()
    toast('보내지 못했어요: ' + err.message)
  }
}

// ------------------------------------------------------------------ sidebar width (PC)
;(() => {
  const app = $('app')
  const set = (w) => document.documentElement.style.setProperty('--side-w', Math.max(200, Math.min(520, w)) + 'px')
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
    const move = (m) => set(m.clientX - app.getBoundingClientRect().left)
    const up = () => {
      r.classList.remove('dragging')
      r.removeEventListener('pointermove', move)
      store.set('sideW', parseInt(getComputedStyle(document.documentElement).getPropertyValue('--side-w')))
    }
    r.addEventListener('pointermove', move)
    r.addEventListener('pointerup', up, { once: true })
  })
})()

$('btn-new').addEventListener('click', () => {
  location.href = withToken('/admin') // until the new-session screen lands, the old admin page has it
})

$('old-admin').href = withToken('/admin')

// ------------------------------------------------------------------ start
connect()
renderConn()
const start = location.hash.slice(1)
if (/^\d+\.\d+$/.test(start)) open(start, { push: false })

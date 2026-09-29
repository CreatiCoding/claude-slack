// End-to-end QA of the web app (/app) in a real browser, against a fake API: nothing here touches the running broker.
// Usage: node scripts/qa-web.ts        (needs playwright's chromium; prints PASS/FAIL per check, exits 1 on any FAIL)
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Page } from 'playwright'
import { createAdminServer, type AdminApi } from '../src/admin.ts'
import type { AdminState, WebSession } from '../src/broker.ts'
import { EventLog } from '../src/events.ts'

const events = new EventLog(mkdtempSync(join(tmpdir(), 'qa-web-')))
const calls: string[] = []
const changes = new Set<() => void>()
const now = Date.now()
const A = '1000.0001'
const B = '2000.0002'
let sessions: WebSession[] = [
  { pid: 11, thread: A, cwd: '/p/alpha', title: '알파 작업', state: 'idle', model: 'opus', effort: 'high', permissionMode: 'default', contextLabel: '12%', startedAt: now - 60_000, held: 0, canKeys: true, autoAllow: false, lastSeq: 0, lastAt: now - 60_000, preview: '첫 메시지 A' },
  { pid: 12, thread: B, cwd: '/p/beta', title: '베타', state: 'waiting', waiting: '권한 대기', startedAt: now - 120_000, held: 0, canKeys: true, autoAllow: false, lastSeq: 0, lastAt: now - 120_000 },
]
const changed = () => {
  sessions = sessions.map((s) => ({ ...s, lastSeq: events.last(s.thread) }))
  for (const l of changes) l()
}
const permBlocks = (pid: number) => [
  { type: 'section', text: { type: 'mrkdwn', text: '🔐 *Bash* 권한 요청 · `abcde`\n명령 실행' } },
  { type: 'section', text: { type: 'mrkdwn', text: '```npm test && open https://example.com/docs.```' } },
  { type: 'actions', block_id: `perm_${pid}_abcde`, elements: [
    { type: 'button', text: { type: 'plain_text', text: '허용' }, action_id: 'perm_allow_abcde_1', value: `${pid}:abcde`, style: 'primary' },
    { type: 'button', text: { type: 'plain_text', text: '거부' }, action_id: 'perm_deny_abcde_2', value: `${pid}:abcde`, style: 'danger' },
  ] },
]

// A conversation already in progress.
events.emit(A, { type: 'user', ts: '1000.1', text: '테스트 돌려 줘 https://example.com/a).', via: 'slack' })
events.emit(A, { type: 'text', text: '## 결과\n\n- **통과** 286개\n- 링크: https://example.com/x.\n\n| 이름 | 값 |\n|---|---|\n| a | `1` |\n\n```ts\nconst a = 1\n```' })
events.emit(A, { type: 'tool', id: 't1', name: 'Bash', title: '💻 npm test https://example.com/t', detail: 'npm test' })
events.emit(A, { type: 'tool_end', id: 't1', ok: true, output: 'ok 286' })
events.emit(A, { type: 'todos', todos: [{ content: '하나', status: 'completed' }, { content: '둘', status: 'in_progress', activeForm: '둘 하는 중' }, { content: '셋', status: 'pending' }] })
events.emit(B, { type: 'msg', ts: '2000.5', text: '권한 요청', blocks: permBlocks(12) })
changed()

const api: AdminApi = {
  async adminState(): Promise<AdminState> {
    return { channelId: 'C1', pins: [], live: [], recent: [], archives: [] } as AdminState
  },
  async adminKill() { return { ok: true, note: '' } },
  async adminPurge() { return { ok: true, note: '' } },
  async adminRename(pid, title) {
    calls.push(`rename:${pid}:${title}`)
    sessions = sessions.map((s) => (s.pid === pid ? { ...s, title } : s))
    changed()
    return { ok: true, note: '이름을 바꿨습니다.' }
  },
  webSessions: () => sessions,
  async webSend(pid, text) {
    calls.push(`send:${pid}:${text}`)
    const s = sessions.find((x) => x.pid === pid)!
    const ts = `${s.thread.split('.')[0]}.${Date.now()}`
    events.emit(s.thread, { type: 'user', ts, text, via: 'web' })
    events.emit(s.thread, { type: 'react', ts, name: 'eyes', on: true })
    setTimeout(() => {
      events.emit(s.thread, { type: 'text', text: `받았어요: ${text}` })
      changed()
    }, 200)
    changed()
    return { ok: true, note: '보냈습니다.' }
  },
  async webAction(a) {
    calls.push(`action:${a.actionId.replace(/_\d+$/, '')}:${a.value}:${a.messageTs ?? ''}`)
    const auto = /^(\d+):auto (on|off)$/.exec(a.value)
    if (auto) {
      sessions = sessions.map((s) => (s.pid === Number(auto[1]) ? { ...s, autoAllow: auto[2] === 'on' } : s))
      changed()
    }
    if (a.messageTs === '2000.5') {
      events.emit(B, { type: 'msg_update', ts: '2000.5', text: '✅ 허용', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '✅ 허용됨 · `abcde`' } }] })
      sessions = sessions.map((s) => (s.thread === B ? { ...s, state: 'busy', waiting: undefined } : s))
      changed()
    }
    return { ok: true, note: '눌렀습니다.' }
  },
  events,
  onChange(l) {
    changes.add(l)
    return () => changes.delete(l)
  },
}

const server = createAdminServer(api, { port: 0 })
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`

let failed = 0
const check = (name: string, cond: unknown, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : ' ' + detail}`)
  if (!cond) failed++
}
const settle = (p: Page, ms = 400) => p.waitForTimeout(ms)

const browser = await chromium.launch()
for (const [label, size, phone] of [
  ['PC', { width: 1440, height: 820 }, false],
  ['폰', { width: 390, height: 844 }, true],
] as const) {
  const ctx = await browser.newContext({ viewport: size, hasTouch: phone, isMobile: phone })
  const page = await ctx.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await page.goto(base + '/')
  await page.waitForSelector('.row')
  check(`${label}: 목록에 세션 두 개`, (await page.locator('.row').count()) === 2)
  check(`${label}: 응답 대기 배지`, (await page.locator('.row .badge').first().textContent()) === '권한 대기')
  check(`${label}: 대기 세션이 맨 위`, ((await page.locator('.row .name').first().textContent()) ?? '') === '베타')
  if (phone) check(`${label}: 처음엔 대화 화면이 안 보임`, !(await page.locator('#main').isVisible()))

  // Open A and read it.
  await page.locator('.row', { hasText: '알파' }).click()
  await page.waitForSelector('.item.text')
  await settle(page)
  check(`${label}: 제목`, (await page.locator('#title').textContent()) === '알파 작업')
  check(`${label}: 마크다운 제목·표·코드`, (await page.locator('.item.text .md-h').count()) === 1 && (await page.locator('.item.text table').count()) === 1 && (await page.locator('.item.text pre').count()) === 1)
  const userLink = await page.locator('.item.user a').first().getAttribute('href')
  check(`${label}: 내 메시지 속 주소가 링크, 끝 ). 빠짐`, userLink === 'https://example.com/a', String(userLink))
  const textLink = await page.locator('.item.text a').first().getAttribute('href')
  check(`${label}: 답변 속 주소 끝 . 빠짐`, textLink === 'https://example.com/x', String(textLink))
  check(`${label}: 도구 줄 완료 배지`, (await page.locator('.tool .st').first().textContent()) === '완료')
  check(`${label}: 도구 출력은 펼치기 전엔 없음`, (await page.locator('.tool .detail').count()) === 0)
  // A link in the row opens the link only.
  const [popup] = await Promise.all([page.waitForEvent('popup').catch(() => null), page.locator('.tool .head a').click()])
  await popup?.close()
  check(`${label}: 도구 줄 링크는 칸을 펼치지 않음`, (await page.locator('.tool .detail').count()) === 0)
  await page.locator('.tool .head .st').click()
  check(`${label}: 도구 줄 펼치면 출력`, ((await page.locator('.tool .detail').textContent()) ?? '').includes('ok 286'))
  check(`${label}: 할 일 목록 입력칸 위`, (await page.locator('#todos').isVisible()) && ((await page.locator('#todos').textContent()) ?? '').includes('둘 하는 중'))

  // Send.
  await page.locator('#input').fill('안녕 https://example.com/q')
  if (phone) await page.locator('#btn-send').click()
  else await page.locator('#input').press('Enter')
  await page.waitForSelector('.item.text:has-text("받았어요")')
  check(`${label}: 보내면 브로커 webSend`, calls.some((c) => c.startsWith('send:11:안녕')))
  check(`${label}: 보낸 메시지와 전달됨 표시`, ((await page.locator('.item.user').last().textContent()) ?? '').includes('전달됨'))
  check(`${label}: 입력칸 비움`, (await page.locator('#input').inputValue()) === '')
  if (!phone) {
    await page.locator('#input').fill('줄1')
    await page.locator('#input').press('Shift+Enter')
    await page.locator('#input').type('줄2')
    check(`${label}: Shift+Enter 는 줄바꿈`, (await page.locator('#input').inputValue()) === '줄1\n줄2')
    await page.locator('#input').fill('')
  }

  // Draft survives switching sessions.
  await page.locator('#input').fill('쓰던 글')
  if (phone) await page.goBack()
  await page.locator('.row', { hasText: '베타' }).click()
  await page.waitForSelector('.card.decision')
  check(`${label}: 권한 카드 버튼`, (await page.locator('.card.decision button').count()) === 2)
  check(`${label}: 카드 코드 속 링크`, (await page.locator('.card.decision pre a').getAttribute('href')) === 'https://example.com/docs')
  if (!phone) {
    check(`${label}: 허용 버튼에 ⌘↵ 표시`, ((await page.locator('.card.decision button').first().textContent()) ?? '').includes('↵'))
    await page.locator('#input').focus()
    await page.keyboard.press('Meta+Enter')
  } else await page.locator('.card.decision button', { hasText: '허용' }).click()
  await page.waitForFunction(() => !document.querySelector('.card.decision'), null, { timeout: 3000 }).catch(() => {})
  check(`${label}: 허용은 Slack 과 같은 action 으로`, calls.some((c) => c === 'action:perm_allow_abcde:12:abcde:2000.5'), calls.join(' | '))
  check(`${label}: 답한 카드는 결과로 접힘`, (await page.locator('.card.decision').count()) === 0)
  check(`${label}: ⌘↵ 로 메시지가 보내지지 않음`, !calls.some((c) => c.startsWith('send:12')))
  if (phone) await page.goBack()
  await page.locator('.row', { hasText: '알파' }).click()
  await settle(page)
  check(`${label}: 쓰던 글 남음`, (await page.locator('#input').inputValue()) === '쓰던 글')
  await page.locator('#input').fill('')

  // 전부 허용 toggle: asks first, then runs the same `:auto on` command a thread would.
  page.once('dialog', (d) => d.accept())
  await page.locator('#btn-auto').click()
  await page.waitForFunction(() => document.getElementById('btn-auto')?.getAttribute('aria-pressed') === 'true', null, { timeout: 3000 }).catch(() => {})
  check(`${label}: 전부 허용 켜기는 :auto on 명령`, calls.some((c) => c.startsWith('action:ctl_btn_web:11:auto on')), calls.join(' | '))
  check(`${label}: 켜진 표시(토글·목록 ⚡)`, (await page.locator('#btn-auto').getAttribute('aria-pressed')) === 'true' && (await page.locator('.row .auto').count()) === 1)
  await page.locator('#btn-auto').click()
  await page.waitForFunction(() => document.getElementById('btn-auto')?.getAttribute('aria-pressed') === 'false', null, { timeout: 3000 }).catch(() => {})
  check(`${label}: 끄기는 묻지 않고 :auto off`, calls.some((c) => c.startsWith('action:ctl_btn_web:11:auto off')))

  // Live: an event arriving while the page is open.
  const live = `실시간으로 온 답 ${label}`
  events.emit(A, { type: 'text', text: live })
  changed()
  await page.waitForSelector(`text=${live}`, { timeout: 3000 }).catch(() => {})
  check(`${label}: SSE 로 새 답이 바로 붙음`, (await page.locator(`text=${live}`).count()) === 1)

  // Scroll horizontally never.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  check(`${label}: 가로 스크롤 없음`, overflow <= 0, String(overflow))
  await page.screenshot({ path: join(tmpdir(), `qa-web-${phone ? 'phone' : 'pc'}.png`) })
  check(`${label}: 페이지 오류 없음`, errors.length === 0, errors.join(' | '))
  calls.length = 0
  // Reset B's card for the next viewport.
  events.emit(B, { type: 'msg', ts: '2000.5', text: '권한 요청', blocks: permBlocks(12) })
  sessions = sessions.map((s) => (s.thread === B ? { ...s, state: 'waiting', waiting: '권한 대기' } : s))
  changed()
  await ctx.close()
}
await browser.close()
server.close()
console.log(failed ? `\n${failed} FAIL` : '\nALL PASS')
process.exit(failed ? 1 : 0)

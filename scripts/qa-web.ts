// End-to-end QA of the web app (/app) in a real browser, against a fake API: nothing here touches the running broker.
// Usage: node scripts/qa-web.ts        (needs playwright's chromium; prints PASS/FAIL per check, exits 1 on any FAIL)
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Page } from 'playwright'
import { createAdminServer, type AdminApi } from '../src/admin.ts'
import type { AdminState, WebSession } from '../src/broker.ts'
import { EventLog } from '../src/events.ts'
import { ImageStore } from '../src/images.ts'
import { deflateSync, crc32 } from 'node:zlib'

/** A PNG of noise (incompressible), to get a picture of a given byte size. */
function png(w: number, h: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(td) >>> 0)
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let i = 0; i < raw.length; i++) raw[i] = (Math.random() * 256) | 0
  for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
const imageStore = new ImageStore(mkdtempSync(join(tmpdir(), 'qa-img-')))

const events = new EventLog(mkdtempSync(join(tmpdir(), 'qa-web-')))
const calls: string[] = []
const changes = new Set<() => void>()
const now = Date.now()
const A = '1000.0001'
const B = '2000.0002'
const C = '3000.0003' // a long session: thousands of events
let sessions: WebSession[] = [
  { pid: 11, thread: A, cwd: '/p/alpha', title: '알파 작업', state: 'idle', model: 'opus', effort: 'high', permissionMode: 'default', contextLabel: '12%', startedAt: now - 60_000, held: 0, canKeys: true, autoAllow: false, lastSeq: 0, lastAt: now - 60_000, preview: '첫 메시지 A' },
  { pid: 13, thread: C, cwd: '/p/long', title: '긴 세션', state: 'idle', startedAt: now - 300_000, held: 0, canKeys: true, autoAllow: false, lastSeq: 0, lastAt: now - 300_000 },
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
events.emit(A, { type: 'tool_end', id: 't1', ok: true, output: 'ok 286', images: [imageStore.put(A, png(40, 24), 'image/png')!] })
events.emit(A, { type: 'text', text: '큰 스크린샷이에요', images: [imageStore.put(A, png(600, 400), 'image/png')!] })
events.emit(A, { type: 'todos', todos: [{ content: '하나', status: 'completed' }, { content: '둘', status: 'in_progress', activeForm: '둘 하는 중' }, { content: '셋', status: 'pending' }] })
events.emit(B, { type: 'msg', ts: '2000.5', text: '권한 요청', blocks: permBlocks(12) })
for (let i = 0; i < 1600; i++) {
  events.emit(C, { type: 'user', ts: `3000.${i}`, text: `질문 ${i}`, via: 'web' })
  events.emit(C, { type: 'tool', id: `c${i}`, name: 'Bash', title: `ls ${i}`, detail: 'ls' })
  events.emit(C, { type: 'tool_end', id: `c${i}`, ok: true, output: 'a\nb' })
  events.emit(C, { type: 'text', text: `답 **${i}**` })
}
changed()

const api: AdminApi = {
  async adminState(): Promise<AdminState> {
    return {
      channelId: 'C1', pins: [], live: [],
      recent: [{ id: 'r1', cwd: '/Users/me/p/old', title: '지난 작업', mtime: now - 3600_000, when: '1시간 전', preview: '이어서 할 일' }],
      archives: [{ path: '/tmp/a1.json', title: '보관된 것', cwd: '/p/alpha', sessionId: 'sa1', archivedAt: new Date(now - 86400_000).toISOString(), preview: '보관 첫 메시지', messages: 9 }],
    } as unknown as AdminState
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
  webOptions: () => ({ models: [{ label: 'Opus', value: 'opus' }, { label: 'Sonnet', value: 'sonnet' }], efforts: ['low', 'high'], modes: [{ label: 'manual', value: 'default' }, { label: 'auto', value: 'auto' }] }),
  async webSend(pid, text, images) {
    calls.push(`send:${pid}:${text}${images?.length ? `:images=${images.length}` : ''}`)
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
  async webFork(pid) {
    calls.push(`fork:${pid}`)
    const D = '4000.0004'
    events.emit(D, { type: 'user', ts: '4000.1', text: '원래 질문', via: 'web' }, now - 3600_000)
    events.emit(D, { type: 'notice', text: '여기까지 복제한 대화', icon: 'undo' })
    sessions = [...sessions, { pid: 14, thread: D, cwd: '/p/alpha', title: '알파 작업 (복제)', state: 'starting', startedAt: Date.now(), held: 0, canKeys: true, autoAllow: false, lastSeq: 0, lastAt: Date.now() }]
    changed()
    return { ok: true, note: '복제한 세션을 띄웁니다.', thread: D }
  },
  async webUnhold(pid, ts) {
    calls.push(`unhold:${pid}:${ts}`)
    const s = sessions.find((x) => x.pid === pid)!
    events.emit(s.thread, { type: 'react', ts, name: 'hourglass_flowing_sand', on: false })
    events.emit(s.thread, { type: 'react', ts, name: 'x', on: true })
    changed()
    return { ok: true, note: '대기열에서 뺐습니다.', text: '고칠 글' }
  },
  async webRetract(pid, ts) {
    calls.push(`retract:${pid}:${ts}`)
    return { ok: true, note: '멈추고 잘못 보냈다고 알렸습니다.' }
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
  images: imageStore,
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
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()))
  await page.goto(base + '/')
  await page.waitForSelector('.row')
  check(`${label}: 목록에 떠 있는 세션들`, (await page.locator('.row[data-thread]').count()) >= 3)
  check(`${label}: 응답 대기 배지`, ((await page.locator('.row[data-thread] .badge').first().textContent()) ?? '').includes('권한 대기'))
  check(`${label}: 대기 세션이 맨 위`, ((await page.locator('.row .name').first().textContent()) ?? '') === '베타')
  if (phone) check(`${label}: 처음엔 대화 화면이 안 보임`, !(await page.locator('#main').isVisible()))

  // Open A and read it.
  await page.locator(`.row[data-thread="${A}"]`).click()
  await page.waitForSelector('.item.text')
  await settle(page)
  check(`${label}: 제목`, (await page.locator('#title').textContent()) === '알파 작업')
  check(`${label}: 마크다운 제목·표·코드`, (await page.locator('.item.text .md-h').count()) === 1 && (await page.locator('.item.text table').count()) === 1 && (await page.locator('.item.text pre').count()) === 1)
  const userLink = await page.locator('.item.user a').first().getAttribute('href')
  check(`${label}: 내 메시지 속 주소가 링크, 끝 ). 빠짐`, userLink === 'https://example.com/a', String(userLink))
  const textLink = await page.locator('.item.text a').first().getAttribute('href')
  check(`${label}: 답변 속 주소 끝 . 빠짐`, textLink === 'https://example.com/x', String(textLink))
  check(`${label}: 도구 줄 완료 배지`, (await page.locator('.tool .st').first().textContent()) === '완료')
  check(`${label}: 도구 줄 앞 이모지 대신 SVG`, !((await page.locator('.tool .label').first().textContent()) ?? '').includes('💻') && (await page.locator('.tool .label svg').count()) >= 1)
  check(`${label}: 도구 출력은 펼치기 전엔 없음`, (await page.locator('.tool .detail').count()) === 0)
  // A link in the row opens the link only.
  const [popup] = await Promise.all([page.waitForEvent('popup').catch(() => null), page.locator('.tool .head a').click()])
  await popup?.close()
  check(`${label}: 도구 줄 링크는 칸을 펼치지 않음`, (await page.locator('.tool .detail').count()) === 0)
  await page.locator('.tool .head .st').click()
  check(`${label}: 도구 줄 펼치면 출력`, ((await page.locator('.tool .detail').textContent()) ?? '').includes('ok 286'))
  check(`${label}: 도구가 읽은 작은 그림은 이벤트에 실린 채로`, ((await page.locator('.tool .img img').first().getAttribute('src')) ?? '').startsWith('data:image/png'))
  await page.waitForFunction(() => (document.querySelector('.text .img img') as HTMLImageElement | null)?.complete && (document.querySelector('.text .img img') as HTMLImageElement).naturalWidth > 0, null, { timeout: 5000 }).catch(() => {})
  check(`${label}: 큰 그림은 참조로 받아 그린다`, await page.locator('.text .img img').evaluate((i: HTMLImageElement) => i.naturalWidth > 0 && (i.src.startsWith('blob:') || i.src.includes('/api/image/'))))
  const box = await page.locator('.text .img').boundingBox()
  check(`${label}: 그림 틀은 실제 비율대로 (600×400)`, !!box && Math.abs(box.width / box.height - 1.5) < 0.05, JSON.stringify(box))
  await page.locator('.text .img').click()
  check(`${label}: 누르면 페이지 안에서 크게 보기`, await page.locator('.viewer').count() === 1)
  await page.keyboard.press('Escape')
  check(`${label}: Esc 로 닫힘`, await page.locator('.viewer').count() === 0)
  check(`${label}: 할 일 목록 입력칸 위`, (await page.locator('#todos').isVisible()) && ((await page.locator('#todos').textContent()) ?? '').includes('둘 하는 중'))

  // Send.
  await page.locator('#input').fill(`안녕 ${label} https://example.com/q`)
  if (phone) await page.locator('#btn-send').click()
  else await page.locator('#input').press('Enter')
  await page.waitForSelector(`.item.text:has-text("받았어요: 안녕 ${label}")`)
  check(`${label}: 보내면 브로커 webSend`, calls.some((c) => c.startsWith('send:11:안녕')))
  check(`${label}: 보낸 메시지와 전달됨 표시`, ((await page.locator('.item.user').last().textContent()) ?? '').includes('전달됨'), (await page.locator('.item.user').last().textContent()) ?? '')
  check(`${label}: 입력칸 비움`, (await page.locator('#input').inputValue()) === '')
  if (!phone) {
    await page.locator('#input').fill('줄1')
    await page.locator('#input').press('Shift+Enter')
    await page.locator('#input').type('줄2')
    check(`${label}: Shift+Enter 는 줄바꿈`, (await page.locator('#input').inputValue()) === '줄1\n줄2')
    await page.locator('#input').fill('')
  }

  // A reload draws what the page kept, asks only for what came after it, and does not fetch a picture again.
  if (!phone) {
    await page.waitForTimeout(1300) // the timeline is kept a second after the last change
    const asked: string[] = []
    const onReq = (r: { url(): string }) => asked.push(r.url())
    page.on('request', onReq)
    await page.reload()
    await page.waitForSelector('.text .img img[src^="blob:"]', { timeout: 5000 }).catch(() => {})
    page.off('request', onReq)
    const ev = asked.filter((u) => u.includes('/api/events'))
    check(`${label}: 새로고침하면 둔 것부터 그리고 after=seq 로 빠진 것만`, ev.length >= 1 && ev.every((u) => !/after=0\b/.test(u)), ev.join(' '))
    check(`${label}: 받은 그림은 다시 받지 않는다(IndexedDB)`, !asked.some((u) => u.includes('/api/image/')), asked.filter((u) => u.includes('/api/image/')).join(' '))
    check(`${label}: 연결 전에도 목록이 보인다(localStorage)`, await page.evaluate(() => !!localStorage.getItem('sessions-cache')))
  }

  // The broker away for a moment (the proxy answers 502): the message waits and goes once it is back, once.
  if (!phone) {
    let refused = 0
    await page.route('**/api/session/11/send*', (route) => (refused++ === 0 ? route.fulfill({ status: 502, body: 'Bad Gateway' }) : route.continue()))
    const n0 = calls.filter((c) => c.startsWith('send:11:잠깐')).length
    await page.locator('#input').fill('잠깐 끊겼을 때')
    await page.locator('#input').press('Enter')
    await page.waitForFunction(() => true)
    await page.waitForTimeout(3500)
    await page.unroute('**/api/session/11/send*')
    check(`${label}: 브로커 없음(502)으로 거절된 명령은 돌아온 뒤 한 번 다시`, calls.filter((c) => c.startsWith('send:11:잠깐')).length === n0 + 1, calls.join(' | '))
    check(`${label}: 그동안 빨간 줄을 띄우지 않는다`, ((await page.locator('#conn').textContent()) ?? '') === '')
    // A network error may have reached the broker: reported, never sent again.
    await page.route('**/api/session/11/send*', (route) => route.abort('failed'))
    await page.locator('#input').fill('네트워크 오류')
    await page.locator('#input').press('Enter')
    await page.waitForSelector('#toast:not([hidden])', { timeout: 3000 }).catch(() => {})
    check(`${label}: 네트워크 오류는 알리고`, ((await page.locator('#toast').textContent()) ?? '').includes('확인할 수 없어요'))
    await page.unroute('**/api/session/11/send*')
    await page.waitForTimeout(3500)
    check(`${label}: 다시 보내지 않는다`, !calls.some((c) => c.startsWith('send:11:네트워크 오류')))
    await page.locator('#input').fill('')
  }

  // A picture to send: picked, shown small, removable, sent with the message.
  await page.locator('input[type=file]').setInputFiles({ name: 'shot.png', mimeType: 'image/png', buffer: png(30, 20) })
  await page.waitForSelector('.pending .thumb')
  check(`${label}: 고른 그림이 입력칸 위에 작게`, (await page.locator('.pending .thumb').count()) === 1)
  await page.locator('#btn-send').click()
  await page.waitForTimeout(300)
  check(`${label}: 그림만 보내도 된다 (images=1)`, calls.some((c) => c.startsWith('send:11:') && c.endsWith(':images=1')), calls.join(' | '))
  check(`${label}: 보내면 미리보기가 사라진다`, (await page.locator('.pending .thumb').count()) === 0)

  // A held message: "수정" takes it back into the field. A delivered one: "잘못 보냄" asks and retracts.
  events.emit(A, { type: 'user', ts: '1000.9', text: '고칠 글', via: 'web' })
  events.emit(A, { type: 'react', ts: '1000.9', name: 'hourglass_flowing_sand', on: true })
  changed()
  await page.waitForSelector('button[data-act="unhold"]')
  await page.locator('button[data-act="unhold"]').click()
  await page.waitForFunction(() => (document.getElementById('input') as HTMLTextAreaElement).value.includes('고칠 글'), null, { timeout: 3000 }).catch(() => {})
  check(`${label}: 수정 → 대기열에서 빼고 입력칸에`, calls.includes('unhold:11:1000.9') && (await page.locator('#input').inputValue()).includes('고칠 글'))
  await page.waitForSelector('text=취소함', { timeout: 3000 }).catch(() => {})
  check(`${label}: 뺀 메시지는 취소함`, (await page.locator('.user .failed', { hasText: '취소함' }).count()) >= 1)
  await page.locator('#input').fill('')
  page.once('dialog', (d) => d.accept())
  await page.locator('button[data-act="retract"]').first().click()
  await page.waitForTimeout(300)
  check(`${label}: 잘못 보냄 → 묻고 retract`, calls.some((c) => c.startsWith('retract:11:')), calls.join(' | '))

  // Draft survives switching sessions.
  await page.locator('#input').fill('쓰던 글')
  if (phone) await page.goBack()
  await page.locator('.row', { hasText: '베타' }).click()
  await page.waitForSelector('.card.decision')
  check(`${label}: 권한 카드 버튼`, (await page.locator('.card.decision button.btn').count()) === 2)
  check(`${label}: 카드 제목 이모지 대신 아이콘`, !((await page.locator('.card.decision .ttl').textContent()) ?? '').includes('🔐') && (await page.locator('.card.decision .ttl svg').count()) === 1)
  check(`${label}: 응답 기다리는 카드 안내`, ((await page.locator('#waiting-note').textContent()) ?? '').includes('1개'))
  check(`${label}: 카드 코드 속 링크`, (await page.locator('.card.decision pre a').getAttribute('href')) === 'https://example.com/docs')
  if (!phone) {
    check(`${label}: 허용 버튼에 ⌘↵ 표시`, ((await page.locator('.card.decision button.btn').first().textContent()) ?? '').includes('↵'))
    await page.locator('#input').focus()
    await page.keyboard.press('Meta+Enter')
  } else await page.locator('.card.decision button', { hasText: '허용' }).click()
  await page.waitForFunction(() => !document.querySelector('.card.decision'), null, { timeout: 3000 }).catch(() => {})
  check(`${label}: 허용은 Slack 과 같은 action 으로`, calls.some((c) => c === 'action:perm_allow_abcde:12:abcde:2000.5'), calls.join(' | '))
  check(`${label}: 답한 카드는 결과로 접힘`, (await page.locator('.card.decision').count()) === 0 && (await page.locator('.folded').count()) >= 1)
  check(`${label}: ⌘↵ 로 메시지가 보내지지 않음`, !calls.some((c) => c.startsWith('send:12')))
  // B is busy now: the activity box shows at the bottom.
  await page.waitForSelector('#activity:not([hidden])', { timeout: 3000 }).catch(() => {})
  check(`${label}: 작업 중이면 활동 상자`, await page.locator('#activity:not([hidden])').count() === 1)
  await page.screenshot({ path: join(tmpdir(), `qa-web-${phone ? 'phone' : 'pc'}-busy.png`) })
  if (phone) await page.goBack()
  await page.locator(`.row[data-thread="${A}"]`).click()
  await settle(page)
  check(`${label}: 쓰던 글 남음`, (await page.locator('#input').inputValue()) === '쓰던 글')
  await page.locator('#input').fill('')

  // 전부 허용 toggle: asks first, then runs the same `:auto on` command a thread would.
  page.once('dialog', (d) => d.accept())
  await page.locator('#btn-more').click()
  check(`${label}: 메뉴에 '이 세션' 항목`, (await page.locator('.menu .mhead', { hasText: '이 세션' }).count()) === 1)
  await page.locator('.menu .mi', { hasText: '전부 허용 켜기' }).click()
  await page.waitForSelector('#badge .badge.auto', { timeout: 3000 }).catch(() => {})
  check(`${label}: 전부 허용 켜기는 :auto on 명령`, calls.some((c) => c.startsWith('action:ctl_btn_web:11:auto on')), calls.join(' | '))
  check(`${label}: 켜진 표시(상태 줄 배지)`, (await page.locator('#badge .badge.auto').count()) === 1)
  await page.locator('#btn-more').click()
  await page.locator('.menu .mi', { hasText: '전부 허용 끄기' }).click()
  await page.waitForFunction(() => !document.querySelector('#badge .badge.auto'), null, { timeout: 3000 }).catch(() => {})
  check(`${label}: 끄기는 묻지 않고 :auto off`, calls.some((c) => c.startsWith('action:ctl_btn_web:11:auto off')))
  // 복제 opens the new session, with the copied history and the line where it ends.
  if (!phone) {
    await page.locator('#btn-more').click()
    await page.locator('.menu .mi', { hasText: '복제' }).click()
    await page.waitForSelector('text=여기까지 복제한 대화', { timeout: 3000 }).catch(() => {})
    check(`${label}: 복제 → 새 세션을 연다`, calls.includes('fork:11') && (await page.locator('.notice', { hasText: '여기까지 복제한 대화' }).count()) === 1)
    await page.locator(`.row[data-thread="${A}"]`).click()
    await page.waitForSelector('.item.text')
  }

  // Settings submenu reaches the model command.
  await page.locator('#btn-more').click()
  await page.locator('.menu .mi', { hasText: '설정 (모델·권한)' }).click()
  await page.locator('.menu .mi', { hasText: /^모델/ }).click()
  await page.locator('.menu .mi', { hasText: 'Sonnet' }).click()
  check(`${label}: 설정 › 모델 › Sonnet 은 model 명령`, calls.some((c) => c.startsWith('action:ctl_btn_web:11:model sonnet')), calls.join(' | '))

  // Live: an event arriving while the page is open.
  const live = `실시간으로 온 답 ${label}`
  events.emit(A, { type: 'text', text: live })
  changed()
  await page.waitForSelector(`text=${live}`, { timeout: 3000 }).catch(() => {})
  check(`${label}: SSE 로 새 답이 바로 붙음`, (await page.locator(`text=${live}`).count()) === 1)

  // A hidden tab closes its stream (here after 300ms instead of 30s) and catches up when shown again.
  if (!phone) {
    await page.goto(base + '/?hiddenMs=300#' + A)
    await page.waitForSelector('.item.text')
    const streams = () => page.evaluate(() => (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).filter((r) => r.name.includes('/api/stream')).length)
    const before = await streams()
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await page.waitForTimeout(500)
    const missed = `가려진 동안 온 답 ${label}`
    events.emit(A, { type: 'text', text: missed })
    changed()
    await page.waitForTimeout(200)
    check(`${label}: 가려진 탭은 받지 않는다`, (await page.locator(`text=${missed}`).count()) === 0)
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await page.waitForSelector(`text=${missed}`, { timeout: 3000 }).catch(() => {})
    check(`${label}: 다시 보이면 다시 붙어 따라잡는다`, (await page.locator(`text=${missed}`).count()) === 1 && (await streams()) > before)
  }

  // A long session (6400 events) opens by drawing only its newest rows; scrolling up draws more.
  if (phone) await page.goBack()
  const t0 = Date.now()
  await page.locator('.row', { hasText: '긴 세션' }).click()
  await page.waitForSelector('text=답 1599')
  const openMs = Date.now() - t0
  const drawn = await page.locator('#log > .item').count()
  check(`${label}: 긴 세션은 최근 줄만 그린다 (${drawn}줄, ${openMs}ms)`, drawn <= 150 && drawn >= 100, String(drawn))
  await page.locator('#scroller').evaluate((el) => (el.scrollTop = 0))
  await page.waitForTimeout(300)
  const more = await page.locator('#log > .item').count()
  check(`${label}: 위로 올리면 150줄 더 (${more}줄)`, more > drawn && more <= drawn + 150, String(more))
  if (phone) await page.goBack()
  await page.locator(`.row[data-thread="${A}"]`).click()
  await page.waitForSelector('.item.text')

  // Scroll horizontally never.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  check(`${label}: 가로 스크롤 없음`, overflow <= 0, String(overflow))
  await page.screenshot({ path: join(tmpdir(), `qa-web-${phone ? 'phone' : 'pc'}.png`) })
  if (!phone) {
    // Sidebar collapses to a rail and back (⌘\), and the choice is kept.
    await page.keyboard.press('Meta+Backslash')
    check(`${label}: ⌘\\ 사이드바 접기`, await page.locator('#app.collapsed').count() === 1)
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
    await page.screenshot({ path: join(tmpdir(), 'qa-web-pc-dark-collapsed.png') })
    await page.keyboard.press('Meta+Backslash')
    await page.evaluate(() => { delete document.documentElement.dataset.theme })
  } else {
    await page.goBack()
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(tmpdir(), 'qa-web-phone-list.png') })
    check(`${label}: 폰 목록 줄에 마지막 메시지·폴더`, ((await page.locator('.row[data-thread] .sub.where').first().textContent()) ?? '').includes('/p/'))
  }
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

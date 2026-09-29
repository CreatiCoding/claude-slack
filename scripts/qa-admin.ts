// End-to-end QA of the admin page in a real browser, against a fake API: nothing here touches the running broker's state.
// Usage: node scripts/qa-admin.ts        (needs playwright's chromium; prints PASS/FAIL per check, exits 1 on any FAIL)
import { chromium, type Page } from 'playwright'
import { createAdminServer, type AdminApi } from '../src/admin.ts'
import type { AdminState } from '../src/broker.ts'

const calls: string[] = []
const pins = new Set<string>()
const ok = (note: string) => ({ ok: true, note })
const now = Date.now()
const view = { title: '샘플 대화', cwd: '/p/alpha', sessionId: 's', live: true, messages: [
  { ts: '1.1', user: 'U1', bot: false, text: '안녕하세요' },
  { ts: '1.2', user: 'B', bot: true, text: '*반갑습니다*' },
] }

const api: AdminApi = {
  async adminState(): Promise<AdminState> {
    return {
      channelId: 'C1',
      pins: [...pins],
      live: [
        { pid: 11, key: 'k1', cwd: '/p/alpha', state: 'idle', startedAt: now - 60_000, busy: false, threadTs: '1.000', sessionId: 'sess-a', window: '@1', model: 'claude-opus-5', preview: '첫 메시지 A', messages: 7, link: 'https://slack.example/archives/C1/p1' },
        { pid: 12, key: 'k2', cwd: '/p/beta', state: 'busy', startedAt: now - 120_000, busy: true, threadTs: '2.000', sessionId: 'sess-b', canScreen: true, model: 'claude-sonnet-5', preview: '첫 메시지 B', messages: 120 },
        { pid: 13, key: 'k3', cwd: '/p/gamma', state: 'waiting', startedAt: now - 180_000, busy: false, threadTs: '3.000', waiting: '권한 대기', preview: '<https://x.dev/|링크> :tada: *굵게*' },
      ],
      recent: [{ id: 'r1', cwd: '/p/alpha', title: '지난 작업', mtime: now - 3600_000, when: '1시간 전', preview: '이어서 할 일', messages: 4 }],
      archives: [{ path: '/tmp/a1.json', title: '보관된 것', cwd: '/p/alpha', sessionId: 'sa1', archivedAt: new Date(now - 86400_000).toISOString(), preview: '보관 첫 메시지', messages: 9 }],
    } as AdminState
  },
  async adminKill(pid) { calls.push(`kill:${pid}`); return ok('종료') },
  async adminPurge(pid) { calls.push(`purge:${pid}`); return ok('삭제') },
  async adminDeleteArchive(p) { calls.push(`delArchive:${p}`); return ok('삭제') },
  async adminResume(id) { calls.push(`resume:${id}`); return ok('이어서') },
  async adminDeleteRecent(id) { calls.push(`delRecent:${id}`); return ok('삭제') },
  async adminPin(key, pinned) { calls.push(`pin:${key}:${pinned}`); pinned ? pins.add(key) : pins.delete(key); return ok('고정') },
  async adminScreenPng() { return Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' + '1f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082', 'hex') },
  async adminOrphans() {
    return [
      { ts: '9.001', kind: 'ended', title: '끊긴 스레드', replies: 3, at: now - 5000, sessionId: 'sess-o' },
      { ts: '9.002', kind: 'unknown', title: '알 수 없는 스레드', replies: 0, at: now - 9000 },
    ]
  },
  async adminThreadLink(ts) { return `https://slack.example/archives/C1/p${ts.replace('.', '')}` },
  async adminArchiveThread() { return view },
  async adminOrphanThread() { return view },
  async adminPurgeOrphan(ts) { calls.push(`purgeOrphan:${ts}`); return ok('정리 시작') },
  async adminResumeOrphan(ts) { calls.push(`resumeOrphan:${ts}`); return ok('이어서') },
  async adminPurgeOrphans() { calls.push('purgeOrphans'); return ok('정리 시작') },
  async adminRename(pid, title) { calls.push(`rename:${pid}:${title}`); return ok('이름 변경') },
  async adminRenameArchive(p, title) { calls.push(`renameArchive:${p}:${title}`); return ok('이름 변경') },
  async adminNew(o) { calls.push(`new:${o.cwd}`); return ok('시작') },
  async adminScreen() { return { ok: true, screen: 'x' } },
}

const server = createAdminServer(api, { port: 0 })
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`

let failed = 0
const check = (name: string, cond: unknown, detail = '') => {
  if (!cond) failed++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail ? `  → ${detail}` : ''}`)
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

const rowOf = (p: Page, text: string) => p.locator('tr', { hasText: text }).first()
async function openMenu(p: Page, text: string) {
  await rowOf(p, text).locator('summary').click()
  await wait(150)
}
async function menuItem(p: Page, text: string, label: string) {
  return rowOf(p, text).locator('.menu-list button', { hasText: new RegExp(`^${label}$`) })
}
async function menuLabels(p: Page, text: string) {
  return rowOf(p, text).locator('.menu-list button').evaluateAll((bs) => bs.map((b) => (b.textContent ?? '') + ((b as HTMLButtonElement).disabled ? '(off)' : '')))
}

const browser = await chromium.launch()
for (const [device, viewport] of [['desktop', { width: 1280, height: 800 }], ['phone', { width: 430, height: 900 }]] as const) {
  console.log(`\n===== ${device} =====`)
  calls.length = 0
  pins.clear()
  const ctx = await browser.newContext({ viewport, hasTouch: device === 'phone' })
  await ctx.route('https://slack.example/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: 'slack' }))
  const p = await ctx.newPage()
  const errs: string[] = []
  p.on('pageerror', (e) => errs.push(e.message))
  p.on('console', (m) => m.type() === 'error' && errs.push(m.text()))
  p.on('dialog', async (d) => { calls.push(`dialog:${d.type()}`); await d.accept(d.type() === 'prompt' ? '새이름' : undefined) })
  await p.goto(base + '/admin')
  await p.waitForSelector('tr .cell-actions', { timeout: 10000 })

  check('첫 화면에 카드가 그려진다 (요청 1번)', (await p.locator('tbody tr').count()) === 5)
  check('페이지 오류·콘솔 오류 없음', errs.length === 0, errs.join(' | '))
  check('iOS 바운스(고무줄 스크롤)가 꺼져 있다', await p.evaluate(() => getComputedStyle(document.documentElement).overscrollBehaviorY === 'none' && getComputedStyle(document.body).overscrollBehaviorY === 'none'))
  check('가로 스크롤이 생기지 않는다', await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
  check('대화 수가 보인다 (💬 7)', (await p.locator('tr', { hasText: '첫 메시지 A' }).innerText()).includes('7'))
  check('첫 메시지의 링크·이모지·굵게 표기가 정리돼 보인다', !(await rowOf(p, 'x.dev').innerText().catch(() => '')).includes('<https'), '')

  // ---- tabs & search
  for (const [tab, n] of [['실행 중', 3], ['이어서', 1], ['보관', 1]] as const) {
    await p.locator('.tabs button', { hasText: tab }).click()
    check(`탭 ${tab}: ${n}행`, (await p.locator('tbody tr').count()) === n)
  }
  await p.locator('.tabs button', { hasText: '전체' }).click()
  await p.fill('#q', '첫 메시지 B')
  check('검색: 첫 메시지로 걸러진다', (await p.locator('tbody tr').count()) === 1)
  await p.fill('#q', '')

  // ---- live row actions
  await openMenu(p, '첫 메시지 B')
  check('창 이름이 없어도 tmux 화면을 읽을 수 있으면 "화면"이 켜진다', !(await menuLabels(p, '첫 메시지 B')).includes('화면(off)'), (await menuLabels(p, '첫 메시지 B')).join(','))
  await p.keyboard.press('Escape')
  await openMenu(p, '첫 메시지 A')
  check('live 메뉴 항목 구성', JSON.stringify(await menuLabels(p, '첫 메시지 A')) === JSON.stringify(['화면', '기록 보기', '이어서 하기(off)', '이름 변경', '상단에 고정', '세션 종료', '스레드 삭제']), JSON.stringify(await menuLabels(p, '첫 메시지 A')))
  await p.keyboard.press('Escape')
  check('Esc 로 메뉴가 닫힌다', (await p.locator('details.menu[open]').count()) === 0)
  await openMenu(p, '첫 메시지 A')
  await p.mouse.click(5, 5)
  await wait(150)
  check('바깥을 누르면 메뉴가 닫힌다', (await p.locator('details.menu[open]').count()) === 0)
  await openMenu(p, '첫 메시지 A')
  await wait(4800)
  check('메뉴를 연 채 갱신이 지나가도 열려 있다', (await p.locator('details.menu[open]').count()) === 1)
  await p.keyboard.press('Escape')

  const [thread] = await Promise.all([ctx.waitForEvent('page', { timeout: 5000 }).catch(() => null), rowOf(p, '첫 메시지 A').locator('.cell-actions > button').first().click()])
  check('스레드 열기: 새 탭이 Slack 링크로 열린다', thread && /slack\.example/.test(thread.url()), thread?.url())
  await thread?.close()
  const [thread2] = await Promise.all([ctx.waitForEvent('page', { timeout: 5000 }).catch(() => null), rowOf(p, '첫 메시지 B').locator('.cell-actions > button').first().click()])
  check('스레드 열기: 링크가 없으면 다리 페이지로 열린다', thread2 && /\/go\/thread/.test(thread2.url()), thread2?.url())
  await thread2?.close()

  await openMenu(p, '첫 메시지 A')
  const [screenTab] = await Promise.all([ctx.waitForEvent('page', { timeout: 5000 }).catch(() => null), (await menuItem(p, '첫 메시지 A', '화면')).click()])
  check('화면: 새 탭에 이미지가 뜬다', screenTab && /\/screen\/11/.test(screenTab.url()), screenTab?.url())
  await screenTab?.close()

  await openMenu(p, '첫 메시지 A')
  await (await menuItem(p, '첫 메시지 A', '기록 보기')).click()
  await wait(800)
  check('기록 보기: 패널이 열리고 대화가 채워진다', (await p.locator('#panel-frame').isVisible()) && ((await p.frameLocator('#panel-frame').locator('body').innerText()).includes('안녕하세요')))
  const panelBox = await p.locator('.panel-body').boundingBox()
  check('패널이 화면 안에 들어온다', panelBox && panelBox.x >= -1 && panelBox.x + panelBox.width <= viewport.width + 1, JSON.stringify(panelBox))
  await p.locator('.panel-body header button').click()
  check('✕ 로 패널이 닫힌다', !(await p.locator('.panel-body').isVisible()))
  await openMenu(p, '첫 메시지 A')
  await (await menuItem(p, '첫 메시지 A', '기록 보기')).click()
  await wait(400)
  await p.keyboard.press('Escape')
  check('Esc 로 패널이 닫힌다', !(await p.locator('.panel-body').isVisible()))
  await openMenu(p, '첫 메시지 A')
  await (await menuItem(p, '첫 메시지 A', '기록 보기')).click()
  await wait(400)
  if (device === 'desktop') {
    await p.mouse.click(20, 400)
    check('바깥(어두운 영역)을 눌러도 패널이 닫힌다', !(await p.locator('.panel-body').isVisible()))
  }
  if (await p.locator('.panel-body').isVisible()) await p.keyboard.press('Escape')
  if (device === 'phone') {
    await openMenu(p, '첫 메시지 A')
    await (await menuItem(p, '첫 메시지 A', '기록 보기')).click()
    await wait(400)
    await p.goBack().catch(() => {})
    await wait(300)
    check('폰: 뒤로가기(브라우저 Back)로 패널이 닫힌다', !(await p.locator('.panel-body').isVisible()) && p.url().startsWith(base), p.url())
    if (await p.locator('.panel-body').isVisible()) await p.keyboard.press('Escape')
  }

  await openMenu(p, '첫 메시지 A')
  await (await menuItem(p, '첫 메시지 A', '이름 변경')).click()
  await wait(300)
  check('이름 변경: API 호출', calls.includes('rename:11:새이름'), calls.join(','))

  await openMenu(p, '첫 메시지 A')
  await (await menuItem(p, '첫 메시지 A', '상단에 고정')).click()
  await wait(500)
  check('고정: API 호출 + 행이 맨 위로', calls.includes('pin:s:sess-a:true') && (await p.locator('tbody tr').first().innerText()).includes('첫 메시지 A'), calls.join(','))
  await openMenu(p, '첫 메시지 A')
  check('고정된 행 메뉴는 "고정 해제"', (await menuLabels(p, '첫 메시지 A')).includes('고정 해제'))
  await (await menuItem(p, '첫 메시지 A', '고정 해제')).click()
  await wait(500)
  check('고정 해제: API 호출', calls.includes('pin:s:sess-a:false'), calls.join(','))
  await p.locator('button.pin', { hasText: '📌' }).first().click()
  await wait(500)
  check('📌 버튼으로도 고정된다', pins.size === 1, [...pins].join(','))
  pins.clear()

  await openMenu(p, '첫 메시지 B')
  await (await menuItem(p, '첫 메시지 B', '세션 종료')).click()
  await wait(400)
  check('세션 종료: 확인 후 API 호출', calls.includes('kill:12') && calls.includes('dialog:confirm'), calls.join(','))
  await openMenu(p, '첫 메시지 B')
  await (await menuItem(p, '첫 메시지 B', '스레드 삭제')).click()
  await wait(400)
  check('스레드 삭제: 확인 후 API 호출', calls.includes('purge:12'), calls.join(','))

  // ---- recent / archive
  await p.locator('.tabs button', { hasText: '이어서' }).click()
  await rowOf(p, '이어서 할 일').locator('.cell-actions > button').first().click()
  await wait(400)
  check('이어서 목록: 이어서 하기', calls.includes('resume:r1'), calls.join(','))
  await openMenu(p, '이어서 할 일')
  const recentLabels = await menuLabels(p, '이어서 할 일')
  check('이어서 메뉴: 스레드가 없어 못 하는 것은 비활성, 고정·삭제는 가능', recentLabels.includes('스레드 열기(off)') && recentLabels.includes('삭제') && recentLabels.includes('상단에 고정'), recentLabels.join(','))
  await (await menuItem(p, '이어서 할 일', '삭제')).click()
  await wait(400)
  check('이어서 목록: 삭제', calls.includes('delRecent:r1'), calls.join(','))

  await p.locator('.tabs button', { hasText: '보관' }).click()
  await openMenu(p, '보관 첫 메시지')
  await (await menuItem(p, '보관 첫 메시지', '기록 보기')).click()
  await wait(800)
  check('보관: 기록 보기 패널', await p.locator('#panel-frame').isVisible())
  await p.keyboard.press('Escape')
  await openMenu(p, '보관 첫 메시지')
  await (await menuItem(p, '보관 첫 메시지', '이름 변경')).click()
  await wait(300)
  check('보관: 이름 변경', calls.some((c) => c.startsWith('renameArchive:/tmp/a1.json')), calls.join(','))
  await openMenu(p, '보관 첫 메시지')
  await (await menuItem(p, '보관 첫 메시지', '삭제')).click()
  await wait(300)
  check('보관: 삭제', calls.includes('delArchive:/tmp/a1.json'), calls.join(','))

  // ---- orphans
  await p.locator('.tabs button', { hasText: '잔재' }).click()
  await wait(800)
  check('잔재 탭: 2행', (await p.locator('tbody tr').count()) === 2, String(await p.locator('tbody tr').count()))
  await p.locator('#bulk button', { hasText: '모두 정리' }).click()
  await wait(400)
  check('잔재: 모두 정리', calls.includes('purgeOrphans'), calls.join(','))
  await rowOf(p, '끊긴 스레드').locator('.cell-actions > button').first().click()
  await wait(400)
  check('잔재: 스레드 정리', calls.includes('purgeOrphan:9.001'), calls.join(','))
  await openMenu(p, '끊긴 스레드')
  await (await menuItem(p, '끊긴 스레드', '이어서 하기')).click()
  await wait(400)
  check('잔재: 이어서 하기', calls.includes('resumeOrphan:9.001'), calls.join(','))

  // ---- new session form
  await p.locator('.tabs button', { hasText: '전체' }).click()
  const form = p.locator('#form')
  await form.locator('input').first().fill('/p/new')
  await form.locator('button').first().click()
  await wait(400)
  check('새 세션 시작', calls.includes('new:/p/new'), calls.join(','))

  // ---- touch targets & names
  const small = await p.locator('tr .cell-actions > button, tr summary').evaluateAll((els) => els.filter((e) => e.getBoundingClientRect().height < (window.innerWidth < 600 ? 40 : 28)).length)
  check(device === 'phone' ? '폰: 주요 버튼 높이 40px 이상' : '데스크톱: 버튼 높이 28px 이상', small === 0, `${small}개가 작음`)
  const unnamed = await p.locator('button, summary').evaluateAll((els) => els.filter((e) => !(e.textContent ?? '').trim() && !e.getAttribute('title') && !e.getAttribute('aria-label')).length)
  check('이름 없는 버튼이 없다', unnamed === 0, `${unnamed}개`)
  check('끝까지 오류 없음', errs.length === 0, errs.join(' | '))
  await ctx.close()
}

await browser.close()
server.close()
console.log(failed ? `\n${failed}개 실패` : '\n모두 통과')
process.exit(failed ? 1 : 0)

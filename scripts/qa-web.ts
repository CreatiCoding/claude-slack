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
import { GroupStore } from '../src/groups.ts'
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
const groupStore = new GroupStore(join(mkdtempSync(join(tmpdir(), 'qa-grp-')), 'groups.json'))
let defaultPrompt = ''

const events = new EventLog(mkdtempSync(join(tmpdir(), 'qa-web-')))
const calls: string[] = []
const changes = new Set<() => void>()
let liveText = ''
const now = Date.now()
const A = '1000.0001'
const B = '2000.0002'
const C = '3000.0003' // a long session: thousands of events
let sessions: WebSession[] = [
  { pid: 11, thread: A, cwd: '/p/alpha', title: '알파 작업', state: 'idle', model: 'claude-opus-5-5', plugins: [{ market: 'cdt-skills', version: '0.4.2', latest: '0.5.0' }], effort: 'high', permissionMode: 'default', contextLabel: '12%', startedAt: now - 60_000, held: 0, canKeys: true, autoAllow: false, lastSeq: 0, lastAt: now - 60_000, preview: '첫 메시지 A' },
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
events.emit(A, { type: 'user', ts: '999.1', text: Array.from({ length: 20 }, (_, i) => `긴 줄 ${i + 1}`).join('\n'), via: 'web' })
events.emit(A, { type: 'user', ts: '1000.1', text: '테스트 돌려 줘 https://example.com/a).', via: 'slack' })
events.emit(A, { type: 'text', text: '## 결과\n\n- **통과** 286개\n- 링크: https://example.com/x.\n\n| 이름 | 값 |\n|---|---|\n| a | `1` |\n\n```ts\nconst a = 1\n```' })
events.emit(A, { type: 'tool', id: 't1', name: 'Bash', title: '💻 npm test https://example.com/t', detail: 'npm test' })
events.emit(A, { type: 'tool_end', id: 't1', ok: true, output: 'ok 286', images: [imageStore.put(A, png(40, 24), 'image/png')!] })
events.emit(A, { type: 'text', text: '표를 그렸어요\n\n````html\n<!doctype html><html><head><meta http-equiv="refresh" content="0;url=https://evil.example"></head><body><h1 id="h">안녕 HTML</h1><script>document.getElementById("h").textContent = "스크립트가 돌았다"</script><a href="https://example.com">링크</a></body></html>\n````' })
events.emit(A, { type: 'text', text: '큰 스크린샷이에요', images: [imageStore.put(A, png(600, 400), 'image/png')!] })
events.emit(A, { type: 'todos', todos: [{ content: '하나', status: 'completed' }, { content: '둘', status: 'in_progress', activeForm: '둘 하는 중' }, { content: '셋', status: 'pending' }] })
events.emit(B, { type: 'msg', ts: '2000.5', text: '권한 요청', blocks: permBlocks(12) })
sessions = sessions.map((x) => (x.thread === B ? { ...x, permission: { ts: '2000.5', text: '권한 요청', blocks: permBlocks(12) } } : x))
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
  webGroups: () => groupStore.get(),
  webGroupOp(o) {
    calls.push(`group:${(o as { op: string }).op}`)
    const r = groupStore.apply(o)
    changed()
    return r
  },
  webDefaultPrompt: () => defaultPrompt,
  webSetDefaultPrompt(t) {
    defaultPrompt = t
    calls.push(`prompt:${t}`)
    return { ok: true, note: '저장했어요. 새로 띄우거나 다시 연 세션부터 적용돼요.' }
  },
  async webClearArchives() {
    calls.push('clearArchives')
    return { ok: true, note: '지난 기록 1개를 지웠어요.' }
  },
  async webRefreshInfo(pid) {
    return pid === 12 ? { busy: true, tasks: [{ kind: 'bash', label: 'npm run dev' }, { kind: 'monitor', label: 'tail -f log' }] } : { busy: false, tasks: [] }
  },
  async webLinks(pid) {
    return pid === 11
      ? { prs: [{ url: 'https://github.com/a/b/pull/1', label: '#1 첫 PR' }, { url: 'https://github.com/a/c/pull/2', label: '#2 둘째 PR' }], threads: [{ url: 'https://x.slack.com/archives/C1/p1000000100000001', label: '이 세션의 스레드' }] }
      : { prs: [], threads: [] }
  },
  async webLive(thread) {
    return thread === B && liveText ? liveText : ''
  },
  webFolders(path) {
    const p = path || '/Users/me/projects'
    return { ok: true, path: p, parent: '/Users/me', dirs: p.endsWith('projects') ? [{ name: 'alpha', git: true }, { name: 'beta', git: false }] : [] }
  },
  async adminNew(o) {
    calls.push(`new:${o.cwd}:${o.model ?? ''}:${o.create ? 'create' : ''}:${o.prompt ?? ''}`)
    if (o.cwd.endsWith('/nope') && !o.create) return { ok: false, missing: true, note: '폴더가 없어요' }
    return { ok: true, note: '세션을 띄웁니다.', thread: A }
  },
  webTrashInfo(pid) {
    calls.push(`trash-info:${pid}`)
    return { ok: true, note: '', folder: '/Users/me/p/alpha', repos: [{ path: '/Users/me/p/alpha', uncommitted: 2, unpushed: 1 }] }
  },
  async webTrash(pid) {
    calls.push(`trash:${pid}`)
    return { ok: true, note: '휴지통으로 옮겼습니다: ~/.Trash/alpha' }
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
      sessions = sessions.map((s) => (s.thread === B ? { ...s, state: 'busy', waiting: undefined, permission: undefined } : s))
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

const clientErrors: string[] = []
const server = createAdminServer(api, { port: 0, clientLog: (e) => clientErrors.push(e) })
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`

let failed = 0
const check = (name: string, cond: unknown, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : ' ' + detail}`)
  if (!cond) failed++
}
const settle = (p: Page, ms = 400) => p.waitForTimeout(ms)

const browser = await chromium.launch()
// A frame that cannot be parsed is recorded (screen error log) and does not stop the frames after it.
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 820 } })
  const page = await ctx.newPage()
  let served = false
  await page.route('**/api/stream*', async (route) => {
    if (served) return route.continue()
    served = true
    await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: `retry: 100\n\nevent: sessions\ndata: {not json\n\nevent: sessions\ndata: ${JSON.stringify(sessions)}\n\n` })
  })
  await page.goto(base + '/')
  await page.waitForSelector('.row[data-thread]', { timeout: 5000 }).catch(() => {})
  await page.waitForTimeout(300)
  check('깨진 프레임: 다음 프레임은 그대로 그린다', (await page.locator('.row[data-thread]').count()) >= 3)
  check('깨진 프레임: 화면 오류 기록으로 간다', clientErrors.some((e) => /화면 오류 \[pc\] sse:sessions:/.test(e)), clientErrors.join(' | '))
  await ctx.close()
}

for (const [label, size, phone] of [
  ['PC', { width: 1440, height: 820 }, false],
  ['폰', { width: 390, height: 844 }, true],
] as const) {
  const ctx = await browser.newContext({ viewport: size, hasTouch: phone, isMobile: phone })
  const page = await ctx.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource|Blocked script execution .* sandboxed/.test(m.text()) && errors.push(m.text()))
  await page.goto(base + '/')
  await page.waitForSelector('.row')
  check(`${label}: 목록에 떠 있는 세션들`, (await page.locator('.row[data-thread]').count()) >= 3)
  check(`${label}: 응답 대기 배지`, ((await page.locator(`.row[data-thread="${B}"] .badge`).first().textContent()) ?? '').includes('권한 대기'))
  check(`${label}: 대기 세션이 맨 위`, ((await page.locator('.row[data-loose] .name').first().textContent()) ?? '') === '베타')
  if (phone) check(`${label}: 처음엔 대화 화면이 안 보임`, !(await page.locator('#main').isVisible()))

  // B waits for a permission, so a modal asks about it on whatever screen this is; tapping outside dismisses it.
  await page.waitForSelector('.perm-modal', { timeout: 3000 }).catch(() => {})
  check(`${label}: 다른 세션의 권한 대기는 모달로`, ((await page.locator('.perm-modal .pm-name').textContent().catch(() => '')) ?? '') === '베타' && (await page.locator('.perm-modal button[data-action^="perm_allow"]').count()) === 1)
  check(`${label}: 모달에 세션으로 가기`, (await page.locator('.perm-modal .btn', { hasText: '세션으로 가기' }).count()) === 1)
  await page.mouse.click(5, 300)
  await page.waitForTimeout(150)
  check(`${label}: 바깥을 누르면 닫고 다시 띄우지 않는다`, (await page.locator('.perm-modal').count()) === 0)
  await page.locator(`.row[data-thread="${A}"]`).click()
  await page.waitForSelector('.item.text')
  await settle(page)
  check(`${label}: 제목`, (await page.locator('#title').textContent()) === '알파 작업')
  const metaText = (await page.locator('#meta').textContent()) ?? ''
  check(`${label}: 헤더에 세션이 쓰는 플러그인 버전과 "새로고침하면"`, metaText.includes('cdt-skills 0.4.2') && metaText.includes('새로고침하면 0.5.0'), metaText)
  check(`${label}: 모델 이름(${phone ? '폰은 줄여서' : 'PC 는 그대로'})`, phone ? metaText.startsWith('opus 5.5') : metaText.startsWith('claude-opus-5-5'), metaText)
  const answer = page.locator('.item.text', { hasText: '통과' }).first()
  check(`${label}: 마크다운 제목·표·코드`, (await answer.locator('.md-h').count()) === 1 && (await answer.locator('table').count()) === 1 && (await answer.locator('pre').count()) === 1)
  const userLink = await page.locator('.item.user a').first().getAttribute('href')
  check(`${label}: 내 메시지 속 주소가 링크, 끝 ). 빠짐`, userLink === 'https://example.com/a', String(userLink))
  const textLink = await page.locator('.item.text a').first().getAttribute('href')
  check(`${label}: 답변 속 주소 끝 . 빠짐`, textLink === 'https://example.com/x', String(textLink))
  const longMsg = page.locator('.item.user', { hasText: '긴 줄 1' })
  check(`${label}: 긴 메시지는 앞 8줄만`, ((await longMsg.locator('.bubble').textContent()) ?? '').includes('긴 줄 8') && !((await longMsg.locator('.bubble').textContent()) ?? '').includes('긴 줄 9'))
  await longMsg.locator('.more-toggle').click()
  check(`${label}: 펼치기 (12줄 더) → 전부, 접기`, ((await longMsg.locator('.bubble').textContent()) ?? '').includes('긴 줄 20') && (await longMsg.locator('.more-toggle').textContent()) === '접기')
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
  // ```html (here with a 4-backtick fence) is drawn in a sandboxed frame: no scripts, no refresh, links outside.
  await page.waitForFunction(() => (document.querySelector('.htmlprev iframe') as HTMLIFrameElement | null)?.contentDocument?.getElementById('h'), null, { timeout: 3000 }).catch(() => {})
  const frameText = await page.evaluate(() => (document.querySelector('.htmlprev iframe') as HTMLIFrameElement).contentDocument?.getElementById('h')?.textContent)
  check(`${label}: HTML 블럭을 그린다(스크립트 없이)`, frameText === '안녕 HTML', String(frameText))
  const frameAttrs = await page.evaluate(() => {
    const f = document.querySelector('.htmlprev iframe') as HTMLIFrameElement
    const d = f.contentDocument!
    return { sandbox: f.getAttribute('sandbox'), csp: d.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content'), refresh: !!d.querySelector('meta[http-equiv="refresh"]'), base: d.querySelector('base')?.getAttribute('target') }
  })
  check(`${label}: 샌드박스·CSP·base·refresh 제거`, frameAttrs.sandbox === 'allow-same-origin' && /script-src 'none'/.test(frameAttrs.csp ?? '') && !frameAttrs.refresh && frameAttrs.base === '_blank', JSON.stringify(frameAttrs))
  check(`${label}: 코드 칸은 숨기고 "코드 보기"`, (await page.locator('.htmlprev + .codebox, .codebox[hidden]').count()) >= 1)
  await page.locator('.hp-big').first().click()
  check(`${label}: 크게 보기`, (await page.locator('.hp-full iframe').count()) === 1)
  await page.keyboard.press('Escape')
  await page.waitForSelector('.chip:has-text("PR 2")', { timeout: 3000 }).catch(() => {})
  check(`${label}: PR 이 여러 개면 "PR 2" 칩`, (await page.locator('.chip', { hasText: 'PR 2' }).count()) === 1)
  await page.locator('.chip', { hasText: 'PR 2' }).click()
  check(`${label}: 누르면 목록`, (await page.locator('.menu .mi', { hasText: '#2 둘째 PR' }).count()) === 1)
  await page.keyboard.press('Escape')
  check(`${label}: Slack 스레드 하나면 바로 링크`, (await page.locator('a.chip', { hasText: 'Slack 스레드' }).getAttribute('href')) === 'https://x.slack.com/archives/C1/p1000000100000001')
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
  // Refresh while working: a choice, with the background work that would be cut; "끝나면" is the default.
  await page.locator('#btn-more').click()
  await page.locator('.menu .mi', { hasText: '새로고침' }).click()
  await page.waitForSelector('.choice-sheet')
  check(`${label}: 작업 중 새로고침은 두 선택지와 끊길 작업`, ((await page.locator('.choice-sheet').textContent()) ?? '').includes('백그라운드 작업 2개') && (await page.locator('.choice-sheet .btn.primary').textContent()) === '끝나면 새로고침')
  await page.locator('.choice-sheet .btn.primary').click()
  await page.waitForTimeout(200)
  check(`${label}: 끝나면 새로고침 → refresh later`, calls.some((c) => c.startsWith('action:ctl_btn_web:12:refresh later')), calls.join(' | '))
  sessions = sessions.map((x) => (x.thread === B ? { ...x, refreshAfter: true } : x))
  changed()
  await page.waitForSelector('.refresh-plan', { timeout: 3000 }).catch(() => {})
  check(`${label}: 헤더에 "끝나면 새로고침해요 · 취소"`, ((await page.locator('.refresh-plan').textContent()) ?? '').includes('끝나면 새로고침해요'))
  await page.locator('.refresh-plan button').click()
  await page.waitForTimeout(200)
  check(`${label}: 취소 → refresh cancel`, calls.some((c) => c.startsWith('action:ctl_btn_web:12:refresh cancel')))
  sessions = sessions.map((x) => (x.thread === B ? { ...x, refreshAfter: undefined } : x))
  changed()

  if (!phone) {
    // Esc stops the session being watched (like the chip), but not while a menu is open.
    await page.locator('#btn-more').click()
    await page.keyboard.press('Escape')
    check(`${label}: 메뉴가 떠 있으면 Esc 는 메뉴만 닫는다`, !calls.some((c) => c.startsWith('action:ctl_btn_web:12:esc')) && (await page.locator('.menu').count()) === 0)
    await page.locator('#input').focus()
    await page.keyboard.press('Escape')
    await page.waitForTimeout(150)
    check(`${label}: 작업 중 Esc 는 중단`, calls.some((c) => c.startsWith('action:ctl_btn_web:12:esc')), calls.join(' | '))
    check(`${label}: 칩에 "중단 · Esc"`, (await page.locator('.chip', { hasText: '중단 · Esc' }).count()) === 1)
  }

  // B is busy now: the activity box shows at the bottom.
  await page.waitForSelector('#activity:not([hidden])', { timeout: 3000 }).catch(() => {})
  check(`${label}: 작업 중이면 활동 상자`, await page.locator('#activity:not([hidden])').count() === 1)
  // What is being written shows in the activity box (two lines, faded) and clears when the answer lands.
  liveText = '지금 쓰는 중인 글의 앞부분이고\n이어지는 둘째 줄'
  await page.waitForSelector('#activity .tail', { timeout: 5000 }).catch(() => {})
  await page.waitForFunction(() => (document.querySelector('#activity .tail')?.textContent ?? '').includes('둘째 줄'), null, { timeout: 5000 }).catch(() => {})
  check(`${label}: 쓰는 중 미리보기`, ((await page.locator('#activity .txt').textContent()) ?? '').includes('쓰는 중') && ((await page.locator('#activity .tail').textContent()) ?? '').includes('둘째 줄'))
  await page.screenshot({ path: join(tmpdir(), `qa-web-${phone ? 'phone' : 'pc'}-busy.png`) })
  liveText = ''
  events.emit(B, { type: 'text', text: '다 쓴 답' })
  changed()
  await page.waitForSelector('text=다 쓴 답')
  await page.waitForTimeout(200)
  check(`${label}: 답이 오면 미리보기는 지운다`, (await page.locator('#activity .tail').count()) === 0)
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
  // 새 세션: folder browsing, model, a missing folder made only when asked.
  if (phone) await page.goBack()
  await page.locator(phone ? '#btn-new-big' : '#btn-new').click()
  await page.waitForSelector('.newsess .ns-dirs .row')
  await page.screenshot({ path: join(tmpdir(), `qa-web-${phone ? 'phone' : 'pc'}-new.png`) })
  check(`${label}: 새 세션 화면(${phone ? '아래 시트' : '오른쪽 칸'})`, (await page.locator(phone ? '.newsess.sheet' : '#main .newsess').count()) === 1)
  await page.locator('.ns-dirs .row', { hasText: 'alpha' }).click()
  await page.waitForFunction(() => (document.querySelector('.ns-cwd') as HTMLInputElement).value.endsWith('/alpha'))
  check(`${label}: 폴더를 눌러 들어간다`, (await page.locator('.ns-cwd').inputValue()) === '/Users/me/projects/alpha')
  await page.locator('.ns-cwd').fill('/Users/me/projects/nope')
  await page.locator('.ns-model').selectOption('sonnet')
  await page.locator('.ns-prompt').fill('새 일')
  await page.locator('.ns-start').click()
  await page.waitForSelector('.ns-missing:not([hidden])')
  check(`${label}: 없는 폴더면 알려 준다`, ((await page.locator('.ns-missing').textContent()) ?? '').includes('폴더가 없어요'))
  page.once('dialog', (d) => d.accept())
  await page.locator('.ns-missing .btn').click()
  await page.waitForTimeout(300)
  check(`${label}: 만들고 시작(모델 포함)`, calls.includes('new:/Users/me/projects/nope:sonnet:create:새 일'), calls.join(' | '))
  check(`${label}: 시작하면 그 세션을 연다`, (await page.locator('.newsess').count()) === 0 && (await page.locator('#title').textContent()) === '알파 작업')

  // 폴더 버리고 종료: shows what would be lost first, then goes on only when confirmed.
  if (!phone) {
    let asked = ''
    page.once('dialog', (d) => ((asked = d.message()), d.accept()))
    await page.locator('#btn-more').click()
    await page.locator('.menu .mi', { hasText: '폴더 버리고 종료' }).click()
    await page.waitForTimeout(300)
    check(`${label}: 버리기 전에 저장소 상태를 보여 준다`, /커밋 안 한 변경 2개/.test(asked) && /push 안 한 커밋 1개/.test(asked), asked)
    check(`${label}: 확인하면 trash`, calls.includes('trash:11'))
  }

  // Groups: made from the menu, a session put in one from its menu (and, on a PC, by dragging onto the head).
  page.once('dialog', (d) => d.accept('업무'))
  await page.locator('#btn-more').click()
  await page.locator('.menu .mi', { hasText: '새 그룹' }).click()
  await page.waitForSelector('.sec-head.group', { timeout: 3000 }).catch(() => {})
  if (phone) await page.goBack()
  check(`${label}: 새 그룹`, ((await page.locator('.sec-head.group .gname').first().textContent()) ?? '') === '업무')
  if (phone) {
    await page.locator(`.row[data-thread="${C}"]`).click()
    await page.locator('#btn-more').click()
  } else await page.locator(`.row[data-thread="${C}"]`).click({ button: 'right' })
  await page.locator('.menu .mi', { hasText: '그룹: 없음' }).click()
  await page.locator('.menu .mi', { hasText: '업무' }).click()
  await page.waitForTimeout(300)
  if (phone) await page.goBack()
  const inGroup = () => page.evaluate(() => { const head = document.querySelector('.sec-head.group'); let n = head?.nextElementSibling; const out: string[] = []; while (n && n.classList.contains('row')) { out.push((n as HTMLElement).dataset.thread!); n = n.nextElementSibling } return out })
  check(`${label}: 메뉴로 그룹에 넣기`, (await inGroup()).includes(C), JSON.stringify(await inGroup()))
  if (!phone) {
    await page.locator(`.row[data-thread="${B}"]`).dragTo(page.locator('.sec-head.group'))
    await page.waitForTimeout(300)
    check(`${label}: 끌어다 그룹 머리에 놓으면 그 그룹으로`, (await inGroup()).includes(B), JSON.stringify(await inGroup()))
    await page.locator(`.row[data-thread="${B}"]`).dragTo(page.locator('.sec-head', { hasText: '진행 중' }))
    await page.waitForTimeout(300)
    check(`${label}: "진행 중" 머리에 놓으면 그룹에서 뺀다`, !(await inGroup()).includes(B))
  }
  await page.locator(`.row[data-thread="${A}"]`).click()
  await page.waitForSelector('.item.text')

  // Default prompt, and clearing the side lists, from the global menu.
  await page.locator('#btn-more').click()
  await page.locator('.menu .mi', { hasText: '기본 프롬프트' }).click()
  await page.locator('.prompt-sheet textarea').fill('한국어로 답해')
  await page.locator('.prompt-sheet .btn.primary').click()
  await page.waitForTimeout(200)
  check(`${label}: 기본 프롬프트 저장`, calls.includes('prompt:한국어로 답해'))
  page.once('dialog', (d) => d.accept())
  await page.locator('#btn-more').click()
  await page.locator('.menu .mi', { hasText: '이어서 하기 비우기' }).click()
  await page.waitForTimeout(200)
  page.once('dialog', (d) => d.accept())
  await page.locator('#btn-more').click()
  await page.locator('.menu .mi', { hasText: '지난 기록 모두 지우기' }).click()
  await page.waitForTimeout(200)
  check(`${label}: 이어서 하기 비우기·지난 기록 지우기`, calls.includes('group:clearRecent') && calls.includes('clearArchives'))

  if (!phone) {
    // ⌘K finds a session; ⌥↓ goes to the next one; ↑ in an empty field brings back the last message.
    await page.keyboard.press('Meta+k')
    await page.locator('.finder input').fill('긴 세')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(200)
    check(`${label}: ⌘K 로 찾아 열기`, (await page.locator('#title').textContent()) === '긴 세션')
    const before = await page.locator('#title').textContent()
    await page.keyboard.press('Alt+ArrowDown')
    await page.waitForTimeout(200)
    check(`${label}: ⌥↓ 다음 세션`, (await page.locator('#title').textContent()) !== before)
    await page.locator(`.row[data-thread="${A}"]`).click()
    await page.waitForSelector('.item.text')
    await page.locator('#input').focus()
    await page.keyboard.press('ArrowUp')
    check(`${label}: 빈 입력칸에서 ↑ 는 마지막으로 보낸 글`, (await page.locator('#input').inputValue()).length > 0, await page.locator('#input').inputValue())
    await page.locator('#input').fill('')
  }

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
  sessions = sessions.map((s) => (s.thread === B ? { ...s, state: 'waiting', waiting: '권한 대기', permission: { ts: '2000.5', text: '권한 요청', blocks: permBlocks(12) } } : s))
  for (const g of [...groupStore.get().groups]) groupStore.apply({ op: 'delete', id: g.id })
  groupStore.apply({ op: 'loose', order: [] })
  changed()
  await ctx.close()
}
await browser.close()
server.close()
console.log(failed ? `\n${failed} FAIL` : '\nALL PASS')
process.exit(failed ? 1 : 0)

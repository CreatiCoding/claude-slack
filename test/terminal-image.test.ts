import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applySgr, cellWidth, clipRow, cutColumn, findPanelEdge, firstBlock, parseAnsi, renderHtml, renderPng, renderScreenPictures, rowWidth, sliceRow, splitScreen } from '../src/terminal-image.ts'

const ESC = '\x1b'

test('parseAnsi: 색과 굵기를 해석하고, 리셋하면 되돌리고, 다른 이스케이프는 버린다', () => {
  const rows = parseAnsi(`${ESC}[1;31m빨강${ESC}[0m 보통\n${ESC}[38;5;196m256색${ESC}[39m ${ESC}[38;2;10;20;30m트루컬러${ESC}[0m${ESC}(B${ESC}[?25h끝`)
  assert.deepEqual(rows[0]!.map((r) => [r.text, r.style.bold, r.style.fg]), [['빨강', true, '#cd3131'], [' 보통', undefined, undefined]])
  assert.equal(rows[1]![0]!.style.fg, 'rgb(255,0,0)', '256 색')
  assert.equal(rows[1]!.find((r) => r.text === '트루컬러')!.style.fg, 'rgb(10,20,30)')
  assert.equal(rows[1]!.at(-1)!.text, '끝', '문자 집합 전환과 커서 표시는 글자로 남지 않는다')
})

test('applySgr: 반전·흐림·배경색', () => {
  const s = applySgr({}, '2;7;44')
  assert.deepEqual([s.dim, s.reverse, s.bg], [true, true, '#2472c8'])
  assert.deepEqual(applySgr(s, '0'), {})
  assert.deepEqual(applySgr({ bold: true, dim: true }, '22'), {})
})

test('cellWidth: 한글·한자·이모지는 두 칸, 영문은 한 칸, 결합 문자는 0칸', () => {
  assert.equal(cellWidth('가'.codePointAt(0)!), 2)
  assert.equal(cellWidth('漢'.codePointAt(0)!), 2)
  assert.equal(cellWidth('✅'.codePointAt(0)!), 2)
  assert.equal(cellWidth('🚀'.codePointAt(0)!), 2)
  assert.equal(cellWidth('a'.codePointAt(0)!), 1)
  assert.equal(cellWidth('─'.codePointAt(0)!), 1, '상자 그리기 문자는 한 칸')
  assert.equal(cellWidth(0x301), 0)
})

test('renderHtml: 한글은 두 칸 격자에 넣고, 끝의 빈 줄은 자르고, 위험한 글자는 이스케이프한다', () => {
  const ansi = `가나 ab\n${ESC}[31m<script>alert(1)</script>${ESC}[0m\n\n\n`
  const { html, cols, rows } = renderHtml(ansi, { title: '<b>제목</b>' })
  assert.equal(rows, 2, '끝의 빈 줄 둘은 잘린다')
  assert.equal(cols, 40, '최소 폭')
  assert.match(html, /<i class="w">가<\/i><i class="w">나<\/i>/)
  assert.ok(!/<script>alert/.test(html) && html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
  assert.ok(!html.includes('<b>제목</b>') && html.includes('&lt;b&gt;제목&lt;/b&gt;'))
  assert.equal(rowWidth(parseAnsi('가나 ab')[0]!), 7, '한글 둘(4칸) + 공백 + ab')
})

test('renderHtml: 가장 넓은 줄에 맞춰 폭을 잡고, 오래된 줄부터 잘라 maxRows 를 지킨다', () => {
  const long = 'x'.repeat(90)
  const { cols, rows, html } = renderHtml(`첫줄\n${long}\n끝줄`, { maxRows: 2 })
  assert.equal(rows, 2)
  assert.equal(cols, 90)
  assert.ok(!html.includes('<i class="w">첫</i>'), '가장 오래된 줄이 잘렸다')
  assert.ok(html.includes('<i class="w">끝</i><i class="w">줄</i>'))
})

test('renderPng: 실제 브라우저로 PNG 를 만든다 (브라우저가 없으면 건너뛴다)', async (t) => {
  let png: Buffer
  try {
    png = await renderPng(`${ESC}[1m제목${ESC}[0m 본문 ${ESC}[42m초록${ESC}[0m\n`, { title: 'test' })
  } catch (err) {
    return void t.skip(`no browser: ${err}`)
  }
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG signature')
  assert.ok(png.length > 2000)
})

test('clipRow: 폭을 넘는 오른쪽은 자르고, 두 칸짜리 글자는 반으로 자르지 않는다', () => {
  const row = parseAnsi('가나다라마 abc')[0]!
  assert.equal(rowWidth(clipRow(row, 100)), 14, '넉넉하면 그대로')
  assert.equal(clipRow(row, 6).map((r) => r.text).join(''), '가나다', '6칸 = 한글 세 글자')
  assert.equal(clipRow(row, 5).map((r) => r.text).join(''), '가나', '5칸에는 두 칸 글자가 반쪽으로 걸리지 않는다')
  assert.equal(clipRow(parseAnsi(`${ESC}[31mred${ESC}[0m plain`)[0]!, 5).map((r) => [r.text, r.style.fg]).flat().join('|'), 'red|#cd3131| p|')
})

test('renderHtml: maxCols 를 넘는 화면은 그 폭으로 자르고 그림의 폭도 그만큼만 잡는다', () => {
  const wide = 'y'.repeat(220)
  const { html, cols } = renderHtml(`${wide}\n짧은 줄`, { maxCols: 120 })
  assert.equal(cols, 120)
  assert.ok(html.includes('width: calc(120 * var(--cw) + 32px)'), '폭은 측정한 칸 폭(--cw)으로 계산한다')
  assert.ok(!html.includes('y'.repeat(121)), '120칸 뒤는 잘렸다')
  assert.ok(html.includes('font: 20px/'), '글자 크기 20px')
})

/** A screen like Claude Code's on a wide window: the conversation on the left, a changed-files panel on the right. */
const withPanel = (left: number, panelFrom: number, panelTo: number, lines = 30) =>
  Array.from({ length: lines }, (_, i) => `${'a'.repeat(i % 3 === 0 ? left : left - 12)}${' '.repeat(panelFrom - (i % 3 === 0 ? left : left - 12))}${'p'.repeat(panelTo - panelFrom)}`).join('\n')

test('cutColumn: 대화와 오른쪽 패널 사이의 빈 세로 틈을 찾아, 패널을 통째로 떼어 낸다', () => {
  const rows = parseAnsi(withPanel(100, 106, 200))
  const cut = cutColumn(rows, 150)
  assert.equal(cut.clean, true)
  assert.ok(cut.col >= 100 && cut.col <= 106, `틈에서 자른다: ${cut.col}`)
  const { html, cols, faded } = renderHtml(withPanel(100, 106, 200), { maxCols: 150 })
  assert.equal(faded, false)
  assert.ok(cols <= 106)
  assert.ok(!html.includes('p'.repeat(5)), '패널 글자는 한 조각도 남지 않는다')
  assert.ok(!html.includes('id="fade"'), '깨끗하게 잘렸으니 페이드는 필요 없다')
})

test('cutColumn: 틈이 없이 꽉 찬 화면은 maxCols 에서 자르고 페이드로 표시한다. 폭이 안 넘으면 자르지 않는다', () => {
  const dense = Array.from({ length: 20 }, () => 'x'.repeat(200)).join('\n')
  assert.deepEqual(cutColumn(parseAnsi(dense), 150), { col: 150, clean: false })
  const { html, faded } = renderHtml(dense, { maxCols: 150 })
  assert.equal(faded, true)
  assert.ok(html.includes('id="fade"'))
  assert.deepEqual(cutColumn(parseAnsi(withPanel(60, 64, 90)), 150), { col: 150, clean: true }, '150칸 안이면 그대로')
})

test('cutColumn: 한글(두 칸)도 칸 수로 센다', () => {
  const left = '가'.repeat(45) // 90 columns
  const rows = parseAnsi(Array.from({ length: 12 }, () => `${left}${' '.repeat(8)}${'p'.repeat(90)}`).join('\n'))
  const cut = cutColumn(rows, 150)
  assert.equal(cut.clean, true)
  assert.ok(cut.col >= 90 && cut.col <= 98, `한글 90칸 뒤의 틈: ${cut.col}`)
})

test('renderHtml: 한글 칸은 측정한 칸 폭의 두 배이고, AppleGothic 을 먼저 쓴다 (글자가 칸을 채우도록)', () => {
  const { html } = renderHtml('가나다 abc')
  assert.match(html, /\.w \{[^}]*width: calc\(var\(--cw\) \* 2\)/)
  assert.match(html, /\.w \{[^}]*font-family: AppleGothic,/)
  assert.ok(!/\.w \{[^}]*width: 2ch/.test(html), '2ch 는 글꼴마다 달라서 쓰지 않는다')
  assert.match(html, /id="probe"/, '칸 폭을 재는 요소')
})

/** A wide window: `left` columns of conversation, a filled panel from column `edge`, like the changed-files panel. */
const panelScreen = (edge = 130, lines = 40, width = 200) =>
  Array.from({ length: lines }, (_, i) => {
    const text = i % 4 === 3 ? '' : `● ${'대화 내용 '.repeat(i % 5 + 2)}`.trim()
    const w = [...text].reduce((n, c) => n + (c.charCodeAt(0) > 0x3000 ? 2 : 1), 0)
    return `${text}${' '.repeat(edge - w)}${`\x1b[42m${'+ code line '.padEnd(width - edge)}\x1b[0m`}`
  }).join('\n')

test('findPanelEdge: 오른쪽 패널의 왼쪽 가장자리(비어 있다가 갑자기 채워지는 칸)를 찾는다', () => {
  assert.equal(findPanelEdge(parseAnsi(panelScreen(130))), 130)
  assert.equal(findPanelEdge(parseAnsi(panelScreen(96, 30, 190))), 96)
})

test('findPanelEdge: 패널이 없는 평범한 화면에서는 찾지 않는다', () => {
  const plain = Array.from({ length: 40 }, (_, i) => `● ${'긴 문장이 이어집니다 '.repeat(i % 6 + 1)}`).join('\n')
  assert.equal(findPanelEdge(parseAnsi(plain)), undefined)
  const dense = Array.from({ length: 30 }, () => 'x'.repeat(200)).join('\n')
  assert.equal(findPanelEdge(parseAnsi(dense)), undefined, '꽉 찬 화면은 패널이 아니다')
  assert.equal(findPanelEdge(parseAnsi('짧은 화면\n두 줄')), undefined, '줄이 너무 적으면 판단하지 않는다')
  // one long line running across is not a panel either
  const oneLong = [...Array.from({ length: 20 }, () => '● 대화'), `● ${'y'.repeat(180)}`].join('\n')
  assert.equal(findPanelEdge(parseAnsi(oneLong)), undefined)
})

test('sliceRow / splitScreen: 경계에서 대화와 패널을 나누고, 두 칸 글자를 반으로 자르지 않는다', () => {
  const row = parseAnsi('가나다라 abc')[0]!
  assert.equal(sliceRow(row, 0, 4).map((r) => r.text).join(''), '가나')
  assert.equal(sliceRow(row, 3, 9).map((r) => r.text).join(''), '다라 ', '3칸에서 시작하면 2~4칸에 걸친 \'나\'는 어느 쪽에도 넣지 않는다')
  const [conversation, panel] = splitScreen(panelScreen(130))
  assert.equal(conversation!.part, 'conversation')
  assert.equal(panel!.part, 'panel')
  assert.ok(conversation!.rows.every((r) => rowWidth(r) < 129), '대화 쪽에는 패널 글자가 없다')
  assert.ok(panel!.rows.filter((r) => rowWidth(r) > 0).every((r) => r.map((x) => x.text).join('').includes('code line')))
  assert.deepEqual(splitScreen('짧은\n화면').map((p) => p.part), ['screen'])
})

test('renderScreenPictures: 패널이 있으면 그림 두 장(대화, 변경 내용), 없으면 한 장 (브라우저가 없으면 건너뛴다)', async (t) => {
  try {
    const two = await renderScreenPictures(panelScreen(130), { title: 'x' })
    assert.deepEqual(two.map((p) => p.part), ['conversation', 'panel'])
    for (const p of two) assert.deepEqual([...p.png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47])
    const one = await renderScreenPictures(Array.from({ length: 10 }, (_, i) => `줄 ${i}`).join('\n'))
    assert.deepEqual(one.map((p) => p.part), ['screen'])
  } catch (err) {
    t.skip(`no browser: ${err}`)
  }
})

/** Conversation of `lines` rows, and a panel of only `panelRows` rows starting at `edge`, like one changed file. */
const shortPanelScreen = (edge = 130, lines = 60, panelRows = 14) =>
  Array.from({ length: lines }, (_, i) => {
    const text = i % 5 === 4 ? '' : `● ${'대화 내용 '.repeat(i % 6 + 2)}`.trim()
    const w = [...text].reduce((n, c) => n + (c.charCodeAt(0) > 0x3000 ? 2 : 1), 0)
    const panel = i >= 3 && i < 3 + panelRows ? `${i === 3 ? '1 file changed +10' : '+ const cells = []'.padEnd(60)}` : ''
    return panel ? `${text}${' '.repeat(edge - w)}${panel}` : text
  }).join('\n')

test('findPanelEdge: 변경 파일이 적어 패널이 짧아도(60줄 중 14줄) 가장자리를 찾는다', () => {
  assert.equal(findPanelEdge(parseAnsi(shortPanelScreen(130))), 130)
  assert.equal(findPanelEdge(parseAnsi(shortPanelScreen(110, 70, 10))), 110)
  const [conversation, panel] = splitScreen(shortPanelScreen(130))
  assert.equal(conversation!.part, 'conversation')
  assert.ok(panel!.rows.filter((r) => rowWidth(r) > 0).length >= 10, '패널 줄이 그대로 남는다')
  assert.ok(conversation!.rows.every((r) => rowWidth(r) < 129))
})

test('findPanelEdge: 들여쓴 목록이나 몇 줄 뒤의 낱말은 패널로 보지 않는다', () => {
  const indented = Array.from({ length: 40 }, (_, i) => (i % 3 === 0 ? '  - 항목' : `${'긴 문장 '.repeat(8)}`)).join('\n')
  assert.equal(findPanelEdge(parseAnsi(indented)), undefined)
  // a few words after a gap at column 100 (fewer rows than a panel would have)
  const stray = Array.from({ length: 50 }, (_, i) => (i === 10 || i === 11 ? `${'x'.repeat(50)}${' '.repeat(50)}옆말이 조금 ${'y'.repeat(20)}` : 'x'.repeat(40))).join('\n')
  assert.equal(findPanelEdge(parseAnsi(stray)), undefined)
})

test('firstBlock: 패널 아래로 이어지는 입력창 테두리 선은 버리고, 패널 안의 짧은 빈 줄은 남긴다', () => {
  const rows = parseAnsi(['1 file changed', '', 'README.md', '', '', '+ 추가한 줄', ...Array(8).fill(''), '────────', '', '────────'].join('\n'))
  const kept = firstBlock(rows).map((r) => r.map((x) => x.text).join(''))
  assert.deepEqual(kept, ['1 file changed', '', 'README.md', '', '', '+ 추가한 줄'], '두 줄 빈 줄(패널 안)은 남고, 큰 빈 구간 뒤의 선은 없다')
  assert.deepEqual(firstBlock(parseAnsi('\n\n')), [])
  assert.equal(firstBlock(parseAnsi('a\nb\nc')).length, 3, '빈 구간이 없으면 전부')
})

test('splitScreen: 패널 조각에 화면 아래의 전체 폭 선이 딸려 오지 않는다', () => {
  const screen = shortPanelScreen(130, 70, 12).split('\n')
  // the rules around the input box, as wide as the window, at the bottom
  const rule = '─'.repeat(200)
  const parts = splitScreen([...screen, '', rule, '', rule].join('\n'))
  const panel = parts.find((p) => p.part === 'panel')!
  assert.ok(panel.rows.length <= 16, `패널은 위쪽 덩어리만: ${panel.rows.length}줄`)
  assert.ok(!panel.rows.some((r) => r.map((x) => x.text).join('').includes('────')))
})

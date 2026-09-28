/**
 * A terminal screen as a picture.
 *
 * Pasted as text, a screen is re-wrapped by whatever shows it: Korean letters take two
 * columns but not two characters' width, so columns drift, and a phone breaks every
 * long line. Drawn as an image on a fixed grid it looks the same everywhere.
 *
 * `tmux capture-pane -e` gives the screen with its colours as SGR escape sequences; this turns them
 * into cells, lays each cell out on the grid (a wide letter takes two), and screenshots that
 * with the Chromium Playwright already ships for the Slack login helper.
 */

export interface Style {
  fg?: string
  bg?: string
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  reverse?: boolean
}
export interface Run {
  text: string
  style: Style
}
export type Row = Run[]

// ---- colours (the VS Code dark palette)
const ANSI16 = ['#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5', '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff']
export const DEFAULT_FG = '#d4d4d4'
export const DEFAULT_BG = '#1e1e1e'

function color256(n: number): string | undefined {
  if (n < 0 || n > 255) return undefined
  if (n < 16) return ANSI16[n]
  if (n >= 232) {
    const v = 8 + (n - 232) * 10
    return `rgb(${v},${v},${v})`
  }
  const i = n - 16
  const level = (x: number) => (x === 0 ? 0 : 55 + x * 40)
  return `rgb(${level(Math.floor(i / 36))},${level(Math.floor(i / 6) % 6)},${level(i % 6)})`
}

/** Apply one SGR parameter list (the part between `ESC[` and `m`) to a style. */
export function applySgr(style: Style, params: string): Style {
  const s: Style = { ...style }
  const p = params === '' ? [0] : params.split(/[;:]/).map((x) => (x === '' ? 0 : Number(x)))
  for (let i = 0; i < p.length; i++) {
    const n = p[i]!
    if (n === 0) {
      for (const k of Object.keys(s) as Array<keyof Style>) delete s[k]
    } else if (n === 1) s.bold = true
    else if (n === 2) s.dim = true
    else if (n === 3) s.italic = true
    else if (n === 4) s.underline = true
    else if (n === 7) s.reverse = true
    else if (n === 9) s.strike = true
    else if (n === 22) delete s.bold, delete s.dim
    else if (n === 23) delete s.italic
    else if (n === 24) delete s.underline
    else if (n === 27) delete s.reverse
    else if (n === 29) delete s.strike
    else if (n >= 30 && n <= 37) s.fg = ANSI16[n - 30]
    else if (n === 39) delete s.fg
    else if (n >= 40 && n <= 47) s.bg = ANSI16[n - 40]
    else if (n === 49) delete s.bg
    else if (n >= 90 && n <= 97) s.fg = ANSI16[n - 90 + 8]
    else if (n >= 100 && n <= 107) s.bg = ANSI16[n - 100 + 8]
    else if (n === 38 || n === 48) {
      const target = n === 38 ? 'fg' : 'bg'
      if (p[i + 1] === 5) {
        const c = color256(p[i + 2] ?? -1)
        if (c) s[target] = c
        i += 2
      } else if (p[i + 1] === 2) {
        s[target] = `rgb(${p[i + 2] ?? 0},${p[i + 3] ?? 0},${p[i + 4] ?? 0})`
        i += 4
      }
    }
  }
  return s
}

// ---- character width on the grid
const WIDE_SYMBOLS = new Set([
  0x231a, 0x231b, 0x23e9, 0x23ea, 0x23eb, 0x23ec, 0x23f0, 0x23f3, 0x25fd, 0x25fe, 0x2614, 0x2615, 0x267f, 0x2693, 0x26a1, 0x26aa, 0x26ab, 0x26bd, 0x26be, 0x26c4, 0x26c5, 0x26ce, 0x26d4, 0x26ea,
  0x26f2, 0x26f3, 0x26f5, 0x26fa, 0x26fd, 0x2705, 0x270a, 0x270b, 0x2728, 0x274c, 0x274e, 0x2753, 0x2754, 0x2755, 0x2757, 0x2795, 0x2796, 0x2797, 0x27b0, 0x27bf, 0x2b1b, 0x2b1c, 0x2b50, 0x2b55,
])
/** Columns a character takes: 0 for combining marks, 2 for wide ones (Hangul, CJK, emoji), else 1. */
export function cellWidth(cp: number): number {
  if (cp === 0 || cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0x20d0 && cp <= 0x20ff) || cp === 0x200d) return 0
  if (WIDE_SYMBOLS.has(cp)) return 2
  if (
    (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0x303e) || (cp >= 0x3041 && cp <= 0x33ff) || (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1f64f) || (cp >= 0x1f680 && cp <= 0x1f6ff) || (cp >= 0x1f900 && cp <= 0x1f9ff) || (cp >= 0x1fa70 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
    return 2
  return 1
}

// Any CSI sequence (including private ones such as ESC[?25h), charset switches, and OSC strings.
const ESCAPE_RE = /\x1b\[([0-?]*)([ -\/]*[@-~])|\x1b[()][A-Z0-9]|\x1b[=>78]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g

/** Split captured text into rows of styled runs. Cursor movement and other escapes are dropped. */
export function parseAnsi(ansi: string): Row[] {
  const rows: Row[] = []
  let style: Style = {}
  for (const line of ansi.replace(/\r/g, '').split('\n')) {
    const row: Row = []
    let last = 0
    const push = (text: string) => {
      if (!text) return
      const prev = row.at(-1)
      if (prev && JSON.stringify(prev.style) === JSON.stringify(style)) prev.text += text
      else row.push({ text, style: { ...style } })
    }
    for (const m of line.matchAll(ESCAPE_RE)) {
      push(line.slice(last, m.index))
      last = m.index! + m[0].length
      if (m[2] === 'm') style = applySgr(style, m[1] ?? '')
    }
    push(line.slice(last))
    rows.push(row)
  }
  return rows
}

/** Columns a row occupies, up to its last visible (non-space or coloured) cell. */
export function rowWidth(row: Row): number {
  let col = 0
  let used = 0
  for (const run of row) {
    for (const ch of run.text) {
      const w = cellWidth(ch.codePointAt(0)!)
      col += w
      if (ch !== ' ' || run.style.bg || run.style.reverse) used = col
    }
  }
  return used
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

function runHtml(run: Run): string {
  const st = run.style
  let fg = st.fg ?? DEFAULT_FG
  let bg = st.bg
  if (st.reverse) [fg, bg] = [bg ?? DEFAULT_BG, st.fg ?? DEFAULT_FG]
  const css = [`color:${fg}`]
  if (bg) css.push(`background:${bg}`)
  if (st.bold) css.push('font-weight:700')
  if (st.dim) css.push('opacity:.6')
  if (st.italic) css.push('font-style:italic')
  const deco = [st.underline && 'underline', st.strike && 'line-through'].filter(Boolean).join(' ')
  if (deco) css.push(`text-decoration:${deco}`)
  // A wide letter gets exactly two cells, whatever font it falls back to.
  let body = ''
  let plain = ''
  for (const ch of run.text) {
    const w = cellWidth(ch.codePointAt(0)!)
    if (w === 2) {
      body += esc(plain) + `<i class="w">${esc(ch)}</i>`
      plain = ''
    } else if (w === 1) plain += ch
  }
  body += esc(plain)
  return `<span style="${css.join(';')}">${body}</span>`
}

export interface HtmlOptions {
  /** Shown in the window's title bar. */
  title?: string
  /** Most rows to draw; the newest ones win. */
  maxRows?: number
  /** Never narrower than this many columns. */
  minCols?: number
  /** Never wider than this many columns; what lies further right is cut. A 220-column screen at 16px is too wide to read as a picture. */
  maxCols?: number
}

export const DEFAULT_MAX_COLS = Number(process.env.CLAUDE_SLACK_SCREEN_COLS) || 150

/** Which columns of a row hold something visible. A wide letter marks both of its columns. */
function occupied(row: Row): boolean[] {
  const cells: boolean[] = []
  for (const run of row) {
    for (const ch of run.text) {
      const w = cellWidth(ch.codePointAt(0)!)
      const on = ch !== ' ' || !!run.style.bg || !!run.style.reverse
      for (let i = 0; i < w; i++) cells.push(on)
    }
  }
  return cells
}

/**
 * Where to cut a screen wider than `max` columns. Claude Code puts a changed-files panel beside the
 * conversation on a wide window; cutting through the middle of that panel leaves confusing scraps,
 * so look for the empty vertical strip between the two (blank in nearly every row) and cut there,
 * dropping the panel whole. Without such a strip the cut is at `max` (and drawn as a fade).
 */
export function cutColumn(rows: Row[], max: number): { col: number; clean: boolean } {
  const grids = rows.map(occupied).filter((g) => g.some(Boolean))
  // Only what is visible counts: a row padded with spaces out to the window's width needs no cut.
  if (!grids.some((g) => g.lastIndexOf(true) + 1 > max)) return { col: max, clean: true }
  const STRIP = 3
  for (let c = max; c >= Math.floor(max * 0.55); c--) {
    const blank = grids.filter((g) => g.slice(c - STRIP, c).every((on) => !on)).length
    if (blank / grids.length >= 0.9) return { col: c - STRIP, clean: true }
  }
  return { col: max, clean: false }
}

/** The columns [from, to) of a row. A wide letter that would straddle an edge is left out of both sides. */
export function sliceRow(row: Row, from: number, to = Infinity): Row {
  const out: Row = []
  let col = 0
  for (const run of row) {
    let text = ''
    for (const ch of run.text) {
      const w = cellWidth(ch.codePointAt(0)!)
      if (col >= from && col + w <= to) text += ch
      col += w
    }
    if (text) out.push({ text, style: run.style })
  }
  return out
}

/**
 * The column where a side panel begins, or undefined. Claude Code draws a changed-files panel down the
 * right of a wide window. Its left edge is straight: a run of rows whose content starts at the same column,
 * with empty cells just before it. That holds for a tall panel and for a short one (one changed file is a
 * dozen rows of a seventy-row screen), which a "filled in most rows" rule would miss.
 */
export function findPanelEdge(rows: Row[]): number | undefined {
  const grids = rows.map(occupied).filter((g) => g.some(Boolean))
  if (grids.length < 6) return undefined
  const width = Math.max(...grids.map((g) => g.lastIndexOf(true) + 1))
  // The conversation never starts this far right, and a panel wants room to its right.
  const FROM = 80
  const need = Math.max(6, Math.ceil(grids.length * 0.12))
  let best: { col: number; rows: number } | undefined
  for (let c = FROM; c <= width - 12; c++) {
    const edge = grids.filter((g) => g[c] && !g[c - 1] && !g[c - 2])
    if (edge.length < need) continue
    // Most of those rows must carry on to the right: a panel, not a stray word after a gap.
    if (edge.filter((g) => g.lastIndexOf(true) + 1 - c >= 12).length < need) continue
    // There must still be a conversation to its left.
    if (grids.filter((g) => g.slice(0, c - 2).some(Boolean)).length / grids.length < 0.4) continue
    if (!best || edge.length > best.rows) best = { col: c, rows: edge.length }
  }
  return best?.col
}

export interface ScreenPart {
  /** `screen` when the whole screen is one picture; otherwise the conversation and its side panel. */
  part: 'screen' | 'conversation' | 'panel'
  rows: Row[]
}

/**
 * The first block of content in a panel: from its first row to the last one before a long empty stretch.
 * The rules Claude Code draws around its input box run the full width of the window, through the panel's
 * columns too, far below the panel itself; taken along they stretch the picture across a screen of nothing.
 */
export function firstBlock(rows: Row[], gap = 5): Row[] {
  const start = rows.findIndex((r) => rowWidth(r) > 0)
  if (start < 0) return []
  let end = start
  let blanks = 0
  for (let i = start; i < rows.length; i++) {
    if (rowWidth(rows[i]!) === 0) {
      if (++blanks >= gap) break
    } else {
      blanks = 0
      end = i
    }
  }
  return rows.slice(start, end + 1)
}

/** Split a captured screen into what to draw: one part, or the conversation and the panel beside it. */
export function splitScreen(ansi: string): ScreenPart[] {
  const rows = parseAnsi(ansi)
  const edge = findPanelEdge(rows)
  if (edge === undefined) return [{ part: 'screen', rows }]
  return [
    { part: 'conversation', rows: rows.map((r) => sliceRow(r, 0, edge - 1)) },
    { part: 'panel', rows: firstBlock(rows.map((r) => sliceRow(r, edge))) },
  ]
}

/** The part of a row that fits in `max` columns; a wide letter is never cut in half. */
export function clipRow(row: Row, max: number): Row {
  const out: Row = []
  let col = 0
  for (const run of row) {
    let text = ''
    for (const ch of run.text) {
      const w = cellWidth(ch.codePointAt(0)!)
      if (col + w > max) return text ? [...out, { text, style: run.style }] : out
      col += w
      text += ch
    }
    out.push({ text, style: run.style })
  }
  return out
}

/** The screen as an HTML page: a terminal window, one row per line, every cell on a fixed grid. */
export function renderHtml(ansi: string, opts: HtmlOptions = {}): { html: string; cols: number; rows: number; faded: boolean } {
  return renderRowsHtml(parseAnsi(ansi), opts)
}

/** The same, from rows already parsed (and possibly cut out of a larger screen). */
export function renderRowsHtml(parsed: Row[], opts: HtmlOptions = {}): { html: string; cols: number; rows: number; faded: boolean } {
  let rows = parsed.map((r) => r)
  while (rows.length && rowWidth(rows[0]!) === 0) rows.shift()
  while (rows.length && rowWidth(rows.at(-1)!) === 0) rows.pop()
  if (opts.maxRows && rows.length > opts.maxRows) rows = rows.slice(-opts.maxRows)
  const cut = cutColumn(rows, opts.maxCols ?? DEFAULT_MAX_COLS)
  rows = rows.map((r) => clipRow(r, cut.col))
  const cols = Math.min(cut.col, Math.max(opts.minCols ?? 40, ...rows.map(rowWidth)))
  const cuts = cut.clean ? '' : '<div id="fade"></div>'
  const body = rows.map((r) => `<div class="r">${r.map(runHtml).join('') || ' '}</div>`).join('')
  const html = `<!doctype html><meta charset="utf-8"><style>
    * { box-sizing: border-box }
    body { margin: 0; background: transparent }
    #win { display: inline-block; background: ${DEFAULT_BG}; border-radius: 10px; overflow: hidden; border: 1px solid #3a3a3a }
    #bar { height: 30px; background: #2b2b2b; display: flex; align-items: center; padding: 0 12px; gap: 8px; border-bottom: 1px solid #1a1a1a }
    #bar i { width: 11px; height: 11px; border-radius: 50%; display: block }
    #bar b { margin-left: 8px; color: #9a9a9a; font: 12px -apple-system, "Apple SD Gothic Neo", sans-serif; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
    #term { --cw: 12.04px; position: relative; padding: 12px 16px 14px; color: ${DEFAULT_FG}; font: 20px/1.32 Menlo, "SF Mono", "DejaVu Sans Mono", Consolas, monospace; width: calc(${cols} * var(--cw) + 32px) }
    .r { white-space: pre; height: 1.32em }
    /* A wide letter fills exactly two cells. The cell width is measured in the page (--cw, in px): 2ch here would mean 2 zeros of the letter's own font. AppleGothic keeps Hangul full-bodied like a real terminal. */
    .w { display: inline-block; width: calc(var(--cw) * 2); font-size: 1.2em; line-height: 1; font-style: normal; text-align: center; overflow: visible; font-family: AppleGothic, "Noto Sans Mono CJK KR", "D2Coding", "Nanum Gothic Coding", "Apple SD Gothic Neo", "Noto Sans CJK KR", "Malgun Gothic", "Apple Color Emoji", Menlo, sans-serif }
    #fade { position: absolute; top: 0; right: 0; bottom: 0; width: 56px; background: linear-gradient(90deg, transparent, ${DEFAULT_BG}) }
    #probe { position: absolute; visibility: hidden; white-space: pre }
  </style>
  <div id="win"><div id="bar"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i>${opts.title ? `<b>${esc(opts.title)}</b>` : ''}</div>
  <div id="term"><span id="probe">0000000000</span>${cuts}${body}</div></div>`
  return { html, cols, rows: rows.length, faded: !cut.clean }
}

// ---- the browser: started on first use, kept a minute, then let go
type Browser = { newPage(o?: unknown): Promise<Page>; close(): Promise<void>; isConnected(): boolean }
type Page = { setContent(html: string): Promise<void>; evaluate?: unknown; locator(sel: string): { screenshot(o?: unknown): Promise<Buffer> }; close(): Promise<void> }
let browser: Promise<Browser> | undefined
let idle: ReturnType<typeof setTimeout> | undefined
let queue: Promise<unknown> = Promise.resolve()
const BROWSER_IDLE_MS = 60_000

async function getBrowser(): Promise<Browser> {
  if (browser) {
    const b = await browser.catch(() => undefined)
    if (b?.isConnected()) return b
    browser = undefined
  }
  browser = import('playwright').then((m) => m.chromium.launch({ headless: true }) as unknown as Promise<Browser>)
  return browser
}

/** Screenshot one rendered page. One at a time: a screenshot is quick, and this keeps a burst from starting many pages. */
function screenshot(html: string): Promise<Buffer> {
  const run = queue.then(async () => {
    if (idle) clearTimeout(idle)
    const b = await getBrowser()
    const page = await b.newPage({ deviceScaleFactor: 2, viewport: { width: 2400, height: 1600 } })
    try {
      await page.setContent(html)
      // Measure one cell in the page's own font and use it for every wide letter and for the width.
      await (page as unknown as { evaluate(fn: () => void): Promise<void> }).evaluate(() => {
        const term = document.getElementById('term')!
        const w = document.getElementById('probe')!.getBoundingClientRect().width / 10
        if (w > 4) term.style.setProperty('--cw', w + 'px')
      })
      return await page.locator('#win').screenshot({ type: 'png', omitBackground: true })
    } finally {
      await page.close().catch(() => {})
      idle = setTimeout(() => {
        const closing = browser
        browser = undefined
        void closing?.then((x) => x.close()).catch(() => {})
      }, BROWSER_IDLE_MS)
      idle.unref?.()
    }
  })
  queue = run.catch(() => {})
  return run
}

/** Draw a screen (with its colours) to one PNG. Rejects when no browser is available; callers fall back to text. */
export function renderPng(ansi: string, opts: HtmlOptions = {}): Promise<Buffer> {
  return screenshot(renderHtml(ansi, opts).html)
}

export interface ScreenPicture {
  part: ScreenPart['part']
  png: Buffer
}

/**
 * Draw a screen as the pictures to send: one, or, when Claude Code has a side panel open, the
 * conversation and the panel as two, each whole. Squeezed into one picture the panel would be cut
 * off at the edge and read as scraps of code.
 */
export async function renderScreenPictures(ansi: string, opts: HtmlOptions = {}): Promise<ScreenPicture[]> {
  const parts = splitScreen(ansi)
  const title = (part: ScreenPart['part']) => (part === 'panel' && opts.title ? `${opts.title} · 변경 내용` : opts.title)
  const out: ScreenPicture[] = []
  for (const p of parts) {
    // A panel that turns out to have nothing in it is not worth a picture.
    if (p.part === 'panel' && !p.rows.some((r) => rowWidth(r) > 0)) continue
    out.push({ part: p.part, png: await screenshot(renderRowsHtml(p.rows, { ...opts, title: title(p.part) }).html) })
  }
  return out
}

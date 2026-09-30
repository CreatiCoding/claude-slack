// Measure the web app against the running broker: open pages (read-only; nothing is pressed or sent),
// keep them for a while, then print the broker's own per-minute lines ("web sent 1m", "page ...") from that window.
// Usage: node scripts/measure-web.ts [minutes=3] [url=https://claude-slack.internal.creco.dev/] [thread-to-open]
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'

const minutes = Number(process.argv[2] ?? 3)
const url = process.argv[3] ?? 'https://claude-slack.internal.creco.dev/'
const thread = process.argv[4] ?? ''
const logFile = join(process.env.CLAUDE_SLACK_LOG_DIR ?? join(homedir(), '.claude-slack', 'logs'), 'broker.log')
// The broker logs in local time: compare as text.
const local = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().replace('T', ' ').slice(0, 19)
const from = local(new Date(Date.now() - 1000))

const browser = await chromium.launch()
const pages = []
for (const [view, size, mobile] of [['pc', { width: 1440, height: 820 }, false], ['phone', { width: 390, height: 844 }, true]] as const) {
  const ctx = await browser.newContext({ viewport: size, isMobile: mobile, hasTouch: mobile })
  const p = await ctx.newPage()
  await p.goto(url + (thread ? '#' + thread : ''))
  pages.push({ view, p })
}
console.log(`${pages.length} pages open for ${minutes} min${thread ? ` on ${thread}` : ''}…`)
await new Promise((r) => setTimeout(r, minutes * 60_000 + 5_000))
for (const { view, p } of pages) console.log(`${view}: dom=${await p.evaluate(() => document.getElementsByTagName('*').length)}`)
await browser.close()

const lines = readFileSync(logFile, 'utf8').split('\n').filter((l) => l.slice(0, 19) >= from && /\[admin\] (web sent 1m|web big|page )/.test(l))
console.log(lines.join('\n') || '(no lines)')

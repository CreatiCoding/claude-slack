/**
 * Tiny HTTP-driven browser for hands-off setup steps. Launches the installed
 * Chrome with a throwaway profile and takes JSON commands on 127.0.0.1:8931.
 *   curl -s localhost:8931 -d '{"op":"goto","url":"https://example.com"}'
 * Ops: goto, click{selector|text}, fill{selector,value}, press{key}, type{text},
 *      shot → /tmp/shot.png, text{selector?}, eval{js}, url, wait{ms}, frames.
 */
import { chromium } from 'playwright'
import http from 'node:http'
import { resolve } from 'node:path'

const profile = resolve(import.meta.dirname, '..', '.browser-profile')
const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chrome',
  headless: false,
  viewport: { width: 1280, height: 900 },
  args: ['--disable-blink-features=AutomationControlled'],
})
let page = ctx.pages()[0] ?? (await ctx.newPage())
ctx.on('page', (p) => (page = p))

async function run(cmd: Record<string, string | number>): Promise<unknown> {
  const sel = String(cmd.selector ?? '')
  const timeout = Number(cmd.timeout ?? 15000)
  switch (cmd.op) {
    case 'goto':
      await page.goto(String(cmd.url), { waitUntil: 'domcontentloaded', timeout: 60000 })
      return page.url()
    case 'click':
      if (cmd.text) await page.getByText(String(cmd.text), { exact: cmd.exact === 'true' }).first().click({ timeout })
      else if (cmd.role) await page.getByRole(cmd.role as never, { name: String(cmd.name) }).first().click({ timeout })
      else await page.locator(sel).first().click({ timeout })
      return 'clicked'
    case 'fill':
      await page.locator(sel).first().fill(String(cmd.value), { timeout })
      return 'filled'
    case 'type':
      await page.keyboard.type(String(cmd.text), { delay: 30 })
      return 'typed'
    case 'press':
      await page.keyboard.press(String(cmd.key))
      return 'pressed'
    case 'wait':
      await page.waitForTimeout(Number(cmd.ms ?? 1000))
      return 'waited'
    case 'shot':
      await page.screenshot({ path: String(cmd.path ?? '/tmp/shot.png'), fullPage: cmd.full === 'true' })
      return String(cmd.path ?? '/tmp/shot.png')
    case 'text':
      return sel ? await page.locator(sel).first().innerText({ timeout }) : await page.locator('body').innerText()
    case 'eval':
      return await page.evaluate(String(cmd.js))
    case 'url':
      return page.url()
    case 'frames':
      return page.frames().map((f) => f.url())
    case 'close':
      setTimeout(() => process.exit(0), 200)
      return 'closing'
    default:
      throw new Error(`unknown op ${cmd.op}`)
  }
}

http
  .createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    try {
      const result = await run(JSON.parse(body || '{}'))
      res.end(JSON.stringify({ ok: true, result }))
    } catch (err) {
      res.statusCode = 500
      res.end(JSON.stringify({ ok: false, error: String(err).split('\n')[0] }))
    }
  })
  .listen(8931, '127.0.0.1', () => console.log('browser driver on 127.0.0.1:8931'))

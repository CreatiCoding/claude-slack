// The web app's QR (src/web/qr.js) read back by a real reader. Chrome on macOS has no BarcodeDetector, so this uses
// Apple's CoreImage CIDetector (scripts/qr-read.swift). Usage: node scripts/qa-qr.ts   (macOS, needs swift)
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'

const src = readFileSync(new URL('../src/web/qr.js', import.meta.url), 'utf8').replace(/^export /gm, '')
const dir = mkdtempSync(join(tmpdir(), 'qa-qr-'))
// The same strings as the known vectors npm test compares against (test/fixtures/qr-vectors.json), plus a long one.
const texts = [...(JSON.parse(readFileSync(new URL('../test/fixtures/qr-vectors.json', import.meta.url), 'utf8')) as Array<{ text: string }>).map((v) => v.text), 'https://example.com/' + 'a'.repeat(190)]
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 420, height: 420 } })
const files: string[] = []
for (const [i, t] of texts.entries()) {
  await page.setContent('<body style="margin:0;background:#fff"><div id=q></div></body>')
  await page.evaluate(({ src, t }) => {
    new Function(src + '; window.qrSvg = qrSvg')()
    document.getElementById('q')!.innerHTML = (window as unknown as { qrSvg: (t: string, n: number) => string }).qrSvg(t, 400)
  }, { src, t })
  const file = join(dir, `${i}.png`)
  await page.locator('svg').screenshot({ path: file })
  writeFileSync(file + '.txt', t)
  files.push(file)
}
await browser.close()
const out = execFileSync('swift', [new URL('./qr-read.swift', import.meta.url).pathname, ...files], { encoding: 'utf8' })
console.log(out.trim())
process.exit(out.includes('MISMATCH') ? 1 : 0)

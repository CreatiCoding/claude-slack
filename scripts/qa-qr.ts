// The web app's QR (src/web/qr.js) read back by a real reader. Chrome on macOS has no BarcodeDetector, so this uses
// Apple's CoreImage CIDetector (scripts/qr-read.swift). Usage: node scripts/qa-qr.ts   (macOS, needs swift)
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'

const src = readFileSync(new URL('../src/web/qr.js', import.meta.url), 'utf8').replace(/^export /gm, '')
const dir = mkdtempSync(join(tmpdir(), 'qa-qr-'))
const texts = ['https://claude-slack.internal.creco.dev/', 'https://claude-slack.internal.creco.dev/?t=abcdef0123456789abcdef0123456789#1790681234.661739', '한글 주소 https://예시.com/경로', 'x'.repeat(120), 'https://example.com/' + 'a'.repeat(190)]
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

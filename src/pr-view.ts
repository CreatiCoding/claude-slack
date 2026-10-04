/**
 * A pull request as one HTML page (50), for the phone's window: its status, title, who and where, the description,
 * the checks, the reviews, the files, and the changes (per file, the first five open; a diff over 400 KB is cut; the limits count bytes).
 * Drawn in the same sandbox as the HTML preview (no scripts), so it is shown, not run.
 */
import { execFile } from 'node:child_process'
import { md } from './web/markdown.js'

const FIELDS = 'number,title,body,state,isDraft,author,baseRefName,headRefName,createdAt,mergedAt,closedAt,additions,deletions,changedFiles,url,reviewDecision,statusCheckRollup,reviews,comments,files,mergedBy,labels'
const DIFF_MAX = 400_000
const FILE_CHUNK_MAX = 40_000

/** The first `max` bytes of a text (50: the limits are bytes, not characters). */
const headBytes = (s: string, max: number): string => (Buffer.byteLength(s) <= max ? s : Buffer.from(s).subarray(0, max).toString('utf8'))

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

function run(args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile('gh', args, { timeout: 20_000, maxBuffer: 20 * 1024 * 1024 }, (err, out) => (err ? reject(err) : resolve(out))),
  )
}

/** The document's start and style, on every page (50). */
const STYLE_HEAD = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
body{font:15px/1.5 system-ui,sans-serif;margin:0;padding:14px;color:#1f2328;background:#fff}
.badge{display:inline-block;color:#fff;border-radius:999px;padding:1px 10px;font-size:13px}
h1{font-size:19px;margin:8px 0}.meta{color:#656d76;font-size:13px}pre{white-space:pre-wrap;background:#f6f8fa;border-radius:8px;padding:10px;font-size:12px;overflow-x:auto}
details{margin:6px 0;border:1px solid #d1d9e0;border-radius:8px;padding:6px 10px}summary{cursor:pointer;word-break:break-all}h2{font-size:15px;margin-top:18px}.md{word-break:break-word}.md pre{white-space:pre-wrap}
.none{color:#656d76}@media (prefers-color-scheme:dark){body{background:#0d1117;color:#e6edf3}pre{background:#161b22}details{border-color:#30363d}.meta,.none{color:#8b949e}}
</style></head><body>`

/** One page holds about this many characters (50); a file's block is never cut to fit, only over the limit. */
export const PAGE_CHARS = 60_000

/** Pull request URL → its pages of HTML (50). Rejects when gh cannot say. Page 1 has the header; the changes continue on the next. */
export async function prViewPages(url: string): Promise<{ title: string; pages: string[] }> {
  const [raw, diff] = await Promise.all([run(['pr', 'view', url, '--json', FIELDS]), run(['pr', 'diff', url]).catch(() => '')])
  return prPages(JSON.parse(raw) as Record<string, any>, diff)
}

/** The pages from gh's answer (50): kept apart from the call so a test can give it a PR and a diff. */
export function prPages(pr: Record<string, any>, diff: string): { title: string; pages: string[] } {
  const state = pr.state === 'OPEN' && pr.isDraft ? 'DRAFT' : pr.state
  const color: Record<string, string> = { OPEN: '#1a7f37', MERGED: '#8250df', CLOSED: '#cf222e', DRAFT: '#6e7781' }
  const checks: Array<{ name?: string; status?: string; conclusion?: string }> = pr.statusCheckRollup ?? []
  const failed = checks.filter((c) => c.conclusion && !['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(c.conclusion))
  const files: Array<{ path: string; additions?: number; deletions?: number }> = pr.files ?? []
  const tooBig = Buffer.byteLength(diff) > DIFF_MAX
  const chunks = tooBig ? headBytes(diff, DIFF_MAX) : diff
  const parts = chunks.split(/^(?=diff --git )/m).filter(Boolean)
  const diffHtml = parts.map((p, i) => {
    const name = /^diff --git a\/(\S+)/.exec(p)?.[1] ?? `파일 ${i + 1}`
    const body = Buffer.byteLength(p) > FILE_CHUNK_MAX ? headBytes(p, FILE_CHUNK_MAX) + '\n… (이 파일은 여기까지)' : p
    return `<details${i < 5 ? ' open' : ''}><summary>${esc(name)}</summary><pre>${esc(body)}</pre></details>`
  })
  const reviews: Array<{ author?: { login?: string }; state?: string }> = pr.reviews ?? []
  const title = `#${pr.number} ${pr.title}`
  const head = STYLE_HEAD + `<span class="badge" style="background:${color[state] ?? '#6e7781'}">${esc(({ OPEN: '열림', MERGED: '머지됨', CLOSED: '닫힘', DRAFT: '초안' } as Record<string, string>)[state] ?? state)}</span>
<h1>#${esc(pr.number)} ${esc(pr.title)}</h1>
<div class="meta">${esc(pr.author?.login)} · ${esc(pr.headRefName)} → ${esc(pr.baseRefName)} · ${esc(String(pr.createdAt ?? '').slice(0, 10))}</div>
<div class="meta">+${esc(pr.additions)} −${esc(pr.deletions)} · 파일 ${esc(pr.changedFiles)}개 · 리뷰 ${esc(pr.reviewDecision || '없음')}${(pr.labels ?? []).length ? ' · ' + (pr.labels as Array<{ name: string }>).map((l) => esc(l.name)).join(', ') : ''}</div>
<h2>체크</h2>${checks.length ? `<details${failed.length ? ' open' : ''}><summary>${checks.length}개${failed.length ? ` · 실패 ${failed.length}개` : ''}</summary><pre>${esc(checks.map((c) => `${c.name ?? ''}: ${c.conclusion || c.status || ''}`).join('\n'))}</pre></details>` : '<div class="none">체크가 없어요</div>'}
<h2>설명</h2>${pr.body ? `<div class="md">${md(String(pr.body))}</div>` : '<div class="none">설명이 없어요</div>'}
<h2>리뷰</h2>${reviews.length ? reviews.map((r) => `<div>${esc(r.author?.login)} · ${esc(r.state)}</div>`).join('') : '<div class="none">리뷰가 없어요</div>'}
<h2>바뀐 파일</h2>${files.length ? files.map((f) => `<div>${esc(f.path)} <span class="meta">+${esc(f.additions)} −${esc(f.deletions)}</span></div>`).join('') : '<div class="none">없어요</div>'}
<h2>변경 내용</h2>${tooBig ? '<div class="meta">(앞부분만)</div>' : ''}`
  const tail = '</body></html>'
  // Pages: the header with the first blocks; then blocks until a page would pass PAGE_CHARS.
  const pages: string[] = []
  let current = head
  for (const block of diffHtml.length ? diffHtml : ['<div class="none">변경 내용을 읽지 못했어요</div>']) {
    if (current.length + block.length > PAGE_CHARS && current !== head) {
      pages.push(current + tail)
      current = `${STYLE_HEAD}<div class="meta">변경 내용 계속</div>`
    }
    current += block
  }
  pages.push(current + tail)
  return { title, pages }
}

/** The first page only (kept for callers that want one HTML document). */
export async function prViewHtml(url: string): Promise<string> {
  return (await prViewPages(url)).pages[0]!
}

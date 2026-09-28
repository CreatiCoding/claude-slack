import { MODEL_OPTIONS } from './panel.ts'

const REFRESH_MS = 60 * 60 * 1000

const DOCS_URL = 'https://platform.claude.com/docs/en/about-claude/models/overview.md'

/** Pull `Claude API ID` and `Model page` rows out of the docs' model-comparison table; columns line up by position. */
export function parseModelsDoc(md: string): Array<{ label: string; value: string }> {
  const cells = (prefix: string) => md.split('\n').find((l) => l.startsWith(`| ${prefix}`))?.split('|').slice(2, -1) ?? []
  const ids = cells('Claude API ID').map((c) => c.match(/`(claude-[\w.-]+)`/)?.[1])
  const names = cells('Model page').map((c) => c.match(/\[([^\]]+)\]/)?.[1])
  return ids.flatMap((id, i) => (id ? [{ label: (names[i] ?? id).replace(/^Claude /, ''), value: id }] : []))
}

/** Models the docs list that the picker doesn't already offer, in the docs' order. */
export async function fetchNewModels(known: Set<string>, fetchFn: typeof fetch = fetch) {
  const res = await fetchFn(DOCS_URL)
  if (!res.ok) throw new Error(`models doc ${res.status}`)
  return parseModelsDoc(await res.text()).filter((m) => !known.has(m.value))
}

/** Merge newly listed models into MODEL_OPTIONS in place, ahead of the Claude Code-only entries (opusplan, default). */
export async function refreshModelOptions(fetchFn?: typeof fetch): Promise<number> {
  const known = new Set(MODEL_OPTIONS.map((m) => m.value.replace(/\[1m\]$/, '')))
  const fresh = await fetchNewModels(known, fetchFn)
  if (!fresh.length) return 0
  const at = MODEL_OPTIONS.findIndex((m) => m.value === 'opusplan')
  MODEL_OPTIONS.splice(at < 0 ? MODEL_OPTIONS.length : at, 0, ...fresh)
  return fresh.length
}

/** Refresh now and hourly; a failed refresh keeps the static list. */
export function startModelRefresh(log: (msg: string) => void) {
  const run = () => refreshModelOptions().then((n) => n && log(`model list: added ${n} new model(s)`), (e) => log(`model list refresh failed: ${e}`))
  void run()
  setInterval(run, REFRESH_MS).unref()
}

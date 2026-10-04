/**
 * Usage statistics (53), worked out from the event logs alone: a turn is a `status` busy line up to the next
 * non-busy one; a turn that never ends counts up to its last event (or a minute after it) and never past 30 min.
 * Pure: the caller hands in the events and the clock.
 */

export interface StatEvent {
  type: string
  at: number
  via?: string
  name?: string
  state?: string
  /** A message's text (a permission card's line starts with 🔐 권한 요청). */
  text?: string
}

export interface StatThread {
  thread: string
  cwd: string
  events: StatEvent[]
}

export type StatDays = 1 | 7 | 30 | 90

const DAY = 86_400_000
const TURN_CAP_MS = 30 * 60_000
const QUIET_OPEN_MS = 30 * 60_000

export interface Span {
  start: number
  end: number
  cwd: string
}

/** Turns per thread, with the open one closed the way the page explains (see the header). */
export function turnSpans(threads: StatThread[], now: number, from: number): Span[] {
  const out: Span[] = []
  for (const t of threads) {
    let open: number | undefined
    let lastAt = 0
    const closeAt = (end: number) => {
      if (open === undefined) return
      const e = Math.min(end, open + TURN_CAP_MS)
      if (e > from) out.push({ start: Math.max(open, from), end: Math.min(e, now), cwd: t.cwd })
      open = undefined
    }
    for (const e of t.events) {
      lastAt = Math.max(lastAt, e.at)
      if (e.type !== 'status') continue
      if (e.state === 'busy') {
        if (open !== undefined) closeAt(e.at)
        open = e.at
      } else closeAt(e.at)
    }
    if (open !== undefined) {
      const end = now - lastAt <= QUIET_OPEN_MS ? now : Math.min(lastAt + 60_000, open + TURN_CAP_MS)
      closeAt(end)
    }
  }
  return out
}

/** The length of the union of spans (busy time) and the most spans open at once. */
export function busyAndPeak(spans: Span[]): { busy: number; peak: number } {
  const points: Array<[number, number]> = []
  for (const s of spans) {
    points.push([s.start, 1], [s.end, -1])
  }
  points.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  let depth = 0
  let busy = 0
  let peak = 0
  let last = 0
  for (const [at, d] of points) {
    if (depth > 0) busy += at - last
    depth += d
    peak = Math.max(peak, depth)
    last = at
  }
  return { busy, peak }
}

/** Nearest-rank by floor(q·n), as the page describes: the value at index floor(q·n) of the sorted list. */
export function quantile(sorted: number[], q: number): number | undefined {
  if (!sorted.length) return undefined
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
}

/** Bucket width of the concurrency graph: 15 min for a day, 1 h up to a week, 3 h beyond (53). */
export function bucketMs(days: StatDays): number {
  if (days === 1) return 15 * 60_000
  if (days <= 7) return 3_600_000
  return 3 * 3_600_000
}

/** The pull requests of the person in the window (53): merged, opened, merge time, and the lines added and removed. */
export interface PrStat {
  mergedAt?: string
  createdAt: string
  url: string
}
export function prSummary(prs: PrStat[], now: number, days: StatDays) {
  const from = now - days * DAY
  const inWin = (t?: string) => !!t && Date.parse(t) >= from && Date.parse(t) <= now
  const merged = prs.filter((p) => inWin(p.mergedAt))
  const created = prs.filter((p) => inWin(p.createdAt))
  const times = merged.map((p) => Date.parse(p.mergedAt!) - Date.parse(p.createdAt)).filter((x) => x >= 0).sort((a, b) => a - b)
  return {
    merged: merged.length,
    created: created.length,
    medianMergeMs: quantile(times, 0.5),
    p90MergeMs: quantile(times, 0.9),
    recent: [...created].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, 20).map((p) => ({ url: p.url, createdAt: p.createdAt, mergedAt: p.mergedAt })),
  }
}

export function computeStats(threads: StatThread[], now: number, days: StatDays) {
  const from = now - days * DAY
  const spans = turnSpans(threads, now, from)
  const durations = spans.map((s) => s.end - s.start).sort((a, b) => a - b)
  const total = durations.reduce((a, b) => a + b, 0)
  const { busy, peak } = busyAndPeak(spans)
  const width = bucketMs(days)
  const series: number[] = []
  for (let t = from; t < now; t += width) {
    let overlap = 0
    for (const s of spans) overlap += Math.max(0, Math.min(s.end, t + width) - Math.max(s.start, t))
    series.push(Math.round((overlap / width) * 100) / 100)
  }
  const inRange = (at: number) => at >= from && at <= now
  const myMessages = threads.flatMap((t) => t.events.filter((e) => e.type === 'user' && (e.via === 'web' || e.via === 'terminal') && inRange(e.at)))
  const tools = threads.flatMap((t) => t.events.filter((e) => e.type === 'tool' && inRange(e.at)))
  const perms = threads.flatMap((t) => t.events.filter((e) => e.type === 'msg' && inRange(e.at) && /권한 요청/.test(e.text ?? '')))
  const byDay = new Map<string, { work: number; mine: number; sessions: Set<string> }>()
  const dayKey = (at: number) => {
    const d = new Date(at)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  const dayOf = (k: string) => byDay.get(k) ?? byDay.set(k, { work: 0, mine: 0, sessions: new Set() }).get(k)!
  for (const s of spans) {
    // A span across midnight is split across the days it touches.
    for (let t = s.start; t < s.end; ) {
      const next = new Date(t)
      next.setHours(24, 0, 0, 0)
      const cut = Math.min(s.end, next.getTime())
      dayOf(dayKey(t)).work += cut - t
      t = cut
    }
  }
  for (const t of threads) for (const e of t.events) if (inRange(e.at)) dayOf(dayKey(e.at)).sessions.add(t.thread)
  for (const m of myMessages) dayOf(dayKey(m.at)).mine++
  const heat: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0) as number[])
  for (const m of myMessages) {
    const d = new Date(m.at)
    heat[d.getDay()]![d.getHours()]!++
  }
  const folders = new Map<string, number>()
  for (const s of spans) folders.set(s.cwd, (folders.get(s.cwd) ?? 0) + (s.end - s.start))
  const toolCounts = new Map<string, number>()
  for (const t of tools) toolCounts.set(t.name ?? '?', (toolCounts.get(t.name ?? '?') ?? 0) + 1)
  return {
    days,
    totals: { work: total, busy, avgConcurrency: busy ? Math.round((total / busy) * 100) / 100 : 0, peakConcurrency: peak },
    turns: { count: durations.length, medianMs: quantile(durations, 0.5), p90Ms: quantile(durations, 0.9) },
    tools: tools.length,
    permissions: perms.length,
    series,
    daily: [...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, v]) => ({ day, workMs: v.work, mine: v.mine, sessions: v.sessions.size })),
    heat,
    topFolders: [...folders.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([cwd, ms]) => ({ cwd, workMs: ms })),
    topTools: [...toolCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, count]) => ({ name, count })),
  }
}

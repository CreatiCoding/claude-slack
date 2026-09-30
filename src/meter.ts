/**
 * What the web app costs on the wire, per minute: how many of each kind the broker sent and how many
 * bytes. A single payload over `bigBytes` is logged at once with what it was, since one of those is
 * usually the thing to fix.
 */
const PERIOD_MS = 60_000

export class TrafficMeter {
  private kinds = new Map<string, { n: number; bytes: number }>()
  private log: (line: string) => void
  private bigBytes: number
  private timer?: ReturnType<typeof setInterval>

  constructor(log: (line: string) => void, opts: { bigBytes?: number } = {}) {
    this.log = log
    this.bigBytes = opts.bigBytes ?? 500_000
  }

  add(kind: string, bytes: number, what = ''): void {
    const k = this.kinds.get(kind) ?? { n: 0, bytes: 0 }
    k.n++
    k.bytes += bytes
    this.kinds.set(kind, k)
    if (bytes > this.bigBytes) this.log(`big ${kind} ${bytes}B${what ? ' ' + what : ''}`)
  }

  /** The line for the period so far, and a fresh period. Nothing sent: nothing to say. */
  flush(): string | undefined {
    if (!this.kinds.size) return undefined
    let n = 0
    let bytes = 0
    for (const k of this.kinds.values()) {
      n += k.n
      bytes += k.bytes
    }
    const parts = [...this.kinds.entries()].sort((a, b) => b[1].bytes - a[1].bytes).map(([kind, k]) => `${kind}=${k.n}/${k.bytes}B`)
    this.kinds.clear()
    return `sent 1m total=${n}/${bytes}B ${parts.join(' ')}`
  }

  start(): void {
    this.timer ??= setInterval(() => {
      const line = this.flush()
      if (line) this.log(line)
    }, PERIOD_MS)
    this.timer.unref?.()
  }
}

/** One line from what a page reported about its last minute. Fields it did not send are left out. */
export function pageMetricsLine(b: Record<string, unknown>): string {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0)
  const word = (v: unknown) => String(v ?? '').replace(/[^\w.-]/g, '').slice(0, 24) || '-'
  const apply = (b.apply ?? {}) as Record<string, unknown>
  const stalls = (b.stalls ?? {}) as Record<string, unknown>
  const catchups = Array.isArray(b.catchups) ? (b.catchups as Array<Record<string, unknown>>).slice(0, 50) : []
  const n = num(apply.n)
  const parts = [
    `tab=${word(b.tab)} view=${word(b.view)}`,
    `recv=${num(b.recvBytes)}B/${num(b.recvEvents)}ev`,
    `apply=${n}×avg${n ? Math.round(num(apply.sum) / n) : 0}ms/max${num(apply.max)}ms`,
    `catchup=${catchups.length}×${catchups.reduce((s, c) => s + num(c.rounds), 0)}rounds/${catchups.reduce((s, c) => s + num(c.events), 0)}ev/${catchups.reduce((s, c) => s + num(c.ms), 0)}ms`,
    `stalls=${num(stalls.n)}/max${num(stalls.max)}ms`,
    `dom=${num(b.dom)}`,
  ]
  return `page ${parts.join(' ')}`
}

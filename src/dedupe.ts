/**
 * Remembers keys just long enough to recognize a repeat.
 *
 * Two different sources deliver the same event twice: a hook registered in both
 * the user and the project config fires twice, and Slack mobile sends a button
 * press twice when the user double-taps. Both were handled with their own
 * copy of "check a timestamp map, then prune it", which is easy to get subtly
 * different. One implementation, two instances.
 */
export class RecentKeys {
  private seen = new Map<string, number>()
  private windowMs: number
  private maxEntries: number
  private ttlMs: number

  constructor(windowMs: number, opts: { maxEntries?: number; ttlMs?: number } = {}) {
    this.windowMs = windowMs
    this.maxEntries = opts.maxEntries ?? 200
    this.ttlMs = opts.ttlMs ?? 10_000
  }

  /**
   * Was this key already seen inside the window? Records it either way, so a
   * burst of repeats keeps being suppressed rather than sliding through.
   */
  isRepeat(key: string, now = Date.now()): boolean {
    // Not `?? 0`: a missing key must not be compared as if it were seen at time 0.
    const last = this.seen.get(key)
    this.seen.set(key, now)
    if (this.seen.size > this.maxEntries) {
      for (const [k, t] of this.seen) if (t < now - this.ttlMs) this.seen.delete(k)
    }
    return last !== undefined && last > now - this.windowMs
  }
}

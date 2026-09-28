/**
 * Who is running, and how to find them.
 *
 * A session is reachable three ways and each caller used to pick its own map:
 * by launch key (the IPC hello), by Slack thread (a message or the native stop
 * button), and by pid (every panel button encodes one). The pid lookup also has
 * to answer for sessions that just ended, because their panel is still in the
 * thread with a working 🗑 button. Keeping those rules in one place means a new
 * caller cannot invent a fourth, subtly different lookup.
 */
import type { Session } from './session.ts'

/** Ended sessions kept addressable, so their panel buttons still resolve. */
const REMEMBER_ENDED = 50

export class SessionRegistry {
  private byKey = new Map<string, Session>()
  private byThread = new Map<string, Session>()
  private endedByPid = new Map<number, Session>()

  /** Sessions that have not ended. */
  get live(): Session[] {
    return [...this.byKey.values()]
  }

  byLaunchKey(key: string): Session | undefined {
    return this.byKey.get(key)
  }

  byThreadTs(threadTs: string): Session | undefined {
    return this.byThread.get(threadTs)
  }

  /** Live session with this pid, else one that ended recently. */
  byPid(pid: number): Session | undefined {
    return this.live.find((s) => s.pid === pid && !s.ended) ?? this.endedByPid.get(pid)
  }

  /** Register a session (or re-register it after its thread is known). */
  add(session: Session): void {
    this.byKey.set(session.key, session)
    if (session.threadTs) this.byThread.set(session.threadTs, session)
  }

  /**
   * Drop it from the live lookups but keep it addressable by pid, so the panel
   * left in the thread can still be used to archive and purge.
   */
  remember(session: Session): void {
    this.byKey.delete(session.key)
    this.endedByPid.set(session.pid, session)
    if (this.endedByPid.size > REMEMBER_ENDED) {
      this.endedByPid.delete(this.endedByPid.keys().next().value!)
    }
  }
}

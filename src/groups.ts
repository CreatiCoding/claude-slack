/**
 * The web app's session groups, kept by the broker so a phone and a PC see the same: which conversation
 * (by thread) is in which group, the order of groups, the order inside each, and the order of the sessions
 * outside any group. Also when "이어서 하기" was last cleared (the list hides what is older).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'

export const DEFAULT_GROUPS_PATH = process.env.CLAUDE_SLACK_GROUPS ?? join(homedir(), '.claude-slack', 'groups.json')

export interface Group {
  id: string
  name: string
  /** Threads in this group, in order. */
  items: string[]
}
export interface GroupsState {
  groups: Group[]
  /** Sessions outside any group, in the order they were put (the rest follow in the default order). */
  loose: string[]
  recentClearedAt?: number
  /** The ids of groups folded shut: kept here so every device shows the same (54). */
  collapsed?: string[]
}

export type GroupOp =
  | { op: 'create'; name: string }
  | { op: 'rename'; id: string; name: string }
  | { op: 'delete'; id: string }
  /** Put a thread into a group (or out of all groups: group null), before `before` (a thread) or at the end. */
  | { op: 'move'; thread: string; group: string | null; before?: string | null }
  /** Put a group before another group (or at the end). */
  | { op: 'order'; id: string; before?: string | null }
  /** Fold a group shut or open it, for every device (54). */
  | { op: 'fold'; id: string; open: boolean }
  /** The order of the sessions outside groups, as shown after a drop (the dropped one is taken out of its group). */
  | { op: 'loose'; order: string[] }
  | { op: 'clearRecent' }

const THREAD_RE = /^\d+\.\d+$/

export class GroupStore {
  private path: string
  private state?: GroupsState

  constructor(path = DEFAULT_GROUPS_PATH) {
    this.path = path
  }

  get(): GroupsState {
    if (!this.state) {
      try {
        const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<GroupsState>
        this.state = { groups: raw.groups ?? [], loose: raw.loose ?? [], ...(raw.recentClearedAt ? { recentClearedAt: raw.recentClearedAt } : {}), ...(raw.collapsed ? { collapsed: raw.collapsed } : {}) }
      } catch {
        this.state = { groups: [], loose: [] }
      }
    }
    return this.state
  }

  /** Apply one change; the result says what went wrong, if anything. */
  apply(o: GroupOp): { ok: boolean; note: string; id?: string } {
    const st = this.get()
    // A group name is 40 characters at most (54).
    const name = (n: string) => n.trim().slice(0, 40)
    const out = (from: string) => {
      st.loose = st.loose.filter((t) => t !== from)
      for (const g of st.groups) g.items = g.items.filter((t) => t !== from)
    }
    const insert = (list: string[], item: string, before?: string | null) => {
      const at = before ? list.indexOf(before) : -1
      at < 0 ? list.push(item) : list.splice(at, 0, item)
    }
    let clearNote = ''
    switch (o.op) {
      case 'create': {
        if (!name(o.name)) return { ok: false, note: '그룹 이름이 비어 있어요.' }
        if (st.groups.length >= 50) return { ok: false, note: '그룹이 너무 많아요.' }
        const id = randomBytes(4).toString('hex')
        st.groups.push({ id, name: name(o.name), items: [] })
        this.save()
        return { ok: true, note: '그룹을 만들었어요.', id }
      }
      case 'rename': {
        const g = st.groups.find((x) => x.id === o.id)
        if (!g || !name(o.name)) return { ok: false, note: '그룹을 찾지 못했거나 이름이 비어 있어요.' }
        g.name = name(o.name)
        break
      }
      case 'delete': {
        const i = st.groups.findIndex((x) => x.id === o.id)
        if (i < 0) return { ok: false, note: '그룹을 찾지 못했어요.' }
        // Its sessions are not lost, they go back to the list outside groups.
        st.loose.push(...st.groups[i]!.items)
        st.groups.splice(i, 1)
        break
      }
      case 'move': {
        if (!THREAD_RE.test(o.thread)) return { ok: false, note: '세션을 찾지 못했어요.' }
        const g = o.group ? st.groups.find((x) => x.id === o.group) : undefined
        if (o.group && !g) return { ok: false, note: '그룹을 찾지 못했어요.' }
        out(o.thread)
        insert(g ? g.items : st.loose, o.thread, o.before)
        break
      }
      case 'order': {
        const i = st.groups.findIndex((x) => x.id === o.id)
        if (i < 0) return { ok: false, note: '그룹을 찾지 못했어요.' }
        const [g] = st.groups.splice(i, 1)
        const at = o.before ? st.groups.findIndex((x) => x.id === o.before) : -1
        at < 0 ? st.groups.push(g!) : st.groups.splice(at, 0, g!)
        break
      }
      case 'fold': {
        if (!st.groups.some((x) => x.id === o.id)) return { ok: false, note: '그룹을 찾지 못했어요.' }
        const shut = new Set(st.collapsed ?? [])
        if (o.open) shut.delete(o.id)
        else shut.add(o.id)
        st.collapsed = [...shut]
        break
      }
      case 'loose': {
        const order = (Array.isArray(o.order) ? o.order : []).filter((t) => THREAD_RE.test(t)).slice(0, 500)
        for (const t of order) for (const g of st.groups) g.items = g.items.filter((x) => x !== t)
        st.loose = [...new Set(order)]
        break
      }
      case 'clearRecent':
        st.recentClearedAt = Date.now()
        clearNote = '이어서 하기 목록을 비웠어요. 대화 파일은 맥에 그대로예요'
        break
      default:
        return { ok: false, note: '알 수 없는 동작이에요.' }
    }
    this.save()
    return { ok: true, note: clearNote }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      writeFileSync(this.path, JSON.stringify(this.state, null, 1))
    } catch {}
  }
}

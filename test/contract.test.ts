/**
 * The producer/consumer contract, checked end to end.
 *
 * Every Slack bug this project has shipped came from the same shape: `panel.ts`
 * renders a button one way and `broker.ts` looks for it another way, and the
 * click is silently dropped. Per-button tests missed it because they passed
 * hand-written ids instead of the ones actually rendered.
 *
 * These tests take the buttons straight out of the rendered blocks and assert
 * (1) every action_id belongs to a known base and (2) clicking it actually does
 * something. A dropped click produces no observable effect and fails here.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Broker } from '../src/broker.ts'
import { listen, type Conn } from '../src/ipc.ts'
import { ACTION, isAction, type ActionBase } from '../src/actions.ts'
import { confirmBlocks, controlPanel, homeView, newSessionEntry, permissionBlocksV2, planApprovalBlocks, questionBlocks, resumePicker } from '../src/panel.ts'
import type { InAction, SlackApi, StreamChunk } from '../src/slack.ts'
import type { TmuxLike } from '../src/tmux.ts'

interface Rendered {
  actionId: string
  value: string
}

/** Pull every clickable element (buttons, overflow options, selects) out of blocks. */
function clickables(blocks: unknown): Rendered[] {
  const out: Rendered[] = []
  for (const b of (blocks as Array<Record<string, any>>) ?? []) {
    const elements = [...(b.elements ?? []), ...(b.accessory ? [b.accessory] : [])]
    for (const e of elements) {
      if (!e?.action_id) continue
      // A link button carries a url instead of a value, but Slack still expects an ack.
      if (typeof e.value === 'string') out.push({ actionId: e.action_id, value: e.value })
      else if (typeof e.url === 'string') out.push({ actionId: e.action_id, value: '' })
      for (const o of e.options ?? []) if (typeof o.value === 'string') out.push({ actionId: e.action_id, value: o.value })
    }
  }
  return out
}

const PID = 100
const PANEL_STATE = { pid: PID, cwd: '/home/u/proj', origin: 'slack' as const, hasPane: true, window: '@1', state: 'idle' as const }

/** Every surface the app can render, with the buttons it puts in front of the user. */
function everySurface(): Array<{ name: string; buttons: Rendered[] }> {
  return [
    { name: 'controlPanel(live)', buttons: clickables(controlPanel(PANEL_STATE).blocks) },
    { name: 'controlPanel(ended)', buttons: clickables(controlPanel({ ...PANEL_STATE, state: 'ended' }).blocks) },
    { name: 'confirmBlocks(exit)', buttons: clickables(confirmBlocks(PID, 'exit').blocks) },
    { name: 'confirmBlocks(purge)', buttons: clickables(confirmBlocks(PID, 'purge').blocks) },
    { name: 'questionBlocks', buttons: clickables(questionBlocks(PID, [{ question: '어느 쪽?', options: [{ label: 'A' }, { label: 'B' }], multiSelect: true }]).blocks) },
    { name: 'planApprovalBlocks', buttons: clickables(planApprovalBlocks(PID).blocks) },
    { name: 'permissionBlocksV2', buttons: clickables(permissionBlocksV2({ pid: PID, requestId: 'abcde', toolName: 'Bash', description: 'ls', inputPreview: '{}', hasPane: true }).blocks) },
    { name: 'newSessionEntry', buttons: clickables(newSessionEntry().blocks) },
    { name: 'resumePicker', buttons: clickables(resumePicker([{ id: 'sess-1', cwd: '/home/u/proj', title: 't', when: '5분 전' }]).blocks) },
    {
      name: 'homeView',
      buttons: clickables(
        (homeView({
          live: [{ pid: PID, cwd: '/home/u/proj', state: 'idle', link: 'https://slack.example/1' }],
          recent: [{ id: 'sess-1', cwd: '/home/u/proj', title: 't', when: '5분 전' }],
          archived: 3,
          channelId: 'C1',
        }) as { blocks: unknown }).blocks,
      ),
    },
  ]
}

const ALL_BASES = Object.values(ACTION) as ActionBase[]

test('every rendered action_id belongs to exactly one known base', () => {
  const surfaces = everySurface()
  assert.ok(
    surfaces.every((s) => s.buttons.length > 0),
    `every surface renders something: ${surfaces.filter((s) => !s.buttons.length).map((s) => s.name)}`,
  )
  for (const surface of surfaces) {
    for (const btn of surface.buttons) {
      const matched = ALL_BASES.filter((base) => isAction(btn.actionId, base))
      assert.equal(matched.length, 1, `${surface.name}: ${btn.actionId} matched ${matched.length} bases (${matched.join(', ')})`)
    }
  }
})

test('no two bases are prefixes of each other, so matching can never be ambiguous', () => {
  for (const a of ALL_BASES) {
    for (const b of ALL_BASES) {
      if (a === b) continue
      assert.ok(!isAction(`${a}_x_1`, b), `${a} is mistaken for ${b}`)
    }
  }
})

// ---------------------------------------------------------------- routing

class RecordingSlack implements SlackApi {
  effects: string[] = []
  private n = 0
  async post(o: { text: string; threadTs?: string; blocks?: unknown[] }) {
    this.effects.push(`post:${o.text.slice(0, 20)}`)
    return `${++this.n}`
  }
  async update(ts: string) {
    this.effects.push(`update:${ts}`)
  }
  async react() {}
  async unreact() {}
  async postEphemeral(_u: string, text: string) {
    this.effects.push(`ephemeral:${text.slice(0, 20)}`)
  }
  async openModal() {
    this.effects.push('modal')
  }
  async permalink() {
    return 'https://slack.example/1'
  }
  async findBotMessage() {
    return undefined
  }
  async threads() {
    return []
  }
  async replies() {
    return []
  }
  async delete() {
    this.effects.push('delete')
  }
  async deleteAsUser() {
    return false
  }
  async startStream() {
    return 's1'
  }
  async appendStream() {}
  async stopStream() {}
  async setSessionStatus() {}
  async createCanvas() {
    return undefined
  }
  async publishHome() {
    this.effects.push('home')
  }
  async renameSession() {}
  async downloadFile() {
    return Buffer.from('')
  }
  async uploadFiles() {
    return true
  }
}

class RecordingTmux implements TmuxLike {
  effects: string[] = []
  /** A numbered dialog is up, so dialog-answering buttons have something to press. */
  screen = ' Do you want to proceed?\n ❯ 1. Yes\n   2. No, and tell Claude what to do\n'
  async launch() {
    this.effects.push('launch')
    return { window: '@7', pane: '%9' }
  }
  async sendKeys(_p: string, keys: string[]) {
    this.effects.push(`keys:${keys.join(' ')}`)
  }
  async typeLine(_p: string, text: string) {
    this.effects.push(`type:${text}`)
  }
  async pasteLine(_p: string, text: string) {
    this.effects.push(`paste:${text}`)
  }
  async capture() {
    return this.screen
  }
  async growHeight() {
    return false
  }
  async captureAnsi() {
    return this.screen
  }
  async killPane() {
    this.effects.push('kill')
  }
  async hasPane() {
    return true
  }
}

async function harness() {
  const id = `${process.pid}-${Math.random().toString(36).slice(2)}`
  const socketPath = join(tmpdir(), `cs-contract-${id}.sock`)
  const slack = new RecordingSlack()
  const tmux = new RecordingTmux()
  const broker = new Broker(
    {
      channelId: 'C1',
      allowedUsers: new Set(['U1']),
      defaultCwd: tmpdir(),
      launcher: '/bin/claude-slack',
      socketPath,
      flushMs: 20,
      archiveDir: join(tmpdir(), `cs-contract-archive-${id}`),
      offsetsPath: join(tmpdir(), `cs-contract-offsets-${id}.json`),
      revivePath: join(tmpdir(), `cs-contract-live-${id}.json`),
      pendingPurgesPath: join(tmpdir(), `cs-contract-pending-${id}.json`),
      purgeGapMs: 0,
      screenImages: false,
      listSessions: () => [{ id: 'sess-1', cwd: '/home/u/proj', title: 't', mtime: 1, when: '5분 전' }],
    },
    slack,
    tmux,
  )
  broker.log = () => {}
  const server = listen(socketPath, (c: Conn) => broker.onConn(c))
  await new Promise((r) => server.once('listening', r))
  return { broker, slack, tmux, socketPath, close: () => server.close() }
}

test('every rendered button is routed: clicking it always has an observable effect', async () => {
  const seen = new Set<string>()
  for (const surface of everySurface()) {
    for (const btn of surface.buttons) {
      // One button per (base, command) shape is enough; the ids differ per render.
      // A link button does nothing server-side; Slack just needs it acked, which
      // the prefix test above covers.
      if (!btn.value) continue
      const shape = `${btn.actionId.replace(/_\d+$/, '')}|${btn.value}`
      if (seen.has(shape)) continue
      seen.add(shape)

      const t = await harness()
      // A live session with pid 100, as the rendered values expect.
      const conn = await import('../src/ipc.ts').then((m) => m.connect(t.socketPath))
      conn.send({ type: 'hello', role: 'channel', key: '100', pid: PID, sessionId: 's1', cwd: '/home/u/proj', tmuxPane: '%9' })
      await new Promise((r) => setTimeout(r, 120))
      t.slack.effects.length = 0
      t.tmux.effects.length = 0

      const action: InAction = { user: 'U1', actionId: btn.actionId, value: btn.value, messageTs: 'm1', channel: 'C1', triggerId: 'trig' }
      await t.broker.handleAction(action)
      await new Promise((r) => setTimeout(r, 120))

      const effects = [...t.slack.effects, ...t.tmux.effects]
      assert.ok(effects.length > 0, `${surface.name} · ${btn.actionId} (${btn.value}) was silently dropped`)
      conn.close()
      t.close()
    }
  }
})

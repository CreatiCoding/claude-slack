import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectEffort, detectPermissionMode, withCoalescedCaptures, type TmuxLike } from '../src/tmux.ts'

const stubTmux: TmuxLike = {
  async launch() {
    return { window: '@1', pane: '%1' }
  },
  async sendKeys() {},
  async typeLine() {},
  async pasteLine() {},
  async captureAnsi() { return '' },
  async growHeight() { return false },
  async capture() {
    return ''
  },
  async killPane() {},
  async hasPane() {
    return true
  },
}

test('detectPermissionMode reads the status line', () => {
  assert.equal(detectPermissionMode('  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents'), 'auto')
  assert.equal(detectPermissionMode('  ⏵⏵ accept edits on (shift+tab to cycle)'), 'acceptEdits')
  assert.equal(detectPermissionMode('  ⏸ plan mode on (shift+tab to cycle)'), 'plan')
  assert.equal(detectPermissionMode('  ⏸ manual mode on · ? for shortcuts · ← for agents'), 'default')
  assert.equal(detectPermissionMode('nothing here'), null)
})

test('detectEffort reads the header or the /effort hint', () => {
  assert.equal(detectEffort('▝▜██████▀  Sonnet 5 with low effort · Claude Max\n'), 'low')
  assert.equal(detectEffort('   ○ xhigh · /effort\n'), 'xhigh')
  assert.equal(detectEffort('> hello\n'), null)
})

test('concurrent captures of one pane share a single tmux call', async () => {
  let calls = 0
  const slow: TmuxLike = {
    ...stubTmux,
    async capture(pane) {
      calls++
      await new Promise((r) => setTimeout(r, 30))
      return `screen of ${pane}`
    },
  }
  const coalescing = withCoalescedCaptures(slow)
  const [a, b, c] = await Promise.all([coalescing.capture('%1'), coalescing.capture('%1'), coalescing.capture('%2')])
  assert.equal(a, 'screen of %1')
  assert.equal(b, 'screen of %1')
  assert.equal(c, 'screen of %2')
  assert.equal(calls, 2, 'one call per distinct pane, not per caller')
  // A later call is not served from a stale cache.
  await coalescing.capture('%1')
  assert.equal(calls, 3)
})

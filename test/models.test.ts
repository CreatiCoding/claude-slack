import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MODEL_OPTIONS } from '../src/panel.ts'
import { parseModelsDoc, refreshModelOptions } from '../src/models.ts'

const DOC = [
  '| Model page | [Claude Zed 9](https://x/zed) | [Claude Sonnet 5](https://x/s) |',
  '| Claude API ID | `claude-zed-9` | `claude-sonnet-5` |',
].join('\n')

test('parseModelsDoc pairs names with API ids', () => {
  assert.deepEqual(parseModelsDoc(DOC), [
    { label: 'Zed 9', value: 'claude-zed-9' },
    { label: 'Sonnet 5', value: 'claude-sonnet-5' },
  ])
})

test('refreshModelOptions adds unknown models before opusplan and skips known ones', async () => {
  const before = MODEL_OPTIONS.length
  const fake = (async () => new Response(DOC)) as typeof fetch
  assert.equal(await refreshModelOptions(fake), 1)
  assert.equal(MODEL_OPTIONS.length, before + 1)
  assert.equal(MODEL_OPTIONS.findIndex((m) => m.value === 'claude-zed-9') + 1, MODEL_OPTIONS.findIndex((m) => m.value === 'opusplan'))
})

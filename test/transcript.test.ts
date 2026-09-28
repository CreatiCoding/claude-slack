import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { lastModelInTranscript, parseTranscriptLine, TranscriptTailer, transcriptPathFor } from '../src/transcript.ts'

test('parseTranscriptLine distills assistant and user entries', () => {
  const a = JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'hi' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] },
  })
  assert.deepEqual(parseTranscriptLine(a), [{ kind: 'thinking' }, { kind: 'text', text: 'hi' }, { kind: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }])
  const r = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'a' }, { type: 'image' }], is_error: true }] } })
  assert.deepEqual(parseTranscriptLine(r), [{ kind: 'tool_result', toolUseId: 't1', output: 'a\n[image]', isError: true }])
  assert.deepEqual(parseTranscriptLine(JSON.stringify({ type: 'user', message: { role: 'user', content: 'prompt' } })), [{ kind: 'user', text: 'prompt' }])
  assert.deepEqual(parseTranscriptLine(JSON.stringify({ type: 'ai-title', aiTitle: 'T' })), [{ kind: 'title', title: 'T' }])
  assert.deepEqual(parseTranscriptLine(JSON.stringify({ type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'sub' }] } })), [])
  assert.deepEqual(parseTranscriptLine('not json'), [])
  assert.deepEqual(parseTranscriptLine(JSON.stringify({ type: 'queue-operation' })), [])
})

test('TranscriptTailer emits only lines appended after it starts', async () => {
  const path = join(tmpdir(), `cs-tail-${process.pid}.jsonl`)
  writeFileSync(path, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'old' }] } }) + '\n')
  const tailer = new TranscriptTailer(path, { pollMs: 20 })
  const got: unknown[] = []
  tailer.on('event', (e) => got.push(e))
  appendFileSync(path, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'new' }] } }) + '\n')
  await new Promise((r) => setTimeout(r, 120))
  tailer.close()
  assert.deepEqual(got, [{ kind: 'text', text: 'new' }])
})

test('lastModelInTranscript and transcriptPathFor', () => {
  const dir = join(tmpdir(), `cs-tp-${process.pid}`)
  const proj = join(dir, '-home-u-proj')
  mkdirSync(proj, { recursive: true })
  const path = join(proj, 'sess-9.jsonl')
  writeFileSync(path, [
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'claude-fable-5-1', content: [{ type: 'text', text: 'a' }] } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'b' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'c' }] } }),
  ].join('\n') + '\n')
  assert.equal(transcriptPathFor('/home/u/proj', 'sess-9', dir), path)
  assert.equal(transcriptPathFor('/home/u/proj', 'nope', dir), undefined)
  assert.equal(lastModelInTranscript(path), 'claude-sonnet-5')
})

test('parseTranscriptLine: 로컬 명령이 출력한 것은 stdout/stderr 로 나뉘어 나온다', () => {
  const line = (content: string) => JSON.stringify({ type: 'user', message: { role: 'user', content } })
  assert.deepEqual(parseTranscriptLine(line('<local-command-stdout>Set model to `Sonnet 5`</local-command-stdout>')), [{ kind: 'local', text: 'Set model to `Sonnet 5`', isError: false }])
  assert.deepEqual(parseTranscriptLine(line('<local-command-stderr>Unknown command: /x</local-command-stderr>')), [{ kind: 'local', text: 'Unknown command: /x', isError: true }])
  assert.deepEqual(parseTranscriptLine(line('<bash-stdout>a\nb</bash-stdout><bash-stderr>oops</bash-stderr>')), [
    { kind: 'local', text: 'a\nb', isError: false },
    { kind: 'local', text: 'oops', isError: true },
  ])
  assert.deepEqual(parseTranscriptLine(line('그냥 메시지')), [{ kind: 'user', text: '그냥 메시지' }])
})

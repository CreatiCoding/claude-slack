import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect, listen } from '../src/ipc.ts'

test('ipc round-trips ndjson messages', async () => {
  const path = join(tmpdir(), `claude-slack-test-${process.pid}.sock`)
  const received: unknown[] = []
  const server = listen(path, (conn) => {
    conn.on('message', (m) => {
      received.push(m)
      conn.send({ echo: m })
    })
  })
  await new Promise((r) => server.once('listening', r))
  const client = await connect(path)
  const reply = new Promise((resolve) => client.once('message', resolve))
  client.send({ hello: 1 })
  assert.deepEqual(await reply, { echo: { hello: 1 } })
  assert.deepEqual(received, [{ hello: 1 }])
  client.close()
  server.close()
})

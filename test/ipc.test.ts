import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect, listen } from '../src/ipc.ts'

test('ipc round-trips ndjson messages', async () => {
  const path = join(tmpdir(), `claude-slack-test-${process.pid}.sock`)
  const received: unknown[] = []
  const server = await listen(path, (conn) => {
    conn.on('message', (m) => {
      received.push(m)
      conn.send({ echo: m })
    })
  })
  const client = await connect(path)
  const reply = new Promise((resolve) => client.once('message', resolve))
  client.send({ hello: 1 })
  assert.deepEqual(await reply, { echo: { hello: 1 } })
  assert.deepEqual(received, [{ hello: 1 }])
  client.close()
  server.close()
})

test('listen: 소켓 파일이 있어도 응답하는 서버가 없으면(죽은 흔적) 지우고 올라간다', async () => {
  const path = join(tmpdir(), `claude-slack-test-dead-${process.pid}.sock`)
  const first = await listen(path, () => {})
  first.close()
  await new Promise((r) => setTimeout(r, 50)) // 닫혔지만 파일은 남는다
  const second = await listen(path, () => {})
  const client = await connect(path)
  client.close()
  second.close()
})

test('listen: 소켓 파일에 응답하는 서버가 있으면 지우지 않고 거절한다(ERR-081)', async () => {
  const { AnotherBrokerError } = await import('../src/ipc.ts')
  const path = join(tmpdir(), `claude-slack-test-live-${process.pid}.sock`)
  const first = await listen(path, () => {})
  await assert.rejects(listen(path, () => {}), (err: unknown) => {
    assert.ok(err instanceof AnotherBrokerError)
    assert.match((err as Error).message, /another broker is answering/)
    return true
  })
  // 거절했으니 첫 번째 서버는 멀쩡히 살아 있어야 한다.
  const client = await connect(path)
  client.close()
  first.close()
})

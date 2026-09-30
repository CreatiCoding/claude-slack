/**
 * Pictures in the web app: stored once under the broker's own folder, sized for the page, served only
 * from there. The page sees a reference (or, when small, the bytes themselves).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync, crc32 } from 'node:zlib'
import { execFileSync } from 'node:child_process'
import { imageSize, ImageStore, attachedImagePaths } from '../src/images.ts'

/** A real PNG of random pixels: incompressible, so it is as big as its size says. */
function png(w: number, h: number, random = true): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(td) >>> 0)
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2 // RGB
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w * 3; x++) raw[y * (w * 3 + 1) + 1 + x] = random ? (Math.random() * 256) | 0 : (x + y) % 256
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

test('imageSize: PNG·JPEG·GIF·WebP 머리에서 가로·세로를 읽는다', () => {
  assert.deepEqual(imageSize(png(30, 20, false)), { w: 30, h: 20 })
  // A minimal JPEG header: SOI, APP0, SOF0 with 480×640.
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x80, 0x01, 0xe0, 0x03])
  assert.deepEqual(imageSize(jpeg), { w: 480, h: 640 })
  const gif = Buffer.from('GIF89a\x40\x01\xf0\x00', 'latin1')
  assert.deepEqual(imageSize(gif), { w: 320, h: 240 })
  const webp = Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBPVP8X', 'latin1'), Buffer.alloc(8), Buffer.from([0x7f, 0x02, 0x00, 0xdf, 0x01, 0x00])])
  assert.deepEqual(imageSize(webp), { w: 640, h: 480 })
  assert.equal(imageSize(Buffer.from('not an image')), undefined)
})

test('ImageStore: 한 번만 저장(내용 해시), 작은 것은 이벤트에 싣고 큰 것은 참조만', () => {
  const store = new ImageStore(mkdtempSync(join(tmpdir(), 'img-')))
  const small = png(40, 30, false)
  const a = store.put('1.1', small, 'image/png')!
  assert.equal(store.put('1.1', small, 'image/png')!.id, a.id, '같은 그림은 같은 id')
  assert.equal(a.w, 40)
  assert.match(a.data!, /^data:image\/png;base64,/)
  const big = png(700, 400) // ~840KB
  const b = store.put('1.1', big, 'image/png')!
  assert.equal(b.data, undefined, '200KB 넘으면 싣지 않는다')
  assert.equal(b.src, `/api/image/1.1/${b.id}`)
  assert.equal(store.put('../etc', small, 'image/png'), undefined, '스레드가 아니면 저장하지 않는다')
  assert.equal(store.put('1.1', Buffer.from('nope'), 'image/png'), undefined, '그림이 아니면 저장하지 않는다')
})

test('ImageStore.file: 150KB 넘는 그림은 폭 1280 이하로 줄인 것을 준다; 더 커지면 원본', { skip: !existsSync('/usr/bin/sips') && 'sips 없음' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'img-'))
  const store = new ImageStore(dir)
  const big = png(1600, 300) // wide and ~1.4MB
  const e = store.put('1.1', big, 'image/png')!
  const out = await store.file('1.1', e.id)
  assert.ok(out)
  assert.ok(statSync(out.path).size < big.length, `${statSync(out.path).size} < ${big.length}`)
  assert.match(out.type, /image\/(jpeg|webp)/)
  const w = Number(/pixelWidth: (\d+)/.exec(execFileSync('/usr/bin/sips', ['-g', 'pixelWidth', out.path], { encoding: 'utf8' }))![1])
  assert.equal(w, 1280, '폭 기준으로 1280')
  // Twice: served from the cached small copy.
  assert.equal((await store.file('1.1', e.id))!.path, out.path)
  // Small ones are served as they are.
  const s = store.put('1.1', png(20, 20, false), 'image/png')!
  assert.equal((await store.file('1.1', s.id))!.type, 'image/png')
  assert.equal(await store.file('1.1', 'zzzz'), undefined)
  assert.equal(await store.file('1.1', '../../x'), undefined)
})

test('attachedImagePaths: 메시지 속 [Image attached: 경로] 를 뽑고 본문에서 뗀다', () => {
  const r = attachedImagePaths('이거 봐\n[Image attached: /Users/me/.claude-slack/images/1-0-a.png]\n[File attached: /x/y.pdf]')
  assert.deepEqual(r.paths, ['/Users/me/.claude-slack/images/1-0-a.png'])
  assert.equal(r.text, '이거 봐\n[File attached: /x/y.pdf]')
})

test('파일 경로로 넣기: 그림 확장자만, 읽을 수 없으면 건너뛴다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'img-'))
  const store = new ImageStore(join(dir, 'store'))
  const f = join(dir, 'shot.png')
  writeFileSync(f, png(10, 10, false))
  assert.equal(store.putFile('1.1', f)!.w, 10)
  assert.equal(store.putFile('1.1', join(dir, 'none.png')), undefined)
  writeFileSync(join(dir, 'a.txt'), 'x')
  assert.equal(store.putFile('1.1', join(dir, 'a.txt')), undefined)
  assert.ok(readFileSync(f).length > 0)
})

test('브로커: 도구가 읽은 그림·웹에서 보낸 그림·Slack 첨부가 이벤트에 그림으로 실린다', async () => {
  const { setup, shim, hook, until, assistant, tick } = await import('./helpers.ts')
  const { appendFileSync } = await import('node:fs')
  const t = await setup()
  const s = await shim(t.socketPath, {})
  await hook(t.socketPath, 100, { hook_event_name: 'SessionStart', source: 'startup' }, t.transcript)
  await t.broker.handleSlackMessage({ user: 'U1', text: '스크린샷 봐', ts: '9.1', threadTs: s.ack, channel: 'C1' })
  appendFileSync(t.transcript, assistant({ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/x/shot.png' } }))
  const pic = png(16, 9, false)
  appendFileSync(t.transcript, JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: pic.toString('base64') } }] }] } }) + '\n')
  await until(() => t.broker.events.since(s.ack, 0).some((e) => e.type === 'tool_end'), '도구 결과')
  const end = t.broker.events.since(s.ack, 0).find((e) => e.type === 'tool_end')!
  assert.ok(end.type === 'tool_end' && end.images?.length === 1 && end.images[0]!.w === 16 && end.images[0]!.data?.startsWith('data:image/png'))

  // From the web: the picture reaches Claude as a path, like a Slack attachment, and shows as a picture.
  await hook(t.socketPath, 100, { hook_event_name: 'Stop', last_assistant_message: '' }, t.transcript)
  const r = await t.broker.webSend(100, '이것도', [{ name: 'a.png', type: 'image/png', data: 'data:image/png;base64,' + pic.toString('base64') }])
  assert.ok(r.ok)
  await tick()
  const inbound = s.inbox.find((m) => (m as { type: string }).type === 'inbound' && /이것도/.test((m as { text: string }).text)) as { text: string }
  assert.match(inbound.text, /\[Image attached: .*-web-0\.png\]/)
  const user = t.broker.events.since(s.ack, 0).filter((e) => e.type === 'user').at(-1)!
  assert.ok(user.type === 'user' && user.text === '이것도' && user.images?.length === 1, JSON.stringify(user).slice(0, 200))
  assert.ok(t.slack.posts.some((p) => /🌐 웹: 이것도 · 그림 1장/.test(p.text)))
  // Nothing but a picture that is not a picture: refused.
  assert.equal((await t.broker.webSend(100, '', [{ data: 'bm90IGFuIGltYWdl' }])).ok, false)
  s.conn.close()
  t.close()
})

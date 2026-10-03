/**
 * Pictures for the web app: what Claude attached, what a tool read (a screenshot, a png), what a person sent.
 *
 * Each is copied once into the broker's own folder under its content hash, and only that folder is ever
 * served, so a path mentioned in an event can never be used to read an arbitrary file. A small picture
 * rides in the event itself; a large one is a reference the page fetches when it scrolls near it.
 * Anything over 150KB is made smaller on first request (WebP with cwebp when installed, else JPEG with
 * macOS sips), by width: a very tall full-page capture scaled by its long side would be unreadable.
 */
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, join } from 'node:path'

export const DEFAULT_WEB_IMAGES_DIR = process.env.CLAUDE_SLACK_WEB_IMAGES_DIR ?? join(homedir(), '.claude-slack', 'web-images')

/** Up to this size the bytes go in the event; above it, a reference. */
const INLINE_MAX = 200_000
/** Above this, a smaller copy is made for the page. */
const SHRINK_OVER = 150_000
const MAX_WIDTH = 1280
const CONVERT_TIMEOUT_MS = 20_000

export interface WebImage {
  id: string
  type: string
  w?: number
  h?: number
  bytes: number
  name?: string
  /** The picture itself, when small. */
  data?: string
  /** Where to fetch it, when large. */
  src?: string
}

const TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }
const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }

/** Width and height from the file's header, without decoding it. */
export function imageSize(b: Buffer): { w: number; h: number } | undefined {
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }
  if (b.length >= 10 && b.toString('latin1', 0, 3) === 'GIF') return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) }
  if (b.length >= 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const kind = b.toString('latin1', 12, 16)
    if (kind === 'VP8X') return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) }
    if (kind === 'VP8 ' && b.length >= 30) return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff }
    if (kind === 'VP8L' && b.length >= 25) {
      const bits = b.readUInt32LE(21)
      return { w: 1 + (bits & 0x3fff), h: 1 + ((bits >> 14) & 0x3fff) }
    }
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return undefined
      const marker = b[i + 1]!
      const len = b.readUInt16BE(i + 2)
      // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) }
      i += 2 + len
    }
  }
  return undefined
}

function typeOf(b: Buffer): string | undefined {
  if (b.length >= 4 && b.readUInt32BE(0) === 0x89504e47) return 'image/png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg'
  if (b.length >= 3 && b.toString('latin1', 0, 3) === 'GIF') return 'image/gif'
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
  return undefined
}

const THREAD_RE = /^\d+\.\d+$/
const ID_RE = /^[0-9a-f]{20}$/

/** `[Image attached: /path]` lines (how Slack and web attachments reach Claude): the paths, and the text without them. */
export function attachedImagePaths(text: string): { paths: string[]; text: string } {
  const paths: string[] = []
  const rest = text.replace(/^\[Image attached: ([^\]\n]+)\]\n?/gm, (_, p: string) => {
    paths.push(p.trim())
    return ''
  })
  return { paths, text: rest.replace(/\n+$/, '') }
}

/** cwebp when installed (Homebrew's `webp`), looked up each time so installing it needs no restart. */
function cwebpPath(): string | undefined {
  return ['/opt/homebrew/bin/cwebp', '/usr/local/bin/cwebp', '/usr/bin/cwebp'].find((p) => existsSync(p))
}
function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => execFile(cmd, args, { timeout: CONVERT_TIMEOUT_MS }, (err) => (err ? reject(err) : resolve())))
}

export class ImageStore {
  private dir: string
  private converting = new Map<string, Promise<{ path: string; type: string } | undefined>>()

  constructor(dir = DEFAULT_WEB_IMAGES_DIR) {
    this.dir = dir
  }

  /** Keep a picture for a thread. Undefined when it is not a picture or the thread is not a thread. */
  put(thread: string, buf: Buffer, declared?: string, name?: string): WebImage | undefined {
    if (!THREAD_RE.test(thread)) return undefined
    const type = typeOf(buf) ?? (declared && TYPES[declared.split('/')[1] ?? ''] ? declared : undefined)
    if (!type || !typeOf(buf)) return undefined
    const id = createHash('sha256').update(buf).digest('hex').slice(0, 20)
    const folder = join(this.dir, thread)
    const file = join(folder, `${id}.${EXT[type]}`)
    try {
      if (!existsSync(file)) {
        mkdirSync(folder, { recursive: true })
        writeFileSync(file, buf)
      }
    } catch {
      return undefined
    }
    const size = imageSize(buf)
    return {
      id,
      type,
      ...(size ? size : {}),
      bytes: buf.length,
      ...(name ? { name } : {}),
      ...(buf.length <= INLINE_MAX ? { data: `data:${type};base64,${buf.toString('base64')}` } : { src: `/api/image/${thread}/${id}` }),
    }
  }

  /** A picture on disk (a file Claude attached, one a person sent): only picture extensions, copied in. */
  putFile(thread: string, path: string): WebImage | undefined {
    if (!TYPES[extname(path).slice(1).toLowerCase()]) return undefined
    try {
      if (statSync(path).size > 50_000_000) return undefined
      return this.put(thread, readFileSync(path), undefined, path.split('/').pop())
    } catch {
      return undefined
    }
  }

  /** The file to send for a reference: the smaller copy for a large picture (made once), else the original. */
  async file(thread: string, id: string): Promise<{ path: string; type: string } | undefined> {
    if (!THREAD_RE.test(thread) || !ID_RE.test(id)) return undefined
    const folder = join(this.dir, thread)
    let names: string[]
    try {
      names = readdirSync(folder).filter((n) => n.startsWith(id + '.'))
    } catch {
      return undefined
    }
    const orig = names.find((n) => /^[0-9a-f]{20}\.(png|jpg|gif|webp)$/.test(n))
    if (!orig) return undefined
    const path = join(folder, orig)
    const type = TYPES[extname(orig).slice(1)]!
    // `.small.keep`: shrinking made it bigger once, so the original is what to send.
    if (names.includes(`${id}.small.keep`)) return { path, type }
    const small = names.find((n) => /\.small\.(jpg|webp)$/.test(n))
    if (small) return { path: join(folder, small), type: TYPES[extname(small).slice(1)]! }
    if (statSync(path).size <= SHRINK_OVER || type === 'image/gif') return { path, type }
    const key = `${thread}/${id}`
    let job = this.converting.get(key)
    if (!job) {
      job = this.shrink(folder, id, path).finally(() => this.converting.delete(key))
      this.converting.set(key, job)
    }
    return (await job) ?? { path, type }
  }

  private async shrink(folder: string, id: string, path: string): Promise<{ path: string; type: string } | undefined> {
    const size = imageSize(readFileSync(path))
    const narrower = size && size.w > MAX_WIDTH
    try {
      let out: string
      let type: string
      const webp = cwebpPath()
      if (webp) {
        out = join(folder, `${id}.small.webp`)
        type = 'image/webp'
        await run(webp, ['-quiet', '-q', '60', ...(narrower ? ['-resize', String(MAX_WIDTH), '0'] : []), path, '-o', out])
      } else {
        out = join(folder, `${id}.small.jpg`)
        type = 'image/jpeg'
        await run('/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '55', ...(narrower ? ['--resampleWidth', String(MAX_WIDTH)] : []), path, '--out', out])
      }
      // Bigger than what it replaces (a flat screenshot as JPEG, say): keep the original, and remember that.
      if (statSync(out).size >= statSync(path).size) {
        rmSync(out, { force: true })
        writeFileSync(join(folder, `${id}.small.keep`), '')
        return { path, type: TYPES[extname(path).slice(1)]! }
      }
      return { path: out, type }
    } catch {
      return undefined
    }
  }

  /** Drop a thread's whole picture folder (P4-33, archive deletion). */
  forgetThread(thread: string): void {
    if (!THREAD_RE.test(thread)) return
    try {
      rmSync(join(this.dir, thread), { recursive: true, force: true })
    } catch {}
  }
}

import net from 'node:net'
import { EventEmitter } from 'node:events'
import { unlinkSync, existsSync } from 'node:fs'

/**
 * Newline-delimited JSON over a unix socket. One Conn per socket; emits
 * 'message' with the parsed object, 'close' when the peer goes away.
 */
export class Conn extends EventEmitter {
  socket: net.Socket
  private buffer = ''

  constructor(socket: net.Socket) {
    super()
    this.socket = socket
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      this.buffer += chunk
      let idx: number
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx).trim()
        this.buffer = this.buffer.slice(idx + 1)
        if (!line) continue
        try {
          this.emit('message', JSON.parse(line))
        } catch {
          this.emit('error', new Error(`bad ipc line: ${line.slice(0, 200)}`))
        }
      }
    })
    socket.on('close', () => this.emit('close'))
    socket.on('error', (err) => this.emit('error', err))
    // Avoid unhandled 'error' crashes when nobody listens.
    this.on('error', () => {})
  }

  send(obj: unknown): void {
    if (this.socket.destroyed) return
    this.socket.write(JSON.stringify(obj) + '\n')
  }

  close(): void {
    this.socket.end()
  }
}

/** Thrown by `listen` when a socket file is already answering: `cannot listen on <path>: another broker is answering`. */
export class AnotherBrokerError extends Error {
  constructor(path: string) {
    super(`cannot listen on ${path}: another broker is answering`)
    this.name = 'AnotherBrokerError'
  }
}

/**
 * Bind the socket, but only after checking a leftover file is not a live broker: unlinking and binding
 * over one, the old behavior, let a second `npm start` steal the socket from a launchd-run broker and
 * the two then fought over the state files underneath it.
 */
export async function listen(path: string, onConn: (conn: Conn) => void): Promise<net.Server> {
  if (existsSync(path)) {
    const answering = await connect(path, 1000).then(
      (conn) => (conn.close(), true),
      () => false,
    )
    if (answering) throw new AnotherBrokerError(path)
    // Dead socket file: no server is listening behind it.
    try {
      unlinkSync(path)
    } catch {}
  }
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => onConn(new Conn(socket)))
    server.once('error', reject)
    server.listen(path, () => {
      server.removeListener('error', reject)
      resolve(server)
    })
  })
}

export function connect(path: string, timeoutMs = 2000): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path)
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('ipc connect timeout'))
    }, timeoutMs)
    socket.once('connect', () => {
      clearTimeout(timer)
      resolve(new Conn(socket))
    })
    socket.once('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

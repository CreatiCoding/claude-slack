/**
 * `npm run logs -- [-n 200] [--hook] [--follow] [--thread <ts>] [--level WARN] [--area inject]`
 *
 * Shows the broker log (or the hook log), filtered so one thread's story can
 * be read on its own. `--follow` tails.
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { DEFAULT_LOG_DIR, tailLog, type Level } from '../src/log.ts'

const args = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const has = (name: string) => args.includes(name)

const file = join(DEFAULT_LOG_DIR, has('--hook') ? 'hook.log' : 'broker.log')
const n = Number(flag('-n') ?? 50)
const thread = flag('--thread')
const level = flag('--level') as Level | undefined
const area = flag('--area')

if (has('--follow') || has('-f')) {
  const tail = spawn('tail', ['-n', String(n), '-F', file], { stdio: ['ignore', 'pipe', 'inherit'] })
  tail.stdout.setEncoding('utf8')
  tail.stdout.on('data', (chunk: string) => {
    for (const line of chunk.split('\n')) {
      if (!line) continue
      if (thread && !line.includes(`t=${thread}`)) continue
      if (area && !line.includes(`[${area}]`)) continue
      process.stdout.write(line + '\n')
    }
  })
} else {
  const lines = tailLog(file, n, { thread, minLevel: level, area })
  if (!lines.length) console.log(`(비어 있음: ${file})`)
  else console.log(lines.join('\n'))
}

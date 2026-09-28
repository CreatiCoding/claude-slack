// Renew the admin page's certificate when it is close to expiring, and tell the channel how it went.
// Meant to run once a day (scripts/install-renew-cert sets that up); it does nothing until 30 days are left.
//   node --env-file=.env scripts/renew-cert.ts            # renew only if due
//   node --env-file=.env scripts/renew-cert.ts --force    # renew now
//   node --env-file=.env scripts/renew-cert.ts --check    # only say when it expires and what is served
// Needs CLAUDE_SLACK_WEB_DOMAIN, and SLACK_BOT_TOKEN, SLACK_CHANNEL_ID and SLACK_ALLOWED_USERS to post the result.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve4 } from 'node:dns/promises'
import { connect } from 'node:tls'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { renewIfNeeded, type RenewSteps } from '../src/cert-renew.ts'
import { need } from './infra-env.ts'

const run = promisify(execFile)
const ROOT = join(import.meta.dirname, '..')
const DOMAIN = need('CLAUDE_SLACK_WEB_DOMAIN')
const CERT = join(homedir(), '.claude-slack', 'tls', 'fullchain.pem')
const stamp = () => new Date().toLocaleString('sv-SE')
const log = (m: string) => console.log(`${stamp()} ${m}`)

async function expiry(): Promise<Date | undefined> {
  if (!existsSync(CERT)) return undefined
  try {
    const { stdout } = await run('openssl', ['x509', '-enddate', '-noout', '-in', CERT])
    const d = new Date(stdout.replace('notAfter=', '').trim())
    return Number.isNaN(d.getTime()) ? undefined : d
  } catch {
    return undefined
  }
}

/** What the domain serves right now: connect over TLS to its address and read the certificate. */
async function served(): Promise<Date | undefined> {
  // c-ares reads the resolvers straight from the system configuration; the OS resolver can hold a stale answer.
  const [ip] = await resolve4(DOMAIN)
  if (!ip) return undefined
  return new Promise((resolve) => {
    const socket = connect({ host: ip, port: 443, servername: DOMAIN, timeout: 10_000 }, () => {
      const cert = socket.getPeerCertificate()
      socket.end()
      resolve(cert?.valid_to ? new Date(cert.valid_to) : undefined)
    })
    socket.on('error', () => resolve(undefined))
    socket.on('timeout', () => {
      socket.destroy()
      resolve(undefined)
    })
  })
}

async function notify(text: string): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN
  const channel = process.env.SLACK_CHANNEL_ID
  if (!token || !channel) return log('no SLACK_BOT_TOKEN / SLACK_CHANNEL_ID; not posting')
  const owner = process.env.SLACK_ALLOWED_USERS?.split(',')[0]?.trim()
  // A failure needs a person, so it mentions them; a success does not.
  const body = text.startsWith('⚠️') && owner ? `<@${owner}> ${text}` : text
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ channel, text: body, unfurl_links: false }),
  })
  const json = (await res.json()) as { ok?: boolean; error?: string }
  if (!json.ok) log(`Slack did not take the message: ${json.error}`)
}

const steps: RenewSteps = {
  expiry,
  issue: async () => void (await run('sh', [join(ROOT, 'scripts', 'issue-cert')], { timeout: 5 * 60_000, maxBuffer: 8 << 20 }).then(({ stdout, stderr }) => log(`issue-cert:\n${(stdout + stderr).trim().split('\n').slice(-6).join('\n')}`))),
  upload: async () => void (await run('node', [join(ROOT, 'scripts', 'dokploy-cert.ts')], { timeout: 2 * 60_000 }).then(({ stdout }) => log(`dokploy-cert: ${stdout.trim()}`))),
  served: async () => {
    // Traefik takes a moment to load the new file.
    await new Promise((r) => setTimeout(r, 8_000))
    return served()
  },
  notify,
  log,
}

if (process.argv.includes('--check')) {
  const [own, live] = [await expiry(), await served().catch(() => undefined)]
  log(`on disk: ${own?.toISOString().slice(0, 10) ?? 'none'} · served by ${DOMAIN}: ${live?.toISOString().slice(0, 10) ?? 'unreachable'}`)
  process.exit(0)
}
const outcome = await renewIfNeeded(steps, { force: process.argv.includes('--force') })
process.exit(outcome === 'failed' ? 1 : 0)

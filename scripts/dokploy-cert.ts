// Upload the admin page's certificate to Dokploy, so its Traefik serves it on 443 for the domain.
// The certificate comes from scripts/issue-cert (DNS-01 through acme-dns); Traefik cannot get one
// itself because the domain only resolves to a Tailscale address.
// Usage: node --env-file=.env scripts/dokploy-cert.ts [--dry-run]
// Run it again after every renewal: it replaces the certificate of the same name.
// Needs CLAUDE_SLACK_WEB_DOMAIN and CLAUDE_SLACK_DOKPLOY_ORG_ID (see .env.example), plus the Dokploy URL and key.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dokploy, need } from './infra-env.ts'

const NAME = need('CLAUDE_SLACK_WEB_DOMAIN')
const ORGANIZATION_ID = need('CLAUDE_SLACK_DOKPLOY_ORG_ID')
const dir = `${homedir()}/.claude-slack/tls`
const certificateData = readFileSync(`${dir}/fullchain.pem`, 'utf8')
const privateKey = readFileSync(`${dir}/key.pem`, 'utf8')

if (process.argv.includes('--dry-run')) {
  console.log(`would upload "${NAME}": ${certificateData.split('BEGIN CERTIFICATE').length - 1} certificate(s), key ${privateKey.length} bytes`)
  process.exit(0)
}

const { base, apiKey } = dokploy()
const headers = { 'content-type': 'application/json', 'x-api-key': apiKey }
const call = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
  const res = await fetch(`${base}/api/${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) })
  const text = await res.text()
  if (!res.ok) throw new Error(`${path}: ${res.status} ${text.slice(0, 200)}`)
  return text ? JSON.parse(text) : undefined
}

const existing = (await call('GET', 'certificates.all')) as Array<{ certificateId: string; name: string }>
for (const c of existing.filter((c) => c.name === NAME)) {
  await call('POST', 'certificates.remove', { certificateId: c.certificateId })
  console.log(`replaced the earlier certificate ${c.certificateId}`)
}
await call('POST', 'certificates.create', { name: NAME, certificateData, privateKey, autoRenew: false, organizationId: ORGANIZATION_ID })
console.log(`uploaded "${NAME}"`)

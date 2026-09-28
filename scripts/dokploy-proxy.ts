// Point CLAUDE_SLACK_WEB_DOMAIN at the broker's admin page over Tailscale.
// Dokploy's Traefik redirects every http:// request to https://, so the router lives on
// websecure with tls: {} and Traefik serves its built-in self-signed certificate.
// Writes the Traefik router/service of the Dokploy app that holds the domain.
// Usage: node --env-file=.env scripts/dokploy-proxy.ts [--dry-run]
// Needs CLAUDE_SLACK_WEB_DOMAIN, CLAUDE_SLACK_PROXY_TARGET, CLAUDE_SLACK_DOKPLOY_APP_ID and
// CLAUDE_SLACK_DOKPLOY_APP_NAME (see .env.example), plus the Dokploy URL and key (see infra-env.ts).
import { dokploy, need } from './infra-env.ts'

const APP_ID = need('CLAUDE_SLACK_DOKPLOY_APP_ID')
const APP_NAME = need('CLAUDE_SLACK_DOKPLOY_APP_NAME')
const HOST = need('CLAUDE_SLACK_WEB_DOMAIN')
const TARGET = need('CLAUDE_SLACK_PROXY_TARGET')
const ROUTER = `${APP_NAME}-router-27`
const SERVICE = `${APP_NAME}-service-27`

const traefikConfig = `http:
  routers:
    ${ROUTER}:
      rule: Host(\`${HOST}\`)
      service: ${SERVICE}
      middlewares: []
      entryPoints:
        - websecure
      tls: {}
  services:
    ${SERVICE}:
      loadBalancer:
        servers:
          - url: ${TARGET}
        passHostHeader: true
`

if (process.argv.includes('--dry-run')) {
  console.log(traefikConfig)
  process.exit(0)
}

const { base, apiKey } = dokploy()
const res = await fetch(`${base}/api/application.updateTraefikConfig`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
  body: JSON.stringify({ applicationId: APP_ID, traefikConfig }),
})
console.log(res.status, (await res.text()).slice(0, 200))
process.exit(res.ok ? 0 : 1)

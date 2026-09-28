// Remove a certificate from Dokploy by name.
// Usage: node --env-file=.env scripts/dokploy-cert-remove.ts <name> [--dry-run]
//   --dry-run  only list the certificates and say which one would be removed
import { dokploy } from './infra-env.ts'

const name = process.argv.slice(2).find((a) => !a.startsWith('--'))
if (!name) {
  console.error('지울 인증서 이름을 주세요: node --env-file=.env scripts/dokploy-cert-remove.ts <name> [--dry-run]')
  process.exit(1)
}
const dryRun = process.argv.includes('--dry-run')

const { base, apiKey } = dokploy()
const headers = { 'content-type': 'application/json', 'x-api-key': apiKey }
const call = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
  const res = await fetch(`${base}/api/${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) })
  const text = await res.text()
  if (!res.ok) throw new Error(`${path}: ${res.status} ${text.slice(0, 200)}`)
  return text ? JSON.parse(text) : undefined
}

const all = (await call('GET', 'certificates.all')) as Array<{ certificateId: string; name: string }>
console.log(`Dokploy 인증서 ${all.length}개:`)
for (const c of all) console.log(`  ${c.name === name ? '→' : ' '} ${c.name}`)

const hits = all.filter((c) => c.name === name)
if (!hits.length) {
  console.log(`"${name}" 이름의 인증서가 없습니다. 지울 것이 없습니다.`)
  process.exit(0)
}
if (dryRun) {
  console.log(`(dry-run) "${name}" ${hits.length}개를 지울 예정입니다. --dry-run 을 빼고 다시 실행하세요.`)
  process.exit(0)
}
for (const c of hits) {
  await call('POST', 'certificates.remove', { certificateId: c.certificateId })
  console.log(`지웠습니다: ${c.name}`)
}

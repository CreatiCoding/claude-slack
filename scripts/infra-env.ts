// Settings for the optional self-hosting scripts (Dokploy proxy and certificate). Everything specific to
// one deployment lives in .env, so run them with `node --env-file=.env scripts/<name>.ts`.
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'

export function need(name: string): string {
  const value = process.env[name]
  if (!value) {
    console.error(`${name} 가 없습니다. .env 에 넣고 node --env-file=.env 로 실행하세요. (.env.example 참고)`)
    process.exit(1)
  }
  return value
}

/** DOKPLOY_URL / DOKPLOY_API_KEY from the environment, else from the `dokploy` MCP server in ~/.claude.json. */
export function dokploy(): { base: string; apiKey: string } {
  let url = process.env.DOKPLOY_URL
  let apiKey = process.env.DOKPLOY_API_KEY
  const file = `${homedir()}/.claude.json`
  if ((!url || !apiKey) && existsSync(file)) {
    const env = JSON.parse(readFileSync(file, 'utf8')).mcpServers?.dokploy?.env ?? {}
    url ||= env.DOKPLOY_URL
    apiKey ||= env.DOKPLOY_API_KEY
  }
  if (!url || !apiKey) {
    console.error('DOKPLOY_URL / DOKPLOY_API_KEY 가 없습니다. .env 에 넣거나 ~/.claude.json 의 dokploy MCP 서버 env 에 두세요.')
    process.exit(1)
  }
  return { base: url.replace(/\/$/, '').replace(/\/api$/, ''), apiKey }
}

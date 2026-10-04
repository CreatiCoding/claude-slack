import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sessionPlugins, userMarkets } from '../src/plugins.ts'

function plugins() {
  const dir = mkdtempSync(join(tmpdir(), 'plug-'))
  writeFileSync(
    join(dir, 'known_marketplaces.json'),
    JSON.stringify({ 'cdt-skills': { source: { source: 'github', repo: 'alice/cdt-skills' } }, official: { source: { source: 'github', repo: 'anthropics/official' } }, solo: { source: { source: 'git', url: 'git@github.com:alice/solo.git' } } }),
  )
  const v = (market: string, plugin: string, version: string) => mkdirSync(join(dir, 'cache', market, plugin, version), { recursive: true })
  return { dir, v }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('내 계정 마켓만(주소 경로에 사용자명)', () => {
  const { dir } = plugins()
  assert.deepEqual(userMarkets(dir, 'alice').sort(), ['cdt-skills', 'solo'])
})

test('세션이 쓰는 버전 = 프로세스 시작 전에 있던 가장 새 버전; 더 새 게 있으면 새로고침하면; 스킬별로 나뉜 마켓은 번들 이름·버전 한 줄', async () => {
  const { dir, v } = plugins()
  v('cdt-skills', 'cdt-skills', '0.4.2')
  v('cdt-skills', 'cdt-commit', '0.4.2')
  await sleep(30)
  const started = Date.now()
  await sleep(30)
  v('cdt-skills', 'cdt-commit', '0.5.0') // only a sub-plugin changed
  assert.deepEqual(sessionPlugins({ pluginsDir: dir, user: 'alice', processStart: started }), [{ market: 'cdt-skills', version: '0.4.2', latest: '최신' }])
  v('cdt-skills', 'cdt-skills', '0.5.0')
  assert.deepEqual(sessionPlugins({ pluginsDir: dir, user: 'alice', processStart: started }), [{ market: 'cdt-skills', version: '0.4.2', latest: '0.5.0' }])
  // A new process started after the update runs it: nothing to add.
  assert.deepEqual(sessionPlugins({ pluginsDir: dir, user: 'alice', processStart: Date.now() + 1000 }), [{ market: 'cdt-skills', version: '0.5.0' }])
})

test('대화에 Claude Code 가 쓴 "Base directory for this skill" 만 증거로 본다(명령 출력 속 경로는 무시)', async () => {
  const { dir, v } = plugins()
  v('solo', 'solo', '1.0.0')
  await sleep(30)
  const started = Date.now()
  await sleep(30)
  v('solo', 'solo', '1.1.0')
  const t = join(dir, 't.jsonl')
  const at = new Date(started + 10).toISOString()
  const skill = (ver: string) => JSON.stringify({ type: 'user', isMeta: true, timestamp: at, message: { content: [{ type: 'text', text: `Base directory for this skill: ${dir}/cache/solo/solo/${ver}/skills/x` }] } })
  // A command's output printing the newer path is not what this process loaded.
  const output = JSON.stringify({ type: 'user', timestamp: at, message: { content: [{ type: 'tool_result', tool_use_id: 'u', content: `Base directory for this skill: ${dir}/cache/solo/solo/1.1.0/skills/x` }] } })
  writeFileSync(t, [skill('1.0.0'), output].join('\n') + '\n')
  assert.deepEqual(sessionPlugins({ pluginsDir: dir, user: 'alice', processStart: started, transcript: t }), [{ market: 'solo', version: '1.0.0', latest: '1.1.0' }])
})

test('브로커: 목록에 세션이 쓰는 플러그인 버전과 "새로고침하면"', async () => {
  const { setup, shim, until } = await import('./helpers.ts')
  const { dir, v } = plugins()
  v('cdt-skills', 'cdt-skills', '0.4.2')
  await sleep(30)
  const started = Date.now()
  await sleep(30)
  v('cdt-skills', 'cdt-skills', '0.5.0')
  const t = await setup({ pluginsDir: dir, githubUser: 'alice', processFacts: async () => ({ startedAt: started, shells: 0 }) })
  const s = await shim(t.socketPath, {})
  t.broker.webSessions()
  await until(() => !!t.broker.webSessions()[0]?.plugins, '버전을 알아낸다')
  assert.deepEqual(t.broker.webSessions()[0]!.plugins, [{ market: 'cdt-skills', version: '0.4.2', latest: '0.5.0' }])
  s.conn.close()
  t.close()
})

test('4-1 gh 가 로그인한 모든 호스트의 계정을 본다(사내 GHE 포함)', async () => {
  const { githubAccounts } = await import('../src/plugins.ts')
  const { chmodSync } = await import('node:fs')
  const dir = mkdtempSync(join(tmpdir(), 'gh-'))
  const gh = join(dir, 'gh')
  writeFileSync(gh, `#!/bin/sh\necho "github.com" >&2\necho "  ✓ Logged in to github.com account alice (keyring)" >&2\necho "github.example.com" >&2\necho "  ✓ Logged in to github.example.com account alice-ghe (keyring)" >&2\nexit 1\n`)
  chmodSync(gh, 0o755)
  assert.deepEqual(await githubAccounts(gh), ['alice', 'alice-ghe'])
  // A GHE marketplace (address path has the GHE account) counts as mine.
  writeFileSync(join(dir, 'known_marketplaces.json'), JSON.stringify({ 'example-market': { source: { source: 'git', url: 'https://github.example.com/alice-ghe/example-market.git' } } }))
  assert.deepEqual(userMarkets(dir, 'alice-ghe'), ['example-market'])
})

test('4-1 스킬 줄은 읽은 위치에서 이어 읽는다', async () => {
  const { SkillLineReader } = await import('../src/plugins.ts')
  const { appendFileSync } = await import('node:fs')
  const dir = mkdtempSync(join(tmpdir(), 'slr-'))
  const t = join(dir, 't.jsonl')
  const line = (v: string) => JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { content: [{ type: 'text', text: `Base directory for this skill: /x/cache/m/p/${v}/skills/a` }] } }) + '\n'
  writeFileSync(t, line('1.0.0'))
  const r = new SkillLineReader(t)
  assert.equal(r.read().get('m/p')!.version, '1.0.0')
  const offset = (r as unknown as { offset: number }).offset
  appendFileSync(t, line('1.1.0'))
  assert.equal(r.read().get('m/p')!.version, '1.1.0')
  assert.ok((r as unknown as { offset: number }).offset > offset)
})

// ---- 5. 커밋 단위 마켓
function commitWorld() {
  const dir = mkdtempSync(join(tmpdir(), 'plug-'))
  writeFileSync(join(dir, 'known_marketplaces.json'), JSON.stringify({ 'cdt-skills': { source: { repo: 'me/cdt-skills' } } }))
  const installed: Record<string, Array<{ version: string; installedAt: string; lastUpdated: string; installPath: string }>> = {}
  const cache = (plugin: string, version: string) => mkdirSync(join(dir, 'cache', 'cdt-skills', plugin, version), { recursive: true })
  const install = (plugin: string, version: string, at: number, first = at) => {
    installed[`${plugin}@cdt-skills`] = [{ version, installedAt: new Date(first).toISOString(), lastUpdated: new Date(at).toISOString(), installPath: join(dir, 'cache', 'cdt-skills', plugin, version) }]
    writeFileSync(join(dir, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: installed }))
  }
  return { dir, cache, install }
}

test('5 커밋 단위 마켓: 이 프로세스가 쓰는 커밋과 새로고침하면 받을 커밋을 짧은 id 로(캐시 폴더 순서가 아니라 installed_plugins 로)', async () => {
  const { dir, cache, install } = commitWorld()
  const t0 = Date.now()
  for (const p of ['lint-helper', 'add-cdt-skill', 'create-ticket']) cache(p, '6c0a647d6261'), install(p, '6c0a647d6261', t0)
  await sleep(30)
  for (const p of ['lint-helper', 'add-cdt-skill']) cache(p, '36c12d3aa001'), install(p, '36c12d3aa001', Date.now(), t0)
  await sleep(30)
  const started = Date.now()
  await sleep(30)
  // autoUpdate: new commit folders appear for everyone, but only some plugins are pointed at the newest.
  for (const p of ['lint-helper', 'add-cdt-skill', 'create-ticket']) cache(p, '7dfcd11bb002')
  await sleep(30)
  for (const p of ['lint-helper', 'add-cdt-skill', 'create-ticket']) cache(p, '93767a3cc003')
  for (const p of ['lint-helper', 'add-cdt-skill']) install(p, '93767a3cc003', Date.now(), t0)
  // create-ticket still points at 6c0a647d6261 in installed_plugins.json.
  assert.deepEqual(sessionPlugins({ pluginsDir: dir, user: 'me', processStart: started }), [{ market: 'cdt-skills', version: '36c12d3', latest: '93767a3' }])
  // A process started now runs what is installed.
  assert.deepEqual(sessionPlugins({ pluginsDir: dir, user: 'me', processStart: Date.now() + 1000 }), [{ market: 'cdt-skills', version: '93767a3' }])
})

test('5 쪼개지기 전에 뜬 세션은 그때의 번들 버전; 시작 후에 설치된 플러그인에 "가장 새 커밋"을 주지 않는다', async () => {
  const { dir, cache, install } = commitWorld()
  cache('cdt-skills', '0.4.2')
  install('cdt-skills', '0.4.2', Date.now())
  await sleep(30)
  const started = Date.now()
  await sleep(30)
  cache('lint-helper', '93767a3cc003')
  install('lint-helper', '93767a3cc003', Date.now())
  assert.deepEqual(sessionPlugins({ pluginsDir: dir, user: 'me', processStart: started }), [{ market: 'cdt-skills', version: '0.4.2', latest: '93767a3' }])
})

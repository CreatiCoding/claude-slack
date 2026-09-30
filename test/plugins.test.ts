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
    JSON.stringify({ 'cdt-skills': { source: { source: 'github', repo: 'CreatiCoding/cdt-skills' } }, official: { source: { source: 'github', repo: 'anthropics/official' } }, solo: { source: { source: 'git', url: 'git@github.com:creaticoding/solo.git' } } }),
  )
  const v = (market: string, plugin: string, version: string) => mkdirSync(join(dir, 'cache', market, plugin, version), { recursive: true })
  return { dir, v }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('내 계정 마켓만(주소 경로에 사용자명)', () => {
  const { dir } = plugins()
  assert.deepEqual(userMarkets(dir, 'creaticoding').sort(), ['cdt-skills', 'solo'])
})

test('세션이 쓰는 버전 = 프로세스 시작 전에 있던 가장 새 버전; 더 새 게 있으면 새로고침하면; 스킬별로 나뉜 마켓은 번들 이름·버전 한 줄', async () => {
  const { dir, v } = plugins()
  v('cdt-skills', 'cdt-skills', '0.4.2')
  v('cdt-skills', 'cdt-commit', '0.4.2')
  await sleep(30)
  const started = Date.now()
  await sleep(30)
  v('cdt-skills', 'cdt-commit', '0.5.0') // only a sub-plugin changed
  assert.deepEqual(sessionPlugins({ pluginsDir: dir, user: 'CreatiCoding', processStart: started }), [{ market: 'cdt-skills', version: '0.4.2', latest: '최신' }])
  v('cdt-skills', 'cdt-skills', '0.5.0')
  assert.deepEqual(sessionPlugins({ pluginsDir: dir, user: 'CreatiCoding', processStart: started }), [{ market: 'cdt-skills', version: '0.4.2', latest: '0.5.0' }])
  // A new process started after the update runs it: nothing to add.
  assert.deepEqual(sessionPlugins({ pluginsDir: dir, user: 'CreatiCoding', processStart: Date.now() + 1000 }), [{ market: 'cdt-skills', version: '0.5.0' }])
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
  assert.deepEqual(sessionPlugins({ pluginsDir: dir, user: 'creaticoding', processStart: started, transcript: t }), [{ market: 'solo', version: '1.0.0', latest: '1.1.0' }])
})

test('브로커: 목록에 세션이 쓰는 플러그인 버전과 "새로고침하면"', async () => {
  const { setup, shim, until } = await import('./helpers.ts')
  const { dir, v } = plugins()
  v('cdt-skills', 'cdt-skills', '0.4.2')
  await sleep(30)
  const started = Date.now()
  await sleep(30)
  v('cdt-skills', 'cdt-skills', '0.5.0')
  const t = await setup({ pluginsDir: dir, githubUser: 'CreatiCoding', processFacts: async () => ({ startedAt: started, shells: 0 }) })
  const s = await shim(t.socketPath, {})
  t.broker.webSessions()
  await until(() => !!t.broker.webSessions()[0]?.plugins, '버전을 알아낸다')
  assert.deepEqual(t.broker.webSessions()[0]!.plugins, [{ market: 'cdt-skills', version: '0.4.2', latest: '0.5.0' }])
  s.conn.close()
  t.close()
})

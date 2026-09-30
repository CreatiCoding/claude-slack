import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { availableSkills, skillMenu, SkillUsage } from '../src/skills.ts'

function world() {
  const home = mkdtempSync(join(tmpdir(), 'home-'))
  const claude = join(home, '.claude')
  const skill = (dir: string, name: string, desc = '') => {
    mkdirSync(join(dir, 'skills', name), { recursive: true })
    writeFileSync(join(dir, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n---\n본문`)
  }
  skill(claude, 'publish-report', '리포트를 올린다')
  mkdirSync(join(claude, 'commands', 'git'), { recursive: true })
  writeFileSync(join(claude, 'commands', 'git', 'pr.md'), '---\ndescription: PR\n---')
  const proj = join(home, 'projects', 'app')
  mkdirSync(proj, { recursive: true })
  skill(join(home, 'projects', '.claude'), 'team-rule')
  skill(join(proj, '.claude'), 'app-deploy')
  const plug = join(claude, 'plugins', 'cache', 'm', 'kit', '1.0.0')
  skill(plug, 'submit-commit')
  const off = join(claude, 'plugins', 'cache', 'm', 'off', '1.0.0')
  skill(off, 'hidden')
  mkdirSync(join(claude, 'plugins'), { recursive: true })
  writeFileSync(join(claude, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'kit@m': [{ installPath: plug }], 'off@m': [{ installPath: off }] } }))
  writeFileSync(join(claude, 'settings.json'), JSON.stringify({ enabledPlugins: { 'kit@m': true, 'off@m': false } }))
  return { home, claude, proj }
}

test('쓸 수 있는 스킬·명령: 사용자 것, 프로젝트 것(폴더와 위 폴더들), 켜진 플러그인 것', () => {
  const { home, claude, proj } = world()
  const names = availableSkills(proj, { home, claudeDir: claude }).map((s) => `${s.source}:${s.name}`).sort()
  assert.deepEqual(names, ['plugin:kit:submit-commit', 'project:app-deploy', 'project:team-rule', 'user:git:pr', 'user:publish-report'])
})

test('직접 부른 횟수: <command-name> 과 "바로 앞 내 메시지에 이름이 있는 Skill 호출"만, 나머지 Skill 은 자동; 이어서만 읽는다', async () => {
  const root = mkdtempSync(join(tmpdir(), 'usage-'))
  const projects = join(root, 'projects')
  mkdirSync(join(projects, 'p'), { recursive: true })
  const f = join(projects, 'p', 'a.jsonl')
  const user = (text: string, extra = {}) => JSON.stringify({ type: 'user', message: { content: text }, ...extra }) + '\n'
  const skill = (name: string) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name: 'Skill', input: { skill: name } }] } }) + '\n'
  writeFileSync(
    f,
    user('<command-name>/publish-report</command-name>') +
      user('리포트로 publish-report 써서 올려줘') +
      skill('publish-report') +
      user('아무 말') +
      user('<system-reminder>publish-report 는 스킬</system-reminder>') + // a reminder is not the person's words
      skill('publish-report') +
      user('스킬 본문 kit:submit-commit', { isMeta: true }) +
      skill('kit:submit-commit'),
  )
  const statePath = join(root, 'state.json')
  const u = new SkillUsage({ statePath, projectsDir: projects })
  await u.update()
  assert.deepEqual(u.counts(), { direct: { 'publish-report': 2 }, auto: { 'publish-report': 1, 'kit:submit-commit': 1 } })
  // Only what was added is read, and the count survives a restart.
  appendFileSync(f, user('submit-commit 해줘') + skill('kit:submit-commit'))
  const again = new SkillUsage({ statePath, projectsDir: projects })
  await again.update()
  assert.deepEqual(again.counts().direct, { 'publish-report': 2, 'kit:submit-commit': 1 })
  const menu = skillMenu(
    [
      { name: 'publish-report', kind: 'skill', source: 'user' },
      { name: 'kit:submit-commit', kind: 'skill', source: 'plugin' },
      { name: 'git:pr', kind: 'command', source: 'user' },
    ],
    again.counts(),
  )
  assert.deepEqual([menu.direct.map((s) => s.name), menu.auto.map((s) => s.name), menu.other.map((s) => s.name)], [['publish-report', 'kit:submit-commit'], [], ['git:pr']])
})

// ---- 코드 리뷰에서 나온 결함
import { readFileSync as readFile } from 'node:fs'

function usageWorld(lines: string) {
  const root = mkdtempSync(join(tmpdir(), 'usage-'))
  const projects = join(root, 'projects')
  mkdirSync(join(projects, 'p'), { recursive: true })
  const f = join(projects, 'p', 'a.jsonl')
  writeFileSync(f, lines)
  return { root, projects, f, statePath: join(root, 'state.json') }
}
const u = (text: string) => JSON.stringify({ type: 'user', message: { content: text } }) + '\n'
const sk = (name: string) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name: 'Skill', input: { skill: name } }] } }) + '\n'

test('4-2a 세는 규칙이 바뀌면(버전) 옛 집계를 버린다', async () => {
  const w = usageWorld('')
  writeFileSync(w.statePath, JSON.stringify({ files: {}, direct: { old: 99 }, auto: {} }))
  const s = new SkillUsage({ statePath: w.statePath, projectsDir: w.projects })
  await s.update()
  assert.deepEqual(s.counts().direct, {})
})

test('4-2b 내 메시지 글을 skill-usage.json 에 저장하지 않는다', async () => {
  const w = usageWorld(u('비밀스러운 내 메시지 publish-report 로 올려줘'))
  const s = new SkillUsage({ statePath: w.statePath, projectsDir: w.projects })
  await s.update()
  assert.ok(!readFile(w.statePath, 'utf8').includes('비밀스러운'), readFile(w.statePath, 'utf8').slice(0, 300))
  // What is kept still decides a Skill call written in a later read.
  appendFileSync(w.f, sk('publish-report'))
  const again = new SkillUsage({ statePath: w.statePath, projectsDir: w.projects })
  await again.update()
  assert.deepEqual(again.counts().direct, { 'publish-report': 1 })
})

test('4-2c 큰 대화 파일을 읽는 동안 브로커(이벤트 루프)를 오래 막지 않는다', async () => {
  const filler = u('x'.repeat(2000)).repeat(60_000) // ~120MB
  const w = usageWorld(filler + u('/x') + sk('publish-report'))
  const s = new SkillUsage({ statePath: w.statePath, projectsDir: w.projects })
  let worst = 0
  let last = Date.now()
  const timer = setInterval(() => {
    worst = Math.max(worst, Date.now() - last)
    last = Date.now()
  }, 10)
  await s.update()
  // The gap up to now counts too: a read that never yields leaves the timer silent the whole time.
  worst = Math.max(worst, Date.now() - last)
  clearInterval(timer)
  assert.ok(worst < 120, `가장 길게 막힌 시간 ${worst}ms`)
  assert.deepEqual(s.counts().auto, { 'publish-report': 1 })
})

test('4-2d user-invocable: false 스킬은 빼고, 4-2e 프로젝트 범위 플러그인은 그 폴더 세션에만', () => {
  const home = mkdtempSync(join(tmpdir(), 'home-'))
  const claude = join(home, '.claude')
  mkdirSync(join(claude, 'skills', 'hidden-helper'), { recursive: true })
  writeFileSync(join(claude, 'skills', 'hidden-helper', 'SKILL.md'), '---\nname: hidden-helper\nuser-invocable: false\n---')
  const proj = join(home, 'app')
  const other = join(home, 'other')
  mkdirSync(proj)
  mkdirSync(other)
  const plug = join(claude, 'plugins', 'cache', 'm', 'kit', '1.0.0')
  mkdirSync(join(plug, 'skills', 'deploy'), { recursive: true })
  writeFileSync(join(plug, 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\n---')
  writeFileSync(join(claude, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'kit@m': [{ scope: 'project', projectPath: proj, installPath: plug }] } }))
  const names = (cwd: string) => availableSkills(cwd, { home, claudeDir: claude }).map((s) => s.name)
  assert.deepEqual(names(proj), ['kit:deploy'])
  assert.deepEqual(names(other), [])
})

test('4-2f 스킬 이름은 낱말 경계로, 4자 이하 이름은 /이름 입력만 직접 부른 것', async () => {
  const w = usageWorld(u('reporting 좀 봐줘') + sk('report') + u('run tests please') + sk('run') + u('<command-name>/run</command-name>') + u('publish-report 로 해') + sk('publish-report'))
  const s = new SkillUsage({ statePath: w.statePath, projectsDir: w.projects })
  await s.update()
  assert.deepEqual(s.counts().direct, { run: 1, 'publish-report': 1 })
  assert.deepEqual(s.counts().auto, { report: 1, run: 1 })
})

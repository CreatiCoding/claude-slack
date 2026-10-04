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

test('3 조각 경계에 걸린 한글 때문에 읽은 위치가 파일 크기를 넘지 않고, 파일이 그대로면 횟수도 그대로', async () => {
  const MB = 1024 * 1024
  // A line whose "한" (3 bytes) straddles the 1MB piece boundary.
  const head = JSON.stringify({ type: 'user', message: { content: '' } })
  const pad = MB - 1 - (head.length - 2) - 2 // leaves the 3-byte character starting one byte before the boundary
  const line1 = JSON.stringify({ type: 'user', message: { content: 'x'.repeat(pad) + '한글' } }) + '\n'
  const w = usageWorld(line1 + u('<command-name>/publish-report</command-name>'))
  const { statSync } = await import('node:fs')
  const s = new SkillUsage({ statePath: w.statePath, projectsDir: w.projects })
  await s.update()
  assert.deepEqual(s.counts().direct, { 'publish-report': 1 })
  const state = JSON.parse(readFile(w.statePath, 'utf8')) as { files: Record<string, { offset: number }> }
  assert.equal(state.files[w.f]!.offset, statSync(w.f).size, '읽은 위치 = 파일 크기')
  const again = new SkillUsage({ statePath: w.statePath, projectsDir: w.projects })
  await again.update()
  assert.deepEqual(again.counts().direct, { 'publish-report': 1 }, '파일이 그대로면 다시 세지 않는다')
})

test('7-1 스킬 이름 뒤 경계는 ASCII 로만: "tap-review로 봐줘", "dove-log-analysis 스킬로"를 알아본다', async () => {
  const w = usageWorld(u('tap-review로 봐줘') + sk('tap-review') + u('dove-log-analysis 스킬로 분석') + sk('kit:dove-log-analysis'))
  const s = new SkillUsage({ statePath: w.statePath, projectsDir: w.projects })
  await s.update()
  assert.deepEqual(s.counts().direct, { 'tap-review': 1, 'kit:dove-log-analysis': 1 })
})

test('7-2 프로젝트 범위 플러그인: 세션 폴더와 위 폴더들의 .claude/settings(.local).json 의 enabledPlugins 도 읽고, 가까운 폴더가 끄면 끈 것', () => {
  const home = mkdtempSync(join(tmpdir(), 'home-'))
  const claude = join(home, '.claude')
  const work = join(home, 'work')
  const app = join(work, 'app')
  mkdirSync(join(app, '.claude'), { recursive: true })
  mkdirSync(join(work, '.claude'), { recursive: true })
  const plug = (name: string) => {
    const p = join(claude, 'plugins', 'cache', 'm', name, '1.0.0')
    mkdirSync(join(p, 'skills', name + '-skill'), { recursive: true })
    writeFileSync(join(p, 'skills', name + '-skill', 'SKILL.md'), '---\nname: x\n---')
    return p
  }
  writeFileSync(join(claude, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'slack@m': [{ scope: 'project', projectPath: work, installPath: plug('slack') }], 'chapter@m': [{ scope: 'project', projectPath: app, installPath: plug('chapter') }], 'user-kit@m': [{ scope: 'user', installPath: plug('user-kit') }] } }))
  writeFileSync(join(claude, 'settings.json'), JSON.stringify({ enabledPlugins: { 'user-kit@m': true } }))
  writeFileSync(join(work, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'slack@m': true, 'user-kit@m': true } }))
  writeFileSync(join(app, '.claude', 'settings.local.json'), JSON.stringify({ enabledPlugins: { 'chapter@m': true, 'user-kit@m': false } }))
  const names = (cwd: string) => availableSkills(cwd, { home, claudeDir: claude }).filter((s) => s.source === 'plugin').map((s) => s.name).sort()
  assert.deepEqual(names(app), ['chapter:chapter-skill', 'slack:slack-skill'], '가까운 app 이 user-kit 을 끈다')
  assert.deepEqual(names(work), ['slack:slack-skill', 'user-kit:user-kit-skill'])
})

test('스킬 설명(78): 여러 줄 description(> 또는 |)은 들여쓴 줄을 이어 읽는다', async () => {
  const { availableSkills } = await import('../src/skills.ts')
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = mkdtempSync(join(tmpdir(), 'skills78-'))
  const dir = join(root, '.claude', 'skills', 'folded')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), '---\nname: folded\ndescription: >\n  첫 줄\n  둘째 줄\n---\n본문\n')
  const found = availableSkills(root, { home: root, claudeDir: join(root, '.claude') }).find((x) => x.name === 'folded')
  assert.equal(found?.description, '첫 줄 둘째 줄')
})

test('플러그인 스킬(78): 맨 위 SKILL.md 는 플러그인 이름으로, plugin.json 의 skills 경로도 읽는다', async () => {
  const { availableSkills } = await import('../src/skills.ts')
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = mkdtempSync(join(tmpdir(), 'plugin78-'))
  const claude = join(root, '.claude')
  const install = join(root, 'cache', 'mkt', 'tool', '1.0')
  mkdirSync(join(install, '.claude-plugin'), { recursive: true })
  writeFileSync(join(install, 'SKILL.md'), '---\nname: tool\ndescription: 도구\n---\n')
  mkdirSync(join(install, 'extra', 'deep'), { recursive: true })
  writeFileSync(join(install, 'extra', 'deep', 'SKILL.md'), '---\nname: deep\n---\n')
  writeFileSync(join(install, '.claude-plugin', 'plugin.json'), JSON.stringify({ skills: ['extra'] }))
  mkdirSync(join(claude, 'plugins'), { recursive: true })
  writeFileSync(join(claude, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'tool@mkt': [{ installPath: install, scope: 'user' }] } }))
  writeFileSync(join(claude, 'settings.json'), JSON.stringify({ enabledPlugins: { 'tool@mkt': true } }))
  const names = availableSkills(root, { home: root, claudeDir: claude }).map((x) => x.name)
  assert.ok(names.includes('tool:tool'), names.join(',')) // the skill's own name, not the version folder 1.0 (78)
  assert.ok(!names.includes('tool:1.0'), names.join(','))
  assert.ok(names.includes('tool:deep'), names.join(','))
})

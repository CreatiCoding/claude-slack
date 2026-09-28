import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyOption, detectKnown, DialogDriver, isProceedDialog, parseDialog, parseKeyedDialog } from '../src/dialog.ts'

const TRUST = `
 Accessing workspace:

 /private/tmp/cs-smoke

 Quick safety check: Is this a project you created or one you trust?

 Claude Code'll be able to read, edit, and execute files here.

 Security guide

 ❯ No, exit
   Yes, I trust this folder

 Enter to confirm · Esc to cancel
`

test('detectDialog moves the cursor from "No, exit" to the trust option', () => {
  assert.deepEqual(detectKnown(TRUST), { name: 'folder-trust', moves: 1 })
})

test('detectDialog handles the dev-channels warning with the option already selected', () => {
  const screen = `
 Development channels warning
 ...
 ❯ I am using this for local development
   Exit
`
  assert.deepEqual(detectKnown(screen), { name: 'dev-channels', moves: 0 })
  const flipped = `
 ❯ Exit
   I am using this for local development
`
  assert.deepEqual(detectKnown(flipped), { name: 'dev-channels', moves: 1 })
})

test('detectDialog ignores a normal prompt screen', () => {
  assert.equal(detectKnown('╭──╮\n│ > │\n╰──╯\n'), null)
})

const MODEL_SWITCH = `
⏺ 안녕하세요! 무엇을 도와드릴까요?
▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔
   Switch model?
   Your next response will be slower and use more tokens
   This conversation is cached for the current model. Switching to Sonnet 5 means the full history gets re-read on your next message.
   ❯ 1. Yes, switch to Sonnet 5
     2. No, go back
`

test('detectDialog confirms the mid-conversation model switch prompt', () => {
  assert.deepEqual(detectKnown(MODEL_SWITCH), { name: 'model-switch', moves: 0 })
})

const UNKNOWN_DIALOG = `
⏺ 작업을 진행합니다
────────────────────────────────────────
   Restart required
   The new setting takes effect after a restart.
   ❯ 1. Restart now
     2. Later
     3. Cancel

  Enter to confirm · Esc to cancel
`

const PROMPT_WITH_TEXT = `
⏺ 답변입니다
────────────────────────────────────────
❯ QuantBench로 할게
────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle)
`

test('parseOptionsDialog reads any numbered dialog, question and cursor included', () => {
  const d = parseDialog(UNKNOWN_DIALOG)!
  assert.equal(d.question, 'Restart required')
  assert.equal(d.description, 'The new setting takes effect after a restart.')
  assert.deepEqual(d.options.map((o: { label: string }) => o.label), ['Restart now', 'Later', 'Cancel'])
  assert.equal(d.selected, 0)
  assert.equal(parseDialog(MODEL_SWITCH)!.question, 'Switch model?')
})

test('parseOptionsDialog ignores the prompt line and known unnumbered dialogs', () => {
  assert.equal(parseDialog(PROMPT_WITH_TEXT), null)
  assert.equal(parseDialog(TRUST), null)
})

test('classifyOption puts "don\'t ask again" on the allow side, not the deny side', () => {
  // The leading word reads like a refusal but this is the broadest allow there is.
  assert.equal(classifyOption("Don't ask again for Bash"), 'allow-always')
  assert.equal(classifyOption('Yes, allow reading from /Users/me from this project'), 'allow-always')
  assert.equal(classifyOption('Yes'), 'allow-once')
  assert.equal(classifyOption('No, and tell Claude what to do differently'), 'deny')
  assert.equal(classifyOption('Use TypeScript'), 'other')
})

test('isProceedDialog accepts a permission gate and rejects a plain question', () => {
  const gate = parseDialog(' Do you want to proceed?\n ❯ 1. Yes\n   2. No\n')!
  assert.equal(isProceedDialog(gate), true)
  const question = parseDialog(' 어느 쪽으로 갈까요?\n ❯ 1. A안\n   2. B안\n')!
  assert.equal(isProceedDialog(question), false)
})

test('confirmKnown 은 다이얼로그가 없으면 Enter 를 보내지 않는다', async () => {
  const keys: string[][] = []
  const fake = {
    async capture() {
      return ''
    },
    async sendKeys(_p: string, k: string[]) {
      keys.push(k)
    },
    async launch() {
      return { window: '@1', pane: '%1' }
    },
    async typeLine() {},
    async pasteLine() {},
    async captureAnsi() { return '' },
    async growHeight() { return false },
    async killPane() {},
    async hasPane() {
      return true
    },
  }
  const { DialogDriver } = await import('../src/dialog.ts')
  const d = new DialogDriver(fake)

  // 화면에 그 문구가 있지만 다이얼로그가 아니라 그냥 글일 때.
  const prose = '⏺ 대화 중에 Switch model? 창이 뜨면 캐시가 날아갑니다.\n❯ \n'
  assert.equal(await d.confirmKnown('%1', prose), null)
  assert.deepEqual(keys, [], '프롬프트에 Enter 를 치면 빈 메시지가 전송된다')

  // 진짜 다이얼로그면 넘긴다.
  const real = ' Switch model?\n ❯ 1. Yes, switch to Sonnet 5\n   2. No, go back\n'
  assert.equal(await d.confirmKnown('%1', real), 'model-switch')
  assert.deepEqual(keys, [['Enter']])
})

// Claude Code prints an explanation under each option, so the numbered lines are
// not adjacent. This is the real screen that went unrecognized in production.
const SPACED_OPTIONS = `←  ☐ 규칙 충돌  ☐ 진입 방식  ✔ Submit  →
│ 규칙 여러 개가 동시에 맞을 때 어떻게 할까요?

❯ 1. 먼저 쓴 규칙이 이긴다 (추천)
     위에서부터 확인하다가 처음 맞는 규칙 하나만 실행합니다.
  2. 맞는 것을 전부 실행한다
     순서대로 다 적용합니다. 유연하지만 결과 예측이 어렵습니다.
  3. 가장 많이 파는 규칙이 이긴다
     여러 개가 맞으면 그중 행동이 가장 큰 것을 실행합니다.
  4. Type something.
  5. Chat about this

Enter to select · Tab/Arrow keys to navigate · Esc to cancel`

test('parseKeyedDialog 는 번호 없는 체크박스 창을 읽는다 (세션이 여기서 멈춰 있었다)', () => {
  const screen = [
    '  Teach auto mode about your environment?',
    '  Claude Code reads this project, your recent Claude sessions, and optionally your',
    '  shell history and other repositories.',
    '    How you use Claude here    ◀ Mixed ▶',
    '  ❯ Also scan shell history   [ ]',
    '    Also scan your other repos [ ]',
    '    Continue',
    '  ←/→ to change usage · Enter to continue · Esc to cancel',
  ].join('\n')
  const d = parseKeyedDialog(screen)
  assert.ok(d, '창을 알아본다')
  assert.equal(d!.question, 'Teach auto mode about your environment?')
  assert.match(d!.footer, /Enter to continue/)
  assert.match(d!.body!, /Also scan shell history/)
  // 번호가 없으니 기존 파서는 그대로 비켜 간다.
  assert.equal(parseDialog(screen), null)
})

test('parseKeyedDialog 는 돌아가는 화면을 창으로 착각하지 않는다', () => {
  // 상태줄에도 esc 가 있지만 Enter 힌트가 없다. 이걸 창으로 보면 멀쩡한 세션이 멈춘 것처럼 보인다.
  const running = ['  ▶▶ auto mode on (shift+tab to cycle) · esc to interrupt · ← for agents', '', '❯ ', ''].join('\n')
  assert.equal(parseKeyedDialog(running), null)
  // 빈 프롬프트만 있는 화면도 아니다.
  assert.equal(parseKeyedDialog('❯ \n'), null)
  // 번호 있는 창은 기존 파서 몫이므로 여기서 가로채지 않는다… 만 Enter 힌트가 없으면 애초에 안 걸린다.
  assert.equal(parseKeyedDialog(['  Do you want to proceed?', '  ❯ 1. Yes', '    2. No'].join('\n')), null)
})

const MCP_CONSENT = [
  '────────────────────────────',
  '  New MCP server found in this project: alphabench',
  '',
  '  MCP servers may execute code or access system resources.',
  '',
  '    Use this MCP server',
  '    Use this and all future MCP servers in this project',
  '  ❯ Continue without using this MCP server',
  '',
  '  Enter to confirm · Esc to cancel',
].join('\n')

test('confirmKnown 은 번호 없는 아는 창도 넘긴다 (세션이 여기서 붙지 못했다)', async () => {
  const keys: string[][] = []
  const fake = {
    async capture() {
      return MCP_CONSENT
    },
    async sendKeys(_p: string, k: string[]) {
      keys.push(k)
    },
    async launch() {
      return { window: '@1', pane: '%1' }
    },
    async typeLine() {},
    async pasteLine() {},
    async captureAnsi() { return '' },
    async growHeight() { return false },
    async killPane() {},
    async hasPane() {
      return true
    },
  }
  const { DialogDriver } = await import('../src/dialog.ts')
  const d = new DialogDriver(fake)

  // 번호가 없어 예전에는 parseDialog 가 막아 아무것도 안 했다. 그래서 세션이 시작조차 못 했다.
  assert.equal(parseDialog(MCP_CONSENT), null, '번호가 없는 창이 맞다')
  assert.equal(await d.confirmKnown('%1', MCP_CONSENT), 'mcp-consent')
  assert.deepEqual(keys, [['Up', 'Up', 'Enter']], '커서를 올려 승인 선택지에 놓고 확인한다')

  // 글일 뿐인 화면에는 여전히 손대지 않는다.
  keys.length = 0
  const prose = '⏺ Use this MCP server 라는 문구가 뜨면 알려주세요.\n❯ \n'
  assert.equal(await d.confirmKnown('%1', prose), null)
  assert.deepEqual(keys, [], '프롬프트에 Enter 를 치면 빈 메시지가 전송된다')
})

test('parseDialog 는 설명이 끼어 있어도 선택지를 모두 읽는다', () => {
  const d = parseDialog(SPACED_OPTIONS)!
  assert.ok(d, '설명 줄 때문에 인식에 실패하면 안 된다')
  assert.deepEqual(
    d.options.map((o) => o.n),
    [1, 2, 3, 4, 5],
    '다섯 개를 모두 읽는다',
  )
  assert.match(d.question, /규칙 여러 개가 동시에 맞을 때/)
  assert.match(d.options[0]!.description!, /위에서부터 확인하다가/, '설명도 함께 읽는다')
  assert.equal(d.options[4]!.label, 'Chat about this')
  assert.equal(d.selected, 0)
})

test('parseDialog 는 번호가 이어지지 않으면 다른 목록으로 본다', () => {
  // 본문에 있는 번호 매김이 선택지로 오인되면 안 된다.
  const mixed = '설명 1. 첫째\n\n\n\n\n\n\n\n❯ 1. 진짜 선택\n  2. 다른 선택\n'
  const d = parseDialog(mixed)!
  assert.deepEqual(
    d.options.map((o) => o.label),
    ['진짜 선택', '다른 선택'],
  )
})

test('프롬프트가 키 입력을 쥐고 있으면 숫자를 누르지 않는다 (백그라운드 에이전트의 권한 창)', async () => {
  const { DialogDriver, promptHoldsFocus } = await import('../src/dialog.ts')
  const dialog = ' Do you want to allow Claude to fetch this content?\n ❯ 1. Yes\n   2. Yes, and don\'t ask again for macops.ca\n   3. No, and tell Claude what to do differently (esc)\n'
  const withPrompt = dialog + '\n❯ \n  ctrl+x ctrl+s to send now\n'
  assert.equal(promptHoldsFocus(dialog), false)
  assert.equal(promptHoldsFocus(withPrompt), true)
  assert.equal(promptHoldsFocus('⏺ 끝났습니다\n❯ \n'), false, '다이얼로그가 없으면 해당 없음')

  const keys: string[][] = []
  let screen = withPrompt
  const fake = {
    async capture() {
      return screen
    },
    async sendKeys(_p: string, k: string[]) {
      keys.push(k)
    },
    async launch() {
      return { window: '@1', pane: '%1' }
    },
    async typeLine() {},
    async pasteLine() {},
    async captureAnsi() { return '' },
    async growHeight() { return false },
    async killPane() {},
    async hasPane() {
      return true
    },
  }
  const d = new DialogDriver(fake)
  assert.equal(await d.answerProceed('%1', 'allow'), 'unfocused')
  assert.equal(await d.answerNumber('%1', '1'), 'unfocused')
  assert.deepEqual(keys, [], '"1" 이 프롬프트에 타이핑돼 메시지로 전송되면 안 된다')

  // 입력칸이 없으면 평소대로 누른다.
  screen = dialog
  assert.equal(await d.answerProceed('%1', 'allow'), 'answered')
  assert.deepEqual(keys, [['1'], ['Enter']])
})

test('confirmKnown 은 Chrome 확장 감지 창을 브라우저 끔으로 넘긴다 (QA 스윕에서 세션이 여기 멈춰 있었다)', async () => {
  const screen = [
    '  Claude in Chrome extension detected',
    '  Claude will use your Chrome browser by default — navigating sites, filling forms, and capturing screenshots in your existing session.',
    '  ❯ No, keep browser tools off',
    '    Yes, use my browser',
    '  Enter to confirm · Esc to keep browser tools off',
  ].join('\n')
  const keys: string[] = []
  const driver = new DialogDriver({ capture: async () => screen, sendKeys: async (_p: string, k: string[]) => void keys.push(...k) } as never)
  assert.equal(await driver.confirmKnown('%1', screen), 'chrome-extension')
  assert.deepEqual(keys, ['Enter'], '커서가 이미 "끔" 에 있으니 Enter 만')
})

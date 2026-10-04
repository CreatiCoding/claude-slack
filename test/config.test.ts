import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig, validateEnv } from '../src/config.ts'

const BASE_ENV = { SLACK_BOT_TOKEN: 'xoxb-1', SLACK_APP_TOKEN: 'xapp-1', SLACK_CHANNEL_ID: 'C1', SLACK_ALLOWED_USERS: 'U1' }

test('validateEnv: 모르는 CLAUDE_SLACK_* 키는 기동을 막는다', () => {
  assert.throws(() => validateEnv({ CLAUDE_SLACK_WEB_PROT: '1234' }), /unknown env var\(s\): CLAUDE_SLACK_WEB_PROT/)
})

test('validateEnv: 숫자가 아닌 포트는 기동을 막는다', () => {
  assert.throws(() => validateEnv({ CLAUDE_SLACK_WEB_PORT: 'abc' }), /CLAUDE_SLACK_WEB_PORT/)
})

test('validateEnv: 알려진 값, 알려지지 않은 CLAUDE_SLACK_* 가 없으면 그냥 지나간다. CLAUDE_* 가 아닌 다른 env(PATH 등)는 안 본다', () => {
  assert.doesNotThrow(() => validateEnv({ CLAUDE_SLACK_WEB_PORT: '4180', CLAUDE_SLACK_LOG_LEVEL: 'DEBUG', PATH: '/usr/bin', HOME: '/root' }))
})

test('loadConfig: 잘못된 CLAUDE_SLACK_* env 가 있으면 토큰이 다 있어도 던진다', () => {
  assert.throws(() => loadConfig({ ...BASE_ENV, CLAUDE_SLACK_WEB_PORT: 'nope' }), /CLAUDE_SLACK_WEB_PORT/)
})

test('validateEnv: 운영 배포 스크립트가 쓰는 값들(QA 채널, dokploy 프록시)은 모른다고 막지 않는다', () => {
  assert.doesNotThrow(() =>
    validateEnv({
      CLAUDE_SLACK_QA_CHANNEL: 'C1',
      CLAUDE_SLACK_PROXY_TARGET: 'http://x:4180',
      CLAUDE_SLACK_DOKPLOY_APP_ID: 'a',
      CLAUDE_SLACK_DOKPLOY_APP_NAME: 'b',
      CLAUDE_SLACK_DOKPLOY_ORG_ID: 'c',
    }),
  )
})

test('loadConfig: 여러 문제가 있으면 한 번에 모두 알려준다', () => {
  assert.throws(() => loadConfig({ ...BASE_ENV, CLAUDE_SLACK_WEB_PORT: 'nope', CLAUDE_SLACK_TYPO: '1' }), /CLAUDE_SLACK_WEB_PORT[\s\S]*CLAUDE_SLACK_TYPO|CLAUDE_SLACK_TYPO[\s\S]*CLAUDE_SLACK_WEB_PORT/)
})

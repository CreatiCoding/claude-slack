import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export interface Config {
  botToken: string
  appToken: string
  /** Optional xoxp- token; enables deleting the user's own messages on purge. */
  userToken?: string
  channelId: string
  allowedUsers: Set<string>
  defaultCwd: string
  launcher: string
  /** Admin page. Loopback by default; binding elsewhere requires a token. */
  web: { host: string; port: number; token?: string; enabled: boolean; tlsCert?: string; tlsKey?: string }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_CHANNEL_ID', 'SLACK_ALLOWED_USERS'].filter((k) => !env[k])
  if (missing.length) {
    throw new Error(
      `Missing env: ${missing.join(', ')}. Copy .env.example to .env and fill it in. ` +
        `SLACK_ALLOWED_USERS gates who may talk to your sessions and approve tool calls, so it is required.`,
    )
  }
  return {
    botToken: env.SLACK_BOT_TOKEN!,
    appToken: env.SLACK_APP_TOKEN!,
    userToken: env.SLACK_USER_TOKEN || undefined,
    channelId: env.SLACK_CHANNEL_ID!,
    allowedUsers: new Set(
      env.SLACK_ALLOWED_USERS!.split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
    defaultCwd: env.CLAUDE_SLACK_DEFAULT_CWD ? resolve(env.CLAUDE_SLACK_DEFAULT_CWD.replace(/^~/, homedir())) : homedir(),
    launcher: env.CLAUDE_SLACK_LAUNCHER ?? resolve(REPO_ROOT, 'bin', 'claude-slack'),
    web: {
      enabled: env.CLAUDE_SLACK_WEB !== '0',
      host: env.CLAUDE_SLACK_WEB_HOST ?? '127.0.0.1',
      port: Number(env.CLAUDE_SLACK_WEB_PORT ?? 4180),
      token: env.CLAUDE_SLACK_WEB_TOKEN || undefined,
      tlsCert: env.CLAUDE_SLACK_WEB_TLS_CERT || undefined,
      tlsKey: env.CLAUDE_SLACK_WEB_TLS_KEY || undefined,
    },
  }
}

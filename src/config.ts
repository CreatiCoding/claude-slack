import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Every `CLAUDE_SLACK_*` env var this codebase reads, in one place (P4-33). `process.env` carries a lot
 * that is not ours (`PATH`, `HOME`, a Claude Code session's own `CLAUDE_*` vars before `index.ts` strips
 * them) — only keys starting with `CLAUDE_SLACK_` are checked here, and `.strict()` means a typo in one
 * (`CLAUDE_SLACK_WEB_PROT`) fails loudly at boot instead of silently doing nothing.
 */
const numeric = (name: string) => z.string().regex(/^\d+$/, `${name} must be a number`).optional()
const CLAUDE_SLACK_ENV_SCHEMA = z
  .object({
    CLAUDE_SLACK_DEFAULT_CWD: z.string().optional(),
    CLAUDE_SLACK_LAUNCHER: z.string().optional(),
    CLAUDE_SLACK_WEB: z.string().optional(),
    CLAUDE_SLACK_WEB_HOST: z.string().optional(),
    CLAUDE_SLACK_WEB_PORT: numeric('CLAUDE_SLACK_WEB_PORT'),
    CLAUDE_SLACK_WEB_TOKEN: z.string().optional(),
    CLAUDE_SLACK_WEB_TLS_CERT: z.string().optional(),
    CLAUDE_SLACK_WEB_TLS_KEY: z.string().optional(),
    CLAUDE_SLACK_WEB_PUBLIC_URL: z.string().optional(),
    CLAUDE_SLACK_WEB_DOMAIN: z.string().optional(),
    CLAUDE_SLACK_ARCHIVE_DIR: z.string().optional(),
    CLAUDE_SLACK_DAEMON: z.string().optional(),
    CLAUDE_SLACK_DEFAULT_PROMPT: z.string().optional(),
    CLAUDE_SLACK_EVENTS_DIR: z.string().optional(),
    CLAUDE_SLACK_GROUPS: z.string().optional(),
    CLAUDE_SLACK_IMAGES_DIR: z.string().optional(),
    CLAUDE_SLACK_LINKS: z.string().optional(),
    CLAUDE_SLACK_LOG: z.string().optional(),
    CLAUDE_SLACK_LOG_DIR: z.string().optional(),
    CLAUDE_SLACK_LOG_LEVEL: z.enum(['DEBUG', 'INFO', 'WARN', 'ERROR']).optional(),
    CLAUDE_SLACK_NO_CHANNEL: z.string().optional(),
    CLAUDE_SLACK_OFFSETS: z.string().optional(),
    CLAUDE_SLACK_PENDING_PURGES: z.string().optional(),
    CLAUDE_SLACK_PINS: z.string().optional(),
    CLAUDE_SLACK_REVIVE: z.string().optional(),
    CLAUDE_SLACK_SCREEN_COLS: numeric('CLAUDE_SLACK_SCREEN_COLS'),
    CLAUDE_SLACK_SESSION: z.string().optional(),
    CLAUDE_SLACK_SOCKET: z.string().optional(),
    CLAUDE_SLACK_STATUS_DIR: z.string().optional(),
    CLAUDE_SLACK_THREAD_TS: z.string().optional(),
    CLAUDE_SLACK_TITLES: z.string().optional(),
    CLAUDE_SLACK_TMUX_ROWS: numeric('CLAUDE_SLACK_TMUX_ROWS'),
    CLAUDE_SLACK_TMUX_SESSION: z.string().optional(),
    CLAUDE_SLACK_WEB_IMAGES_DIR: z.string().optional(),
    CLAUDE_SLACK_DEBUG: z.string().optional(),
    CLAUDE_SLACK_NO_CHROME: z.string().optional(),
    // 배포 스크립트(scripts/dokploy-*.ts, scripts/qa-sweep.ts)가 쓰는, 브로커 자신은 읽지 않는 값들.
    // 이 셋이 없으면 프로덕션 .env 에 있는 한 운영 전용 값만으로도 부팅이 막혔다(실제로 겪음).
    CLAUDE_SLACK_QA_CHANNEL: z.string().optional(),
    CLAUDE_SLACK_PROXY_TARGET: z.string().optional(),
    CLAUDE_SLACK_DOKPLOY_APP_ID: z.string().optional(),
    CLAUDE_SLACK_DOKPLOY_APP_NAME: z.string().optional(),
    CLAUDE_SLACK_DOKPLOY_ORG_ID: z.string().optional(),
  })
  .strict()

/** Throws with every problem found (not just the first) — a typo'd key and a bad port show up together. */
export function validateEnv(env: NodeJS.ProcessEnv = process.env): void {
  const ours = Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith('CLAUDE_SLACK_')))
  const result = CLAUDE_SLACK_ENV_SCHEMA.safeParse(ours)
  if (result.success) return
  const problems = result.error.issues.map((i) => (i.code === 'unrecognized_keys' ? `unknown env var(s): ${i.keys.join(', ')}` : `${i.path.join('.')}: ${i.message}`))
  throw new Error(`Invalid CLAUDE_SLACK_* env:\n  ${problems.join('\n  ')}`)
}

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
  web: { host: string; port: number; token?: string; enabled: boolean; tlsCert?: string; tlsKey?: string; publicUrl?: string }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  validateEnv(env)
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
      // The address a phone opens (for the QR): explicit, or the domain the certificate is for.
      publicUrl: env.CLAUDE_SLACK_WEB_PUBLIC_URL || (env.CLAUDE_SLACK_WEB_DOMAIN ? `https://${env.CLAUDE_SLACK_WEB_DOMAIN}` : undefined),
    },
  }
}

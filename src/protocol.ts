import { homedir } from 'node:os'
import { join } from 'node:path'

/** Raw hook payload as Claude Code writes it to the hook's stdin. */
export type HookEvent = {
  hook_event_name: string
  session_id: string
  cwd: string
  transcript_path?: string
  [k: string]: unknown
}

/** Messages the channel shim or a hook sends to the broker. */
export type ToBroker =
  | {
      type: 'hello'
      role: 'channel'
      /** CLAUDE_SLACK_SESSION from the launcher; falls back to the pid as a string. */
      key: string
      pid: number
      sessionId: string
      cwd: string
      threadTs?: string
      tmuxPane?: string
    }
  /** `files` are absolute paths on this machine; the broker uploads them into the thread. `notify` asks for an @-mention. */
  | { type: 'reply'; text: string; files?: string[]; notify?: boolean }
  | {
      type: 'permission_request'
      requestId: string
      toolName: string
      description: string
      inputPreview: string
    }
  | { type: 'hook'; key: string; pid: number; event: HookEvent }

/** Messages the broker sends to a channel shim. */
export type ToChannel =
  | { type: 'hello_ack'; threadTs: string }
  | { type: 'inbound'; text: string; user: string; ts: string }
  | { type: 'permission'; requestId: string; behavior: 'allow' | 'deny' }
  /** Sent instead of `hello_ack`: another, still-live process already owns this run; this one should not reconnect. */
  | { type: 'bye'; reason: string }

export const SOCKET_PATH = process.env.CLAUDE_SLACK_SOCKET ?? join(homedir(), '.claude-slack.sock')

/** Session key shared by the shim and hooks: the launcher's UUID, else the pid. */
export function sessionKey(pid: number, env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_SLACK_SESSION || String(pid)
}

/**
 * Registers the claude-slack hooks in ~/.claude/settings.json and writes
 * mcp.json for the launcher. `--remove` undoes both.
 */
import { stableNodePath } from '../src/node-path.ts'
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { REPO_ROOT } from '../src/config.ts'

const remove = process.argv.includes('--remove')
const settingsPath = process.env.CLAUDE_SETTINGS_PATH ?? join(homedir(), '.claude', 'settings.json')
const hookScript = resolve(REPO_ROOT, 'hooks', 'notify.ts')
const channelScript = resolve(REPO_ROOT, 'src', 'channel.ts')
const mcpJsonPath = resolve(REPO_ROOT, 'mcp.json')
const MARK = 'claude-slack/hooks/notify.ts'

const EVENTS: Array<{ name: string; async?: boolean; matcher?: string }> = [
  { name: 'SessionStart' },
  { name: 'UserPromptSubmit' },
  { name: 'PreToolUse', matcher: 'AskUserQuestion|ExitPlanMode' },
  { name: 'PostToolUse', async: true },
  { name: 'PostToolUseFailure', async: true },
  { name: 'Stop' },
  { name: 'Notification' },
  { name: 'SessionEnd' },
]

type HookEntry = { matcher?: string; hooks: Array<Record<string, unknown>> }
type Settings = { hooks?: Record<string, HookEntry[]>; [k: string]: unknown }

const settings: Settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {}
settings.hooks ??= {}

// Strip any previous claude-slack entries first so the install is idempotent.
for (const [event, entries] of Object.entries(settings.hooks)) {
  const kept = entries
    .map((e) => ({ ...e, hooks: e.hooks.filter((h) => !String(h.command ?? '').includes(MARK)) }))
    .filter((e) => e.hooks.length > 0)
  if (kept.length) settings.hooks[event] = kept
  else delete settings.hooks[event]
}

if (!remove) {
  for (const { name, async, matcher } of EVENTS) {
    settings.hooks[name] ??= []
    settings.hooks[name].push({
      ...(matcher ? { matcher } : {}),
      hooks: [
        {
          type: 'command',
          command: `${JSON.stringify(stableNodePath())} ${JSON.stringify(hookScript)}`,
          timeout: 5,
          ...(async ? { async: true } : {}),
        },
      ],
    })
  }
  writeFileSync(
    mcpJsonPath,
    JSON.stringify({ mcpServers: { slack: { command: stableNodePath(), args: [channelScript] } } }, null, 2) + '\n',
  )
}
if (Object.keys(settings.hooks).length === 0) delete settings.hooks
writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n')

if (remove) {
  if (existsSync(mcpJsonPath)) unlinkSync(mcpJsonPath)
  console.log(`Removed claude-slack hooks from ${settingsPath} and deleted mcp.json`)
} else {
  console.log(`Installed hooks (${EVENTS.map((e) => e.name).join(', ')}) into ${settingsPath}`)
  console.log(`Wrote ${mcpJsonPath}`)
  console.log(`\nNext:\n  1. npm start                      # broker (keep running)\n  2. ${resolve(REPO_ROOT, 'bin', 'claude-slack')}   # a terminal session that shows up as a Slack thread`)
}

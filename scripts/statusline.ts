/**
 * Claude Code's `statusLine` command for a broker-launched session (registered per-launch via
 * `--settings`, never the global `~/.claude/settings.json` — P4-31, "세션별 --settings 전달"). Claude Code
 * runs this on (almost) every render and feeds it a JSON blob on stdin describing the current turn's
 * cost and model; it prints the text to show as the status line.
 *
 * Side effect: it also saves the fields `src/status.ts`'s `StatusStore` reads — one JSON file per
 * `CLAUDE_SLACK_SESSION` (the same key the broker already puts in the pane's env at launch) — so the
 * broker can later tell how expensive a conversation has gotten without talking to the terminal.
 * Losing this write costs nothing but that visibility; the status line itself still prints either way.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_STATUS_DIR } from '../src/status.ts'

interface StatusLineInput {
  model?: { display_name?: string }
  workspace?: { current_dir?: string }
  cost?: { total_cost_usd?: number; total_duration_ms?: number }
  exceeds_200k_tokens?: boolean
  context_window?: {
    context_window_size?: number
    used_percentage?: number
    current_usage?: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }
  }
  rate_limits?: { five_hour?: { used_percentage?: number; resets_at?: number }; seven_day?: { used_percentage?: number; resets_at?: number } }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

const raw = await readStdin()
let input: StatusLineInput = {}
try {
  input = JSON.parse(raw) as StatusLineInput
} catch {
  // Malformed/empty stdin: still print something below rather than crash the terminal's status line.
}

const key = process.env.CLAUDE_SLACK_SESSION
if (key) {
  try {
    mkdirSync(DEFAULT_STATUS_DIR, { recursive: true })
    writeFileSync(
      join(DEFAULT_STATUS_DIR, `${key}.json`),
      JSON.stringify({
        at: Date.now(),
        model: input.model?.display_name,
        costUsd: input.cost?.total_cost_usd,
        durationMs: input.cost?.total_duration_ms,
        exceeds200k: input.exceeds_200k_tokens,
        // The context window and the plan's usage (43): the page's gauges read these.
        contextPercent: input.context_window?.used_percentage,
        contextSize: input.context_window?.context_window_size,
        contextUsed: input.context_window?.current_usage
          ? Math.round(((input.context_window.current_usage.input_tokens ?? 0) + (input.context_window.current_usage.cache_creation_input_tokens ?? 0) + (input.context_window.current_usage.cache_read_input_tokens ?? 0)) / 1000) * 1000
          : undefined,
        rateLimits: input.rate_limits && {
          fiveHour: input.rate_limits.five_hour && { used: input.rate_limits.five_hour.used_percentage, resetsAt: input.rate_limits.five_hour.resets_at },
          sevenDay: input.rate_limits.seven_day && { used: input.rate_limits.seven_day.used_percentage, resetsAt: input.rate_limits.seven_day.resets_at },
        },
      }),
    )
  } catch {
    // Best-effort only; see file header.
  }
}

const cost = typeof input.cost?.total_cost_usd === 'number' ? `$${input.cost.total_cost_usd.toFixed(2)}` : undefined
const parts = [input.model?.display_name, cost, input.exceeds_200k_tokens ? '200k+' : undefined].filter(Boolean)
console.log(parts.join(' · ') || 'claude')

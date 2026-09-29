/**
 * Keeps the test run off the machine's own broker state.
 *
 * `DEFAULT_ARCHIVE_DIR`, `DEFAULT_OFFSETS_PATH` and `DEFAULT_REVIVE_PATH` are
 * read from the environment when their module is first imported, so a Broker
 * built without those options writes to `~/.claude-slack/` — the live broker's
 * own files. Most tests pass temp paths, but every new `new Broker(...)` is a
 * chance to forget, and two had: 176 of the 224 archives in the real folder
 * turned out to be test fixtures (`/home/u/proj`, session `s1`), which then
 * showed up in `/cchistory` and the `/ccresume` picker.
 *
 * Loaded with `--import` from the `test` script, this runs before any source
 * module, so forgetting an option can no longer reach real state.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'claude-slack-test-'))

process.env.CLAUDE_SLACK_ARCHIVE_DIR ??= join(dir, 'sessions')
process.env.CLAUDE_SLACK_OFFSETS ??= join(dir, 'offsets.json')
process.env.CLAUDE_SLACK_REVIVE ??= join(dir, 'live.json')
process.env.CLAUDE_SLACK_PENDING_PURGES ??= join(dir, 'pending-purges.json')
process.env.CLAUDE_SLACK_PINS ??= join(dir, 'pins.json')
process.env.CLAUDE_SLACK_EVENTS_DIR ??= join(dir, 'events')
process.env.CLAUDE_SLACK_LINKS ??= join(dir, 'thread-links.json')
process.env.CLAUDE_SLACK_IMAGES_DIR ??= join(dir, 'images')
process.env.CLAUDE_SLACK_LOG_DIR ??= join(dir, 'logs')
// A test must never talk to the live broker's socket, nor to the tmux session it drives.
process.env.CLAUDE_SLACK_SOCKET ??= join(dir, 'test.sock')
process.env.CLAUDE_SLACK_TMUX_SESSION ??= 'claude-slack-test'

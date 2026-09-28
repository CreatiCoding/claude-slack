/**
 * One-off: archive every thread in the channel to disk, then delete every message
 * (bot messages via the bot token, the user's own via SLACK_USER_TOKEN).
 * The channel's "new session" entry message (block_id new_session_entry) is kept.
 *   node --env-file=.env scripts/purge-channel.ts            # dry run
 *   node --env-file=.env scripts/purge-channel.ts --delete   # really delete
 */
import { WebClient } from '@slack/web-api'
import { writeArchive, DEFAULT_ARCHIVE_DIR } from '../src/archive.ts'
import { NEW_SESSION_BLOCK_ID } from '../src/panel.ts'

const doDelete = process.argv.includes('--delete')
const channel = process.env.SLACK_CHANNEL_ID!
const bot = new WebClient(process.env.SLACK_BOT_TOKEN)
const user = process.env.SLACK_USER_TOKEN ? new WebClient(process.env.SLACK_USER_TOKEN) : undefined
const botUserId = String((await bot.auth.test()).user_id)

type Msg = { ts: string; user?: string; bot: boolean; text: string; blocks?: unknown[]; reply_count?: number }
const norm = (m: any): Msg => ({ ts: String(m.ts), user: m.user, bot: m.user === botUserId || !!m.bot_id, text: String(m.text ?? ''), blocks: m.blocks, reply_count: m.reply_count })

async function page<T>(fn: (cursor?: string) => Promise<{ messages?: any[]; response_metadata?: { next_cursor?: string } }>): Promise<Msg[]> {
  const out: Msg[] = []
  let cursor: string | undefined
  do {
    const res = await fn(cursor)
    out.push(...(res.messages ?? []).map(norm))
    cursor = res.response_metadata?.next_cursor || undefined
  } while (cursor)
  return out
}

const roots = await page((cursor) => bot.conversations.history({ channel, limit: 200, cursor }))
const isEntry = (m: Msg) => m.bot && (m.blocks as any[] | undefined)?.some((b) => b.block_id === NEW_SESSION_BLOCK_ID)
let archived = 0, deleted = 0, kept = 0, failed = 0
const del = async (m: Msg) => {
  if (!doDelete) return
  try {
    if (m.bot) await bot.chat.delete({ channel, ts: m.ts })
    else if (user) await user.chat.delete({ channel, ts: m.ts })
    else return void kept++
    deleted++
  } catch (e: any) {
    if (e?.data?.error === 'message_not_found') return
    failed++
    console.error(`delete ${m.ts} failed: ${e?.data?.error ?? e}`)
  }
}
for (const root of roots.sort((a, b) => Number(a.ts) - Number(b.ts))) {
  if (isEntry(root)) { console.log(`keep entry ${root.ts}`); continue }
  const thread = root.reply_count ? await page((cursor) => bot.conversations.replies({ channel, ts: root.ts, limit: 200, cursor })) : [root]
  const path = writeArchive({ key: `purge-${root.ts}`, sessionId: '', cwd: '', title: root.text.split('\n')[0]?.slice(0, 80), threadTs: root.ts, origin: root.bot ? 'terminal' : 'slack', archivedAt: new Date().toISOString(), messages: thread }, DEFAULT_ARCHIVE_DIR)
  archived++
  console.log(`${doDelete ? 'purge' : 'dry'} ${root.ts} · ${thread.length} msgs (${thread.filter((m) => m.bot).length} bot) · ${root.text.split('\n')[0]?.slice(0, 60)} → ${path}`)
  for (const m of thread) if (m.ts !== root.ts) await del(m)
  await del(root)
}
console.log(`threads ${archived} · deleted ${deleted} · kept ${kept} · failed ${failed}${doDelete ? '' : ' (dry run)'}`)

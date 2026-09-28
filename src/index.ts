import { startModelRefresh } from './models.ts'
import { join } from 'node:path'
import { describeError } from './format.ts'
import { loadConfig } from './config.ts'
import { Broker } from './broker.ts'
import { listen } from './ipc.ts'
import { SOCKET_PATH } from './protocol.ts'
import { createBoltSlack } from './slack.ts'
import { realTmux, TMUX_SESSION } from './tmux.ts'
import { autoConfirmDialogs } from './dialog.ts'
import { createAdminServer, listenWithRetry } from './admin.ts'
import { createLogger, DEFAULT_LOG_DIR, type Level } from './log.ts'

// If the broker itself was started from inside a Claude Code session, drop the
// session's variables so the tmux server (and every session it launches)
// starts clean. CLAUDE_EFFORT would otherwise override the saved default.
for (const k of Object.keys(process.env)) {
  if (/^CLAUDE/.test(k) && !/^CLAUDE_SLACK/.test(k) && k !== 'CLAUDE_CONFIG_DIR') delete process.env[k]
}

// One line per event, with the clock and the thread, in ~/.claude-slack/logs/broker.log.
// CLAUDE_SLACK_LOG_LEVEL=DEBUG adds the per-hook chatter.
const logFile = process.env.CLAUDE_SLACK_LOG === '0' ? undefined : join(DEFAULT_LOG_DIR, 'broker.log')
const log = createLogger({
  file: logFile,
  minLevel: (process.env.CLAUDE_SLACK_LOG_LEVEL as Level | undefined) ?? 'INFO',
  // Echo to the terminal when someone is looking (tmux attach, `npm start` by hand);
  // under a redirect the file is the record and a second copy is just disk.
  stderr: !logFile || !!process.stderr.isTTY,
})

const cfg = loadConfig()
const slack = createBoltSlack({ ...cfg, sdkLog: (level, msg) => log.at(level, 'slack-sdk', msg) })
const broker = new Broker({ ...cfg, socketPath: SOCKET_PATH }, slack.api, realTmux, (pane, done) => autoConfirmDialogs(realTmux, pane, done))
broker.log = log

slack.events.onMessage((m) => broker.handleSlackMessage(m).catch((e) => log.error('slack', `message handler failed: ${describeError(e)}`)))
slack.events.onAction((a) => broker.handleAction(a).catch((e) => log.error('slack', `action handler failed: ${describeError(e)}`)))
slack.events.onStop((s) => broker.handleStop(s).catch((e) => log.error('slack', `stop handler failed: ${describeError(e)}`)))
slack.events.onCommand((c) => broker.handleCommand(c).catch((e) => log.error('slack', `command handler failed: ${describeError(e)}`)))
slack.events.onView((v) => broker.handleView(v).catch((e) => log.error('slack', `view handler failed: ${describeError(e)}`)))
slack.events.onHomeOpened((u) => broker.handleHomeOpened(u).catch((e) => log.error('slack', `home tab failed: ${describeError(e)}`)))

const server = listen(SOCKET_PATH, (conn) => broker.onConn(conn))
server.on('error', (err) => {
  log.error('broker', `cannot listen on ${SOCKET_PATH}: ${describeError(err)} (is another broker running?)`)
  process.exit(1)
})

const { botUserId, teamId } = await slack.start()
log.info('broker', 'up', { pid: process.pid, node: process.version, bot: botUserId, team: teamId, channel: cfg.channelId, socket: SOCKET_PATH, tmux: TMUX_SESSION, log: log.file })
log.info('broker', `allowed users: ${[...cfg.allowedUsers].join(', ')} · user token: ${cfg.userToken ? 'yes (purge deletes your messages too)' : 'no (purge keeps your messages)'}`)
await broker.ensureEntryMessage()
startModelRefresh((m) => log.info('broker', m))
// A purge cut short by a restart or by Slack's rate limit is finished here, now and every few minutes.
const resumePurges = () => broker.resumePurges().catch((e) => log.warn('purge', `resume failed: ${describeError(e)}`))
void resumePurges()
setInterval(resumePurges, 5 * 60 * 1000).unref()

if (cfg.web.enabled) {
  try {
    const admin = createAdminServer(broker, { ...cfg.web, log: (m) => log.info('admin', m) })
    listenWithRetry(admin, cfg.web.port, cfg.web.host, {
      onListening: () => log.info('admin', `http${cfg.web.tlsCert ? 's' : ''}://${cfg.web.host}:${cfg.web.port}${cfg.web.token ? '?t=…' : ''}`),
      // Right after a boot the Tailscale address may not exist yet; say so once, then keep trying quietly.
      onWaiting: (tries) => (tries === 1 || tries % 12 === 0) && log.warn('admin', `${cfg.web.host} is not available yet (Tailscale still coming up?); retrying`),
      onGiveUp: (err) => log.warn('admin', `unavailable: ${err.message}`),
    })
  } catch (err) {
    log.warn('admin', err instanceof Error ? err.message : String(err))
  }
}

// Remember how far each transcript has been read and which sessions are alive,
// so a restart neither skips output nor loses the sessions themselves.
const saveState = setInterval(() => broker.saveState(), 5000)
saveState.unref?.()

// Sessions do not survive a reboot even though the broker now does. Bring the
// ones that were alive back to their threads, conversation and all.
broker.reviveSessions().catch((e) => log.error('revive', describeError(e)))

process.on('uncaughtException', (err) => log.error('broker', `uncaught: ${describeError(err)}`))
process.on('unhandledRejection', (err) => log.error('broker', `unhandled rejection: ${describeError(err)}`))

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    log.info('broker', `shutting down on ${sig}`)
    broker.saveState()
    server.close()
    process.exit(0)
  })
}

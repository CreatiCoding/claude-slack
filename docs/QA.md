# QA: the "stuck session" class

Most bugs in this bridge are one shape: **the terminal enters a state that needs
input, and Slack neither shows it nor drives it, so the session looks like it is
"작업 중" forever.** Model switch, effort change, the auto-mode classifier
("Do you want to proceed?"), folder trust, plan approval, AskUserQuestion — all
the same class.

## The invariant

> After any user action, the terminal must never sit on an input-waiting dialog
> without Slack offering an actionable control within a few seconds.

Anything that violates this is the bug, whatever the dialog says.

## How the bridge upholds it (defense in depth)

1. **Notification hook** (`agent_needs_input` / `elicitation_dialog`): Claude Code
   tells us it needs input. The broker captures the screen and posts the dialog
   as buttons (`surfaceDialog`). This is the primary, timing-free path.
2. **Stall watchdog**: during a turn, if the transcript is quiet for `stallMs`,
   the broker looks at the screen and surfaces any dialog. Belt to the
   Notification suspenders.
3. **Permission verdicts drive the terminal**: `허용`/`거부` also press the
   matching option in a terminal proceed dialog, since the MCP verdict alone does
   not clear Claude Code's classifier.
4. **Reconnect**: when the broker restarts under a live session, it surfaces any
   dialog already on screen (the reconnected session has no active turn, so the
   watchdog would otherwise miss it).

Known dialogs (folder trust, dev-channels, MCP consent, model switch) are
auto-confirmed. Everything else — permission, credential exploration, unknown
numbered dialogs — becomes buttons for the user to decide.

## Automated sweep

`scripts/qa-sweep.ts` launches a real Claude Code session, types the scenario
prompts straight into the terminal (not via the Slack channel, so it stays
isolated), and has a fake Slack auto-click every card and dialog. A continuous
monitor fails the run if any numbered dialog persists past `STUCK_MS`, so it
catches kinds we have never seen.

```
node --env-file=.env scripts/qa-sweep.ts
```

Always give it its own socket and tmux session, or it takes over the live
broker's:

```
CLAUDE_SLACK_SOCKET=/tmp/cs-qa.sock CLAUDE_SLACK_TMUX_SESSION=cs-qa \
  node --env-file=.env scripts/qa-sweep.ts
```

### The QA channel

With `CLAUDE_SLACK_QA_CHANNEL` set in `.env` (a private channel the bot is in —
`#claude-code-qa`, never the live one), two more things happen:

- **Every card is posted there for real.** The fake Slack accepts any block, so a
  block type this workspace rejects passes every test and then fails in
  production — `invalid_blocks` appeared 1,274 times in one day's log with a
  green suite. Slack's own verdict is now a sweep failure.
- **Channels stay on**, so a scenario can push a message the way Slack does
  (`handleSlackMessage` → shim → MCP notification → session) and check the marker
  reached the transcript. Typing into the terminal never touches that path.

Inbound still does not come from Slack itself: a second Socket Mode connection
for the same app would take events away from the live broker, so the sweep never
opens one. Slack's inbound delivery is proven by the live bridge running.

Without the variable the sweep behaves as before (`CLAUDE_SLACK_NO_CHANNEL=1`,
fake Slack only), so it still runs on a machine with no tokens.

Run it after changing dialog/permission handling, and when a new Claude Code
version might have added or reworded a dialog.

## Adding a scenario

Add an action + `settle(...)` in the harness. You do not need to teach it the new
dialog: if the broker fails to surface it, the monitor reports the stuck screen.
Teach `src/dialog.ts` `KNOWN` only when a dialog should be **auto**-confirmed
without asking the user. Every keypress that answers a dialog goes through
`DialogDriver` in that file, and the Slack button contract lives in
`src/actions.ts`.

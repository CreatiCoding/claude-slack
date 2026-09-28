#!/bin/sh
# Runs the broker under launchd while keeping it reachable with `tmux attach`.
#
# launchd wants a process whose lifetime is the service's lifetime, but
# `tmux new-session -d` returns at once — launchd would read that as a crash and
# respawn in a loop. So start the session, then block for as long as it lives.
# When the broker dies the session goes with it, this script exits, and
# KeepAlive starts the whole thing over.
set -eu

SESSION=claude-slack-broker
DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
LOG_DIR="$HOME/.claude-slack/logs"

mkdir -p "$LOG_DIR"
# The broker writes ~/.claude-slack/logs/broker.log itself (timestamped, rotated
# at 5MB while running). The pane keeps stderr so `tmux attach` still shows it.
# Anything printed before the logger is up (a crash on start) lands in start.log.
if ! tmux has-session -t "=$SESSION" 2>/dev/null; then
  tmux new-session -d -s "$SESSION" -c "$DIR" "npm start 2>>'$LOG_DIR/start.log'"
fi

while tmux has-session -t "=$SESSION" 2>/dev/null; do
  sleep 5
done

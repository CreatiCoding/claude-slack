#!/bin/sh
# Run on the machine whose Chrome is logged into Slack. Needs the
# "Claude in Chrome" extension (chrome web store) installed.
DIR=$(cd "$(dirname "$0")/.." && pwd)
cd "$DIR" && exec claude --chrome "$(cat "$DIR/docs/SETUP-PROMPT.md")"

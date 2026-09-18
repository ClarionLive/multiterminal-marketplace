#!/bin/sh
# check.sh — one monitoring round over one or more agents.
#
# Usage: check.sh <name>:<sessionIdOrAgentName>:<fromLine> [...]
#   e.g. check.sh Diana:4831a141:1139 Nadia:Nadia:0
#
# For each agent: resolve its transcript (by id, or by name), print everything since <fromLine>, then
# scan the same range for outward-facing actions. Ends each block with the new line count, which is
# what you pass back as <fromLine> next round.
#
# Read-only by construction: it opens files and runs nothing on the agents' behalf. Never add a
# message-send here. Asking the agent what it is doing changes what it does next, and "is it still
# alive?" answered with list_terminals is worse than useless — that call refreshes the very
# last-active timestamp you are reading.
set -u
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

for spec in "$@"; do
  name=${spec%%:*}; rest=${spec#*:}; id=${rest%%:*}; from=${rest#*:}
  f=$(sh "$DIR/find-transcript.sh" "$id") || f=""
  echo "== $name (${f:-NOT FOUND})"
  [ -z "$f" ] && continue
  node "$DIR/tail-transcript.mjs" "$f" "$from"
  node "$DIR/writes.mjs" "$f" "$from"
done

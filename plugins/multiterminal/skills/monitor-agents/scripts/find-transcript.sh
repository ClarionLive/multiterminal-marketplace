#!/bin/sh
# find-transcript.sh — locate an agent's CURRENT transcript file.
#
# Usage: find-transcript.sh <sessionIdPrefix|AgentName> [maxAgeMinutes]
#
# By session id (8+ hex chars) is the reliable form. Claude Code names the file after the session id
# but files it under a directory derived from the agent's WORKING DIRECTORY — so the path moves when
# the agent enters or switches a worktree, while the id does not. That happened mid-run on
# 2026-09-17 (a helper moved from …-worktrees-e6721573 to …-worktrees-2484592b) and broke a tail
# that had remembered the path.
#
# By agent name is the fallback for a helper whose session id you do not know yet. It tries THREE
# markers, because the obvious one is not universal:
#   - `MULTITERMINAL_NAME=<name>`  — the SessionStart hook's identity block. Present for a terminal
#     the OWNER opened. A spawned helper does NOT get this line (verified 2026-09-17 on a helper
#     whose transcript contained the string MULTITERMINAL_NAME only inside unrelated hook text), so
#     matching on it alone silently finds nothing and reads as "the helper never started".
#   - `You are <name>, spawned by` — the spawn job, once the helper has COLLECTED it.
#   - `"fromTerminalId":"<name>"` — any message the helper has sent.
# A helper that has not yet collected its job matches none of them; that is a real state (see the
# 120s collection window), so report "not found yet" rather than inferring anything from it.
#
# ⚠️ Name lookup is a HEURISTIC over text, and a monitor is the worst case for it: your own
# transcript quotes the agents you read, so it contains their markers too. Caught on the first use —
# searching for "Nadia" returned the monitor's own file. Two guards: this script skips the session
# named by $CLAUDE_SESSION_ID or a third argument, and it prints every match it rejected to stderr so
# an ambiguous answer is visible rather than silently wrong. Once you have the id, USE THE ID.
set -u
NEEDLE=${1:-}
MAXAGE=${2:-240}
SELF=${3:-${CLAUDE_SESSION_ID:-}}   # your own session; never your own transcript
PROJECTS="$HOME/.claude/projects"
[ -d "$PROJECTS" ] || PROJECTS="/c/Users/$USERNAME/.claude/projects"

if [ -z "$NEEDLE" ]; then
  echo "usage: find-transcript.sh <sessionIdPrefix|AgentName> [maxAgeMinutes]" >&2
  exit 2
fi

case "$NEEDLE" in
  [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]*)
    find "$PROJECTS" -name "$NEEDLE*.jsonl" -printf '%T@ %p\n' 2>/dev/null | sort -n | tail -1 | cut -d' ' -f2-
    ;;
  *)
    # Markers are tried STRONGEST FIRST, because only one of them is self-identifying:
    #   1. `"fromTerminalId":"<name>"` — an argument the agent passed when IT sent a message. Another
    #      agent's transcript carries the name in `from="<name>"` instead, so this one does not
    #      confuse a helper with the PM watching it.
    #   2. `MULTITERMINAL_NAME=<name>` — the hook's identity block (Owner-opened terminals only).
    #   3. `You are <name>, spawned by` — the spawn job. AMBIGUOUS: it appears in the helper's
    #      transcript AND in the spawner's, because the spawner wrote it. Both false positives were
    #      real on the first run: searching "Nadia" hit the monitor's own file, then the PM's.
    # `while read`, not `for f in $(...)`: these paths contain the user's home directory, which on
    # Windows routinely has a space in it ("John Hickey"), and word-splitting silently found nothing.
    scan() {
      find "$PROJECTS" -name '*.jsonl' -mmin -"$MAXAGE" -printf '%T@ %p\n' 2>/dev/null | sort -rn | cut -d' ' -f2- |
        while IFS= read -r f; do
          case "$SELF" in
            ?*) case "$f" in *"$SELF"*) continue ;; esac ;;
          esac
          grep -qE "$1" "$f" 2>/dev/null && printf '%s\n' "$f"
        done
    }

    matches=$(scan "\"fromTerminalId\":\"$NEEDLE\"")
    weak=""
    if [ -z "$matches" ]; then
      matches=$(scan "MULTITERMINAL_NAME=$NEEDLE([^A-Za-z0-9_]|$)")
    fi
    if [ -z "$matches" ]; then
      matches=$(scan "You are $NEEDLE, spawned by")
      weak="yes"
    fi

    [ -z "$matches" ] && exit 1
    printf '%s\n' "$matches" | head -1

    count=$(printf '%s\n' "$matches" | grep -c .)
    if [ -n "$weak" ] || [ "$count" -gt 1 ]; then
      echo "warning: matched '$NEEDLE' on a weak or ambiguous marker ($count file(s)); chose the most recent." >&2
      printf '%s\n' "$matches" | sed 's/^/  /' >&2
      echo "  The spawner's own transcript contains the job text too. Confirm the session id and use that instead." >&2
    fi
    exit 0
    ;;
esac

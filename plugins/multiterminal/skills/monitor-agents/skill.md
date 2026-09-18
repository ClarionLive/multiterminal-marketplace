---
name: monitor-agents
description: Watch another MultiTerminal agent's run read-only and report to the Owner only what they asked to hear. Use when the Owner says "monitor X", "watch what Diana is doing", "keep an eye on that run", "tell me when the helper finishes", or asks for updates on a terminal they are not reading themselves. Reads transcripts, the board and git; never messages the agent being watched. Not for driving work — for that see project-management.
version: 1.0.0
---

# Monitor another agent's run

You watch a run you are not part of, and tell the Owner the few things they asked to hear.

Built from the first real use (2026-09-17): one terminal watched a PM and three helpers across two
runs and about three hours, roughly twenty rounds, entirely from files.

## The one rule that makes this work

**Never message the agent you are watching, and never act on its work.**

A message changes what it does next, so the report would be about a run you altered. Everything you
report comes from artifacts the agents wrote anyway: their transcripts, the kanban board, git,
and — when the Owner cares about it — the live state of GitHub.

The same trap has a second, subtler form. Do not "check if the agent is still alive" with
`list_terminals`: last-active tracks tool calls, so **the check refreshes the timestamp you are
reading**. If you need liveness, compare timestamps you already have.

## Step 1 — Agree the brief BEFORE the first round

Do not start until you and the Owner agree on three things. Write them into your first reply so
they are quotable later:

1. **Who** you are watching (the PM, and any helpers — including ones spawned later).
2. **What you report.** A short, closed list of triggers. From the first run, these earned their place:
   - a helper is spawned, or reports done / blocked;
   - a checkpoint decision: a root cause, a plan change, a gate failure;
   - any outward-facing or destructive action (push, GitHub write, killing a process);
   - work touching a checkout other than the agent's own worktree;
   - the agent asks the Owner something (they may not be looking at that pane);
   - the run ends.
3. **When you stop.** Normally "when the run is handed back to the Owner". Say it out loud, so the
   loop has an end condition rather than running until someone notices.

Anything not on the list gets one line: `no change` plus the new line numbers. That is what keeps
twenty rounds readable.

## Step 2 — Find each transcript ONCE, by session id

```
sh scripts/find-transcript.sh 4831a141          # by session id (preferred)
sh scripts/find-transcript.sh Nadia             # by agent name, for a helper you just saw spawn
```

The file is named after the session id but stored under a directory derived from the agent's working
directory, **so the path moves when the agent enters or switches a worktree**. Remember the id, never
the path. On the first run a helper's transcript moved mid-run and a path-based tail silently went
quiet — which reads exactly like "nothing is happening".

For the PM's own session id: `MULTITERMINAL_NAME=` appears in the transcript's identity block, or ask
the Owner which terminal to watch and match it in `list_terminals` once, at the start.

## Step 3 — Each round

```
sh scripts/check.sh Diana:4831a141:1139 Nadia:Nadia:0
```

Per agent it prints everything since your last line number, then scans that same range for
outward-facing actions, then prints the new line count. Feed those counts back next round.

Add, when the brief calls for it:
- `get_task_detail(taskId)` for checklist movement and notes;
- `git -C <repo> log/status/branch --merged` to check a claimed commit or merge exists;
- `gh issue view` when GitHub state is part of the brief.

**Verify claims against artifacts, not the agent's own summary.** On the first run every summary was
accurate — and that is knowable only because they were checked. A "done" message is a claim; a commit
on the branch is evidence.

## Step 4 — Report

- **Trigger hit:** lead with what happened and what it means for the Owner, then the evidence
  (commit, ticket id, file, line). Say plainly what is NOT established: "she says X; I checked the
  branch and X is there" is different from "she says X".
- **Nothing:** one line. `no change` plus the new line numbers.
- **Never** invent progress, and never fill a quiet round with speculation about what the agent is
  "probably" doing.

## Step 5 — Pacing, and its cost

Every round spends tokens in YOUR context, and the Owner pays for it. Twenty rounds is a real cost,
so pace to the work rather than to a habit:

- Fast phases (a helper coding, gates running): 5 minutes is reasonable.
- Slow phases (waiting on the Owner to test): much longer, or stop and let the Owner restart you.
- `/loop 5m <this brief>` schedules the rounds; cancel it with CronDelete when the run ends.
- Before each round, ask whether anything could plausibly have changed. If the answer is no, say so
  and lengthen the interval instead of running the scripts again.

## Step 6 — Stop

When the end condition is met, **cancel the loop** and say so in the same message as the final
report. A monitor that keeps reporting "no change" after the run ended is noise that teaches the
Owner to ignore the channel.

## What a monitor is not

- **Not a reviewer.** You report what happened; you do not judge the code, and you do not fix it.
- **Not a second PM.** If you think the run is going wrong, tell the OWNER what you saw. Do not
  message the PM, and do not intervene.
- **Not a supervisor of people.** Report actions and artifacts, not opinions about the agent.

If the Owner asks you to step in, that is a different job: stop monitoring first and say that you
have, because from that moment your reports are about a run you are changing.

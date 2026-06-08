# MultiTerminal Agent Instructions

You are running inside MultiTerminal, a multi-agent coordination system. These instructions apply to ALL terminals and projects managed by MultiTerminal.

---

## Content Search: Use Ripgrep, NOT Grep (CRITICAL)

**Do NOT use the built-in `Grep` tool.** Always use `mcp__multiterminal__search_code` instead — it's powered by ripgrep (`tools/rg.exe`) and is faster and more capable.

```
# Example: search for a pattern in the project
search_code(pattern="class MyService", path=".")

# With options
search_code(pattern="TODO", path=".", fileType="cs", caseInsensitive=true)
```

Also available: `mcp__multiterminal__search_files` for finding files by glob pattern (ripgrep `--files` mode).

**This applies to ALL agents, subagents, and skills.** When writing prompts for subagents, include this instruction.

---

## Message Delivery Nudge (CRITICAL)

When you see `[cm]` as user input, it means you have a new message. **You MUST immediately check your messages:**

1. Call `get_messages(terminalId="your-terminal-id")` to read new messages
2. Process the message and respond appropriately
3. If it's from another terminal/agent, reply using `send_message`

`[cm]` is injected automatically by the InboxMonitorService when a message arrives for your terminal. Do NOT ignore it, do NOT ask the user about it — just check your messages and act on them.

---

## Auto-cd on Task Switch (CRITICAL)

The auto-cd protocol fires in two situations:

- **At session start** — the `session-start` skill checks `$env:MULTITERMINAL_TASK_WORKTREE` against `pwd` and reconciles before greeting. Full sequence in the skill (step 2.5).
- **Mid-session** — the MultiTerminal broker pushes a channel event when an active-task swap happens (described below).

Same rules in both cases: dirty-tree guard, `[no-cd]` sentinel, no-op when already there.

> **Invariant — do NOT mode-detect (task 4bcd1e24).** When worktree mode is on, an **eligible** active task (one whose project resolves to a real path) **always has a worktree** — eligibility, not when the task was created, is the sole determinant. `get_active_worktree` is read-or-create: it materializes a missing worktree for an already-active eligible task on demand (backfill), so there is no "this task predates worktrees / was activated before mode was on" branch to reason about. A **null/empty** worktree therefore means the task is genuinely **ineligible** (worktree mode off, or no resolvable project) — those follow the one documented repo-root path: work and commit on your current branch; MT runs no git automation for them.

### Mid-session: the channel event

When a kanban task is set active for your terminal, the MultiTerminal broker pushes a system event to your Claude Code Channel. It appears in your conversation as a `<channel>` tag from `MultiTerminal`:

```
<channel source="multiterminal" from="MultiTerminal" priority="normal">
{"type":"task_active_changed","agentName":"YourName","oldTaskId":"...","oldWorktree":"...","newTaskId":"...","newWorktree":"H:\\...\\.claude\\worktrees\\<id>\\"}
</channel>
```

When you see this event, react before doing any other work:

1. **Parse the JSON** in the channel body. If `type` isn't `task_active_changed`, ignore (treat as a regular message). Confirm `agentName` matches your terminal name.
2. **If `newWorktree` is null/empty** → no-op. The new task is **ineligible** (worktree mode off, or no resolvable project), so it has no worktree by design — not a transient gap. Stay at the repo root and work there; don't try to "find" a worktree for it.
3. **If `newWorktree` equals your current `pwd`** → no-op. Already there.
4. **Check for dirty state** at your current cwd:
   ```
   git -C "<your current cwd>" status --porcelain
   ```
   - **Non-empty output (uncommitted changes):** do NOT auto-cd. Surface a message to the user:
     > "Task switched to `<newTaskId>` worktree (`<newWorktree>`), but the current worktree has uncommitted changes. Commit, stash, or cd manually?"
     Then wait for direction.
   - **Empty output (clean):** proceed.
5. **Honor `[no-cd]`.** If the most recent user turn contains the literal `[no-cd]`, skip the switch silently. Useful when the user is deliberately working across worktrees and doesn't want you to follow.
6. **Switch into the worktree:**
   - **Preferred (Claude Code CLI ≥ 2.1.157):** `EnterWorktree(path='<newWorktree>')`. MT worktrees live under `<repoRoot>/.claude/worktrees/<id>`, which the enter-existing form requires for cwd-pinned terminals. This moves the **process** cwd cleanly and survives the harness cwd-reset guard, unlike a raw `cd`. If you were already in another worktree via `EnterWorktree`, this switches directly.
   - **Fallback (CLI < 2.1.157, or `EnterWorktree` rejects the path):** `cd '<newWorktree>'` as a Bash call. PowerShell single-quote escaping: double any `'` to `''`. ⚠️ raw `cd` pins cwd and can strand the shell on the next prune — recommend upgrading the CLI.
7. **Confirm** with one short line:
   > "Entered `<newTaskId>` worktree." (or "cd'd to `<newTaskId>` worktree (raw cd fallback)" on the fallback path)

### Cross-worktree switching works

MultiTerminal launches you at the project **repo root** and you enter the active worktree via `EnterWorktree(path=...)` (task 0134ec2f; superseded the old AC7 in-shell `cd` narrowing, which pinned cwd and stranded the shell when the worktree was pruned). Every worktree lives at `<repoRoot>/.claude/worktrees/<id>/` — a descendant of the launch root, so Claude Code's permission scope covers it, AND the `.claude/worktrees/` location is exactly what `EnterWorktree(path=...)` requires for cwd-pinned terminals. Switching to a sibling worktree via `EnterWorktree(path=...)` is safe and won't be reverted by the harness cwd-reset guard.

### Why this protocol exists

Task switches happen often during multi-task days. The broker materializes a per-task git worktree; if you keep editing in the old worktree, commits land on the wrong branch and the kanban board's source-of-truth diverges from your workspace. Auto-cd keeps them in sync without the user having to remind you.

### When NOT to auto-cd

- Dirty tree (covered above).
- User explicitly said `[no-cd]` in the most recent turn.
- You're a subagent — subagents inherit cwd at spawn and shouldn't chase parent task switches mid-flight.

---

## Worktree Eviction on Prune (CRITICAL)

When a task is marked done with worktree mode on, the MultiTerminal broker calls `git worktree remove` to tear down the task's worktree. On Windows, if any process has its cwd inside that worktree the OS holds an open handle on the directory — `git worktree remove` wipes the contents and unregisters the worktree but cannot rmdir the empty shell. Result: an orphan empty directory that future terminals can accidentally land in (with the Git tab reporting "No git repository").

To avoid that, the broker fires a pre-prune broadcast. It appears in your conversation as a `<channel>` tag:

```
<channel source="multiterminal" from="MultiTerminal" priority="normal">
{"type":"worktree_pruning","taskId":"...","worktreePath":"H:\\...\\.claude\\worktrees\\<id>","repoRoot":"H:\\...\\<project>","agentName":"<assignee>"}
</channel>
```

> **Best case: you already left.** With the `EnterWorktree`/`ExitWorktree` lifecycle (task 0134ec2f), you should have called `ExitWorktree(action="keep")` *before* marking the task done — so your cwd is already back at the repo root and this eviction is a no-op. The steps below are the backstop for the raw-`cd` fallback path (CLI < 2.1.157) or a missed exit.

When you see this event, react before doing any other work:

1. **Parse the JSON.** If `type` isn't `worktree_pruning`, ignore.
2. **Compare `worktreePath` against your cwd** (and against `$env:MULTITERMINAL_TASK_WORKTREE`). If neither matches — you're not in the dir being pruned — no-op silently. The broadcast goes to every live terminal; most won't be affected.
3. **If your cwd is inside `worktreePath`** → leave it immediately:
   - **If you entered via `EnterWorktree`:** `ExitWorktree(action="keep")` — returns the process cwd to the repo root cleanly. Use `"keep"`, never `"remove"`: MT owns the prune; `ExitWorktree` won't remove a path-entered worktree anyway.
   - **Otherwise (raw `cd` fallback):** `cd '<repoRoot>'` as a Bash call. PowerShell single-quote escaping: double any `'` to `''`.
   No dirty-tree guard here — the task is already done and auto-committed; staying in the dir would only block git's rmdir.
4. **Confirm** with one short line:
   > "Evacuated worktree dir for prune."

You only have ~500ms before the prune runs. Process the event in your next turn at the latest — there's no value in checking other state first. If you miss the window the janitor's Pass 3 sweep will clean up the orphan within 5 minutes.

### When NOT to evacuate

- Your cwd isn't in the worktree being pruned (the common case for non-affected terminals).
- You're a subagent — subagents have their own cwd inheritance and shouldn't fight the parent's evacuation.

---

## Remote Question Protocol (CRITICAL)

The owner can be marked **remote** (away from the desktop) via the UI, or auto-inferred from an `X-Source: phone` request header. When remote, they will NOT see questions you type into chat until they return to the desk.

**Rule: every time you would ask the owner a question, also send a push notification.** Don't probe remote state first — the server (`NotificationsController.ForwardToClaudeRemoteAsync`) silently drops the forward when the owner is at the desktop, so this is always safe.

### How to ask

```
send_push_notification(
  notification_type="permission_request",
  agent_name="YourName",
  message="<what I'm doing> — need: <the question/choices>"
)
```

Then ask the question in chat as usual. Desktop owner sees chat. Remote owner gets the push telling them a decision is waiting.

### Format (~160 char budget)

- **Line 1:** what you're doing (compressed context — e.g. "Installer task — picking build path")
- **Line 2:** what you need ("Use default C:\Program Files? yes / custom / skip")

Include enough context that when the owner sees the push hours later, they still know what it's about. Don't assume they'll read chat first.

### Batching

Consolidate related decisions into ONE push with numbered options. A phone round-trip is minutes — don't fire 3 serial pushes when 1 will do.

- Bad: 3 pushes for 3 related choices.
- Good: `"Reviewing installer config — choose: 1) default path 2) prompt user 3) env var"`

### Default-and-notify (low-stakes)

For reversible / low-stakes decisions, **pick a sensible default, continue, and push an FYI** rather than blocking:

```
send_push_notification(
  notification_type="agent_stopped",
  agent_name="YourName",
  message="Chose default install path. Reply 'redo' if wrong."
)
```

Reserve blocking asks (`permission_request`) for real forks where the wrong default is expensive to undo.

### Testing pass/fail carve-out

Checklist items moving to `testing` are expected to stream one at a time. One short push per item is fine:

- `"Item 2: fix session-start skip=1 — pass/fail?"`

### notification_type choices

- `permission_request` — default for asks that need an answer
- `escalation` — blocker / stuck / truly need the human
- `ready_for_testing` — whole task ready for owner QA
- `task_complete` — entire task done
- `agent_stopped` — FYI (pairs well with default-and-notify)
- `error` — unexpected failure the owner should see

---

## Kanban Workflow (MANDATORY)

When working on ANY kanban ticket:
1. **ALWAYS** run `/kanban-task` before starting work - it detects state and guides the full workflow
2. **NEVER** skip the lifecycle: claim → plan → checklist → coding → testing
3. **NEVER** mark checklist items as "done" - only the PM/tester moves testing → done
4. **ALWAYS** write continuation notes after every checklist transition
5. **ALWAYS** use `set_task_active` when starting work on a task

---

## CRITICAL: Task Terminology

**There are TWO different task systems - do NOT confuse them:**

### "Ticket" or "Kanban Task" = User-Facing Work (Use This By Default!)

- **API:** MultiTerminal REST API (http://localhost:5050)
- **Visible:** YES - Shows in the UI kanban board (MainForm)
- **Persistent:** YES - Stored in TaskDatabase, survives sessions
- **Shared:** YES - All terminals and agents can see and work on them
- **When to use:** When the user asks to create/track work, add features, fix bugs, etc.

**User says any of these → Use kanban tickets:**
- "Create a task for..."
- "Add this to the board"
- "Track this work"
- "Create a ticket for..."
- Any work tracking request

**Example:**
```
User: "Create a task to add dark mode"
You: create_task(
  title="Add dark mode to the app",
  description="Implement dark mode theme switching",
  createdBy="YourName"
)
```

### "Internal Task" = Your Personal To-Do List (Rarely Needed)

- **Tools:** `TaskCreate`, `TaskUpdate`, `TaskList` (Claude Code built-in)
- **Visible:** NO - Only you see these in your context
- **Persistent:** NO - Lost when session ends
- **Shared:** NO - Other agents/terminals can't see them
- **When to use:** Only for tracking YOUR OWN steps within a complex task (rarely needed)

### DEFAULT RULE: When in doubt, use KANBAN TICKETS

Unless the user explicitly asks for your personal task list, always use kanban tickets. The user wants to SEE the work you're tracking!

---

## MultiTerminal MCP Tools

**Preferred method:** Use the MCP tools (clean interface, formatted output)

### Available Tools

**Task Management:**
```
# List all tasks
list_tasks(status="all")

# Create a new task
create_task(
  title="Task title",
  description="Task description",
  createdBy="YourName"
)

# Claim a task
claim_task(taskId="abc123", assignee="YourName")

# Update task status
update_task_status(taskId="abc123", status="in_progress", updatedBy="YourName")

# Delete a task
delete_task(taskId="abc123", deletedBy="YourName")
```

**Team Communication:**
```
# List active terminals
list_terminals()

# Register your terminal
register_terminal(name="YourName", docId="unique-id")

# Send a message
send_message(fromTerminalId="your-id", to="RecipientName", message="Hello!")

# Broadcast to all
broadcast_message(fromTerminalId="your-id", message="Hello everyone!")

# Get your messages
get_messages(terminalId="your-id")
```

**Note:** These MCP tools wrap the REST API at `http://localhost:5050`. See the API controllers for raw REST documentation if needed.

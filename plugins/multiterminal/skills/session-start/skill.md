---
name: session-start
description: Auto-run at session start. Lightweight startup menu — presents quick choices (continue task, new task, pick task, just chat) so the user decides how to spend the session. No heavy loading until a choice is made.
version: 2.0.0
---

# session-start

Lightweight session startup menu. Establishes identity, registers session in lifecycle pipeline, reads active context, gives a quick summary, presents interactive choices.

---

## Instructions

### 1. Establish Your Identity (MANDATORY FIRST STEP)

Before anything else, you MUST identify yourself:

1. **Read your identity from the SessionStart hook's `additionalContext`** (a system-reminder near the top of this session). Look for the block emitted by the hook:
   ```
   ## MultiTerminal Identity (authoritative — from SessionStart hook)
   MULTITERMINAL_NAME=<name>
   MULTITERMINAL_DOC_ID=<doc-id>
   CLAUDE_SESSION_ID=<session-uuid>
   ```
   Save all three. **Prefer this source** — the hook receives the live session id via stdin (`hookData.session_id`) and is authoritative. This is the ONLY reliable source for `CLAUDE_SESSION_ID`, because Claude Code does NOT export it into the child shell (so the bash echo below cannot recover it).
2. **Fallback only if those lines are absent** (older hook, or running outside MultiTerminal): run `echo "$MULTITERMINAL_NAME|$MULTITERMINAL_DOC_ID|$CLAUDE_SESSION_ID"` and parse the three `|`-separated values (name, doc ID, session ID). Note that `$CLAUDE_SESSION_ID` will be empty in this fallback — without a session id, skip `register_session` (step 5).
3. **Only call `register_terminal(name=YOUR_NAME, docId=YOUR_DOC_ID)` if BOTH values are non-empty.** This ensures you don't accidentally rename another terminal by passing a stale/inherited docId.
4. If only the name is set (no docId), call `register_terminal(name=YOUR_NAME)` without a docId — you'll get a fresh registration.
5. **Immediately after register_terminal**, call `register_session(sessionId=YOUR_SESSION_ID, agentName=YOUR_NAME, projectPath=PROJECT_ROOT)`. This registers the current session as 'open' in the lifecycle pipeline and closes any previous open sessions for the same agent+project. PROJECT_ROOT is your current working directory (e.g., `H:\DevLaptop\ClarionPowerShell\MultiTerminal`).
6. Greet using your name: "Hey, it's **Alice** checking in." (use YOUR actual name from the env var).
7. If both env vars are empty (e.g., running outside MultiTerminal), skip registration and greet generically.

**IMPORTANT: Never pass a docId that wasn't set by YOUR terminal's launch.** If you're running in a context where env vars might be inherited from a parent process (e.g., a Clarion IDE addin launched from a MultiTerminal shell), those env vars belong to the parent — not you. When in doubt, register with just your name and no docId.

**You now know who you are for the rest of this session.** Use this name for all MCP calls (claiming tasks, sending messages, checking inbox, etc.).

### 2. Read Previous Session + Active Task

**Call both in parallel:**
1. `get_latest_session(projectPath=PROJECT_ROOT, agentName=YOUR_NAME, skip=0, excludeSessionId=YOUR_SESSION_ID)` — returns the previous session with its **summary**. This call auto-ensures the session is fully processed (imports messages, indexes chunks, generates summary on demand). The summary it returns is reliable — trust it.
2. `get_my_active_task(agentName=YOUR_NAME)` — checks for your current active task on the kanban board.

**How to use the results:**
- `get_latest_session` returns a summary. **Use this summary as your primary context** for the greeting. It's generated from the actual session messages and describes what was worked on.
- If the summary is empty or says "No summary cached", fall back to `search_session_memory(query="what we worked on last session", projectPath=PROJECT_ROOT, topK=5, agentName=YOUR_NAME)` to get transcript chunks. Synthesize a 2-3 sentence summary from those chunks.
- The active task is secondary context. Do NOT read `memory/ACTIVE-CONTEXT.md` — it's often stale and misleading.
- **IMPORTANT:** Do NOT just repeat the active task's continuation notes as your summary. If the session summary tells a different story than the active task, trust the session summary — the user may have been working off-task.

If `get_latest_session` returns no results AND the search fallback returns nothing, just mention the active task.

### 2.5. Active-Task Worktree Check (auto-enter)

If `get_my_active_task` returned a task, the agent may be sitting outside the active task's worktree (the terminal launches at the **repo root** now, and you may need to enter the worktree; also after a session resume or if the user activated a new task between terminal launch and now). Reconcile cwd to the active task's worktree before greeting:

1. Call `get_active_worktree(agentName=YOUR_NAME)` — the broker's **live** view (preferred over `$env:MULTITERMINAL_TASK_WORKTREE`, which is a launch-time snapshot and can be stale if the user activated a different task between terminal launch and now). This call is **read-or-create**: if your active task is eligible (worktree mode on + resolvable project) but its worktree was never materialized — e.g. the task was already active on resume, or activated before mode was on — it backfills the worktree on demand and returns the fresh path (task 4bcd1e24). So do **not** mode-detect or reason about whether a task "predates worktrees": an eligible active task always resolves to a worktree here. If the tool says "No active worktree", the task is genuinely **ineligible** (mode off, or no resolvable project) — skip the rest of this step and just work at the repo root.
2. Compare the returned `worktreePath` to your current `pwd`. If equal, skip — already there.
3. **Dirty-tree guard:** run `git -C "<your current cwd>" status --porcelain`. If output is non-empty, do NOT auto-enter. Tell the user:
   > "Active task is `<taskTitle>` with worktree `<worktreePath>`, but the current cwd has uncommitted changes. Want me to enter anyway, stash, or stay?"
   Then proceed with the rest of the session-start flow (the user can address the divergence later).
4. **`[no-cd]` sentinel:** if the user's most recent turn contains `[no-cd]`, skip the switch silently and proceed.
5. Otherwise, switch into the worktree:
   - **Preferred (Claude Code CLI ≥ 2.1.157):** call `EnterWorktree(path='<worktreePath>')`. MT worktrees live under `<repoRoot>/.claude/worktrees/<taskIdShort>`, which the enter-existing form requires for cwd-pinned terminals. Unlike a raw `cd`, `EnterWorktree` moves the **process** cwd cleanly and survives the harness cwd-reset guard. One-line confirm: `"Entered active task worktree."`
   - **Fallback (CLI < 2.1.157, or `EnterWorktree` rejects the path):** run `cd '<worktreePath>'` (PowerShell single-quote escape `'` as `''`). ⚠️ A raw `cd` pins cwd and can strand the shell when the worktree is pruned on task completion — recommend upgrading the CLI (≥ 2.1.157). One-line confirm: `"cd'd to active task worktree (raw cd fallback — upgrade CLI to ≥2.1.157 for clean EnterWorktree)."`
   - Run `claude --version` first if you're unsure which path applies.

**On task completion (exit):** before marking the task done (which triggers MT's worktree prune), if you entered via `EnterWorktree`, call `ExitWorktree(action="keep")` to return the process cwd to the repo root. This is what lets MT's `git worktree remove` succeed — a shell can't remove its own cwd. Use `"keep"` (not `"remove"`): MT owns the prune, branch merge, and auto-commit; `ExitWorktree` only removes worktrees IT created, and won't touch a path-entered one anyway.

This is the session-start analog of the `task_active_changed` channel event (full protocol in the plugin CLAUDE.md). Same rules; this one fires once at session boot instead of on every task switch.

### 3. Brief Greeting + Context Summary

Summarize what the **previous session** was about in 2-3 sentences based on the summary from `get_latest_session`. Lead with what you were *doing* (e.g., "Last session we were fixing the HUD dashboard to filter recent activity by project"). Then mention the active task if relevant.

If there's also a Last Session Recap in the system reminders from the hook, incorporate that too.

**IMPORTANT:** After outputting the summary, always add a blank line (`\n`) before calling AskUserQuestion. This prevents the selection box from clipping the summary text.

### 4. Present the Menu with AskUserQuestion

Use the `AskUserQuestion` tool to present an interactive selectable menu. This is MANDATORY — do NOT just print the options as text.

Build the **Continue** option dynamically:
- If the previous session summary describes specific work, use that: `Continue — "making /clear trigger session-start flow"`
- If an active task was found, include its title: `Continue — pick up "Installer MCP Gateway Distribution"`
- If both exist, prefer the session summary (it's more specific) but mention the task too
- If nothing, just say `Continue — resume where we left off`

**IMPORTANT:** Always show the human-readable task TITLE in quotes, never just a task ID.

Example AskUserQuestion call:

```
AskUserQuestion(questions=[{
  question: "What would you like to do?",
  header: "Session",
  multiSelect: false,
  options: [
    { label: "Continue", description: "Pick up \"Installer MCP Gateway Distribution\"" },
    { label: "New task", description: "Create a new ticket on the board" },
    { label: "Pick a task", description: "Choose an existing task from the board" },
    { label: "Just chat", description: "No task — just talk" }
  ]
}])
```

### 5. Wait

Stop after presenting the AskUserQuestion. Do NOT run any other skills until the user responds.

### 6. Route Based on Choice

**IMPORTANT: Follow these routing rules EXACTLY. Do NOT call list_tasks or any other MCP tool unless specified.**

- **Continue** → Immediately run `/kanban-task` using the Skill tool (`skill="kanban-task"`). Do NOT list tasks first. The kanban-task skill will auto-detect the active task and resume it.
- **New task** → Run `/project-management` using the Skill tool (`skill="project-management"`).
- **Pick a task** → Call `get_my_pickable_tasks()` (do NOT use `list_tasks`). Present results as a **numbered list** so the user can type a number to select. Then run `/kanban-task`.
- **Just chat** → Do nothing. Respond naturally to whatever they say next.
- **Other (direct instruction)** → Just do what they asked. No skill needed.

---

**Key principle:** This skill is FAST. One env var check, one register_terminal call, one register_session call (registers this session + closes previous), two parallel MCP calls (get_latest_session with auto-ensure-ready + active task), and an interactive menu. The session lifecycle pipeline guarantees the previous session's summary is available. When routing, go DIRECTLY to the skill — don't add extra steps.

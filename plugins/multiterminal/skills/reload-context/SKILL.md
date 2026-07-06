# reload-context

Reloads session context after /clear. Replicates what the SessionStart hooks inject: terminal identity, kanban tasks, active task details, and last session recap.

Use when: User runs /clear and wants to restore context, or says "reload context", "restore context", "what was I working on".

---

## Instructions

When this skill is invoked, perform ALL of the following steps. Output each section as you go.

### 1. Terminal Identity

Read the environment variable `MULTITERMINAL_NAME`. Output:

```
## Terminal Identity: {name}
You are {name}. Always use "{name}" as your name when registering, claiming tasks, or sending messages.
```

If the env var is not set, state that and continue with the remaining steps.

### 2. Kanban Tasks

Fetch active work only — do NOT fetch done or suggestion tasks:

1. Call `mcp__multiterminal__list_tasks` with status="in_progress"
2. Call `mcp__multiterminal__list_tasks` with status="todo"

From the results, show:
- **My tasks:** Tasks assigned to this terminal (in_progress first, then todo)
- **Unassigned todos:** Only if this terminal has no assigned tasks

Do NOT display done or suggestion tasks — they waste context.

### 3. Active Task Detail

If there's an in_progress task assigned to this terminal, use `mcp__multiterminal__get_task_detail` to fetch its full details including:
- Checklist progress summary
- Continuation notes
- Linked files
- Blocking relationships

### 4. Last Session Recap

Use `mcp__multiterminal__get_latest_session` with the terminal's agent name to fetch the last session summary. This is the same recap source `/session-start` uses — one owner, called from both paths.

Output under `## Last Session Recap`.

### 5. Reminder

Output:
```
IMPORTANT: Keep your active kanban task's continuation notes current (via update_task_continuation) — they are the durable record of work state. ACTIVE-CONTEXT.md is auto-maintained by hooks as an on-demand artifact; you don't need to hand-update it.
```

---

Do NOT run /project-management automatically after this skill. The user just wants context restored, not the full workflow.

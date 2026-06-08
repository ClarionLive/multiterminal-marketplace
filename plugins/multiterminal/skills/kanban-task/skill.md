---
name: kanban-task
description: Orchestrates the kanban task workflow - auto-detects state, guides through planning/coding/testing cycles, enforces gates, and manages continuation notes for seamless session handoffs.
version: 1.0.0
---

# Kanban Task Workflow Orchestrator

This skill manages the full lifecycle of kanban tasks: detect current state, plan work, track progress through coding/testing cycles, write continuation notes, and enforce completion gates. It keeps agents on track without hand-holding.

## When to Use This Skill

Use `/kanban-task` when:
- Starting a session and need to know what to work on
- Planning checklist items for a claimed task
- Updating progress on a checklist item (coding → testing)
- Resuming work after context ran out (reading continuation notes)
- Completing a task (all items must be done)
- You need to know your current task state

## Critical Rules

### ALWAYS
- Write continuation notes after every checklist item transition
- Include notes when moving items from coding → testing (what was done, what to test)
- Check task state before taking any action
- Follow the state machine: pending → coding → testing → done (with cycles allowed)

### NEVER
- Mark a checklist item as "done" yourself - only the user (PM/tester) moves testing → done
- Mark a task as complete if ANY checklist item is not "done"
- Skip the planning phase - every task needs a checklist before coding starts
- Move checklist items backwards yourself (testing → coding is the user's call)
- Work on more than one Active task at a time
- Save plans as external .md files - plans are ALWAYS stored in the task's `plan` field via `mcp__multiterminal__update_task_plan`

---

## Step 1: Detect Current State

Your terminal name is in the `MULTITERMINAL_NAME` environment variable (also shown in the startup hook output as "Terminal Identity"). This is YOUR name — only look at tasks assigned to you.

### Step 1.1: Check for YOUR active task (ONE call)

Use `mcp__multiterminal__get_my_active_task` with `agentName` set to YOUR terminal name (from `MULTITERMINAL_NAME` environment variable or the startup hook's "Terminal Identity" line).

This returns your active in-progress task with full detail (checklist, continuation notes, plan) in a single call. **Do NOT use `list_tasks` for this.**

**If a task is returned** → Store as ACTIVE_TASK. Go DIRECTLY to Step 2A. Do NOT list other tasks.

**If no task returned (404)** → Continue to Check 2.

### Step 1.2: Only if no active task, check for paused or available work

**Check 2:** Use `mcp__multiterminal__list_tasks` with `status="in_progress"`. Filter to find YOUR paused tasks only.
- **Found a paused task** → Store as PAUSED_TASK. Go to Step 2B.
- **None** → Continue to Check 3.

**Check 3:** Use `mcp__multiterminal__list_tasks` with `status="todo"` to find unclaimed tasks.
- **YES** → Store as AVAILABLE_TASKS. Go to Step 2C.
- **NO** → Tell the user: "No active, paused, or available tasks found. The board is clear!"

---

## Step 2A: Active Task Found - What Do You Want to Do?

You already have the full task detail from `get_my_active_task` (Step 1.1). Do NOT call `get_task_detail` again — use the data you already have.

Display a summary to the user:
```
ACTIVE TASK: [title]
Assignee: [assignee] | Helpers: [helpers list]
Checklist: [X of Y items done] | Current item: [first non-done item]
Plan: [show first 2-3 lines of plan if present, or "No plan yet"]
Continuation Notes: [continuation notes if any]
```

If the task has a `plan` field, read it from the task detail. This is the implementation plan - use it to guide your work. Do NOT look for external .md files.

Then present the checklist with current statuses. For each item, call `mcp__multiterminal__get_checklist_item_images` to check if images are attached, and show a count if so:
```
1. [done] Item description
2. [done] Item description
3. [coding] Item description  ← YOU ARE HERE  📎 2 images
4. [pending] Item description
5. [pending] Item description  📎 1 image
```

Use AskUserQuestion to ask:

**Question**: "What would you like to do with this task?"
**Header**: "Action"
**Options**:
1. **Continue working** - "Resume coding the current checklist item"
2. **Update progress** - "Move a checklist item to the next status (e.g., coding → testing)"
3. **Update plan** - "Add, edit, or review checklist items"
4. **Complete task** - "Check if all items are done and mark task complete"

Based on selection, go to the corresponding step:
- Continue working → Step 3
- Update progress → Step 4
- Update plan → Step 5
- Complete task → Step 6

---

## Step 2B: Paused Task Found

Display the paused task info:
```
PAUSED TASK: [title] (paused since [pausedAt])
```

Use AskUserQuestion to ask:

**Question**: "You have a paused task. What would you like to do?"
**Header**: "Resume?"
**Options**:
1. **Resume this task** - "Set this task to Active and continue where you left off"
2. **Pick a new task** - "Leave this paused and grab something from To Do"
3. **View task details** - "See the full checklist and continuation notes first"

If **Resume this task**:
- Use `mcp__multiterminal__set_task_active` with the task id. This auto-pauses any other active tasks.
- Note which tasks were auto-paused (from the response).
- Then go to Step 2A to show full task state and options.

If **Pick a new task**:
- Go to Step 2C.

If **View task details**:
- Use `mcp__multiterminal__get_task_detail` to show full details, then re-ask the question.

---

## Step 2C: No Active Task - Pick from To Do

Display available tasks:
```
AVAILABLE TASKS (To Do):
1. [task-id-short] Task title - [description preview]
2. [task-id-short] Task title - [description preview]
3. [task-id-short] Task title - [description preview]
```

Use AskUserQuestion to ask:

**Question**: "Which task would you like to claim?"
**Header**: "Pick task"
**Options**: List up to 4 available tasks by title.

Once selected:
1. Use `mcp__multiterminal__claim_task` with the task id and your name.
2. Use `mcp__multiterminal__update_task_status` to set status to "in_progress".
3. Use `mcp__multiterminal__set_task_active` to mark it active (auto-pauses others).
4. Tell the user: "Task claimed and set to Active! Now let's plan the work."
5. Go to Step 5 (Plan/Checklist).

---

## Step 3: Continue Working on Current Item

Read the ACTIVE_TASK's continuation notes and checklist to identify the current item (first item with status "coding" or first "pending" item).

If there's a current "coding" item:
- Display: "Continuing: Item [index]: [description]"
- Show the last note on this item (if any) for context.
- Show continuation notes if available.
- **Check for image attachments:** Call `mcp__multiterminal__get_checklist_item_images` with the task ID and item index. If images are returned, analyze them for context — they may contain screenshots of bugs, UI mockups, or test results that are critical for understanding the work. Mention what you see in the images to the user.
- Tell the agent: "Work on this item. When finished, use `/kanban-task` again and select 'Update progress' to move it to testing."

If all items are either "done" or "testing" (waiting on the user):
- Display: "All your items are either done or waiting for user testing. Nothing to code right now."
- Show which items are in "testing" status.

If there's a "pending" item and no "coding" item:
- Ask: "Ready to start the next item? Item [index]: [description]"
- If yes, use `mcp__multiterminal__update_task_checklist` with:
  - taskId: ACTIVE_TASK id
  - itemIndex: the item index
  - newStatus: "coding"
  - notes: "Starting work on this item"
  - updatedBy: your name
- Write continuation notes with `mcp__multiterminal__update_task_continuation`.

### Optional: auto-pace the coding cycle with `/goal`

If you've just left planning and have several checklist items in `pending`/`coding` status, `/goal` (Claude Code v2.1.139+) can **auto-pace** the per-turn loop until every item reaches `testing` — you decide what to do next *only once*, at the start. See `references/goal-integration.md` in this folder for the full design rationale.

> ⚠️ **Security:** This template re-broadcasts task fields (title, description, checklist item text and notes, continuation notes) into a Haiku evaluator transcript on every turn via the `get_task_detail` print. Treat task content as **untrusted input** — only run `/goal` on tasks you authored yourself or have reviewed for prompt-injection-style strings. A maliciously-crafted task description can steer the evaluator and corrupt the stop decision. The Haiku evaluator is the weakest model in the loop and is the most susceptible to coercion.

> ⚠️ **`/goal` is NOT unattended.** It removes the "what should I do this turn?" prompt; it does **NOT** remove per-tool approval prompts (Edit, Bash, MCP writes). Each turn still pauses for tool permission unless you've separately enabled auto-mode. If you want fully unattended runs, combine `/goal` with auto-mode (separate adoption).

**Recommended condition** (copy-paste, then run as written — the structure carries load-bearing safety clauses):

```
/goal Run a coding auto-pace loop for the active kanban task. Follow this sequence:

(1) Initialization: Call mcp__multiterminal__get_my_active_task with your terminal name. If no active task is returned, STOP the goal immediately. Otherwise, use that task ID for all subsequent operations.

(2) Each turn (INCLUDING turn 1): Begin the turn by calling mcp__multiterminal__get_task_detail and printing the full checklist into the conversation, with each item formatted as `<index> | status=<status> | assignedTo=<name-or-null> | cycleCount=<n> | <description>`. All four fields are required — the STOP clauses below reference status, assignedTo, and cycleCount, and the Haiku evaluator can only see fields you've actually printed. If you finish a turn without this exact dump, the evaluator will see stale or incomplete state and the loop will stall — do not skip this step and do not abbreviate the format.

(3) Drive every "pending" or "coding" checklist item to status "testing" by completing the work each item describes and calling mcp__multiterminal__update_task_checklist with a structured completion report. Process items in order, but SKIP any item whose `assignedTo` is another helper (not you).

(4) Do NOT mark any item "done" — that is the PM's call, not the agent's. Items already in "done" before the goal started should be ignored, not re-driven.

STOP the goal if ANY of these hold:
  - Every "pending"/"coding" item has reached "testing".
  - 25 turns have elapsed.
  - The pipeline ran and routed items back to coding — pipeline bouncebacks need human triage, not another auto-pace pass.
  - Any item's cycleCount reaches 4 or more — per kanban-task Step 4.8, that is an escalation gate requiring user discussion.
```

**Token-spend note:** the 25-turn cap is on turns, not tokens. Each turn re-broadcasts the full checklist (and growing transcript) to the Haiku evaluator; for long-running tasks watch the `◎ /goal active` overlay's token-spend field and `/goal clear` early if it climbs faster than expected.

**Troubleshooting** — `/goal` fails silently on multiple paths. If the loop is misbehaving:
- **Pre-v2.1.139 Claude Code build:** the command is unrecognized; check `claude --version`. v2.1.139+ required.
- **Workspace trust off / `disableAllHooks: true`:** the evaluator runs as a Stop hook and silently no-ops. Confirm workspace trust is accepted and `disableAllHooks` is `false` in settings.
- **Fast-model provider outage:** the configured small fast model (Haiku by default) may be unavailable; the loop may not stop or may fall through to a larger model with elevated token cost.
- **Oscillating no-progress loop:** agent prints checklist, evaluator says "no, keep working", agent does nothing actionable, repeat. `/goal clear` and re-issue with a smaller turn cap or sharper condition.
- **After `--resume`:** the goal's condition carries forward but the 25-turn counter RESETS. Re-`get_task_detail` immediately on the first turn after resume so the evaluator's view of state is fresh.

**Why these clauses:**
- **G1 — Evaluator can't query SQLite.** The "print the checklist each turn" clause is what makes the condition verifiable. Without it, the evaluator sees stale state and the loop stalls.
- **PM gate preservation.** The "do NOT mark done" clause + the explicit "ignore items already done" wording prevents an over-eager loop from calling `update_task_checklist newStatus: done` and burning turns on API rejections.
- **Pipeline-rebounce stop.** When the last item reaches testing, the pipeline auto-triggers; if the pipeline routes items back to coding, those are quality concerns the auto-pace can't fix — keep the human in the loop.
- **cycleCount escalation.** Step 4.8 says 4+ cycles needs user discussion. Without this stop clause the auto-pace would grind past the escalation gate silently.
- **25-turn cap.** `/goal` has no built-in turn budget; bound it in the condition itself.

**Out of scope for the loop:** the pipeline runs *after* the goal's stop condition is met (the pipeline-trigger-hook fires when all items reach testing). Don't include "run the pipeline" in the goal — let the existing hook fire it. The goal's only job is to move the checklist forward; the pipeline judges quality afterward.

---

## Step 4: Update Progress (Move Checklist Item Forward)

This step handles the coding → testing transition. This is the most important gate.

### Step 4.1: Identify the Item

Show all items currently in "coding" status. If there's only one, select it automatically. If multiple, ask which one.

### Step 4.2: Require Structured Completion Report

Before transitioning coding → testing, you MUST provide a **structured completion report** — not vague notes. Use this format:

```
FILES CHANGED:
- [path/to/file.cs] — [what changed and why]

FUNCTIONS ADDED/MODIFIED:
- [ClassName.MethodName()] — [added|modified] — [purpose]

WHAT WAS SKIPPED:
- [anything from the plan NOT implemented, with reason, or "Nothing"]

KNOWN LIMITATIONS:
- [edge cases, TODOs, or constraints, or "None"]

WHAT TO TEST:
- [specific behavior the tester should verify]
- [expected vs previous behavior]
```

**Every field is required.** Do NOT use vague notes like "implemented the feature" or "done". The PM uses this report to verify completeness before testing.

Use AskUserQuestion if the agent hasn't provided a structured report:

**Question**: "Provide a structured completion report for this item (files changed, functions modified, what to test)"
**Header**: "Report"
**Options**:
1. **I'll write it** - "Let me fill out the structured completion report"
2. **Auto-generate from recent work** - "Summarize based on files I just modified"

### Step 4.3: Link Changed Files to the Task

After writing the completion report, you MUST call `mcp__multiterminal__link_task_file` for **every file** listed in the FILES CHANGED section. This creates structured file links that the code review panel and other agents can query — plain text in notes is not enough.

For each file:
```
mcp__multiterminal__link_task_file(
  taskId: ACTIVE_TASK id,
  filePath: absolute path to the file,
  addedBy: your name,
  description: what changed and why (from the completion report)
)
```

**Rules:**
- Use absolute paths (e.g., `H:\DevLaptop\ClarionPowerShell\MultiTerminal\Services\MyService.cs`)
- Include the description from your FILES CHANGED list — it helps reviewers
- If you modified many files, link ALL of them — don't skip any
- Duplicate links are safe (the API handles idempotency)

### Step 4.4: Transition the Item

Use `mcp__multiterminal__update_task_checklist` with:
- taskId: ACTIVE_TASK id
- itemIndex: the item index
- newStatus: "testing"
- notes: the notes from Step 4.2
- updatedBy: your name

If the API rejects the transition (invalid state), display the error and explain why.

### Step 4.5: Auto-Write Continuation Notes

After every checklist transition, automatically write continuation notes:

Use `mcp__multiterminal__update_task_continuation` with:
- taskId: ACTIVE_TASK id
- continuationNotes: A summary including:
  - Current checklist progress (X of Y done, Z in testing)
  - Which item was just moved to testing
  - What the next pending item is (if any)
  - Any blockers or decisions pending
- updatedBy: your name

Tell the user:
```
Item [index] "[description]" moved to TESTING.
Continuation notes updated.
Checklist: [X done, Y testing, Z pending] of [total] items.
Next item: [next pending item description, or "All items submitted - waiting on user testing"]
```

### Step 4.6: Pipeline Gate — AUTO-TRIGGER (When All Items Reach Testing)

After transitioning an item, check if ALL items are now in "testing" or "done" status (no more "pending" or "coding"). If so, **automatically run the pipeline** — do NOT wait for permission, do NOT ask the user. The pipeline must pass before the user tests anything.

**Auto-trigger sequence:**
1. Announce: "All checklist items are in testing. Auto-triggering the review pipeline..."
2. Invoke the pipeline skill immediately: `Skill(skill="pipeline")`
3. The pipeline runs: Verifier first (must pass), then Code Reviewer + Security Auditor + Debugger in parallel
4. If pipeline passes → proceed to Step 4.6 (save testing instructions)
5. If pipeline fails → failures route back as coding items automatically (the pipeline skill handles this)

**IMPORTANT:** This is fully automated. The agent does NOT need to be "team lead" — any agent that moves the last item to testing triggers the pipeline. The `pipeline-trigger-hook.js` PostToolUse hook also watches for this condition as a safety net, so even if the skill logic is skipped, the hook will remind you.

### Step 4.7: Save Testing Instructions (When Pipeline Passes)

After transitioning an item, check if ALL items are now in "testing" or "done" status (i.e., no more "pending" or "coding" items remain). If so, save a testing checklist to the task's `testResults` field so testers can see what to verify:

Use `mcp__multiterminal__update_task_summary` (or REST API `PATCH /api/tasks/{taskId}/summary`) with:
- testResults: A markdown checklist of what to test, covering:
  - Each testable feature/behavior from the checklist items
  - Step-by-step instructions for manual verification
  - Any edge cases to watch for
- updatedBy: your name

This ensures testing instructions are **saved on the card** (visible in the lifecycle board's Testing column phase notes), not just printed in chat.

**When to write:** Only when the last coding item moves to testing (the "batch is ready" moment). Don't rewrite on every individual item transition.

### Step 4.8: Check for Escalation

If the item's cycleCount is 4 or more after this transition, flag it:
```
WARNING: Item [index] "[description]" has cycled [N] times between coding and testing.
This item may need a discussion with the user to clarify requirements.
```

---

## Step 5: Plan / Update Checklist

This step creates or updates the checklist for the active task.

### Step 5.1: Check Current State

Use `mcp__multiterminal__get_task_detail` to see if a checklist already exists.

If checklist exists and has items:
- Display current checklist.
- Use AskUserQuestion:
  **Question**: "The checklist already has items. What would you like to do?"
  **Header**: "Plan"
  **Options**:
  1. **Add items** - "Add new checklist items to the existing list"
  2. **Replace all** - "Start fresh with a new checklist (WARNING: replaces existing)"
  3. **View and continue** - "Keep the current plan and start working"

If no checklist exists:
- Tell the user: "This task needs a plan before coding can begin."
- Continue to Step 5.2.

### Step 5.2: Create the Plan

Analyze the task title and description. Break it down into two parts:

**Part A: Implementation Plan (markdown)**
Write a concise implementation plan covering:
- Approach / architecture decisions
- Key files to modify or create
- Dependencies or risks
- Any exploration findings (existing infrastructure to reuse)

This is the strategic "how" - it goes into the task's `plan` field.

**Part B: Checklist Items**
Break the plan into concrete, actionable checklist items.

Guidelines for good checklist items:
- Each item should be a single, testable unit of work
- Use the agent's judgment on granularity
- Items should be ordered by dependency (do foundational work first)
- Each item description should be clear enough that another agent could pick it up

Present BOTH the plan text and the proposed checklist to the user for approval before saving.

### Step 5.3: Save the Plan

Save the implementation plan directly to the task using `mcp__multiterminal__update_task_plan`. The plan is stored as markdown text in the task's `plan` database field - do NOT save it as an external .md file.

For each checklist item, ensure it has the correct format:
```json
{
  "item": "Description of the work",
  "status": "pending",
  "done": false,
  "notes": [],
  "assignedTo": null,
  "cycleCount": 0
}
```

Write continuation notes summarizing the plan.

Tell the user: "Plan saved with [N] checklist items. Ready to start coding! Use `/kanban-task` to begin the first item. If you have multiple items and want auto-pacing rather than per-turn prompting, see Step 3's `/goal` subsection before starting."

---

## Step 6: Complete Task

This step runs ALL completion gates before allowing the task to be marked done.

### Step 6.1: Run Completion Gates

Use `mcp__multiterminal__get_task_detail` to get the full task state.

Run these checks:

**Gate 1: All Items Done?**
Check that EVERY checklist item has `status: "done"`.
- If ANY item is not "done", STOP and display:
  ```
  CANNOT COMPLETE: [N] item(s) are not done yet:
  - Item [index]: "[description]" - status: [status]
  - Item [index]: "[description]" - status: [status]
  ```
- List what's blocking completion.

**Gate 2: No Items in Coding?**
If any item is still in "coding" status, the agent needs to finish or submit for testing first.

**Gate 3: No Items in Testing?**
If any item is in "testing" status, the user needs to approve them first. Display:
```
WAITING ON USER: [N] item(s) still in testing:
- Item [index]: "[description]" - awaiting user testing
```

### Step 6.2: Mark Complete

If ALL gates pass:
1. Use `mcp__multiterminal__update_task_status` with status "done".
2. Write final continuation notes: "Task completed. All [N] checklist items done."
3. Use `mcp__multiterminal__update_task_summary` with a final implementation summary.

Tell the user:
```
TASK COMPLETE: "[title]"
All [N] checklist items verified and done.
Final summary written.
```

Then check: are there more tasks in To Do? If so, offer to pick the next one (go to Step 2C).

---

## Handling User Actions

When the user sends items back from testing → coding (with notes about what needs fixing):

The agent should:
1. Read the user's notes on the item (visible in the checklist item's notes history).
2. **Check for image attachments:** Call `mcp__multiterminal__get_checklist_item_images` with the task ID and item index. The user may have attached screenshots showing the exact issue — a visual bug, incorrect behavior, or UI problem. Describe what you see in the images before starting the fix.
3. Understand what needs to be fixed (combining notes + images).
4. Work on the fix.
5. When done, use Step 4 (Update Progress) to move it back to testing with new notes.

When the user marks items testing → done:
- The item is complete. Move on to the next pending/coding item.
- If that was the last item, proceed to Step 6 (Complete Task).

---

## Session End / Context Running Out

Before the session ends or if context is running low:

1. Write comprehensive continuation notes using `mcp__multiterminal__update_task_continuation`:
   - Which file(s) were being edited (and line numbers if possible)
   - Current checklist item being worked on
   - What's done, what's in progress, what's next
   - Any blockers or decisions pending
   - Any uncommitted work or partial changes

2. This ensures the next session can pick up seamlessly via Step 1 → Step 2A.

---

## Important Notes

- The state machine is enforced server-side by the `update_task_checklist` API. If you attempt an invalid transition, it will be rejected with an error message. Trust the API.
- Only ONE task should be Active at a time. The `set_task_active` API handles auto-pausing others.
- The user is the PM and tester. They control: testing → coding (send back) and testing → done (approve). Agents cannot make these transitions.
- Continuation notes are your lifeline for session handoffs. Write them often.
- After 4 coding/testing cycles on a single item, flag it for discussion - something may be unclear in the requirements.
- Helpers can be assigned to specific checklist items. Each helper sees and works on their assigned items.

## Troubleshooting

### "Invalid transition" error from update_task_checklist
**Problem:** You tried to move an item to a status that isn't valid from its current status.
**Solution:** Check the item's current status first. Valid transitions: pending→coding, coding→testing. Only the user can do: testing→coding, testing→done.

### "Task not found" error
**Problem:** The task ID doesn't match any task in the database.
**Solution:** Use `list_tasks` to get current task IDs. Task IDs may have changed if tasks were recreated.

### "Notes required" error
**Problem:** You tried to move an item to testing without providing notes.
**Solution:** Always include notes describing what was done when moving coding→testing.

### All items stuck in "testing"
**Problem:** Everything is waiting on the user to test.
**Solution:** This is normal! Let the user know items are ready. Check if any items were sent back to coding that you missed.

# Specialist Agent Spawn Templates

Fire-and-forget subagents (NOT team members). They return results directly to the PM. Fill in all `[bracketed]` placeholders before use.

**Model default:** All agents use Opus.

---

## Devils Advocate (LARGE tasks, after planning)

Scores plans 0-100 and challenges assumptions. Blocks bad ideas before coding starts.

```
Task(
  subagent_type="devils-advocate",
  name="Devils Advocate",
  prompt="Review this plan and score it 0-100. Challenge every assumption.

  TASK: [title]
  PLAN: [full plan markdown]
  CHECKLIST: [all items]
  CODEBASE CONTEXT: [key files and patterns]"
)
```

**Handle the score:**
- **70-100 (PROCEED):** Note warnings in the plan, continue to Team Assembly.
- **50-69 (REVISE):** Update plan addressing concerns. Re-present to user. Do NOT re-run DA.
- **0-49 (RETHINK):** Present concerns to user. Discuss alternatives. May need more research.

---

## Test Designer (MEDIUM & LARGE tasks, during checklist creation)

Generates acceptance criteria so coders and tester share the same definition of "done."

```
Task(
  subagent_type="test-designer",
  name="Test Designer",
  prompt="Review this plan and checklist, then design test criteria for each item.

  TASK PLAN: [plan markdown]
  CHECKLIST ITEMS: [list of items]
  CODEBASE CONTEXT: [relevant files and patterns]"
)
```

Returns: observable pass/fail criteria, manual test steps, edge cases, regression risks. Append to the plan or checklist item descriptions.

---

## Verifier (MEDIUM & LARGE tasks, before code review)

Confirms work is genuinely complete before wasting the reviewer's time.

```
Task(
  subagent_type="verifier",
  name="Verifier",
  prompt="Verify that all coding work is complete for task '[TaskTitle]' (ID: [taskId]).

  CHECKLIST ITEMS IN TESTING: [list with transition notes showing changed files]
  TASK PLAN: [plan field]

  Check: files exist, changes are present, no TODOs/placeholders, build compiles."
)
```

Parse the last line for `VERDICT: PASS`, `VERDICT: FAIL`, or `VERDICT: PARTIAL`.
- **PASS:** Proceed to Code Review.
- **FAIL:** Route issues back to coding agents, re-run after fixes.
- **PARTIAL:** Review what couldn't be verified. Proceed if acceptable, otherwise address gaps.

---

## Security Auditor (LARGE tasks, parallel with Code Review)

Scans for OWASP Top 10 and architecture-specific vulnerabilities.

```
Task(
  subagent_type="security-auditor",
  name="Security Auditor",
  prompt="Audit the code changes for task '[TaskTitle]' (ID: [taskId]).

  FILES CHANGED: [list from checklist testing notes]
  TASK PLAN: [plan field]

  Focus on: SQL injection (SQLite), XSS (WebView2 HTML), command injection (process spawning),
  input validation (REST API), path traversal (file operations), message spoofing (MessageBroker)."
)
```

**PASS / PASS WITH WARNINGS:** Note warnings, proceed. **BLOCK (CRITICAL/HIGH):** Route to coding agents, re-audit after fix.

---

## Debugger (MEDIUM & LARGE tasks, when testing fails)

Root cause analyst — finds the real problem, not just symptoms.

```
Task(
  subagent_type="debugger",
  name="Debugger",
  prompt="Diagnose the root cause of this failure for task '[TaskTitle]' (ID: [taskId]).

  FAILED ITEM: Item [index]: [description]
  FAILURE NOTES FROM TESTER: [tester's notes]
  CODING NOTES: [what the agent said they changed]
  TASK PLAN: [plan field]

  Trace the code path, find the root cause (not the symptom),
  check for pattern spread, and produce targeted fix instructions."
)
```

Route the Debugger's diagnosis to the assigned coding agent with specific fix instructions.

---

## Session Distiller (after task completion, background)

Compresses session learnings into persistent memory files.

```
Task(
  subagent_type="session-distiller",
  name="Session Distiller",
  run_in_background=true,
  prompt="Distill learnings from this completed task into persistent memory.

  TASK: [title] (ID: [taskId])
  PLAN: [plan field]
  SUMMARY: [implementation summary]
  TEST RESULTS: [test results]

  Check existing memory files in the project memory directory before writing.
  Save: stable patterns, architecture decisions, debugging insights, anti-patterns.
  Skip: session-specific state, one-time fixes, speculative conclusions.
  Merge into existing entries. Don't duplicate."
)
```

This runs in the background. Don't block on it.

---

## Session Summarizer (Session start, when no cached summary)

Generates a concise recap of the previous session from raw messages. Saves it to SQLite so future sessions load instantly.

```
Agent(
  subagent_type="session-summarizer",
  name="_Summarizer",
  prompt="Generate a session recap from these messages and save it.

  SESSION ID: [sessionId]
  PROJECT: [project name]

  RECENT ASSISTANT MESSAGES (newest first):
  [paste 15-20 assistant messages from recentMessages array]

  After generating the summary, save it using mcp__multiterminal__update_session_summary
  with sessionId='[sessionId]' and your generated summary text.
  Then return the summary."
)
```

This runs at session start (Step 0 of project-management). Should complete in under 10 seconds. If it takes longer, display raw messages and move on.

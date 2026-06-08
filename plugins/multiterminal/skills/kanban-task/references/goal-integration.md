# Design memo: `/goal` and the kanban-task workflow

Status: Approved + Run 2 revisions applied (PM signed off on Option (b) + Step 3 placement; v2 template landed after Run 1 pipeline review surfaced 4 HIGH design flaws — see "Notes on Run 2 revision" in §4.)
Source ticket: kanban `057ee788` ("[Digest] Adopt /goal command for MT task loops")
Claude Code version: v2.1.139+ (changelog 2026-05-11)
Author: Diana
Audience: maintainers of `skills/kanban-task/SKILL.md` and the MT pipeline

## TL;DR

`/goal` is a Claude Code primitive that wraps a session-scoped prompt-based Stop hook around an editor loop, with a Haiku-class evaluator deciding whether a natural-language completion condition is met after each turn. It does not call tools and only sees the conversation transcript.

It composes with — does **not** replace — the kanban-task flow. The hard collision is that the workflow forbids the agent from moving items into `done` (that's the PM's gate). The clean composition is "drive coding through the checklist until every item reaches `testing`, then stop and let the pipeline run." Continuation notes and `/goal` are complementary (inter-session vs. intra-session).

**Recommendation:** Option (b) — add an optional "Auto-pace via `/goal`" subsection to kanban-task `SKILL.md` Step 3, with a recommended condition template that respects the workflow's human gates. Keep the integration loosely coupled; do not wire `/goal` into the mandatory flow.

## 1. What `/goal` actually does

`/goal <condition>` declares a completion condition and runs a chain of turns until that condition holds, replacing the per-turn "now what?" prompt with a per-turn "are we there yet?" check.

**Lifecycle (per turn):**

1. Claude finishes a turn.
2. A small fast model (Haiku by default) receives `(condition, full conversation so far)` and returns `{ met: yes|no, reason: <one line> }`.
3. If `met: no` → Claude starts another turn with the reason as guidance.
4. If `met: yes` → the goal clears, an "achieved" entry is recorded in the transcript, and control returns to the user.

**Surface:**

- Triggered with `/goal <condition>`; one goal per session; new replaces old.
- Condition: natural-language string, up to 4,000 chars. Can include time/turn clauses (e.g. "…or stop after 20 turns").
- Status overlay: `◎ /goal active`, elapsed time, turns evaluated, current token spend, last evaluator reason.
- Inspect: `/goal` with no argument shows the current or most-recent-achieved goal's status.
- Clear early: `/goal clear` (also `stop`, `off`, `reset`, `none`, `cancel`, and `/clear`).
- Modes: works in interactive, `-p` (non-interactive), and Remote Control. Ctrl+C interrupts `-p`.
- Resume: a still-active goal carries forward through `--resume`/`--continue`, but the elapsed-time / turn-count / token-spend counters reset.

**Requirements:**

- Workspace trust must be accepted (because `/goal` rides the hooks system).
- `disableAllHooks` must not be set in managed policy. If it is, `/goal` tells you why instead of silently doing nothing.

**Important property — the evaluator cannot call tools.** It judges your condition solely against what Claude has already surfaced in the transcript. Conditions that depend on filesystem or database state are only verifiable if Claude has read and printed that state into the conversation on the current turn.

**Cost:** evaluator runs on the configured small fast model; per the docs, evaluation tokens are "typically negligible compared to main-turn spend."

**Related autonomous-workflow primitives** (per the docs comparison table):

| Approach | Next turn starts when | Stops when |
|---|---|---|
| `/goal` | Previous turn finishes | Model confirms condition is met |
| `/loop` | Time interval elapses | User stops, or Claude decides done |
| Stop hook (custom) | Previous turn finishes | Your own script or prompt decides |
| Auto mode | (per-tool, not per-turn) | Claude judges work done |

`/goal` is the right tool when "is this done?" needs a fresh-model second opinion *and* the answer is observable from the conversation surface.

## 2. Where `/goal` overlaps with kanban-task

Mapping `/goal` capabilities to kanban-task's steps:

| kanban-task surface | `/goal`-relevant action | Verdict |
|---|---|---|
| Step 1 (detect state) + Step 2A (action menu) | User-driven prompt-and-respond | NEITHER OVERLAP NOR REPLACE. The user picks the action; `/goal` doesn't enter the picture. |
| Step 3 (Continue Working on Current Item) | Many tool-using turns until ready for testing | **OVERLAP.** `/goal` could auto-pace the per-turn pacing. Today the agent self-paces. |
| Step 4 (Update Progress: coding → testing) | Single-shot transition + structured report | NOT A GOAL TARGET. One decision, not a loop. |
| Step 5 (plan / checklist creation) | Single-turn decision with user review | NOT A GOAL TARGET. |
| Step 6 (Complete task: testing → done) | NEVER agent-driven; PM-only | **HARD COLLISION.** `/goal`'s Haiku evaluator cannot replace the PM. Any condition aiming at "done" would violate the workflow. |
| Continuation notes (cross-step) | Inter-session handoff mechanism | NOT OVERLAPPING — complementary. Continuation notes hand off between sessions; `/goal` lives inside one session. |
| Pipeline auto-trigger (Step 4.6) | Fires when all items reach testing | **COMPOSES CLEANLY.** A condition like "every checklist item has reached testing" stops the loop right where the pipeline kicks in. The goal does not need to manage the pipeline itself. |

### Two gotchas worth pulling forward

**(G1) The evaluator can't read SQLite.** kanban-task state lives in the MultiTerminal SQLite via the MCP server. For a `/goal` condition like "every item is in testing" to be evaluable, the agent must dump the current checklist state into the transcript each turn — typically by calling `get_task_detail` and printing it. Without that, the evaluator has no visibility into the data the condition references and the loop will either spin (always "no") or terminate falsely.

**(G2) `/goal` is intra-session; the workflow is multi-session.** Continuation notes exist because MT sessions are bounded — context fills up, a teammate hands off, an agent is paused. `/goal` cannot bridge those boundaries. If the loop hits `Stop` mid-task it carries forward on `--resume` but loses its counters; if the agent hands off to another teammate via continuation notes, the goal does not transfer. So `/goal` is best understood as a *batch coding aid for one session*, not a workflow-level abstraction.

## 3. Three integration options

### Option (a) — Ignore

Treat `/goal` as a Claude Code primitive that users can discover and use on their own. Make no changes to kanban-task or any other MT skill.

| | |
|---|---|
| **Pros** | Zero coupling. Zero maintenance surface. Avoids the gotchas in §2 entirely — users who reach for `/goal` already know what they want it for. The /skills menu surfaces `/goal` natively. |
| **Cons** | We lose the chance to standardize the condition template, so users who try it will invent their own conditions — some of which will violate the testing→done gate or get tangled in the evaluator-can't-see-SQLite trap. No discoverability handoff from kanban-task to `/goal`. |

### Option (b) — Suggest in skill prose (RECOMMENDED — see §4)

Add a short, optional "Auto-pace via `/goal`" subsection to kanban-task `SKILL.md` (most naturally in Step 3 "Continue Working on Current Item"). The subsection:

- Explains the use case: batch-progressing multiple coding-state items in one session.
- Provides a recommended condition template that respects the PM gate ("…stop when every item is in testing, not done").
- Calls out the two gotchas in §2 explicitly with mitigations:
  - **G1 mitigation:** the recommended condition tells the agent to dump checklist state into each turn.
  - **G2 mitigation:** notes that `/goal` is intra-session; continuation notes still handle handoff.
- Notes the prerequisites (workspace trust, `disableAllHooks: false`).
- Does *not* alter the mandatory flow — agents who don't use `/goal` continue exactly as today.

| | |
|---|---|
| **Pros** | Cheap. Additive. Captures the affinity without coupling. Standardizes the condition pattern so the next person isn't reinventing it. Survives doc-rot reasonably well because the template is a copy-pasteable snippet. |
| **Cons** | Prose suggestions are easy to skim past — agents may not notice the subsection until they re-read the skill. The template itself will need to be revised if the kanban-task flow changes (e.g., if "testing" gets sub-states). |

### Option (c) — Wire `/goal` into the skill flow

Have kanban-task explicitly issue `/goal <generated-condition>` when transitioning from Step 5 (planning) to Step 3 (coding), with the condition built programmatically from the active checklist.

| | |
|---|---|
| **Pros** | Highest automation. Agent never has to think about whether to use `/goal`. |
| **Cons** | Heavy coupling between kanban-task and `/goal`'s semantics. The flow's human gates and `/goal`'s loop have to agree on what "done" means at every layer — the testing→done collision becomes load-bearing. Hides errors: a malformed condition fires before the user can see it. Adds a runtime dependency on hooks being enabled (a deployment can lose `/goal` silently if `disableAllHooks` is later set). The pipeline already auto-fires when all items reach testing, so the marginal win over option (b) is small. |

## 4. Recommendation

**Adopt Option (b).** Specifically:

1. Add a new subsection to `skills/kanban-task/SKILL.md` Step 3 titled "Optional: auto-pace the coding cycle with `/goal`". (Originally drafted with the word "autopilot"; renamed to "auto-pace" in Run 2 — see Notes on this revision below — because `/goal` removes the per-turn "what next?" prompt but does *not* remove per-tool approval prompts; "autopilot" overpromises.)
2. Body of the subsection mirrors the SKILL.md content (see `kanban-task/SKILL.md` Step 3 for the canonical version). The load-bearing artifacts are:
   - A **security callout** above the template warning that task fields (title, description, checklist notes, continuation notes) get re-broadcast into the Haiku evaluator transcript every turn — task content must be treated as untrusted input.
   - An **auto-mode dependency callout** stating `/goal` does not bypass per-tool approval prompts.
   - The recommended condition template (canonical in SKILL.md):

   > ```
   > /goal Run a coding auto-pace loop for the active kanban task. Follow this sequence:
   >
   > (1) Initialization: Call mcp__multiterminal__get_my_active_task with your terminal name. If no active task is returned, STOP the goal immediately. Otherwise, use that task ID for all subsequent operations.
   >
   > (2) Each turn (INCLUDING turn 1): Begin the turn by calling mcp__multiterminal__get_task_detail and printing the full checklist into the conversation, with each item formatted as `<index> | status=<status> | assignedTo=<name-or-null> | cycleCount=<n> | <description>`. All four fields are required — the STOP clauses below reference status, assignedTo, and cycleCount, and the Haiku evaluator can only see fields you've actually printed. If you finish a turn without this exact dump, the evaluator will see stale or incomplete state and the loop will stall — do not skip this step and do not abbreviate the format.
   >
   > (3) Drive every "pending" or "coding" checklist item to status "testing" by completing the work each item describes and calling mcp__multiterminal__update_task_checklist with a structured completion report. Process items in order, but SKIP any item whose `assignedTo` is another helper (not you).
   >
   > (4) Do NOT mark any item "done" — that is the PM's call, not the agent's. Items already in "done" before the goal started should be ignored, not re-driven.
   >
   > STOP the goal if ANY of these hold:
   >   - Every "pending"/"coding" item has reached "testing".
   >   - 25 turns have elapsed.
   >   - The pipeline ran and routed items back to coding — pipeline bouncebacks need human triage, not another auto-pace pass.
   >   - Any item's cycleCount reaches 4 or more — per kanban-task Step 4.8, that is an escalation gate requiring user discussion.
   > ```

   - A **token-spend hedge** noting the cap is on turns not tokens; transcript grows each turn.
   - An **expanded troubleshooting block** covering five silent-failure paths: pre-v2.1.139 build, workspace trust off / `disableAllHooks`, fast-model outage, oscillating no-progress loop, and the `--resume` counter-reset behavior.
   - A **why-these-clauses** block tying each load-bearing rule (G1 evaluator-blind, PM-gate, pipeline-rebounce-stop, cycleCount-escalation-stop, 25-turn cap) back to the original failure mode it prevents.

3. **Step 5.3 pointer.** SKILL.md's "ready to start coding!" line at the end of plan creation now points multi-item users at the Step 3 `/goal` subsection — the auto-pace's natural audience arrives via that handoff, not via Step 2A's single-item "Continue working" option.
4. No code changes — no `agents/` edits, no `hooks.json` edits, no kanban-task workflow rule changes.

### Rationale

The kanban-task workflow has two layers of gates: agent-side (pending → coding → testing) and PM-side (testing → done, plus testing → coding bouncebacks). `/goal` is a useful auto-pace tool for the agent-side layer but **must not** touch the PM-side. Option (b) puts the right tool in the agent's reach with the right rails (condition template, security callout, auto-mode caveat, stop-on-pipeline-rebounce, stop-on-cycleCount-escalation), keeps the workflow's authority intact, and avoids the trap that option (c) would set: making `/goal` load-bearing inside the skill and then discovering, six months later, that a settings drift or a Claude Code version pinning issue silently broke the auto-pace.

The pipeline composition story is also clean: the goal stops at "all items in testing" → the existing PostToolUse hook fires the pipeline → the pipeline produces verdicts → the PM stamps testing → done. Each layer keeps its own surface; they touch only through the database. **Pipeline bouncebacks specifically are NOT re-driven by the auto-pace** — that's the H-D1 stop clause's job.

### Notes on Run 2 revision

The Run 1 pipeline review (Debugger FAIL + Adversary PASS_WITH_WARNINGS) surfaced four HIGH design flaws in the v1 template that this revision addresses:

- **H-D1 (pipeline-rebounce trap):** v1 stop set was "testing OR done OR 25 turns"; pipeline-injected coding items would silently extend the loop. v2 adds an explicit stop clause for "pipeline ran and routed items back."
- **H-D2 (escalation-gate bypass):** v1 had no cycleCount awareness. v2 adds a stop clause at cycleCount ≥4 mirroring SKILL.md Step 4.8's human-discussion rule.
- **H-A1 ("autopilot" overpromise):** v1 used the word "autopilot" in heading and body; v2 renames to "auto-pace" and adds an explicit callout that `/goal` does not bypass per-tool approval prompts.
- **H-A2 (Step 3 placement misses audience):** v1's Step 3 subsection was only reachable via Step 2A's singular-item "Continue working" option. v2 adds a pointer from Step 5.3 (plan-finalization) so multi-item users see the auto-pace option at the handoff point.

Plus the v2 template also fixes 4 MEDIUM gaps (first-turn state-read explicit, active-task resolution via `get_my_active_task`, drop "or done" from stop set per Adversary M, helper-assigned items skipped) and lands the Security MEDIUM as a boxed callout above the template (M1 + M2 combined: get_task_detail re-broadcasts untrusted task content; only run on tasks you authored or reviewed).

## 5. Open questions for PM — resolved

1. **SKILL.md placement.** Resolved: Step 3. PM confirmed: places the subsection before the agent commits to a long loop, so the auto-pace is discoverable up front.
2. **Agents/ mention.** Resolved: skip. `/goal` is a user-invoked primitive, not an agent-invoked one. Agents wrapping themselves in goal evaluators on their own initiative is a misuse of the leverage tool.
3. **Telemetry overlay.** Resolved: deferred to backlog. The `/goal` status overlay → MT terminal status display integration is a separate concern from skill flow and gets its own ticket if there's appetite later.

## 6. Out of scope

- Custom kanban-specific Stop hook (would replace `/goal`'s evaluator with our own kanban-aware logic). Overkill for the v1 adoption.
- Bridging `/goal`'s session scope to MT's multi-agent coordination model (different abstractions; would require a server-side concept of "team goal" that doesn't exist).
- The agent-view overlay → terminal-status display feed (digest item 4) — separate ticket if PM wants it.
- Auto-mode adoption (digest doesn't cover it explicitly, but it's the natural sibling to `/goal` for unattended runs). Worth flagging if a future ticket asks for "fully unattended kanban".

### Known limitations (shipped — deferred to real-world feedback)

The Run-2 pipeline surfaced four findings that the Run-3 pass intentionally did **not** fix. They are documented here so first adopters know what to look for and so future maintainers don't re-discover the analysis. Each is deferred until adoption produces real-world feedback (which is the only thing that can productively prioritize them).

- **STOP-clause precedence undefined when (3) pipeline-rebounce and (4) cycleCount ≥4 coincide** — When both stops hold simultaneously, the Haiku evaluator cites whichever it scans first; user gets "fix quality" or "renegotiate scope" diagnosis non-deterministically. Both stops still fire — only the diagnostic narration is affected, not the stop behavior. Defer until a user reports the diagnostic mismatch creates real confusion.
- **"Auto-pace" heading may inoculate against reading the "NOT unattended" callout** — A user attracted by the heading word may skip to the code fence before reading the boxed caveat about per-tool approvals. Defer until adoption data tells us whether real users skip the callout.
- **Step 5.3 pointer is a single sentence inside a 3-sentence finalizer** — Plan-finalization message ends "Plan saved with N items. Ready to start coding! ...see Step 3's `/goal` subsection before starting." A user who stops reading at "Ready to start coding!" misses the pointer. Defer until adoption data tells us whether multi-item planners actually discover the auto-pace.
- **No empirical end-to-end test of the v2 template** — Pipeline gates analyze the doc, not `/goal`'s live behavior. The actual evaluator interpretation of the recommended condition is unverified. Closed by the first real adoption, not by another review cycle.

The discipline going forward: triage findings by **defect class**, not severity tag. "Fix doesn't function" is a blocker; "could be more elegant" is a ship + listen signal.

## 7. Sources

- Claude Code v2.1.139 changelog (release 2026-05-11): `https://code.claude.com/docs/en/release-notes/cli#2.1.139` (via the local KB chunk `Changelog v2.1.139`).
- Claude Code `/goal` reference: `https://code.claude.com/docs/en/goal`.
- Claude Code commands reference (mentions `/goal [condition|clear]` in the master table): `https://code.claude.com/docs/en/commands`.
- This plugin's `skills/kanban-task/SKILL.md` (current behavior the memo describes).

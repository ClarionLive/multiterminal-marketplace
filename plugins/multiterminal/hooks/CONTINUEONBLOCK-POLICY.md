# PostToolUse `continueOnBlock` Policy

Claude Code v2.1.139 added a `continueOnBlock` option to PostToolUse hook configs. When `continueOnBlock: true`, a hook's block decision flows back to Claude as feedback inside the same turn instead of killing the turn. The default (`false`) is the legacy hard-block behavior.

This document defines MultiTerminal's policy for when to use the flag. The current `hooks.json` does **not** set `continueOnBlock` on any leaf because none of MT's current PostToolUse hooks issue block decisions today; the policy is forward-looking and applies when a hook starts blocking — either an existing hook gaining a block branch, or a new hook being added.

Companion doc: see `HOOKS-MIGRATION.md` (this folder) for the v2.1.139 `args: string[]` migration and the rubric for choosing exec-form vs shell-form. The two policies compose: this doc covers *what* a hook does on block; that doc covers *how* a hook is invoked.

## The principle (correctness vs. intent)

Every PostToolUse hook decision falls into one of two classes. The class determines whether to set `continueOnBlock: true`.

### Correctness blocks → `continueOnBlock: true` (soften)

The hook is reporting a **factual mismatch** between what Claude attempted and what the system enforces: a schema violation, a state-machine transition the database refused, a build failure, a lint error, a missing dependency. The block expresses **what is**, not **what is allowed**.

**Both of the following must hold** for a hook to qualify as correctness-class:

1. **The rejection identifies a fixable mismatch.** The reason text names what was wrong in a way the next attempt can act on directly (e.g., `Invalid transition: coding to done` → "go through testing first"). Opaque error codes (`ERR_4123`), uninformative compiler-trace dumps, or messages that require human interpretation do **not** qualify — see "How to tell which class" below.
2. **The blocked invariant is enforced outside the hook.** Below the hook layer there is an independent authority — DB constraint, build system, lint, schema validator, REST API state machine, external service, OS — that re-enforces the same rule. Softening then doesn't weaken any guarantee because the hook is just a fast-fail proxy for the lower enforcement.

**Client-side-only validation is intent-class, not correctness-class.** A hook that inspects tool arguments against a regex and rejects, or validates the agent's report text against a format checker, or imposes any rule that lives ONLY in the hook script — even when the rejection text looks "actionable" — must be classified **intent** and **must NOT have `continueOnBlock: true`**. With no second-line enforcement, softening turns the block into a polite suggestion Claude can iterate around (re-issue a variant call that evades the regex, paraphrase the report to satisfy the literal check). The "actionable rejection reason" property without the "enforced-outside-the-hook" precondition is the policy's known bypass pattern.

### Intent blocks → `continueOnBlock: false` (default — hard block)

The hook is enforcing a **policy decision** about what Claude is allowed to do: a `Bash(rm -rf …)` deny rule, a destructive-op gate, a security boundary, a "don't ever do this without a human in the loop" rail.

For these, the block expresses **what is allowed**, not **what is**. Letting Claude argue past the block — even with the rejection reason in hand — defeats the gate. The right response is a hard turn-stop so the human can re-evaluate.

### How to tell which class a hook is

Ask: *would the agent's **next obvious mechanical correction** — derived directly from the rejection-reason text without reinterpretation or workaround-hunting — succeed AND remain in-policy?*

- If yes (the rejection text names the wrong step + the next call that names the right step is itself allowed) → **correctness** → soften.
- If no (the next obvious correction is "do the forbidden thing differently", or "find a way around the boundary", or the rejection text is too opaque for a mechanical fix) → **intent** → hard block.

"Mechanical" and "in-policy" do the load-bearing work here:

- A `coding → done` rejection's mechanical correction is `coding → testing` — that succeeds AND remains in-policy → correctness.
- An `rm -rf /` deny rule rejection's mechanical correction would be re-issuing the same destructive command with different scope — even if `rm -rf ./dist` "succeeds", the agent's act was *re-interpreting* the rejection as an obstacle to route around, not following its text → intent.
- A "Diana cannot edit Alice's task; ask Alice to release the claim" rejection has a workaround path (handoff), but the mechanical reading is "you can't do this without handoff," and the workaround requires out-of-turn coordination → intent.
- A rate-limit rejection's mechanical correction would be "wait 10 seconds" — not something the agent can do mechanically inside a turn → intent.

If the question is ambiguous in your hook's case, **default to intent**. The cost of hard-blocking a correctness-class hook is one re-prompt; the cost of softening an intent-class hook is a defeated gate.

Edge case: a hook that mixes both (e.g., enforces a state machine AND a deny rule) should be split into two hooks. One per class. Don't paper over the distinction at the config layer.

## Current PostToolUse hooks — non-blocking inventory

The current `hooks.json` contains 5 PostToolUse matcher-blocks with 6 leaf hooks. **None currently issue block decisions.** This inventory was verified during ticket `1b310891` by reading each script for `decision: 'block'`, `process.exit(2)`, or any other block-signal path.

| Leaf hook | Matcher(s) | Block status today | Forward classification | If/when it blocks, why |
|---|---|---|---|---|
| `activity-hook.js` | `Edit\|Write\|Bash\|Task`; also fires in PostToolUseFailure / SubagentStart/Stop | Async fire-and-forget. HTTP POSTs the activity record without awaiting the response; all exit paths are `process.exit(0)`. No `decision` or `exit-2` paths. | **soften** (correctness) | Hypothetical block would mean a telemetry write failed (e.g., DB locked) AND the activity REST endpoint independently re-enforces — both preconditions hold. Claude retrying after a brief delay would succeed. |
| `commentary-hook.js` | `Edit\|Write\|Bash\|Task`; also (mcp\__multiterminal\_\_update_task_*) and PostToolUseFailure | Async fire-and-forget. No decision or exit-2 paths. | **soften** (correctness) | Same as activity-hook — commentary write failure is correctness; retry is the right path. |
| `active-context-hook.js` | `mcp__multiterminal__update_task_checklist`, `update_task_status`, `update_task_continuation`, `build_project` (MT + windows-build-runner) | Synchronous state writer. All exits 0. No decision paths. | **soften** (correctness) | **Worked example** — see below. Outside enforcement: REST API state machine (server-side), the API process lifecycle, and the OS filesystem all back-stop the three plausible block paths. |
| `pipeline-trigger-hook.js` | `mcp__multiterminal__update_task_checklist` | Header says "Hook errors should not block the agent — fail silently." Exit 0 on every path. | **soften** (correctness) | Block would mean pipeline-startup failure (the pipeline skill/agent runtime is the lower enforcement layer — it still fires its own errors regardless of this hook). That's a tool/environment fault Claude can see and decide how to recover from — correctness. |
| `research-cache-hook.js` | `WebSearch\|WebFetch` (mirrored in PreToolUse) | Header says "Never blocks — provides cached results as supplementary context // Output as context — don't block the tool." Exit 0 on every path. | **soften** (correctness) | Block-mode shouldn't be reachable by design; if a future change introduced one, it'd be a cache-layer failure (the underlying WebSearch/WebFetch tool result is itself the canonical answer — cache is a performance optimization, not enforcement). Outside enforcement: the actual web tool's response. Pure correctness. |
| `inbox-check-hook.js` (PostToolUse mode, trailing arg `"PostToolUse"`) | (no matcher) | Block-decision branch exists (line 89) but is **gated to `Stop` / `SubagentStop` modes only**, not PostToolUse. In PostToolUse mode (line 93-95), it prints plain-text context. | **soften** (correctness) | The Stop-mode block branch is a side-channel for "keep Claude processing because messages arrived" — that's not a PostToolUse case and continueOnBlock doesn't apply there. If a future PostToolUse path added a block, it'd be informational. |

Summary: 6 of 6 leaves classified **soften (correctness)** as their forward-looking class. **0 hooks** in MT's current PostToolUse set are intent gates. That's expected — intent gates in MT live in PreToolUse (`safety-hook.js`, `ask-user-relay-hook.js`, `task-to-agent-hook.js`) and Stop hooks, neither of which `continueOnBlock` applies to.

**Important:** none of these 6 leaves have `continueOnBlock: true` set in `hooks.json` today, and none should until a real block branch lands. The classifications above are *projections* for when/if these hooks gain block behavior, not assertions about current config state. See "Out of scope" below for why the inert-flag pattern was avoided.

## Worked example: `active-context-hook.js`

The most defensible case for soften, and the one where the principle gets concrete.

This hook fires synchronously on `mcp__multiterminal__update_task_checklist`, `update_task_status`, `update_task_continuation`, and `build_project`. It writes session state to the local active-context file. Today it never blocks — all paths exit 0. But it's the hook in the set most likely to gain a future block path.

Three plausible future block paths exist; all three classify as correctness because both preconditions (fixable mismatch + outside-the-hook enforcement) hold:

1. **REST API state-machine rejection** — the scenario walked through below. The REST API at `localhost:5050` enforces the `pending → coding → testing → done` ordering; if the agent attempts an invalid transition, the API returns an error and a future block branch could surface it. Outside enforcement: the API itself.
2. **REST API unreachable** — the hook calls `/api/tasks?status=in_progress`; if the local API is down, a future block branch could surface "API unavailable." Outside enforcement: the API process lifecycle (Claude retrying once MT is back up succeeds).
3. **Active-context file write failure** — Windows file lock contention or `ENOSPC` on the memory directory; a future block could surface "could not write ACTIVE-CONTEXT.md." Outside enforcement: the OS filesystem (releasing the lock or freeing space resolves it).

All three are correctness because they identify *what is*, not *what is allowed*. The state machine, the API lifecycle, and the OS are the lower enforcement layers — softening the hook still leaves those rules intact.

**Hypothetical block scenario:** the agent calls `update_task_checklist itemIndex=2 newStatus=done updatedBy=Diana` on an item currently in `coding`. The MT REST API state machine enforces `pending → coding → testing → done`, so the `coding → done` transition is rejected with an error like `Invalid transition: coding to done`. Suppose a future iteration of `active-context-hook.js` surfaced this as a block decision rather than just an exit 0.

**Without `continueOnBlock`:** the hook's block kills the turn. The agent is re-prompted next turn; Claude has lost the conversation context about why the call was made and has to re-derive it. Re-derivation often produces the same wrong call. The PM/tester sees a stuck loop.

**With `continueOnBlock: true`:** the block's `reason` ("Invalid transition: coding to done") feeds back to Claude in the same turn. Claude reads "oh, I needed to go through testing first" and issues `newStatus=testing` with a structured report. The state machine still rejected the bad call — the DB enforcement is intact — but the agent self-corrects rather than stalling.

This is the **correctness** signature: the agent's *intent* was valid (move the item along its lifecycle); only the *step* was wrong; the rejection identified the wrong step in a way Claude can act on.

**Contrast — the same hook firing on a security policy (hypothetical):** suppose a future `active-context-hook.js` also enforced "Diana can't update tasks claimed by other agents." If Claude calls `update_task_checklist` on Alice's task and the hook blocks with `"Diana is not the assignee"`, that block expresses **intent** — letting Claude argue past with a "but Alice is offline" rationalization is the security failure the policy is designed to prevent. That kind of rule should live in a separate hook (or a separate branch with its own classification), and that branch should NOT have `continueOnBlock: true`.

**In-script evolution:** the worked example anticipates the case where `active-context-hook.js` gains a block branch in a future commit. **When that happens, the contributor adding the branch is responsible for re-classifying the hook against this policy** — not assuming the existing "soften" projection still applies. If the new branch is correctness AND the hook had no prior block paths, set `continueOnBlock: true` on the existing matcher entry. If the new branch is intent OR the hook now has mixed semantics, **split the hook into two `hooks.json` entries** (one per class, same matcher) rather than papering over the distinction with one flag. The split-hook rule isn't just for new-hook authoring — it applies equally to hooks that grow block branches across revisions.

The split-hook rule from "How to tell which class" exists precisely so we don't end up with one hook that mixes correctness and intent under a single flag.

## Out of scope

- **PreToolUse hooks.** `continueOnBlock` is PostToolUse-only per the v2.1.139 spec. MT's PreToolUse blockers (`safety-hook.js`, `ask-user-relay-hook.js`, `task-to-agent-hook.js`) are intent-class gates that already enforce hard-block by design and don't get this flag.
- **Stop / SubagentStop hooks.** Different decision semantics — these use `decision: 'block'` as a side-channel to keep Claude processing (see `inbox-check-hook.js` lines 86-92). `continueOnBlock` doesn't apply.
- **Existing `hooks.json` edits.** This ticket does NOT modify `hooks.json` — there are no hooks blocking today, so encoding `continueOnBlock: true` as an inert flag would hide design intent inside a boolean that does nothing. The policy applies when a hook actually gains a block branch.

## Rollback path

The R2 backup `hooks.pre-continueOnBlock-backup.json` is preserved in this folder as defensive insurance for the Owner's end-of-program restart. If something breaks after restart and the args[] migration (ticket `71c957b9`) is the suspected cause, the backup file is for THAT ticket's rollback — this ticket added no `hooks.json` edits.

When a real blocking PostToolUse hook lands and gets `continueOnBlock: true` per this policy, the maintainer at that time should write a fresh per-edit backup (the discipline established in ticket `71c957b9`).

## Maintenance contract

The inventory table above anchors classifications on **current** hook-script behavior — it cites header comments, exit paths, and branch gating as evidence. Those anchors drift if a hook script changes without a corresponding doc update.

When a PR modifies any hook script in this folder and touches a block-decision path (adds `decision: 'block'`, adds `process.exit(2)`, adds a conditional branch that changes when a block fires, or removes a "never blocks" header comment), the **same PR must update the inventory row for that hook** — change the "Block status today" column, re-evaluate the forward classification against the tightened correctness preconditions above, and update the "if/when it blocks, why" column. Reviewers should reject hook-script PRs that touch block paths without an accompanying policy-doc update.

The same rule applies to `hooks.json` edits that set `continueOnBlock: true` on any leaf: that edit lands in the same PR as the script's first real block branch and the inventory row update.

## Companion docs

- `HOOKS-MIGRATION.md` — the v2.1.139 `args: string[]` (exec-form) migration policy. Covers *how* hooks are invoked.
- This doc — covers *what* hooks do on block.

If MT accumulates a third hook-related policy artifact in the future, consider promoting to a unifying `HOOKS-CONVENTIONS.md` parent doc (backlog noted by PM during ticket `1b310891`).

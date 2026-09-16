---
name: program-management
description: Coordinate an existing batch of 2+ related tickets across agents, reviewers and quality gates — sequencing, dispatch, finding triage, and scope calls. Use when the user says "be the program manager", "dispatch these tickets", "run this multi-ticket program", "coordinate this batch of work", OR describes a batch of 2+ related tickets needing sequenced dispatch and gate handling. It does NOT build or spawn a team — for "you are the PM" / "act as PM" on a project, assembling a team, or spawning helpers, use project-management. Distinct from `/kanban-task` (single-ticket lifecycle).
---

# Program Management

> v1, revision expected. Authored from the v2.1.139 adoption program (May 2026), tickets `910354d5` / `71c957b9` / `057ee788` / `1b310891`. Planning-rigor trio contributed by Diana.

## When to use this skill

Use when:
- User invokes one of the trigger phrases above.
- You need to sequence 2+ related tickets across one or more agents.
- The work involves quality-gate cycles (pipeline reviews) and findings need triage across cycles.

Do not use for:
- Single-ticket work — use `/kanban-task` instead, including pure coding within a ticket.
- Decision-record or skill authoring — those are separate skills.

## What this skill won't give you

A discipline, not a magic wand. This skill will not:
- Make hard scope-decline calls for you. PMs decline scope; this skill names the discipline.
- Replace adversarial review. The pipeline catches what plans miss; this skill teaches you how to triage what it surfaces.
- Predict program outcomes. The trio asks plan-time questions; answers still come from honest thinking.
- Substitute for system-enforced gates. Where alignment is enforced by code or config, prefer that to PM-by-discipline.

## Core principles

Fourteen principles grouped into four disciplines. Order within a group is alphabetical and non-narrative — add or remove a bullet anywhere within a group without disrupting flow.

### Decision discipline

- **Don't expand scope mid-pipeline.** When a review surfaces a finding outside the ticket's frame, do not fold it in unilaterally. Surface to the user; name the scope decision explicitly; accept the option to defer.
- **Kanban state must align with git state.** Until system gates enforce this automatically: dispatch messages name worktree path and branch · `coding → testing` requires a commit on the task branch · `→ done` requires a non-empty task branch · program close means merged, not just stamped.
- **PM-only declines scope, explicitly.** Coders and reviewers cannot decline scope — they lack the authority. Only PM can, and PM must do so on the record, not by silence. Silent declines push "fix everything" onto reviewers and "do what I'm told" onto coders.
- **Position-taking, not rubber-stamping.** When asked for a call, give one — including a recommendation and the tradeoff. "Your call" is fine; "go with whichever" is abdication.
- **Triage by defect class, not severity tag.** "Fix doesn't function" blocks; "could be more elegant" ships and listens. A HIGH on a cosmetic issue does not block; a MEDIUM on a broken precondition does. Classify the *kind* of defect before reading the severity.

### Information discipline

- **Logical clauses specify observable state.** Any rule that fires on a property of the world — a count, a status, a flag — must name the surface from which it is read. "When X happens" requires "where X is observable."
- **Self-attest with falsifiable checks.** After a focused fix, verify with a grep, a count assertion, or a structural check — not by narration. "I think it's there" doesn't catch the case where 3 of 6 rows silently missed a precondition. A 30-second script does.
- **Surface dependencies early.** External gates, restart requirements, downstream verification windows — name them at ticket-identification time, not at done-stamp time. Surprises in the close-out belong in the dispatch.

### Quality discipline

- **Convergent findings = single root.** When 2+ independent reviewers flag overlapping issues — even with different severity tags — they almost certainly share a root cause; one focused edit usually closes the cluster. Don't fix five findings; fix the rule they all point at.
- **Cycle-3 escalation.** When adversarial review hits diminishing returns (cycle 3 with non-blocking findings only), surface the meta-question to the user rather than grind through cycle 4. The pipeline is doing its job; the doc is genuinely improving; that's the moment to call it.
- **Inert-config skepticism.** When the feature's value is policy not behavior, doc-only beats inert config flags. A flag that does nothing today hides design intent inside a boolean — worse than a doc, not better.
- **Planning-rigor trio.** Three questions to ask before commit. Full text in §5.

### Risk discipline

- **Risk-class sequencing.** When a program has multiple risky changes that batch into a single verification window (e.g., Owner restart), put non-risky work between them. Isolates which change caused which issue if anything goes wrong.
- **Rollback discipline.** When migrating something whose contract cannot be verified from inside the affected session, write a one-filename-swap rollback artifact before editing. Cost ~zero, value enormous. Generalizes: any change batched with downstream verification deserves a per-change rollback target.

## Planning-rigor trio

*Contributed by Diana — v2.1.139 adoption program, tickets `71c957b9` / `057ee788` / `1b310891`.*

Three questions to ask of any new rule, clause, or load-bearing assumption before commit. Each catches a class of Run-1 HIGH that surfaced across the source program. Not a checklist to pass; a discipline to apply.

1. **The misclassification question.** *"What plausible inputs would this rule classify wrong?"* If the answer is "I can't think of any," keep going until you can — or admit the rule's scope is narrower than it appears.
2. **The observable-state question.** *"What state does this clause reference that the agent can't directly observe?"* For any rule that fires on a property of the world, name the surface the agent will read it from. If you can't, the rule is broken before it ships.
3. **The safety-basis question.** *"What property of the world is this safety argument assuming?"* When the rule's safety story relies on something being true elsewhere, name the property and verify it's a *property* — not a hope. If verification can't happen from where you sit, the verification itself needs to be a separate artifact (a rollback file, a smoke test, a contract claim).

**The discipline:** ask all three at plan-time, write the answers in the plan, and treat any "I can't answer this concretely" as a blocker on the plan — not a known-limitations footnote. Cost of asking is small; cost of discovering at Run-1 pipeline is a rework cycle.

## Workflow phases

1. **Kickoff.** Inventory the tickets. Identify external gates (restarts, verification windows, downstream merges). Name explicit risk-class sequencing where deployment risk is uneven. Apply the planning-rigor trio to each ticket's plan as intake — not after.
2. **Dispatch.** Send tickets one at a time. Each dispatch names: ticket ID, worktree path, branch name, dependencies on prior tickets, expected pipeline gates. Agents are accountable for landing changes in the named worktree. Exit criterion: the agent has claimed and acknowledged.
3. **Monitor.** As tickets land in testing, read the pipeline outputs and apply convergent-findings + defect-class triage. When findings cluster, surface the focused-fix option with a clear recommendation. Don't broadcast every finding for parallel work — that's how cycle-N loops start.
4. **Pipeline gate handling.** Run pipeline ≥1 per ticket. On Run-1, apply the trio retroactively if a HIGH surfaces: which question would have caught this at plan? On Run-2+, watch for cycle-3 escalation signals — diminishing returns plus non-blocking-only findings = surface the meta-question.
5. **Batch-close + external-gate handoff.** Program close means *merged*, not just stamped. For each done-task branch, coordinate the merge to the integration branch before declaring the program complete. Document the external-gate handoff (e.g., Owner restart) with the per-ticket rollback target available.

## Worked examples

See `references/case-studies.md` for three program-defining cases:
- Ticket `71c957b9` — R2-backup discipline before hook migrations enabled safe restart-deferral.
- Ticket `057ee788` — cycleCount-miss as "fix doesn't function" defect class; Option 1.5 (focused fix + Known limitations).
- Ticket `1b310891` — doc-only over preemptive-config; inert-flag skepticism in action.

---
name: pipeline
description: "Runs the agent review pipeline — verifier, code-reviewer, security-auditor, debugger, and cross-model adversary — sized to the diff: SMALL diffs get 2 gates and 1 run, larger ones the full topology. Verifier runs first (must pass build), then the others run in parallel. Blocking failures cycle back as coding items and re-run within the tier's run budget; non-blocking findings are filed to a follow-up ticket by default. Triggers on: '/pipeline', 'run the pipeline', 'full review', 'run all gates'."
version: 3.1.0
---

# Agent Review Pipeline

Runs the complete post-coding quality gate. Each of 5 gates independently dispatches to Claude, to Codex, or is skipped — per the user's saved topology in MultiTerminal Settings (task `b4e05eb9`, Part 1). Failures cycle back to coding automatically. The pipeline loops until all enabled gates pass clean — only then is the code ready for the user to test.

**Gates (5, each independently `claude` / `codex` / `off`):**
1. **Verifier** — build + completeness (must pass before others run)
2. **Code Reviewer** — quality, patterns, naming, consistency
3. **Security Auditor** — OWASP Top 10, injection, XSS
4. **Debugger** — proactive bug detection, data flow analysis
5. **Cross-Model Adversary** — requirements / assumption pressure-test (new in Part 2)

The topology is fetched at runtime from MultiTerminal (`GET /api/settings/pipeline-topology`, default 4 Claude + adversary off). Per-run flags (`--cross-model`, `--no-cross-model`) can override the adversary gate for a single run. When any gate is mapped to `codex`, Codex must be installed and authenticated; if not, those gates gracefully degrade to Claude with a banner note.

**Cross-model gate — user guide:** See `cross-model-usage.md` in this folder for auth / Codex readiness requirements, graceful-degrade behavior, and calibration realities (e.g. Codex systematically blocks DAL-layer code that delegates authorization upstream).

**Codex role prompts:** See `codex-role-prompts.md` in this folder — role-specific focus texts passed to Codex for each of the 5 gates, plus the verdict-scale mapping Step 3.2 uses to normalize Codex output per role.

## Instructions

### 0. Parse Flags + Fetch Pipeline Topology

The `/pipeline` command can be run as-is (reads the user's saved topology from MultiTerminal Settings) or with optional flags that override specific gates for a single run.

#### 0.1 Defaults (fallback when REST fetch fails)

```
DEFAULT_TOPOLOGY = {
  verifier: "claude",
  codeReviewer: "claude",
  securityAuditor: "claude",
  debugger: "claude",
  crossModelAdversary: "off"
}
```

These match the pre-Part-2 baseline (4 Claude gates, no adversary).

#### 0.2 Fetch saved topology from MultiTerminal

```bash
curl -sS --max-time 3 http://localhost:5050/api/settings/pipeline-topology
```

Expected response (HTTP 200, JSON):

```json
{"verifier":"claude","codeReviewer":"claude","securityAuditor":"claude","debugger":"claude","crossModelAdversary":"off"}
```

On success with all 5 fields present, use those values as `PIPELINE_TOPOLOGY`.

On failure (MT not running, timeout, non-200, malformed JSON, missing fields), use `DEFAULT_TOPOLOGY` and prepend a banner to the eventual dashboard:

```
⚠️ Topology fetch failed — using defaults (4 Claude gates, adversary off). Reason: <brief reason>
```

**Do NOT fail the pipeline on topology fetch error** — graceful degrade to defaults.

#### 0.3 Apply flag overrides

Two flags override the fetched topology for a single run:

- `--cross-model` → set `PIPELINE_TOPOLOGY.crossModelAdversary = "codex"`.
- `--no-cross-model` → set `PIPELINE_TOPOLOGY.crossModelAdversary = "off"`.

Flags apply after the REST fetch, so they override whatever the user saved. No other per-gate flags are supported — change Settings for durable changes to the other four gates.

#### 0.4 Log the resolved topology

Before running any gates, log the resolved topology. Makes "why did Codex run on Security?" answerable without opening Settings:

```
Pipeline topology (source: <settings | defaults-fallback | flag-override>):
  • Verifier:               <claude|codex|off>
  • Code Reviewer:          <claude|codex|off>
  • Security Auditor:       <claude|codex|off>
  • Debugger:               <claude|codex|off>
  • Cross-Model Adversary:  <claude|codex|off>
```

### 0.5 Codex Readiness (only if any gate is codex)

If every gate in `PIPELINE_TOPOLOGY` is `"claude"` or `"off"`, skip this section entirely.

Otherwise, resolve `<CODEX_COMPANION_PATH>` (glob at runtime):

```bash
ls -d ~/.claude/plugins/cache/openai-codex/codex/*/scripts/codex-companion.mjs | sort -V | tail -1
```

If the glob finds nothing, Codex is not installed. Demote every gate with value `"codex"` to `"claude"` and log:

```
⚠️ Codex plugin not installed — demoting Codex-mapped gates to Claude (gates: <comma-list>).
```

If the companion script is found, probe setup:

```bash
node "<CODEX_COMPANION_PATH>" setup --json
```

Parse JSON. If `ready !== true`, extract a reason:

- `codex.available === false` → `"Codex CLI not installed"`
- `auth.loggedIn === false` → `"not authenticated (run: !codex login)"`
- `node.available === false` or `npm.available === false` → `"runtime missing: <detail>"`
- Otherwise → `"Codex not ready"`

On not-ready, demote every gate with value `"codex"` to `"claude"` and log:

```
⚠️ Codex not ready — demoting Codex-mapped gates to Claude (gates: <comma-list>, reason: <reason>).
```

**Do not fail the pipeline on readiness failure** — graceful degrade preserves pre-Part-2 behaviour for users without Codex installed.

If `ready === true`, keep topology as-is and set `CODEX_READY = true`. All codex-mapped gates will dispatch via `node codex-companion.mjs adversarial-review` in Phase 1 / Phase 2 below.

### 0.6 Proportionality Tier (MANDATORY — size the pipeline to the diff)

A 3-line reporting tweak must not get the same 13-gate-invocation treatment as a security-critical feature. Real cost data (task 2f7280c2, 2026-07-15): a ~40-line cosmetic JS fix consumed 3 full runs and ~400k subagent tokens; the base fix was shippable after Run 1. Classify BEFORE dispatching:

**SMALL** — ALL of: single file (or file + its test), no C# / no build-surface change, no auth/IO/network/persistence surface touched, < ~100 changed LOC, reporting/display/logging/comment/test-only in nature.
→ Run **verifier + ONE reviewer only** (code-reviewer by default; security-auditor instead if the diff is anywhere near input handling). Skip the rest — log the skip with the tier as the reason. **Run budget: 1** (a 2nd run only if a BLOCKING failure was fixed).

**MEDIUM** — multi-file or 100-500 LOC or touches runtime behavior, but no auth/security surface and no new external inputs.
→ Full enabled topology. **Run budget: 2.**

**LARGE** — security surface, new external inputs, C# + deploy path, schema/contract changes, or > 500 LOC.
→ Full enabled topology, existing 3+-run escalation rules apply.

Log the tier and what it excludes: `Tier: SMALL — dispatching verifier + code-reviewer; security/debugger/adversary skipped (display-only JS diff).` The user can override with `--full` (force LARGE treatment) or by saying so.

**When the run budget is exhausted** and non-blocking findings remain: file them to a follow-up ticket and present the dashboard — do NOT keep looping. Blocking failures always override the budget (they must be fixed and re-verified), but see Step 5.0 for what "re-verified" costs.

### 1. Gather Context

Determine what to review:

**If there's an active kanban task:**
- Call `get_my_active_task()` to get the task ID
- Call `get_task_detail(taskId)` to read plan, checklist, and transition notes
- Identify all files mentioned in coding→testing notes

**If no active task (ad-hoc pipeline):**
- Run `git diff --name-only HEAD~1` for recently changed files
- If no changes, ask the user what to review

Build a file list and change summary for all four agents.

### 2. Phase 1: Verifier (Sequential — Must Pass)

Dispatch the verifier gate per `PIPELINE_TOPOLOGY.verifier`. Verifier must pass (or be explicitly `"off"`) before Phase 2 runs.

#### 2.A `verifier === "off"` — skipped by topology

Log a warning banner: `⚠️ Verifier gate DISABLED by topology — build / completeness checks skipped (user's setting).`

Set `VERIFIER_VERDICT = "SKIPPED"` and `VERIFIER_REPORT = "(gate disabled by topology)"`. Do not save a report (nothing to save). Proceed directly to Phase 2 — downstream gates still run because the user explicitly chose to skip this one.

#### 2.B `verifier === "claude"` — existing behaviour

```
Agent(
  subagent_type="verifier",
  name="Verifier",
  prompt="Verify the following code changes are complete and the project builds.

TASK ID: [taskId or 'ad-hoc']
FILES CHANGED:
[file list]

CHANGE SUMMARY:
[what was built]

TASK PLAN:
[plan text if available]

CHECKLIST ITEMS IN TESTING:
[items with their transition notes]

Run the build. Check file existence, implementation presence, obvious gaps, and plan alignment.
Report your verdict: PASS or FAIL.

IMPORTANT: End your report with a structured verdict block:
---VERDICT---
STATUS: PASS or FAIL
FAILURES:
- [specific failure description] | FILE: [path] | FIX: [what needs to change]
- (or 'None' if PASS)
---END VERDICT---"
)
```

After the Agent returns, save the report:

```
save_task_report(
  taskId="[taskId]",
  agentName="verifier",
  reportContent="[the verifier's full report text]",
  reportType="markdown",
  verdict="[PASS or FAIL]",
  createdBy="[your name]"
)
```

Set `VERIFIER_VERDICT = <PASS|FAIL>` and `VERIFIER_REPORT = <full report text>`.

#### 2.C `verifier === "codex"` — route via Codex

Prepare the focus text: load the `verifier` section of `codex-role-prompts.md` (sibling file) and substitute the `[paste the verifier's build output and the claimed changes summary here]` placeholder with the actual build output + diff summary. Call it `VERIFIER_FOCUS`.

Run the build yourself first (Codex can't run the project build directly; the build output is part of what you pass in):

```bash
# Run whichever build command is appropriate for this project (e.g. dotnet build, npm run build).
# Capture stdout/stderr into BUILD_OUTPUT for the focus text substitution.
```

Then invoke Codex with the focus:

```
Bash(
  command=`node "<CODEX_COMPANION_PATH>" adversarial-review --wait "<VERIFIER_FOCUS>"`,
  description="Codex verifier gate",
  run_in_background=false
)
```

`--wait` is appropriate — Phase 2 depends on the verifier verdict, so we block until Codex is done.

Parse the raw stdout per Step 3.2 (extract `Verdict:` line, map per the verdict-scale table in `codex-role-prompts.md`). For the verifier role:
- `approve` → `PASS`
- `needs-attention` → `FAIL`
- `block` → `FAIL`

Save the report:

```
save_task_report(
  taskId="[taskId]",
  agentName="codex-verifier",
  reportContent=<raw adversarial-review output>,
  reportType="markdown",
  verdict=<mapped verdict>,
  createdBy="[your name]"
)
```

Set `VERIFIER_VERDICT = <PASS|FAIL>` and `VERIFIER_REPORT = <raw output>`.

#### 2.D Gate the pipeline

**If `VERIFIER_VERDICT === "FAIL"`:**
- Parse the failure list from the verdict block (Claude) or from Codex findings
- STOP the pipeline — do not run Phase 2
- Add failures to the pipeline failure list
- Jump to **Step 5 (Failure Routing)**

**If `VERIFIER_VERDICT === "PASS"` or `"SKIPPED"`:**
- Capture `VERIFIER_REPORT` for the Phase-2 handoff
- Continue to Phase 2

### 3. Phase 2: Parallel Gates (Code Review + Security + Debugger + Cross-Model Adversary)

Launch every enabled Phase-2 gate in a **single message**. Claude-mapped gates are `Agent(...)` calls; Codex-mapped gates are `Bash(...)` calls with `run_in_background=true`; off-mapped gates contribute nothing. Mixing Agent() and Bash() in the same message is what keeps them parallel — the Task tool dispatches the Claude agents concurrently while the background Bash processes launch Codex jobs that return immediately with a job ID.

Each gate receives the `VERIFIER HANDOFF` block from Step 2 so it doesn't re-discover context.

#### 3.1 Build the dispatch batch

For each of the 4 Phase-2 roles, consult `PIPELINE_TOPOLOGY`:

| Role | `claude` branch | `codex` branch | `off` branch |
|------|-----------------|----------------|--------------|
| `codeReviewer` | `Agent(subagent_type="code-reviewer", ...)` — prompt in §3.2 | `Bash(...)` with focus from `codex-role-prompts.md` § `code-reviewer` | omit |
| `securityAuditor` | `Agent(subagent_type="security-auditor", ...)` — prompt in §3.2 | Bash with focus § `security-auditor` | omit |
| `debugger` | `Agent(subagent_type="debugger", ...)` — prompt in §3.2 | Bash with focus § `debugger` | omit |
| `crossModelAdversary` | `Agent(subagent_type="cross-model-adversary", ...)` — prompt in §3.2 | Bash with focus § `cross-model-adversary` | omit |

Assemble the batch of calls for the single dispatch message. If **every** Phase-2 gate is `off`, skip Phase 2 entirely and go straight to Step 4 with the verifier-only dashboard.

#### 3.2 Claude gate prompts

Each `claude`-mapped gate uses the corresponding Agent() prompt below. Substitute `[paste the verifier's full report text here]` with `VERIFIER_REPORT` (from Step 2) before dispatching.

```
Agent(
  subagent_type="code-reviewer",
  name="Code Reviewer",
  prompt="Review the following verified code changes for quality.

FILES TO REVIEW:
[file list]

CHANGE SUMMARY:
[what was built]

TASK CONTEXT:
[plan if available]

VERIFIER HANDOFF:
The verifier has already run and PASSED. Here is its report:
---
[paste the verifier's full report text here]
---
Build is clean. Focus your review on quality, not build/completeness issues the verifier already checked.

Focus on naming, patterns, duplication, architecture fit, performance, and error handling.
Score each category and provide an overall verdict.

IMPORTANT: End your report with a structured verdict block:
---VERDICT---
STATUS: PASS, PASS_WITH_NOTES, REVISE, or REWORK
SCORE: [0-100]
FAILURES:
- [finding description] | SEVERITY: MAJOR/MINOR/NIT | FILE: [path:line] | FIX: [suggestion]
- (or 'None' if PASS)
---END VERDICT---"
)

Agent(
  subagent_type="security-auditor",
  name="Security Auditor",
  prompt="Audit the following verified code changes for security vulnerabilities.

FILES TO AUDIT:
[file list with risk categories]

CHANGE SUMMARY:
[what was built]

TASK CONTEXT:
[plan if available]

VERIFIER HANDOFF:
The verifier has already run and PASSED. Here is its report:
---
[paste the verifier's full report text here]
---
Build is clean. Focus on security, not build issues.

Check OWASP Top 10, injection, XSS, path traversal, and architecture-specific risks.
Report findings by severity and provide a verdict.

IMPORTANT: End your report with a structured verdict block:
---VERDICT---
STATUS: PASS, PASS_WITH_WARNINGS, or BLOCK
FAILURES:
- [vulnerability description] | SEVERITY: CRITICAL/HIGH/MEDIUM/LOW | FILE: [path:line] | FIX: [remediation]
- (or 'None' if PASS)
---END VERDICT---"
)

Agent(
  subagent_type="debugger",
  name="Debugger",
  prompt="Proactively analyze these code changes for potential bugs, race conditions, and logic errors.

FILES TO ANALYZE:
[file list]

CHANGE SUMMARY:
[what was built]

TASK CONTEXT:
[plan if available]

VERIFIER HANDOFF:
The verifier has already run and PASSED. Here is its report:
---
[paste the verifier's full report text here]
---
Build is clean. Focus on finding bugs, not build issues.

You are running PROACTIVELY — there is no reported bug yet. Your job is to find bugs BEFORE the user hits them. Focus on:
- Null reference risks at system boundaries
- Race conditions in concurrent code (ConcurrentDictionary, async, events)
- Logic errors (off-by-one, wrong comparison, missing cases)
- Initialization order issues
- Event wiring gaps (event fired but no handler, or handler registered too late)
- Data flow issues (wrong field mapped, data lost in transformation)
- Edge cases (empty collections, null strings, missing keys)

Do NOT report style issues or theoretical concerns. Only report bugs you can trace through the code.

IMPORTANT: End your report with a structured verdict block:
---VERDICT---
STATUS: PASS or FAIL
FAILURES:
- [bug description] | SEVERITY: CRITICAL/HIGH/MEDIUM/LOW | FILE: [path:line] | ROOT_CAUSE: [explanation] | FIX: [specific fix]
- (or 'None' if PASS)
---END VERDICT---"
)

Agent(
  subagent_type="cross-model-adversary",
  name="Cross-Model Adversary",
  prompt="Pressure-test the following verified code changes for load-bearing assumptions, ambiguous contracts, and silent-failure paths the other gates may have shared a mental model about.

FILES TO REVIEW:
[file list]

CHANGE SUMMARY:
[what was built]

TASK CONTEXT:
[plan if available]

VERIFIER HANDOFF:
The verifier has already run and PASSED. Here is its report:
---
[paste the verifier's full report text here]
---
Build is clean. The code-reviewer / security-auditor / debugger are running in parallel with you — don't duplicate their turf (naming, OWASP, root-cause diagnostics). Focus on assumptions, requirements ambiguity, and failure modes that hide in silent paths.

IMPORTANT: End your report with a structured verdict block:
---VERDICT---
STATUS: PASS, PASS_WITH_WARNINGS, or BLOCK
FAILURES:
- [finding description] | SEVERITY: CRITICAL/HIGH/MEDIUM/LOW | FILE: [path:line or 'design-level'] | FIX: [recommendation]
- (or 'None' if PASS)
---END VERDICT---"
)
```

#### 3.3 Codex gate invocation

For each role with `PIPELINE_TOPOLOGY.<role> === "codex"`:

1. **Assemble the focus text.** Load the corresponding section from `codex-role-prompts.md` and substitute the `[paste the verifier's full report text here]` placeholder with `VERIFIER_REPORT`. For the `cross-model-adversary` section, also substitute the peer-gate reports if they're already saved (otherwise leave the note `"peers running in parallel — reports not yet saved"`). Multi-line string; on Windows bash use a heredoc or write to a temp file; on PowerShell use a here-string. Do **not** attempt to inline-quote the focus text on the command line.

2. **Invoke via Bash, in background:**

```
Bash(
  command=`node "<CODEX_COMPANION_PATH>" adversarial-review "<FOCUS>"`,
  description="Codex <role> gate",
  run_in_background=true
)
```

Capture the job identifier from stdout if `codex-companion.mjs adversarial-review` emits one on launch. Store per-gate in `CODEX_JOB_IDS[<role>]` for targeted polling in Step 3.2.

> **Multi-concurrent Codex jobs:** `codex-companion.mjs status <job-id>` and `result <job-id>` accept a per-job identifier so multiple adversarial-review jobs can run concurrently. If the installed runtime version does not support per-job addressing (very first releases had only global state), fall back to serializing Codex gates: launch one at a time with `--wait`, save its report, then move to the next. The serialized fallback is invisible to the user beyond increased wall-clock time. Detection: if `CODEX_JOB_IDS` can't be populated from stdout, switch to the serial path.

#### 3.4 Dispatch the batch (single message)

Emit a single message containing ALL Agent() calls (for Claude-mapped gates) + ALL Bash() calls (for Codex-mapped gates). Off-mapped gates contribute nothing. Example for topology `{codeReviewer:"claude", securityAuditor:"codex", debugger:"claude", crossModelAdversary:"off"}`:

```
Agent(subagent_type="code-reviewer", ...)                              # Claude
Bash(command=`node "..." adversarial-review "<SEC_FOCUS>"`, run_in_background=true)  # Codex
Agent(subagent_type="debugger", ...)                                   # Claude
# crossModelAdversary skipped — off
```

After dispatch, Claude gates return inline (report-saving per Step 3.1) and Codex gates run in the background (polling + parsing per Step 3.2).

#### 3.0.1 Gate agent lifecycle (spawn ephemeral; clean up whatever persists)

Gate agents are ONE-SHOT: they produce a single report and have no further job. Spawn them as plain **ephemeral subagents** — do NOT pass a `name:` to the Agent tool. Named agents become persistent, mailbox-addressable teammates that go **idle** after reporting instead of terminating; across a 2-run pipeline that leaves ~10 zombie agents open until someone notices (Owner-reported, 2026-07-12). Unnamed subagents deliver their final text as the tool result / task notification and close naturally — which also kills the "agent went idle without reporting" failure mode, since the report IS the return value.

If the harness makes a gate persistent anyway (some environments treat every Agent spawn as a teammate), or you deliberately named one:
- Send `SendMessage({to: <gate>, message: {type: "shutdown_request", reason: "report saved — pipeline gate complete"}})` **immediately after saving that gate's report** (per-gate, not batched at the end — a re-run failure or context break must not orphan them).
- At the end of every run (pass OR fail), sweep: confirm no gate agents from this run are still open; shut down any stragglers before presenting the dashboard.

Each `claude`-dispatched Phase-2 gate that returns inline must have its report saved immediately via `save_task_report`. Do NOT wait for all agents — save each one as it returns. The UI shows review badges (Build/Quality/Security/Debug/Adversary) based on saved reports. Without saving, badges remain as hourglasses even after the pipeline passes clean.

**Context hygiene (both directions):** (a) Every gate prompt must include: "Keep the report under ~600 words plus the verdict block — findings belong in the verdict block's structured lines, not restated in prose." Gate reports are consumed by the verdict parser and the report DB, not by a human reading the transcript. (b) Save the gate's returned text **verbatim** as the report — do not rewrite, expand, or annotate it into a second near-copy (each rewrite pays the report's token cost twice in the orchestrator's context). A one-line header (run number, mapped verdict) is the only permitted addition. (c) Handoff blocks passed to later gates carry the VERDICT BLOCK ONLY of prior reports, not their full text.

For each `claude`-dispatched gate, use the `agentName` slug matching the subagent:

| Role | `agentName` slug | Extra fields |
|------|------------------|--------------|
| `codeReviewer` | `code-reviewer` | `score=<0-100>` |
| `securityAuditor` | `security-auditor` | — |
| `debugger` | `debugger` | — |
| `crossModelAdversary` | `cross-model-adversary` | — |

```
save_task_report(
  taskId="[taskId]",
  agentName="<slug-from-table-above>",
  reportContent="<agent's full report text>",
  reportType="markdown",
  verdict="<verdict from the ---VERDICT--- block>",
  createdBy="[your name]"
  # pass score=... only for code-reviewer
)
```

`off`-mapped gates have no report to save (they never ran). `codex`-mapped gates save via Step 3.2.6 after polling completes. The verifier (Phase 1) already saved itself in Step 2.B or Step 2.C.

**When re-running after fixes:** Save the new reports — latest wins, the UI picks up the most recent.

### 3.2. Collect Codex Results (per-role, when any Phase-2 gate is codex)

Skip this entire section if no Phase-2 gate is mapped to `"codex"` (pure-Claude Phase 2 — nothing to collect here). Verifier-Codex (Step 2.C) handled its own collection inline using `--wait`; Step 3.2 is for Phase-2 Codex jobs that launched in background.

For each Phase-2 role where `PIPELINE_TOPOLOGY.<role> === "codex"`, run the sub-steps below. The parsing logic (3.2.1–3.2.4) is uniform across roles; the verdict mapping (3.2.5) and save slug (3.2.6) are role-specific.

Variables that accumulate results are per-role maps:

- `CODEX_VERDICT[<role>]` — final mapped verdict (`PASS` / `FAIL` / `PASS_WITH_NOTES` / `REVISE` / `PASS_WITH_WARNINGS` / `BLOCK`, per role).
- `CODEX_FINDINGS[<role>]` — list of structured findings.
- `CODEX_RAW_OUTPUT[<role>]` — full adversarial-review markdown (or error text on failure).

#### 3.2.1 Poll until complete (per job)

If Step 3.3 captured a per-job ID in `CODEX_JOB_IDS[<role>]`, poll that specific job:

```bash
node "<CODEX_COMPANION_PATH>" status <JOB_ID> --json
```

If the runtime doesn't support per-job addressing and we're running the serial fallback (one codex gate at a time), poll global status:

```bash
node "<CODEX_COMPANION_PATH>" status --json
```

Parse the JSON. The `status` field is the signal:

- `"running"` or `"pending"` → Codex still working. Wait ~5 seconds, then poll again.
- `"completed"` → Codex finished successfully. Proceed to 3.2.2.
- `"failed"` or `"error"` → Codex errored out. Set `CODEX_VERDICT[<role>] = PASS_WITH_WARNINGS` (tolerant fallback), capture any error text as `CODEX_RAW_OUTPUT[<role>]`, leave `CODEX_FINDINGS[<role>] = []`, and skip to 3.2.6. Log one line to the pipeline summary: `Codex <role> gate errored — continuing with other verdicts (reason: <error>)`.

**Poll budget:** cap at ~5 minutes per gate (roughly 60 iterations at 5s). If a gate has not reached `completed` by then, treat it as the `failed` case above with reason `"Codex timeout"`. Never block the pipeline indefinitely on a single Codex gate.

#### 3.2.2 Read the result (per job)

```bash
node "<CODEX_COMPANION_PATH>" result <JOB_ID>
```

(Drop `<JOB_ID>` in the serial fallback — global `result` returns the latest completed job.)

Stdout is the raw adversarial-review markdown that `/codex:adversarial-review` produced. Store the full text verbatim as `CODEX_RAW_OUTPUT[<role>]` — 3.2.6 saves it unmodified so the tester has the full Codex output to read.

#### 3.2.3 Parse the Verdict line (uniform across roles)

`/codex:adversarial-review` natively emits a single-line verdict near the end of its output:

```
Verdict: approve
Verdict: needs-attention
Verdict: block
```

Extract with a multiline regex:

```
^Verdict:\s*(.+?)\s*$
```

Trim and lowercase the captured group. Store as the **raw** verdict for this role — role-specific mapping happens in 3.2.5 below.

#### 3.2.4 Parse findings (uniform across roles)

Codex's adversarial-review findings arrive as a bullet list. Each bullet starts with a bracketed severity tag, then a short title, then an optional parenthesized location, then an explanation and (usually) a `Recommendation:` tail. Example:

```
- [high] SQL concat in UserRepo.Find (Services/UserRepo.cs:42-48) — User input is string-concatenated into the query.
  Recommendation: Use parameterized SQLiteCommand parameters.
- [medium] Missing null guard on Authorization header (API/Middleware/AuthMiddleware.cs:18) — Null header crashes before the auth filter runs.
  Recommendation: Short-circuit with 401 when the header is absent.
```

For each bullet, extract:

- **severity** — one of `critical | high | medium | low` (lowercased from the bracketed tag)
- **title** — the short description after the severity tag, up to the location paren (or end of first line)
- **location** — the `(file:line)` or `(file:line-line)` locator if present; `null` otherwise
- **body** — remaining explanation lines up to the next bullet or the `Verdict:` line
- **recommendation** — text after `Recommendation:` inside the body; `null` if not present

Collect as `CODEX_FINDINGS[<role>]` — a list of structured records (possibly empty). An `approve` run with zero bullets is valid and produces `CODEX_FINDINGS[<role>] = []`.

**Lenient parsing:** if a bullet doesn't match the expected `[severity] title (location) — body` shape, fall back to capturing the raw bullet text with `severity = "low"` and `title = <raw bullet>`. Do not drop the finding. Over-strict parsing is worse than imperfect parsing here — Step 4 surfaces the count to a human who can read the raw report.

#### 3.2.5 Role-specific verdict mapping

Apply the role's verdict-scale from `codex-role-prompts.md` to map the raw `approve` / `needs-attention` / `block` verdict onto the pipeline's standard STATUS field:

| Role | `approve` → | `needs-attention` → | `block` → |
|------|-------------|---------------------|-----------|
| `verifier` (Phase 1, via Step 2.C) | `PASS` | `FAIL` | `FAIL` |
| `codeReviewer` | `PASS` | `PASS_WITH_NOTES` | `REVISE` |
| `securityAuditor` | `PASS` | `PASS_WITH_WARNINGS` | `BLOCK` |
| `debugger` | `PASS` | `FAIL` | `FAIL` |
| `crossModelAdversary` | `PASS` | `PASS_WITH_WARNINGS` | `BLOCK` |
| (unrecognized raw verdict) | `PASS_WITH_WARNINGS` (tolerant fallback) | | |
| (no `Verdict:` line found) | `PASS_WITH_WARNINGS` (tolerant fallback) | | |

On tolerant fallback, record the raw captured value (or the literal string `"missing"` when no line matched) in the pipeline summary so the fallback is visible, e.g. `Codex <role> verdict unrecognized: "approved-with-caveats" — defaulted to PASS_WITH_WARNINGS`. Do not suppress silently — a rising fallback rate is the signal to iterate on the focus string in `codex-role-prompts.md`.

Store as `CODEX_VERDICT[<role>]`.

#### 3.2.6 Save Codex report (per-role, mandatory)

Save each gate's Codex report using `agentName="codex-<role>"`. These slugs drive the pipeline UI badges and must match exactly — see `codex-role-prompts.md` for the reference table.

| Role | `agentName` slug |
|------|------------------|
| `verifier` (Phase 1) | `codex-verifier` |
| `codeReviewer` | `codex-code-reviewer` |
| `securityAuditor` | `codex-security-auditor` |
| `debugger` | `codex-debugger` |
| `crossModelAdversary` | `codex-cross-model-adversary` |

```
save_task_report(
  taskId="[taskId]",
  agentName="<slug-from-table-above>",
  reportContent=CODEX_RAW_OUTPUT[<role>],
  reportType="markdown",
  verdict=CODEX_VERDICT[<role>],
  createdBy="[your name]"
)
```

**Always save — even on the failure / timeout paths.** If 3.2.1 degraded to `PASS_WITH_WARNINGS` because Codex errored or timed out, `CODEX_RAW_OUTPUT[<role>]` holds the error text (or an empty string). Save it anyway: the badge reflects "Codex ran but couldn't complete cleanly" rather than staying as an hourglass that misleads the reader into thinking the gate was skipped.

For the true skip case — gate was demoted to `claude` in Step 0.5 because Codex was not installed / not authenticated — Step 3.2 is never reached for that role (the Claude branch ran instead and saved via Step 3.1). Correct by construction.

### 4. Collect Results and Build Unified Dashboard

After all agents complete, parse each agent's `---VERDICT---` block and build a unified summary.

#### 4.1: Parse Verdicts

Extract the structured verdict from each **enabled** gate's output. Gates mapped to `"off"` in `PIPELINE_TOPOLOGY` don't contribute to the failure list (they never ran). Gates mapped to `"claude"` emit a `---VERDICT---` block; gates mapped to `"codex"` emit a `Verdict:` line plus structured findings (already parsed and normalized per Step 3.2).

Build a combined failure list. Each entry includes the provider label (`claude` or `codex`) so readers can tell which engine flagged it:

```
PIPELINE FAILURE LIST:
1. [Verifier / claude] [description] | File: [path] | Fix: [what to change]
2. [Code Reviewer / codex] [MAJOR] [description] | File: [path:line] | Fix: [suggestion]
3. [Security Auditor / claude] [HIGH] [description] | File: [path:line] | Fix: [remediation]
4. [Debugger / claude] [HIGH] [description] | File: [path:line] | Fix: [specific fix]
5. [Cross-Model Adversary / codex] [HIGH] [description] | File: [path:line or design-level] | Fix: [recommendation]
```

Codex findings flow in via `CODEX_FINDINGS[<role>]` (produced in Step 3.2.4). Map each finding's `severity` field (`critical` / `high` / `medium` / `low`) to the same severity column the Claude gates use.

#### 4.2: Determine Overall Verdict

**Blocking failures** (must fix before user testing):
- Verifier: any `FAIL` (both Claude and Codex). `SKIPPED` is not a failure.
- Code Reviewer: `MAJOR` findings, or verdict `REVISE` / `REWORK`.
- Security Auditor: `CRITICAL` or `HIGH` findings, or verdict `BLOCK`.
- Debugger: `CRITICAL` or `HIGH` severity bugs, or verdict `FAIL`.
- Cross-Model Adversary: `CRITICAL` or `HIGH` findings, or verdict `BLOCK`.

**Non-blocking notes** (informational, don't require a fix cycle):
- Code Reviewer: `MINOR` / `NIT` findings with verdict `PASS` / `PASS_WITH_NOTES`.
- Security Auditor: `MEDIUM` / `LOW` findings with verdict `PASS` / `PASS_WITH_WARNINGS`.
- Debugger: `MEDIUM` / `LOW` severity findings.
- Cross-Model Adversary: `MEDIUM` / `LOW` findings with verdict `PASS` / `PASS_WITH_WARNINGS`.

**Codex tolerant-fallback note:** When a Codex gate degrades to `PASS_WITH_WARNINGS` due to timeout, error, or unrecognized verdict (Step 3.2.1 / 3.2.5), that `PASS_WITH_WARNINGS` is informational and **does not block** — the pipeline continues as if that gate produced no findings. The raw output is still saved via Step 3.2.6 so the tester can review it manually if they want.

**Skipped gates are not failures.** `off`-mapped gates contribute nothing to the failure list; they appear in the dashboard as "SKIPPED" and don't gate the Overall verdict. That's the user's setting — the pipeline respects it.

**Overall:**
- **ALL PASS** — No blocking failures from any gate → Ready for user testing
- **FIX AND RE-RUN** — Blocking failures exist → Route to coding, then re-run pipeline

#### 4.3: Present Dashboard

Each gate section carries a **provider badge** (`CLAUDE` / `CODEX` / `OFF`) so the reader can see the topology at a glance. Off gates still get a section — visible skip beats invisible skip. If any demotion happened in Step 0.5 (Codex not ready → demoted to Claude), include a preamble banner summarising it.

```
## Pipeline Results (Run [N])

[Optional preamble banner if topology demoted or fetch fell back:]
⚠️ Topology fetch failed — using defaults (4 Claude gates, adversary off). Reason: <reason>
⚠️ Codex not ready — demoted gates to Claude: <comma-list>. Reason: <reason>

### Topology
| Gate | Provider | Verdict |
|------|----------|---------|
| Verifier | `<claude / codex / off>` | `<PASS / FAIL / SKIPPED>` |
| Code Reviewer | `<claude / codex / off>` | `<PASS / NOTES / REVISE / REWORK / SKIPPED>` |
| Security Auditor | `<claude / codex / off>` | `<PASS / WARNINGS / BLOCK / SKIPPED>` |
| Debugger | `<claude / codex / off>` | `<PASS / FAIL / SKIPPED>` |
| Cross-Model Adversary | `<claude / codex / off>` | `<PASS / WARNINGS / BLOCK / SKIPPED>` |

### Gate 1: Verifier — [PASS/FAIL/SKIPPED] · Provider: [CLAUDE/CODEX/OFF]
- Build: [clean / errors / n/a — gate off]
- Completeness: [all items verified / gaps found / n/a — gate off]

### Gate 2: Code Review — [PASS/NOTES/REVISE/REWORK/SKIPPED] · Provider: [CLAUDE/CODEX/OFF] ([score]/100 if claude)
- Major: [count]  Minor: [count]  Nit: [count]
- Top issue: [brief description if any]

### Gate 3: Security Audit — [PASS/WARNINGS/BLOCK/SKIPPED] · Provider: [CLAUDE/CODEX/OFF]
- Critical: [count]  High: [count]  Medium: [count]  Low: [count]
- Top finding: [brief description if any]

### Gate 4: Debugger — [PASS/FAIL/SKIPPED] · Provider: [CLAUDE/CODEX/OFF]
- Critical: [count]  High: [count]  Medium: [count]  Low: [count]
- Top finding: [brief description if any]

### Gate 5: Cross-Model Adversary — [PASS/WARNINGS/BLOCK/SKIPPED] · Provider: [CLAUDE/CODEX/OFF]
- Critical: [count]  High: [count]  Medium: [count]  Low: [count]
- Top finding: [brief description if any]
- (If provider is OFF, show "SKIPPED — disabled by topology (user's setting)" and omit the counts.)

### Overall: [ALL PASS / FIX AND RE-RUN]

[If FIX AND RE-RUN:]
### Blocking Failures ([count]):
1. [Gate / provider] [severity] [description] → Fix: [what to change] (File: [path])
2. ...
```

**Score field:** Only populate for Code Review when provider is `claude` (the Claude code-reviewer scores 0–100 natively). For `codex`-provider Code Review, score is omitted — the codex adversarial-review focus text instructs Codex to include a score in the body, so the number is readable to humans but not in the badge.

### 5. Failure Routing (Fix and Re-Run Loop)

#### 5.0 Non-blocking findings DEFER by default; fixes get DELTA re-review, never a full re-run

Two rules that exist because their absence is expensive (task 2f7280c2: every accepted non-blocking fix cascaded into a full re-run):

1. **Non-blocking findings (MEDIUM/MINOR/NIT, PASS_WITH_* verdicts) are FILED, not fixed.** Default action: add them to an existing follow-up ticket or create one, note it in the dashboard, done. Do NOT present them to the user as "fix now? (Recommended)" — that framing converts advisory findings into scope creep. Only offer the in-place fix when the finding is (a) in code THIS task introduced AND (b) a few lines AND (c) squarely in the ticket's own theme; even then, present "defer" first.

2. **If the user does elect an in-place fix of a non-blocking finding: re-review the DELTA only.** Dispatch ONLY the gate that raised the finding (plus the verifier IF the fix touched anything beyond the flagged lines), with a prompt scoped to "did this fix resolve your finding and introduce nothing new?". Gates whose concerns didn't change do NOT re-run — record their prior verdict in the next dashboard with a `(carried from Run N — delta was outside this gate's concern)` note. A test-only or comment-only delta never re-triggers debugger/security.

**If overall verdict is ALL PASS → Skip the rest of this step. Pipeline is done.**

If there are blocking failures:

#### 5.1: Create Coding Items from Failures

If there's an active kanban task, convert each blocking failure into a checklist item for the coding column:

For each blocking failure:
- Create a new checklist item OR update an existing item's notes with the failure details
- The item description should be specific and actionable: "Fix [agent] finding: [description]"
- Include the agent's fix recommendation in the item notes

Use `update_task_checklist` to add items in "coding" status with notes containing:
```
PIPELINE FAILURE (Run [N]):
Agent: [which agent]
Severity: [severity]
File: [path:line]
Issue: [description]
Fix: [agent's recommendation]
```

If no kanban task (ad-hoc), just present the failure list and let the team lead decide how to fix.

#### 5.2: Fix the Failures

The team lead should now fix each failure — either directly or by spawning coding agents. Each fix should be targeted based on the agent's specific recommendation.

#### 5.3: Re-Run the Pipeline

After all blocking failures are fixed, **re-run the pipeline from Step 1**. Increment the run counter.

The pipeline keeps looping (Steps 1-5) until the overall verdict is **ALL PASS**.

**Escalation:** If the pipeline has run 3+ times without reaching ALL PASS, flag it:
```
WARNING: Pipeline has run [N] times without passing. Consider:
- Are the agents' recommendations conflicting with each other?
- Is there a fundamental design issue?
- Should the user weigh in before continuing?
```

### 6. Render Dashboard as Browser Tab

If you have a terminal ID, render the unified dashboard as an HTML browser tab:

```
open_browser_tab(
  terminalId="[your-terminal-id]",
  title="Pipeline Results (Run [N])",
  content="[HTML dashboard]"
)
```

Use this HTML template structure:
- Green header for PASS, yellow for NOTES/WARNINGS, red for FAIL/BLOCK, grey for SKIPPED
- Score badge with circular progress indicator for code review score (only when code-reviewer is Claude-provided)
- Color-coded severity badges for each finding
- Collapsible sections for detailed findings
- Summary counts at the top
- Run history if this is a re-run (show improvement from previous runs)
- **Five gate sections, one per role, each badged with its provider (`CLAUDE` / `CODEX` / `OFF`).** Off gates render dim with "SKIPPED — disabled by topology" rather than being omitted — visible skip beats invisible skip. A demoted gate (Step 0.5 forced codex→claude) should show provider `CLAUDE` with a small note `(demoted from codex — <reason>)` so the reader can tell the user's intent differed from what ran.
- **Topology preamble banner** at the top if the topology fetch failed or any gate was demoted — one line per event, dim-yellow style.

### 7. Save Reports to Task

Individual agent reports should already be saved in Steps 2 and 3.1 above. If any were missed, save them now. Additionally, save the unified pipeline dashboard:

```
save_task_report(
  taskId="[taskId]",
  agentName="pipeline",
  reportContent="[unified HTML dashboard]",
  verdict="[ALL PASS or FIX AND RE-RUN]",
  score=[code review score if available]
)
```

**Reminder:** The UI task card shows review badges (Build / Quality / Security / Debug / Adversary) based on saved reports. If you skip saving, the badges stay as hourglasses even after a clean pass. Always save reports for every gate that ran — the Claude branch saves via Step 3.1 using the role slug (`code-reviewer`, `security-auditor`, `debugger`, `cross-model-adversary`); the Codex branch saves via Step 3.2.6 using `agentName="codex-<role>"` (see the slug table in Step 3.2.6). `off` gates save nothing — nothing ran.

### Key Rules

- **Sequential then parallel**: Verifier MUST complete (PASS or SKIPPED) before Phase 2 launches. No exceptions.
- **Topology is the source of truth**: The pipeline dispatches exactly what `PIPELINE_TOPOLOGY` says for each role. Claude, Codex, or Off — no partial runs within an enabled gate.
- **Skipped gates are not failures**: `off`-mapped gates contribute nothing to the failure list. Visible in the dashboard as `SKIPPED`, but don't gate the Overall verdict.
- **Graceful degrade for Codex**: If Codex is not ready (plugin missing, not authenticated), demote Codex-mapped gates to Claude with a banner — never fail the pipeline for a tooling miss.
- **Blocking failures must be fixed**: Do not present code for user testing if any enabled gate has blocking findings.
- **Proportionality first**: Tier the diff (Step 0.6) before dispatching. SMALL diffs get 2 gates and 1 run; nobody spends 400k tokens re-reviewing a display tweak.
- **Loop until clean — on BLOCKING findings only, within the tier's run budget**: The pipeline re-runs after blocking fixes. Non-blocking findings are filed to a follow-up ticket by default (Step 5.0); an elected non-blocking fix gets a delta re-review by the raising gate, never a full re-run.
- **The user only tests clean code**: The entire point is that the user never sees code that hasn't survived the enabled reviewer set.
- **Proportional detail**: Show full details for failures, brief summaries for passes.
- **Content search**: Use `mcp__multiterminal__search_code` for finding files, NOT Grep.
- **No user names in output**: Refer to "the user" or "the tester", never by personal name.
- **No zombie gates**: Spawn gate agents ephemeral (no `name:` — see §3.0.1). If any gate ended up persistent, shutdown_request it right after its report is saved, and sweep for stragglers before presenting the dashboard. A finished pipeline leaves ZERO gate agents open.

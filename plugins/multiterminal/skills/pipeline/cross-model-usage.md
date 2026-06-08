# /pipeline --cross-model — User Guide

Cross-model review gate — adds the OpenAI Codex (GPT-5.x) adversarial-review as a 5th parallel gate alongside the 4 Claude-based pipeline gates.

## TL;DR

- **Enable:** `/pipeline --cross-model`
- **Disable** (override a future flipped default): `/pipeline --no-cross-model`
- **Requires:** `openai/codex-plugin-cc` installed and `/codex:setup` reporting `ready: true`
- **Adds:** ~30–50 seconds per pipeline run (Codex runs in parallel with the 3 subagents, so net latency is `max(subagents, codex)` not sum)
- **Degrades gracefully:** if Codex is unavailable, the pipeline drops to the 4-gate baseline with a one-line skip note. Does not fail.
- **Known calibration reality:** Codex systematically blocks DAL-layer code that delegates authorization upstream. See [Calibration Realities](#calibration-realities) below.

## When to use it

**High value:**
- Security-sensitive diffs (auth, data access, input validation, command execution, deserialization)
- Changes touching request / response boundaries of HTTP endpoints
- Any code that will handle untrusted input in production

**Medium value:**
- Backend service-layer refactors where authz is enforced at or above the diff
- Changes to privileged operations (deletes, role changes, impersonation)

**Low value (consider running baseline 4-gate instead):**
- Pure-function refactors (string utilities, value objects, math helpers)
- Logging / telemetry-only changes
- Comment-only or documentation-only changes
- UI styling / CSS changes

**Expected false positive zone:**
- DAL-layer (`Services/*Database.cs` shape) classes that correctly delegate authz to service-layer callers. Codex will flag these as HIGH. See [Calibration Realities](#calibration-realities).

## Prerequisites

1. **Codex plugin installed.** `openai/codex-plugin-cc` via `/plugin marketplace add openai/codex-plugin-cc` then `/plugin install codex@openai-codex`.
2. **Codex authenticated.** Run `/codex:setup` and confirm it reports `ready: true`. A valid ChatGPT Plus subscription is sufficient (no separate API billing required).
3. **One of:** Codex companion at `~/.claude/plugins/cache/openai-codex/codex/<version>/scripts/codex-companion.mjs` (installed automatically by the plugin).

## Auth constraint — local-user-only, no headless

Codex authentication is scoped to the **local Windows user session** that ran `codex login`. This means:

- ✅ **Works:** Interactive `/pipeline --cross-model` runs from Claude Code in your terminal.
- ✅ **Works:** Any scripted invocation running under the same Windows user account that is currently logged into Codex.
- ❌ **Does NOT work:** Task Scheduler / cron-style automation running under `SYSTEM`, `NETWORK SERVICE`, or a different user account — the session token is not accessible from there.
- ❌ **Does NOT work:** Headless CI runners that don't have an interactive Codex login.

If you want the cross-model gate to run on CI/CD, you'll need to either: (a) run the CI agent under an interactive user session with a persistent Codex login, or (b) wait for a headless / API-key mode to land in the Codex plugin.

## Graceful degrade

Before launching Codex, the pipeline runs a readiness probe (`codex-companion.mjs setup --json`). If `ready !== true`, the pipeline:

1. Logs one line: `Codex gate requested but unavailable — skipping (reason: <reason>)`
2. Flips `CODEX_GATE_ENABLED` to false for the rest of the run
3. Continues with the 4-gate baseline pipeline — **does not fail**

Common reasons you'll see in the skip message:
- `Codex CLI not installed` — plugin is missing; run `/plugin install codex@openai-codex`
- `not authenticated (run: !codex login)` — session expired; re-auth
- `runtime missing: <detail>` — Node or npm not on PATH

## Calibration realities

**These are observations from validation probes (task 3553ac46 items 8 + 9). They inform when to trust a `--cross-model` BLOCK verdict vs when to override it.**

### Codex is stricter than the Claude gates on architectural authz

On a clean, parameterized, well-disposed DAL class (`scratch/SafeUserLookup.cs.sample` probe), all four Claude gates (verifier, code-reviewer, security-auditor, debugger) passed cleanly. Codex flagged HIGH on the same code because it treated the class's public methods as "unconstrained primitives for delete-by-id / lookup-by-name" and demanded in-class authorization enforcement. The Step 4.2 blocking rule then fired on that HIGH, turning the run into FIX AND RE-RUN.

**Documenting that authz is upstream makes Codex more alarmed, not less.** On probe 2 the class was marked `internal` with XML remarks explaining authz delegation — Codex specifically called out the remarks as themselves the defect: *"That is a trust-boundary defect in the diff itself."*

**What this means for you:**
- If you're refactoring DAL code that correctly delegates authz upstream, expect Codex to FIX-AND-RE-RUN.
- The finding is not wrong — Codex is advocating defense-in-depth at the DAL layer. Whether to act on it is your architectural call.
- Treat persistent Codex authz findings on DAL code as "opinion from a paranoid reviewer," not "bug you must fix before shipping."

### Codex's verdict can be milder than its own prose

On probe 1 of a textbook SQL injection, Codex's summary said *"No-ship. Trivially exploitable"* but the emitted verdict was `needs-attention` — which maps to `PASS_WITH_WARNINGS`. The Step 4.2 "block on CRITICAL/HIGH findings regardless of verdict" rule is what caught this. **Do not rely on `CODEX_VERDICT == BLOCK` alone — the findings severities are the more reliable signal.**

### Latency — expect ~30–50s

Four observed runs on small diffs:
- 46s (item 8, vulnerable DAL probe)
- 39s (item 9 probe 1, clean DAL probe)
- ~35s (item 9 probe 2, scoped DAL probe)
- 51s (item 9 probe 3, pure utility)

Codex runs in parallel with the 3 Claude subagents via `--background`, so the net pipeline latency overhead is the difference between `max(subagents, codex)` and `max(subagents)` alone — typically single-digit seconds, not the full Codex runtime.

### `--background` returns synchronously — but the poll path still works

The `codex-companion.mjs adversarial-review --background` invocation currently blocks the calling process until Codex completes, despite the flag. The output (including progress logs and the final review markdown) streams through stdout. If the pipeline wants true non-blocking Codex, use `run_in_background: true` on the Bash tool wrapping the companion call — this makes Claude Code's tool layer async even though the companion process is blocking.

The Step 3.2.1 poll loop (`status --json`) still works correctly because the companion reports job state via the shared Codex runtime (Windows named pipe), so a separate `status` invocation can query the job even while the originating `adversarial-review` call is still running.

## Troubleshooting

### "Codex gate skipped" after I just installed the plugin

Run `/codex:setup`. If it reports ready, try again. If it still skips, check the pipeline output for the specific reason string.

### Skill edits not picked up after editing `skill.md`

Run `/reload-plugins`. The skill content is cached in the harness at session start; edits to skill files are not picked up until the cache is invalidated.

### Codex emits no `Verdict:` line

Step 3.2.3's tolerant fallback kicks in — verdict defaults to `PASS_WITH_WARNINGS` and the raw (or missing) value is logged. If you see this regularly, open `scratch/` and review the focus text. The default focus string (`skill.md` Step 3 companion-path subsection) has been stable across 4+ probes without a missing-verdict case.

### Codex returns `error` / `failed` status

Per Step 3.2.1, this degrades to `PASS_WITH_WARNINGS` with an empty findings list and a one-line skip note. Does not block the pipeline. If errors persist across runs, check the companion log file path reported in `status --all --json`.

## Future: Settings-pane default

Sibling task `b4e05eb9` will add a project-level settings toggle that flips the default for `/pipeline` from 4-gate to 5-gate. When that ships, `--cross-model` becomes the implicit default for projects with the toggle on, and `--no-cross-model` is the per-run override back to baseline.

Until `b4e05eb9` ships, the 4-gate baseline is the default for all projects — `--cross-model` must be passed explicitly on every invocation that wants Codex.

## Further reading

- `skill.md` in this folder — pipeline orchestration logic (Steps 0–7)
- Probe task history on ticket `3553ac46` (items 8, 9) — concrete examples of BLOCK, FIX-AND-RE-RUN, and ALL-PASS outcomes
- [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) — Codex plugin upstream docs

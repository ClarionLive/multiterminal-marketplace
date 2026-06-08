# Hooks Migration: shell-form → `args: string[]` exec-form (v2.1.139)

Claude Code v2.1.139 added an `args: string[]` field to hook command entries. When `args` is set, the harness spawns the command **directly via Node's `child_process.spawn`** with the given argv vector — bypassing the shell entirely. This eliminates the path-quoting headaches that recur on Windows installs whose user profile contains a space (`C:\Users\First Last\…`).

This document classifies every entry in `hooks.json` so future maintainers can tell at a glance which form each hook uses and **why**.

**Companion policy:** `CONTINUEONBLOCK-POLICY.md` in this folder covers *what* PostToolUse hooks do on block (correctness-vs-intent classification). This doc covers *how* hooks are invoked; that one covers their block semantics. Both apply to any new hook added to `hooks.json`.

## Acceptance invariant (post-migration)

```
events=13   leaves=36   leaves-with-args=36   leaves-in-shell-form=0
```

This is the assertion the migration aims to preserve. Re-verify with one Node one-liner:

```bash
node -e "const h=require('./hooks.json'); let leaf=0,args=0; for(const e of Object.values(h.hooks)) for(const b of e) for(const l of (b.hooks||[])) { leaf++; if(l.args) args++; } console.log('events='+Object.keys(h.hooks).length+' leaves='+leaf+' with-args='+args+' shell='+( leaf-args));"
```

Expected output: `events=13 leaves=36 with-args=36 shell=0`. If `shell` is anything other than `0`, a hook has been added (or reverted) in shell-form and must be reviewed against the rubric below.

## Why this matters

Before the migration, every hook command was a single string that the harness handed to the user's shell. On Windows that's `cmd.exe /c <command>`. Embedded `${CLAUDE_PLUGIN_ROOT}` expansions to a path with spaces (e.g. `C:\Users\First Last\.claude\plugins\…`) had to be wrapped in double quotes inside the JSON, then survive a second round of shell tokenisation. Any drift in the quoting (a missing escape, a single-quoted argument on a `cmd.exe` host, a different shell on a future platform) broke the hook silently.

After migration, the path is a single argv element. No shell sees the spaces; no quoting is required.

## Classification rubric

For each leaf hook entry below, the classification is one of:

| Class | Meaning | Required action |
|---|---|---|
| **migratable** | Pure single command + literal args. No `&&` / `\|\|` / `\|` pipe / redirect / glob / shell-side variable expansion. | Split into `command` + `args`. |
| **migratable-with-care** | Spawns a real shell as the command (e.g. `powershell -Command "…"`). Migratable because `powershell` is still the program; only the argv shape changes. Verify the embedded script string survives intact when passed as a single argv element. | Split, then smoke-test the literal output. |
| **shell-required** | Genuinely needs a shell — uses `&&`, pipes, redirects, glob expansion, or env-var expansion the harness doesn't provide. | Stay on shell form; document why here. |
| **wrapper-needed** | Could go either way but would benefit from a small wrapper script. | Optional cleanup; not load-bearing. |

`${CLAUDE_PLUGIN_ROOT}` is a **harness placeholder** expanded by Claude Code itself before the command runs, *not* a shell variable. So a command that uses only `${CLAUDE_PLUGIN_ROOT}` and literal path/argument segments is **migratable**, not shell-required.

### Glossary

The per-event counts in the inventory tables below use two related terms:

- A **matcher-block** is one `{ matcher, hooks: [...] }` object inside an event's array. It groups one or more hooks that share a matcher pattern.
- A **leaf hook** is one entry inside that block's `hooks` array — a single `{ type, command, args?, timeout?, async? }` object. The `args` field attaches per leaf hook, so the leaf hook (not the matcher-block) is the unit of classification.

For example, `PostToolUseFailure` has 1 matcher-block (`"matcher": ""`) containing 2 leaf hooks (`activity-hook.js` and `commentary-hook.js`). The acceptance invariant counts leaves, not blocks.

## Inventory

36 leaf hooks across 13 events. All 36 are migratable today; the only one warranting extra care is the PowerShell echo in `SessionStart`.

### SessionStart (3 matcher-blocks → 4 leaf hooks)

| # | Matcher | Command (shell-form) | Class |
|---|---|---|---|
| 1 | *(none)* | `node "${CLAUDE_PLUGIN_ROOT}/hooks/project-context-hook.js"` | migratable |
| 2 | `startup\|resume\|clear` | `powershell -NoProfile -Command "Write-Output '…PARALLEL SUBAGENTS…'"` | migratable-with-care |
| 3 | `startup\|resume\|clear` | `node "${CLAUDE_PLUGIN_ROOT}/hooks/session-status-hook.js"` | migratable |
| 4 | `compact` | `node "${CLAUDE_PLUGIN_ROOT}/hooks/session-compact-hook.js"` | migratable |

### SessionEnd (1 block → 2 leaf hooks)

| # | Matcher | Command (shell-form) | Class |
|---|---|---|---|
| 5 | `""` | `node "${CLAUDE_PLUGIN_ROOT}/hooks/session-status-hook.js"` | migratable |
| 6 | `""` | `node "${CLAUDE_PLUGIN_ROOT}/hooks/session-import-hook.js"` | migratable |

### PreToolUse (8 blocks → 8 leaf hooks)

| # | Matcher | Command (shell-form) | Class |
|---|---|---|---|
| 7 | `Edit\|Write\|Bash\|Task` | `node "${CLAUDE_PLUGIN_ROOT}/hooks/activity-hook.js"` | migratable |
| 8 | `AskUserQuestion` | `node "${CLAUDE_PLUGIN_ROOT}/hooks/ask-user-relay-hook.js"` | migratable |
| 9 | `Task` | `node "${CLAUDE_PLUGIN_ROOT}/hooks/task-to-agent-hook.js"` | migratable |
| 10 | `Bash` | `node "${CLAUDE_PLUGIN_ROOT}/hooks/safety-hook.js"` | migratable |
| 11 | `Read` | `node "${CLAUDE_PLUGIN_ROOT}/hooks/safety-hook.js"` | migratable |
| 12 | `Write\|Edit` | `node "${CLAUDE_PLUGIN_ROOT}/hooks/safety-hook.js"` | migratable |
| 13 | `mcp__sqlite__write_query\|mcp__mssql__query` | `node "${CLAUDE_PLUGIN_ROOT}/hooks/safety-hook.js"` | migratable |
| 14 | `WebSearch\|WebFetch` | `node "${CLAUDE_PLUGIN_ROOT}/hooks/research-cache-hook.js"` | migratable |

### PostToolUse (5 blocks → 7 leaf hooks)

| # | Matcher | Command (shell-form) | Class |
|---|---|---|---|
| 15 | `Edit\|Write\|Bash\|Task` | `node "${CLAUDE_PLUGIN_ROOT}/hooks/activity-hook.js"` | migratable |
| 16 | `Edit\|Write\|Bash\|Task` | `node "${CLAUDE_PLUGIN_ROOT}/hooks/commentary-hook.js"` | migratable |
| 17 | `mcp__multiterminal__update_task_*\|…\|mcp__windows-build-runner__build_project` | `node "${CLAUDE_PLUGIN_ROOT}/hooks/active-context-hook.js"` | migratable |
| 18 | (same as 17) | `node "${CLAUDE_PLUGIN_ROOT}/hooks/commentary-hook.js"` | migratable |
| 19 | `mcp__multiterminal__update_task_checklist` | `node "${CLAUDE_PLUGIN_ROOT}/hooks/pipeline-trigger-hook.js"` | migratable |
| 20 | `WebSearch\|WebFetch` | `node "${CLAUDE_PLUGIN_ROOT}/hooks/research-cache-hook.js"` | migratable |
| 21 | *(none)* | `node "${CLAUDE_PLUGIN_ROOT}/hooks/inbox-check-hook.js" PostToolUse` | migratable (one literal trailing arg) |

### PostToolUseFailure (1 block → 2 leaf hooks)

| # | Matcher | Command (shell-form) | Class |
|---|---|---|---|
| 22 | `""` | `node "${CLAUDE_PLUGIN_ROOT}/hooks/activity-hook.js"` | migratable |
| 23 | `""` | `node "${CLAUDE_PLUGIN_ROOT}/hooks/commentary-hook.js"` | migratable |

### PreCompact (1 block → 1 leaf hook)

| # | Matcher | Command (shell-form) | Class |
|---|---|---|---|
| 24 | *(none)* | `node "${CLAUDE_PLUGIN_ROOT}/hooks/session-save-hook.js"` | migratable |

### Elicitation (1 block → 1 leaf hook)

| # | Matcher | Command (shell-form) | Class |
|---|---|---|---|
| 25 | *(none)* | `node "${CLAUDE_PLUGIN_ROOT}/hooks/elicitation-relay-hook.js"` | migratable |

### Stop (2 blocks → 2 leaf hooks)

| # | Matcher | Command (shell-form) | Class |
|---|---|---|---|
| 26 | *(none)* | `node "${CLAUDE_PLUGIN_ROOT}/hooks/session-save-hook.js"` | migratable |
| 27 | *(none)* | `node "${CLAUDE_PLUGIN_ROOT}/hooks/inbox-check-hook.js" Stop` | migratable (one literal trailing arg) |

### SubagentStart (1 block → 2 leaf hooks)

| # | Matcher | Command (shell-form) | Class |
|---|---|---|---|
| 28 | `""` | `node "${CLAUDE_PLUGIN_ROOT}/hooks/subagent-office-hook.js"` | migratable |
| 29 | `""` | `node "${CLAUDE_PLUGIN_ROOT}/hooks/activity-hook.js"` | migratable |

### SubagentStop (2 blocks → 3 leaf hooks)

| # | Matcher | Command (shell-form) | Class |
|---|---|---|---|
| 30 | `""` | `node "${CLAUDE_PLUGIN_ROOT}/hooks/subagent-office-hook.js"` | migratable |
| 31 | `""` | `node "${CLAUDE_PLUGIN_ROOT}/hooks/activity-hook.js"` | migratable |
| 32 | *(none)* | `node "${CLAUDE_PLUGIN_ROOT}/hooks/inbox-check-hook.js" SubagentStop` | migratable (one literal trailing arg) |

### TeammateIdle (1 block → 1 leaf hook)

| # | Matcher | Command (shell-form) | Class |
|---|---|---|---|
| 33 | *(none)* | `node "${CLAUDE_PLUGIN_ROOT}/hooks/subagent-office-hook.js"` | migratable |

### UserPromptSubmit (1 block → 2 leaf hooks)

| # | Matcher | Command (shell-form) | Class |
|---|---|---|---|
| 34 | *(none)* | `node "${CLAUDE_PLUGIN_ROOT}/hooks/inbox-check-hook.js" UserPromptSubmit` | migratable (one literal trailing arg) |
| 35 | *(none)* | `node "${CLAUDE_PLUGIN_ROOT}/hooks/desktop-presence-hook.js"` | migratable |

### Notification (1 block → 1 leaf hook)

| # | Matcher | Command (shell-form) | Class |
|---|---|---|---|
| 36 | *(none)* | `node "${CLAUDE_PLUGIN_ROOT}/hooks/notification-hook.js"` | migratable |

## Totals

| Class | Count |
|---|---|
| migratable (plain node, no args) | 31 |
| migratable (node + literal trailing arg) | 4 |
| migratable-with-care (PowerShell echo) | 1 |
| shell-required | 0 |
| wrapper-needed | 0 |
| **Total** | **36** |

No entry currently relies on a shell feature (`&&`, `||`, pipe, redirect, glob, shell-side env expansion). All 36 entries migrate cleanly.

## What we'd watch for if a future entry sneaks shell semantics back in

The mechanical translation `"command": "X \"…/Y\" Z" → "command": "X", "args": ["…/Y", "Z"]` is only safe when **all** of the following hold. A new contributor adding a hook should verify each one before committing:

1. **No chained commands.** `&&`, `||`, and `;` only work inside a shell. Replace by a single wrapper script.
2. **No pipes or redirects.** `|`, `<`, `>`, `>>` only work inside a shell. Move the piping into the script (`fs.createWriteStream` etc.) or use a wrapper.
3. **No glob expansion.** `*.js`, `**/*.json` etc. only expand inside a shell. Pass each path explicitly, or have the script do its own globbing. (On Windows specifically, `cmd.exe` does not glob-expand anyway — that's the program's job there — but assume some shell on a future spawn path *will*.)
4. **No shell-side variable expansion.** `$HOME` (POSIX) or `%USERPROFILE%` (cmd.exe) only expand inside a shell. The harness *does* expand its own placeholders like `${CLAUDE_PLUGIN_ROOT}` regardless of form — those are safe to use in `args` strings. But arbitrary OS env vars are not.
5. **No quoted strings carrying shell-special characters.** With exec form, quotes are not consumed by a shell, so a string like `"-Command \"Write-Output 'foo'\""` becomes ambiguous: is the outer pair-of-quotes part of the argv element or not? Prefer to break the script body out into its own argv element (`["-NoProfile", "-Command", "Write-Output 'foo'"]`) so the argv shape is unambiguous.
6. **No background `&` or job-control characters.** `&` at the end of a command runs it in the background under a shell. Use the hook config's own `async: true` instead.

If a future hook needs any of the above, leave it in shell form (`"command": "<full string>"`, no `args`) and add a row to the inventory below with class `shell-required` and a one-line rationale.

## Field-by-field migration cheatsheet

For a shell-form entry like:

```json
{
  "type": "command",
  "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/foo.js\" SomeArg",
  "timeout": 6
}
```

The exec-form equivalent is:

```json
{
  "type": "command",
  "command": "node",
  "args": ["${CLAUDE_PLUGIN_ROOT}/hooks/foo.js", "SomeArg"],
  "timeout": 6
}
```

`type`, `matcher`, `timeout`, `async` are preserved verbatim. Only `command` is split.

For the PowerShell echo entry:

```json
{
  "type": "command",
  "command": "powershell -NoProfile -Command \"Write-Output 'PARALLEL SUBAGENTS: …'\""
}
```

becomes:

```json
{
  "type": "command",
  "command": "powershell",
  "args": ["-NoProfile", "-Command", "Write-Output @'\nPARALLEL SUBAGENTS: …\n'@"],
  "timeout": 2
}
```

Note that the `-Command` script body is now a *single* argv element. PowerShell's own argument parser handles the here-string literal inside — that part has nothing to do with the OS shell. Verify after migration that `Write-Output` emits identical text on stdout.

**Why a here-string (`@'…'@`) instead of a single-quoted literal?** PowerShell single-quoted literals terminate at the first apostrophe. The banner text is plain English; a future contributor who writes "don't", "isn't", or "you'll" inside the body would silently break the entry (PowerShell would emit a syntax error to stderr, which the harness swallows — the banner just stops appearing). Here-strings don't have that problem: apostrophes are ordinary characters inside `@'…'@`. JSON carries the required leading/trailing newlines as `\n` escape sequences.

## Out-of-scope flags (for future tickets)

These surfaces were examined and intentionally deferred. Each is annotated with the concrete evidence supporting the deferral, so a future audit doesn't have to re-derive it.

- `~/.claude/hooks/hooks.json` (user-level) — uses an older flat schema (`SessionStart: { command, args, injectAs }` directly) that doesn't match the v2.x nested array layout. **Verified scripts-don't-exist-dead:** the file references hooks under `~/.claude/hooks/*.js` (e.g. `session-status-hook.js`, `activity-hook.js`) but no such files exist on disk at that location — a glob returns zero matches. Whichever loader once read this file no longer has anything to spawn from it. Safe to leave; warrants its own cleanup pass if anyone wants to garbage-collect the file.
- `~/.claude/settings.json` `statusLine` — `{ "type": "command", "command": "node H:/.../statusline.js" }`. Similar pattern, different config surface. The v2.1.139 changelog wording specifically mentions *hooks* `args: string[]`; whether the same field is honored for `statusLine` is a spec question for a separate ticket. **Note:** the configured path is on drive `H:\` and contains no spaces, so the Windows-path-with-spaces motivation that drove this migration does not apply to `statusLine` today. Migrating it would be hygiene, not a bug fix.

## Unwired hook scripts in this folder

Adjacent to the wired-up scripts, two `.js` files live in `hooks/` but are not referenced from `hooks.json`:

- `pool-context.js`
- `stop-relay-hook.js`

These are **not part of the 36 leaf-hook inventory**. If a future contributor wires either of them into an event, the new entry must follow the same exec-form pattern (`command: "node"`, `args: ["${CLAUDE_PLUGIN_ROOT}/hooks/<name>.js", ...]`) and the acceptance invariant above will need to be bumped from 36 to the new total. Cleanup option: delete the orphans; not done in this migration to avoid scope creep.

## Smoke-test plan (see also the kanban ticket)

The smoke test fires on the actual `C:\Users\First Last\` install — the exact path-with-spaces case the migration fixes — so verifying that two distinct hook events still run end-to-end is sufficient evidence that the migration didn't regress. Target events: `SessionStart` (fires on session boot) and a `PostToolUse` matcher (fires on routine tool use).

## Smoke-test results (4 of 4 passed)

Hooks were exercised by direct-invocation against their `C:/Users/First Last/...` paths from a Bash session, simulating the exec-form dispatch shape Claude Code will use after restart.

| # | Scenario | Result |
|---|---|---|
| 1 | `node "C:/Users/First Last/.claude/plugins/marketplaces/multiterminal-marketplace/plugins/multiterminal/hooks/session-status-hook.js"` with a SessionStart-shaped JSON payload on stdin | exit 0; hook ran and printed its debug line. |
| 2 | `node "<plugin path>/activity-hook.js"` with a PostToolUse-shaped JSON payload on stdin | exit 0; silent (correct — activity hook records to disk and returns). |
| 3 | `powershell -NoProfile -Command "Write-Output '<full PARALLEL SUBAGENTS body>'"` (the actual exec-form argv) | Emitted the full 350-char literal message byte-for-byte intact. The single-quoted body survives argv-passing. |
| 4 | `node "<plugin path>/inbox-check-hook.js" Stop` (the 4 hooks that pass a literal trailing arg) | exit 0; script received `Stop` as `process.argv[2]` — identical shape to Claude Code's exec-form dispatch. |

Every test path exercised `C:/Users/First Last/...` — the exact path-with-spaces install that motivated the migration. No quoting issues, no spawn failures, no false negatives.

## False-negatives discovered: **none**

The inventory in this document was authored before the migration; the smoke tests above were run after. No entry exhibited shell-feature dependence that wasn't visible in the pre-migration shell-form string. The classification holds.

## Caveat — end-to-end coverage limit

The smoke tests above validate the **script-launch contract** the new exec-form config relies on: that Node and PowerShell can be spawned directly with the documented argv shape and produce the expected behavior. They do **not** exercise Claude Code's own hooks-config loader (which is what reads `args: string[]` from the JSON). That last mile requires a session restart on a Claude Code build with v2.1.139's args[] support enabled, and is observed naturally on next startup.

## Rollback path (in priority order)

If anything looks off after the next restart — missing prompt banners, hooks that should fire but don't, suspicious silent failures — recover in this order:

### 1. One-keystroke file swap (preferred)

A verbatim pre-migration copy is preserved at `hooks/hooks.shellform-backup.json` in the same folder. Restore by swapping it in:

```powershell
cd "$env:USERPROFILE\.claude\plugins\marketplaces\multiterminal-marketplace\plugins\multiterminal\hooks"
Move-Item hooks.json hooks.execform-broken.json
Move-Item hooks.shellform-backup.json hooks.json
```

Then **fully exit and relaunch Claude Code** — the harness reads `hooks.json` once at session startup, so a soft reload won't pick up the swap. Keep `hooks.execform-broken.json` around for post-mortem; delete after the cause is understood.

### 2. Git revert (if the backup file is also gone)

The marketplace plugin is a git checkout at `~/.claude/plugins/marketplaces/multiterminal-marketplace`. The pre-migration `hooks.json` is captured in commit `57774452bb19eec4c1371aeac8f7cfa0ae8f7b13` (the HEAD before this migration landed). Revert that single file:

```bash
cd ~/.claude/plugins/marketplaces/multiterminal-marketplace
git checkout 57774452 -- plugins/multiterminal/hooks/hooks.json
```

Then fully exit and relaunch Claude Code.

### 3. Reload semantics

Hooks are loaded once when Claude Code starts a session. There is no in-session hot-reload — closing and reopening the CLI / desktop app / IDE plugin host is the only way the new config takes effect. A `/clear` clears the conversation, not the harness's loaded config. If the symptom is "I swapped files but nothing changed," the most common cause is a still-running Claude Code process holding the old config.

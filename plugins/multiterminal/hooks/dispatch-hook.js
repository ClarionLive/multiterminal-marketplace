#!/usr/bin/env node
/**
 * dispatch-hook.js — one in-process dispatcher per (event, head). Ticket 42c91001.
 *
 * B2 model: hooks.json carries TWO entries per event —
 *   - a SYNC entry (blockers / decision-emitters; Claude waits on the result), and
 *   - an ASYNC entry (async:true; fire-and-forget side-effect leaves).
 * Each entry invokes:  node dispatch-hook.js <EventName> <sync|async>
 * The dispatcher reads hookData once, runs that head's leaf chain in-process via
 * each leaf module's run(hookData, {hookType}), and aggregates to ONE
 * {exitCode, stdout, stderr}. Collapsing N per-event process spawns to 2 (sync+async)
 * is the boot/tool-call latency win, while keeping the async leaves non-blocking.
 *
 * DORMANCY NOTE: the exit-2 blocking path is live-dormant as of 2026-07
 * (REDIRECT_TYPES=[] in task-to-agent → no live hook exits 2). The dispatcher still
 * propagates exit codes defensively; that path is proven by a synthetic stub (T2),
 * not a production path.
 *
 * The routing TABLE below is the source of truth for which leaf runs on which event
 * in which head; T6 (dispatch-test/dispatch.test.js) asserts it against hooks.json —
 * every leaf classified sync XOR async, and that classification == its hooks.json
 * async flag. TABLE is populated for the 4 proof-of-pattern reps; the remaining
 * leaves are wired during fan-out (each already refactored to run()+shim first).
 */

const path = require('path');
const { isClarionEmbedded } = require('./embedded-session.js');

// leaf spec: { name, mod (require path) OR run (fn, for tests), head: 'sync'|'async' }
//
// SessionStart is deliberately ABSENT from this table — see STANDALONE below.
// Ruling C (42c91001): the dispatcher stays MATCHER-BLIND and collapses only the
// high-frequency, matcher-safe events where the per-tool-call latency win lives
// (PreToolUse/PostToolUse/UserPromptSubmit/Stop/...). SessionStart fires once per
// boot (negligible spawn saving) and is the highest-blast-radius event, so its
// matcher-scoped leaves stay as individual hooks.json entries, byte-identical and
// equivalence-harness-proven, rather than taking behavior-change risk for ~zero
// benefit.
const TABLE = {
  PreToolUse: [
    { name: 'safety-hook', mod: './safety-hook.js', head: 'sync' },
    { name: 'task-to-agent-hook', mod: './task-to-agent-hook.js', head: 'sync' },
    // activity-hook is MATCHER-BLIND (MT task edcdcdd5 item 2). It used to carry
    // matcher: 'Edit|Write|Bash|Task' to preserve its pre-collapse hooks.json scope, and that
    // scope quietly became load-bearing for something it was never chosen for: MT's Attention
    // Rail clears a blocked card from these rows, so only those four tools could ever clear one.
    // Measured against raw transcripts (not the hook's own log, which is circular): the four
    // covered 629 of 1068 tool uses — 41% of activity was invisible, PowerShell alone 116.
    // The hook now decides for itself, via DISPLAY_TOOLS: those four still produce the displayed
    // TOOL_COMPLETE, everything else produces TOOL_QUIET, which clears without touching the
    // display line. So the Activity feed keeps exactly the scope this matcher was protecting,
    // and the clear-edge stops inheriting it by accident.
    { name: 'activity-hook', mod: './activity-hook.js', head: 'async' },
    // ask-user-relay self-gates on tool_name==='AskUserQuestion' → matcher-blind safe.
    { name: 'ask-user-relay-hook', mod: './ask-user-relay-hook.js', head: 'sync' },
    // research-cache self-gates via extractQuery (non-Web tool → '' → no-op).
    { name: 'research-cache-hook', mod: './research-cache-hook.js', head: 'sync' },
  ],
  PostToolUse: [
    // Matcher-blind, same reasoning as PreToolUse above. THIS is the one that mattered: the
    // clear-edge reads PostToolUse rows, so the matcher here is what made a card sit blocked
    // through a PowerShell command, an MCP call, or a read-only stretch.
    { name: 'activity-hook', mod: './activity-hook.js', head: 'async' },
    // commentary self-gates precisely via extractEvent (fires only on the union of
    // its matched tools), so it stays matcher-blind — no table-matcher needed.
    { name: 'commentary-hook', mod: './commentary-hook.js', head: 'async' },
    { name: 'inbox-check-hook', mod: './inbox-check-hook.js', head: 'sync' },
    // context-threshold: no matcher in hooks.json (fires on all PostToolUse),
    // self-gates on the statusline pct — correct scope for a blanket dispatch.
    { name: 'context-threshold-hook', mod: './context-threshold-hook.js', head: 'sync' },
    { name: 'research-cache-hook', mod: './research-cache-hook.js', head: 'sync' },
    // B′: these two do NOT self-gate to their exact tools, so they carry the
    // hooks.json matcher they replaced — the dispatcher runs them only on those
    // tools (zero added spawns; it's already firing on every PostToolUse).
    {
      name: 'active-context-hook',
      mod: './active-context-hook.js',
      head: 'sync',
      matcher: 'mcp__multiterminal__update_task_checklist|mcp__multiterminal__update_task_status|mcp__multiterminal__update_task_continuation|mcp__multiterminal__build_project|mcp__windows-build-runner__build_project',
    },
    {
      name: 'pipeline-trigger-hook',
      mod: './pipeline-trigger-hook.js',
      head: 'sync',
      matcher: 'mcp__multiterminal__update_task_checklist',
    },
  ],
  PostToolUseFailure: [
    { name: 'activity-hook', mod: './activity-hook.js', head: 'async' },
    { name: 'commentary-hook', mod: './commentary-hook.js', head: 'async' },
  ],
  SessionEnd: [
    // session-import self-gates on eventName==='SessionEnd'. (session-status is
    // the OTHER SessionEnd leaf and is STANDALONE — not dispatched here.)
    { name: 'session-import-hook', mod: './session-import-hook.js', head: 'sync' },
  ],
  PreCompact: [
    // session-save self-gates on the event (PreCompact always writes).
    { name: 'session-save-hook', mod: './session-save-hook.js', head: 'sync' },
    // compact-trigger reports manual vs auto to MultiTerminal (ticket c0ebcfd4): SessionStart(compact)
    // does not say which, and only a manual compaction may claim a compact_my_context continue request.
    // Sync head, so the report reaches MT before the compaction runs; no stdout.
    { name: 'compact-trigger-hook', mod: './compact-trigger-hook.js', head: 'sync' },
  ],
  Stop: [
    { name: 'session-save-hook', mod: './session-save-hook.js', head: 'sync' },
    { name: 'inbox-check-hook', mod: './inbox-check-hook.js', head: 'sync' },
    // TURN_END for MultiTerminal's attention rail (task edcdcdd5). The leaf gained its Stop
    // case in 95565f2 and was unit-tested there -- but was never ROUTED: this table had no
    // activity entry for Stop and hooks.json had no `Stop async` dispatch, so no TURN_END row
    // was ever written and a prompt dismissed with Escape pulsed forever. Found by the
    // pipeline debugger against the live table (0 TURN_END rows in 153k).
    { name: 'activity-hook', mod: './activity-hook.js', head: 'async' },
  ],
  SubagentStart: [
    // subagent-office self-gates on hook_event_name === 'SubagentStart'.
    { name: 'subagent-office-hook', mod: './subagent-office-hook.js', head: 'sync' },
    { name: 'activity-hook', mod: './activity-hook.js', head: 'async' },
  ],
  SubagentStop: [
    { name: 'subagent-office-hook', mod: './subagent-office-hook.js', head: 'sync' },
    { name: 'activity-hook', mod: './activity-hook.js', head: 'async' },
    { name: 'inbox-check-hook', mod: './inbox-check-hook.js', head: 'sync' },
  ],
  TeammateIdle: [
    { name: 'subagent-office-hook', mod: './subagent-office-hook.js', head: 'sync' },
  ],
  UserPromptSubmit: [
    { name: 'inbox-check-hook', mod: './inbox-check-hook.js', head: 'sync' },
    { name: 'desktop-presence-hook', mod: './desktop-presence-hook.js', head: 'async' },
    { name: 'context-threshold-hook', mod: './context-threshold-hook.js', head: 'sync' },
  ],
  Elicitation: [
    // elicitation-relay self-gates on mode==='form' → matcher-blind safe.
    { name: 'elicitation-relay-hook', mod: './elicitation-relay-hook.js', head: 'sync' },
  ],
  Notification: [
    { name: 'notification-hook', mod: './notification-hook.js', head: 'async' },
  ],
  // Remaining events (SessionEnd/PreCompact/Elicitation/SubagentStart/
  // TeammateIdle) wired during fan-out. SessionStart is intentionally absent
  // (its trio is standalone — see STANDALONE).
};

// STANDALONE ALLOWLIST — hooks.json node leaves deliberately NOT collapsed into
// the dispatcher; each stays an individual matcher-scoped hooks.json entry,
// byte-identical + equivalence-proven. Ruling C (42c91001): SessionStart fires
// once per boot (no per-tool-call latency to win) and is the highest-blast-radius
// path, so the dispatcher stays OUT of the boot path. Every entry MUST carry a
// reason. T6 asserts each hooks.json node leaf is in EXACTLY ONE of {TABLE
// (matcher-blind), TABLE (with table-matcher), STANDALONE}. The 1 powershell
// SessionStart echo is non-node and inherently standalone (never dispatchable).
const STANDALONE = {
  'project-context-hook':
    'SessionStart (matcher: none). Once-per-boot; highest-blast path — kept dispatcher-free (ruling C).',
  'session-status-hook':
    'standalone, never dispatched; left in original CLI/main form by PM ruling (run()+shim is dispatcher-composability plumbing it does not use; highest-blast boot hook + un-equivalence-testable critical path = zero churn for zero functional gain).',
  'session-compact-hook':
    'SessionStart (matcher: compact). Once-per-compaction; does not self-gate on source — kept dispatcher-free (ruling C).',
  'agent-rules-hook':
    'SessionStart (matcher: startup|resume|clear|compact). Prints the universal agent rules as its OWN hook command so they get their own 10,000-char output budget (task 9d3404d9); dispatching would merge them into one accumulated stdout and reopen the truncation it exists to avoid.',
};

// CLARION ASSISTANT ALLOWLIST (ticket 9a731cda). A ClarionAssistant tab is a Claude Code session
// hosted in the Clarion IDE, not an MT pane, but it sets MULTITERMINAL_NAME, so the CLI entry's
// MT-only guard lets it through. The Owner's decision is that CA tabs get MESSAGING ONLY from this
// plugin, and the plugin's one messaging job there is the inbox fallback. Every other leaf was
// found wrong in CA: desktop-presence switched off MT's phone remote mode on every CA prompt,
// session-save/active-context overwrote CA's ACTIVE-CONTEXT.md with another agent's task,
// subagent-office added office avatars, pipeline-trigger named a Skill CA lacks, and
// activity/notification/ask-user-relay wrote MT activity rows and Attention cards. safety-hook
// is dropped too (Owner-accepted: CA gets no MT permission prompts).
//
// An ALLOWLIST, not a denylist, so a leaf added to TABLE later is OFF in CA until someone decides
// otherwise. Pinned by dispatch-test/unit-dispatch-embedded.js against the real TABLE.
const CA_ALLOWED_LEAVES = Object.freeze(['inbox-check-hook']);

// Pure: which of `leaves` may run in the session described by `env`. Non-embedded sessions keep
// every leaf, in order; embedded ones keep only CA_ALLOWED_LEAVES. Applied inside dispatch() so the
// CLI path and the tests go through the same filter.
function selectLeavesForEnv(leaves, env, allowed = CA_ALLOWED_LEAVES) {
  const list = Array.isArray(leaves) ? leaves : [];
  if (!isClarionEmbedded(env)) return list;
  return list.filter((l) => l && allowed.includes(l.name));
}

function resolveRun(leaf) {
  if (typeof leaf.run === 'function') return leaf.run;
  // eslint-disable-next-line global-require
  return require(path.join(__dirname, leaf.mod)).run;
}

// B′ (42c91001): a dispatched leaf MAY carry a `matcher` — the exact hooks.json
// matcher string it replaced (e.g. active-context / pipeline-trigger). The
// dispatcher is otherwise matcher-BLIND (leaves self-gate); a table-matcher lets
// a matcher-RELIANT leaf collapse in-process with zero added spawns while keeping
// its original scope. Anchored full-match against hookData.tool_name, mirroring
// Claude Code's own matcher semantics. Leaves with no `matcher` always run.
function matcherMatches(leaf, hookData) {
  if (!leaf.matcher) return true;
  const toolName = (hookData && hookData.tool_name) || '';
  try {
    return new RegExp('^(?:' + leaf.matcher + ')$').test(toolName);
  } catch (e) {
    // A malformed matcher must never silently swallow the leaf; run it (the leaf
    // still self-gates internally). Surfaced by T6 matcher-parity in practice.
    return true;
  }
}

// A sync leaf's stdout is "authoritative" (ends the chain) when it is a
// permission decision (PreToolUse safety) or a stop decision (Stop inbox-check).
function isDecision(s) {
  try {
    const o = JSON.parse(s);
    return !!(o && ((o.hookSpecificOutput && o.hookSpecificOutput.permissionDecision) || o.decision));
  } catch (e) {
    return false;
  }
}

// Events whose plain stdout Claude Code does NOT give the model (ticket 7f2a6f61). Measured on
// 2.1.289 with a headless secret-word test: a PostToolUse hook's plain stdout never reached the
// model, its JSON hookSpecificOutput.additionalContext always did, and UserPromptSubmit plain
// stdout did. ONE process printing a plain line and then the JSON line delivered NEITHER, so
// concatenating leaves (what this dispatcher used to do) spoils any JSON a leaf emits. For these
// events the sync head therefore emits exactly one JSON object. Every other event keeps plain
// text, which Claude Code already delivers (UserPromptSubmit) or which is a decision (Stop).
const CONTEXT_JSON_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure']);

// Claude Code caps a hook's output at 10,000 characters; stay under it with room for the JSON.
const ADDITIONAL_CONTEXT_MAX_CHARS = 9000;
const TRUNCATION_MARKER = '\n[...truncated: hook output exceeded the context budget]';

function parseObject(s) {
  try {
    const o = JSON.parse(s);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
  } catch (e) {
    return null;
  }
}

// The text one leaf wants the model to see: the additionalContext of a JSON leaf, or the leaf's
// stdout as written when it is plain text (or JSON of some other shape, which Claude Code would
// not have parsed either).
function adviceOf(stdout) {
  const o = parseObject(stdout);
  if (o && o.hookSpecificOutput && typeof o.hookSpecificOutput.additionalContext === 'string') {
    return o.hookSpecificOutput.additionalContext;
  }
  return stdout.replace(/\s+$/, '');
}

function capAdvice(text) {
  if (text.length <= ADDITIONAL_CONTEXT_MAX_CHARS) return text;
  return text.slice(0, ADDITIONAL_CONTEXT_MAX_CHARS - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}

// Builds the single stdout a CONTEXT_JSON_EVENTS sync head emits from what its leaves said.
// `advice` is the leaves' text in table order; `decision` is the parsed decision object that ended
// the chain, or null. Returns '' when there is nothing to say, so a silent chain stays silent.
function buildContextJson(eventName, advice, decision) {
  const text = advice.filter((a) => a && a.trim()).join('\n\n');
  if (!decision) {
    if (!text) return '';
    return JSON.stringify({
      hookSpecificOutput: { hookEventName: eventName, additionalContext: capAdvice(text) },
    });
  }
  if (!text) return JSON.stringify(decision);
  const merged = { ...decision };
  const hso = { ...(decision.hookSpecificOutput || {}) };
  if (!hso.hookEventName) hso.hookEventName = eventName;
  hso.additionalContext = capAdvice(
    typeof hso.additionalContext === 'string' && hso.additionalContext.trim()
      ? `${text}\n\n${hso.additionalContext}`
      : text,
  );
  merged.hookSpecificOutput = hso;
  return JSON.stringify(merged);
}

// `env` is the session environment the embedded filter reads. It defaults to an EMPTY object, not
// process.env, so tests that call dispatch() directly stay independent of the ambient environment;
// the CLI entry (runCli) passes process.env explicitly.
async function dispatch(eventName, head, hookData, table = TABLE, env = {}) {
  const leaves = selectLeavesForEnv((table[eventName] || []).filter((l) => l.head === head), env);
  const opts = { hookType: eventName };

  if (head === 'async') {
    // Fire-and-forget: run all (matcher-gated), ignore output AND errors, never block.
    await Promise.allSettled(leaves.filter((l) => matcherMatches(l, hookData)).map((l) => {
      try { return Promise.resolve(resolveRun(l)(hookData, opts)); } catch (e) { return Promise.resolve(); }
    }));
    return { exitCode: 0 };
  }

  // SYNC head: blockers + decision emitters, in table order.
  const asContextJson = CONTEXT_JSON_EVENTS.has(eventName);
  let stdout = '';
  const advice = [];
  for (const leaf of leaves) {
    // Table-matcher gate (B′): a matcher-reliant leaf only runs on its tools.
    if (!matcherMatches(leaf, hookData)) continue;
    let res;
    try { res = await resolveRun(leaf)(hookData, opts); } catch (e) { res = { exitCode: 0 }; }
    res = res || {};

    if (res.exitCode && res.exitCode !== 0) {
      // Exit-code blocker (task-to-agent exit 2): propagate verbatim, stop the chain. Exit 2 shows
      // stderr, not stdout, so the advice gathered so far is not the deliverable here either way.
      return { exitCode: res.exitCode, stdout, stderr: res.stderr || '' };
    }
    if (res.stdout) {
      if (isDecision(res.stdout)) {
        // Authoritative permission/stop decision — emit and stop. On a context-JSON event the
        // advice gathered before it is merged INTO the decision rather than prepended as text,
        // which would make the whole output unparseable and lose the decision too.
        // With no advice the decision goes out byte-for-byte as the leaf wrote it.
        if (asContextJson && advice.some((a) => a && a.trim())) {
          return { exitCode: 0, stdout: buildContextJson(eventName, advice, parseObject(res.stdout)) };
        }
        stdout += (stdout ? '\n' : '') + res.stdout;
        return { exitCode: 0, stdout };
      }
      if (asContextJson) advice.push(adviceOf(res.stdout));
      else stdout += (stdout ? '\n' : '') + res.stdout;
    }
  }
  if (asContextJson) return { exitCode: 0, stdout: buildContextJson(eventName, advice, null) };
  return { exitCode: 0, stdout };
}

// The CLI entry, with its I/O injected so a test can drive the real path (MT-only guard, stdin
// parse, dispatch with the session env) without spawning a process or reaching localhost:5050.
// Returns the exit code; the caller exits.
async function runCli({ argv = process.argv, env = process.env, readStdin, write = (s) => process.stdout.write(s), writeErr = (s) => process.stderr.write(s), table = TABLE } = {}) {
  // MT-ONLY (task c9285d2a). This dispatcher is registered for ~12 events, so under
  // --plugin-dir it runs only in terminals MT launched. Once the plugin is installed at USER
  // SCOPE it would run in EVERY Claude Code session on the machine, and none of its leaves
  // belong there: 10 of the 15 address MultiTerminal's broker on localhost:5050 by agent name
  // and have nothing to say without one, while the self-contained ones (safety-hook's
  // deny/ask policy, inbox-check's stop decision) would quietly extend MT's behaviour to
  // projects that never opted into it.
  //
  // Bail before any leaf runs. This preserves today's behaviour for non-MT sessions exactly,
  // rather than granting them a policy they have never had.
  //
  // A ClarionAssistant tab passes this guard (it sets MULTITERMINAL_NAME); dispatch() then
  // narrows it to CA_ALLOWED_LEAVES because `env` is passed through below.
  if (!env.MULTITERMINAL_NAME) return 0;

  const eventName = argv[2] || '';
  const head = argv[3] || 'sync';
  const input = readStdin ? await readStdin() : '';
  let hookData;
  try { hookData = input.trim() ? JSON.parse(input) : {}; } catch (e) { return 0; }
  const { exitCode, stdout, stderr } = await dispatch(eventName, head, hookData, table, env);
  if (stdout) write(stdout + '\n');
  if (stderr) writeErr(stderr);
  return exitCode || 0;
}

module.exports = {
  dispatch, runCli, selectLeavesForEnv, CA_ALLOWED_LEAVES, TABLE, STANDALONE,
  CONTEXT_JSON_EVENTS, ADDITIONAL_CONTEXT_MAX_CHARS,
};

if (require.main === module) {
  (async () => {
    const code = await runCli({
      readStdin: async () => {
        let input = '';
        for await (const chunk of process.stdin) { input += chunk; }
        return input;
      },
    });
    process.exit(code);
  })().catch(() => process.exit(0));
}

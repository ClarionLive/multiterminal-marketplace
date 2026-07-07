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
    { name: 'activity-hook', mod: './activity-hook.js', head: 'async' },
    // ask-user-relay self-gates on tool_name==='AskUserQuestion' → matcher-blind safe.
    { name: 'ask-user-relay-hook', mod: './ask-user-relay-hook.js', head: 'sync' },
    // research-cache self-gates via extractQuery (non-Web tool → '' → no-op).
    { name: 'research-cache-hook', mod: './research-cache-hook.js', head: 'sync' },
  ],
  PostToolUse: [
    { name: 'activity-hook', mod: './activity-hook.js', head: 'async' },
    { name: 'commentary-hook', mod: './commentary-hook.js', head: 'async' },
    { name: 'inbox-check-hook', mod: './inbox-check-hook.js', head: 'sync' },
    // context-threshold: no matcher in hooks.json (fires on all PostToolUse),
    // self-gates on the statusline pct — correct scope for a blanket dispatch.
    { name: 'context-threshold-hook', mod: './context-threshold-hook.js', head: 'sync' },
    { name: 'research-cache-hook', mod: './research-cache-hook.js', head: 'sync' },
    // fan-out (B′, table-matcher): active-context, pipeline-trigger
  ],
  PostToolUseFailure: [
    { name: 'activity-hook', mod: './activity-hook.js', head: 'async' },
    { name: 'commentary-hook', mod: './commentary-hook.js', head: 'async' },
  ],
  Stop: [
    { name: 'inbox-check-hook', mod: './inbox-check-hook.js', head: 'sync' },
    // fan-out: session-save (sync)
  ],
  SubagentStop: [
    { name: 'activity-hook', mod: './activity-hook.js', head: 'async' },
    { name: 'inbox-check-hook', mod: './inbox-check-hook.js', head: 'sync' },
    // fan-out: subagent-office (sync)
  ],
  UserPromptSubmit: [
    { name: 'desktop-presence-hook', mod: './desktop-presence-hook.js', head: 'async' },
    { name: 'context-threshold-hook', mod: './context-threshold-hook.js', head: 'sync' },
    // fan-out: inbox-check (sync)
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
    'SessionStart|SessionEnd (matcher: startup|resume|clear on start). Once-per-boot; does not self-gate on source — kept dispatcher-free (ruling C).',
  'session-compact-hook':
    'SessionStart (matcher: compact). Once-per-compaction; does not self-gate on source — kept dispatcher-free (ruling C).',
};

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

async function dispatch(eventName, head, hookData, table = TABLE) {
  const leaves = (table[eventName] || []).filter((l) => l.head === head);
  const opts = { hookType: eventName };

  if (head === 'async') {
    // Fire-and-forget: run all (matcher-gated), ignore output AND errors, never block.
    await Promise.allSettled(leaves.filter((l) => matcherMatches(l, hookData)).map((l) => {
      try { return Promise.resolve(resolveRun(l)(hookData, opts)); } catch (e) { return Promise.resolve(); }
    }));
    return { exitCode: 0 };
  }

  // SYNC head: blockers + decision emitters, in table order.
  let stdout = '';
  for (const leaf of leaves) {
    // Table-matcher gate (B′): a matcher-reliant leaf only runs on its tools.
    if (!matcherMatches(leaf, hookData)) continue;
    let res;
    try { res = await resolveRun(leaf)(hookData, opts); } catch (e) { res = { exitCode: 0 }; }
    res = res || {};

    if (res.exitCode && res.exitCode !== 0) {
      // Exit-code blocker (task-to-agent exit 2): propagate verbatim, stop the chain.
      return { exitCode: res.exitCode, stdout, stderr: res.stderr || '' };
    }
    if (res.stdout) {
      stdout += (stdout ? '\n' : '') + res.stdout;
      if (isDecision(res.stdout)) {
        // Authoritative permission/stop decision — emit and stop.
        return { exitCode: 0, stdout };
      }
    }
  }
  return { exitCode: 0, stdout };
}

module.exports = { dispatch, TABLE, STANDALONE };

if (require.main === module) {
  (async () => {
    const eventName = process.argv[2] || '';
    const head = process.argv[3] || 'sync';
    let input = '';
    for await (const chunk of process.stdin) { input += chunk; }
    let hookData;
    try { hookData = input.trim() ? JSON.parse(input) : {}; } catch (e) { process.exit(0); return; }
    const { exitCode, stdout, stderr } = await dispatch(eventName, head, hookData);
    if (stdout) process.stdout.write(stdout + '\n');
    if (stderr) process.stderr.write(stderr);
    process.exit(exitCode || 0);
  })().catch(() => process.exit(0));
}

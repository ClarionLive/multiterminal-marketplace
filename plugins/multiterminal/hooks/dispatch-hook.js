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
const TABLE = {
  SessionStart: [
    // project-context self-gates on hookType==='SessionStart' and is wired with
    // NO matcher in hooks.json (fires on every start incl. compact) — its correct
    // scope, so a blanket SessionStart dispatch is right for it.
    { name: 'project-context-hook', mod: './project-context-hook.js', head: 'sync' },
    // fan-out: session-status (sync, matcher startup|resume|clear),
    //          session-compact (sync, matcher compact).
    // MATCHER NOTE (surfaced to PM): session-status/session-compact are matcher-
    // SCOPED in hooks.json and do NOT self-gate on hookData.source, so a per-event
    // (matcher-blind) dispatch would fire them on the wrong starts. They stay
    // UNWIRED pending the collapse-time matcher-handling ruling. The powershell
    // echo (startup|resume|clear) is non-node and stays standalone regardless.
  ],
  PreToolUse: [
    { name: 'safety-hook', mod: './safety-hook.js', head: 'sync' },
    { name: 'task-to-agent-hook', mod: './task-to-agent-hook.js', head: 'sync' },
    { name: 'activity-hook', mod: './activity-hook.js', head: 'async' },
    // fan-out: ask-user-relay (sync), research-cache (sync) per matcher
  ],
  PostToolUse: [
    { name: 'activity-hook', mod: './activity-hook.js', head: 'async' },
    { name: 'commentary-hook', mod: './commentary-hook.js', head: 'async' },
    { name: 'inbox-check-hook', mod: './inbox-check-hook.js', head: 'sync' },
    // context-threshold: no matcher in hooks.json (fires on all PostToolUse),
    // self-gates on the statusline pct — correct scope for a blanket dispatch.
    { name: 'context-threshold-hook', mod: './context-threshold-hook.js', head: 'sync' },
    // fan-out: active-context (sync), pipeline-trigger (sync), research-cache (sync)
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
  Notification: [
    { name: 'notification-hook', mod: './notification-hook.js', head: 'async' },
  ],
  // Remaining events (SessionEnd/PreCompact/Elicitation/SubagentStart/
  // TeammateIdle) wired during fan-out; SessionStart partially wired above.
};

function resolveRun(leaf) {
  if (typeof leaf.run === 'function') return leaf.run;
  // eslint-disable-next-line global-require
  return require(path.join(__dirname, leaf.mod)).run;
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
    // Fire-and-forget: run all, ignore output AND errors, never block.
    await Promise.allSettled(leaves.map((l) => {
      try { return Promise.resolve(resolveRun(l)(hookData, opts)); } catch (e) { return Promise.resolve(); }
    }));
    return { exitCode: 0 };
  }

  // SYNC head: blockers + decision emitters, in table order.
  let stdout = '';
  for (const leaf of leaves) {
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

module.exports = { dispatch, TABLE };

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

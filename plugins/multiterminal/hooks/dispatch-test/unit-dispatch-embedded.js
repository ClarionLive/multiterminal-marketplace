#!/usr/bin/env node
/**
 * Unit test for the dispatcher's ClarionAssistant allowlist (ticket 9a731cda, item 6).
 *
 * A CA tab sets MULTITERMINAL_NAME, so the dispatcher's MT-only guard lets it through; the Owner's
 * rule is that it then runs ONLY the inbox fallback (CA_ALLOWED_LEAVES). Asserted against the REAL
 * routing TABLE: every leaf is cloned with its name/head/matcher intact and its `run` replaced by a
 * recorder, so the real dispatch() — and the real CLI entry, runCli() — decide what runs, but no
 * real leaf executes. The network tripwire is loaded first anyway: if a recorder swap ever failed
 * and a real leaf ran, it would throw rather than reach the live MT on :5050.
 *
 * Non-vacuity: the non-embedded pass must run MORE than one distinct leaf (all of them), and the
 * embedded pass must actually run inbox-check (every TABLE entry of it), so "only inbox-check ran"
 * cannot be satisfied by "nothing ran".
 *
 * FALSIFIED 2026-09-29 by a script that, per edit, asserted the anchor text occurred exactly once,
 * ran this file (green), applied the edit, confirmed the anchor was gone, ran it (red), restored,
 * ran it (green). The run stops at its first failure, so each line names only where it went red:
 *   - dispatch() given the unfiltered leaf list (selectLeavesForEnv bypassed)
 *       -> red at 'embedded: no leaf other than inbox-check runs'.
 *   - CA_ALLOWED_LEAVES emptied (inbox-check dropped)
 *       -> red at 'CA_ALLOWED_LEAVES is exactly [inbox-check-hook]' (the literal check comes first;
 *          the behavioural 'inbox-check ran for every TABLE entry' was not reached in that run).
 *   - runCli calling dispatch() without env (the CLI stops forwarding process.env)
 *       -> red at 'runCli embedded UserPromptSubmit/async: nothing runs'.
 */
const assert = require('assert');
const { attempts } = require('./_net-tripwire.js');
const { dispatch, runCli, selectLeavesForEnv, CA_ALLOWED_LEAVES, TABLE } = require('../dispatch-hook.js');

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed++; }

const EMBEDDED = { MULTITERMINAL_NAME: 'CA-test', CLARION_ASSISTANT_EMBEDDED: '1' };
const MT_PANE = { MULTITERMINAL_NAME: 'Alice' };
// Satisfies both table-matchers (active-context, pipeline-trigger), so the non-embedded pass can
// reach every leaf rather than having two gated out by the tool name.
const HOOK_DATA = { tool_name: 'mcp__multiterminal__update_task_checklist', hook_event_name: 'x' };

// Real TABLE, recorder runs. `mod` is dropped so resolveRun can only use the recorder.
function recordingTable(ran) {
  const out = {};
  for (const [event, leaves] of Object.entries(TABLE)) {
    out[event] = leaves.map((l) => {
      const { mod: _mod, ...rest } = l;
      return { ...rest, run: async () => { ran.push(`${event}/${l.name}`); return { exitCode: 0 }; } };
    });
  }
  return out;
}

async function driveAll(env) {
  const ran = [];
  const table = recordingTable(ran);
  for (const event of Object.keys(table)) {
    for (const head of ['sync', 'async']) {
      await dispatch(event, head, HOOK_DATA, table, env);
    }
  }
  return ran;
}

(async () => {
  // ── 1. The allowlist itself ──────────────────────────────────────────────────────────────────
  ok(Array.isArray(CA_ALLOWED_LEAVES) && CA_ALLOWED_LEAVES.length === 1 && CA_ALLOWED_LEAVES[0] === 'inbox-check-hook',
    `CA_ALLOWED_LEAVES is exactly [inbox-check-hook] (got ${JSON.stringify(CA_ALLOWED_LEAVES)})`);
  const tableNames = new Set(Object.values(TABLE).flat().map((l) => l.name));
  ok(tableNames.has('inbox-check-hook'), 'the allowlisted leaf is a real TABLE leaf (not a typo that allows nothing)');

  // ── 2. Pure filter, with a fixture leaf that is NOT in the table ─────────────────────────────
  // Models "a leaf added later": it must be OFF in CA without anyone touching the allowlist.
  {
    const fixture = [
      { name: 'inbox-check-hook', head: 'sync' },
      { name: 'brand-new-future-hook', head: 'sync' },
      { name: 'safety-hook', head: 'sync' },
    ];
    const emb = selectLeavesForEnv(fixture, EMBEDDED).map((l) => l.name);
    ok(JSON.stringify(emb) === JSON.stringify(['inbox-check-hook']), `embedded: fixture filtered to inbox-check only (got ${JSON.stringify(emb)})`);
    const mt = selectLeavesForEnv(fixture, MT_PANE).map((l) => l.name);
    ok(JSON.stringify(mt) === JSON.stringify(fixture.map((l) => l.name)), 'MT pane: fixture untouched, order kept');
    ok(selectLeavesForEnv(fixture, { ...EMBEDDED, CLARION_ASSISTANT_EMBEDDED: '0' }).length === 3, 'CLARION_ASSISTANT_EMBEDDED=0: not embedded, all kept');
    ok(selectLeavesForEnv(undefined, EMBEDDED).length === 0, 'non-array leaves -> empty, no throw');
  }

  // ── 3. Real TABLE through the real dispatch() ────────────────────────────────────────────────
  const totalLeaves = Object.values(TABLE).flat().length;
  const inboxEntries = Object.values(TABLE).flat().filter((l) => l.name === 'inbox-check-hook').length;
  {
    const ran = await driveAll(MT_PANE);
    const names = new Set(ran.map((r) => r.split('/')[1]));
    ok(names.size > 1, `MT pane: more than one distinct leaf runs (got ${names.size}) — keeps the embedded case from being vacuous`);
    ok(names.size === tableNames.size, `MT pane: every TABLE leaf name runs (${names.size}/${tableNames.size})`);
    ok(ran.length === totalLeaves, `MT pane: every TABLE entry runs exactly once (${ran.length}/${totalLeaves})`);
  }
  {
    const ran = await driveAll(EMBEDDED);
    const others = ran.filter((r) => !r.endsWith('/inbox-check-hook'));
    ok(others.length === 0, `embedded: no leaf other than inbox-check runs (ran: ${others.join(', ') || 'none'})`);
    ok(ran.length === inboxEntries && inboxEntries > 0, `embedded: inbox-check ran for every TABLE entry (${ran.length}/${inboxEntries})`);
  }
  {
    // dispatch() without an env argument is not embedded (tests stay independent of ambient env).
    const ran = [];
    await dispatch('UserPromptSubmit', 'async', HOOK_DATA, recordingTable(ran));
    ok(ran.length === 1 && ran[0] === 'UserPromptSubmit/desktop-presence-hook', 'dispatch() with no env: unfiltered (desktop-presence runs)');
  }

  // ── 4. The CLI entry (runCli) forwards the session env into the filter ───────────────────────
  async function cli(env, event, head) {
    const ran = [];
    const writes = [];
    const code = await runCli({
      argv: ['node', 'dispatch-hook.js', event, head],
      env,
      readStdin: async () => JSON.stringify(HOOK_DATA),
      write: (s) => writes.push(s),
      writeErr: (s) => writes.push(s),
      table: recordingTable(ran),
    });
    return { code, ran, writes };
  }
  {
    // desktop-presence is the leaf that switched MT's phone remote mode off on every CA prompt.
    const mt = await cli(MT_PANE, 'UserPromptSubmit', 'async');
    ok(mt.ran.includes('UserPromptSubmit/desktop-presence-hook'), 'runCli MT pane UserPromptSubmit/async: desktop-presence runs');
    const emb = await cli(EMBEDDED, 'UserPromptSubmit', 'async');
    ok(emb.ran.length === 0, `runCli embedded UserPromptSubmit/async: nothing runs (ran: ${emb.ran.join(', ') || 'none'})`);
    ok(emb.code === 0, 'runCli embedded exits 0');
  }
  {
    const mt = await cli(MT_PANE, 'UserPromptSubmit', 'sync');
    ok(mt.ran.length === 2, `runCli MT pane UserPromptSubmit/sync: inbox-check + context-threshold (got ${mt.ran.join(', ')})`);
    const emb = await cli(EMBEDDED, 'UserPromptSubmit', 'sync');
    ok(JSON.stringify(emb.ran) === JSON.stringify(['UserPromptSubmit/inbox-check-hook']), `runCli embedded UserPromptSubmit/sync: inbox-check only (got ${emb.ran.join(', ')})`);
  }
  {
    const emb = await cli(EMBEDDED, 'PreToolUse', 'sync');
    ok(emb.ran.length === 0, 'runCli embedded PreToolUse/sync: safety/task-to-agent/ask-user-relay/research-cache all skipped');
  }
  {
    // Unchanged MT-only guard: no MULTITERMINAL_NAME -> nothing runs, embedded or not.
    const none = await cli({ CLARION_ASSISTANT_EMBEDDED: '1' }, 'Stop', 'sync');
    ok(none.ran.length === 0 && none.code === 0, 'runCli without MULTITERMINAL_NAME: nothing runs');
  }

  ok(attempts.length === 0, `no network attempt reached the tripwire (got ${attempts.join('; ')})`);

  console.log(`dispatch CA allowlist unit: PASS (${passed} assertions)`);
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});

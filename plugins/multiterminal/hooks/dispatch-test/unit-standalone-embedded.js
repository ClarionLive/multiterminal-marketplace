#!/usr/bin/env node
/**
 * Unit test: the standalone SessionStart hooks are silent in a ClarionAssistant tab
 * (ticket 9a731cda, item 6).
 *
 *   - project-context-hook: its first act is `claude plugin install ... --scope project` into the
 *     cwd plus a marker file, then an MT project-context fetch. In CA that would install MT's
 *     plugin into the Clarion project the IDE tab is open on.
 *   - session-compact-hook: after compaction it prints MT rules, an MT kanban task and
 *     "You are <name>". A CA tab is not an MT agent.
 *
 * Driven through each hook's run() with injected deps (spies for install/fetch, an in-memory fs and
 * a stub DB constructor) — the same run() the CLI shim calls. Each embedded case has a control with
 * the identical deps minus the embedded flag, which MUST produce output and hit the spies; without
 * it, "embedded is silent" could pass because the fixture never produced output at all.
 *
 * FALSIFIED 2026-09-29 (anchor asserted to occur once, green before, edit, red, restore, green):
 *   - project-context's `if (isClarionEmbedded(env)) {` -> `if (false) {`
 *       -> red at 'project-context embedded: exit 0, no stdout'.
 *   - session-compact's `if (isClarionEmbedded(env)) {` -> `if (false) {`
 *       -> red at 'session-compact embedded: exit 0, empty stdout'.
 * The run stops at the first failure; the spy-count assertions after it were not reached.
 */
const assert = require('assert');
const path = require('path');
const { attempts } = require('./_net-tripwire.js');
const projectContext = require('../project-context-hook.js');
const sessionCompact = require('../session-compact-hook.js');

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed++; }

const EMBEDDED = { CLARION_ASSISTANT_EMBEDDED: '1', MULTITERMINAL_NAME: 'CA-test', MULTITERMINAL_PROJECT_ID: 'proj-1' };
const MT_PANE = { MULTITERMINAL_NAME: 'Alice', MULTITERMINAL_PROJECT_ID: 'proj-1' };

function pcSpies(env) {
  const s = { ensure: 0, fetch: 0 };
  s.deps = {
    env,
    ensurePluginInstalled: () => { s.ensure++; },
    fetchProjectContext: async () => { s.fetch++; return { project: { name: 'P' } }; },
  };
  return s;
}

const CWD = '/proj';
const DBP = '/db/mt.db';
function csDeps(env, counter) {
  const store = new Map([[path.join(CWD, 'multiterminal-rules.md'), 'RULE ONE'], [DBP, 'x']]);
  return {
    env,
    cwd: CWD,
    dbPath: DBP,
    fs: {
      existsSync: (p) => { counter.fs++; return store.has(p); },
      readFileSync: (p) => { counter.fs++; return store.get(p); },
    },
    requireBetterSqlite3: () => {
      counter.db++;
      return function Database() {
        return { prepare: () => ({ get: () => ({ id: 't1', title: 'Some MT task', status: 'in_progress' }) }), close: () => {} };
      };
    },
  };
}

(async () => {
  // ── project-context ──────────────────────────────────────────────────────────────────────────
  for (const hookData of [{ hook_type: 'SessionStart' }, { hook_event_name: 'SessionStart', type: 'SessionStart' }]) {
    const s = pcSpies(EMBEDDED);
    const r = await projectContext.run(hookData, s.deps);
    ok(r && r.exitCode === 0 && !r.stdout, 'project-context embedded: exit 0, no stdout');
    ok(s.ensure === 0, 'project-context embedded: NO `claude plugin install` into the cwd');
    ok(s.fetch === 0, 'project-context embedded: NO project-context fetch');
  }
  {
    const s = pcSpies(MT_PANE);
    const r = await projectContext.run({ hook_type: 'SessionStart' }, s.deps);
    ok(s.ensure === 1 && s.fetch === 1, 'project-context control (MT pane, same deps): install + fetch DO run');
    ok(r.stdout && r.stdout.includes('## Project Context: P'), 'project-context control: prints context');
  }
  {
    const s = pcSpies({ ...EMBEDDED, CLARION_ASSISTANT_EMBEDDED: '0' });
    await projectContext.run({ hook_type: 'SessionStart' }, s.deps);
    ok(s.ensure === 1, 'project-context CLARION_ASSISTANT_EMBEDDED=0: treated as not embedded');
  }

  // ── session-compact ──────────────────────────────────────────────────────────────────────────
  {
    const c = { fs: 0, db: 0 };
    const r = sessionCompact.run({}, csDeps(EMBEDDED, c));
    ok(r && r.exitCode === 0 && !r.stdout, `session-compact embedded: exit 0, empty stdout (got ${JSON.stringify(r && r.stdout)})`);
    ok(c.fs === 0 && c.db === 0, `session-compact embedded: touches neither the rules file nor the DB (fs=${c.fs}, db=${c.db})`);
  }
  {
    const c = { fs: 0, db: 0 };
    const r = sessionCompact.run({}, csDeps({ ...MT_PANE }, c));
    ok(r.stdout.includes('RULE ONE') && r.stdout.includes('Some MT task') && r.stdout.includes('You are Alice'),
      'session-compact control (MT pane, same deps): rules + task + identity printed');
    ok(c.db === 1, 'session-compact control: DB consulted');
  }

  ok(attempts.length === 0, `no network attempt reached the tripwire (got ${attempts.join('; ')})`);

  console.log(`standalone hooks CA skip unit: PASS (${passed} assertions)`);
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});

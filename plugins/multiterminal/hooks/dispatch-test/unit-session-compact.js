#!/usr/bin/env node
/**
 * Unit test for session-compact-hook.run() (ticket 42c91001).
 *
 * session-compact is read-only (rules file + readonly DB), so the equivalence
 * harness safely covers the real path twice. This unit test additionally pins
 * the active-task branch deterministically with a stub Database (no live SQLite)
 * and asserts the emit-sink reproduces console.log's per-line newline structure
 * exactly — the property the dispatcher relies on when it accumulates this
 * SessionStart(compact) leaf's stdout.
 */
const assert = require('assert');
const path = require('path');
const { run } = require('../session-compact-hook.js');

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed++; }

const CWD = '/proj';
const DBP = '/db/mt.db';
const rulesPath = path.join(CWD, 'multiterminal-rules.md');

function memFs(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    existsSync: (p) => store.has(p),
    readFileSync: (p) => { if (!store.has(p)) throw new Error('ENOENT ' + p); return store.get(p); },
  };
}
// Stub better-sqlite3 Database constructor returning a fixed task row.
function fakeDbCtor(task) {
  return function Database() {
    return {
      prepare: () => ({ get: () => task, all: () => [] }),
      close: () => {},
    };
  };
}

const RULES = 'RULE ONE\nRULE TWO';
const TASK = {
  id: '42c91001', title: 'Tooling diet', continuation_notes: 'resume = sync fan-out',
  checklist_json: JSON.stringify([
    { status: 'done' }, { status: 'done' }, { status: 'coding' }, { status: 'pending' },
  ]),
};
function deps(over = {}) {
  return {
    fs: over.fs || memFs({ [rulesPath]: RULES, [DBP]: '' }),
    env: over.env || { MULTITERMINAL_NAME: 'Henry' },
    cwd: CWD,
    dbPath: DBP,
    requireBetterSqlite3: over.requireBetterSqlite3 || (() => fakeDbCtor(over.task !== undefined ? over.task : TASK)),
  };
}

// ── 1. Full path: rules + active task + checklist + identity, exact newlines ──
{
  const r = run({}, deps());
  ok(r.exitCode === 0, 'exit 0');
  ok(r.stdout.startsWith('[Post-Compaction Context Re-injection]\n\nRULE ONE\nRULE TWO\n\n'), 'rules block newline structure matches console.log');
  ok(r.stdout.includes('## Active Task: Tooling diet [42c91001]'), 'active task header');
  ok(r.stdout.includes('**Continuation Notes:** resume = sync fan-out'), 'continuation notes');
  ok(r.stdout.includes('**Checklist:** 2/4 done, 0 testing, 1 coding, 1 pending'), 'checklist summary');
  ok(r.stdout.endsWith('You are Henry. Continue working on your active task.\n'), 'identity line + trailing newline');
}

// ── 2. No name → rules only (DB + identity skipped) ──
{
  const r = run({}, deps({ env: { MULTITERMINAL_NAME: '' } }));
  ok(r.stdout.includes('RULE ONE'), 'no name → rules still emitted');
  ok(!r.stdout.includes('## Active Task'), 'no name → no DB task block');
  ok(!r.stdout.includes('You are'), 'no name → no identity line');
}

// ── 3. No rules file → task + identity only, no re-injection header ──
{
  const r = run({}, deps({ fs: memFs({ [DBP]: '' }) }));
  ok(!r.stdout.includes('[Post-Compaction Context Re-injection]'), 'no rules file → no header');
  ok(r.stdout.includes('## Active Task: Tooling diet'), 'task still emitted');
  ok(r.stdout.includes('You are Henry.'), 'identity still emitted');
}

// ── 4. No active task → rules + identity only, no task block ──
{
  const r = run({}, deps({ task: null }));
  ok(r.stdout.includes('RULE ONE'), 'rules emitted');
  ok(!r.stdout.includes('## Active Task'), 'no task → no task block');
  ok(r.stdout.includes('You are Henry.'), 'identity emitted');
}

// ── 5. Empty output → empty string (no trailing newline artifact) ──
{
  // no rules file, no name → nothing emitted at all
  const r = run({}, deps({ fs: memFs({}), env: { MULTITERMINAL_NAME: '' } }));
  ok(r.stdout === '', 'nothing to emit → empty stdout, not a bare newline');
}

console.log(`session-compact run() unit: PASS (${passed} assertions)`);

#!/usr/bin/env node
/**
 * Unit test for session-compact-hook.run() (ticket 42c91001).
 *
 * session-compact is read-only (readonly DB), so the equivalence
 * harness safely covers the real path twice. This unit test additionally pins
 * the active-task branch deterministically with a stub Database (no live SQLite)
 * and asserts the emit-sink reproduces console.log's per-line newline structure
 * exactly — the property the dispatcher relies on when it accumulates this
 * SessionStart(compact) leaf's stdout.
 *
 * Task 9d3404d9: the hook no longer re-injects multiterminal-rules.md from the cwd
 * (agent-rules-hook.js re-injects the plugin's rules after compaction). Every case
 * plants a rules file in the cwd; case 6 asserts it is never even opened.
 *
 * FALSIFIED 2026-10-02 (anchor counted == 1, green before, red after, restored, green): a read of
 * the cwd multiterminal-rules.md put back before the task block -> red at case 1 'header then task,
 * newline structure matches console.log'. The run stops there; case 6 was not individually seen red.
 */
const assert = require('assert');
const path = require('path');
const { run } = require('../session-compact-hook.js');

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed++; }

const CWD = '/proj';
const DBP = '/db/mt.db';
const rulesPath = path.join(CWD, 'multiterminal-rules.md'); // planted; must never be read

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

// ── 1. Full path: header + active task + checklist + identity, exact newlines ──
{
  const r = run({}, deps());
  ok(r.exitCode === 0, 'exit 0');
  ok(r.stdout.startsWith('[Post-Compaction Context Re-injection]\n\n## Active Task: Tooling diet [42c91001]\n'), 'header then task, newline structure matches console.log');
  ok(!r.stdout.includes('RULE ONE'), 'the cwd rules file is not printed');
  ok(r.stdout.includes('**Continuation Notes:** resume = sync fan-out'), 'continuation notes');
  ok(r.stdout.includes('**Checklist:** 2/4 done, 0 testing, 1 coding, 1 pending'), 'checklist summary');
  ok(r.stdout.endsWith('You are Henry. Continue working on your active task.\n'), 'identity line + trailing newline');
}

// ── 2. No name → nothing at all, even with a cwd rules file ──
{
  const r = run({}, deps({ env: { MULTITERMINAL_NAME: '' } }));
  ok(r.stdout === '', 'no name → empty stdout (no header, no cwd rules, no bare newline)');
}

// ── 3. No rules file → output identical to case 1 (the cwd file plays no part) ──
{
  const r = run({}, deps({ fs: memFs({ [DBP]: '' }) }));
  ok(r.stdout === run({}, deps()).stdout, 'with and without a cwd rules file → identical output');
  ok(r.stdout.includes('## Active Task: Tooling diet'), 'task still emitted');
}

// ── 4. No active task → header + identity only, no task block ──
{
  const r = run({}, deps({ task: null }));
  ok(r.stdout.startsWith('[Post-Compaction Context Re-injection]\n\n'), 'header emitted');
  ok(!r.stdout.includes('## Active Task'), 'no task → no task block');
  ok(r.stdout.includes('You are Henry.'), 'identity emitted');
}

// ── 5. Empty output → empty string (no trailing newline artifact) ──
{
  const r = run({}, deps({ fs: memFs({}), env: { MULTITERMINAL_NAME: '' } }));
  ok(r.stdout === '', 'nothing to emit → empty stdout, not a bare newline');
}

// ── 6. The cwd rules file is never even opened (task 9d3404d9) ──
{
  const seen = [];
  const base = memFs({ [rulesPath]: RULES, [DBP]: '' });
  const spyFs = {
    existsSync: (p) => { seen.push(p); return base.existsSync(p); },
    readFileSync: (p) => { seen.push(p); return base.readFileSync(p); },
  };
  const r = run({}, deps({ fs: spyFs }));
  ok(seen.length > 0, `the spy sees filesystem calls at all (saw ${seen.length})`);
  ok(!seen.includes(rulesPath), `cwd multiterminal-rules.md not touched (touched: ${seen.join(', ')})`);
  ok(r.stdout.includes('You are Henry.'), 'spy run still produced output');
}

console.log(`session-compact run() unit: PASS (${passed} assertions)`);

#!/usr/bin/env node
/**
 * Unit test for the node:sqlite fallback in _sqlite.js (marketplace issue #1).
 *
 * WHY: the bundled better-sqlite3 binary is built for one Node ABI. On any other Node major
 * it fails to load and every DB-backed hook silently no-ops (on Node 26 MultiTerminal's
 * activity_feed stayed at 0 rows, so the Attention rail never cleared a block). The fallback
 * wraps Node's built-in node:sqlite in the slice of the better-sqlite3 API the hooks use.
 *
 * What this covers: resolution order (a candidate that can open a database wins and the fallback is not
 * consulted; a candidate that fails to require OR fails on open is skipped and the fallback
 * is returned; with no fallback the
 * result is null), and the adapter against a REAL temp database, written the way
 * activity-hook.js writes and read back with { readonly: true } the way the readers do.
 * The adapter facts are skipped (with a printed reason) on a Node without node:sqlite.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveSqlite, loadNodeSqlite } = require('../_sqlite.js');

const throwingRequire = () => { throw new Error('Cannot find module'); };

// How an ABI-mismatched better-sqlite3 actually fails: require() succeeds, because the native
// binding is loaded lazily, and the CONSTRUCTOR throws. Simulating the failure as a throwing
// require() would pass a resolver that never probes, which is the bug this file once missed.
function LazyAbiMismatch() { throw new Error('was compiled against a different Node.js version'); }
const lazyMismatchRequire = () => LazyAbiMismatch;

function main() {
  // A candidate that loads wins; the fallback is not consulted.
  const real = function RealBetterSqlite3() { this.close = () => {}; };
  let fallbackCalls = 0;
  const loaded = resolveSqlite(['a'], () => real, () => { fallbackCalls++; return 'fallback'; });
  assert.strictEqual(loaded, real, 'a loadable candidate is returned');
  assert.strictEqual(fallbackCalls, 0, 'fallback not consulted when a candidate loads');

  // Every candidate throws -> the fallback is returned.
  assert.strictEqual(resolveSqlite(['a', 'b'], throwingRequire, () => 'fallback'), 'fallback',
    'all candidates failing falls back');

  // The real Node-26 failure: requires cleanly, throws on open -> must still fall back.
  assert.strictEqual(resolveSqlite(['vendor'], lazyMismatchRequire, () => 'fallback'), 'fallback',
    'a module that requires but cannot open a database is skipped');

  // No fallback available either -> null (the hooks' existing "disabled" path).
  assert.strictEqual(resolveSqlite(['a'], throwingRequire, () => null), null,
    'no driver at all resolves to null');

  const Database = loadNodeSqlite();
  if (!Database) {
    console.log(`SKIP adapter facts: node:sqlite not available on Node ${process.version}`);
    console.log('PASS unit-sqlite-fallback (resolution only)');
    return;
  }
  assert.strictEqual(Database.backend, 'node:sqlite');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-sqlite-fallback-'));
  const file = path.join(dir, 'multiterminal.db');
  const open = [];
  const track = (db) => { open.push(db); return db; };
  try {
    // Writer, shaped like activity-hook.js recordActivity().
    const w = track(new Database(file));
    w.exec('CREATE TABLE activity_feed (id INTEGER PRIMARY KEY, timestamp TEXT NOT NULL, '
      + 'activity_type TEXT NOT NULL, actor TEXT, summary TEXT NOT NULL, severity TEXT, details_json TEXT)');
    const res = w.prepare('INSERT INTO activity_feed (timestamp, activity_type, actor, summary, severity, details_json) '
      + 'VALUES (?, ?, ?, ?, ?, ?)').run('2026-10-20T08:51:00Z', 'TOOL_QUIET', 'Bob', 'AskUserQuestion', 'info', null);
    assert.strictEqual(res.changes, 1, 'run() reports changes like better-sqlite3');
    // Named parameters without a prefix, as better-sqlite3 accepts.
    w.prepare('INSERT INTO activity_feed (timestamp, activity_type, actor, summary) VALUES (@t, @a, @who, @s)')
      .run({ t: '2026-10-20T08:51:01Z', a: 'TURN_END', who: 'Bob', s: 'Turn ended' });

    // Reader, opened read-only like pool-context / session-status.
    const r = track(new Database(file, { readonly: true }));
    const rows = r.prepare('SELECT activity_type, actor FROM activity_feed ORDER BY id').all();
    assert.deepStrictEqual(rows.map((x) => x.activity_type), ['TOOL_QUIET', 'TURN_END'], 'all() returns rows');
    assert.strictEqual(r.prepare('SELECT actor FROM activity_feed WHERE id = ?').get(1).actor, 'Bob', 'get() returns a row');
    assert.strictEqual(r.prepare('SELECT 1 FROM activity_feed WHERE id = ?').get(99), undefined, 'get() miss is undefined');
    assert.throws(() => r.prepare("INSERT INTO activity_feed (timestamp, activity_type, summary) VALUES ('x','y','z')").run(),
      /readonly/i, 'readonly: true is enforced');
  } finally {
    // Close before deleting, and never let cleanup replace an assertion failure: Windows
    // refuses to delete an open database, and that EPERM would hide the real message.
    for (const db of open) { try { db.close(); } catch (_e) { /* already closed */ } }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) { /* best effort */ }
  }

  console.log('PASS unit-sqlite-fallback');
}

try {
  main();
} catch (e) {
  console.error('FAIL unit-sqlite-fallback:', e && e.stack || e);
  process.exit(1);
}

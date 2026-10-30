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

    // busy_timeout is set by PRAGMA, so it holds on 22.13-22.15 too, where DatabaseSync has no
    // `timeout` option and a locked database would fail at once instead of waiting.
    assert.strictEqual(r.pragma('busy_timeout', { simple: true }), 5000, 'default busy_timeout is 5000ms');
    assert.strictEqual(track(new Database(file, { timeout: 1234 })).pragma('busy_timeout', { simple: true }), 1234,
      'an explicit timeout option sets busy_timeout');

    // pragma(), as session-status-hook.js uses it for the Project Knowledge block: the setter
    // form, then the rows form and the { simple: true } form, both better-sqlite3 shapes.
    const k = track(new Database(file));
    const setRows = k.pragma('busy_timeout = 2000');
    assert.ok(Array.isArray(setRows), 'pragma() without simple returns an array of rows');
    assert.strictEqual(setRows[0].timeout, 2000, 'pragma() setter row carries the new value');
    assert.strictEqual(k.pragma('busy_timeout', { simple: true }), 2000, 'pragma() simple returns the first column');

    // transaction(): the reference-count bump in session-status-hook.js.
    k.exec('CREATE TABLE knowledge_entries (id INTEGER PRIMARY KEY, reference_count INTEGER NOT NULL DEFAULT 0)');
    k.exec('INSERT INTO knowledge_entries (id) VALUES (1), (2)');
    const bumpStmt = k.prepare('UPDATE knowledge_entries SET reference_count = reference_count + 1 WHERE id = ?');
    const bumpAll = k.transaction((entries) => { for (const e of entries) bumpStmt.run(e.id); return entries.length; });
    assert.strictEqual(bumpAll([{ id: 1 }, { id: 2 }]), 2, 'transaction function returns fn\'s result');
    const counts = () => k.prepare('SELECT reference_count AS c FROM knowledge_entries ORDER BY id').all().map((x) => x.c);
    assert.deepStrictEqual(counts(), [1, 1], 'transaction commits');
    const failing = k.transaction(() => { bumpStmt.run(1); throw new Error('boom'); });
    assert.throws(() => failing(), /boom/, 'transaction rethrows fn\'s error');
    assert.deepStrictEqual(counts(), [1, 1], 'transaction rolls back on error');
    // Nested: an inner failure caught by the outer function undoes only the inner work.
    // The caught message is checked so a nested BEGIN failing for its own reason cannot pass.
    const inner = k.transaction(() => { bumpStmt.run(2); throw new Error('inner'); });
    let caught;
    const outer = k.transaction(() => { bumpStmt.run(1); try { inner(); } catch (e) { caught = e.message; } });
    outer();
    assert.strictEqual(caught, 'inner', 'the nested call failed with fn\'s own error');
    assert.deepStrictEqual(counts(), [2, 1], 'nested transaction rolls back to its savepoint only');
    const innerOk = k.transaction(() => bumpStmt.run(2));
    k.transaction(() => { bumpStmt.run(1); innerOk(); })();
    assert.deepStrictEqual(counts(), [3, 2], 'a nested transaction that succeeds commits with the outer one');
    assert.doesNotThrow(() => k.exec('BEGIN; COMMIT'), 'no transaction is left open');

    // Unset binds become NULL, as in better-sqlite3 (node:sqlite throws on undefined). This is
    // session-status-hook.js binding env.MULTITERMINAL_PROJECT_ID when the env var is unset.
    assert.strictEqual(k.prepare('SELECT ? IS NULL AS n').get(undefined).n, 1, 'undefined positional binds NULL');
    assert.strictEqual(k.prepare('SELECT @p IS NULL AS n').get({ p: undefined }).n, 1, 'undefined named binds NULL');
    k.prepare('INSERT INTO activity_feed (timestamp, activity_type, actor, summary) VALUES (?, ?, ?, ?)')
      .run('2026-10-20T08:51:02Z', 'TURN_END', undefined, 'unset actor');
    assert.strictEqual(k.prepare('SELECT actor FROM activity_feed WHERE summary = ?').get('unset actor').actor, null,
      'run() with an undefined value writes NULL');
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

/**
 * _sqlite.js — single source of truth for resolving the optional better-sqlite3
 * native module across machines.
 *
 * Replaces five divergent copies of requireBetterSqlite3() that each hardcoded a
 * dev-box absolute path ("H:\DevLaptop\...\mcp-session-history\node_modules\
 * better-sqlite3"), which never exists on a clean install (tracking issue #7).
 *
 * Resolution order (first hit wins, all failures are swallowed):
 *   1. MT_BETTER_SQLITE3 env var (explicit full path to the module) — escape hatch.
 *   2. bare 'better-sqlite3' (global install / NODE_PATH / plugin-flattened deps).
 *   3. vendor/ copy bundled with the plugin (the binary shipped alongside hooks).
 *   4. plugin-local node_modules (if the plugin was npm-installed).
 *   5. %APPDATA%\npm\node_modules (Windows global npm — the documented workaround).
 *   6. Node's built-in node:sqlite (Node >= 22.13 / 23.4), wrapped to look like better-sqlite3.
 *
 * No hardcoded developer-machine paths. The bundled vendor/ copy (3) is what makes
 * this work out of the box; the installer (#2) is responsible for placing a
 * correctly-built binary there for the target's Node ABI.
 *
 * Why (6) exists (marketplace issue #1): a native binary is built for ONE Node ABI. On
 * any other Node major the vendor copy fails to load, every DB-backed hook silently
 * no-ops, and nothing tells the human. node:sqlite ships inside Node itself, so it can
 * never be ABI-mismatched. It is last, not first, so a machine where better-sqlite3
 * loads keeps exactly the behaviour it had.
 */
const path = require('path');

let cached; // memoize across calls within a single process

function requireBetterSqlite3() {
  if (cached !== undefined) return cached;

  const candidates = [
    process.env.MT_BETTER_SQLITE3,
    'better-sqlite3',
    path.join(__dirname, '..', 'vendor', 'node_modules', 'better-sqlite3'),
    path.join(__dirname, '..', 'node_modules', 'better-sqlite3'),
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'better-sqlite3'),
  ].filter(Boolean);

  cached = resolveSqlite(candidates, require, loadNodeSqlite);
  return cached;
}

/**
 * Pure resolution: the first candidate that loads AND can open a database, else the
 * node:sqlite adapter, else null. Split out so the fallback can be tested without a broken
 * native module on disk.
 *
 * Requiring is not enough: better-sqlite3 loads its native binding lazily, in the Database
 * constructor, so an ABI-mismatched copy requires cleanly and only throws when a hook opens
 * the database. Each candidate therefore opens and closes an in-memory database before it
 * is accepted.
 */
function resolveSqlite(candidates, requireFn, loadFallback) {
  for (const modulePath of candidates) {
    try {
      const Database = requireFn(modulePath);
      new Database(':memory:').close();
      return Database;
    } catch (e) {
      // try next candidate
    }
  }
  return loadFallback();
}

/**
 * The node:sqlite DatabaseSync class, or null when this Node has none without a flag
 * (before 22.13 / 23.4 it needs --experimental-sqlite, which hooks are not run with).
 * Node versions where node:sqlite is still experimental print an ExperimentalWarning on
 * first load; that warning is dropped here so it cannot reach a hook's stderr.
 */
function loadNodeSqlite() {
  const originalEmitWarning = process.emitWarning;
  process.emitWarning = function (warning, ...rest) {
    const type = typeof rest[0] === 'string' ? rest[0] : rest[0] && rest[0].type;
    if (type === 'ExperimentalWarning' && /sqlite/i.test(String(warning))) return;
    return originalEmitWarning.call(process, warning, ...rest);
  };
  try {
    return createNodeSqliteDatabase(require('node:sqlite').DatabaseSync);
  } catch (e) {
    return null;
  } finally {
    process.emitWarning = originalEmitWarning;
  }
}

/**
 * Wraps DatabaseSync in the slice of the better-sqlite3 API the hooks use:
 * `new Database(file, { readonly })`, `prepare(sql).run/get/all`, `exec`, `close`.
 * Statements are node:sqlite's own; their run/get/all already match (run returns
 * { changes, lastInsertRowid }, get returns undefined on no row, bare named parameters
 * bind @name/:name/$name).
 */
function createNodeSqliteDatabase(DatabaseSync) {
  class Database {
    constructor(filename, options = {}) {
      this._db = new DatabaseSync(filename, {
        readOnly: !!options.readonly,
        // better-sqlite3 waits up to 5s on a locked database; node:sqlite defaults to 0 and
        // would fail at once with SQLITE_BUSY while MultiTerminal is writing.
        timeout: options.timeout != null ? options.timeout : 5000,
      });
    }

    prepare(sql) {
      return this._db.prepare(sql);
    }

    exec(sql) {
      this._db.exec(sql);
      return this;
    }

    close() {
      this._db.close();
    }
  }
  Database.backend = 'node:sqlite';
  return Database;
}

/**
 * Human-actionable one-liner for when resolution fails — surface this to the user
 * (e.g. via SessionStart additionalContext) instead of a silent stderr no-op.
 */
function sqliteUnavailableMessage() {
  return 'MultiTerminal: no SQLite driver could be loaded — DB-backed '
    + 'features (profiles, session lifecycle, activity tracking) are disabled this '
    + 'session. The bundled better-sqlite3 binary did not load (it is built for one '
    + 'Node ABI/platform) and this Node has no built-in node:sqlite (needs Node 22.13 '
    + 'or later). Fix: upgrade Node to 22.13+, '
    + 'or `npm rebuild better-sqlite3` inside the plugin\'s vendor/node_modules/better-sqlite3 '
    + '(rebuilds for your ABI), '
    + 'or `npm install -g better-sqlite3` + set NODE_PATH, '
    + 'or set MT_BETTER_SQLITE3 to a module path built for your runtime.';
}

module.exports = {
  requireBetterSqlite3,
  sqliteUnavailableMessage,
  // test seams
  resolveSqlite,
  loadNodeSqlite,
};

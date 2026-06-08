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
 *
 * No hardcoded developer-machine paths. The bundled vendor/ copy (3) is what makes
 * this work out of the box; the installer (#2) is responsible for placing a
 * correctly-built binary there for the target's Node ABI.
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

  for (const modulePath of candidates) {
    try {
      cached = require(modulePath);
      return cached;
    } catch (e) {
      // try next candidate
    }
  }

  cached = null;
  return null;
}

/**
 * Human-actionable one-liner for when resolution fails — surface this to the user
 * (e.g. via SessionStart additionalContext) instead of a silent stderr no-op.
 */
function sqliteUnavailableMessage() {
  return 'MultiTerminal: better-sqlite3 native module could not be loaded — DB-backed '
    + 'features (profiles, session lifecycle, activity tracking) are disabled this '
    + 'session. This is usually one of two things: (a) the bundled binary was built '
    + 'for a different Node ABI/platform than your runtime (most common after a '
    + 'fresh GitHub install on a non-Windows-x64 box or a different Node major), or '
    + '(b) no binary is resolvable at all. Fix: '
    + '`npm rebuild better-sqlite3` inside the plugin\'s vendor/node_modules/better-sqlite3 '
    + '(rebuilds for your ABI), '
    + 'or `npm install -g better-sqlite3` + set NODE_PATH, '
    + 'or set MT_BETTER_SQLITE3 to a module path built for your runtime.';
}

module.exports = { requireBetterSqlite3, sqliteUnavailableMessage };

#!/usr/bin/env node
/**
 * session-compact-hook.js — SessionStart hook with matcher "compact".
 *
 * Fires ONLY after context compaction. Re-injects critical context that
 * would otherwise be lost: MultiTerminal rules + active task state.
 *
 * This ensures behavioral rules survive compaction without relying on
 * Claude's built-in memory system (which we've disabled).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const DB_PATH = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'multiterminal', 'multiterminal.db'
);

// ── Core (dispatcher-callable) ───────────────────────────────────────
// Ignores hookData (this hook has always drained but never parsed stdin — it
// keys entirely off env). Read-only: rules file + readonly DB, no writes/http/
// spawn. Deps injectable (fs / env / cwd / dbPath / requireBetterSqlite3) so the
// active-task branch is unit-testable with a stub DB and no live SQLite (ticket
// 42c91001). Emits via an `out` sink that replicates console.log's per-line
// newline exactly. Returns {exitCode:0, stdout?}. SYNC dispatch head (post-
// compaction context re-injection; not a decision → accumulates).
function run(hookData, deps = {}) {
  const _fs = deps.fs || fs;
  const env = deps.env || process.env;
  const cwd = deps.cwd || process.cwd();
  const dbPath = deps.dbPath || DB_PATH;
  // Lazy default require mirrors the original (resolved inside the try below).
  const requireDb = deps.requireBetterSqlite3
    || (() => require('./_sqlite').requireBetterSqlite3());

  const out = [];
  const emit = (s = '') => out.push(s); // one console.log ≡ one out entry + '\n'

  const terminalName = env.MULTITERMINAL_NAME || '';

  // 1. Re-inject rules
  try {
    const rulesPath = path.join(cwd, 'multiterminal-rules.md');
    if (_fs.existsSync(rulesPath)) {
      const rules = _fs.readFileSync(rulesPath, 'utf-8').trim();
      if (rules) {
        emit('[Post-Compaction Context Re-injection]');
        emit('');
        emit(rules);
        emit('');
      }
    }
  } catch {}

  // 2. Re-inject active task context
  if (terminalName) {
    try {
      // better-sqlite3 via the shared resolver (env → bare → vendor → plugin → APPDATA/npm);
      // drops the fragile ../../mcp-session-history relative path that fails on clean installs (issue #7).
      const Database = requireDb();
      if (Database && _fs.existsSync(dbPath)) {
        const db = new Database(dbPath, { readonly: true });
        const projectId = env.MULTITERMINAL_PROJECT_ID || null;

        const projectFilter = projectId ? ' AND project_id = ?' : '';
        const params = projectId ? [terminalName, projectId] : [terminalName];
        const task = db.prepare(`
          SELECT id, title, status, sub_status, checklist_json, continuation_notes
          FROM tasks
          WHERE assignee = ? AND status = 'in_progress'${projectFilter}
          ORDER BY CASE sub_status WHEN 'active' THEN 0 ELSE 1 END
          LIMIT 1
        `).get(...params);

        if (task) {
          emit(`## Active Task: ${task.title} [${task.id}]`);
          if (task.continuation_notes) {
            emit(`**Continuation Notes:** ${task.continuation_notes}`);
          }
          if (task.checklist_json && task.checklist_json !== '[]') {
            try {
              const items = JSON.parse(task.checklist_json);
              const done = items.filter(i => i.status === 'done').length;
              const testing = items.filter(i => i.status === 'testing').length;
              const coding = items.filter(i => i.status === 'coding').length;
              const pending = items.filter(i => i.status === 'pending').length;
              emit(`**Checklist:** ${done}/${items.length} done, ${testing} testing, ${coding} coding, ${pending} pending`);
            } catch {}
          }
          emit('');
        }
        db.close();
      }
    } catch {}
  }

  // 3. Remind identity
  if (terminalName) {
    emit(`You are ${terminalName}. Continue working on your active task.`);
  }

  return { exitCode: 0, stdout: out.length ? out.join('\n') + '\n' : '' };
}

module.exports = { run };

// ── CLI shim (standalone invocation — preserves exact prior behavior) ─
if (require.main === module) {
  (async () => {
    // Drain stdin for pipe compatibility (the hook has always ignored its body).
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
    }
    let out = { exitCode: 0 };
    try { out = run({}, {}); } catch { out = { exitCode: 0 }; }
    if (out && out.stdout) process.stdout.write(out.stdout);
    process.exit((out && out.exitCode) || 0);
  })().catch(() => process.exit(0));
}

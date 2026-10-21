#!/usr/bin/env node
/**
 * session-compact-hook.js — SessionStart hook with matcher "compact".
 *
 * Fires ONLY after context compaction. Re-injects the active task state and
 * identity that would otherwise be lost.
 *
 * Also reports the finished compaction to MT (reportCompactFinished, ticket c0ebcfd4), so a pane
 * that compacted itself with compact_my_context is told to continue.
 *
 * The agent rules are re-injected after compaction by agent-rules-hook.js
 * (matcher includes "compact"), read from the plugin, not from the cwd
 * (task 9d3404d9). This hook used to read multiterminal-rules.md from the
 * launch folder, which existed only in the MultiTerminal repo.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { isClarionEmbedded } = require('./embedded-session.js');

const DB_PATH = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'multiterminal', 'multiterminal.db'
);

// ── Core (dispatcher-callable) ───────────────────────────────────────
// Ignores hookData (this hook has always drained but never parsed stdin — it
// keys entirely off env). Read-only: readonly DB, no writes/http/
// spawn. Deps injectable (fs / env / dbPath / requireBetterSqlite3) so the
// active-task branch is unit-testable with a stub DB and no live SQLite (ticket
// 42c91001). Emits via an `out` sink that replicates console.log's per-line
// newline exactly. Returns {exitCode:0, stdout?}. SYNC dispatch head (post-
// compaction context re-injection; not a decision → accumulates).
function run(hookData, deps = {}) {
  const _fs = deps.fs || fs;
  const env = deps.env || process.env;
  // ClarionAssistant tab (ticket 9a731cda): print nothing. The block below re-injects an
  // MT kanban task and "You are <name>" after compaction; a CA tab is not an MT agent and gets
  // messaging only from this plugin.
  if (isClarionEmbedded(env)) {
    return { exitCode: 0, stdout: '' };
  }
  const dbPath = deps.dbPath || DB_PATH;
  // Lazy default require mirrors the original (resolved inside the try below).
  const requireDb = deps.requireBetterSqlite3
    || (() => require('./_sqlite').requireBetterSqlite3());

  const out = [];
  const emit = (s = '') => out.push(s); // one console.log ≡ one out entry + '\n'

  const terminalName = env.MULTITERMINAL_NAME || '';

  // 1. Re-inject active task context
  if (terminalName) {
    emit('[Post-Compaction Context Re-injection]');
    emit('');
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

  // 2. Remind identity
  if (terminalName) {
    emit(`You are ${terminalName}. Continue working on your active task.`);
  }

  return { exitCode: 0, stdout: out.length ? out.join('\n') + '\n' : '' };
}

// ── Report the finished compaction to MT (ticket c0ebcfd4) ──────────────
// A manual /compact ends with no new turn. When an agent compacted itself with compact_my_context,
// MT armed its pane to continue; this tells MT the compaction finished so it can type the continue
// prompt once the pane is idle. MT decides: a pane that armed nothing (the Owner's own /compact, an
// automatic compaction) is a no-op there. The pane is named by MULTITERMINAL_DOC_ID, which MT checks
// against the pane registered under MULTITERMINAL_NAME. Separate from run() so run() stays read-only.
//
// postToMt: POST a JSON body to MT's localhost REST API. Shared with compact-trigger-hook.js (the
// PreCompact leaf). Never throws; resolves with the status code, or null on error or after timeoutMs.
function postToMt(apiPath, body, timeoutMs = 3000) {
  return new Promise((resolve) => {
    try {
      const payload = JSON.stringify(body);
      const req = http.request({
        hostname: 'localhost',
        port: 5050,
        path: apiPath,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        timeout: timeoutMs,
      }, (res) => { res.on('data', () => {}); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.write(payload);
      req.end();
    } catch {
      resolve(null);
    }
  });
}

async function reportCompactFinished(hookData, deps = {}) {
  const env = deps.env || process.env;
  if (isClarionEmbedded(env)) return { posted: false, reason: 'embedded' };
  const agentName = env.MULTITERMINAL_NAME || '';
  const docId = env.MULTITERMINAL_DOC_ID || '';
  if (!agentName || !docId) return { posted: false, reason: 'not an MT pane' };
  const body = { agentName, docId, sessionId: (hookData && hookData.session_id) || null };
  const post = deps.post || ((b) => postToMt('/api/terminals/compact-finished', b));
  try {
    const status = await post(body);
    return { posted: true, body, status };
  } catch {
    return { posted: false, reason: 'post failed', body };
  }
}

module.exports = { run, reportCompactFinished, postToMt };

// ── CLI shim (standalone invocation — preserves exact prior behavior) ─
if (require.main === module) {
  (async () => {
    // Drain stdin. run() ignores it; reportCompactFinished reads session_id from it (ticket c0ebcfd4).
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
    }
    let hookData = {};
    try { hookData = JSON.parse(input || '{}') || {}; } catch { hookData = {}; }
    let out = { exitCode: 0 };
    try { out = run(hookData, {}); } catch { out = { exitCode: 0 }; }
    if (out && out.stdout) process.stdout.write(out.stdout);
    // After the context is written: MT only types once the pane is idle, so order is not load-bearing,
    // but a slow MT must never delay the re-injected context.
    try { await reportCompactFinished(hookData, {}); } catch { /* never fails the hook */ }
    process.exit((out && out.exitCode) || 0);
  })().catch(() => process.exit(0));
}

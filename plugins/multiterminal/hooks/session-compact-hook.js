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

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  const terminalName = process.env.MULTITERMINAL_NAME || '';

  // 1. Re-inject rules
  try {
    const rulesPath = path.join(process.cwd(), 'multiterminal-rules.md');
    if (fs.existsSync(rulesPath)) {
      const rules = fs.readFileSync(rulesPath, 'utf-8').trim();
      if (rules) {
        console.log('[Post-Compaction Context Re-injection]');
        console.log('');
        console.log(rules);
        console.log('');
      }
    }
  } catch {}

  // 2. Re-inject active task context
  if (terminalName) {
    try {
      // better-sqlite3 via the shared resolver (env → bare → vendor → plugin → APPDATA/npm);
      // drops the fragile ../../mcp-session-history relative path that fails on clean installs (issue #7).
      const { requireBetterSqlite3 } = require('./_sqlite');
      const Database = requireBetterSqlite3();
      if (Database && fs.existsSync(DB_PATH)) {
        const db = new Database(DB_PATH, { readonly: true });
        const projectId = process.env.MULTITERMINAL_PROJECT_ID || null;

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
          console.log(`## Active Task: ${task.title} [${task.id}]`);
          if (task.continuation_notes) {
            console.log(`**Continuation Notes:** ${task.continuation_notes}`);
          }
          if (task.checklist_json && task.checklist_json !== '[]') {
            try {
              const items = JSON.parse(task.checklist_json);
              const done = items.filter(i => i.status === 'done').length;
              const testing = items.filter(i => i.status === 'testing').length;
              const coding = items.filter(i => i.status === 'coding').length;
              const pending = items.filter(i => i.status === 'pending').length;
              console.log(`**Checklist:** ${done}/${items.length} done, ${testing} testing, ${coding} coding, ${pending} pending`);
            } catch {}
          }
          console.log('');
        }
        db.close();
      }
    } catch {}
  }

  // 3. Remind identity
  if (terminalName) {
    console.log(`You are ${terminalName}. Continue working on your active task.`);
  }

  process.exit(0);
}

main().catch(() => process.exit(0));

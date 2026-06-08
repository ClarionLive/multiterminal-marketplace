#!/usr/bin/env node
/**
 * Session Import Hook for Claude Code
 *
 * Automatically imports the current session transcript into the MultiTerminal
 * session lineage system when a session ends. Links the session to the
 * terminal's active kanban task (if any).
 *
 * Handles: SessionEnd
 * Hook data received via stdin: { session_id, transcript_path, cwd, hook_event_name }
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

const DB_PATH = path.join(process.env.APPDATA || '', 'multiterminal', 'multiterminal.db');

// better-sqlite3 resolution is centralized in _sqlite.js (issue #7) — no hardcoded paths.
const { requireBetterSqlite3 } = require('./_sqlite');

function httpPost(urlPath, body) {
  return new Promise((resolve) => {
    const postData = JSON.stringify(body);
    const req = http.request({
      hostname: 'localhost',
      port: 5050,
      path: urlPath,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
      timeout: 10000
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(postData);
    req.end();
  });
}

/**
 * Get the terminal's active kanban task ID from SQLite.
 * Returns { id, title } or null.
 */
function getActiveTask(agentName) {
  try {
    const Database = requireBetterSqlite3();
    if (!Database || !fs.existsSync(DB_PATH)) return null;

    const db = new Database(DB_PATH, { readonly: true });
    try {
      const row = db.prepare(`
        SELECT id, title FROM tasks
        WHERE assignee = ? AND status = 'in_progress' AND sub_status = 'active'
        LIMIT 1
      `).get(agentName);
      return row || null;
    } finally {
      db.close();
    }
  } catch (e) {
    return null;
  }
}

async function main() {
  // Read stdin
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let hookData;
  try { hookData = JSON.parse(input); } catch (e) { return; }

  const eventName = hookData.hook_event_name || hookData.hook_type || hookData.type;
  if (eventName !== 'SessionEnd') return;

  const agentName = process.env.MULTITERMINAL_NAME;
  if (!agentName) return; // Not a MultiTerminal session

  const transcriptPath = hookData.transcript_path;
  const sessionId = hookData.session_id;
  if (!transcriptPath || !sessionId) return;

  // Verify the transcript file exists
  if (!fs.existsSync(transcriptPath)) {
    process.stderr.write(`[session-import] Transcript not found: ${transcriptPath}\n`);
    return;
  }

  // Find the active task for this terminal
  const activeTask = getActiveTask(agentName);
  // If no active task, use a sentinel value so we still import the session
  const taskId = activeTask ? activeTask.id : '__unlinked__';

  // Import via REST API
  const result = await httpPost('/api/session-lineage/import', {
    sessionFilePath: transcriptPath,
    taskId: taskId,
    agentName: agentName,
    sessionType: 'terminal',
    parentSessionId: null
  });

  if (result && result.success) {
    process.stderr.write(`[session-import] Imported session ${sessionId} (${result.messageCount} msgs) → task ${taskId}\n`);
  } else {
    process.stderr.write(`[session-import] Failed to import session ${sessionId}: ${JSON.stringify(result)}\n`);
  }
}

main().catch(e => {
  process.stderr.write(`[session-import] Error: ${e.message}\n`);
});

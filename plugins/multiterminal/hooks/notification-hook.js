#!/usr/bin/env node
/**
 * Notification Hook for Claude Code → MultiTerminal → ClaudeRemote.
 * Captures Notification events (permission_prompt, idle_prompt, auth_success, elicitation_dialog)
 * and POSTs them to MultiTerminal's REST API for storage, UI toast, and phone push via ClaudeRemote.
 *
 * Configured globally in ~/.claude/settings.json under "Notification" hook event.
 * Fails silently if MultiTerminal API is unavailable (async, fire-and-forget).
 *
 * Debug logging: Set MT_DEBUG=1 environment variable to enable. Log capped at 100KB.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const API_PORT = 5050;
const API_TIMEOUT = 3000;
const DEBUG_LOG = path.join(os.tmpdir(), 'mt-notification-hook-debug.log');
const DEBUG_ENABLED = process.env.MT_DEBUG === '1';
const MAX_LOG_SIZE = 100 * 1024; // 100KB

function debugLog(msg) {
  if (!DEBUG_ENABLED) return;
  try {
    // Rotate log if it exceeds max size
    if (fs.existsSync(DEBUG_LOG)) {
      const stats = fs.statSync(DEBUG_LOG);
      if (stats.size > MAX_LOG_SIZE) {
        fs.renameSync(DEBUG_LOG, DEBUG_LOG + '.old');
      }
    }
    fs.appendFileSync(DEBUG_LOG, msg);
  } catch { /* ignore logging errors */ }
}

function callApi(apiPath, method, body) {
  return new Promise((resolve) => {
    const options = {
      hostname: 'localhost',
      port: API_PORT,
      path: apiPath,
      method: method || 'POST',
      headers: { 'Content-Type': 'application/json' },
      timeout: API_TIMEOUT
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ ok: res.statusCode === 200, data: JSON.parse(data) }); }
        catch { resolve({ ok: res.statusCode === 200, data: {} }); }
      });
    });
    req.on('error', () => resolve({ ok: false, data: {} }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, data: {} }); });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

// ── Core (dispatcher-callable) ───────────────────────────────────────
// ASYNC class (async:true → async dispatch head under B2). POSTs Notification
// events to MT for storage/toast/phone-push; callApi is injectable so tests don't
// hit :5050 (ticket 42c91001). No stdout; always returns {exitCode: 0}.
async function run(hookData, deps = {}) {
  const _callApi = deps.callApi || callApi;
  const timestamp = new Date().toISOString();
  const data = hookData || {};

  const hookType = data.hook_event_name;
  if (hookType !== 'Notification') {
    debugLog(`${timestamp} SKIPPED: not a Notification event (got ${hookType})\n`);
    return { exitCode: 0 };
  }

  const agentName = process.env.MULTITERMINAL_NAME || data.agent_type || 'Unknown';
  const rawType = data.notification_type || 'unknown';

  // Map Claude Code native notification types to ClaudeRemote-compatible types
  const typeMap = {
    'idle_prompt': 'permission_request',
    'elicitation_dialog': 'permission_request',
    'permission_prompt': 'permission_request',
  };
  const notificationType = typeMap[rawType] || rawType;

  // Provide meaningful messages for mapped types
  const messageMap = {
    'idle_prompt': `${agentName} is waiting for your input`,
    'elicitation_dialog': `${agentName} has a question that needs your response`,
    'permission_prompt': `${agentName} needs permission to continue`,
  };
  const title = data.title || notificationType;
  const message = messageMap[rawType] || data.message || '';
  const cwd = data.cwd || process.env.CLAUDE_PROJECT_DIR || '';

  // Try to read project name from .claude/project.json in the working directory
  let projectName = '';
  try {
    const projectJsonPath = path.join(cwd, '.claude', 'project.json');
    if (fs.existsSync(projectJsonPath)) {
      const proj = JSON.parse(fs.readFileSync(projectJsonPath, 'utf8'));
      projectName = proj.name || '';
    }
  } catch { /* ignore — project name is optional */ }

  debugLog(`${timestamp} NOTIFICATION: type=${notificationType} agent=${agentName} project="${projectName}" title="${title}" message="${message.substring(0, 100)}"\n`);

  const payload = {
    notification_type: notificationType,
    title: title,
    message: message,
    session_id: data.session_id || '',
    agent_name: agentName,
    project_name: projectName,
    cwd: cwd
  };

  const result = await _callApi('/api/notifications', 'POST', payload);
  debugLog(`${timestamp} API RESULT: ok=${result.ok}\n`);
  return { exitCode: 0 };
}

module.exports = { run };

// ── CLI shim (standalone invocation — preserves exact prior behavior) ─
if (require.main === module) {
  (async () => {
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
    }
    let hookData;
    try {
      hookData = JSON.parse(input);
    } catch (err) {
      debugLog(`${new Date().toISOString()} PARSE ERROR: ${err.message}\n`);
      return;
    }
    await run(hookData);
  })().catch(err => {
    debugLog(`${new Date().toISOString()} FATAL: ${err.message}\n`);
  });
}

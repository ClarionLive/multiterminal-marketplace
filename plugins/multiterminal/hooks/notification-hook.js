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
/**
 * Reads `<dir>/.claude/project.json` and returns its `name`, or '' if there isn't one.
 * Never throws: the project name is optional metadata and must not take a notification down.
 */
function readProjectName(dir) {
  try {
    const p = path.join(dir, '.claude', 'project.json');
    if (!fs.existsSync(p)) return '';
    const proj = JSON.parse(fs.readFileSync(p, 'utf8'));
    return (proj && typeof proj.name === 'string') ? proj.name : '';
  } catch {
    return '';   // unreadable or malformed — indistinguishable from absent, and equally optional
  }
}

/**
 * Resolves the MultiTerminal project name for a working directory.
 *
 * Tries the exact cwd first, then — if that missed and the cwd is inside an MT task
 * worktree — the repo root the worktree belongs to.
 *
 * MT's worktrees live at `<repo>/.claude/worktrees/<taskId>` and carry no project.json
 * of their own, so the previous single-join form returned '' for EVERY agent working in
 * a worktree, which is now the normal way agents work. The card's project line was
 * therefore blank almost always. (MultiTerminal task 42052f0c.)
 *
 * The suffix-strip deliberately mirrors `mcp/index.js`'s own worktree handling
 * (`target.replace(/[\\/]\.claude[\\/]worktrees[\\/].*$/, "")`) rather than walking up
 * the tree looking for any ancestor's project.json. A generic walk would happily adopt
 * an UNRELATED grandparent's project for a directory that simply has no project of its
 * own — silently mislabelling the card instead of leaving it honestly blank.
 */
function resolveProjectName(cwd) {
  if (!cwd) return '';

  const exact = readProjectName(cwd);
  if (exact) return exact;

  const repoRoot = String(cwd).replace(/[\\/]\.claude[\\/]worktrees[\\/].*$/, '');
  if (repoRoot && repoRoot !== cwd) return readProjectName(repoRoot);

  return '';
}

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

  const projectName = resolveProjectName(cwd);

  // keys= is deliberately logged: it is the cheapest way to settle whether Claude Code supplies a
  // tool_use_id on a Notification payload at all (MultiTerminal task 2289bb8a item 0 left that open
  // rather than assuming it). Key NAMES only — no values, so nothing sensitive reaches the log.
  debugLog(`${timestamp} NOTIFICATION: type=${notificationType} agent=${agentName} project="${projectName}" title="${title}" keys=${Object.keys(data).join(',')} message="${message.substring(0, 100)}"\n`);

  const payload = {
    notification_type: notificationType,
    title: title,
    message: message,
    session_id: data.session_id || '',
    agent_name: agentName,
    project_name: projectName,
    cwd: cwd,

    // ADDITIVE (MultiTerminal task 2289bb8a item 1). notification_type above keeps the flattened
    // permission_request value ClaudeRemote's push contract depends on — do not change it. These
    // two carry what that flattening destroys:
    //   raw_type    — which of the three it actually was. permission_prompt wants a yes/no,
    //                 elicitation_dialog is a real question, and idle_prompt is not a block at all
    //                 and must not raise an alert. One value cannot mean all three.
    //   tool_use_id — lets the consumer clear the alert when THIS call resolves, rather than
    //                 guessing from whatever happens next. May legitimately be absent; consumers
    //                 must degrade instead of assuming it is there.
    raw_type: rawType,
    tool_use_id: data.tool_use_id || ''
  };

  const result = await _callApi('/api/notifications', 'POST', payload);
  debugLog(`${timestamp} API RESULT: ok=${result.ok}\n`);
  return { exitCode: 0 };
}

module.exports = { run, resolveProjectName, readProjectName };

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

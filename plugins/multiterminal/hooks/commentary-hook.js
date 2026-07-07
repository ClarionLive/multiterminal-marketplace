#!/usr/bin/env node
/**
 * commentary-hook.js — Sends interesting agent events to the Commentator agent
 *
 * Fires on PostToolUse for tools like Edit, Write, Bash, Task, and MCP tools.
 * Filters for interesting events and sends them to "Commentator" via MT messaging.
 * Async + fire-and-forget — never blocks the agent.
 */

const http = require('http');

const MT_HOST = 'localhost';
const MT_PORT = 5050;
const COMMENTATOR_NAME = 'Commentator';

// Rate limiting — don't spam the commentator
let lastSentAt = 0;
const MIN_INTERVAL_MS = 3000; // At most one event every 3 seconds

// ── Core (dispatcher-callable) ───────────────────────────────────────
// ASYNC class (async:true → async dispatch head under B2). Sends interesting
// events to the Commentator via MT messaging; deps (getTerminals / sendMessage)
// are injectable so tests exercise the extract→send logic with stubs instead of
// firing HTTP at the running MultiTerminal (ticket 42c91001). No stdout; always
// returns {exitCode: 0} (fire-and-forget, never blocks).
async function run(hookData, deps = {}) {
  const _getTerminals = deps.getTerminals || getTerminals;
  const _sendMessage = deps.sendMessage || sendMessage;
  try {
    const agentName = process.env.MULTITERMINAL_NAME || 'Unknown';

    // Don't send events FROM the Commentator itself
    if (agentName === COMMENTATOR_NAME) {
      return { exitCode: 0 };
    }

    const event = extractEvent(hookData || {}, agentName);
    if (!event) {
      return { exitCode: 0 };
    }

    // Rate limit
    const now = Date.now();
    if (now - lastSentAt < MIN_INTERVAL_MS) {
      return { exitCode: 0 };
    }
    lastSentAt = now;

    // Get Commentator's terminal ID, then send
    const terminals = await _getTerminals();
    const commentator = terminals.find(t => t.name === COMMENTATOR_NAME);
    if (!commentator) {
      // Commentator not online — silently skip
      return { exitCode: 0 };
    }

    // Find sender's terminal ID
    const sender = terminals.find(t => t.name === agentName);
    const fromId = sender ? sender.id : 'unknown';

    await _sendMessage(fromId, COMMENTATOR_NAME, JSON.stringify(event));
    return { exitCode: 0 };
  } catch (err) {
    // Never block the agent
    return { exitCode: 0 };
  }
}

module.exports = { run };

// ── CLI shim (standalone invocation — preserves exact prior behavior) ─
if (require.main === module) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => input += chunk);
  process.stdin.on('end', async () => {
    try {
      const hookData = JSON.parse(input);
      await run(hookData);
    } catch (err) {
      // Never block the agent
    }
    process.exit(0);
  });
}

/**
 * Extract an interesting event from hook data, or null if not interesting
 */
function extractEvent(hookData, agentName) {
  const hookType = hookData.hook_event_name || '';
  const toolName = hookData.tool_name || '';
  const toolInput = hookData.tool_input || {};
  const toolOutput = hookData.tool_output || {};
  const error = hookData.tool_error || toolOutput.error || '';
  const timestamp = new Date().toISOString();

  // Build/compile results
  if (toolName.includes('build_project')) {
    const success = toolOutput.success || toolOutput.exitCode === 0;
    return {
      type: 'build',
      agent: agentName,
      success,
      project: toolInput.projectId || toolInput.project || '',
      details: success ? 'Build succeeded' : (error || 'Build failed'),
      timestamp
    };
  }

  // Bash commands — look for test runs, git operations, errors
  if (toolName === 'Bash') {
    const cmd = toolInput.command || '';
    const output = typeof toolOutput === 'string' ? toolOutput : (toolOutput.output || toolOutput.stdout || '');
    const exitCode = toolOutput.exitCode ?? toolOutput.exit_code;

    // Test runs
    if (cmd.match(/test|jest|pytest|dotnet test|npm test|vitest/i)) {
      const passed = exitCode === 0;
      return {
        type: 'test',
        agent: agentName,
        success: passed,
        command: cmd.substring(0, 100),
        details: passed ? 'Tests passed' : 'Tests FAILED',
        timestamp
      };
    }

    // Git commits
    if (cmd.match(/git commit/)) {
      return {
        type: 'git_commit',
        agent: agentName,
        command: cmd.substring(0, 100),
        details: output.substring(0, 200),
        timestamp
      };
    }

    // Git push
    if (cmd.match(/git push/)) {
      return {
        type: 'git_push',
        agent: agentName,
        success: exitCode === 0,
        details: output.substring(0, 200),
        timestamp
      };
    }

    // Command failures
    if (exitCode !== 0 && exitCode !== undefined) {
      return {
        type: 'error',
        agent: agentName,
        command: cmd.substring(0, 100),
        exitCode,
        details: (output || error || '').substring(0, 200),
        timestamp
      };
    }

    // Skip routine bash commands
    return null;
  }

  // File edits
  if (toolName === 'Edit' || toolName === 'Write') {
    const filePath = toolInput.file_path || '';
    const fileName = filePath.split(/[/\\]/).pop() || filePath;
    return {
      type: 'file_change',
      agent: agentName,
      action: toolName === 'Write' ? 'created' : 'edited',
      file: fileName,
      path: filePath,
      timestamp
    };
  }

  // Task operations
  if (toolName.includes('update_task_status')) {
    return {
      type: 'task_status',
      agent: agentName,
      taskId: toolInput.taskId || '',
      newStatus: toolInput.status || '',
      timestamp
    };
  }

  if (toolName.includes('update_task_checklist')) {
    return {
      type: 'checklist_update',
      agent: agentName,
      taskId: toolInput.taskId || '',
      newStatus: toolInput.newStatus || '',
      itemIndex: toolInput.itemIndex,
      notes: (toolInput.notes || '').substring(0, 100),
      timestamp
    };
  }

  // Agent spawning
  if (toolName === 'Task' || toolName.includes('spawn')) {
    return {
      type: 'agent_spawn',
      agent: agentName,
      description: (toolInput.description || toolInput.prompt || '').substring(0, 100),
      timestamp
    };
  }

  // Tool failures
  if (hookType === 'PostToolUseFailure') {
    return {
      type: 'tool_failure',
      agent: agentName,
      tool: toolName,
      error: (error || '').substring(0, 200),
      timestamp
    };
  }

  return null;
}

function getTerminals() {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: MT_HOST, port: MT_PORT,
      path: '/api/messaging/terminals',
      method: 'GET', timeout: 2000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
    req.on('timeout', () => { req.destroy(); resolve([]); });
    req.end();
  });
}

function sendMessage(fromId, to, message) {
  return new Promise((resolve) => {
    const postData = JSON.stringify({ fromTerminalId: fromId, to, message });
    const req = http.request({
      hostname: MT_HOST, port: MT_PORT,
      path: '/api/messaging/send',
      method: 'POST', timeout: 2000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
    }, (res) => {
      res.on('data', () => {});
      res.on('end', () => resolve(true));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.write(postData);
    req.end();
  });
}

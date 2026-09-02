#!/usr/bin/env node
/**
 * Activity Recording Hook for Claude Code
 *
 * Records tool usage, build events, and subagent activity to the MultiTerminal activity feed.
 * Handles: PreToolUse, PostToolUse, PostToolUseFailure, SubagentStart, SubagentStop
 *
 * Hook data is received via stdin as JSON.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

// Database path
const DB_PATH = path.join(process.env.APPDATA || '', 'multiterminal', 'tasks.db');

// Subagent-to-Office bridge: maps agent IDs to registered terminal names
const SUBAGENT_MAP_PATH = path.join(process.env.APPDATA || '', 'multiterminal', 'subagent-map.json');

// better-sqlite3 resolution is centralized in _sqlite.js (issue #7) — no hardcoded paths.
const { requireBetterSqlite3 } = require('./_sqlite');

// Build patterns to detect
const BUILD_PATTERNS = [
  { pattern: /dotnet\s+(build|publish|test|run)/i, type: 'dotnet' },
  { pattern: /msbuild/i, type: 'msbuild' },
  { pattern: /npm\s+(run\s+)?(build|test|start)/i, type: 'npm' },
  { pattern: /yarn\s+(build|test|start)/i, type: 'yarn' },
  { pattern: /go\s+(build|test|run)/i, type: 'go' },
  { pattern: /cargo\s+(build|test|run)/i, type: 'cargo' },
  { pattern: /pytest|python.*-m\s+pytest/i, type: 'pytest' },
  { pattern: /jest|vitest|mocha/i, type: 'test' },
];

// Tools to skip logging (too noisy)
const SKIP_TOOLS = new Set(['Read', 'Glob', 'Grep', 'ToolSearch']);

/**
 * Record activity to the MultiTerminal database
 */
function recordActivity(activityType, actor, summary, severity = 'info', detailsJson = null) {
  try {
    const Database = requireBetterSqlite3();
    if (!Database) {
      return false;
    }

    if (!fs.existsSync(DB_PATH)) {
      return false;
    }

    const db = new Database(DB_PATH);

    const timestamp = new Date().toISOString();

    const stmt = db.prepare(`
      INSERT INTO activity_feed (timestamp, activity_type, actor, summary, severity, details_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(timestamp, activityType, actor, summary, severity, detailsJson);
    db.close();

    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Detect if a command is a build/test command
 */
function detectBuildCommand(command) {
  for (const { pattern, type } of BUILD_PATTERNS) {
    if (pattern.test(command)) {
      return type;
    }
  }
  return null;
}

/**
 * Extract project name from command or path
 */
function extractProjectName(command, cwd) {
  const slnMatch = command.match(/(\w+\.sln)/i);
  if (slnMatch) return slnMatch[1].replace('.sln', '');

  const csprojMatch = command.match(/(\w+\.csproj)/i);
  if (csprojMatch) return csprojMatch[1].replace('.csproj', '');

  if (cwd) {
    return path.basename(cwd);
  }

  return 'project';
}

/**
 * Get a short summary of tool input
 */
function getToolSummary(tool, input) {
  if (!input) return tool;

  switch (tool) {
    case 'Bash':
      const cmd = input.command || '';
      return cmd.length > 60 ? cmd.substring(0, 60) + '...' : cmd;
    case 'Edit':
    case 'Write':
      return input.file_path ? path.basename(input.file_path) : tool;
    case 'Task':
      return input.description || input.subagent_type || 'subagent';
    default:
      return tool;
  }
}

// ─────────────────────────────────────────────────
// Subagent-to-Office Bridge
// Registers/disconnects virtual terminals so subagents
// appear as animated characters in the OfficePanel.
// ─────────────────────────────────────────────────

/**
 * HTTP POST helper for the MultiTerminal REST API
 */
function httpPost(urlPath, body) {
  return new Promise((resolve) => {
    const postData = JSON.stringify(body);
    const req = http.request({
      hostname: 'localhost',
      port: 5050,
      path: urlPath,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
      timeout: 3000
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

function loadSubagentMap() {
  try {
    if (fs.existsSync(SUBAGENT_MAP_PATH)) {
      return JSON.parse(fs.readFileSync(SUBAGENT_MAP_PATH, 'utf8'));
    }
  } catch (e) { /* ignore */ }
  return {};
}

function saveSubagentMap(map) {
  try {
    const dir = path.dirname(SUBAGENT_MAP_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SUBAGENT_MAP_PATH, JSON.stringify(map, null, 2));
  } catch (e) { /* ignore */ }
}

/**
 * Register a subagent as a virtual terminal so it appears in the office.
 * Uses "Agent " name prefix convention to distinguish from real terminals.
 */
async function registerSubagent(hookData) {
  const rawName = hookData.name || hookData.input?.name || hookData.subagent_type || 'Worker';
  const agentName = rawName.startsWith('Agent ') ? rawName : `Agent ${rawName}`;
  const agentKey = hookData.agent_id || hookData.session_id || `sa-${Date.now()}`;
  const docId = `subagent-${agentKey}`;

  const result = await httpPost('/api/messaging/register', { name: agentName, docId });

  if (result && result.terminalId) {
    const map = loadSubagentMap();
    map[agentKey] = { name: agentName, terminalId: result.terminalId };
    saveSubagentMap(map);
  }

  return agentName;
}

/**
 * Disconnect a subagent's virtual terminal so it leaves the office.
 */
async function disconnectSubagent(hookData) {
  const agentKey = hookData.agent_id || hookData.session_id;
  let agentName = null;

  // Look up name from mapping
  if (agentKey) {
    const map = loadSubagentMap();
    if (map[agentKey]) {
      agentName = map[agentKey].name;
      delete map[agentKey];
      saveSubagentMap(map);
    }
  }

  // Fallback: construct name from available data
  if (!agentName) {
    const rawName = hookData.name || hookData.input?.name;
    if (rawName) {
      agentName = rawName.startsWith('Agent ') ? rawName : `Agent ${rawName}`;
    }
  }

  if (agentName) {
    await httpPost('/api/messaging/disconnect', { name: agentName });
  }
}

/**
 * Process stdin and handle the hook event
 */
// ── Core (dispatcher-callable) ───────────────────────────────────────
// ASYNC class (async:true in hooks.json → ASYNC dispatch head under B2). Records
// activity to DB + bridges subagents via HTTP — all side-effects, no stdout, no
// blocking. Deps (recordActivity / registerSubagent / disconnectSubagent) are
// injectable so tests exercise the event→side-effect dispatch with spies instead
// of firing real DB writes / HTTP at the running MultiTerminal (ticket 42c91001).
// Always returns {exitCode: 0}; the dispatcher ignores async-leaf output.
async function run(hookData, deps = {}) {
  const _recordActivity = deps.recordActivity || recordActivity;
  const _registerSubagent = deps.registerSubagent || registerSubagent;
  const _disconnectSubagent = deps.disconnectSubagent || disconnectSubagent;

  const data = hookData || {};
  const terminalName = process.env.MULTITERMINAL_NAME || 'Unknown';

  // PROVENANCE (MultiTerminal task edcdcdd5). Stamped onto every row this hook writes.
  //
  // activity_feed.actor is MULTITERMINAL_NAME, which SUBAGENTS INHERIT -- so a subagent's tool
  // calls are logged under its parent's name and are indistinguishable from the parent's own.
  // Measured in the 2289bb8a spike at 12,544 of 64,444 PreToolUse events (19.5%).
  //
  // That matters because MultiTerminal's attention rail clears a "blocked on the owner" alert when
  // it observes the agent working again. Clearing on a SUBAGENT's activity would clear a parent
  // that is still genuinely waiting -- and a false clear renders a calm card, which looks exactly
  // like nobody needing you. Refusing to clear only leaves a stale pulse, which is dismissible.
  //
  // agent_id is present on subagent-originated events (this file already relies on it for office
  // register/disconnect) and absent for the main thread. A consumer MUST treat a row with no
  // agent_id field at all -- every row written before this change -- as possibly-subagent rather
  // than as main-thread, or the safe default inverts on exactly the historical data.
  const provenance = {
    agent_id: data.agent_id || null,
    session_id: data.session_id || null,
  };
  const details = (obj) => JSON.stringify({ ...(obj || {}), ...provenance });
  const hookType = data.hook_event_name || data.hook_type || data.type;
  const tool = data.tool_name || data.tool || '';
  // Normalize input: Claude Code uses tool_input, not input
  if (data.tool_input && !data.input) {
    data.input = data.tool_input;
  }

  // Debug: dump hook data to file for inspection
  const debugPath = path.join(process.env.APPDATA || '', 'multiterminal', 'hook-debug.log');
  try {
    const debugLine = `[${new Date().toISOString()}] ${hookType} tool=${tool} keys=${Object.keys(data).join(',')}\n`;
    fs.appendFileSync(debugPath, debugLine);
    if (hookType === 'SubagentStart' || hookType === 'SubagentStop' || tool === 'Task') {
      fs.appendFileSync(debugPath, `  FULL DATA: ${JSON.stringify(data, null, 2)}\n`);
    }
  } catch(e) { /* ignore debug failures */ }

  // Handle different hook types
  switch (hookType) {
    case 'PreToolUse': {
      // Skip noisy read-only tools
      if (SKIP_TOOLS.has(tool)) break;

      // Register subagent when Task tool is about to be called
      if (tool === 'Task') {
        const rawName = data.input?.name || data.input?.description || 'Worker';
        await _registerSubagent({
          name: rawName,
          subagent_type: data.input?.subagent_type || 'general-purpose',
          agent_id: rawName
        });
      }

      const summary = getToolSummary(tool, data.input);
      _recordActivity('TOOL_START', terminalName, `${tool}: ${summary}`, 'info',
        details({ tool, input: data.input }));
      break;
    }

    case 'PostToolUse': {
      // Disconnect subagent when Task tool completes
      if (tool === 'Task') {
        const rawName = data.input?.name || data.input?.description || 'Worker';
        await _disconnectSubagent({
          name: rawName,
          agent_id: rawName
        });
      }

      // Special handling for build commands
      if (tool === 'Bash') {
        const command = data.input?.command || '';
        const buildType = detectBuildCommand(command);

        if (buildType) {
          const exitCode = data.output?.exit_code ?? data.exit_code ?? 0;
          const success = exitCode === 0;
          const projectName = extractProjectName(command, data.cwd);

          const activityType = success ? 'BUILD_SUCCEEDED' : 'BUILD_FAILED';
          const summary = success
            ? `Build succeeded: ${projectName}`
            : `Build failed: ${projectName}`;
          const severity = success ? 'info' : 'error';

          _recordActivity(activityType, terminalName, summary, severity,
            details({ buildType, projectName, exitCode }));
          break;
        }
      }

      // Skip noisy read-only tools
      if (SKIP_TOOLS.has(tool)) break;

      const summary = getToolSummary(tool, data.input);
      _recordActivity('TOOL_COMPLETE', terminalName, `${tool}: ${summary}`, 'info',
        details({ tool }));
      break;
    }

    case 'PostToolUseFailure': {
      const error = data.error || data.output?.error || 'Unknown error';
      const summary = `${tool} failed: ${error.substring(0, 100)}`;
      _recordActivity('TOOL_FAILED', terminalName, summary, 'error',
        details({ tool, error }));
      break;
    }

    case 'Stop': {
      // TURN_END is the clear-edge for a block the owner DISMISSED rather than answered
      // (MultiTerminal task edcdcdd5).
      //
      // The 2289bb8a spike concluded UserPromptSubmit was the unblock signal. It is not sufficient:
      // pressing ESCAPE on a permission prompt submits no prompt, so the alert stayed lit. The owner
      // hit exactly this -- a card pulsing "needs permission" 49 minutes after they had dismissed it.
      //
      // Escape ends the turn, so Stop fires. "Turn ended" is not a block: nobody is being waited on.
      // Recorded here rather than POSTed because the row is the transport MultiTerminal already
      // polls, and adding an HTTP call to a hook that fires on every turn is not free.
      _recordActivity('TURN_END', terminalName, 'Turn ended', 'info', details({}));
      break;
    }

    case 'SubagentStart': {
      const agentType = data.subagent_type || data.agent_type || 'unknown';
      const description = data.description || data.prompt?.substring(0, 50) || '';
      _recordActivity('SUBAGENT_START', terminalName, `Started ${agentType}: ${description}`, 'info',
        details({ agentType, description }));
      // Note: Office registration handled by PreToolUse for Task tool (has full name data)
      break;
    }

    case 'SubagentStop': {
      const agentType = data.subagent_type || data.agent_type || 'unknown';
      const success = data.success !== false;
      const activityType = success ? 'SUBAGENT_COMPLETE' : 'SUBAGENT_FAILED';
      const severity = success ? 'info' : 'warning';
      _recordActivity(activityType, terminalName, `${agentType} ${success ? 'completed' : 'failed'}`, severity,
        details({ agentType, success }));
      // Note: Office disconnect handled by PostToolUse for Task tool (has full name data)
      break;
    }
  }

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

    if (!input.trim()) {
      return;
    }

    let hookData;
    try {
      hookData = JSON.parse(input);
    } catch (err) {
      return;
    }

    await run(hookData);
  })().catch(() => {});
}

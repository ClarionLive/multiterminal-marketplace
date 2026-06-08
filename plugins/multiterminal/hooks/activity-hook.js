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
async function main() {
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

  const terminalName = process.env.MULTITERMINAL_NAME || 'Unknown';
  const hookType = hookData.hook_event_name || hookData.hook_type || hookData.type;
  const tool = hookData.tool_name || hookData.tool || '';
  // Normalize input: Claude Code uses tool_input, not input
  if (hookData.tool_input && !hookData.input) {
    hookData.input = hookData.tool_input;
  }

  // Debug: dump hook data to file for inspection
  const debugPath = path.join(process.env.APPDATA || '', 'multiterminal', 'hook-debug.log');
  try {
    const debugLine = `[${new Date().toISOString()}] ${hookType} tool=${tool} keys=${Object.keys(hookData).join(',')}\n`;
    fs.appendFileSync(debugPath, debugLine);
    if (hookType === 'SubagentStart' || hookType === 'SubagentStop' || tool === 'Task') {
      fs.appendFileSync(debugPath, `  FULL DATA: ${JSON.stringify(hookData, null, 2)}\n`);
    }
  } catch(e) { /* ignore debug failures */ }

  // Handle different hook types
  switch (hookType) {
    case 'PreToolUse': {
      // Skip noisy read-only tools
      if (SKIP_TOOLS.has(tool)) break;

      // Register subagent when Task tool is about to be called
      if (tool === 'Task') {
        const rawName = hookData.input?.name || hookData.input?.description || 'Worker';
        await registerSubagent({
          name: rawName,
          subagent_type: hookData.input?.subagent_type || 'general-purpose',
          agent_id: rawName
        });
      }

      const summary = getToolSummary(tool, hookData.input);
      recordActivity('TOOL_START', terminalName, `${tool}: ${summary}`, 'info',
        JSON.stringify({ tool, input: hookData.input }));
      break;
    }

    case 'PostToolUse': {
      // Disconnect subagent when Task tool completes
      if (tool === 'Task') {
        const rawName = hookData.input?.name || hookData.input?.description || 'Worker';
        await disconnectSubagent({
          name: rawName,
          agent_id: rawName
        });
      }

      // Special handling for build commands
      if (tool === 'Bash') {
        const command = hookData.input?.command || '';
        const buildType = detectBuildCommand(command);

        if (buildType) {
          const exitCode = hookData.output?.exit_code ?? hookData.exit_code ?? 0;
          const success = exitCode === 0;
          const projectName = extractProjectName(command, hookData.cwd);

          const activityType = success ? 'BUILD_SUCCEEDED' : 'BUILD_FAILED';
          const summary = success
            ? `Build succeeded: ${projectName}`
            : `Build failed: ${projectName}`;
          const severity = success ? 'info' : 'error';

          recordActivity(activityType, terminalName, summary, severity,
            JSON.stringify({ buildType, projectName, exitCode }));
          break;
        }
      }

      // Skip noisy read-only tools
      if (SKIP_TOOLS.has(tool)) break;

      const summary = getToolSummary(tool, hookData.input);
      recordActivity('TOOL_COMPLETE', terminalName, `${tool}: ${summary}`, 'info',
        JSON.stringify({ tool }));
      break;
    }

    case 'PostToolUseFailure': {
      const error = hookData.error || hookData.output?.error || 'Unknown error';
      const summary = `${tool} failed: ${error.substring(0, 100)}`;
      recordActivity('TOOL_FAILED', terminalName, summary, 'error',
        JSON.stringify({ tool, error }));
      break;
    }

    case 'SubagentStart': {
      const agentType = hookData.subagent_type || hookData.agent_type || 'unknown';
      const description = hookData.description || hookData.prompt?.substring(0, 50) || '';
      recordActivity('SUBAGENT_START', terminalName, `Started ${agentType}: ${description}`, 'info',
        JSON.stringify({ agentType, description }));
      // Note: Office registration handled by PreToolUse for Task tool (has full name data)
      break;
    }

    case 'SubagentStop': {
      const agentType = hookData.subagent_type || hookData.agent_type || 'unknown';
      const success = hookData.success !== false;
      const activityType = success ? 'SUBAGENT_COMPLETE' : 'SUBAGENT_FAILED';
      const severity = success ? 'info' : 'warning';
      recordActivity(activityType, terminalName, `${agentType} ${success ? 'completed' : 'failed'}`, severity,
        JSON.stringify({ agentType, success }));
      // Note: Office disconnect handled by PostToolUse for Task tool (has full name data)
      break;
    }
  }
}

main().catch(() => {});

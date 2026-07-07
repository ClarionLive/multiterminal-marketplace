#!/usr/bin/env node
/**
 * Office Panel Hook for Claude Code SubagentStart/SubagentStop events.
 * Calls the MultiTerminal REST API to trigger walk-in/exit animations
 * for native Claude Code subagents in the Office Panel.
 *
 * Uses a temp file to track agent_id → display_name mappings so that
 * SubagentStop can correctly identify which agent to remove.
 *
 * Ghost agent cleanup: Tracks session_id per agent. On SubagentStart,
 * any agents from a different session are auto-departed (handles
 * interrupted/cancelled agents that never got a SubagentStop).
 *
 * DISPATCHER FORM (ticket 42c91001): side-effect-only (no stdout). The event
 * branches (Start/Stop/TeammateIdle) fire REST calls + temp-file tracking, so
 * run(hookData, deps) takes injectable callApi/fs/env/now/nowIso/random and the
 * spawn/depart/ghost-cleanup logic is unit-tested with stubs — no live office
 * API. Self-gates on hook_event_name, so it dispatches on SubagentStart/Stop and
 * TeammateIdle (SYNC; Claude waits, but it emits no decision). The debug trace
 * (temp mt-office-hook-debug.log) is diagnostic-only and NOT part of the
 * behavioral contract — its exact bytes are not asserted by the equivalence
 * harness. The CLI shim preserves the standalone stdout/stderr/exit behavior.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TRACKING_FILE = path.join(os.tmpdir(), 'mt-office-agents.json');
const PENDING_DESC_FILE = path.join(os.tmpdir(), 'mt-pending-agent-descriptions.json');
const DEBUG_LOG = path.join(os.tmpdir(), 'mt-office-hook-debug.log');
const API_PORT = 5050;
const API_TIMEOUT = 3000;

/**
 * Pop the oldest pending description written by task-to-agent-hook.js.
 * Returns { description, name, subagentType } or null.
 */
function popPendingDescription(_fs = fs, nowMs = Date.now()) {
  try {
    if (!_fs.existsSync(PENDING_DESC_FILE)) return null;
    let pending = JSON.parse(_fs.readFileSync(PENDING_DESC_FILE, 'utf8'));
    if (!Array.isArray(pending) || pending.length === 0) return null;
    // Remove stale entries older than 30 seconds
    const cutoff = nowMs - 30000;
    pending = pending.filter(e => e.timestamp > cutoff);
    if (pending.length === 0) {
      _fs.writeFileSync(PENDING_DESC_FILE, '[]', 'utf8');
      return null;
    }
    const entry = pending.shift();
    _fs.writeFileSync(PENDING_DESC_FILE, JSON.stringify(pending), 'utf8');
    return entry;
  } catch (e) {
    return null;
  }
}

function loadTracking(_fs = fs) {
  try {
    if (_fs.existsSync(TRACKING_FILE)) {
      return JSON.parse(_fs.readFileSync(TRACKING_FILE, 'utf8'));
    }
  } catch (e) {
    // Corrupted file, start fresh
  }
  return {};
}

function saveTracking(data, _fs = fs) {
  try {
    const tempPath = TRACKING_FILE + '.tmp';
    _fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
    _fs.renameSync(tempPath, TRACKING_FILE);
  } catch (e) {
    console.error('Failed to save tracking file:', e.message);
  }
}

function callApi(apiPath, method, body) {
  return new Promise((resolve) => {
    const options = {
      hostname: 'localhost',
      port: API_PORT,
      path: apiPath,
      method: method,
      headers: { 'Content-Type': 'application/json' },
      timeout: API_TIMEOUT
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ ok: res.statusCode === 200, data: JSON.parse(data) });
        } catch (e) {
          resolve({ ok: res.statusCode === 200, data: {} });
        }
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

/**
 * Clean up ghost agents from previous sessions.
 * Any tracked agent whose session_id differs from the current session
 * gets departed via the API and removed from tracking.
 */
async function cleanupGhostAgents(tracking, currentSessionId, debugLog, deps = {}) {
  const _callApi = deps.callApi || callApi;
  const _fs = deps.fs || fs;
  const _saveTracking = deps.saveTracking || saveTracking;

  const ghostIds = Object.keys(tracking).filter(id => {
    const entry = tracking[id];
    // Old format (string) or different session = ghost
    if (typeof entry === 'string') return true;
    return entry.sessionId && entry.sessionId !== currentSessionId;
  });

  for (const ghostId of ghostIds) {
    const entry = tracking[ghostId];
    const displayName = typeof entry === 'string' ? entry : entry.name;
    if (displayName) {
      try { _fs.appendFileSync(debugLog, `CLEANUP GHOST: ${ghostId} → ${displayName}\n`); } catch {}
      await _callApi(`/api/office/agents/${encodeURIComponent(displayName)}`, 'DELETE');
    }
    delete tracking[ghostId];
  }

  if (ghostIds.length > 0) {
    _saveTracking(tracking, _fs);
  }

  return ghostIds.length;
}

// ── Core (dispatcher-callable) ───────────────────────────────────────
// Parsed hookData in (CLI shim reads stdin + handles malformed). Injectable
// callApi / fs / env / now / nowIso / random so the spawn/depart/ghost-cleanup
// paths are unit-testable with stubs. Side-effect-only → returns {exitCode:0}.
async function run(hookData, deps = {}) {
  const _callApi = deps.callApi || callApi;
  const _fs = deps.fs || fs;
  const env = deps.env || process.env;
  const nowIso = typeof deps.nowIso === 'function' ? deps.nowIso : () => new Date().toISOString();
  const nowMs = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const random = typeof deps.random === 'function' ? deps.random : () => Math.random();
  const debugLog = deps.debugLog || DEBUG_LOG;
  const dlog = (msg) => { try { _fs.appendFileSync(debugLog, msg); } catch {} };

  dlog(`PARSED KEYS: ${JSON.stringify(Object.keys(hookData || {}))}\nFULL DATA: ${JSON.stringify(hookData, null, 2)}\n`);

  const hookType = hookData.hook_event_name;
  const agentId = hookData.agent_id || '';
  const sessionId = hookData.session_id || '';
  const agentType = hookData.agent_type || 'Subagent';
  const parentName = env.MULTITERMINAL_NAME || 'Claude';

  // Generate unique agent name: AG-XXXX
  const agentDisplayName = 'AG-' + String(Math.floor(1000 + random() * 9000));

  if (hookType === 'SubagentStart') {
    // Clean up ghost agents from previous sessions before spawning
    const tracking = loadTracking(_fs);
    const cleaned = await cleanupGhostAgents(tracking, sessionId, debugLog, { callApi: _callApi, fs: _fs });
    if (cleaned > 0) {
      dlog(`CLEANED ${cleaned} ghost agent(s) from previous sessions\n`);
    }

    // Spawn agent with unique AG-XXXX name
    const result = await _callApi('/api/office/agents', 'POST', {
      name: agentDisplayName,
      spawnedBy: parentName
    });

    // Track with session_id and transcript path so we can detect ghosts later
    if (result.ok && result.data.agentName) {
      const transcriptDir = path.dirname(hookData.transcript_path || '');
      const agentTranscriptPath = transcriptDir
        ? path.join(transcriptDir, sessionId, 'subagents', `agent-${agentId}.jsonl`)
        : '';
      // Pop pending description from task-to-agent-hook (Explore/Plan agents)
      const pendingDesc = popPendingDescription(_fs, nowMs());
      const freshTracking = loadTracking(_fs);
      freshTracking[agentId] = {
        name: result.data.agentName,
        sessionId: sessionId,
        transcriptPath: agentTranscriptPath,
        spawnerName: parentName,
        taskDescription: pendingDesc?.description || '',
        subagentType: pendingDesc?.subagentType || agentType,
        agentName: pendingDesc?.name || '',
        startedAt: nowIso()
      };
      saveTracking(freshTracking, _fs);
      dlog(`TRACKED: ${agentId} → ${result.data.agentName}, desc: "${pendingDesc?.description || ''}", transcript: ${agentTranscriptPath}\n`);
    }

  } else if (hookType === 'SubagentStop') {
    // Depart agent - look up the display name we stored on spawn
    const tracking = loadTracking(_fs);
    const entry = tracking[agentId];
    // Handle both old format (string) and new format (object with name+sessionId)
    const displayName = entry
      ? (typeof entry === 'string' ? entry : entry.name)
      : agentType;

    if (displayName) {
      await _callApi(`/api/office/agents/${encodeURIComponent(displayName)}`, 'DELETE');
    }

    // Close the agent panel via REST API (use hookData.agent_transcript_path if available,
    // fall back to tracked path in case hook data is missing)
    const transcriptPath = hookData.agent_transcript_path ||
      (entry && typeof entry === 'object' ? entry.transcriptPath : '');
    if (transcriptPath) {
      dlog(`CLOSE PANEL: ${transcriptPath}\n`);
      await _callApi('/api/agent-panels/close', 'POST', { transcriptPath });
    }

    // Don't delete tracking entry here — TeamWatcher may not have read it yet.
    // Ghost cleanup on SubagentStart (session ID check) handles stale entries.

  } else if (hookType === 'TeammateIdle') {
    // TeammateIdle fires when a teammate/subagent goes idle (including cancellation).
    // Depart the agent if we're tracking it, or depart by teammate_id if provided.
    dlog(`TEAMMATE_IDLE: agent_id=${agentId}, looking up in tracking\n`);
    const tracking = loadTracking(_fs);

    if (agentId && tracking[agentId]) {
      const entry = tracking[agentId];
      const displayName = typeof entry === 'string' ? entry : entry.name;
      dlog(`TEAMMATE_IDLE DEPART: ${agentId} → ${displayName}\n`);
      if (displayName) {
        await _callApi(`/api/office/agents/${encodeURIComponent(displayName)}`, 'DELETE');
      }
      delete tracking[agentId];
      saveTracking(tracking, _fs);
    } else {
      // Log what data we got so we can map it in the future
      dlog(`TEAMMATE_IDLE: No matching tracked agent. Keys in tracking: ${JSON.stringify(Object.keys(tracking))}\n`);
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

    // Debug: log raw input (diagnostic only)
    try {
      fs.appendFileSync(DEBUG_LOG, `\n--- ${new Date().toISOString()} ---\nRAW INPUT: ${input}\nENV MULTITERMINAL_NAME: ${process.env.MULTITERMINAL_NAME || '(not set)'}\nENV CLAUDE_PROJECT_DIR: ${process.env.CLAUDE_PROJECT_DIR || '(not set)'}\n`);
    } catch {}

    let hookData;
    try {
      hookData = JSON.parse(input);
    } catch (err) {
      try { fs.appendFileSync(DEBUG_LOG, `PARSE ERROR: ${err.message}\n`); } catch {}
      console.error('Failed to parse hook input:', err.message);
      return;
    }

    try {
      await run(hookData, {});
    } catch (err) {
      console.error('Hook error:', err.message);
    }
  })().catch((err) => {
    console.error('Hook error:', err.message);
  });
}

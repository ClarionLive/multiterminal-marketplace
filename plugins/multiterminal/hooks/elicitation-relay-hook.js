#!/usr/bin/env node
/**
 * Elicitation Relay Hook — forwards MCP elicitation form requests to ClaudeRemote.
 *
 * When an MCP server requests structured user input, this hook:
 *   1. Posts the form schema to MultiTerminal REST API
 *   2. Sends the form to ClaudeRemote via messaging
 *   3. Polls for the user's response
 *   4. Returns hookSpecificOutput to Claude Code
 *
 * Falls through to the default terminal dialog on timeout (120s).
 */

const MT_API = process.env.MT_API_URL || 'http://localhost:5050';
const AGENT_NAME = process.env.MULTITERMINAL_NAME || 'unknown';
const POLL_INTERVAL = 2000; // 2 seconds
const TIMEOUT = 120000; // 2 minutes

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Core (dispatcher-callable) ───────────────────────────────────────
// Parsed hookData in, injectable deps (fetch / sleep / env / now / apiBase /
// pollInterval / timeout) so the store → send → poll → hookSpecificOutput path
// is unit-testable with a stubbed fetch + instant sleep (ticket 42c91001).
// Self-gates on mode!=='form' BEFORE any fetch → matcher-blind-dispatch safe.
// SYNC/decision class (Elicitation): emits hookSpecificOutput Claude waits on.
// Returns {exitCode, stdout?, stderr?}; stdout has NO trailing newline.
async function run(hookData, deps = {}) {
  const _fetch = deps.fetch || fetch;
  const _sleep = deps.sleep || sleep;
  const env = deps.env || process.env;
  const nowFn = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const apiBase = deps.apiBase || MT_API;
  const agentName = deps.agentName || env.MULTITERMINAL_NAME || 'unknown';
  const pollInterval = deps.pollInterval != null ? deps.pollInterval : POLL_INTERVAL;
  const timeout = deps.timeout != null ? deps.timeout : TIMEOUT;

  try {
    const event = hookData || {};

    // Only handle form-mode elicitations (self-gate before any I/O)
    if (event.mode !== 'form' || !event.requested_schema) {
      return { exitCode: 0 }; // Fall through to default dialog
    }

    // Check remote mode — if off, fall through to terminal dialog
    try {
      const modeRes = await _fetch(`${apiBase}/api/remote-mode`);
      if (modeRes.ok) {
        const modeData = await modeRes.json();
        if (!modeData.remote_mode) {
          return { exitCode: 0 };
        }
      }
    } catch {
      return { exitCode: 0 };
    }

    const elicitationId = event.elicitation_id || `elicit_${nowFn()}`;
    const serverName = event.mcp_server_name || 'unknown';
    const message = event.message || 'Please provide input';
    const schemaJson = JSON.stringify(event.requested_schema);

    // 1. Store the elicitation in MultiTerminal
    const storeRes = await _fetch(`${apiBase}/api/elicitations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        elicitationId,
        agentName,
        mcpServerName: serverName,
        message,
        schemaJson
      })
    });
    if (!storeRes.ok) {
      return { exitCode: 0, stderr: `[elicitation-relay] Failed to store elicitation: ${storeRes.status}\n` };
    }

    // 2. Send form to ClaudeRemote via messaging
    const formMessage = `[ELICITATION_REQUEST:${elicitationId}:${serverName}]\n${message}\n[SCHEMA]\n${schemaJson}`;
    await _fetch(`${apiBase}/api/messaging/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fromTerminalId: agentName,
        to: 'ClaudeRemote',
        message: formMessage,
        priority: 'high'
      })
    });

    // 3. Poll for response
    let elapsed = 0;
    while (elapsed < timeout) {
      await _sleep(pollInterval);
      elapsed += pollInterval;

      try {
        const res = await _fetch(`${apiBase}/api/elicitations/${elicitationId}/response`);
        if (res.ok) {
          const data = await res.json();
          if (data.answered) {
            // Parse content from JSON string
            let content = {};
            try {
              content = JSON.parse(data.contentJson || '{}');
            } catch { content = {}; }

            // Output hookSpecificOutput for Claude Code
            const output = {
              hookSpecificOutput: {
                hookEventName: 'Elicitation',
                action: data.action,
                content
              }
            };
            return { exitCode: 0, stdout: JSON.stringify(output) };
          }
        }
      } catch {
        // Polling error — continue
      }
    }

    // Timeout — fall through to default terminal dialog
    return { exitCode: 0 };
  } catch (err) {
    // Parse error or unexpected failure — fall through
    return { exitCode: 0, stderr: `[elicitation-relay] Error: ${err.message}\n` };
  }
}

module.exports = { run };

// ── CLI shim (standalone invocation — preserves exact prior behavior) ─
if (require.main === module) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', async () => {
    let hookData;
    try { hookData = JSON.parse(input); } catch (err) {
      // Original parsed inside the try and fell through with a generic error.
      process.stderr.write(`[elicitation-relay] Error: ${err.message}\n`);
      process.exit(0);
      return;
    }
    let out = { exitCode: 0 };
    try { out = await run(hookData, {}); } catch (err) {
      out = { exitCode: 0, stderr: `[elicitation-relay] Error: ${err.message}\n` };
    }
    if (out && out.stdout) process.stdout.write(out.stdout);
    if (out && out.stderr) process.stderr.write(out.stderr);
    process.exit((out && out.exitCode) || 0);
  });
}

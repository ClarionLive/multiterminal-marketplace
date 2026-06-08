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

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', async () => {
  try {
    const event = JSON.parse(input);

    // Only handle form-mode elicitations
    if (event.mode !== 'form' || !event.requested_schema) {
      process.exit(0); // Fall through to default dialog
    }

    // Check remote mode — if off, fall through to terminal dialog
    try {
      const modeRes = await fetch(`${MT_API}/api/remote-mode`);
      if (modeRes.ok) {
        const modeData = await modeRes.json();
        if (!modeData.remote_mode) {
          process.exit(0);
        }
      }
    } catch {
      process.exit(0);
    }

    const elicitationId = event.elicitation_id || `elicit_${Date.now()}`;
    const serverName = event.mcp_server_name || 'unknown';
    const message = event.message || 'Please provide input';
    const schemaJson = JSON.stringify(event.requested_schema);

    // 1. Store the elicitation in MultiTerminal
    const storeRes = await fetch(`${MT_API}/api/elicitations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        elicitationId,
        agentName: AGENT_NAME,
        mcpServerName: serverName,
        message,
        schemaJson
      })
    });
    if (!storeRes.ok) {
      process.stderr.write(`[elicitation-relay] Failed to store elicitation: ${storeRes.status}\n`);
      process.exit(0); // Fall through to default terminal dialog
    }

    // 2. Send form to ClaudeRemote via messaging
    const formMessage = `[ELICITATION_REQUEST:${elicitationId}:${serverName}]\n${message}\n[SCHEMA]\n${schemaJson}`;
    await fetch(`${MT_API}/api/messaging/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fromTerminalId: AGENT_NAME,
        to: 'ClaudeRemote',
        message: formMessage,
        priority: 'high'
      })
    });

    // 3. Poll for response
    let elapsed = 0;
    while (elapsed < TIMEOUT) {
      await sleep(POLL_INTERVAL);
      elapsed += POLL_INTERVAL;

      try {
        const res = await fetch(`${MT_API}/api/elicitations/${elicitationId}/response`);
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
            process.stdout.write(JSON.stringify(output));
            process.exit(0);
          }
        }
      } catch {
        // Polling error — continue
      }
    }

    // Timeout — fall through to default terminal dialog
    process.exit(0);
  } catch (err) {
    // Parse error or unexpected failure — fall through
    process.stderr.write(`[elicitation-relay] Error: ${err.message}\n`);
    process.exit(0);
  }
});

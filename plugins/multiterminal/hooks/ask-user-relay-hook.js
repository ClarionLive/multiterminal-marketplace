#!/usr/bin/env node
/**
 * AskUserQuestion Relay Hook — forwards agent questions to ClaudeRemote.
 *
 * PreToolUse hook for AskUserQuestion. When an agent asks the user a question:
 *   1. Checks if remote mode is enabled (GET /api/remote-mode)
 *   2. Converts the question + options to an elicitation-like form
 *   3. Sends to ClaudeRemote via messaging
 *   4. Polls for the user's response
 *   5. Blocks the tool call with the answer in the reason (Claude reads it as the response)
 *
 * Falls through to normal terminal prompt when remote mode is off or on timeout (120s).
 */

const MT_API = process.env.MT_API_URL || 'http://localhost:5050';
const AGENT_NAME = process.env.MULTITERMINAL_NAME || 'unknown';
const POLL_INTERVAL = 2000;
const TIMEOUT = 120000;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Core (dispatcher-callable) ───────────────────────────────────────
// Takes the parsed hookData (the CLI shim reads stdin) + injectable deps
// (fetch / sleep / env / now / apiBase / pollInterval / timeout) so the
// remote-mode → store → send → poll → decision path is unit-testable with a
// stubbed fetch + instant sleep + fixed clock — no live REST calls (ticket
// 42c91001). Self-gates on tool_name!=='AskUserQuestion' BEFORE any fetch, so a
// matcher-blind dispatch is safe. SYNC/decision class: on a remote answer it
// returns a {decision:'block'} that Claude waits on. Returns {exitCode, stdout?,
// stderr?}; stdout has NO trailing newline (byte-identical to process.stdout.write).
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

    // Only handle AskUserQuestion (self-gate before any I/O)
    if (event.tool_name !== 'AskUserQuestion') {
      return { exitCode: 0 };
    }

    // Check remote mode — if explicitly off, fall through to terminal prompt.
    // (Non-200 / unreachable behavior preserved verbatim: unreachable → return;
    // reachable-but-not-ok → proceed as before.)
    try {
      const modeRes = await _fetch(`${apiBase}/api/remote-mode`);
      if (modeRes.ok) {
        const modeData = await modeRes.json();
        if (!modeData.remote_mode) {
          return { exitCode: 0 };
        }
      }
    } catch {
      // API not reachable — fall through to terminal
      return { exitCode: 0 };
    }

    const toolInput = event.tool_input || {};

    // AskUserQuestion has a nested questions[] array with objects containing
    // { question, header, options: [{label, description}], multiSelect }
    const questions = toolInput.questions || [];
    if (questions.length === 0) {
      return { exitCode: 0 };
    }

    // For now, handle the first question (most common case)
    const q = questions[0];
    const question = q.question || 'Please provide input';
    const header = q.header || '';
    const options = (q.options || []).map(o => typeof o === 'string' ? o : o.label);
    const descriptions = (q.options || []).map(o => typeof o === 'string' ? '' : (o.description || ''));

    const elicitationId = `ask_${nowFn()}`;

    // Build schema from question + options
    let schema;
    if (options.length > 0) {
      const answerProp = {
        type: 'string',
        enum: options,
        title: header || 'Your answer',
        description: question
      };
      // Add enumDescriptions if we have them (helps ClaudeRemote render better labels)
      if (descriptions.some(d => d)) {
        answerProp.enumDescriptions = descriptions;
      }
      schema = {
        type: 'object',
        properties: { answer: answerProp },
        required: ['answer']
      };
    } else {
      schema = {
        type: 'object',
        properties: {
          answer: {
            type: 'string',
            title: header || 'Your answer',
            description: question
          }
        },
        required: ['answer']
      };
    }

    // Store as elicitation via REST API
    const storeRes = await _fetch(`${apiBase}/api/elicitations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        elicitationId,
        agentName,
        mcpServerName: 'claude-code',
        message: question,
        schemaJson: JSON.stringify(schema)
      })
    });

    if (!storeRes.ok) {
      return { exitCode: 0, stderr: `[ask-user-relay] Failed to store: ${storeRes.status}\n` };
    }

    // Send to ClaudeRemote with elicitation format
    const displayMsg = header ? `**${header}:** ${question}` : question;
    const formMessage = `[ELICITATION_REQUEST:${elicitationId}:claude-code]\n${displayMsg}\n[SCHEMA]\n${JSON.stringify(schema)}`;
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

    // Poll for response
    let elapsed = 0;
    while (elapsed < timeout) {
      await _sleep(pollInterval);
      elapsed += pollInterval;

      try {
        const res = await _fetch(`${apiBase}/api/elicitations/${elicitationId}/response`);
        if (res.ok) {
          const data = await res.json();
          if (data.answered) {
            let content = {};
            try { content = JSON.parse(data.contentJson || '{}'); } catch {}

            const answer = content.answer || '';

            if (data.action === 'decline' || data.action === 'cancel') {
              // User declined — fall through to terminal prompt (exit 0, no stdout = allow)
              return { exitCode: 0 };
            }
            // Block tool and provide the answer in the reason.
            // Claude reads the block reason and uses it as the user's response.
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                decision: 'block',
                reason: `The user answered this question remotely via their phone. Their answer is: "${answer}". Use this as the user's response and continue your work.`
              })
            };
          }
        }
      } catch {
        // Polling error — continue
      }
    }

    // Timeout — fall through to terminal prompt
    return { exitCode: 0 };
  } catch (err) {
    return { exitCode: 0, stderr: `[ask-user-relay] Error: ${err.message}\n` };
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
      // Original parsed inside the try and reported a generic error on failure.
      process.stderr.write(`[ask-user-relay] Error: ${err.message}\n`);
      process.exit(0);
      return;
    }
    let out = { exitCode: 0 };
    try { out = await run(hookData, {}); } catch (err) {
      out = { exitCode: 0, stderr: `[ask-user-relay] Error: ${err.message}\n` };
    }
    if (out && out.stdout) process.stdout.write(out.stdout);
    if (out && out.stderr) process.stderr.write(out.stderr);
    process.exit((out && out.exitCode) || 0);
  });
}

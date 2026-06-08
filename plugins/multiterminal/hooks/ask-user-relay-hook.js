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

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', async () => {
  try {
    const event = JSON.parse(input);

    // Only handle AskUserQuestion
    if (event.tool_name !== 'AskUserQuestion') {
      process.exit(0);
    }

    // Check remote mode — if off, fall through to terminal prompt
    try {
      const modeRes = await fetch(`${MT_API}/api/remote-mode`);
      if (modeRes.ok) {
        const modeData = await modeRes.json();
        if (!modeData.remote_mode) {
          process.exit(0);
        }
      }
    } catch {
      // API not reachable — fall through to terminal
      process.exit(0);
    }

    const toolInput = event.tool_input || {};

    // AskUserQuestion has a nested questions[] array with objects containing
    // { question, header, options: [{label, description}], multiSelect }
    const questions = toolInput.questions || [];
    if (questions.length === 0) {
      process.exit(0);
    }

    // For now, handle the first question (most common case)
    const q = questions[0];
    const question = q.question || 'Please provide input';
    const header = q.header || '';
    const options = (q.options || []).map(o => typeof o === 'string' ? o : o.label);
    const descriptions = (q.options || []).map(o => typeof o === 'string' ? '' : (o.description || ''));

    const elicitationId = `ask_${Date.now()}`;

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
    const storeRes = await fetch(`${MT_API}/api/elicitations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        elicitationId,
        agentName: AGENT_NAME,
        mcpServerName: 'claude-code',
        message: question,
        schemaJson: JSON.stringify(schema)
      })
    });

    if (!storeRes.ok) {
      process.stderr.write(`[ask-user-relay] Failed to store: ${storeRes.status}\n`);
      process.exit(0);
    }

    // Send to ClaudeRemote with elicitation format
    const displayMsg = header ? `**${header}:** ${question}` : question;
    const formMessage = `[ELICITATION_REQUEST:${elicitationId}:claude-code]\n${displayMsg}\n[SCHEMA]\n${JSON.stringify(schema)}`;
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

    // Poll for response
    let elapsed = 0;
    while (elapsed < TIMEOUT) {
      await sleep(POLL_INTERVAL);
      elapsed += POLL_INTERVAL;

      try {
        const res = await fetch(`${MT_API}/api/elicitations/${elicitationId}/response`);
        if (res.ok) {
          const data = await res.json();
          if (data.answered) {
            let content = {};
            try { content = JSON.parse(data.contentJson || '{}'); } catch {}

            const answer = content.answer || '';

            if (data.action === 'decline' || data.action === 'cancel') {
              // User declined — fall through to terminal prompt (exit 0, no stdout = allow)
            } else {
              // Block tool and provide the answer in the reason.
              // Claude reads the block reason and uses it as the user's response.
              process.stdout.write(JSON.stringify({
                decision: 'block',
                reason: `The user answered this question remotely via their phone. Their answer is: "${answer}". Use this as the user's response and continue your work.`
              }));
            }
            process.exit(0);
          }
        }
      } catch {
        // Polling error — continue
      }
    }

    // Timeout — fall through to terminal prompt
    process.exit(0);
  } catch (err) {
    process.stderr.write(`[ask-user-relay] Error: ${err.message}\n`);
    process.exit(0);
  }
});

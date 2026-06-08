#!/usr/bin/env node
/**
 * pipeline-trigger-hook.js — PostToolUse hook for update_task_checklist
 *
 * After any checklist update, checks if ALL items are now in "testing" or "done".
 * If so:
 *   1. Outputs a console message (system reminder) telling the agent to auto-run the pipeline
 *   2. Sends a channel message to the agent via the broker — channel messages are
 *      harder to ignore since they arrive as <channel> tags in the conversation
 *
 * Hook type: PostToolUse
 * Matcher: mcp__multiterminal__update_task_checklist
 */

const http = require('http');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', async () => {
  try {
    const hookData = JSON.parse(input);
    const toolInput = hookData.tool_input || {};
    const taskId = toolInput.taskId;

    if (!taskId) {
      process.exit(0);
    }

    // Query the REST API for full task detail
    const taskData = await getTaskDetail(taskId);
    if (!taskData) {
      process.exit(0);
    }

    // Parse checklist
    const checklist = parseChecklist(taskData);
    if (!checklist || checklist.length === 0) {
      process.exit(0);
    }

    // Check if ALL items are in "testing" or "done"
    const allTestingOrDone = checklist.every(item =>
      item.status === 'testing' || item.status === 'done'
    );

    // Check there's at least one "testing" item (not all done already)
    const hasTestingItems = checklist.some(item => item.status === 'testing');

    if (allTestingOrDone && hasTestingItems) {
      const testingCount = checklist.filter(i => i.status === 'testing').length;
      const doneCount = checklist.filter(i => i.status === 'done').length;

      // 1. Console output — system reminder to the agent
      console.log(`AUTO-PIPELINE TRIGGER: All ${checklist.length} checklist items are in testing (${testingCount}) or done (${doneCount}). ` +
        `No pending or coding items remain. ` +
        `You MUST run the pipeline now — invoke Skill(skill="multiterminal:pipeline") immediately. ` +
        `Do NOT ask the user for permission. The pipeline must pass before presenting items for manual testing.`);

      // 2. Send channel message to the agent — arrives as a <channel> tag
      const agentName = process.env.MULTITERMINAL_NAME;
      if (agentName) {
        const taskTitle = taskData.title || taskId;
        await sendChannelMessage(agentName, taskId, taskTitle, testingCount, doneCount, checklist.length);
      }
    }

    process.exit(0);
  } catch (err) {
    // Hook errors should not block the agent — fail silently
    process.exit(0);
  }
});

/**
 * Send a channel message to the agent via the broker's messaging endpoint.
 * This arrives as a <channel> tag which agents treat as external communication.
 */
function sendChannelMessage(agentName, taskId, taskTitle, testingCount, doneCount, totalCount) {
  return new Promise((resolve) => {
    const message = `🚨 PIPELINE REQUIRED — All ${totalCount} checklist items on "${taskTitle}" [${taskId}] are in testing (${testingCount}) or done (${doneCount}). ` +
      `Run the pipeline NOW: invoke Skill(skill="multiterminal:pipeline"). Do NOT ask the user — just run it.`;

    const body = JSON.stringify({
      from: 'System',
      to: agentName,
      message: message,
      priority: 'high'
    });

    const options = {
      hostname: 'localhost',
      port: 5050,
      path: '/api/messaging/send',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 3000
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });

    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

/**
 * Fetch task detail from MultiTerminal REST API
 */
function getTaskDetail(taskId) {
  return new Promise((resolve) => {
    const options = {
      hostname: 'localhost',
      port: 5050,
      path: `/api/tasks/${taskId}`,
      method: 'GET',
      timeout: 3000
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(null);
        }
      });
    });

    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

/**
 * Parse checklist from task data (handles both JSON string and array)
 */
function parseChecklist(taskData) {
  try {
    let checklist = taskData.checklist || taskData.checklist_json;
    if (typeof checklist === 'string') {
      checklist = JSON.parse(checklist);
    }
    if (Array.isArray(checklist)) {
      return checklist;
    }
    return null;
  } catch {
    return null;
  }
}

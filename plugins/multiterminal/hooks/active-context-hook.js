#!/usr/bin/env node
/**
 * active-context-hook.js — PostToolUse hook that auto-writes ACTIVE-CONTEXT.md
 *
 * Triggered after: build_project, update_task_checklist, update_task_status, update_task_continuation
 * Queries the MultiTerminal REST API for current task state and writes a structured
 * ACTIVE-CONTEXT.md file — no agent cooperation needed.
 *
 * The file is written to the project memory directory so session-start can read it.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Claude stores per-project memory under ~/.claude/projects/<encoded>/memory, where the
// folder name is the project path with each ':' '\' '/' replaced by '-'. Derive it from the
// current project (CLAUDE_PROJECT_DIR, else cwd) so this hook works for ANY project that uses
// MultiTerminal — not just the dev box that authored it. (issue #5 follow-up)
function claudeProjectFolderName(dir) {
  return String(dir || '').replace(/[\\/]+$/, '').replace(/[:\\/]/g, '-');
}
const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const MEMORY_DIR = path.join(
  process.env.USERPROFILE || os.homedir(),
  '.claude', 'projects',
  claudeProjectFolderName(PROJECT_DIR),
  'memory'
);
const CONTEXT_FILE = path.join(MEMORY_DIR, 'ACTIVE-CONTEXT.md');

// ── Core (dispatcher-callable) ───────────────────────────────────────
// Parsed hookData in (CLI shim reads stdin). Injectable fetchJson/fs/env/nowIso +
// memoryDir/contextFile so the fetch→build→write ACTIVE-CONTEXT.md path is
// unit-testable without a live REST call or real file write (ticket 42c91001).
// Side-effect-only (no stdout). NOTE: this hook does NOT self-gate on tool_name —
// it relies on its hooks.json matcher (4 task tools + build). Under the dispatcher
// it carries that matcher in the TABLE (B′), so it only runs on its tools, never
// blanket PostToolUse. Returns {exitCode:0}.
async function run(hookData, deps = {}) {
  const _fs = deps.fs || fs;
  const env = deps.env || process.env;
  const _fetchJson = deps.fetchJson || fetchJson;
  const nowIso = typeof deps.nowIso === 'function' ? deps.nowIso : () => new Date().toISOString();
  const memoryDir = deps.memoryDir || MEMORY_DIR;
  const contextFile = deps.contextFile || CONTEXT_FILE;

  try {
    const toolName = hookData.tool_name || '';
    const toolInput = hookData.tool_input || {};
    const toolOutput = hookData.tool_output || '';

    // Extract build result if this was a build trigger
    let buildStatus = null;
    if (toolName.includes('build_project')) {
      try {
        // tool_output might be JSON string or object
        const buildResult = typeof toolOutput === 'string' ? JSON.parse(toolOutput) : toolOutput;
        buildStatus = buildResult.success ? 'PASS (0 errors, 0 warnings)' : 'FAIL';
      } catch {
        buildStatus = toolOutput.includes('"success":true') || toolOutput.includes('Build succeeded') ? 'PASS' : 'FAIL';
      }
    }

    // Fetch active tasks from REST API
    const tasks = await _fetchJson('/api/tasks?status=in_progress');
    if (!tasks || (!tasks.tasks && !Array.isArray(tasks))) {
      // No tasks or API unavailable — write minimal context
      if (buildStatus) {
        await writeMinimalContext(buildStatus, _fs, memoryDir, contextFile, nowIso);
      }
      return { exitCode: 0 };
    }

    const taskList = tasks.tasks || tasks;
    if (!Array.isArray(taskList) || taskList.length === 0) {
      if (buildStatus) {
        await writeMinimalContext(buildStatus, _fs, memoryDir, contextFile, nowIso);
      }
      return { exitCode: 0 };
    }

    // Find the active task for THIS agent (filter by MULTITERMINAL_NAME first)
    const myName = env.MULTITERMINAL_NAME || '';
    const activeTask = taskList.find(t => t.subStatus === 'active' && t.assignee === myName)
      || taskList.find(t => t.assignee === myName)
      || taskList.find(t => t.subStatus === 'active')
      || taskList[0];

    // Fetch full task detail
    const detail = await _fetchJson(`/api/tasks/${activeTask.id}`);

    // Fetch reports for this task
    const reportsData = await _fetchJson(`/api/tasks/${activeTask.id}/reports`);
    const reports = reportsData ? (reportsData.reports || []) : [];

    // Build the context file
    const content = buildContextContent(detail || activeTask, reports, buildStatus, taskList, nowIso);

    // Ensure directory exists and write
    if (!_fs.existsSync(memoryDir)) {
      _fs.mkdirSync(memoryDir, { recursive: true });
    }
    _fs.writeFileSync(contextFile, content, 'utf8');

    return { exitCode: 0 };
  } catch (err) {
    // Never block the agent — fail silently
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
    let hookData;
    try { hookData = JSON.parse(input); } catch { process.exit(0); return; }
    try { await run(hookData, {}); } catch { /* never block */ }
    process.exit(0);
  });
}

function buildContextContent(task, reports, buildStatus, allTasks, nowIsoFn = () => new Date().toISOString()) {
  const now = nowIsoFn().split('T')[0];
  const lines = [];

  lines.push('# Active Context');
  lines.push('');
  lines.push(`## Current Work (${now})`);
  lines.push('');

  // Active task section
  const title = task.title || 'Unknown Task';
  const taskId = task.id || '?';
  const assignee = task.assignee || 'unassigned';

  // Parse checklist
  let checklist = [];
  try {
    const raw = task.checklist_json || task.ChecklistJson || task.checklistJson;
    if (raw) checklist = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {}

  const done = checklist.filter(i => i.status === 'done').length;
  const testing = checklist.filter(i => i.status === 'testing').length;
  const coding = checklist.filter(i => i.status === 'coding').length;
  const pending = checklist.filter(i => i.status === 'pending').length;
  const total = checklist.length;

  // Determine task phase
  let phase = 'IN PROGRESS';
  if (total > 0 && done === total) phase = 'COMPLETE';
  else if (testing > 0 && coding === 0 && pending === 0) phase = 'PIPELINE / TESTING';
  else if (coding > 0) phase = 'CODING';
  else if (pending === total) phase = 'PLANNING';

  lines.push(`### ${title} (Ticket ${taskId}) — ${phase}`);
  lines.push('');

  // Build status
  if (buildStatus) {
    lines.push(`**Last Build:** ${buildStatus}`);
    lines.push('');
  }

  // Checklist progress
  if (total > 0) {
    lines.push(`**Checklist:** ${done}/${total} done, ${testing} testing, ${coding} coding, ${pending} pending`);
    lines.push('');

    // List checklist items with status
    checklist.forEach((item, i) => {
      const icon = item.status === 'done' ? 'done' :
                   item.status === 'testing' ? 'testing' :
                   item.status === 'coding' ? 'CODING' :
                   'pending';
      lines.push(`- [${icon}] ${item.item || item.description || 'Item ' + i}`);
    });
    lines.push('');
  }

  // Pipeline / review status
  if (reports.length > 0) {
    lines.push('**Agent Reviews:**');
    const agentOrder = ['verifier', 'code-reviewer', 'security-auditor', 'debugger'];
    const seen = new Set();
    for (const name of agentOrder) {
      const report = reports.find(r => (r.agent_name || r.agentName || '').includes(name));
      if (report) {
        const verdict = report.verdict || 'unknown';
        const score = report.score != null ? ` (${report.score}/100)` : '';
        lines.push(`- ${name}: ${verdict}${score}`);
        seen.add(name);
      }
    }
    // Any other agents
    for (const r of reports) {
      const name = r.agent_name || r.agentName || '';
      if (!agentOrder.some(a => name.includes(a)) && !seen.has(name)) {
        lines.push(`- ${name}: ${r.verdict || 'unknown'}`);
      }
    }
    lines.push('');
  }

  // Continuation notes
  const contNotes = task.continuation_notes || task.continuationNotes || task.ContinuationNotes;
  if (contNotes) {
    lines.push('**Continuation Notes:**');
    lines.push(contNotes);
    lines.push('');
  }

  // Other in-progress tasks (paused)
  const otherTasks = allTasks.filter(t => t.id !== taskId);
  if (otherTasks.length > 0) {
    lines.push('## Other In-Progress Tasks (Paused)');
    for (const t of otherTasks) {
      lines.push(`- ${t.title || t.id} (${t.assignee || 'unassigned'})`);
    }
    lines.push('');
  }

  // Footer
  lines.push(`_Auto-generated by active-context-hook.js at ${nowIsoFn()}_`);

  return lines.join('\n');
}

async function writeMinimalContext(buildStatus, _fs = fs, memoryDir = MEMORY_DIR, contextFile = CONTEXT_FILE, nowIsoFn = () => new Date().toISOString()) {
  const now = nowIsoFn().split('T')[0];
  const content = `# Active Context\n\n## Current Work (${now})\n\n**Last Build:** ${buildStatus}\n\n_Auto-generated by active-context-hook.js at ${nowIsoFn()}_\n`;
  if (!_fs.existsSync(memoryDir)) {
    _fs.mkdirSync(memoryDir, { recursive: true });
  }
  _fs.writeFileSync(contextFile, content, 'utf8');
}

function fetchJson(urlPath) {
  return new Promise(resolve => {
    const options = {
      hostname: 'localhost',
      port: 5050,
      path: urlPath,
      method: 'GET',
      timeout: 3000
    };

    const req = http.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(null); }
      });
    });

    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

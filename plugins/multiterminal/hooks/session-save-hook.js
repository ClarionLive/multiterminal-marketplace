#!/usr/bin/env node
/**
 * session-save-hook.js — PreCompact + Stop hook for session continuity.
 *
 * Ensures ACTIVE-CONTEXT.md is fresh before context is lost.
 * Fires on:
 *   - PreCompact: before context compression (auto or manual)
 *   - Stop: when agent finishes responding (lightweight checkpoint)
 *
 * Queries MultiTerminal REST API for active task state and writes
 * ACTIVE-CONTEXT.md to the project memory directory.
 *
 * Designed to complement active-context-hook.js (PostToolUse) by catching
 * cases where context is lost without a tool call (compaction, session end).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const API_PORT = 5050;
const API_TIMEOUT = 4000;

// Derive the per-project memory dir name from the current project (CLAUDE_PROJECT_DIR, else
// cwd) rather than hardcoding it: the folder name is the project path with each ':' '\' '/'
// replaced by '-'. Lets this shipped hook serve ANY project, not just the dev box. (issue #5 follow-up)
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

// Throttle: don't write more than once per 30 seconds (Stop fires frequently)
const THROTTLE_FILE = path.join(os.tmpdir(), 'mt-session-save-last.txt');
const THROTTLE_MS = 30000;

function shouldThrottle(_fs = fs, throttleFile = THROTTLE_FILE, nowMs = Date.now()) {
  try {
    if (_fs.existsSync(throttleFile)) {
      const lastWrite = parseInt(_fs.readFileSync(throttleFile, 'utf8'), 10);
      if (nowMs - lastWrite < THROTTLE_MS) return true;
    }
  } catch {}
  return false;
}

function markWritten(_fs = fs, throttleFile = THROTTLE_FILE, nowMs = Date.now()) {
  try { _fs.writeFileSync(throttleFile, String(nowMs), 'utf8'); } catch {}
}

// ── Main ─────────────────────────────────────────────────────────────

// ── Core (dispatcher-callable) ───────────────────────────────────────
// Parsed hookData in (CLI shim reads stdin). Injectable deps (fetchJson / fs /
// env / now / nowIso / memoryDir / contextFile / throttleFile / log) so the
// fetch → buildContext → write-ACTIVE-CONTEXT path is unit-testable with stubs —
// no live REST call and no real file write (ticket 42c91001). Self-gates on the
// event (Stop throttled; PreCompact always writes). Side-effect-only (no stdout).
// Returns {exitCode:0}. The debug trace goes through `log` (diagnostic only).
async function run(hookData, deps = {}) {
  const _fs = deps.fs || fs;
  const env = deps.env || process.env;
  const _fetchJson = deps.fetchJson || fetchJson;
  const nowIsoFn = typeof deps.nowIso === 'function' ? deps.nowIso : () => new Date().toISOString();
  const nowMsFn = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const memoryDir = deps.memoryDir || MEMORY_DIR;
  const contextFile = deps.contextFile || CONTEXT_FILE;
  const throttleFile = deps.throttleFile || THROTTLE_FILE;
  const logLine = deps.log || (() => {});

  const eventName = hookData.hook_event_name || '';
  logLine(`Event: ${eventName}`);

  // For Stop events, throttle to avoid excessive writes.
  // PreCompact always writes (it's infrequent and critical).
  if (eventName === 'Stop' && shouldThrottle(_fs, throttleFile, nowMsFn())) {
    logLine('Throttled — skipping');
    return { exitCode: 0 };
  }

  try {
    // Fetch active tasks from REST API
    const agentName = env.MULTITERMINAL_NAME || '';
    logLine(`Agent: ${agentName}`);
    let tasks = await _fetchJson('/api/tasks?status=in_progress');
    if (!tasks) {
      logLine('API returned null — no tasks');
      return { exitCode: 0 };
    }

    const taskList = tasks.tasks || tasks;
    if (!Array.isArray(taskList) || taskList.length === 0) {
      return { exitCode: 0 };
    }

    // Find the active task for this agent (KanbanTask uses subStatus === "active")
    const activeTask = taskList.find(t =>
      t.subStatus === 'active' &&
      (t.assignee || '').toLowerCase() === agentName.toLowerCase()
    ) || taskList.find(t => (t.assignee || '').toLowerCase() === agentName.toLowerCase())
      || taskList.find(t => t.subStatus === 'active')
      || taskList[0];

    // Fetch full task detail
    const detail = await _fetchJson(`/api/tasks/${activeTask.id}`);
    if (!detail) {
      return { exitCode: 0 };
    }

    // Fetch reports
    const reportsData = await _fetchJson(`/api/tasks/${activeTask.id}/reports`);
    const reports = reportsData ? (reportsData.reports || []) : [];

    // Build and write context
    const content = buildContext(detail, reports, taskList, eventName, nowIsoFn());
    if (!_fs.existsSync(memoryDir)) {
      _fs.mkdirSync(memoryDir, { recursive: true });
    }
    _fs.writeFileSync(contextFile, content, 'utf8');
    logLine(`SUCCESS — wrote ${contextFile}`);
    markWritten(_fs, throttleFile, nowMsFn());
  } catch (err) {
    logLine(`ERROR: ${err.message}`);
    // Never interfere with agent flow
  }

  return { exitCode: 0 };
}

module.exports = { run };

// ── Context Builder ──────────────────────────────────────────────────

function buildContext(task, reports, allTasks, eventName, nowIso = new Date().toISOString()) {
  const now = nowIso;
  const date = now.split('T')[0];
  const lines = [];

  lines.push('# Active Context');
  lines.push(`## Current Work (${date})`);
  lines.push('');

  const title = task.title || 'Unknown Task';
  const taskId = task.id || '?';

  // Parse checklist
  let checklist = [];
  try {
    const raw = task.checklist_json || task.checklistJson || task.ChecklistJson;
    if (raw) checklist = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {}

  const done = checklist.filter(i => i.status === 'done').length;
  const testing = checklist.filter(i => i.status === 'testing').length;
  const coding = checklist.filter(i => i.status === 'coding').length;
  const pending = checklist.filter(i => i.status === 'pending').length;
  const total = checklist.length;

  let phase = 'IN PROGRESS';
  if (total > 0 && done === total) phase = 'COMPLETE';
  else if (testing > 0 && coding === 0 && pending === 0) phase = 'PIPELINE / TESTING';
  else if (coding > 0) phase = 'CODING';
  else if (pending === total && total > 0) phase = 'PLANNING';

  lines.push(`### ${title} (Ticket ${taskId}) — ${phase}`);
  lines.push('');

  if (total > 0) {
    lines.push(`**Checklist:** ${done}/${total} done, ${testing} testing, ${coding} coding, ${pending} pending`);
    lines.push('');
    checklist.forEach((item, i) => {
      const icon = item.status === 'done' ? 'done' :
                   item.status === 'testing' ? 'testing' :
                   item.status === 'coding' ? 'CODING' : 'pending';
      lines.push(`- [${icon}] ${item.item || item.description || 'Item ' + i}`);
    });
    lines.push('');
  }

  // Reports
  if (reports.length > 0) {
    lines.push('**Agent Reviews:**');
    for (const name of ['verifier', 'code-reviewer', 'security-auditor', 'debugger']) {
      const report = reports.find(r => (r.agent_name || r.agentName || '').includes(name));
      if (report) {
        const score = report.score != null ? ` (${report.score}/100)` : '';
        lines.push(`- ${name}: ${report.verdict || 'unknown'}${score}`);
      }
    }
    lines.push('');
  }

  // Continuation notes (full — don't truncate for session save)
  const contNotes = task.continuation_notes || task.continuationNotes;
  if (contNotes) {
    lines.push('**Continuation Notes:**');
    lines.push(contNotes);
    lines.push('');
  }

  // Plan (first 300 chars as reminder)
  const plan = task.plan;
  if (plan) {
    const planPreview = plan.length > 300 ? plan.substring(0, 300) + '...' : plan;
    lines.push('**Plan Preview:**');
    lines.push(planPreview);
    lines.push('');
  }

  // Other paused tasks
  const otherTasks = allTasks.filter(t => t.id !== taskId);
  if (otherTasks.length > 0) {
    lines.push('## Other In-Progress Tasks (Paused)');
    for (const t of otherTasks.slice(0, 10)) {
      lines.push(`- ${t.title || t.id} (${t.assignee || 'unassigned'})`);
    }
    if (otherTasks.length > 10) lines.push(`- ...and ${otherTasks.length - 10} more`);
    lines.push('');
  }

  const trigger = eventName === 'PreCompact' ? 'PreCompact (before context compression)' :
                  eventName === 'Stop' ? 'Stop (agent checkpoint)' : eventName;
  lines.push(`_Auto-generated by session-save-hook.js at ${now} — trigger: ${trigger}_`);

  return lines.join('\n');
}

// ── HTTP Helper ──────────────────────────────────────────────────────

function fetchJson(urlPath) {
  return new Promise(resolve => {
    const req = http.request({
      hostname: 'localhost',
      port: API_PORT,
      path: urlPath,
      method: 'GET',
      timeout: API_TIMEOUT
    }, res => {
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

// ── CLI shim (standalone invocation — preserves exact prior behavior) ─
if (require.main === module) {
  (async () => {
    // Debug log to verify hook is firing (diagnostic only)
    const debugLog = path.join(os.tmpdir(), 'mt-session-save-debug.log');
    const logLine = (msg) => { try { fs.appendFileSync(debugLog, `${new Date().toISOString()} ${msg}\n`); } catch {} };

    logLine('Hook invoked');

    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
    }

    let hookData;
    try {
      hookData = JSON.parse(input);
    } catch (e) {
      logLine(`JSON parse error: ${e.message}`);
      process.exit(0);
      return;
    }

    await run(hookData, { log: logLine });
    process.exit(0);
  })().catch(() => process.exit(0));
}

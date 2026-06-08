#!/usr/bin/env node
/**
 * Session Status Hook for Claude Code
 * Marks terminal profiles online/offline based on SessionStart/SessionEnd events
 */


const fs = require('fs');
const path = require('path');
const os = require('os');

const DB_PATH = path.join(process.env.APPDATA || '', 'multiterminal', 'multiterminal.db');

// better-sqlite3 resolution is centralized in _sqlite.js (issue #7) — no hardcoded paths.
const { requireBetterSqlite3, sqliteUnavailableMessage } = require('./_sqlite');

function updateProfileStatus(terminalName, isOnline) {
  try {
    const Database = requireBetterSqlite3();
    if (!Database) {
      console.error('better-sqlite3 not found');
      return false;
    }

    if (!fs.existsSync(DB_PATH)) {
      console.error(`Database not found: ${DB_PATH}`);
      return false;
    }

    const db = new Database(DB_PATH);
    const timestamp = new Date().toISOString();

    // Check if table exists
    const tableCheck = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type='table' AND name='team_member_profiles'
    `).get();

    if (!tableCheck) {
      console.error('team_member_profiles table not found');
      db.close();
      return false;
    }

    // Insert or update profile status (upsert)
    const upsertStmt = db.prepare(`
      INSERT INTO team_member_profiles (id, display_name, is_online, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        is_online = excluded.is_online,
        updated_at = excluded.updated_at
    `);

    const result = upsertStmt.run(
      terminalName,      // id
      terminalName,      // display_name
      isOnline ? 1 : 0,  // is_online
      timestamp,         // created_at
      timestamp          // updated_at
    );
    db.close();

    console.log(`Profile ${terminalName} ${result.changes > 0 ? (isOnline ? 'created/marked online' : 'marked offline') : 'unchanged'}`);
    return true;
  } catch (err) {
    console.error('Error updating profile status:', err.message);
    return false;
  }
}

function updateSessionAgentMap(sessionId, terminalName, isActive) {
  try {
    if (!sessionId || !terminalName) return false;

    const Database = requireBetterSqlite3();
    if (!Database) return false;
    if (!fs.existsSync(DB_PATH)) return false;

    const db = new Database(DB_PATH);
    const timestamp = new Date().toISOString();

    // Ensure table exists
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_agent_map (
        session_id TEXT PRIMARY KEY,
        agent_name TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        ended_at TEXT
      )
    `);

    if (isActive) {
      // Upsert: set active on session start
      db.prepare(`
        INSERT INTO session_agent_map (session_id, agent_name, is_active, started_at)
        VALUES (?, ?, 1, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          agent_name = excluded.agent_name,
          is_active = 1,
          started_at = excluded.started_at,
          ended_at = NULL
      `).run(sessionId, terminalName, timestamp);
    } else {
      // Mark inactive on session end
      db.prepare(`
        UPDATE session_agent_map SET is_active = 0, ended_at = ? WHERE session_id = ?
      `).run(timestamp, sessionId);
    }

    db.close();
    console.log(`Session ${sessionId} mapped to ${terminalName} (active: ${isActive})`);
    return true;
  } catch (err) {
    console.error('Error updating session agent map:', err.message);
    return false;
  }
}

function getKanbanContext(db, terminalName, projectId) {
  const tableCheck = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type='table' AND name='tasks'
  `).get();

  if (!tableCheck) return null;

  const lines = [];

  if (terminalName) {
    // Prefer tasks for current project, fall back to all
    const projectFilter = projectId ? ' AND project_id = ?' : '';
    const params = projectId ? [terminalName, projectId] : [terminalName];
    const myTasks = db.prepare(`
      SELECT id, title, description, status, created_by, assignee
      FROM tasks
      WHERE assignee = ? AND status IN ('in_progress', 'todo')${projectFilter}
      ORDER BY
        CASE status WHEN 'in_progress' THEN 0 WHEN 'todo' THEN 1 END,
        id
    `).all(...params);

    if (myTasks.length > 0) {
      lines.push(`## Your Kanban Tasks (${terminalName})`);
      for (const task of myTasks) {
        const statusIcon = task.status === 'in_progress' ? '🔨' : '📋';
        lines.push(`${statusIcon} [${task.id}] ${task.title} (${task.status})`);
        if (task.description) {
          const desc = task.description.split('\n')[0].substring(0, 80);
          lines.push(`   ${desc}${task.description.length > 80 ? '...' : ''}`);
        }
      }
      lines.push('');
      lines.push('Use list_tasks to see all board tasks, update_task_status when done.');
    }
  }

  if (lines.length === 0) {
    const projectFilterAvail = projectId ? ' AND project_id = ?' : '';
    const paramsAvail = projectId ? [projectId] : [];
    const availableTasks = db.prepare(`
      SELECT id, title, status, created_by
      FROM tasks
      WHERE (assignee IS NULL OR assignee = '') AND status IN ('todo', 'suggestion')${projectFilterAvail}
      ORDER BY
        CASE status WHEN 'todo' THEN 0 WHEN 'suggestion' THEN 1 END,
        id
      LIMIT 5
    `).all(...paramsAvail);

    if (availableTasks.length > 0) {
      lines.push('## Kanban Board - Available Tasks');
      for (const task of availableTasks) {
        const statusIcon = task.status === 'todo' ? '📋' : '💡';
        lines.push(`${statusIcon} [${task.id}] ${task.title} (${task.status})`);
      }
      lines.push('');
      lines.push('Use claim_task(task_id, your_name) to claim a task.');
    } else {
      lines.push('## Kanban Board');
      lines.push('No tasks available to claim. Use create_task to add work items.');
    }
  }

  return lines.length > 0 ? lines.join('\n') : null;
}

function getActiveTaskContext(db, terminalName, projectId) {
  if (!terminalName) return null;

  // Check if tasks table exists
  const tableCheck = db.prepare(`
    SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'
  `).get();
  if (!tableCheck) return null;

  // Find active task for this terminal, prefer current project
  const projectFilter = projectId ? ' AND project_id = ?' : '';
  const params = projectId ? [terminalName, projectId] : [terminalName];
  let activeTask = db.prepare(`
    SELECT id, title, description, status, sub_status, checklist_json, plan, continuation_notes
    FROM tasks
    WHERE assignee = ? AND status = 'in_progress'${projectFilter}
    ORDER BY CASE sub_status WHEN 'active' THEN 0 ELSE 1 END
    LIMIT 1
  `).get(...params);

  // Fall back to any project if no tasks in current project
  if (!activeTask && projectId) {
    activeTask = db.prepare(`
      SELECT id, title, description, status, sub_status, checklist_json, plan, continuation_notes
      FROM tasks
      WHERE assignee = ? AND status = 'in_progress'
      ORDER BY CASE sub_status WHEN 'active' THEN 0 ELSE 1 END
      LIMIT 1
    `).get(terminalName);
  }

  if (!activeTask) return null;

  const lines = [];
  lines.push(`## ACTIVE TASK: ${activeTask.title} [${activeTask.id}]`);

  // Checklist summary
  if (activeTask.checklist_json && activeTask.checklist_json !== '[]') {
    try {
      const items = JSON.parse(activeTask.checklist_json);
      const counts = { pending: 0, coding: 0, testing: 0, done: 0 };
      items.forEach(i => { counts[i.status || 'pending']++; });
      lines.push(`Checklist: ${counts.done} done, ${counts.testing} testing, ${counts.coding} coding, ${counts.pending} pending (${items.length} total)`);
    } catch (e) { /* ignore */ }
  }

  // Continuation notes (most important for session handoff)
  if (activeTask.continuation_notes) {
    lines.push('');
    lines.push('### Continuation Notes');
    lines.push(activeTask.continuation_notes);
  }

  // File links
  const fileLinksTable = db.prepare(`
    SELECT name FROM sqlite_master WHERE type='table' AND name='task_file_links'
  `).get();
  if (fileLinksTable) {
    const fileLinks = db.prepare(`
      SELECT file_path, description, line_start, line_end FROM task_file_links WHERE task_id = ? ORDER BY created_at
    `).all(activeTask.id);
    if (fileLinks.length > 0) {
      lines.push('');
      lines.push('### Linked Files');
      fileLinks.forEach(f => {
        let entry = `- ${f.file_path}`;
        if (f.line_start) entry += `:${f.line_start}${f.line_end ? `-${f.line_end}` : ''}`;
        if (f.description) entry += ` — ${f.description}`;
        lines.push(entry);
      });
    }
  }

  // Blocking relationships
  const relTable = db.prepare(`
    SELECT name FROM sqlite_master WHERE type='table' AND name='task_relationships'
  `).get();
  if (relTable) {
    const blockers = db.prepare(`
      SELECT r.target_task_id, t.title, t.status
      FROM task_relationships r
      LEFT JOIN tasks t ON t.id = r.target_task_id
      WHERE r.source_task_id = ? AND r.type = 'depends_on'
    `).all(activeTask.id);
    const unresolvedBlockers = blockers.filter(b => b.status !== 'done');
    if (unresolvedBlockers.length > 0) {
      lines.push('');
      lines.push('### BLOCKED BY (unresolved)');
      unresolvedBlockers.forEach(b => {
        lines.push(`- [${b.target_task_id}] ${b.title || '(unknown)'} (${b.status})`);
      });
    }

    const blocking = db.prepare(`
      SELECT r.target_task_id, t.title
      FROM task_relationships r
      LEFT JOIN tasks t ON t.id = r.target_task_id
      WHERE r.source_task_id = ? AND r.type = 'blocks'
    `).all(activeTask.id);
    if (blocking.length > 0) {
      lines.push('');
      lines.push('### Blocks (other tasks waiting on this)');
      blocking.forEach(b => {
        lines.push(`- [${b.target_task_id}] ${b.title || '(unknown)'}`);
      });
    }
  }

  return lines.join('\n');
}

function getPlanContext(db, terminalName) {
  const tableCheck = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type='table' AND name='plans'
  `).get();

  if (!tableCheck) return null;

  const plan = db.prepare(`
    SELECT id, title, description, current_phase, status, leader_id
    FROM plans
    WHERE status = 'active'
    LIMIT 1
  `).get();

  if (!plan) return null;

  const phases = db.prepare(`
    SELECT id, phase_name, phase_order, checklist_json, started_at, completed_at
    FROM plan_phases
    WHERE plan_id = ?
    ORDER BY phase_order
  `).all(plan.id);

  let assignment = null;
  if (terminalName) {
    assignment = db.prepare(`
      SELECT id, role, assigned_task_summary, status, blocked_by
      FROM plan_assignments
      WHERE plan_id = ? AND terminal_name = ?
    `).get(plan.id, terminalName);
  }

  const lines = [];
  const phaseIndex = phases.findIndex(p => p.phase_name === plan.current_phase);
  lines.push(`## Active Plan: ${plan.title}`);
  lines.push(`Phase: ${plan.current_phase} (${phaseIndex + 1}/${phases.length}) | Leader: ${plan.leader_id || 'Unassigned'}`);

  if (assignment) {
    lines.push(`Your Role: ${assignment.role}`);
    lines.push(`Your Task: ${assignment.assigned_task_summary || 'Not specified'}`);
    lines.push(`Status: ${assignment.status}`);
    if (assignment.blocked_by) {
      lines.push(`Blocked By: ${assignment.blocked_by}`);
    }
  }

  const currentPhase = phases.find(p => p.phase_name === plan.current_phase);
  if (currentPhase && currentPhase.checklist_json) {
    try {
      const checklist = JSON.parse(currentPhase.checklist_json);
      if (checklist.length > 0) {
        lines.push('');
        lines.push('Checklist:');
        for (const item of checklist) {
          const mark = item.Done ? 'x' : ' ';
          lines.push(`  [${mark}] ${item.Item}`);
        }
      }
    } catch (e) {
      // Ignore JSON parse errors
    }
  }

  return lines.join('\n');
}

// DEBUG: trace helper — appends to temp log file
const DEBUG_PATH = path.join(os.tmpdir(), 'mt-session-hook-debug.log');
function dtrace(msg) {
  try { fs.appendFileSync(DEBUG_PATH, `[${new Date().toISOString()}] ${msg}\n`); } catch (e) { /* ignore */ }
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  dtrace(`hook fired | input length=${input.length} | NAME=${process.env.MULTITERMINAL_NAME || 'unset'} | SPAWNER=${process.env.MULTITERMINAL_SPAWNER || 'unset'}`);
  dtrace(`INPUT: ${input.substring(0, 500)}`);
  dtrace('---');

  // Skip when running inside the Clarion IDE addin (skill/task tools not available)
  if (process.env.CLARION_ASSISTANT_EMBEDDED) return;

  if (!input.trim()) {
    console.error('No input received');
    return;
  }

  let hookData;
  try {
    hookData = JSON.parse(input);
  } catch (err) {
    console.error('Failed to parse JSON input:', err.message);
    return;
  }

  const terminalName = process.env.MULTITERMINAL_NAME;
  if (!terminalName) {
    console.error('MULTITERMINAL_NAME environment variable not set');
    return;
  }

  const spawnerName = process.env.MULTITERMINAL_SPAWNER;
  const isSpawnedAgent = !!spawnerName;

  // DEBUG: Log spawner status
  console.log(`[DEBUG] MULTITERMINAL_SPAWNER = '${spawnerName}' (isSpawnedAgent: ${isSpawnedAgent})`);

  const hookType = hookData.hook_event_name || hookData.hook_type || hookData.type;

  dtrace(`PARSED: hookType=${hookType} source=${hookData.source} spawner=${spawnerName} keys=${Object.keys(hookData).join(',')}`);

  switch (hookType) {
    case 'SessionStart': {
      dtrace(`STEP 1: Entered SessionStart branch for ${terminalName}`);

      // Mark profile online
      updateProfileStatus(terminalName, true);
      dtrace('STEP 2: updateProfileStatus done');

      // Map this session to the terminal agent name
      const sessionId = hookData.session_id;
      updateSessionAgentMap(sessionId, terminalName, true);
      dtrace('STEP 3: updateSessionAgentMap done');

      // Skip kanban/plan context for spawned agents (they have specific tasks from spawner)
      // But NOT on /clear — user explicitly wants a fresh start with session-start menu
      if (isSpawnedAgent && hookData.source !== 'clear') {
        console.log(`## Spawned Agent: ${terminalName}`);
        console.log(`Spawned by: ${spawnerName}`);
        console.log('Waiting for task assignment from spawner...');
        break;
      }

      // CRITICAL: emit the auto-run instruction FIRST so it survives the 2KB hook-output
      // preview truncation. Everything below (rules, active context, knowledge, kanban)
      // can easily push the total past 2KB — if this were at the end it would be lost.
      dtrace('STEP 4: About to emit AUTO-RUN SKILL to stdout');
      console.log('AUTO-RUN SKILL: You MUST run /multiterminal:session-start as your FIRST action before responding to the user. This is mandatory - use the Skill tool with skill="multiterminal:session-start" immediately.');
      dtrace('STEP 5: AUTO-RUN SKILL emitted to stdout');
      console.log('');

      // Surface identity (esp. CLAUDE_SESSION_ID) via additionalContext. Claude Code
      // does NOT export CLAUDE_SESSION_ID into the child shell, so the session-start
      // skill's `echo "$CLAUDE_SESSION_ID"` is always empty and register_session gets
      // skipped (tracking issue #1). The hook receives the live session id via stdin
      // (hookData.session_id) — emit it here, right after AUTO-RUN, so it lands inside
      // the first 2KB of hook output (survives the preview truncation) and the skill
      // can read it from this context instead of from the (empty) env var.
      console.log('## MultiTerminal Identity (authoritative — from SessionStart hook)');
      console.log(`MULTITERMINAL_NAME=${terminalName}`);
      console.log(`MULTITERMINAL_DOC_ID=${process.env.MULTITERMINAL_DOC_ID || ''}`);
      console.log(`CLAUDE_SESSION_ID=${sessionId || ''}`);
      console.log('');

      // Surface a missing native DB module to the user instead of silently no-op'ing
      // (issue #7) — otherwise profiles/lifecycle/activity quietly stop working.
      if (!requireBetterSqlite3()) {
        console.log(`⚠️ ${sqliteUnavailableMessage()}`);
        console.log('');
      }

      // Always output terminal identity so the agent knows who it is
      console.log(`## Terminal Identity: ${terminalName}`);
      console.log(`You are ${terminalName}. Always use "${terminalName}" as your name when registering, claiming tasks, or sending messages.`);
      console.log('');

      // Inject MultiTerminal behavioral rules (host-controlled, replaces MEMORY.md)
      try {
        const rulesPath = path.join(process.cwd(), 'multiterminal-rules.md');
        if (fs.existsSync(rulesPath)) {
          const rulesContent = fs.readFileSync(rulesPath, 'utf-8').trim();
          if (rulesContent) {
            console.log(rulesContent);
            console.log('');
          }
        }
      } catch (rulesErr) {
        // Non-critical — never block startup
      }

      // Inject ACTIVE-CONTEXT.md for session continuity
      try {
        // Derive the per-project memory folder name (project path with ':' '\' '/' → '-')
        // from CLAUDE_PROJECT_DIR (else cwd) instead of hardcoding it, so this shipped hook
        // reads the right project's context on any machine. (issue #5 follow-up)
        const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
        const projectFolderName = projectDir.replace(/[\\/]+$/, '').replace(/[:\\/]/g, '-');
        const memoryDir = path.join(process.env.USERPROFILE || os.homedir(), '.claude', 'projects',
          projectFolderName, 'memory');
        const activeContextPath = path.join(memoryDir, 'ACTIVE-CONTEXT.md');
        if (fs.existsSync(activeContextPath)) {
          const contextContent = fs.readFileSync(activeContextPath, 'utf-8').trim();
          if (contextContent) {
            console.log('## Session Continuity');
            console.log(contextContent);
            console.log('');
          }
        }
      } catch (ctxErr) {
        // Non-critical — never block startup
      }

      // Inject per-project knowledge from DB with attention decay ranking
      try {
        const Database = requireBetterSqlite3();
        const projectId = process.env.MULTITERMINAL_PROJECT_ID || null;
        if (Database && fs.existsSync(DB_PATH) && projectId) {
          const kdb = new Database(DB_PATH, { readonly: false }); // writable: must bump reference counts
          kdb.pragma('busy_timeout = 2000');
          // Check if decay columns exist (migration may not have run yet)
          const cols = kdb.prepare("PRAGMA table_info(knowledge_entries)").all();
          const hasDecay = cols.some(c => c.name === 'last_referenced');

          let knowledge;
          if (hasDecay) {
            // Decay-aware query: rank by reference recency weighted by frequency
            // Score = (reference_count + 1) / (days_since_referenced + 1)
            knowledge = kdb.prepare(`
              SELECT id, title, content, category, confidence, last_referenced, reference_count,
                     (COALESCE(reference_count, 0) + 1.0)
                     / (julianday('now') - julianday(COALESCE(last_referenced, updated_at)) + 1.0)
                     AS decay_score
              FROM knowledge_entries
              WHERE (project_id = ? OR project_id IS NULL)
                AND confidence != 'deprecated'
                AND category NOT IN ('web_research')
              ORDER BY decay_score DESC
              LIMIT 15
            `).all(projectId);

            // Bump reference counts for injected entries
            if (knowledge.length > 0) {
              const bumpStmt = kdb.prepare(
                `UPDATE knowledge_entries SET last_referenced = datetime('now'), reference_count = reference_count + 1 WHERE id = ?`
              );
              const bumpAll = kdb.transaction((entries) => {
                for (const e of entries) bumpStmt.run(e.id);
              });
              bumpAll(knowledge);
            }
          } else {
            // Fallback: simple recency ranking (pre-migration)
            knowledge = kdb.prepare(`
              SELECT id, title, content, category, confidence
              FROM knowledge_entries
              WHERE (project_id = ? OR project_id IS NULL)
                AND confidence != 'deprecated'
                AND category NOT IN ('web_research')
              ORDER BY updated_at DESC
              LIMIT 15
            `).all(projectId);
          }
          kdb.close();

          if (knowledge.length > 0) {
            console.log('## Project Knowledge');
            // Top 10: full injection (200 char content)
            const fullInject = knowledge.slice(0, 10);
            for (const entry of fullInject) {
              console.log(`**${entry.title}** (${entry.category}): ${entry.content.substring(0, 200)}${entry.content.length > 200 ? '...' : ''}`);
            }
            // Next 5: title-only (saves context tokens)
            const titleOnly = knowledge.slice(10, 15);
            if (titleOnly.length > 0) {
              console.log('_Also available (use query_knowledge for details):_');
              for (const entry of titleOnly) {
                console.log(`- ${entry.title} (${entry.category})`);
              }
            }
            console.log('');
          }
        }
      } catch (kErr) {
        // Non-critical — never block startup
      }

      // Inject kanban/plan context (for non-spawned agents only)
      try {
        const Database = requireBetterSqlite3();
        if (Database && fs.existsSync(DB_PATH)) {
          const db = new Database(DB_PATH, { readonly: true });
          const lines = [];
          const projectId = process.env.MULTITERMINAL_PROJECT_ID || null;

          const kanbanContext = getKanbanContext(db, terminalName, projectId);
          if (kanbanContext) {
            lines.push(kanbanContext);
          }

          const planContext = getPlanContext(db, terminalName);
          if (planContext) {
            if (lines.length > 0) lines.push('');
            lines.push(planContext);
          }

          const activeTaskContext = getActiveTaskContext(db, terminalName, projectId);
          if (activeTaskContext) {
            if (lines.length > 0) lines.push('');
            lines.push(activeTaskContext);
          }

          db.close();

          if (lines.length > 0) {
            console.log(lines.join('\n'));
          } else {
            console.log('No tasks assigned. Use list_tasks to see the board or claim_task to pick up work.');
          }

          // Inject last session recap (non-blocking — skip if API is unavailable)
          try {
            const http = require('http');
            const projectPath = process.cwd();
            const sessionRecap = await new Promise((resolve) => {
              const req = http.request({
                hostname: 'localhost',
                port: 5050,
                path: `/api/session-lineage/latest?projectPath=${encodeURIComponent(projectPath)}&agentName=${encodeURIComponent(terminalName)}`,
                method: 'GET',
                headers: { 'Content-Type': 'application/json' },
                timeout: 3000
              }, (res) => {
                let body = '';
                res.on('data', (chunk) => { body += chunk; });
                res.on('end', () => {
                  try {
                    resolve(JSON.parse(body));
                  } catch (e) {
                    resolve(null);
                  }
                });
              });
              req.on('error', () => resolve(null));
              req.on('timeout', () => { req.destroy(); resolve(null); });
              req.end();
            });

            if (sessionRecap && sessionRecap.session) {
              const sessionId = sessionRecap.session.sessionId || sessionRecap.session.id;
              console.log('');
              if (sessionRecap.summary) {
                console.log(`## Last Session Recap\n${sessionRecap.summary}`);
              } else {
                const msgs = sessionRecap.recentMessages || [];
                if (msgs.length > 0) {
                  const msgLines = msgs.map((m, i) => {
                    const preview = (m.content || '').substring(0, 300);
                    return `${i + 1}. [${m.role}] ${preview}${(m.content || '').length > 300 ? '...' : ''}`;
                  }).join('\n');
                  console.log(`## Last Session (no summary cached)\nRecent activity from your last session:\n${msgLines}`);
                  console.log(`NOTE: No cached summary for session ${sessionId}. The project-management skill will generate one.`);
                }
              }
            }
          } catch (sessionErr) {
            // Session recap is non-critical — never block startup
          }
        }
      } catch (err) {
        dtrace(`STEP-ERR: Error reading kanban/plan context: ${err.message}`);
        console.error('Error reading context:', err.message);
      }

      dtrace('STEP DONE: SessionStart branch completed');
      break;
    }

    case 'SessionEnd': {
      // Mark session as inactive
      const sessionId = hookData.session_id;
      updateSessionAgentMap(sessionId, terminalName, false);

      // Call the REST API to properly disconnect (updates in-memory state + database + broadcasts)
      let disconnected = false;
      try {
        const http = require('http');
        const postData = JSON.stringify({ name: terminalName });
        disconnected = await new Promise((resolve) => {
          const req = http.request({
            hostname: 'localhost',
            port: 5050,
            path: '/api/messaging/disconnect',
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
            timeout: 3000
          }, (res) => {
            resolve(res.statusCode === 200);
          });
          req.on('error', () => resolve(false));
          req.on('timeout', () => { req.destroy(); resolve(false); });
          req.write(postData);
          req.end();
        });
      } catch (e) {
        // API not reachable
      }

      // Fallback to direct DB update if API is not available
      if (!disconnected) {
        updateProfileStatus(terminalName, false);
      }
      break;
    }

    default:
      console.error(`Unknown hook type: ${hookType}`);
      break;
  }
}

main().catch((err) => {
  console.error('Unhandled error:', err.message);
});

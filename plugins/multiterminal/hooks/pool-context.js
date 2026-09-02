#!/usr/bin/env node
/**
 * Plan Context Injection Hook for Claude Code SessionStart
 *
 * Retrieves active plan and kanban task context from multiterminal.db
 * and outputs formatted context for injection into the session.
 *
 * Usage (as Claude Code hook):
 *   node ~/.claude/hooks/pool-context.js
 *
 * Output: Formatted context string for user message prefix
 */

const path = require('path');
const fs = require('fs');

// better-sqlite3 resolution is centralized in _sqlite.js (issue #7) — no hardcoded paths.
const { requireBetterSqlite3 } = require('./_sqlite');


/**
 * Get kanban tasks assigned to or being worked on by this terminal
 */
function getKanbanContext(db, terminalName) {
  // Check if tasks table exists
  const tableCheck = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type='table' AND name='tasks'
  `).get();

  if (!tableCheck) {
    return null;
  }

  const lines = [];

  // Get tasks assigned to this terminal (in_progress first, then todo)
  if (terminalName) {
    const myTasks = db.prepare(`
      SELECT id, title, description, status, created_by, assignee
      FROM tasks
      WHERE assignee = ? AND status IN ('in_progress', 'todo')
      ORDER BY
        CASE status WHEN 'in_progress' THEN 0 WHEN 'todo' THEN 1 END,
        id
    `).all(terminalName);

    if (myTasks.length > 0) {
      lines.push(`## Your Kanban Tasks (${terminalName})`);
      for (const task of myTasks) {
        const statusIcon = task.status === 'in_progress' ? '🔨' : '📋';
        lines.push(`${statusIcon} [${task.id}] ${task.title} (${task.status})`);
        if (task.description) {
          // Show first line of description, truncated
          const desc = task.description.split('\n')[0].substring(0, 80);
          lines.push(`   ${desc}${task.description.length > 80 ? '...' : ''}`);
        }
      }
      lines.push('');
      lines.push('Use list_tasks to see all board tasks, update_task_status when done.');
      lines.push('');
      lines.push('IMPORTANT: Run /project-management now to enter work mode and show the session dashboard.');
    }
  }

  // If no assigned tasks, show available tasks to claim
  if (lines.length === 0) {
    const availableTasks = db.prepare(`
      SELECT id, title, status, created_by
      FROM tasks
      WHERE (assignee IS NULL OR assignee = '') AND status IN ('todo', 'suggestion')
      ORDER BY
        CASE status WHEN 'todo' THEN 0 WHEN 'suggestion' THEN 1 END,
        id
      LIMIT 5
    `).all();

    if (availableTasks.length > 0) {
      lines.push('## Kanban Board - Available Tasks');
      for (const task of availableTasks) {
        const statusIcon = task.status === 'todo' ? '📋' : '💡';
        lines.push(`${statusIcon} [${task.id}] ${task.title} (${task.status})`);
      }
      lines.push('');
      lines.push('Use claim_task(task_id, your_name) to claim a task.');
      lines.push('');
      lines.push('IMPORTANT: Run /project-management now to enter work mode and show the session dashboard.');
    } else {
      lines.push('## Kanban Board');
      lines.push('No tasks available to claim. Use create_task to add work items.');
    }
  }

  return lines.length > 0 ? lines.join('\n') : null;
}

/**
 * Get active plan context from multiterminal.db
 * Mirrors the C# GenerateStartupContext method in PlanDatabase.cs
 */
function getPlanContext() {
  try {
    const Database = requireBetterSqlite3();
    if (!Database) return null;

    const dbPath = path.join(process.env.APPDATA || '', 'multiterminal', 'multiterminal.db');

    if (!fs.existsSync(dbPath)) {
      return null;
    }

    const db = new Database(dbPath, { readonly: true });
    const terminalName = process.env.MULTITERMINAL_NAME;
    const lines = [];

    // KANBAN BOARD FIRST - this is the central focus
    const kanbanContext = getKanbanContext(db, terminalName);
    if (kanbanContext) {
      lines.push(kanbanContext);
    }

    // Check if plans table exists for plan context
    const tableCheck = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type='table' AND name='plans'
    `).get();

    if (tableCheck) {
      // Get active plan
      const plan = db.prepare(`
        SELECT id, title, description, current_phase, status, leader_id
        FROM plans
        WHERE status = 'active'
        LIMIT 1
      `).get();

      if (plan) {
        // Get phases for this plan
        const phases = db.prepare(`
          SELECT id, phase_name, phase_order, checklist_json, started_at, completed_at
          FROM plan_phases
          WHERE plan_id = ?
          ORDER BY phase_order
        `).all(plan.id);

        // Get assignment for this terminal
        let assignment = null;
        if (terminalName) {
          assignment = db.prepare(`
            SELECT id, role, assigned_task_summary, status, blocked_by
            FROM plan_assignments
            WHERE plan_id = ? AND terminal_name = ?
          `).get(plan.id, terminalName);
        }

        // Format the plan context
        lines.push('');
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

        // Add current phase checklist
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
      }
    }

    db.close();

    // If we have no context at all, provide a helpful message
    if (lines.length === 0) {
      return '## Kanban Board\nNo tasks found. Use create_task to add work items or list_tasks to check the board.';
    }

    return lines.join('\n');

  } catch (e) {
    // SQLite not available or error
    return null;
  }
}


function main() {
  // Skip when running inside the Clarion IDE addin (tools not available there)
  if (process.env.CLARION_ASSISTANT_EMBEDDED) return;

  // Get plan context (tells terminal its mission and current tasks)
  const planContext = getPlanContext();
  if (planContext) {
    console.log(planContext);
  }
}

main();

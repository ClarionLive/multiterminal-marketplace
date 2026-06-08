#!/usr/bin/env node
/**
 * Profile Status Hook for Claude Code
 *
 * Sets team member profile online/offline status when Claude sessions start/end.
 * Handles: SessionStart, SessionEnd
 *
 * Hook data is received via stdin as JSON.
 */

const fs = require('fs');
const path = require('path');

// Database path
const DB_PATH = path.join(process.env.APPDATA || '', 'multiterminal', 'tasks.db');

// better-sqlite3 resolution is centralized in _sqlite.js (issue #7) — no hardcoded paths.
const { requireBetterSqlite3 } = require('./_sqlite');

/**
 * Set profile online status in database
 */
function setProfileStatus(profileId, isOnline) {
  try {
    const Database = requireBetterSqlite3();
    if (!Database) {
      return false;
    }

    if (!fs.existsSync(DB_PATH)) {
      return false;
    }

    const db = new Database(DB_PATH);
    const updatedAt = new Date().toISOString();

    const stmt = db.prepare(`
      UPDATE team_member_profiles
      SET is_online = ?, updated_at = ?
      WHERE id = ?
    `);

    stmt.run(isOnline ? 1 : 0, updatedAt, profileId);
    db.close();

    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Process stdin and handle the hook event
 */
async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  if (!input.trim()) {
    return;
  }

  let hookData;
  try {
    hookData = JSON.parse(input);
  } catch (err) {
    return;
  }

  const terminalName = process.env.MULTITERMINAL_NAME;
  if (!terminalName) {
    // Not a MultiTerminal session, skip
    return;
  }

  const hookType = hookData.hook_type || hookData.type;

  switch (hookType) {
    case 'SessionStart': {
      // Set profile online when Claude session starts
      const success = setProfileStatus(terminalName, true);
      if (success) {
        console.log(`✓ Set ${terminalName} online`);
      }
      break;
    }

    case 'SessionEnd': {
      // Set profile offline when Claude session ends
      const success = setProfileStatus(terminalName, false);
      if (success) {
        console.log(`✓ Set ${terminalName} offline`);
      }
      break;
    }
  }
}

main().catch(() => {});

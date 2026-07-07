#!/usr/bin/env node
/**
 * Unit test for session-import-hook.run() (ticket 42c91001).
 *
 * The SessionEnd path reads the active task from SQLite and POSTs the transcript
 * to the lineage REST API — not safe to spawn against live MT, so equivalence
 * covers only the self-gate branches (non-SessionEnd / no-name / malformed). The
 * import path is proven here with injected getActiveTask + httpPost + fs.
 */
const assert = require('assert');
const { run } = require('../session-import-hook.js');

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed++; }

function deps(over = {}) {
  const posts = [];
  const logs = [];
  return {
    _posts: posts, _logs: logs,
    fs: { existsSync: () => over.transcriptExists !== false },
    env: { MULTITERMINAL_NAME: over.name !== undefined ? over.name : 'Henry' },
    getActiveTask: () => (over.activeTask !== undefined ? over.activeTask : { id: 't1', title: 'T' }),
    httpPost: async (path, body) => { posts.push({ path, body }); return over.postResult !== undefined ? over.postResult : { success: true, messageCount: 5 }; },
    log: (m) => logs.push(m),
  };
}

async function main() {
  // ── 1. SessionEnd + active task → POST lineage import with task id ──
  {
    const d = deps();
    const r = await run({ hook_event_name: 'SessionEnd', transcript_path: '/t.jsonl', session_id: 's1' }, d);
    ok(r.exitCode === 0, 'exit 0');
    ok(d._posts.length === 1, 'one import POST');
    ok(d._posts[0].body.taskId === 't1', 'links to active task id');
    ok(d._posts[0].body.sessionFilePath === '/t.jsonl', 'passes transcript path');
    ok(d._logs.some(l => l.includes('Imported') && l.includes('task t1')), 'success logged');
  }

  // ── 2. SessionEnd + NO active task → sentinel __unlinked__ ──
  {
    const d = deps({ activeTask: null });
    await run({ hook_event_name: 'SessionEnd', transcript_path: '/t.jsonl', session_id: 's1' }, d);
    ok(d._posts[0].body.taskId === '__unlinked__', 'unlinked sentinel when no active task');
  }

  // ── 3. Transcript missing → no import ──
  {
    const d = deps({ transcriptExists: false });
    await run({ hook_event_name: 'SessionEnd', transcript_path: '/gone.jsonl', session_id: 's1' }, d);
    ok(d._posts.length === 0, 'missing transcript → no POST');
    ok(d._logs.some(l => l.includes('Transcript not found')), 'logs not-found');
  }

  // ── 4. non-SessionEnd → self-gate, no import ──
  {
    const d = deps();
    await run({ hook_event_name: 'PreToolUse' }, d);
    ok(d._posts.length === 0, 'non-SessionEnd → no POST');
  }

  // ── 5. SessionEnd but no name → no import ──
  {
    const d = deps({ name: '' });
    await run({ hook_event_name: 'SessionEnd', transcript_path: '/t.jsonl', session_id: 's1' }, d);
    ok(d._posts.length === 0, 'no name → no POST');
  }

  console.log(`session-import run() unit: PASS (${passed} assertions)`);
}

main().catch((e) => { console.error(e); process.exit(1); });

#!/usr/bin/env node
/**
 * Unit test for pipeline-trigger-hook.run() (ticket 42c91001).
 *
 * The trigger path fires a live task-detail GET + channel POST, so equivalence
 * covers only the no-taskId/malformed branches. The all-testing-or-done gate,
 * the AUTO-PIPELINE stdout, and the channel-message dispatch are proven here with
 * injected getTaskDetail + sendChannelMessage.
 */
const assert = require('assert');
const { run } = require('../pipeline-trigger-hook.js');

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed++; }

function deps(over = {}) {
  const sends = [];
  const gets = [];
  return {
    _sends: sends, _gets: gets,
    env: { MULTITERMINAL_NAME: over.name !== undefined ? over.name : 'Henry' },
    getTaskDetail: async (id) => { gets.push(id); return over.taskData !== undefined ? over.taskData : { title: 'Tooling diet', checklist: [{ status: 'testing' }, { status: 'done' }] }; },
    sendChannelMessage: async (...a) => { sends.push(a); },
  };
}

async function main() {
  // ── 1. all testing/done with ≥1 testing → AUTO-PIPELINE stdout + channel msg ──
  {
    const d = deps();
    const r = await run({ tool_input: { taskId: 't1' } }, d);
    ok(r.exitCode === 0, 'exit 0');
    ok(r.stdout && r.stdout.includes('AUTO-PIPELINE TRIGGER'), 'emits trigger reminder');
    ok(r.stdout.endsWith('\n'), 'trailing newline matches console.log');
    ok(d._sends.length === 1, 'channel message sent');
    ok(d._sends[0][0] === 'Henry' && d._sends[0][1] === 't1', 'channel msg targets agent + task');
  }

  // ── 2. no taskId → self-gate, no detail fetch, no stdout ──
  {
    const d = deps();
    const r = await run({ tool_input: {} }, d);
    ok(!r.stdout, 'no taskId → no trigger');
    ok(d._gets.length === 0, 'no taskId → no detail fetch');
  }

  // ── 3. a pending item remains → no trigger ──
  {
    const d = deps({ taskData: { title: 'T', checklist: [{ status: 'testing' }, { status: 'pending' }] } });
    const r = await run({ tool_input: { taskId: 't1' } }, d);
    ok(!r.stdout, 'pending remains → no trigger');
    ok(d._sends.length === 0, 'pending remains → no channel msg');
  }

  // ── 4. all done, none testing → no trigger (already past pipeline) ──
  {
    const d = deps({ taskData: { title: 'T', checklist: [{ status: 'done' }, { status: 'done' }] } });
    const r = await run({ tool_input: { taskId: 't1' } }, d);
    ok(!r.stdout, 'all done, no testing → no trigger');
  }

  // ── 5. no agent name → stdout still emitted, but no channel send ──
  {
    const d = deps({ name: '' });
    const r = await run({ tool_input: { taskId: 't1' } }, d);
    ok(r.stdout && r.stdout.includes('AUTO-PIPELINE'), 'stdout still emitted');
    ok(d._sends.length === 0, 'no agent name → no channel send');
  }

  console.log(`pipeline-trigger run() unit: PASS (${passed} assertions)`);
}

main().catch((e) => { console.error(e); process.exit(1); });

#!/usr/bin/env node
/**
 * Unit test for activity-hook.run() (ticket 42c91001).
 *
 * WHY A UNIT TEST: activity records to SQLite + bridges subagents via HTTP to the
 * running MultiTerminal. Firing those for real (as the spawn-equivalence harness
 * would) would write junk rows and hit the live app. So the event→side-effect
 * dispatch is proven here with SPY deps (recordActivity / registerSubagent /
 * disconnectSubagent), zero live effect; the CLI-shim wrapper is proven separately
 * by the equivalence harness on APPDATA-isolated, non-HTTP branches.
 */
const os = require('os');
process.env.APPDATA = os.tmpdir(); // keep the debug-log append off the real path
const assert = require('assert');
const { run } = require('../activity-hook.js');

function spy() {
  const calls = [];
  const fn = (...a) => { calls.push(a); };
  fn.calls = calls;
  return fn;
}

async function main() {
  let ra, rs, ds;

  // PreToolUse + Edit → TOOL_START, no subagent register
  ra = spy(); rs = spy();
  await run({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/a/b.js' } },
    { recordActivity: ra, registerSubagent: rs });
  assert.strictEqual(ra.calls.length, 1, 'Edit records once');
  assert.strictEqual(ra.calls[0][0], 'TOOL_START', 'Edit → TOOL_START');
  assert.strictEqual(rs.calls.length, 0, 'Edit does not register');

  // PreToolUse + Read → skipped (noisy read-only), no record
  ra = spy();
  await run({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/a' } }, { recordActivity: ra });
  assert.strictEqual(ra.calls.length, 0, 'Read skipped');

  // PreToolUse + Task → registerSubagent + TOOL_START
  ra = spy(); rs = spy();
  await run({ hook_event_name: 'PreToolUse', tool_name: 'Task', tool_input: { name: 'W', subagent_type: 'general-purpose' } },
    { recordActivity: ra, registerSubagent: rs });
  assert.strictEqual(rs.calls.length, 1, 'Task registers subagent');
  assert.strictEqual(ra.calls[0][0], 'TOOL_START', 'Task → TOOL_START');

  // PostToolUse + Task → disconnectSubagent + TOOL_COMPLETE
  ra = spy(); ds = spy();
  await run({ hook_event_name: 'PostToolUse', tool_name: 'Task', tool_input: { name: 'W' } },
    { recordActivity: ra, disconnectSubagent: ds });
  assert.strictEqual(ds.calls.length, 1, 'Task disconnects subagent');
  assert.strictEqual(ra.calls[0][0], 'TOOL_COMPLETE', 'Task → TOOL_COMPLETE');

  // PostToolUse + Bash build success → BUILD_SUCCEEDED
  ra = spy();
  await run({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'dotnet build MT.sln' }, output: { exit_code: 0 } }, { recordActivity: ra });
  assert.strictEqual(ra.calls[0][0], 'BUILD_SUCCEEDED', 'build ok → BUILD_SUCCEEDED');

  // PostToolUse + Bash build fail (top-level exit_code) → BUILD_FAILED
  ra = spy();
  await run({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'dotnet build' }, exit_code: 1 }, { recordActivity: ra });
  assert.strictEqual(ra.calls[0][0], 'BUILD_FAILED', 'build fail → BUILD_FAILED');

  // PostToolUseFailure → TOOL_FAILED
  ra = spy();
  await run({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', error: 'boom happened' }, { recordActivity: ra });
  assert.strictEqual(ra.calls[0][0], 'TOOL_FAILED', 'failure → TOOL_FAILED');

  // SubagentStop success → SUBAGENT_COMPLETE
  ra = spy();
  await run({ hook_event_name: 'SubagentStop', subagent_type: 'coder', success: true }, { recordActivity: ra });
  assert.strictEqual(ra.calls[0][0], 'SUBAGENT_COMPLETE', 'subagent ok → SUBAGENT_COMPLETE');

  // Always returns exitCode 0 (async class never blocks)
  const r = await run({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: {} }, { recordActivity: spy() });
  assert.strictEqual(r.exitCode, 0, 'returns exitCode 0');

  console.log('activity run() unit: PASS (12 assertions)');
}

main().catch((e) => { console.error(e); process.exit(1); });

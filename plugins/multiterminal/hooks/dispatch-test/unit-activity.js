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
const fs = require('fs');
const path = require('path');
const { run, DB_PATH } = require('../activity-hook.js');

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

  // ── Provenance + the Escape clear-edge (MultiTerminal task edcdcdd5) ──────────

  // Stop -> TURN_END. This is the clear-edge for a block the owner DISMISSED rather
  // than answered: pressing Escape submits no prompt, so UserPromptSubmit never fires
  // and the alert stayed lit -- the owner saw a card pulsing 49 minutes after they had
  // dismissed it. Escape ends the turn, so Stop fires.
  ra = spy();
  await run({ hook_event_name: 'Stop' }, { recordActivity: ra });
  assert.strictEqual(ra.calls.length, 1, 'Stop records once');
  assert.strictEqual(ra.calls[0][0], 'TURN_END', 'Stop -> TURN_END');

  // agent_id is carried through, so a consumer can tell a SUBAGENT's tool call from its
  // parent's. Both are logged under the parent's MULTITERMINAL_NAME -- measured at 19.5%
  // of PreToolUse events -- so without this the rail would clear a parent that is still
  // genuinely waiting, rendering a calm card that looks exactly like nobody needing you.
  ra = spy();
  await run({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: '/a/b.js' },
              agent_id: 'sub-7', session_id: 'sess-1' }, { recordActivity: ra });
  let d = JSON.parse(ra.calls[0][4]);
  assert.strictEqual(d.agent_id, 'sub-7', 'subagent row carries agent_id');
  assert.strictEqual(d.session_id, 'sess-1', 'row carries session_id');

  // Main-thread rows carry the KEY with an explicit null rather than omitting it. A
  // consumer must distinguish "this row says it was the main thread" from "this row
  // predates provenance and cannot say", because the safe default for the second is
  // possibly-subagent -- and that default inverts if absence is read as main-thread.
  ra = spy();
  await run({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: '/a/b.js' },
              session_id: 'sess-1' }, { recordActivity: ra });
  d = JSON.parse(ra.calls[0][4]);
  assert.ok('agent_id' in d, 'main-thread row still carries the agent_id key');
  assert.strictEqual(d.agent_id, null, 'main-thread agent_id is explicitly null');

  // Provenance must not clobber a payload field of the same name.
  ra = spy();
  await run({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'echo hi' },
              agent_id: 'sub-9' }, { recordActivity: ra });
  d = JSON.parse(ra.calls[0][4]);
  assert.strictEqual(d.tool, 'Bash', 'original details survive alongside provenance');
  assert.strictEqual(d.agent_id, 'sub-9', 'provenance present on the same row');

  // ── The database the rows actually go to (MultiTerminal task edcdcdd5, live-test failure) ──
  //
  // Everything above proves the DISPATCH with a spy; none of it touches the real
  // recordActivity(), whose DB_PATH still named tasks.db -- a 0-byte leftover with no
  // tables, from the day the app's database became multiterminal.db. Every INSERT threw
  // "no such table: activity_feed" straight into recordActivity's catch, which returns
  // false, silently. The last TOOL_* row the app ever received was dated 2026-03-05; the
  // attention rail shipped six months later on the premise that these rows existed, and
  // the owner watched a card that never moved. Nothing in this suite could have failed.
  assert.strictEqual(path.basename(DB_PATH), 'multiterminal.db',
    'activity rows go to the live database, not the dead tasks.db');

  // Census, not a roster: two OTHER hooks carried the same dead path. Naming them here
  // would be written from the same wrong model that missed them, so instead every hook
  // is scanned for the dead filename and the list of offenders must be empty.
  const hooksDir = path.join(__dirname, '..');
  const offenders = fs.readdirSync(hooksDir)
    .filter((f) => f.endsWith('.js'))
    .filter((f) => fs.readFileSync(path.join(hooksDir, f), 'utf8').includes('tasks.db'));
  assert.deepStrictEqual(offenders, [], `hooks still naming tasks.db: ${offenders.join(', ')}`);

  // ── TOOL_QUIET: every completion clears, only DISPLAY_TOOLS show (MT task edcdcdd5 item 2) ──
  //
  // The hook is now MATCHER-BLIND in the dispatch table, and decides for itself. Previously
  // two filters disagreed: the table gated it to Edit|Write|Bash|Task while a SKIP_TOOLS
  // blacklist named four tools that could never arrive. Everything in the gap — PowerShell,
  // every MCP call, every read — was dropped without anyone deciding to drop it, and since
  // the Attention Rail's clear-edge reads these rows, a blocked card sat lit through all of it.
  //
  // Measured on raw transcripts: the four covered 629 of 1068 tool uses. 41% invisible.
  //
  // PowerShell leads this list deliberately — the Owner guessed it ("possibly a powershell
  // command as well") and it was the largest single tool outside the old gate.
  for (const tool of ['PowerShell', 'Read', 'Glob', 'Grep', 'ToolSearch', 'WebFetch', 'mcp__multiterminal__update_task_checklist']) {
    ra = spy();
    await run({ hook_event_name: 'PostToolUse', tool_name: tool, tool_input: {} }, { recordActivity: ra });
    assert.strictEqual(ra.calls.length, 1, `${tool} PostToolUse must record a row`);
    assert.strictEqual(ra.calls[0][0], 'TOOL_QUIET', `${tool} → TOOL_QUIET`);
  }

  // POLARITY GUARD. A non-displayed tool must NOT produce TOOL_COMPLETE: that type feeds the
  // display line, so it would put "Read: foo.cs" on the card and move the Activity feed's
  // noise somewhere more prominent rather than removing it.
  ra = spy();
  await run({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: {} }, { recordActivity: ra });
  assert.notStrictEqual(ra.calls[0][0], 'TOOL_COMPLETE', 'a non-displayed tool must not take the displaying type');

  // Non-displayed tools still write NOTHING on PreToolUse. TOOL_START never clears, so a quiet
  // start row would be pure volume with no consumer.
  for (const tool of ['Read', 'PowerShell']) {
    ra = spy();
    await run({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: {} }, { recordActivity: ra });
    assert.strictEqual(ra.calls.length, 0, `${tool} records nothing on PreToolUse`);
  }

  // THE DISPLAY SET IS UNCHANGED — this is what keeps the Activity feed exactly as readable as
  // it was. If these ever became TOOL_QUIET the feed would empty out, which is the opposite
  // failure and just as silent.
  for (const tool of ['Edit', 'Write', 'Bash']) {
    ra = spy();
    await run({ hook_event_name: 'PostToolUse', tool_name: tool, tool_input: { file_path: '/a/b.js', command: 'echo hi' } }, { recordActivity: ra });
    assert.strictEqual(ra.calls[0][0], 'TOOL_COMPLETE', `${tool} still → TOOL_COMPLETE`);
  }

  // ...and they still write their displayed TOOL_START.
  ra = spy();
  await run({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/a/b.js' } }, { recordActivity: ra });
  assert.strictEqual(ra.calls[0][0], 'TOOL_START', 'Edit still → TOOL_START');

  // ── THE GUARD THAT THE TESTS ABOVE CANNOT BE (MT task edcdcdd5 item 2) ─────────────
  //
  // Every assertion above calls run() directly, so they ALL stay green if someone re-adds a
  // table-matcher to activity-hook — and the hook would then never be invoked for the tools
  // they cover. That is exactly how this bug shipped the first time: a matcher added for a
  // reason that had nothing to do with the clear-edge, silently deciding which tools could
  // clear a blocked card, with a full green suite either side of it.
  //
  // So assert the routing itself. DISPLAY_TOOLS inside the hook is now the ONLY place that
  // decides what shows; the table must not hold a second, disagreeing opinion.
  {
    const { TABLE } = require('../dispatch-hook.js');
    const gated = [];
    for (const [event, leaves] of Object.entries(TABLE)) {
      for (const leaf of leaves) {
        if (leaf.name === 'activity-hook' && leaf.matcher) gated.push(`${event}: ${leaf.matcher}`);
      }
    }
    assert.deepStrictEqual(
      gated, [],
      `activity-hook must be matcher-blind — a table-matcher silently decides which tools can ` +
      `clear a blocked card. Found: ${gated.join(', ')}`
    );

    // And it must actually still be routed on the two events that matter. A leaf deleted
    // outright would also satisfy "no matcher".
    for (const event of ['PreToolUse', 'PostToolUse']) {
      assert.ok(
        (TABLE[event] || []).some((l) => l.name === 'activity-hook'),
        `activity-hook must still be routed on ${event}`
      );
    }
  }

  console.log('activity run() unit: PASS (51 assertions)');
}

main().catch((e) => { console.error(e); process.exit(1); });

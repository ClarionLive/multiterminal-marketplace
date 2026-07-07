#!/usr/bin/env node
/**
 * dispatch-hook.js T-suite (ticket 42c91001). Proves the aggregation contract of
 * the two-headed dispatcher. Real leaves where side-effect-free (T1 safety), synthetic
 * stubs where a live path would fire side-effects or is dormant (T2 exit-2, T3 decision,
 * T4 async, T5 advisory). T6 asserts the routing table against hooks.json.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
process.env.APPDATA = os.tmpdir(); // isolate any incidental fs writes

const { dispatch, TABLE } = require('../dispatch-hook.js');

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed++; }

async function main() {
  // ── T1: PreToolUse sync, REAL safety-hook — deny propagates as permissionDecision ──
  {
    const r = await dispatch('PreToolUse', 'sync', { tool_name: 'Bash', tool_input: { command: 'git add .' } });
    ok(r.exitCode === 0, 'T1 exit 0');
    const o = JSON.parse(r.stdout);
    ok(o.hookSpecificOutput.permissionDecision === 'deny', 'T1 safety deny propagates through the dispatcher');
    console.log('  ✓ T1 safety deny → permissionDecision JSON + exit 0 (real safety-hook)');
  }

  // ── T2: exit-2 propagation via synthetic stub (live path is DORMANT, REDIRECT_TYPES=[]) ──
  {
    const table = { PreToolUse: [
      { name: 'stub-block', head: 'sync', run: async () => ({ exitCode: 2, stderr: 'BLOCKED-BY-STUB' }) },
      { name: 'should-not-run', head: 'sync', run: async () => ({ exitCode: 0, stdout: 'nope' }) },
    ] };
    const r = await dispatch('PreToolUse', 'sync', {}, table);
    ok(r.exitCode === 2, 'T2 exit 2 propagates verbatim');
    ok(r.stderr === 'BLOCKED-BY-STUB', 'T2 stderr verbatim');
    ok(!(r.stdout || '').includes('nope'), 'T2 exit-2 stops the chain');
    console.log('  ✓ T2 exit-2 + stderr propagates verbatim, stops chain (synthetic stub)');
  }

  // ── T3: Stop decision:block passes through + short-circuits ──
  {
    const table = { Stop: [
      { name: 'stub-inbox', head: 'sync', run: async () => ({ exitCode: 0, stdout: JSON.stringify({ decision: 'block', reason: 'msgs' }) }) },
      { name: 'after', head: 'sync', run: async () => ({ exitCode: 0, stdout: 'should-not-append' }) },
    ] };
    const r = await dispatch('Stop', 'sync', {}, table);
    ok(JSON.parse(r.stdout).decision === 'block', 'T3 decision:block emitted');
    ok(!r.stdout.includes('should-not-append'), 'T3 decision short-circuits chain');
    console.log('  ✓ T3 Stop decision:block emitted + short-circuits');
  }

  // ── T4: async head never blocks; ignores throws + non-zero exits ──
  {
    const table = { PostToolUse: [
      { name: 'async-throws', head: 'async', run: async () => { throw new Error('boom'); } },
      { name: 'async-returns-2', head: 'async', run: async () => ({ exitCode: 2, stderr: 'ignored' }) },
    ] };
    const r = await dispatch('PostToolUse', 'async', {}, table);
    ok(r.exitCode === 0, 'T4 async head exit 0 despite a throwing + exit-2 leaf');
    ok(!r.stdout, 'T4 async head emits no stdout');
    console.log('  ✓ T4 async leaves never block / never affect exit or stdout');
  }

  // ── T5: advisory (context-threshold analog) accumulates, never short-circuits/blocks ──
  {
    const table = { UserPromptSubmit: [
      { name: 'advisory', head: 'sync', run: async () => ({ exitCode: 0, stdout: 'context at 72% — consider /compact' }) },
      { name: 'after-advisory', head: 'sync', run: async () => ({ exitCode: 0, stdout: 'second context line' }) },
    ] };
    const r = await dispatch('UserPromptSubmit', 'sync', {}, table);
    ok(r.exitCode === 0, 'T5 advisory exit 0');
    ok(r.stdout.includes('72%') && r.stdout.includes('second context line'),
      'T5 advisory does NOT short-circuit (not a decision) — both lines accumulate');
    console.log('  ✓ T5 advisory stdout accumulates, never blocks/short-circuits');
  }

  // ── T6: routing-table parity vs hooks.json (classification + census + coverage) ──
  {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'hooks.json'), 'utf8'));
    const jsonLeaves = {}; // event -> [{name, async}]  (node hooks only — the dispatchable set)
    let total = 0;
    let node = 0;
    const nonNode = [];
    for (const [event, blocks] of Object.entries(cfg.hooks)) {
      jsonLeaves[event] = [];
      for (const block of blocks) {
        for (const h of (block.hooks || [])) {
          total++;
          if (h.command === 'node') {
            node++;
            const name = path.basename((h.args && h.args[0]) || '').replace(/\.js$/, '');
            jsonLeaves[event].push({ name, async: h.async === true });
          } else {
            nonNode.push({ event, command: h.command });
          }
        }
      }
    }

    // Census: 37 dispatchable node leaves + 1 non-node (SessionStart powershell echo) = 38.
    // POST-COLLAPSE SHAPE (PM-confirmed): the dispatcher owns node leaves only, so the
    // collapsed hooks.json is 37/37 node leaves routed through dispatch-hook.js (2 entries
    // per event: sync + async:true) PLUS the 1 powershell echo kept as its own standalone
    // SessionStart entry = 38 total. The powershell leaf is never dispatched.
    ok(total === 38, `T6 hooks.json total leaf census == 38 (got ${total})`);
    ok(node === 37, `T6 dispatchable node leaves == 37 (got ${node})`);
    ok(nonNode.length === 1 && nonNode[0].command === 'powershell',
      'T6 exactly 1 non-node leaf (SessionStart powershell echo) stays standalone, not dispatched');

    // Classification: every TABLE leaf is sync XOR async AND matches its hooks.json async flag.
    let covered = 0;
    for (const [event, leaves] of Object.entries(TABLE)) {
      for (const leaf of leaves) {
        ok(leaf.head === 'sync' || leaf.head === 'async', `T6 ${event}/${leaf.name} head is sync XOR async`);
        const matches = (jsonLeaves[event] || []).filter((j) => j.name === leaf.name);
        ok(matches.length > 0, `T6 ${event}/${leaf.name} exists as a node leaf in hooks.json`);
        for (const m of matches) {
          const expected = m.async ? 'async' : 'sync';
          ok(leaf.head === expected,
            `T6 ${event}/${leaf.name} head '${leaf.head}' == hooks.json async-flag → '${expected}'`);
        }
        covered += matches.length;
      }
    }

    const tableLeaves = Object.values(TABLE).flat().length;
    console.log(`  ✓ T6 classification correct for all ${tableLeaves} table leaves; census 37 node + 1 powershell = 38`);
    console.log(`    COVERAGE: ${covered}/${node} node leaves wired in TABLE. Fan-out wires the remaining ${node - covered};`);
    console.log(`    the collapse gate REQUIRES ${node}/${node} (T6 becomes the completeness check at that point).`);
  }

  console.log(`\ndispatch T-suite: PASS (${passed} assertions)`);
}

main().catch((e) => { console.error(e); process.exit(1); });

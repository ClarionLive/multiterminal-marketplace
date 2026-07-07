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

const { dispatch, TABLE, STANDALONE } = require('../dispatch-hook.js');

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

  // ── T6: hooks.json accounting — census + classification + matcher-parity + bucket-exclusivity ──
  {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'hooks.json'), 'utf8'));
    const jsonLeaves = {}; // event -> [{name, async, matcher}]  (node leaves only)
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
            jsonLeaves[event].push({ name, async: h.async === true, matcher: block.matcher || '' });
          } else {
            nonNode.push({ event, command: h.command });
          }
        }
      }
    }

    // Census: 37 node leaves + 1 non-node (SessionStart powershell echo) = 38.
    // POST-COLLAPSE SHAPE (ruling C, 42c91001): every node leaf is EXACTLY ONE of
    //   {dispatched matcher-blind} XOR {dispatched with a table-matcher, B′} XOR
    //   {standalone-allowlisted}. The 1 powershell echo is non-node → inherently
    //   standalone. High-frequency matcher-safe events collapse into the dispatcher;
    //   the once-per-boot SessionStart trio stays standalone + individually wired.
    ok(total === 38, `T6 hooks.json total leaf census == 38 (got ${total})`);
    ok(node === 37, `T6 node leaves == 37 (got ${node})`);
    ok(nonNode.length === 1 && nonNode[0].command === 'powershell',
      'T6 exactly 1 non-node leaf (SessionStart powershell echo) — inherently standalone, never dispatched');

    // Unwired hooks: present in hooks/ but NOT registered in hooks.json — assert
    // absence so wiring one later without TABLE/STANDALONE accounting fails loudly.
    const allJsonNames = new Set(Object.values(jsonLeaves).flat().map((j) => j.name));
    for (const unwired of ['profile-status-hook', 'stop-relay-hook', 'pool-context']) {
      ok(!allJsonNames.has(unwired),
        `T6 unwired hook '${unwired}' absent from hooks.json (add to TABLE or STANDALONE if ever wired)`);
    }

    const tableNames = new Set(Object.values(TABLE).flat().map((l) => l.name));
    const standaloneNames = new Set(Object.keys(STANDALONE));

    // ── (2) STANDALONE ALLOWLIST: the SessionStart trio, enumerated + reasoned ──
    ok(standaloneNames.size === 3, `T6 standalone allowlist has exactly 3 node leaves (got ${standaloneNames.size})`);
    for (const name of standaloneNames) {
      ok(allJsonNames.has(name), `T6 standalone '${name}' is a real hooks.json node leaf`);
      ok(STANDALONE[name] && STANDALONE[name].length > 0, `T6 standalone '${name}' carries a reason`);
      ok(!tableNames.has(name), `T6 standalone '${name}' is NOT also in the dispatcher TABLE (bucket exclusivity)`);
    }

    // Bucket exclusivity + accounting, per hooks.json leaf OCCURRENCE (an event,name
    // pair). Each is exactly one of {dispatched, standalone}, or neither-YET
    // (remaining fan-out — soft now, MUST be empty at the collapse gate).
    const remaining = [];
    for (const [event, leaves] of Object.entries(jsonLeaves)) {
      for (const j of leaves) {
        const inTable = (TABLE[event] || []).some((l) => l.name === j.name);
        const inStandalone = standaloneNames.has(j.name);
        ok(!(inTable && inStandalone), `T6 '${event}/${j.name}' not in BOTH TABLE and STANDALONE`);
        if (!inTable && !inStandalone) remaining.push(`${event}/${j.name}`);
      }
    }

    // ── (1) MATCHER-PARITY (B′): a dispatched leaf carrying a table-matcher must ──
    // exactly equal the hooks.json matcher it replaced (active-context, pipeline-
    // trigger). Any drift between the in-table matcher and hooks.json fails loudly.
    let matcherChecked = 0;
    for (const [event, leaves] of Object.entries(TABLE)) {
      for (const leaf of leaves) {
        if (!leaf.matcher) continue;
        const matches = (jsonLeaves[event] || []).filter((j) => j.name === leaf.name);
        ok(matches.length > 0, `T6 table-matcher leaf ${event}/${leaf.name} exists in hooks.json`);
        for (const m of matches) {
          ok(m.matcher === leaf.matcher,
            `T6 matcher-parity ${event}/${leaf.name}: table matcher must equal the hooks.json matcher`);
          matcherChecked++;
        }
      }
    }

    // Classification: every TABLE leaf is sync XOR async AND matches its hooks.json async flag.
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
      }
    }

    const tableLeaves = Object.values(TABLE).flat().length;
    const accounted = node - remaining.length;
    console.log(`  ✓ T6 classification OK for ${tableLeaves} table leaves; matcher-parity checked ${matcherChecked}; census 37 node + 1 powershell = 38`);
    console.log(`    ACCOUNTED: ${accounted}/${node} node-leaf occurrences (dispatched ∪ standalone); STANDALONE = ${standaloneNames.size} node + 1 powershell.`);
    console.log(`    REMAINING fan-out: ${remaining.length}${remaining.length ? ` → ${remaining.sort().join(', ')}` : ''}`);
    console.log(`    COLLAPSE GATE requires REMAINING == 0 (every node leaf dispatched XOR standalone-allowlisted).`);
  }

  console.log(`\ndispatch T-suite: PASS (${passed} assertions)`);
}

main().catch((e) => { console.error(e); process.exit(1); });

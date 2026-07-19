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
    const jsonLeaves = {}; // event -> [{name, async, matcher, dispEvent?, dispHead?}] (node leaves)
    let total = 0;
    let node = 0;
    const nonNode = [];
    const dispSet = new Set(); // `${event}/${head}` for each dispatch-hook.js node leaf
    for (const [event, blocks] of Object.entries(cfg.hooks)) {
      jsonLeaves[event] = [];
      for (const block of blocks) {
        for (const h of (block.hooks || [])) {
          total++;
          if (h.command === 'node') {
            node++;
            const args = h.args || [];
            const name = path.basename(args[0] || '').replace(/\.js$/, '');
            const leaf = { name, async: h.async === true, matcher: block.matcher || '' };
            if (name === 'dispatch-hook') {
              // `node dispatch-hook.js <EventName> <sync|async>` — capture the
              // routed (event,head) so T6 can prove TABLE ⇄ hooks.json parity.
              leaf.dispEvent = args[1] || '';
              leaf.dispHead = args[2] || '';
              dispSet.add(`${leaf.dispEvent}/${leaf.dispHead}`);
            }
            jsonLeaves[event].push(leaf);
          } else {
            nonNode.push({ event, command: h.command });
          }
        }
      }
    }

    // Census: 21 node leaves + 1 non-node (SessionStart powershell echo) = 22.
    // FULLY-COLLAPSED SHAPE (collapse commit 42c91001; rewritten acf2c16d, PM-ratified).
    //   hooks.json no longer wires individual hooks — high-frequency events route
    //   through `dispatch-hook.js <Event> <sync|async>` (matcher-BLIND); the dispatcher's
    //   TABLE holds the real per-leaf routing + matchers and gates them IN-PROCESS
    //   (runtime proof is T7: anchored full-match, both heads). So T6 no longer
    //   cross-checks individual leaf NAMES against hooks.json (that was the pre-collapse
    //   B′ shape, and the old 38/37 count was stale drift — no hook was dropped). It
    //   asserts the invariant that actually guards the collapsed wiring: EVERY
    //   (event,head) the TABLE routes has a matching dispatch-hook.js entry, and every
    //   dispatch entry is backed by TABLE leaves. Aggregation contract = T1–T5; matcher
    //   GATING = T7; this census reflects dispatch-hook.js routing, not per-hook wiring.
    ok(total === 22, `T6 hooks.json total leaf census == 22 (got ${total})`);
    ok(node === 21, `T6 node leaves == 21 (got ${node})`);
    ok(nonNode.length === 1 && nonNode[0].command === 'powershell',
      'T6 exactly 1 non-node leaf (SessionStart powershell echo) — inherently standalone, never dispatched');

    const tableNames = new Set(Object.values(TABLE).flat().map((l) => l.name));
    const standaloneNames = new Set(Object.keys(STANDALONE));
    const allJsonNames = new Set(Object.values(jsonLeaves).flat().map((j) => j.name));

    // ── (1) STANDALONE allowlist: the SessionStart trio, enumerated + reasoned ──
    ok(standaloneNames.size === 3, `T6 standalone allowlist has exactly 3 node leaves (got ${standaloneNames.size})`);
    for (const name of standaloneNames) {
      ok(allJsonNames.has(name), `T6 standalone '${name}' is a real hooks.json node leaf`);
      ok(STANDALONE[name] && STANDALONE[name].length > 0, `T6 standalone '${name}' carries a reason`);
      ok(!tableNames.has(name), `T6 standalone '${name}' is NOT also in the dispatcher TABLE (bucket exclusivity)`);
    }

    // ── (2) PARTITION: every hooks.json node leaf is EXACTLY ONE of {dispatch-hook.js
    //   entry} XOR {standalone-allowlisted}. An individual hook re-wired as a hooks.json
    //   leaf (regressing the collapse) is neither → fails loudly here.
    for (const [event, leaves] of Object.entries(jsonLeaves)) {
      for (const j of leaves) {
        const isDispatch = j.name === 'dispatch-hook';
        const isStandalone = standaloneNames.has(j.name);
        ok(isDispatch !== isStandalone,
          `T6 '${event}/${j.name}' is EXACTLY ONE of {dispatch-hook, standalone} (dispatch=${isDispatch}, standalone=${isStandalone})`);
      }
    }

    // ── (3) EVENT/HEAD parity — the core collapsed-shape invariant ──
    // Every (event,head) the TABLE routes MUST have a matching dispatch-hook.js entry
    // (else that handler is silently dead), AND every dispatch entry MUST be backed by
    // ≥1 TABLE leaf of that head (else the dispatcher fires for an empty head).
    // Returned as a violation list so the SAME check drives the real-config assertion
    // (empty) and the negative self-test below (non-empty).
    function eventHeadViolations(tableObj, dispatchSet) {
      const v = [];
      const wantedHeads = {}; // event -> Set(head) the TABLE routes
      for (const [event, leaves] of Object.entries(tableObj)) {
        for (const leaf of leaves) (wantedHeads[event] ??= new Set()).add(leaf.head);
      }
      for (const [event, heads] of Object.entries(wantedHeads)) {
        for (const head of heads) {
          if (!dispatchSet.has(`${event}/${head}`)) v.push(`MISSING ${event}/${head} (TABLE routes it, hooks.json doesn't wire dispatch-hook)`);
        }
      }
      for (const key of dispatchSet) {
        const [event, head] = key.split('/');
        if (!(wantedHeads[event] && wantedHeads[event].has(head))) v.push(`ORPHAN ${event}/${head} (hooks.json wires it, TABLE has no ${head} leaf)`);
      }
      return v;
    }
    const violations = eventHeadViolations(TABLE, dispSet);
    ok(violations.length === 0,
      `T6 EVENT/HEAD parity: ${violations.length ? violations.join('; ') : 'all TABLE-routed events wired ⇄ all dispatch entries backed'}`);

    // async-flag parity: a dispatch-hook.js leaf whose head arg is 'async' MUST carry
    // async:true (and 'sync' → async:false) so Claude Code fires it blocking vs async.
    for (const leaves of Object.values(jsonLeaves)) {
      for (const j of leaves) {
        if (j.name !== 'dispatch-hook') continue;
        ok(j.dispHead === 'sync' || j.dispHead === 'async', `T6 dispatch head arg '${j.dispHead}' is sync XOR async`);
        const expectAsync = j.dispHead === 'async';
        ok(j.async === expectAsync,
          `T6 dispatch '${j.dispEvent}/${j.dispHead}' async-flag ${j.async} matches head → expected ${expectAsync}`);
      }
    }

    // ── (4) TABLE classification + matcher validity (T7 owns matcher GATING) ──
    let matcherChecked = 0;
    for (const [event, leaves] of Object.entries(TABLE)) {
      for (const leaf of leaves) {
        ok(leaf.head === 'sync' || leaf.head === 'async', `T6 ${event}/${leaf.name} head is sync XOR async`);
        if (leaf.matcher) {
          let compiles = true;
          try { new RegExp('^(?:' + leaf.matcher + ')$'); } catch { compiles = false; }
          ok(compiles, `T6 ${event}/${leaf.name} table-matcher compiles (runtime gating proven by T7)`);
          matcherChecked++;
        }
      }
    }

    // ── (5) NEGATIVE self-test: drop a required dispatch entry → parity MUST fail ──
    // Guards the guard: proves eventHeadViolations catches a dead handler, so a future
    // collapse that forgets to wire a dispatch entry can't pass silently.
    {
      const anyKey = dispSet.values().next().value;
      const mutated = new Set(dispSet); mutated.delete(anyKey);
      const negV = eventHeadViolations(TABLE, mutated);
      ok(negV.some((s) => s.startsWith('MISSING')),
        `T6 negative self-test: dropping ${anyKey} must trip parity (got: ${negV.join('; ') || 'NO violation — BUG'})`);
    }

    const tableLeaves = Object.values(TABLE).flat().length;
    console.log(`  ✓ T6 collapsed-shape accounting OK: census ${node} node + ${nonNode.length} powershell = ${total}; ${dispSet.size} dispatch (event,head) entries ⇄ ${tableLeaves} TABLE leaves; matchers validated ${matcherChecked} (gating → T7)`);
  }

  // ── T7: matcher-gating runtime (B′) — a table-matcher leaf runs ONLY on its tools ──
  {
    const ran = [];
    const table = { PostToolUse: [
      { name: 'gated', head: 'sync', matcher: 'mcp__x__foo|mcp__x__bar', run: async () => { ran.push('gated'); return { exitCode: 0 }; } },
      { name: 'blind', head: 'sync', run: async () => { ran.push('blind'); return { exitCode: 0 }; } },
    ] };

    ran.length = 0;
    await dispatch('PostToolUse', 'sync', { tool_name: 'Edit' }, table);
    ok(ran.length === 1 && ran[0] === 'blind', 'T7 matcher MISS → gated leaf skipped, matcher-blind leaf still runs');

    ran.length = 0;
    await dispatch('PostToolUse', 'sync', { tool_name: 'mcp__x__foo' }, table);
    ok(ran.includes('gated') && ran.includes('blind'), 'T7 matcher HIT → gated + blind both run');

    ran.length = 0;
    await dispatch('PostToolUse', 'sync', { tool_name: 'mcp__x__foobar' }, table);
    ok(!ran.includes('gated'), 'T7 ANCHORED full-match → mcp__x__foobar does NOT match mcp__x__foo (no substring leak)');

    // async head is matcher-gated too
    const aran = [];
    const atable = { PostToolUse: [
      { name: 'gated-async', head: 'async', matcher: 'mcp__x__foo', run: async () => { aran.push('g'); } },
    ] };
    await dispatch('PostToolUse', 'async', { tool_name: 'Edit' }, atable);
    ok(aran.length === 0, 'T7 async head also matcher-gated (miss → not run)');
    await dispatch('PostToolUse', 'async', { tool_name: 'mcp__x__foo' }, atable);
    ok(aran.length === 1, 'T7 async head runs on matcher hit');

    console.log('  ✓ T7 matcher-gating: sync + async heads honor the table-matcher (anchored full-match, no substring leak)');
  }

  console.log(`\ndispatch T-suite: PASS (${passed} assertions)`);
}

main().catch((e) => { console.error(e); process.exit(1); });

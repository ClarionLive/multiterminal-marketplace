#!/usr/bin/env node
/**
 * collapse-validate.js — post-collapse gate (ticket 42c91001).
 *
 * Proves a COLLAPSED hooks.json fires exactly the same leaf set, per event, as
 * the pre-collapse baseline — with the dispatched leaves routed through
 * dispatch-hook.js (sync/async entries) and the SessionStart trio + powershell
 * kept standalone. Run it against the edit-aside file BEFORE the swap, and
 * against the live hooks.json AFTER, to prove the swap changed structure only,
 * not which hooks run where.
 *
 * Usage: node collapse-validate.js <collapsed.json> <baseline.json>
 *   (defaults: ../hooks.json  ../hooks.json.backup-42c91001)
 */
const fs = require('fs');
const path = require('path');
const { TABLE, STANDALONE } = require('../dispatch-hook.js');

const collapsedPath = process.argv[2] || path.join(__dirname, '..', 'hooks.json');
const baselinePath = process.argv[3] || path.join(__dirname, '..', 'hooks.json.backup-42c91001');

let passed = 0;
const fails = [];
function ok(cond, msg) { if (cond) passed++; else fails.push(msg); }

function nodeLeaves(cfg) {
  // event -> Set(leaf-name) for node hooks that are NOT the dispatcher
  const m = {};
  for (const [event, blocks] of Object.entries(cfg.hooks)) {
    m[event] = m[event] || new Set();
    for (const b of blocks) for (const h of (b.hooks || [])) {
      if (h.command !== 'node') continue;
      const name = path.basename(h.args[0]).replace(/\.js$/, '');
      if (name !== 'dispatch-hook') m[event].add(name);
    }
  }
  return m;
}
function dispatchEntries(cfg) {
  // event -> Set(head) for dispatch-hook.js entries
  const m = {};
  for (const [event, blocks] of Object.entries(cfg.hooks)) {
    m[event] = m[event] || new Set();
    for (const b of blocks) for (const h of (b.hooks || [])) {
      if (h.command === 'node' && path.basename(h.args[0]) === 'dispatch-hook.js') {
        m[event].add(h.args[2]); // 'sync' | 'async'
      }
    }
  }
  return m;
}

const collapsed = JSON.parse(fs.readFileSync(collapsedPath, 'utf8'));
const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
const baseLeaves = nodeLeaves(baseline);
const collStandalone = nodeLeaves(collapsed); // in collapsed, only standalone node leaves remain
const collDispatch = dispatchEntries(collapsed);
const standaloneNames = new Set(Object.keys(STANDALONE));

// (1) Every baseline (event, leaf) is covered post-collapse: either it's in the
//     STANDALONE allowlist AND kept as a standalone node entry on that event, or
//     it's a dispatched leaf (in TABLE[event]) AND that event has the matching
//     head's dispatch entry.
for (const [event, leaves] of Object.entries(baseLeaves)) {
  for (const name of leaves) {
    if (standaloneNames.has(name)) {
      ok(collStandalone[event] && collStandalone[event].has(name),
        `collapse: standalone '${name}' preserved as a node entry on ${event}`);
    } else {
      const tableLeaf = (TABLE[event] || []).find(l => l.name === name);
      ok(tableLeaf, `collapse: dispatched '${name}' on ${event} is present in TABLE[${event}]`);
      if (tableLeaf) {
        ok(collDispatch[event] && collDispatch[event].has(tableLeaf.head),
          `collapse: ${event} has a '${tableLeaf.head}' dispatch entry to run '${name}'`);
      }
    }
  }
}

// (2) No NEW node leaf appears in collapsed that wasn't in baseline (standalone set only).
for (const [event, leaves] of Object.entries(collStandalone)) {
  for (const name of leaves) {
    ok(baseLeaves[event] && baseLeaves[event].has(name),
      `collapse: collapsed node entry '${name}' on ${event} existed in baseline`);
    ok(standaloneNames.has(name),
      `collapse: collapsed standalone '${name}' is in the STANDALONE allowlist`);
  }
}

// (3) Dispatch-entry heads match TABLE: a sync/async entry exists iff TABLE has that head.
for (const [event, leaves] of Object.entries(TABLE)) {
  const hasSync = leaves.some(l => l.head === 'sync');
  const hasAsync = leaves.some(l => l.head === 'async');
  if (hasSync) ok(collDispatch[event] && collDispatch[event].has('sync'), `collapse: ${event} needs a sync dispatch entry`);
  if (hasAsync) ok(collDispatch[event] && collDispatch[event].has('async'), `collapse: ${event} needs an async dispatch entry`);
  // and no spurious head
  for (const head of (collDispatch[event] || [])) {
    ok(leaves.some(l => l.head === head), `collapse: ${event} '${head}' dispatch entry is backed by TABLE leaves`);
  }
}

// (4) SessionStart is NEVER dispatched (its trio + powershell stay standalone).
ok(!(collDispatch.SessionStart && collDispatch.SessionStart.size),
  'collapse: SessionStart has NO dispatch entry (ruling C — dispatcher stays out of the boot path)');

// (5) The 1 powershell echo survives.
let ps = 0;
for (const blocks of Object.values(collapsed.hooks)) for (const b of blocks) for (const h of (b.hooks || [])) if (h.command === 'powershell') ps++;
ok(ps === 1, `collapse: the 1 powershell SessionStart echo is preserved (found ${ps})`);

if (fails.length) {
  console.error(`collapse-validate: FAIL (${fails.length})`);
  for (const f of fails) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`collapse-validate: PASS (${passed} assertions) — ${collapsedPath} fires the same leaf set as ${path.basename(baselinePath)}`);

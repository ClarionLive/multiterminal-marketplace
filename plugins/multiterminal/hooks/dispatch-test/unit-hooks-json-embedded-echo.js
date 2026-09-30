#!/usr/bin/env node
/**
 * Unit test: the SessionStart PowerShell echo in hooks.json ("PARALLEL SUBAGENTS: ...") prints only
 * for an MT pane, never for a ClarionAssistant tab (ticket 9a731cda, item 6).
 *
 * Not a text census of the condition: the command and args are read from hooks.json and EXECUTED
 * under each environment, and the printed output is what is asserted. The condition is also checked
 * row-by-row against embedded-session.isClarionEmbedded(), so the PowerShell spelling and the JS
 * predicate cannot drift apart (e.g. on "0", which a bare `-not $env:X` would treat as embedded).
 *
 * Runs the entry's own `command` (powershell). If that is missing it falls back to pwsh and says
 * so; if neither exists it prints SKIPPED in its summary line rather than passing silently.
 *
 * FALSIFIED 2026-09-29 against powershell (anchor asserted once, green before, edit, red, restore,
 * green), two edits to the hooks.json condition:
 *   - reverted to `if ($env:MULTITERMINAL_NAME) {` -> red at the CLARION_ASSISTANT_EMBEDDED="1" row.
 *   - the naive `-and -not $env:CLARION_ASSISTANT_EMBEDDED` -> red at the "0" row (prints nothing
 *     where the JS predicate says not embedded) — the drift this parity check exists for.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { isClarionEmbedded } = require('../embedded-session.js');

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed++; }

const MARKER = 'PARALLEL SUBAGENTS';
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'hooks.json'), 'utf8'));
const entries = [];
for (const block of cfg.hooks.SessionStart || []) {
  for (const h of block.hooks || []) {
    if (h.command !== 'node' && (h.args || []).join(' ').includes(MARKER)) entries.push({ block, h });
  }
}
ok(entries.length === 1, `exactly one non-node SessionStart entry prints "${MARKER}" (got ${entries.length})`);
const { block, h } = entries[0];
ok(block.matcher === 'startup|resume|clear', 'matcher unchanged (startup|resume|clear)');

function available(cmd) {
  const r = spawnSync(cmd, ['-NoProfile', '-Command', 'exit 0'], { encoding: 'utf8' });
  return !r.error && r.status === 0;
}
let shell = h.command;
let note = '';
if (!available(shell)) {
  if (available('pwsh')) { note = ` (fell back from ${shell} to pwsh)`; shell = 'pwsh'; } else { shell = null; }
}
if (!shell) {
  console.log(`hooks.json CA echo: SKIPPED — neither ${h.command} nor pwsh is available (${passed} structural assertions only)`);
  process.exit(0);
}

// Environment with every MT / CA variable removed, then the case's own values set. The ambient env
// of whoever runs this suite (often an MT pane) must not leak into the case.
function caseEnv(vars) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^MULTITERMINAL_/i.test(k) || /^CLARION_/i.test(k)) continue;
    env[k] = v;
  }
  return Object.assign(env, vars);
}
function run(vars) {
  const r = spawnSync(shell, h.args, { env: caseEnv(vars), encoding: 'utf8', timeout: 20000 });
  assert.ok(!r.error, `spawn ${shell} failed: ${r.error}`);
  return { status: r.status, out: r.stdout || '', err: r.stderr || '' };
}

const CA_VALUES = [undefined, '', '1', 'true', 'yes', '0', 'false', 'FALSE', ' 0 '];
for (const value of CA_VALUES) {
  const vars = { MULTITERMINAL_NAME: 'CA-test' };
  if (value !== undefined) vars.CLARION_ASSISTANT_EMBEDDED = value;
  const expectPrint = !isClarionEmbedded(vars);
  const r = run(vars);
  ok(r.status === 0, `CLARION_ASSISTANT_EMBEDDED=${JSON.stringify(value)}: exit 0 (stderr: ${r.err.trim()})`);
  if (expectPrint) {
    ok(r.out.includes(MARKER), `NAME set, CLARION_ASSISTANT_EMBEDDED=${JSON.stringify(value)} (not embedded): prints "${MARKER}"`);
  } else {
    ok(r.out.trim() === '', `NAME set, CLARION_ASSISTANT_EMBEDDED=${JSON.stringify(value)} (embedded): prints nothing (got ${JSON.stringify(r.out.slice(0, 60))})`);
  }
}
// Unchanged half of the condition: no MULTITERMINAL_NAME -> nothing, embedded or not.
for (const value of [undefined, '1']) {
  const vars = value === undefined ? {} : { CLARION_ASSISTANT_EMBEDDED: value };
  ok(run(vars).out.trim() === '', `MULTITERMINAL_NAME unset, CLARION_ASSISTANT_EMBEDDED=${JSON.stringify(value)}: prints nothing`);
}

console.log(`hooks.json CA echo (${shell}${note}): PASS (${passed} assertions)`);

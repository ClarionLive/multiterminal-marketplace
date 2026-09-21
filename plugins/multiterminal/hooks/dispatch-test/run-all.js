#!/usr/bin/env node
/**
 * Runs every unit-*.js in this directory and fails if any of them does (ticket 0ff1b520, item 3).
 *
 * WHY THIS EXISTS. There were seventeen unit-*.js files here and no single command that ran
 * them, so in practice they ran when somebody remembered. Item 3 requires that a credential's
 * non-logging be "asserted by a test — 'we were careful' is not a control", and a test nobody
 * executes is exactly the kind of control that phrase rejects. The assertion and the gate are
 * different things; this file is the gate.
 *
 * (Count measured, not estimated: 17 before this ticket added unit-messaging-credentials.js,
 * 18 after, 330 assertions total on the first full run. Re-measure rather than quoting this —
 * the whole point of a runner is that the number changes without anyone updating a comment.)
 *
 * Each test is a standalone script run in its own process, which is how they were already
 * written: they print a PASS line and exit non-zero on failure. Nothing about them changed.
 *
 * DELIBERATELY NOT a test framework. These files use node:assert and no dependencies, this
 * repo has no package.json, and the plugin ships to users' machines — adding a dependency tree
 * to run twenty asserts would cost more than it buys.
 *
 * dispatch.test.js is excluded: it is the older integration suite with its own entry point,
 * not a unit-*.js. Run it separately.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const tests = fs.readdirSync(dir)
  .filter((f) => f.startsWith('unit-') && f.endsWith('.js'))
  .sort();

if (tests.length === 0) {
  // A glob that matches nothing must fail loudly. Reporting "0 failures" here would be a green
  // tick over an empty set — the vacuous-pass shape this repo's sibling rules warn about.
  console.error('run-all: no unit-*.js tests found — refusing to report success over an empty set');
  process.exit(1);
}

const failures = [];
for (const test of tests) {
  const result = spawnSync(process.execPath, [path.join(dir, test)], { encoding: 'utf8' });
  const ok = result.status === 0;
  if (ok) {
    const summary = (result.stdout || '').trim().split('\n').pop() || 'PASS';
    console.log(`  ok   ${test} — ${summary}`);
  } else {
    failures.push(test);
    console.log(`  FAIL ${test} (exit ${result.status})`);
    const detail = ((result.stdout || '') + (result.stderr || '')).trim();
    if (detail) {
      console.log(detail.split('\n').map((l) => `       ${l}`).join('\n'));
    }
  }
}

console.log('');
if (failures.length > 0) {
  console.error(`run-all: ${failures.length} of ${tests.length} failed: ${failures.join(', ')}`);
  process.exit(1);
}
console.log(`run-all: all ${tests.length} unit tests passed`);

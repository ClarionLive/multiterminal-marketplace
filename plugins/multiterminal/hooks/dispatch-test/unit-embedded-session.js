#!/usr/bin/env node
/**
 * Unit test for embedded-session.isClarionEmbedded() (ticket 9a731cda, item 6).
 *
 * The predicate decides whether a session is a ClarionAssistant tab, and every CA gate in the
 * plugin (dispatcher allowlist, project-context, session-compact, session-status) goes through it.
 * The hooks.json PowerShell echo cannot call it, so unit-hooks-json-embedded-echo.js runs that
 * condition under a set of values and checks each result against this predicate.
 *
 * FALSIFIED 2026-09-29: dropping `norm !== '0' &&` from the predicate -> red at the "0" row.
 *
 * "0" is the row that matters: the inline checks this replaced (`if (process.env.X)`) treated "0"
 * as embedded, because "0" is a non-empty string.
 */
const assert = require('assert');
const { isClarionEmbedded } = require('../embedded-session.js');

let passed = 0;
function check(env, expected, label) {
  assert.strictEqual(isClarionEmbedded(env), expected, label);
  passed++;
}

const TABLE = [
  // [value, expected]
  ['1', true],
  ['true', true],
  ['yes', true],
  ['anything', true],
  ['0', false],
  ['false', false],
  ['FALSE', false],
  ['False', false],
  [' 0 ', false],
  ['', false],
  ['   ', false],
];
for (const [value, expected] of TABLE) {
  check({ CLARION_ASSISTANT_EMBEDDED: value }, expected, `CLARION_ASSISTANT_EMBEDDED=${JSON.stringify(value)} -> ${expected}`);
}

// Absent / non-string values are never embedded — env vars are strings, anything else is not one.
check({}, false, 'unset -> false');
check({ CLARION_ASSISTANT_EMBEDDED: undefined }, false, 'undefined -> false');
check({ CLARION_ASSISTANT_EMBEDDED: 1 }, false, 'number 1 -> false (not an env string)');
check({ CLARION_ASSISTANT_EMBEDDED: true }, false, 'boolean true -> false (not an env string)');
check(null, false, 'null env -> false');
check(undefined, false, 'undefined env -> false');

// The name alone never makes a session embedded — that is the MT-pane case.
check({ MULTITERMINAL_NAME: 'CA-foo' }, false, 'MULTITERMINAL_NAME=CA-* alone -> false (the prefix is not the signal)');

console.log(`isClarionEmbedded truth table: PASS (${passed} assertions)`);

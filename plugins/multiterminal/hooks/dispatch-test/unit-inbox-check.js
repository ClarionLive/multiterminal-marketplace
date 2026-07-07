#!/usr/bin/env node
/**
 * Unit test for inbox-check-hook.run() (ticket 42c91001).
 *
 * WHY A UNIT TEST INSTEAD OF THE SPAWN-EQUIVALENCE HARNESS: inbox-check's
 * decision path READS AND DELETES the inbox file (unlinkSync). Running it twice
 * back-to-back (as the equivalence harness does) is non-idempotent — the first
 * run consumes the state the second needs. And we deliberately do NOT aim real
 * side-effects at the running MultiTerminal. So the read/delete/decision core is
 * proven here with an in-memory fs stub (zero live effect); the CLI-shim wrapper
 * contract is proven separately by the equivalence harness on the idempotent
 * (no-name / no-file) branches.
 */
const assert = require('assert');
const { run } = require('../inbox-check-hook.js');

function stubFs(content) {
  let present = content !== null;
  return {
    existsSync: () => present,
    readFileSync: () => content,
    unlinkSync: () => { present = false; },
  };
}

const inbox = JSON.stringify([
  { sender: 'Bob', content: 'build is green' },
  { Sender: 'Grace', Content: 'ping me back' },
]);

// Stop → {decision:'block'} with all messages in reason.
const r1 = run({}, { hookType: 'Stop', name: 'Tester', inboxPath: 'mem', fs: stubFs(inbox) });
assert.strictEqual(r1.exitCode, 0, 'Stop exitCode 0');
const o1 = JSON.parse(r1.stdout);
assert.strictEqual(o1.decision, 'block', 'Stop → decision block');
assert.ok(o1.reason.includes('[Bob]: build is green'), 'reason has Bob');
assert.ok(o1.reason.includes('[Grace]: ping me back'), 'reason has Grace (Sender/Content casing)');

// SubagentStop → also decision:block.
const r2 = run({}, { hookType: 'SubagentStop', name: 'Tester', inboxPath: 'mem', fs: stubFs(inbox) });
assert.strictEqual(JSON.parse(r2.stdout).decision, 'block', 'SubagentStop → block');

// PostToolUse → plain text context (NOT a decision JSON).
const r3 = run({}, { hookType: 'PostToolUse', name: 'Tester', inboxPath: 'mem', fs: stubFs(inbox) });
assert.ok(!r3.stdout.trim().startsWith('{'), 'PostToolUse → plain text, not JSON');
assert.ok(r3.stdout.includes('[Bob]: build is green'), 'plain text has messages');

// No inbox file → exit 0, no output.
const r4 = run({}, { hookType: 'Stop', name: 'Tester', inboxPath: 'mem', fs: stubFs(null) });
assert.strictEqual(r4.exitCode, 0);
assert.strictEqual(r4.stdout, undefined, 'no file → no stdout');

// No name → exit 0, no output.
const r5 = run({}, { hookType: 'Stop', name: '', fs: stubFs(inbox) });
assert.strictEqual(r5.stdout, undefined, 'no name → no stdout');

// Empty message array → exit 0, no output.
const r6 = run({}, { hookType: 'Stop', name: 'Tester', inboxPath: 'mem', fs: stubFs('[]') });
assert.strictEqual(r6.stdout, undefined, 'empty inbox → no stdout');

console.log('inbox-check run() unit: PASS (6 assertions)');

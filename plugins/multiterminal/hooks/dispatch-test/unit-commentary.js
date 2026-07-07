#!/usr/bin/env node
/**
 * Unit test for commentary-hook.run() (ticket 42c91001).
 * commentary sends events to the Commentator over HTTP to the running MT; proven
 * here with stub getTerminals + spy sendMessage — zero live HTTP. (The module-level
 * 3s rate-limit means only the first interesting event sends within one process, so
 * this asserts one representative send + the guard branches; the equivalence harness
 * covers the wrapper on non-HTTP branches.)
 */
process.env.MULTITERMINAL_NAME = 'Henry';
const assert = require('assert');
const { run } = require('../commentary-hook.js');

const stubTerminals = () => Promise.resolve([{ name: 'Commentator', id: 'c1' }, { name: 'Henry', id: 'h1' }]);

async function main() {
  let sent = null;
  const sendSpy = (fromId, to, msg) => { sent = { fromId, to, msg }; return Promise.resolve(true); };

  // Edit → file_change event, sent to Commentator from the sender's terminal id.
  await run({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: '/a/b.cs' } },
    { getTerminals: stubTerminals, sendMessage: sendSpy });
  assert.ok(sent, 'Edit → a message is sent');
  assert.strictEqual(sent.to, 'Commentator', 'sent to Commentator');
  assert.strictEqual(sent.fromId, 'h1', 'fromId resolved to sender terminal');
  const ev = JSON.parse(sent.msg);
  assert.strictEqual(ev.type, 'file_change', 'Edit → file_change');
  assert.strictEqual(ev.file, 'b.cs', 'file basename extracted');

  // Non-interesting tool (Read) → no event, no send.
  sent = null;
  await run({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: {} },
    { getTerminals: stubTerminals, sendMessage: sendSpy });
  assert.strictEqual(sent, null, 'Read → no send');

  // From the Commentator itself → skip (no self-commentary).
  process.env.MULTITERMINAL_NAME = 'Commentator';
  sent = null;
  await run({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: '/x' } },
    { getTerminals: stubTerminals, sendMessage: sendSpy });
  assert.strictEqual(sent, null, 'Commentator self → no send');
  process.env.MULTITERMINAL_NAME = 'Henry';

  const r = await run({ hook_event_name: 'PostToolUse', tool_name: 'Read' }, { getTerminals: stubTerminals, sendMessage: sendSpy });
  assert.strictEqual(r.exitCode, 0, 'returns exitCode 0');

  console.log('commentary run() unit: PASS (7 assertions)');
}

main().catch((e) => { console.error(e); process.exit(1); });

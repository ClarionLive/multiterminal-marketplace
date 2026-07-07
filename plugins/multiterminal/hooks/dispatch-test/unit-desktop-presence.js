#!/usr/bin/env node
/**
 * Unit test for desktop-presence-hook.run() (ticket 42c91001).
 * Proves the presence-flip decision (post remote-mode off on a real desktop prompt,
 * skip for channel-injected phone prompts) with a spy postRemoteModeOff — never hits
 * :5050. The equivalence harness covers the raw-stdin CLI shim on channel-injected
 * branches (which don't post).
 */
const assert = require('assert');
const { run } = require('../desktop-presence-hook.js');

async function main() {
  let posted = 0;
  const postSpy = () => { posted++; return Promise.resolve(); };

  // Real desktop prompt → flip remote-mode off.
  await run({ prompt: 'please refactor the widget' }, { postRemoteModeOff: postSpy });
  assert.strictEqual(posted, 1, 'desktop prompt → post');

  // Channel-injected (phone) prompt → skip the flip.
  await run({ prompt: '<channel source="plugin:multiterminal:multiterminal-channel" from="Alice">status?</channel>' },
    { postRemoteModeOff: postSpy });
  assert.strictEqual(posted, 1, 'channel-injected → NO post');

  // Empty/absent prompt → treated as desktop → post.
  await run({}, { postRemoteModeOff: postSpy });
  assert.strictEqual(posted, 2, 'empty prompt → post');

  const r = await run({ prompt: 'x' }, { postRemoteModeOff: postSpy });
  assert.strictEqual(r.exitCode, 0, 'returns exitCode 0');

  console.log('desktop-presence run() unit: PASS (4 assertions)');
}

main().catch((e) => { console.error(e); process.exit(1); });

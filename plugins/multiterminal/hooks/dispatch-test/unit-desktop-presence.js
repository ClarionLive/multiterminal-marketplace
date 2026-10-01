#!/usr/bin/env node
/**
 * Unit test for desktop-presence-hook.run() (ticket 42c91001).
 * Proves the presence-flip decision (post remote-mode off on a real desktop prompt,
 * skip for MT-injected phone prompts) with a spy postRemoteModeOff — never hits
 * :5050. The equivalence harness covers the raw-stdin CLI shim on the injected
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

  // Empty/absent prompt → treated as desktop → post.
  await run({}, { postRemoteModeOff: postSpy });
  assert.strictEqual(posted, 2, 'empty prompt → post');

  const r = await run({ prompt: 'x' }, { postRemoteModeOff: postSpy });
  assert.strictEqual(r.exitCode, 0, 'returns exitCode 0');

  // ── Native session injection (ticket 0ff1b520 item 4) ──────────────────
  //
  // These exist because this file's assertions were all green throughout a
  // real, live failure. Item 4 moved messages onto a named pipe, where they
  // arrive with no tag, and this file only ever tested the retired channel
  // server's <channel> tag — so a phone message looked exactly like keyboard
  // input, the hook flipped remote mode off on the very message that had just
  // armed it, and the Owner's reply silently never left the desktop. A passing
  // suite said nothing about it.
  //
  // Falsified before being trusted (re-run when the channel alternative was
  // dropped from the marker): the old channel-only marker fails the first of the
  // next two assertions, and the native marker without its `m` flag passes that
  // one and fails the second. The unchanged marker passes all six.
  await run({ prompt: '[MultiTerminal message from MultiRemote]\n\nHi this is from my phone!' },
    { postRemoteModeOff: postSpy });
  assert.strictEqual(posted, 3, 'native-injected → NO post');

  // The harness prepends its own framing line, so the wrapper is NOT always at
  // offset 0. Pinned separately because a marker anchored with /^...$/ and no
  // `m` flag passes the assertion above and fails this one — which is the real
  // delivery shape.
  await run({ prompt: 'Another Claude session sent a message:\n[MultiTerminal message from MultiRemote]\n\nHi' },
    { postRemoteModeOff: postSpy });
  assert.strictEqual(posted, 3, 'native-injected behind harness framing → NO post');

  // MT ticket eb585e6e: the header now names the recipient too ("from X to Y"),
  // so a session learns its own name from what it receives. The marker matches
  // the unchanged prefix only; this pins that the new shape is still recognised.
  await run({ prompt: 'Another Claude session sent a message:\n[MultiTerminal message from Alice to CA-Terminal-1-CC-2]\n\nHi' },
    { postRemoteModeOff: postSpy });
  assert.strictEqual(posted, 3, 'native-injected with a recipient in the header → NO post');

  // Guards the other direction: the fix must not make the hook inert. A marker
  // broad enough to swallow ordinary typing would leave every assertion above
  // green while remote mode simply never switched off again.
  await run({ prompt: 'can you check the MultiTerminal message from earlier?' },
    { postRemoteModeOff: postSpy });
  assert.strictEqual(posted, 4, 'prose merely MENTIONING the wrapper is still desktop typing');

  console.log('desktop-presence run() unit: PASS (7 assertions)');
}

main().catch((e) => { console.error(e); process.exit(1); });

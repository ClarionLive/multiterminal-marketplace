#!/usr/bin/env node
/**
 * Unit test for the shared-placeholder guard in session-status-hook (ticket 0ff1b520, item 13).
 *
 * THE DEFECT, found live 2026-09-29: two unnamed panes both launched as MULTITERMINAL_NAME=
 * "Unassigned". One claimed "Probe" via register_terminal and later quit. Its SessionEnd hook
 * posted disconnect("Unassigned"), the broker resolved that to the FIRST "Unassigned" row, and the
 * OTHER pane's live row was torn down (with its credentials, since item 14). SessionStart had the
 * mirror problem: both panes posted credentials under the one key, the last one winning.
 *
 * Asserted BEHAVIOURALLY, by driving the exported functions with stubbed I/O and recording what
 * they tried to send — not by scanning the source, which a comment naming the guard would satisfy.
 *
 * FALSIFIED 2026-09-29, both halves: each guard's `if (isSharedPlaceholderName(terminalName)) {` was
 * replaced by `if (false) {` in turn. That condition text occurs in both functions, so each edit was
 * anchored on it PLUS the guard's own dtrace line ('SessionEnd:' / 'STEP 3c: launch name'), and that
 * pattern was asserted to match exactly once. SessionEnd off -> red at 'SessionEnd "Unassigned" ->
 * skipped'; SessionStart off -> red at 'SessionStart "Unassigned" -> skipped'; restored -> green. The
 * run stops at its first failure, so this shows each guard is caught, not that no other assertion moved.
 *
 * WHAT THIS DOES NOT COVER (pipeline run 1, adversary): it drives the exported functions, not main().
 * Reverting main()'s SessionStart/SessionEnd branches to inline POSTs, or dropping the calls, would stay
 * green here. Pinning that needs the hook run as a child process against a stub server, which needs an
 * injectable API port; the hook hard-codes localhost:5050, which is the live app.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  isSharedPlaceholderName,
  releaseOnSessionEnd,
  postSessionStartCredentials,
} = require('../session-status-hook.js');

const SENTINEL = 'SENTINELtokenDOTnotLOG0123456789abcdef';
const GOOD_SOCKET = '\\\\.\\pipe\\LOCAL\\cc-msg-' + 'a'.repeat(32);
const GOOD_ENV = { CLAUDE_CODE_MESSAGING_SOCKET: GOOD_SOCKET, CLAUDE_CODE_MESSAGING_TOKEN: SENTINEL };
const DTRACE_PATH = path.join(os.tmpdir(), 'mt-session-hook-debug.log');

let passed = 0;
function check(actual, expected, label) {
  assert.deepStrictEqual(actual, expected, label);
  passed++;
}

// Records every call a stub receives, so "was never called" is an assertion, not an assumption.
function recorder(result) {
  const calls = [];
  const fn = (...args) => {
    calls.push(args);
    if (result instanceof Error) throw result;
    return result;
  };
  fn.calls = calls;
  return fn;
}

(async () => {
  // ── 1. The predicate ─────────────────────────────────────────────────────────────────────────
  // Case-insensitive like the broker's OrdinalIgnoreCase keys; NOT trimmed, because the broker
  // does not trim either — a predicate more permissive than the lookup it guards is its own bug.
  for (const name of ['Unassigned', 'unassigned', 'UNASSIGNED']) {
    check(isSharedPlaceholderName(name), true, `"${name}" is the shared placeholder`);
  }
  for (const name of ['Probe', 'Alice', 'Unassigned2', ' Unassigned', 'Unassigned ', '', null, undefined, 42]) {
    check(isSharedPlaceholderName(name), false, `${JSON.stringify(name)} is not the placeholder`);
  }

  // ── 2. SessionEnd: never disconnect the placeholder by name ─────────────────────────────────
  for (const name of ['Unassigned', 'unassigned']) {
    const post = recorder(true);
    const offline = recorder(undefined);
    const r = await releaseOnSessionEnd(name, { postDisconnect: post, markOffline: offline });
    check(r, 'skipped-placeholder', `SessionEnd "${name}" -> skipped`);
    check(post.calls.length, 0, `SessionEnd "${name}" -> no disconnect POST (would hit another pane's row)`);
    check(offline.calls.length, 0, `SessionEnd "${name}" -> no fallback profile write either`);
  }

  // A real name still disconnects — the guard must not swallow the normal path.
  {
    const post = recorder(true);
    const offline = recorder(undefined);
    check(await releaseOnSessionEnd('Alice', { postDisconnect: post, markOffline: offline }), 'disconnected', 'SessionEnd "Alice" -> disconnected');
    check(post.calls, [['Alice']], 'SessionEnd "Alice" -> exactly one disconnect POST, for Alice');
    check(offline.calls.length, 0, 'SessionEnd "Alice", API ok -> no fallback');
  }
  // API down -> the existing DB fallback, unchanged.
  {
    const post = recorder(false);
    const offline = recorder(undefined);
    check(await releaseOnSessionEnd('Alice', { postDisconnect: post, markOffline: offline }), 'fallback', 'SessionEnd "Alice", API refused -> fallback');
    check(offline.calls, [['Alice']], 'fallback marks Alice offline');
  }
  {
    const post = recorder(new Error('boom'));
    const offline = recorder(undefined);
    check(await releaseOnSessionEnd('Alice', { postDisconnect: post, markOffline: offline }), 'fallback', 'SessionEnd "Alice", POST throws -> fallback, not a crash');
    check(offline.calls, [['Alice']], 'throwing POST still falls back');
  }

  // ── 3. SessionStart: never post credentials under the placeholder ───────────────────────────
  const dtraceBefore = fs.existsSync(DTRACE_PATH) ? fs.statSync(DTRACE_PATH).size : 0;
  const captured = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk, ...rest) => { captured.push(String(chunk)); return realOut(chunk, ...rest); };
  process.stderr.write = (chunk, ...rest) => { captured.push(String(chunk)); return realErr(chunk, ...rest); };
  try {
    for (const name of ['Unassigned', 'UNASSIGNED']) {
      const post = recorder(true);
      check(await postSessionStartCredentials(name, 'sid', GOOD_ENV, { postCredentials: post }), 'skipped-placeholder', `SessionStart "${name}" -> skipped`);
      check(post.calls.length, 0, `SessionStart "${name}" -> no credential POST (panes would overwrite each other)`);
    }
    {
      const post = recorder(true);
      check(await postSessionStartCredentials('Alice', 'sid', GOOD_ENV, { postCredentials: post }), 'posted', 'SessionStart "Alice" -> posted');
      check(post.calls, [['Alice', 'sid', { socket: GOOD_SOCKET, token: SENTINEL }]], 'SessionStart "Alice" -> one POST, under Alice, with the env credentials');
    }
    {
      const post = recorder(false);
      check(await postSessionStartCredentials('Alice', 'sid', GOOD_ENV, { postCredentials: post }), 'post-failed', 'SessionStart "Alice", broker refused -> post-failed');
    }
    {
      const post = recorder(true);
      check(await postSessionStartCredentials('Alice', 'sid', {}, { postCredentials: post }), 'no-credentials', 'SessionStart "Alice", no env -> no-credentials');
      check(post.calls.length, 0, 'no credentials -> no POST');
    }
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }

  // The accept path writes a length-only trace line; the token must be in neither stream nor log.
  assert.ok(!captured.join('').includes(SENTINEL), 'SECRECY VIOLATION: sentinel token reached stdout/stderr');
  passed++;
  let dtraceDelta = '';
  if (fs.existsSync(DTRACE_PATH)) {
    const size = fs.statSync(DTRACE_PATH).size;
    if (size > dtraceBefore) {
      const fd = fs.openSync(DTRACE_PATH, 'r');
      try {
        const buf = Buffer.alloc(size - dtraceBefore);
        fs.readSync(fd, buf, 0, buf.length, dtraceBefore);
        dtraceDelta = buf.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    }
  }
  assert.ok(!dtraceDelta.includes(SENTINEL), 'SECRECY VIOLATION: sentinel token reached the dtrace log');
  passed++;
  // Not vacuous: the accept path's trace line must actually be there.
  assert.ok(dtraceDelta.includes('messaging credentials present'), 'expected the accept-path trace line — the secrecy check above would be vacuous');
  passed++;

  console.log(`session-status placeholder guard unit: PASS (${passed} assertions)`);
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});

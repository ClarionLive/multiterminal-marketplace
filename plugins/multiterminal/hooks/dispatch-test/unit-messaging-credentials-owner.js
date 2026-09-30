#!/usr/bin/env node
/**
 * Unit test: the SessionStart credential POST carries nonce + ownerPid (ticket 9a731cda hardening).
 *
 * MT rejects a PRESENT-but-wrong launch nonce and requires an ownerPid for pid-owned rows, so the
 * body of POST /api/messaging/credentials carries:
 *   - nonce    = MULTITERMINAL_LAUNCH_NONCE, only when set;
 *   - ownerPid = the hook's process.ppid (claude.exe for args-form hooks, per the 2026-09-29 spike).
 *
 * Driven end-to-end through the REAL postSessionStartCredentials -> postMessagingCredentials path:
 * `http.request` is replaced in-process by a fake that captures the written body and answers 200
 * without opening a socket. The network tripwire is loaded first, so every OTHER way out
 * (net/tls/https/fetch) throws — nothing can reach the live MT on :5050.
 *
 * Secrecy (extends unit-messaging-credentials.js): both the token and the nonce are sentinels, and
 * neither may appear on stdout, stderr or in the dtrace log delta; the dtrace delta must contain
 * the accept-path line, so that check is not vacuous.
 *
 * FALSIFIED 2026-09-29 (anchor asserted once, green before, edit, red, restore, green):
 *   - `if (owner && owner.nonce) body.nonce = owner.nonce;` deleted -> red at 'body carries nonce + ownerPid'.
 *   - postSessionStartCredentials calling post() without `owner` -> red at 'wire body carries the launch nonce'.
 *   - the dtrace line changed to print the nonce value -> red at 'SECRECY: nonce not in dtrace log'.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
require('./_net-tripwire.js');
const http = require('http');

const {
  credentialOwner,
  credentialsBody,
  postSessionStartCredentials,
} = require('../session-status-hook.js');

let passed = 0;
function check(actual, expected, label) { assert.deepStrictEqual(actual, expected, label); passed++; }
function ok(cond, msg) { assert.ok(cond, msg); passed++; }

const TOKEN = 'SENTINELtokenDOTnotLOG0123456789abcdef';
const NONCE = 'SENTINELnonceDOTnotLOGfedcba9876543210';
const GOOD_SOCKET = '\\\\.\\pipe\\LOCAL\\cc-msg-' + 'a'.repeat(32);
const CREDS_ENV = { CLAUDE_CODE_MESSAGING_SOCKET: GOOD_SOCKET, CLAUDE_CODE_MESSAGING_TOKEN: TOKEN };
const DTRACE_PATH = path.join(os.tmpdir(), 'mt-session-hook-debug.log');

// Fake http.request: records options + body, answers 200, never connects.
const sent = [];
http.request = (options, onResponse) => {
  const chunks = [];
  const handlers = {};
  return {
    on: (ev, fn) => { handlers[ev] = fn; },
    write: (d) => { chunks.push(String(d)); },
    destroy: () => {},
    end: () => {
      sent.push({ options, body: chunks.join('') });
      const res = { statusCode: 200, on: (ev, fn) => { if (ev === 'end') setImmediate(fn); } };
      setImmediate(() => onResponse(res));
    },
  };
};

(async () => {
  // ── 1. credentialOwner ───────────────────────────────────────────────────────────────────────
  check(credentialOwner({ MULTITERMINAL_LAUNCH_NONCE: NONCE }, 4242), { nonce: NONCE, ownerPid: 4242 }, 'nonce + pid');
  check(credentialOwner({}, 4242), { ownerPid: 4242 }, 'no nonce in env -> omitted (not sent empty)');
  check(credentialOwner({ MULTITERMINAL_LAUNCH_NONCE: '' }, 4242), { ownerPid: 4242 }, 'empty nonce -> omitted');
  check(credentialOwner({ MULTITERMINAL_LAUNCH_NONCE: NONCE }, 0), { nonce: NONCE }, 'pid 0 -> no ownerPid');
  check(credentialOwner(null, undefined), {}, 'nothing -> {}');

  // ── 2. credentialsBody ───────────────────────────────────────────────────────────────────────
  const creds = { socket: GOOD_SOCKET, token: TOKEN };
  check(credentialsBody('Alice', 'sid', creds, { nonce: NONCE, ownerPid: 4242 }),
    { name: 'Alice', sessionId: 'sid', socket: GOOD_SOCKET, token: TOKEN, nonce: NONCE, ownerPid: 4242 }, 'body carries nonce + ownerPid');
  check(credentialsBody('Alice', undefined, creds, undefined),
    { name: 'Alice', sessionId: '', socket: GOOD_SOCKET, token: TOKEN }, 'no owner -> the pre-9a731cda body, unchanged');

  // ── 3. End to end through the real poster (default ownerPid = process.ppid) ─────────────────
  const dtraceBefore = fs.existsSync(DTRACE_PATH) ? fs.statSync(DTRACE_PATH).size : 0;
  const captured = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (c, ...r) => { captured.push(String(c)); return realOut(c, ...r); };
  process.stderr.write = (c, ...r) => { captured.push(String(c)); return realErr(c, ...r); };
  let withNonce;
  let withoutNonce;
  try {
    withNonce = await postSessionStartCredentials('Alice', 'sid-1', { ...CREDS_ENV, MULTITERMINAL_LAUNCH_NONCE: NONCE });
    withoutNonce = await postSessionStartCredentials('Bob', 'sid-2', CREDS_ENV);
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
  check(withNonce, 'posted', 'MT pane with nonce -> posted');
  check(withoutNonce, 'posted', 'MT pane without nonce -> posted');
  check(sent.length, 2, 'exactly two POSTs went to the (fake) transport');
  check(sent[0].options.path, '/api/messaging/credentials', 'POST path');
  const b0 = JSON.parse(sent[0].body);
  const b1 = JSON.parse(sent[1].body);
  check(b0.nonce, NONCE, 'wire body carries the launch nonce');
  check(b0.ownerPid, process.ppid, 'wire body ownerPid == process.ppid (the default)');
  ok(Number.isInteger(b0.ownerPid) && b0.ownerPid > 0, 'ownerPid is a positive integer');
  check(b0.token, TOKEN, 'wire body still carries the token (it is the payload)');
  ok(!('nonce' in b1), 'no nonce in env -> no nonce key on the wire');
  check(b1.ownerPid, process.ppid, 'no-nonce POST still carries ownerPid');

  // ── 4. Secrecy: neither sentinel in stdout/stderr/dtrace ─────────────────────────────────────
  const out = captured.join('');
  ok(!out.includes(TOKEN), 'SECRECY: token not on stdout/stderr');
  ok(!out.includes(NONCE), 'SECRECY: nonce not on stdout/stderr');
  let delta = '';
  if (fs.existsSync(DTRACE_PATH)) {
    const size = fs.statSync(DTRACE_PATH).size;
    if (size > dtraceBefore) {
      const fd = fs.openSync(DTRACE_PATH, 'r');
      try {
        const buf = Buffer.alloc(size - dtraceBefore);
        fs.readSync(fd, buf, 0, buf.length, dtraceBefore);
        delta = buf.toString('utf8');
      } finally { fs.closeSync(fd); }
    }
  }
  ok(delta.includes('messaging credentials present') && delta.includes('nonce=present'), 'dtrace has the accept-path line (secrecy checks are not vacuous)');
  ok(!delta.includes(TOKEN), 'SECRECY: token not in dtrace log');
  ok(!delta.includes(NONCE), 'SECRECY: nonce not in dtrace log');

  console.log(`messaging credentials owner unit: PASS (${passed} assertions)`);
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});

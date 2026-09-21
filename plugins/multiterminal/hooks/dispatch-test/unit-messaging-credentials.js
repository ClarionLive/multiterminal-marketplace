#!/usr/bin/env node
/**
 * Unit test for session-status-hook.messagingCredentials() (ticket 0ff1b520, item 3).
 *
 * Two things are under test and they are not the same kind of claim:
 *
 *   1. SHAPE — which environments yield credentials and which are refused. Ordinary assertions.
 *   2. SECRECY — that the token never reaches stdout, stderr or the dtrace log. This is the
 *      claim the ticket cares about ("the non-logging must be asserted by a test — 'we were
 *      careful' is not a control"), and it is asserted BEHAVIOURALLY: a sentinel token is fed
 *      through every path and the captured output is searched for it.
 *
 * Why behavioural and not a source census: a census over this file's text would be satisfied by
 * a comment mentioning the variable, and tripped by a refusal comment naming it — both failure
 * directions are live here, since "never log the token" is exactly the sort of thing a future
 * maintainer writes in a comment. See .claude/rules/verification-discipline.md in the
 * MultiTerminal repo, which records three agents getting that wrong in one day.
 *
 * FALSIFIED, not assumed: adding `console.log(token)` to messagingCredentials makes the secrecy
 * assertions fail (verified by doing it, 2026-09-21). Adding it to a path this test does not
 * drive would NOT be caught — that limit is real and is stated here rather than papered over.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { messagingCredentials } = require('../session-status-hook.js');

// Must satisfy the shape rules so it survives to the ACCEPT path, where secrecy matters most.
const SENTINEL = 'SENTINELtokenDOTnotLOG0123456789abcdef';
const GOOD_SOCKET = '\\\\.\\pipe\\LOCAL\\cc-msg-' + 'a'.repeat(32);
const DTRACE_PATH = path.join(os.tmpdir(), 'mt-session-hook-debug.log');

let passed = 0;
function check(actual, expected, label) {
  assert.deepStrictEqual(actual, expected, label);
  passed++;
}

// ---------------------------------------------------------------------------
// 1. SHAPE
// ---------------------------------------------------------------------------

// The happy path: exactly what the CLI was observed to emit on 2026-09-21.
check(
  messagingCredentials({ CLAUDE_CODE_MESSAGING_SOCKET: GOOD_SOCKET, CLAUDE_CODE_MESSAGING_TOKEN: SENTINEL }),
  { socket: GOOD_SOCKET, token: SENTINEL },
  'well-formed socket + token -> captured'
);

// Absence is the common case (any non-MT shell, an older CLI) and must be quiet, not an error.
check(messagingCredentials({}), null, 'empty env -> null');
check(messagingCredentials({ CLAUDE_CODE_MESSAGING_SOCKET: GOOD_SOCKET }), null, 'socket without token -> null');
check(messagingCredentials({ CLAUDE_CODE_MESSAGING_TOKEN: SENTINEL }), null, 'token without socket -> null');
check(messagingCredentials(null), null, 'null env -> null');
check(messagingCredentials(undefined), null, 'undefined env -> null');
check(messagingCredentials('not an object'), null, 'string env -> null');

// Non-string values must not be coerced. A number that stringifies into something plausible is
// still not a credential the CLI produced.
check(messagingCredentials({ CLAUDE_CODE_MESSAGING_SOCKET: 12345, CLAUDE_CODE_MESSAGING_TOKEN: SENTINEL }), null, 'numeric socket -> null');
check(messagingCredentials({ CLAUDE_CODE_MESSAGING_SOCKET: GOOD_SOCKET, CLAUDE_CODE_MESSAGING_TOKEN: 12345 }), null, 'numeric token -> null');
check(messagingCredentials({ CLAUDE_CODE_MESSAGING_SOCKET: '', CLAUDE_CODE_MESSAGING_TOKEN: SENTINEL }), null, 'empty socket -> null');
check(messagingCredentials({ CLAUDE_CODE_MESSAGING_SOCKET: GOOD_SOCKET, CLAUDE_CODE_MESSAGING_TOKEN: '' }), null, 'empty token -> null');

// Socket shape. The namespace is load-bearing, not decoration: \\.\pipe\LOCAL\ is why broker
// push cannot cross machines at all (item 0's finding). A socket in another namespace is not a
// credential we know how to use, so it is refused rather than attempted.
for (const [socket, label] of [
  ['\\\\.\\pipe\\cc-msg-' + 'a'.repeat(32), 'missing LOCAL namespace'],
  ['\\\\.\\pipe\\LOCAL\\ccmsg-' + 'a'.repeat(32), 'missing cc-msg- prefix'],
  ['\\\\.\\pipe\\LOCAL\\cc-msg-abc', 'hex run too short'],
  ['\\\\.\\pipe\\LOCAL\\cc-msg-' + 'z'.repeat(32), 'non-hex run'],
  ['\\\\other\\pipe\\LOCAL\\cc-msg-' + 'a'.repeat(32), 'remote host namespace'],
  [GOOD_SOCKET + '\n', 'trailing newline'],
  [' ' + GOOD_SOCKET, 'leading space'],
  ['/tmp/cc-msg-' + 'a'.repeat(32), 'posix-looking path'],
]) {
  check(messagingCredentials({ CLAUDE_CODE_MESSAGING_SOCKET: socket, CLAUDE_CODE_MESSAGING_TOKEN: SENTINEL }), null, `socket ${label} -> null`);
}

// Token shape. The alphabet is deliberately NOT pinned (a CLI change to base64url must not fail
// closed and silent), so these cases pin only what is actually required: no whitespace, no
// control characters, plausible length. A newline in a token is the one that matters — it could
// smuggle a second line into the JSON payload, a log line, or the two-line pipe handshake.
for (const [token, label] of [
  [SENTINEL + '\n', 'trailing newline'],
  [SENTINEL + '\nmalicious', 'embedded newline'],
  ['tok en with space 0123456789', 'embedded space'],
  ['short', 'too short'],
  ['a'.repeat(257), 'too long'],
  [SENTINEL + '\t', 'embedded tab'],
  [SENTINEL + '\r', 'embedded carriage return'],
  ['\u0000' + SENTINEL, 'embedded NUL'],
]) {
  check(messagingCredentials({ CLAUDE_CODE_MESSAGING_SOCKET: GOOD_SOCKET, CLAUDE_CODE_MESSAGING_TOKEN: token }), null, `token ${label} -> null`);
}

// Boundaries of the length window, stated explicitly so a future widening is a deliberate edit.
check(
  messagingCredentials({ CLAUDE_CODE_MESSAGING_SOCKET: GOOD_SOCKET, CLAUDE_CODE_MESSAGING_TOKEN: 'a'.repeat(16) }),
  { socket: GOOD_SOCKET, token: 'a'.repeat(16) },
  'token at minimum length -> captured'
);
check(
  messagingCredentials({ CLAUDE_CODE_MESSAGING_SOCKET: GOOD_SOCKET, CLAUDE_CODE_MESSAGING_TOKEN: 'a'.repeat(256) }),
  { socket: GOOD_SOCKET, token: 'a'.repeat(256) },
  'token at maximum length -> captured'
);
check(
  messagingCredentials({ CLAUDE_CODE_MESSAGING_SOCKET: GOOD_SOCKET, CLAUDE_CODE_MESSAGING_TOKEN: 'a'.repeat(15) }),
  null,
  'token one below minimum -> null'
);

// ---------------------------------------------------------------------------
// 2. SECRECY — the assertion the ticket actually demands
// ---------------------------------------------------------------------------
//
// Drive every path again with the sentinel in place, capturing stdout, stderr and the delta
// appended to the dtrace file, then assert the sentinel appears in none of them. Both the
// ACCEPT path (nothing should be emitted at all) and the REFUSE paths (which DO write a dtrace
// line, and must carry length only) are covered.

const dtraceBefore = fs.existsSync(DTRACE_PATH) ? fs.statSync(DTRACE_PATH).size : 0;

const captured = [];
const realOut = process.stdout.write.bind(process.stdout);
const realErr = process.stderr.write.bind(process.stderr);
process.stdout.write = (chunk, ...rest) => { captured.push(String(chunk)); return realOut(chunk, ...rest); };
process.stderr.write = (chunk, ...rest) => { captured.push(String(chunk)); return realErr(chunk, ...rest); };

try {
  // Accept path.
  messagingCredentials({ CLAUDE_CODE_MESSAGING_SOCKET: GOOD_SOCKET, CLAUDE_CODE_MESSAGING_TOKEN: SENTINEL });
  // Refuse-on-token path: this one DOES write a dtrace line, so it is the sharpest case.
  messagingCredentials({ CLAUDE_CODE_MESSAGING_SOCKET: GOOD_SOCKET, CLAUDE_CODE_MESSAGING_TOKEN: SENTINEL + '\n' });
  // Refuse-on-socket path, with the sentinel hidden in the socket rather than the token.
  messagingCredentials({ CLAUDE_CODE_MESSAGING_SOCKET: '\\\\.\\pipe\\WRONG\\' + SENTINEL, CLAUDE_CODE_MESSAGING_TOKEN: SENTINEL });
} finally {
  process.stdout.write = realOut;
  process.stderr.write = realErr;
}

const streamOutput = captured.join('');
assert.ok(!streamOutput.includes(SENTINEL), 'SECRECY VIOLATION: sentinel token reached stdout/stderr');
passed++;

let dtraceDelta = '';
if (fs.existsSync(DTRACE_PATH)) {
  const fd = fs.openSync(DTRACE_PATH, 'r');
  try {
    const size = fs.statSync(DTRACE_PATH).size;
    if (size > dtraceBefore) {
      const buf = Buffer.alloc(size - dtraceBefore);
      fs.readSync(fd, buf, 0, buf.length, dtraceBefore);
      dtraceDelta = buf.toString('utf8');
    }
  } finally {
    fs.closeSync(fd);
  }
}
assert.ok(!dtraceDelta.includes(SENTINEL), 'SECRECY VIOLATION: sentinel token reached the dtrace log');
passed++;

// The refusal lines must actually have been written — otherwise the two assertions above pass
// vacuously against an empty string, which is the failure mode verification-discipline.md calls
// out ("assert the extraction succeeded"). This is what makes the secrecy check meaningful
// rather than merely green.
assert.ok(
  dtraceDelta.includes('shape not recognised'),
  'expected refusal traces were not written — the secrecy assertions above would be vacuous'
);
passed++;

console.log(`session-status messagingCredentials unit: PASS (${passed} assertions)`);

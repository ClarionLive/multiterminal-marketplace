#!/usr/bin/env node
/**
 * Unit test: session-status-hook does NOTHING in a ClarionAssistant tab (ticket 9a731cda, item 7).
 *
 * The early return is correct for CA, not a gap: MT's MCP server posts a CA tab's messaging
 * credentials at its own startup, /clear does not rotate the socket or token, and CA closes a tab
 * by killing claude so MT's ownerPid reaper releases it. A SessionEnd disconnect from this hook
 * would be keyed by NAME, and another IDE can host a same-named CA tab.
 *
 * The early return lives inside main(), which reads stdin, so the hook is run as a CHILD PROCESS:
 *   - NODE_OPTIONS --require _net-tripwire.js, so every outbound connection (the hook hard-codes
 *     localhost:5050 / 127.0.0.1:5050, i.e. the live MT) is recorded to a log file and throws;
 *   - APPDATA pointed at an empty temp dir, so the hook's SQLite writes find no database;
 *   - every MULTITERMINAL_* / CLARION_* / CLAUDE_CODE_MESSAGING_* var of the ambient environment
 *     removed, then the case's own set — well-formed messaging credentials included, so the
 *     credential POST path is live if the guard is gone.
 *
 * Non-vacuity: a CONTROL run with the same environment minus CLARION_ASSISTANT_EMBEDDED must print
 * to stdout AND trip the wire. That proves the instrument can see the hook's HTTP calls; without
 * it, "zero attempts" could mean the tripwire was never installed.
 *
 * FALSIFIED 2026-09-29: `if (isClarionEmbedded(process.env)) return;` deleted from the hook (anchor
 * asserted once, green before, red after, restored, green) -> red at 'embedded SessionStart: NOTHING
 * on stdout'. The run stops there, so the SessionEnd and zero-attempt assertions were not reached in
 * that run; the controls show those assertions CAN fail (control runs do trip the wire).
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed++; }

const HOOK = path.join(__dirname, '..', 'session-status-hook.js');
const TRIPWIRE = path.join(__dirname, '_net-tripwire.js');
const SENTINEL = 'SENTINELtokenDOTnotLOG0123456789abcdef';
const GOOD_SOCKET = '\\\\.\\pipe\\LOCAL\\cc-msg-' + 'a'.repeat(32);

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-9a731cda-'));
const appdata = path.join(work, 'appdata');
fs.mkdirSync(appdata);

function caseEnv(vars, logFile) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^MULTITERMINAL_/i.test(k) || /^CLARION_/i.test(k) || /^CLAUDE_CODE_MESSAGING_/i.test(k) || /^NODE_OPTIONS$/i.test(k)) continue;
    env[k] = v;
  }
  return Object.assign(env, {
    APPDATA: appdata,
    // Forward slashes: NODE_OPTIONS parses backslashes inside quotes as escapes.
    NODE_OPTIONS: `--require "${TRIPWIRE.replace(/\\/g, '/')}"`,
    NET_TRIPWIRE_LOG: logFile,
    MULTITERMINAL_NAME: 'CA-test',
    CLAUDE_CODE_MESSAGING_SOCKET: GOOD_SOCKET,
    CLAUDE_CODE_MESSAGING_TOKEN: SENTINEL,
  }, vars);
}

let n = 0;
function runHook(hookData, vars) {
  const logFile = path.join(work, `tripwire-${++n}.log`);
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(hookData),
    env: caseEnv(vars, logFile),
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.ok(!r.error, `spawn failed: ${r.error}`);
  const trips = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean) : [];
  return { status: r.status, out: r.stdout || '', err: r.stderr || '', trips };
}

const START = { hook_event_name: 'SessionStart', source: 'startup', session_id: 'sid-9a731cda' };
const END = { hook_event_name: 'SessionEnd', reason: 'prompt_input_exit', session_id: 'sid-9a731cda' };

try {
  for (const [label, hookData] of [['SessionStart', START], ['SessionEnd', END]]) {
    const emb = runHook(hookData, { CLARION_ASSISTANT_EMBEDDED: '1' });
    ok(emb.status === 0, `embedded ${label}: exit 0 (status ${emb.status}, stderr: ${emb.err.trim().slice(0, 300)})`);
    ok(emb.out === '', `embedded ${label}: NOTHING on stdout (got ${JSON.stringify(emb.out.slice(0, 80))})`);
    ok(emb.trips.length === 0, `embedded ${label}: NO connection attempted (got ${emb.trips.join('; ')})`);

    const ctl = runHook(hookData, {});
    ok(ctl.out.trim() !== '', `control ${label} (not embedded): prints to stdout — the embedded silence is not the fixture's`);
    ok(ctl.trips.some((t) => /5050/.test(t)), `control ${label}: the tripwire records a :5050 attempt (got ${ctl.trips.join('; ') || 'none'}) — the instrument can see the hook's HTTP`);
    ok(!(ctl.out + ctl.err).includes(SENTINEL), `control ${label}: token not on stdout/stderr`);
  }

  // "0" means not embedded (the old inline truthiness check treated it as embedded).
  {
    const r = runHook(START, { CLARION_ASSISTANT_EMBEDDED: '0' });
    ok(r.trips.length > 0, 'CLARION_ASSISTANT_EMBEDDED=0 SessionStart: runs normally (attempts the credential POST)');
  }
} finally {
  try { fs.rmSync(work, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
}

console.log(`session-status CA early return: PASS (${passed} assertions)`);

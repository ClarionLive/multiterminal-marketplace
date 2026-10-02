#!/usr/bin/env node
/**
 * Unit test: a quiet-start terminal's SessionStart (GitHub #34, task e0fa9d90).
 *
 * MultiTerminal sets MULTITERMINAL_QUIET_START='true' when the project has Quiet start on and the
 * terminal is not a spawned helper. The hook must then print identity and the static behavioral rules
 * (multiterminal-rules.md, kept by PM decision: no tool call, nothing typed) and nothing that churns:
 * no AUTO-RUN of /multiterminal:session-start, no prefetch, no /clear inject request. It still
 * registers the session. Knowledge and kanban injection are skipped too, but this test cannot see
 * that: with no database (empty APPDATA) neither prints in the control run either.
 *
 * Two layers:
 *   - the pure helpers (isQuietStart, quietStartLines, registerQuietSession with a stub request);
 *   - the hook run as a CHILD PROCESS, because the branch lives inside main(), which reads stdin.
 *     As in unit-session-status-embedded.js: NODE_OPTIONS --require _net-tripwire.js records and
 *     blocks every outbound connection (the hook hard-codes the live MT on :5050), APPDATA points at
 *     an empty temp dir so the SQLite writes find no database, and the ambient MULTITERMINAL_* vars
 *     are removed before each case sets its own.
 *
 * Non-vacuity: a CONTROL run with the same environment minus MULTITERMINAL_QUIET_START must print
 * AUTO-RUN and attempt the prefetch. That proves the instrument can see what the quiet run must not do.
 *
 * FALSIFIED 2026-10-02: the hook's `if (isQuietStart(process.env)) {` replaced by `if (false) {`
 * (anchor counted: 1 before, 0 after) -> red at 'quiet: no AUTO-RUN', the first child-process
 * assertion, as predicted; restored -> green. The run stops at the first failure, so the later
 * quiet and quiet-/clear assertions were not individually seen red. Their controls do trip.
 * Second run, same day: the quiet block's printMultiTerminalRules() call removed (calls counted:
 * 2 before, 1 after) -> red at 'quiet: behavioral rules still printed', as predicted; restored -> green.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { isQuietStart, quietStartLines, registerQuietSession } = require('../session-status-hook.js');

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed++; }

const GUID = '5d7853b8-c695-4684-8f32-dfad644b0669';

(async () => {
  // ── isQuietStart: only the exact value MT writes, and never for a helper ──
  ok(isQuietStart({ MULTITERMINAL_QUIET_START: 'true' }), "'true' -> quiet");
  ok(!isQuietStart({}), 'absent -> not quiet (every project that never set it)');
  for (const v of ['TRUE', '1', 'yes', ' true', '']) {
    ok(!isQuietStart({ MULTITERMINAL_QUIET_START: v }), `${JSON.stringify(v)} -> not quiet`);
  }
  ok(!isQuietStart({ MULTITERMINAL_QUIET_START: 'true', MULTITERMINAL_SPAWNER: 'Alice' }),
    'a helper is never quiet, even with an inherited flag: it must collect its job');

  // ── quietStartLines: identity yes, auto-run no ──
  const pmEnv = { MULTITERMINAL_QUIET_START: 'true', MULTITERMINAL_DOC_ID: 'doc-1', MULTITERMINAL_PROJECT_PM: 'true', MULTITERMINAL_PROJECT_ID: GUID };
  const text = quietStartLines('Alice', pmEnv, 'sid-1').join('\n');
  ok(text.includes('MULTITERMINAL_NAME=Alice'), 'identity block names the terminal');
  ok(text.includes('MULTITERMINAL_DOC_ID=doc-1'), 'identity block carries the doc id');
  ok(text.includes('CLAUDE_SESSION_ID=sid-1'), 'identity block carries the session id');
  ok(text.includes('MULTITERMINAL_ROLE=project-manager'), 'a PM keeps its role line');
  ok(!text.includes('AUTO-RUN'), 'no AUTO-RUN instruction');
  ok(text.includes('## Quiet start'), 'tells the model why nothing ran');

  // ── registerQuietSession ──
  const calls = [];
  const request = (method, urlPath, body, timeoutMs) => { calls.push({ method, urlPath, body, timeoutMs }); return Promise.resolve({ status: 200, json: {} }); };
  ok(await registerQuietSession({ terminalName: 'Alice', sessionId: 'sid-1', projectPath: 'H:\\Repo' }, { request }) === true, 'register 200 -> true');
  ok(calls.length === 1 && calls[0].method === 'POST' && calls[0].urlPath === '/api/session-lineage/register', 'one POST to session-lineage/register');
  assert.deepStrictEqual(calls[0].body, { sessionId: 'sid-1', agentName: 'Alice', projectPath: 'H:\\Repo', skipJanitor: true }); passed++;
  ok(await registerQuietSession({ terminalName: 'Alice', sessionId: 'sid-1', projectPath: 'x' }, { request: () => Promise.reject(new Error('refused')) }) === false,
    'MT down -> false, no throw');
  ok(await registerQuietSession({ terminalName: 'Alice', sessionId: 'sid-1', projectPath: 'x' }, { request: () => Promise.resolve({ status: 500 }) }) === false, '500 -> false');
  calls.length = 0;
  ok(await registerQuietSession({ terminalName: 'Alice', sessionId: '', projectPath: 'x' }, { request }) === false && calls.length === 0,
    'no session id -> no call');

  // ── The hook itself, as a child process behind the tripwire ──
  const HOOK = path.join(__dirname, '..', 'session-status-hook.js');
  const TRIPWIRE = path.join(__dirname, '_net-tripwire.js');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-e0fa9d90-'));
  const appdata = path.join(work, 'appdata');
  fs.mkdirSync(appdata);
  // The hook reads multiterminal-rules.md from its cwd; each child runs in `work`.
  const RULES_SENTINEL = 'RULES-SENTINEL-e0fa9d90: claim before coding.';
  fs.writeFileSync(path.join(work, 'multiterminal-rules.md'), `# MultiTerminal Rules
${RULES_SENTINEL}
`);
  let n = 0;
  const runHook = (hookData, vars) => {
    const logFile = path.join(work, `tripwire-${++n}.log`);
    const env = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (/^MULTITERMINAL_/i.test(k) || /^CLARION_/i.test(k) || /^CLAUDE_CODE_MESSAGING_/i.test(k) || /^NODE_OPTIONS$/i.test(k)) continue;
      env[k] = v;
    }
    Object.assign(env, {
      APPDATA: appdata,
      // Forward slashes: NODE_OPTIONS parses backslashes inside quotes as escapes.
      NODE_OPTIONS: `--require "${TRIPWIRE.replace(/\\/g, '/')}"`,
      NET_TRIPWIRE_LOG: logFile,
      MULTITERMINAL_NAME: 'QuietTest',
      MULTITERMINAL_DOC_ID: 'doc-quiet',
      MULTITERMINAL_PROJECT_ID: GUID,
      MULTITERMINAL_PROJECT_PM: 'true',
    }, vars);
    const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(hookData), env, cwd: work, encoding: 'utf8', timeout: 30000 });
    assert.ok(!r.error, `spawn failed: ${r.error}`);
    const trips = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    return { out: r.stdout || '', trips };
  };

  try {
    const start = { hook_event_name: 'SessionStart', source: 'startup', session_id: 'sid-quiet', cwd: work };
    const clear = { ...start, source: 'clear' };

    // CONTROL first: without the flag the hook asks for session-start and runs the prefetch.
    const control = runHook(start, {});
    ok(control.out.includes('AUTO-RUN SKILL'), 'control: AUTO-RUN printed (the instrument can see it)');
    ok(control.trips.includes('/api/remote-mode'), 'control: prefetch attempted (the tripwire can see it)');
    ok(control.out.includes(RULES_SENTINEL), 'control: rules printed (the rules file is where the hook looks)');
    const controlClear = runHook(clear, {});
    ok(controlClear.trips.includes('/api/terminals/inject'), 'control /clear: inject attempted');

    const quiet = runHook(start, { MULTITERMINAL_QUIET_START: 'true' });
    ok(!quiet.out.includes('AUTO-RUN'), 'quiet: no AUTO-RUN');
    ok(quiet.out.includes('MULTITERMINAL_NAME=QuietTest'), 'quiet: identity printed');
    ok(quiet.out.includes('## Quiet start'), 'quiet: note printed');
    ok(quiet.out.includes(RULES_SENTINEL), 'quiet: behavioral rules still printed');
    ok(!quiet.out.includes('## MultiTerminal Startup Prefetch'), 'quiet: no prefetch block');
    ok(!quiet.trips.includes('/api/remote-mode') && !quiet.trips.includes('/api/tasks/active/'), 'quiet: no prefetch calls');
    ok(quiet.trips.includes('/api/session-lineage/register'), 'quiet: session registration still attempted');

    const quietClear = runHook(clear, { MULTITERMINAL_QUIET_START: 'true' });
    ok(!quietClear.out.includes('AUTO-RUN'), 'quiet /clear: no AUTO-RUN');
    ok(quietClear.out.includes(RULES_SENTINEL), 'quiet /clear: behavioral rules still printed');
    ok(!quietClear.trips.includes('/api/terminals/inject'), 'quiet /clear: no inject request');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }

  console.log(`session-status quiet start unit: PASS (${passed} assertions)`);
})().catch((e) => {
  console.error(`session-status quiet start unit: FAIL: ${e.message}`);
  process.exit(1);
});

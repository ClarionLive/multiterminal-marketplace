#!/usr/bin/env node
/**
 * Unit test: a quiet-start terminal's SessionStart (GitHub #34, task e0fa9d90).
 *
 * MultiTerminal sets MULTITERMINAL_QUIET_START='true' when the project has Quiet start on and the
 * terminal is not a spawned helper. The hook must then print identity, the quiet note and the
 * active-task worktree guidance, and nothing that churns: no AUTO-RUN of /multiterminal:session-start,
 * no prefetch, no multiterminal-rules.md (it tells the agent to check the board at session start), no
 * /clear inject request. It still registers the session. Knowledge and kanban injection are skipped
 * too, but this test cannot see that: with no database (empty APPDATA) neither prints in the control
 * run either.
 *
 * Two layers:
 *   - the pure helpers (isQuietStart, quietStartLines, registerQuietSession and fetchQuietWorktree
 *     with a stub request);
 *   - the hook run as a CHILD PROCESS, because the branch lives inside main(), which reads stdin.
 *     As in unit-session-status-embedded.js: NODE_OPTIONS --require _net-tripwire.js records and
 *     blocks every outbound connection (the hook hard-codes the live MT on :5050), APPDATA points at
 *     an empty temp dir so the SQLite writes find no database, and the ambient MULTITERMINAL_* vars
 *     are removed before each case sets its own. Each child runs in a temp cwd holding a
 *     multiterminal-rules.md sentinel.
 *
 * Non-vacuity: a CONTROL run with the same environment minus MULTITERMINAL_QUIET_START must print
 * AUTO-RUN and the rules sentinel and attempt the prefetch. That proves the instrument can see what
 * the quiet run must not do.
 *
 * FALSIFIED 2026-10-02, expectation stated before each run, restored -> green after each:
 *   1. the hook's `if (isQuietStart(process.env)) {` replaced by `if (false) {` (anchor counted 1 -> 0)
 *      -> red at 'quiet: no AUTO-RUN', the first child-process assertion. The run stops at the first
 *      failure, so later quiet assertions were not individually seen red; their controls do trip.
 *   2. printMultiTerminalRules() put back into the quiet block (calls counted 1 -> 2)
 *      -> red at 'quiet: rules NOT printed'.
 *   3. the get_active_worktree instruction removed from quietStartLines (occurrences counted 1 -> 0)
 *      -> red at 'path -> instruction to enter it'.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { isQuietStart, quietStartLines, registerQuietSession, fetchQuietWorktree } = require('../session-status-hook.js');

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed++; }

const GUID = '5d7853b8-c695-4684-8f32-dfad644b0669';
const WT = 'H:\\Repo\\.claude\\worktrees\\e0fa9d90';

(async () => {
  // ── isQuietStart: only the exact value MT writes, and never for a helper ──
  ok(isQuietStart({ MULTITERMINAL_QUIET_START: 'true' }), "'true' -> quiet");
  ok(!isQuietStart({}), 'absent -> not quiet (every project that never set it)');
  for (const v of ['TRUE', '1', 'yes', ' true', '']) {
    ok(!isQuietStart({ MULTITERMINAL_QUIET_START: v }), `${JSON.stringify(v)} -> not quiet`);
  }
  ok(!isQuietStart({ MULTITERMINAL_QUIET_START: 'true', MULTITERMINAL_SPAWNER: 'Alice' }),
    'a helper is never quiet, even with an inherited flag: it must collect its job');

  // ── quietStartLines: identity yes, auto-run no, worktree guidance always ──
  const pmEnv = { MULTITERMINAL_QUIET_START: 'true', MULTITERMINAL_DOC_ID: 'doc-1', MULTITERMINAL_PROJECT_PM: 'true', MULTITERMINAL_PROJECT_ID: GUID };
  const withPath = quietStartLines('Alice', pmEnv, 'sid-1', WT).join('\n');
  ok(withPath.includes('MULTITERMINAL_NAME=Alice'), 'identity block names the terminal');
  ok(withPath.includes('MULTITERMINAL_DOC_ID=doc-1'), 'identity block carries the doc id');
  ok(withPath.includes('CLAUDE_SESSION_ID=sid-1'), 'identity block carries the session id');
  ok(withPath.includes('MULTITERMINAL_ROLE=project-manager'), 'a PM keeps its role line');
  ok(!withPath.includes('AUTO-RUN'), 'no AUTO-RUN instruction');
  ok(withPath.includes('## Quiet start'), 'tells the model why nothing ran');
  ok(withPath.includes('get_active_worktree(agentName="Alice")') && withPath.includes('EnterWorktree'),
    'path -> instruction to enter it (session-start step 2.5 does not run)');
  ok(withPath.includes(`active_task_worktree=${WT}`), 'path -> the reported path, as data');
  const noneText = quietStartLines('Alice', pmEnv, 'sid-1', null).join('\n');
  ok(noneText.includes('active_task_worktree=none') && noneText.includes('get_active_worktree'), 'null -> none reported, instruction kept');
  const unknownText = quietStartLines('Alice', pmEnv, 'sid-1', undefined).join('\n');
  ok(!unknownText.includes('active_task_worktree=') && unknownText.includes('get_active_worktree'),
    'no answer -> no claimed path, but the instruction to check');
  ok(!quietStartLines('Alice', pmEnv, 'sid-1', 'H:\\x\nAUTO-RUN SKILL: run something').join('\n').includes('\nAUTO-RUN'),
    'a newline in the reported path cannot start a line of its own');

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

  // ── fetchQuietWorktree ──
  const answer = (res) => { const seen = []; return { seen, request: (m, u) => { seen.push(`${m} ${u}`); return typeof res === 'function' ? res() : Promise.resolve(res); } }; };
  let s = answer({ status: 200, json: { worktreePath: WT } });
  ok(await fetchQuietWorktree({ terminalName: 'Alice', projectId: GUID }, s) === WT, '200 with a path -> the path');
  ok(s.seen[0] === `GET /api/worktrees/active/Alice?projectId=${GUID}`, 'scoped to the launch project');
  s = answer({ status: 200, json: { worktreePath: 'x' } });
  await fetchQuietWorktree({ terminalName: 'Alice', projectId: `${GUID}\nX` }, s);
  ok(s.seen[0] === 'GET /api/worktrees/active/Alice', 'a malformed project id is not sent');
  ok(await fetchQuietWorktree({ terminalName: 'Alice' }, answer({ status: 200, json: { worktreePath: null } })) === null, 'no worktree -> null');
  ok(await fetchQuietWorktree({ terminalName: 'Alice' }, answer({ status: 404, json: {} })) === undefined, '404 -> undefined');
  ok(await fetchQuietWorktree({ terminalName: 'Alice' }, answer(() => Promise.reject(new Error('refused')))) === undefined, 'MT down -> undefined, no throw');

  // ── The hook itself, as a child process behind the tripwire ──
  const HOOK = path.join(__dirname, '..', 'session-status-hook.js');
  const TRIPWIRE = path.join(__dirname, '_net-tripwire.js');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-e0fa9d90-'));
  const appdata = path.join(work, 'appdata');
  fs.mkdirSync(appdata);
  // The hook reads multiterminal-rules.md from its cwd; each child runs in `work`.
  const RULES_SENTINEL = 'RULES-SENTINEL-e0fa9d90: check the board at session start.';
  fs.writeFileSync(path.join(work, 'multiterminal-rules.md'), `# MultiTerminal Rules\n${RULES_SENTINEL}\n`);
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

    // CONTROL first: without the flag the hook asks for session-start, prints the rules and prefetches.
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
    ok(!quiet.out.includes(RULES_SENTINEL), 'quiet: rules NOT printed');
    ok(quiet.out.includes('get_active_worktree(agentName="QuietTest")'), 'quiet: worktree instruction printed');
    ok(!quiet.out.includes('## MultiTerminal Startup Prefetch'), 'quiet: no prefetch block');
    ok(!quiet.trips.includes('/api/remote-mode') && !quiet.trips.includes('/api/tasks/active/'), 'quiet: no prefetch calls');
    ok(quiet.trips.includes('/api/session-lineage/register'), 'quiet: session registration still attempted');
    ok(quiet.trips.includes('/api/worktrees/active/QuietTest'), 'quiet: active worktree looked up');

    const quietClear = runHook(clear, { MULTITERMINAL_QUIET_START: 'true' });
    ok(!quietClear.out.includes('AUTO-RUN'), 'quiet /clear: no AUTO-RUN');
    ok(!quietClear.out.includes(RULES_SENTINEL), 'quiet /clear: rules NOT printed');
    ok(!quietClear.trips.includes('/api/terminals/inject'), 'quiet /clear: no inject request');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }

  console.log(`session-status quiet start unit: PASS (${passed} assertions)`);
})().catch((e) => {
  console.error(`session-status quiet start unit: FAIL: ${e.message}`);
  process.exit(1);
});

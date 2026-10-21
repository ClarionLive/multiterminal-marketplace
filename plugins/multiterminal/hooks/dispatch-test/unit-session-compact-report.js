#!/usr/bin/env node
/**
 * Unit test for session-compact-hook.reportCompactFinished (MultiTerminal ticket c0ebcfd4).
 *
 * After a compaction the hook tells MT which pane finished (agent name + MULTITERMINAL_DOC_ID +
 * session id). MT types a continue prompt only if that pane armed one through compact_my_context.
 *
 * In-process cases use an injected post function behind the network tripwire. The last case runs
 * the hook's CLI in a child behind the tripwire to prove the CLI actually calls the report (a
 * wiring check the in-process cases cannot make): the tripwire records the attempted request to
 * /api/terminals/compact-finished and throws, which the hook swallows.
 *
 * Also covers compact-trigger-hook.js, the PreCompact leaf that reports manual vs auto, and that the
 * dispatcher actually routes it (a run()-level case stays green if the table entry is dropped).
 *
 * FALSIFIED (expectations written before each run): removing the docId guard -> red at
 * 'no docId: no post'; removing the reportCompactFinished call from the CLI shim -> red at
 * 'CLI: one attempt to /api/terminals/compact-finished'; dropping the trigger allow-list -> red at
 * 'trigger: nothing sent ...'; dropping the TABLE entry -> red at 'trigger: routed ...'.
 * See the MT ticket notes.
 */
const tripwire = require('./_net-tripwire.js');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { reportCompactFinished } = require('../session-compact-hook.js');

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed++; }

(async () => {
  const PANE = { MULTITERMINAL_NAME: 'Henry', MULTITERMINAL_DOC_ID: 'doc-123' };

  // 1. An MT pane posts its name, docId and the hook's session id.
  {
    const sent = [];
    const r = await reportCompactFinished({ session_id: 'sess-9' }, { env: PANE, post: async (b) => { sent.push(b); return 200; } });
    ok(r.posted === true, 'MT pane: posted');
    ok(sent.length === 1, 'MT pane: exactly one post');
    ok(sent[0].agentName === 'Henry' && sent[0].docId === 'doc-123' && sent[0].sessionId === 'sess-9',
      `MT pane: body carries name, docId and session id (got ${JSON.stringify(sent[0])})`);
  }

  // 2. No docId: MT cannot tell which pane compacted, so nothing is sent.
  {
    const sent = [];
    const r = await reportCompactFinished({}, { env: { MULTITERMINAL_NAME: 'Henry' }, post: async (b) => { sent.push(b); } });
    ok(r.posted === false && sent.length === 0, 'no docId: no post');
  }

  // 3. No name: not an MT agent.
  {
    const sent = [];
    const r = await reportCompactFinished({}, { env: { MULTITERMINAL_DOC_ID: 'doc-123' }, post: async (b) => { sent.push(b); } });
    ok(r.posted === false && sent.length === 0, 'no name: no post');
  }

  // 4. ClarionAssistant tab (embedded): messaging only, never this.
  {
    const sent = [];
    const r = await reportCompactFinished({}, { env: { ...PANE, CLARION_ASSISTANT_EMBEDDED: '1' }, post: async (b) => { sent.push(b); } });
    ok(r.posted === false && sent.length === 0, 'embedded: no post');
  }

  // 5. A failing post never throws out of the hook.
  {
    const r = await reportCompactFinished({}, { env: PANE, post: async () => { throw new Error('boom'); } });
    ok(r.posted === false, 'post throws: reported, not thrown');
  }

  // ── compact-trigger-hook (PreCompact leaf): reports manual vs auto ──────────────
  const trigger = require('../compact-trigger-hook.js');
  {
    const sent = [];
    const post = async (b) => { sent.push(b); };
    await trigger.run({ hook_event_name: 'PreCompact', trigger: 'manual' }, { env: PANE, post });
    await trigger.run({ hook_event_name: 'PreCompact', trigger: 'auto' }, { env: PANE, post });
    ok(sent.length === 2 && sent[0].trigger === 'manual' && sent[1].trigger === 'auto'
      && sent[0].agentName === 'Henry' && sent[0].docId === 'doc-123',
      `trigger: posts name, docId and the trigger (got ${JSON.stringify(sent)})`);
  }
  {
    const sent = [];
    const post = async (b) => { sent.push(b); };
    await trigger.run({ hook_event_name: 'PreCompact' }, { env: PANE, post });
    await trigger.run({ hook_event_name: 'PreCompact', trigger: 'weird' }, { env: PANE, post });
    await trigger.run({ hook_event_name: 'Stop', trigger: 'manual' }, { env: PANE, post });
    await trigger.run({ hook_event_name: 'PreCompact', trigger: 'manual' }, { env: { MULTITERMINAL_NAME: 'Henry' }, post });
    await trigger.run({ hook_event_name: 'PreCompact', trigger: 'manual' }, { env: { ...PANE, CLARION_ASSISTANT_EMBEDDED: '1' }, post });
    ok(sent.length === 0, `trigger: nothing sent without a known trigger, off PreCompact, without a docId, or embedded (got ${JSON.stringify(sent)})`);
  }
  {
    const r = await trigger.run({ hook_event_name: 'PreCompact', trigger: 'manual' }, { env: PANE, post: async () => { throw new Error('boom'); } });
    ok(r.exitCode === 0 && !r.stdout, 'trigger: a failing post exits 0 with no stdout');
  }
  {
    const { TABLE } = require('../dispatch-hook.js');
    const leaf = (TABLE.PreCompact || []).find((l) => l.name === 'compact-trigger-hook');
    ok(leaf && leaf.head === 'sync' && leaf.mod === './compact-trigger-hook.js',
      'trigger: routed on the PreCompact SYNC head, so it reaches MT before the compaction runs');
    const names = (TABLE.PreCompact || []).map((l) => l.name);
    ok(names.indexOf('compact-trigger-hook') < names.indexOf('session-save-hook'),
      `trigger: runs before session-save, whose requests can use up the 8s head (order ${names.join(', ')})`);
  }

  ok(tripwire.attempts.length === 0, `in-process cases made no network attempt (got ${tripwire.attempts.join('; ')})`);

  // 6. CLI wiring: the hook process itself attempts the POST, behind the tripwire in a child.
  {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-report-'));
    const logFile = path.join(work, 'tripwire.log');
    const env = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (/^MULTITERMINAL_/i.test(k) || /^CLARION_/i.test(k) || /^NODE_OPTIONS$/i.test(k)) continue;
      env[k] = v;
    }
    Object.assign(env, PANE, {
      APPDATA: path.join(work, 'appdata'), // no DB: run() prints identity only
      NODE_OPTIONS: `--require "${path.join(__dirname, '_net-tripwire.js').replace(/\\/g, '/')}"`,
      NET_TRIPWIRE_LOG: logFile,
    });
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'session-compact-hook.js')], {
      input: JSON.stringify({ session_id: 'sess-cli', source: 'compact' }), env, cwd: work, encoding: 'utf8', timeout: 30000,
    });
    const lines = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split(/\r?\n/).filter(Boolean) : [];
    ok(r.status === 0, `CLI: exit 0 (got ${r.status}, stderr ${r.stderr})`);
    ok(r.stdout.includes('You are Henry.'), 'CLI: context still printed');
    ok(lines.length === 1 && lines[0].includes('/api/terminals/compact-finished'),
      `CLI: one attempt to /api/terminals/compact-finished (got ${JSON.stringify(lines)})`);
    fs.rmSync(work, { recursive: true, force: true });
  }

  console.log(`session-compact report unit: PASS (${passed} assertions)`);
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });

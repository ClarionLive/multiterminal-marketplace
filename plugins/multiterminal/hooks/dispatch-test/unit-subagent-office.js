#!/usr/bin/env node
/**
 * Unit test for subagent-office-hook.run() (ticket 42c91001).
 *
 * The Start/Stop/TeammateIdle branches fire live office-panel REST calls and
 * mutate temp tracking files with non-deterministic AG-XXXX names + timestamps —
 * the equivalence harness can only safely cover the no-op branches (unknown
 * event, malformed). The spawn/depart/ghost-cleanup logic is proven here with a
 * stubbed callApi + in-memory fs + fixed clock/random. No live office API.
 */
const assert = require('assert');
const path = require('path');
const os = require('os');
const { run } = require('../subagent-office-hook.js');

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed++; }

const TRACKING_FILE = path.join(os.tmpdir(), 'mt-office-agents.json');

function memFs(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    _store: store,
    existsSync: (p) => store.has(p),
    readFileSync: (p) => { if (!store.has(p)) { const e = new Error('ENOENT ' + p); e.code = 'ENOENT'; throw e; } return store.get(p); },
    writeFileSync: (p, d) => { store.set(p, String(d)); },
    renameSync: (a, b) => { store.set(b, store.get(a)); store.delete(a); },
    appendFileSync: (p, d) => { store.set(p, (store.get(p) || '') + String(d)); },
  };
}
function stubApi(over = {}) {
  const calls = [];
  const fn = async (apiPath, method, body) => {
    calls.push({ path: apiPath, method, body });
    if (apiPath === '/api/office/agents' && method === 'POST') {
      return over.spawnResult || { ok: true, data: { agentName: 'AG-1000' } };
    }
    return { ok: true, data: {} };
  };
  fn.calls = calls;
  return fn;
}
function deps(api, fsStub) {
  return {
    callApi: api, fs: fsStub, env: { MULTITERMINAL_NAME: 'Henry' },
    now: () => 1000, nowIso: () => '2026-07-07T00:00:00.000Z', random: () => 0,
    debugLog: path.join(os.tmpdir(), 'unit-office-debug-42c91001.log'),
  };
}

async function main() {
  // ── 1. SubagentStart → spawn office agent + track by agent_id ──
  {
    const api = stubApi();
    const fsStub = memFs({ [TRACKING_FILE]: '{}' });
    await run({ hook_event_name: 'SubagentStart', agent_id: 'a1', session_id: 's1', transcript_path: '/proj/t.jsonl' }, deps(api, fsStub));
    const spawn = api.calls.find(c => c.path === '/api/office/agents' && c.method === 'POST');
    ok(spawn && spawn.body.name === 'AG-1000', 'spawn POST with deterministic AG name');
    ok(spawn.body.spawnedBy === 'Henry', 'spawnedBy = parent name');
    const tracked = JSON.parse(fsStub._store.get(TRACKING_FILE));
    ok(tracked.a1 && tracked.a1.name === 'AG-1000', 'agent tracked by id');
    ok(tracked.a1.startedAt === '2026-07-07T00:00:00.000Z', 'startedAt from injected clock');
    ok(tracked.a1.transcriptPath === path.join('/proj', 's1', 'subagents', 'agent-a1.jsonl'), 'transcript path derived');
  }

  // ── 2. SubagentStart with a ghost from another session → depart the ghost ──
  {
    const api = stubApi();
    const fsStub = memFs({ [TRACKING_FILE]: JSON.stringify({ g1: { name: 'AG-Ghost', sessionId: 'OLD' } }) });
    await run({ hook_event_name: 'SubagentStart', agent_id: 'a2', session_id: 'NEW' }, deps(api, fsStub));
    ok(api.calls.some(c => c.method === 'DELETE' && c.path.includes('AG-Ghost')), 'ghost from other session departed');
    const tracked = JSON.parse(fsStub._store.get(TRACKING_FILE));
    ok(!tracked.g1, 'ghost removed from tracking');
  }

  // ── 3. SubagentStop → depart tracked agent + close its panel ──
  {
    const api = stubApi();
    const fsStub = memFs({ [TRACKING_FILE]: JSON.stringify({ a1: { name: 'AG-5', transcriptPath: '/tp/x.jsonl' } }) });
    await run({ hook_event_name: 'SubagentStop', agent_id: 'a1' }, deps(api, fsStub));
    ok(api.calls.some(c => c.method === 'DELETE' && c.path.includes('AG-5')), 'departed AG-5');
    const close = api.calls.find(c => c.path === '/api/agent-panels/close');
    ok(close && close.body.transcriptPath === '/tp/x.jsonl', 'closed panel with tracked transcript');
  }

  // ── 4. TeammateIdle → depart + remove tracking entry ──
  {
    const api = stubApi();
    const fsStub = memFs({ [TRACKING_FILE]: JSON.stringify({ a1: { name: 'AG-7' } }) });
    await run({ hook_event_name: 'TeammateIdle', agent_id: 'a1' }, deps(api, fsStub));
    ok(api.calls.some(c => c.method === 'DELETE' && c.path.includes('AG-7')), 'idle teammate departed');
    const tracked = JSON.parse(fsStub._store.get(TRACKING_FILE));
    ok(!tracked.a1, 'idle teammate removed from tracking');
  }

  // ── 5. Unknown hook_event_name → self-gate, zero API calls ──
  {
    const api = stubApi();
    const fsStub = memFs({ [TRACKING_FILE]: '{}' });
    const r = await run({ hook_event_name: 'PostToolUse', agent_id: 'a1' }, deps(api, fsStub));
    ok(r.exitCode === 0 && api.calls.length === 0, 'unknown event → no API calls, exit 0');
  }

  console.log(`subagent-office run() unit: PASS (${passed} assertions)`);
}

main().catch((e) => { console.error(e); process.exit(1); });

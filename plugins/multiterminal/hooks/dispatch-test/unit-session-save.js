#!/usr/bin/env node
/**
 * Unit test for session-save-hook.run() (ticket 42c91001).
 *
 * The write path fetches task state from the REST API and writes ACTIVE-CONTEXT.md
 * — not safe to spawn against live MT, so equivalence covers only the malformed
 * branch. The throttle gate, fetch→buildContext→write flow, and phase logic are
 * proven here with an injected fetchJson + in-memory fs + fixed clock.
 */
const assert = require('assert');
const { run } = require('../session-save-hook.js');

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed++; }

function memFs(seed = {}) {
  const store = new Map(Object.entries(seed));
  const dirs = new Set();
  return {
    _store: store,
    existsSync: (p) => store.has(p) || dirs.has(p),
    mkdirSync: (p) => { dirs.add(p); },
    writeFileSync: (p, d) => { store.set(p, String(d)); },
    readFileSync: (p) => { if (!store.has(p)) throw new Error('ENOENT ' + p); return store.get(p); },
  };
}
function stubFetch(over = {}) {
  const calls = [];
  const fn = async (p) => {
    calls.push(p);
    if (p.includes('status=in_progress')) return over.tasks !== undefined ? over.tasks : { tasks: [{ id: 't1', title: 'Tooling diet', subStatus: 'active', assignee: 'Henry' }] };
    if (p.endsWith('/reports')) return over.reports !== undefined ? over.reports : { reports: [] };
    if (p.startsWith('/api/tasks/')) return over.detail !== undefined ? over.detail : { id: 't1', title: 'Tooling diet', checklist_json: JSON.stringify([{ status: 'done' }, { status: 'testing' }]), continuation_notes: 'resume note' };
    return null;
  };
  fn.calls = calls;
  return fn;
}
const NOW = 1000000;
const PATHS = { memoryDir: '/mem', contextFile: '/mem/ACTIVE-CONTEXT.md', throttleFile: '/mem/throttle.txt' };
function deps(fetchFn, fsStub, extra = {}) {
  return { fetchJson: fetchFn, fs: fsStub, env: { MULTITERMINAL_NAME: 'Henry' }, nowIso: () => '2026-07-07T12:00:00.000Z', now: () => NOW, ...PATHS, log: () => {}, ...extra };
}

async function main() {
  // ── 1. PreCompact → fetch + buildContext + write ACTIVE-CONTEXT.md + throttle mark ──
  {
    const f = stubFetch();
    const fsStub = memFs();
    await run({ hook_event_name: 'PreCompact' }, deps(f, fsStub));
    const content = fsStub._store.get('/mem/ACTIVE-CONTEXT.md');
    ok(content && content.includes('Tooling diet'), 'wrote context with task title');
    ok(content.includes('**Checklist:** 1/2 done, 1 testing'), 'checklist summary rendered');
    ok(content.includes('PIPELINE / TESTING'), 'phase = pipeline/testing (1 done, 1 testing)');
    ok(content.includes('trigger: PreCompact'), 'trigger recorded');
    ok(fsStub._store.get('/mem/throttle.txt') === String(NOW), 'throttle marked with clock');
  }

  // ── 2. Stop + fresh throttle → skip (no fetch) ──
  {
    const f = stubFetch();
    const fsStub = memFs({ '/mem/throttle.txt': String(NOW - 1000) }); // 1s ago < 30s window
    await run({ hook_event_name: 'Stop' }, deps(f, fsStub));
    ok(f.calls.length === 0, 'throttled Stop → no fetch');
    ok(!fsStub._store.has('/mem/ACTIVE-CONTEXT.md'), 'throttled → no write');
  }

  // ── 3. Stop + stale throttle → proceeds ──
  {
    const f = stubFetch();
    const fsStub = memFs({ '/mem/throttle.txt': String(NOW - 60000) }); // 60s ago > 30s
    await run({ hook_event_name: 'Stop' }, deps(f, fsStub));
    ok(f.calls.length > 0, 'stale throttle → fetches');
    ok(fsStub._store.has('/mem/ACTIVE-CONTEXT.md'), 'stale throttle → writes');
  }

  // ── 4. No tasks → no write ──
  {
    const f = stubFetch({ tasks: null });
    const fsStub = memFs();
    await run({ hook_event_name: 'PreCompact' }, deps(f, fsStub));
    ok(!fsStub._store.has('/mem/ACTIVE-CONTEXT.md'), 'no tasks → no context file');
  }

  // ── 5. All-done checklist → COMPLETE phase ──
  {
    const f = stubFetch({ detail: { id: 't1', title: 'Done Task', checklist_json: JSON.stringify([{ status: 'done' }, { status: 'done' }]) } });
    const fsStub = memFs();
    await run({ hook_event_name: 'PreCompact' }, deps(f, fsStub));
    ok(fsStub._store.get('/mem/ACTIVE-CONTEXT.md').includes('COMPLETE'), 'all done → COMPLETE phase');
  }

  console.log(`session-save run() unit: PASS (${passed} assertions)`);
}

main().catch((e) => { console.error(e); process.exit(1); });

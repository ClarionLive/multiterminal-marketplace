#!/usr/bin/env node
/**
 * Unit test for active-context-hook.run() (ticket 42c91001).
 *
 * active-context ALWAYS fetches (it does not self-gate on tool_name — its scope
 * comes from the hooks.json matcher, carried as a B′ table-matcher), so the
 * equivalence harness can only cover the malformed branch. The fetch→build→write
 * path (incl. build-status extraction + minimal-context fallback) is proven here
 * with an injected fetchJson + in-memory fs + fixed clock — no live REST/write.
 */
const assert = require('assert');
const { run } = require('../active-context-hook.js');

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
  };
}
function stubFetch(over = {}) {
  const calls = [];
  const fn = async (p) => {
    calls.push(p);
    if (p.includes('status=in_progress')) return over.tasks !== undefined ? over.tasks : { tasks: [{ id: 't1', title: 'Tooling diet', subStatus: 'active', assignee: 'Henry' }] };
    if (p.endsWith('/reports')) return over.reports !== undefined ? over.reports : { reports: [] };
    if (p.startsWith('/api/tasks/')) return over.detail !== undefined ? over.detail : { id: 't1', title: 'Tooling diet', checklist_json: JSON.stringify([{ status: 'done' }, { status: 'coding' }]), continuation_notes: 'note' };
    return null;
  };
  fn.calls = calls;
  return fn;
}
const PATHS = { memoryDir: '/mem', contextFile: '/mem/ACTIVE-CONTEXT.md' };
function deps(fetchFn, fsStub) {
  return { fetchJson: fetchFn, fs: fsStub, env: { MULTITERMINAL_NAME: 'Henry' }, nowIso: () => '2026-07-07T12:00:00.000Z', ...PATHS };
}

async function main() {
  // ── 1. update_task_checklist → fetch + write ACTIVE-CONTEXT.md ──
  {
    const f = stubFetch(); const fsStub = memFs();
    const r = await run({ tool_name: 'mcp__multiterminal__update_task_checklist', tool_input: { taskId: 't1' } }, deps(f, fsStub));
    ok(r.exitCode === 0, 'exit 0');
    const c = fsStub._store.get('/mem/ACTIVE-CONTEXT.md');
    ok(c && c.includes('Tooling diet'), 'context written with task');
    ok(c.includes('**Checklist:** 1/2 done'), 'checklist summary');
  }

  // ── 2. build_project → build status recorded in context ──
  {
    const f = stubFetch(); const fsStub = memFs();
    await run({ tool_name: 'mcp__windows-build-runner__build_project', tool_output: '{"success":true}' }, deps(f, fsStub));
    ok(fsStub._store.get('/mem/ACTIVE-CONTEXT.md').includes('**Last Build:** PASS'), 'build PASS surfaced');
  }

  // ── 3. no tasks but a build → minimal context still written ──
  {
    const f = stubFetch({ tasks: { tasks: [] } }); const fsStub = memFs();
    await run({ tool_name: 'mcp__multiterminal__build_project', tool_output: '{"success":false}' }, deps(f, fsStub));
    const c = fsStub._store.get('/mem/ACTIVE-CONTEXT.md');
    ok(c && c.includes('**Last Build:** FAIL') && c.includes('# Active Context'), 'minimal context on no-tasks+build');
  }

  // ── 4. no tasks and no build → no write ──
  {
    const f = stubFetch({ tasks: { tasks: [] } }); const fsStub = memFs();
    await run({ tool_name: 'mcp__multiterminal__update_task_status', tool_input: {} }, deps(f, fsStub));
    ok(!fsStub._store.has('/mem/ACTIVE-CONTEXT.md'), 'no tasks + no build → no write');
  }

  console.log(`active-context run() unit: PASS (${passed} assertions)`);
}

main().catch((e) => { console.error(e); process.exit(1); });

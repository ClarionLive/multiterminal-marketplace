#!/usr/bin/env node
/**
 * Unit test for project-context-hook.run() (ticket 42c91001).
 *
 * The SessionStart path calls `claude plugin install` (execSync spawn) and a
 * live REST fetch — neither safe to run twice, so the equivalence harness only
 * covers the idempotent no-op branches (malformed / non-SessionStart). Here the
 * SessionStart install+fetch+format path is proven with injected deps
 * (ensurePluginInstalled spy + fetchProjectContext stub + env) — zero real spawn
 * or HTTP.
 */
const assert = require('assert');
const { run } = require('../project-context-hook.js');

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed++; }

const ctx = {
  project: { name: 'MultiTerminal', projectType: 'WinForms', sourcePath: 'H:/src', buildCommand: 'dotnet build' },
  agents: [{ agentName: 'Henry', role: 'engineer' }],
};

function spies() {
  const s = { ensureCalls: 0, fetchCalls: 0, fetchArg: null };
  s.deps = {
    ensurePluginInstalled: () => { s.ensureCalls++; },
    fetchProjectContext: async (pid) => { s.fetchCalls++; s.fetchArg = pid; return s.ctxReturn; },
    env: { MULTITERMINAL_PROJECT_ID: 'proj-1' },
  };
  s.ctxReturn = ctx;
  return s;
}

async function main() {
// ── 1. SessionStart + projectId + ctx → formatted stdout, deps invoked ──
{
  const s = spies();
  const r = await run({ hook_type: 'SessionStart' }, s.deps);
  ok(r.exitCode === 0, 'sessionstart exit 0');
  ok(r.stdout.includes('## Project Context: MultiTerminal (WinForms)'), 'header formatted');
  ok(r.stdout.includes('- Source: H:/src'), 'paths section present');
  ok(r.stdout.includes('### Team Agents'), 'agents section present');
  ok(r.stdout.endsWith('\n'), 'trailing newline matches console.log');
  ok(s.ensureCalls === 1, 'ensurePluginInstalled called once');
  ok(s.fetchCalls === 1 && s.fetchArg === 'proj-1', 'fetch called with projectId');
}

// ── 2. non-SessionStart → no stdout, NO side-effect deps invoked ──
{
  const s = spies();
  const r = await run({ hook_type: 'PostToolUse' }, s.deps);
  ok(!r.stdout, 'non-sessionstart → no stdout');
  ok(s.ensureCalls === 0 && s.fetchCalls === 0, 'non-sessionstart → no install, no fetch');
}

// ── 3. SessionStart + no projectId → install runs, fetch skipped, no stdout ──
{
  const s = spies();
  s.deps.env = { MULTITERMINAL_PROJECT_ID: '' };
  const r = await run({ hook_type: 'SessionStart' }, s.deps);
  ok(!r.stdout, 'no projectId → no stdout');
  ok(s.ensureCalls === 1, 'no projectId → install still runs (once per project)');
  ok(s.fetchCalls === 0, 'no projectId → fetch skipped');
}

// ── 4. SessionStart + fetch returns null (API down) → no stdout ──
{
  const s = spies();
  s.ctxReturn = null;
  const r = await run({ hook_type: 'SessionStart' }, s.deps);
  ok(!r.stdout, 'ctx null → no stdout');
  ok(s.fetchCalls === 1, 'ctx null → fetch attempted');
}

// ── 5. `type` alias also recognized as the event key ──
{
  const s = spies();
  const r = await run({ type: 'SessionStart' }, s.deps);
  ok(r.stdout.includes('## Project Context: MultiTerminal'), 'type alias recognized');
}

console.log(`project-context run() unit: PASS (${passed} assertions)`);
}

main().catch((e) => { console.error(e); process.exit(1); });

#!/usr/bin/env node
/**
 * Unit test for elicitation-relay-hook.run() (ticket 42c91001).
 *
 * Mirrors ask-user-relay: the store→send→poll→hookSpecificOutput path fires live
 * REST calls and long-polls, so equivalence covers only the pre-fetch self-gate
 * branches and the answered path is proven here with a stubbed fetch. No live MT.
 */
const assert = require('assert');
const { run } = require('../elicitation-relay-hook.js');

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed++; }

function happyFetch(over = {}) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push(`${opts.method || 'GET'} ${url}`);
    if (url.includes('/api/remote-mode')) {
      return { ok: true, json: async () => ({ remote_mode: over.remoteMode !== false }) };
    }
    if (url.includes('/api/elicitations/') && url.includes('/response')) {
      return { ok: true, json: async () => (over.response || { answered: true, action: 'accept', contentJson: JSON.stringify({ field: 'value' }) }) };
    }
    if (url.endsWith('/api/elicitations')) {
      return { ok: over.storeOk !== false, status: over.storeStatus || 500, json: async () => ({}) };
    }
    if (url.includes('/api/messaging/send')) return { ok: true, json: async () => ({}) };
    return { ok: true, json: async () => ({}) };
  };
  fn.calls = calls;
  return fn;
}

const formEvent = {
  mode: 'form',
  requested_schema: { type: 'object', properties: { field: { type: 'string' } } },
  elicitation_id: 'e1',
  mcp_server_name: 'srv',
  message: 'Provide a value',
};
function deps(fetchFn, over = {}) {
  return { fetch: fetchFn, sleep: async () => {}, now: () => 999, timeout: 100, pollInterval: 10, env: { MULTITERMINAL_NAME: 'Tester' }, ...over };
}

async function main() {
  // ── 1. form mode + answered → hookSpecificOutput(Elicitation) with action+content ──
  {
    const f = happyFetch();
    const r = await run(formEvent, deps(f));
    ok(r.exitCode === 0, 'exit 0');
    const o = JSON.parse(r.stdout);
    ok(o.hookSpecificOutput.hookEventName === 'Elicitation', 'hookEventName Elicitation');
    ok(o.hookSpecificOutput.action === 'accept', 'action passed through');
    ok(o.hookSpecificOutput.content.field === 'value', 'content parsed from contentJson');
    ok(f.calls.some(c => c.startsWith('POST') && c.endsWith('/api/elicitations')), 'stored elicitation');
  }

  // ── 2. non-form mode → self-gate before ANY fetch ──
  {
    const f = happyFetch();
    const r = await run({ mode: 'text' }, deps(f));
    ok(!r.stdout && r.exitCode === 0, 'non-form → silent exit 0');
    ok(f.calls.length === 0, 'non-form → zero fetches');
  }

  // ── 3. form mode but missing requested_schema → self-gate ──
  {
    const f = happyFetch();
    const r = await run({ mode: 'form' }, deps(f));
    ok(!r.stdout, 'form w/o schema → no output');
    ok(f.calls.length === 0, 'form w/o schema → zero fetches');
  }

  // ── 4. remote-mode OFF → fall through ──
  {
    const f = happyFetch({ remoteMode: false });
    const r = await run(formEvent, deps(f));
    ok(!r.stdout, 'remote off → no output');
    ok(!f.calls.some(c => c.includes('/api/messaging/send')), 'remote off → nothing sent');
  }

  // ── 5. store failure → stderr, no output ──
  {
    const f = happyFetch({ storeOk: false, storeStatus: 500 });
    const r = await run(formEvent, deps(f));
    ok(!r.stdout, 'store fail → no output');
    ok(r.stderr && r.stderr.includes('Failed to store elicitation: 500'), 'store fail → diagnostic stderr');
  }

  console.log(`elicitation-relay run() unit: PASS (${passed} assertions)`);
}

main().catch((e) => { console.error(e); process.exit(1); });

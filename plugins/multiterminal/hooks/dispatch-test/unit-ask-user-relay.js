#!/usr/bin/env node
/**
 * Unit test for ask-user-relay-hook.run() (ticket 42c91001).
 *
 * The remote-answer path fires 3+ live REST calls (remote-mode, store, send,
 * poll) and long-polls up to 120s — impossible for the spawn-equivalence harness
 * to run safely or quickly. The equivalence fixtures cover only the pre-fetch
 * self-gate/no-op branches; the store→send→poll→decision path is proven here with
 * a stubbed fetch + instant sleep + fixed clock. No live MT calls.
 */
const assert = require('assert');
const { run } = require('../ask-user-relay-hook.js');

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
      return { ok: true, json: async () => (over.response || { answered: true, action: 'accept', contentJson: JSON.stringify({ answer: 'Option A' }) }) };
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

const askEvent = {
  tool_name: 'AskUserQuestion',
  tool_input: { questions: [{ question: 'Pick one', header: 'Choice', options: [{ label: 'Option A', description: 'first' }, { label: 'Option B' }] }] },
};
function deps(fetchFn, over = {}) {
  return { fetch: fetchFn, sleep: async () => {}, now: () => 12345, timeout: 100, pollInterval: 10, env: { MULTITERMINAL_NAME: 'Tester' }, ...over };
}

async function main() {
  // ── 1. remote-mode on + answered accept → decision:block carrying the answer ──
  {
    const f = happyFetch();
    const r = await run(askEvent, deps(f));
    ok(r.exitCode === 0, 'exit 0');
    const o = JSON.parse(r.stdout);
    ok(o.decision === 'block', 'answered → decision block');
    ok(o.reason.includes('"Option A"'), 'answer threaded into block reason');
    ok(f.calls.some(c => c.startsWith('POST') && c.includes('/api/elicitations')), 'stored the elicitation');
    ok(f.calls.some(c => c.includes('/api/messaging/send')), 'sent to ClaudeRemote');
  }

  // ── 2. remote-mode OFF → fall through, no stdout, no store/send ──
  {
    const f = happyFetch({ remoteMode: false });
    const r = await run(askEvent, deps(f));
    ok(!r.stdout, 'remote off → no decision');
    ok(!f.calls.some(c => c.includes('/api/messaging/send')), 'remote off → nothing sent');
  }

  // ── 3. non-AskUserQuestion → self-gate before ANY fetch ──
  {
    const f = happyFetch();
    const r = await run({ tool_name: 'Read', tool_input: {} }, deps(f));
    ok(!r.stdout && r.exitCode === 0, 'non-AUQ → silent exit 0');
    ok(f.calls.length === 0, 'non-AUQ → zero fetches (self-gate)');
  }

  // ── 4. store failure → stderr, no decision ──
  {
    const f = happyFetch({ storeOk: false, storeStatus: 503 });
    const r = await run(askEvent, deps(f));
    ok(!r.stdout, 'store fail → no decision');
    ok(r.stderr && r.stderr.includes('Failed to store: 503'), 'store fail → diagnostic stderr with status');
  }

  // ── 5. user declined → fall through (no decision) ──
  {
    const f = happyFetch({ response: { answered: true, action: 'decline', contentJson: '{}' } });
    const r = await run(askEvent, deps(f));
    ok(!r.stdout, 'decline → no decision, falls through to terminal');
  }

  // ── 6. timeout (never answered) → fall through ──
  {
    const f = happyFetch({ response: { answered: false } });
    const r = await run(askEvent, deps(f, { timeout: 30, pollInterval: 10 }));
    ok(!r.stdout && r.exitCode === 0, 'timeout → no decision');
  }

  // ── Attention-rail notification (MultiTerminal task ee17f42d) ───────────────
  //
  // The bug: the Owner was reading a question while the rail said "Finished and idle".
  // Nothing else observes an AskUserQuestion — no activity_feed row, and it blocks rather
  // than ending a turn, so no TURN_END either. This hook is the only witness.
  {
    // REMOTE MODE OFF is the case that was broken, and it is the DEFAULT. The old code
    // returned at the remote-mode check before telling anyone anything.
    const f = happyFetch({ remoteMode: false });
    const r = await run(askEvent, deps(f));
    ok(r.exitCode === 0, 'remote off → still exit 0');
    ok(
      f.calls.some(c => c.startsWith('POST') && c.includes('/api/notifications')),
      'remote OFF still notifies the attention rail'
    );
  }

  {
    // And with remote mode ON — the agent is blocked on the owner either way. Remote mode
    // decides WHERE the question goes, not whether anyone is waiting.
    const f = happyFetch();
    await run(askEvent, deps(f));
    ok(
      f.calls.some(c => c.startsWith('POST') && c.includes('/api/notifications')),
      'remote ON also notifies'
    );
  }

  {
    // ORDERING: the notification must precede the remote-mode check, because that check
    // is exactly where the old code returned. A notify placed after it would pass the
    // "does it notify" assertions above under remote-ON and silently do nothing by default.
    const f = happyFetch({ remoteMode: false });
    await run(askEvent, deps(f));
    const iNotify = f.calls.findIndex(c => c.includes('/api/notifications'));
    const iMode = f.calls.findIndex(c => c.includes('/api/remote-mode'));
    ok(iNotify >= 0 && iMode >= 0, 'both calls made');
    ok(iNotify < iMode, 'notification is sent BEFORE the remote-mode gate');
  }

  {
    // PAYLOAD: raw_type is what AgentAttentionService.MapState reads. A payload without it
    // falls back to the flattened notification_type and lands on BlockedUnknown — a card
    // that pulses without saying what it wants.
    let body = null;
    const f = async (url, opts = {}) => {
      if (url.includes('/api/notifications')) body = JSON.parse(opts.body);
      if (url.includes('/api/remote-mode')) return { ok: true, json: async () => ({ remote_mode: false }) };
      return { ok: true, json: async () => ({}) };
    };
    await run(askEvent, deps(f));
    ok(body !== null, 'notification carries a body');
    ok(body.raw_type === 'ask_user_question', 'raw_type is ask_user_question');
    ok(body.agent_name === 'Tester', 'agent_name is carried');
    ok(String(body.message).includes('Pick one'), 'the question text reaches the card');
  }

  {
    // A DEAD PANEL MUST NEVER COST A QUESTION. If the notify throws, the hook still
    // completes normally — the rail not learning about a question is a worse card, not a
    // worse session.
    const f = async (url) => {
      if (url.includes('/api/notifications')) throw new Error('API down');
      if (url.includes('/api/remote-mode')) return { ok: true, json: async () => ({ remote_mode: false }) };
      return { ok: true, json: async () => ({}) };
    };
    const r = await run(askEvent, deps(f));
    ok(r.exitCode === 0, 'a failed notification does not break the hook');
  }

  console.log(`ask-user-relay run() unit: PASS (${passed} assertions)`);
}

main().catch((e) => { console.error(e); process.exit(1); });

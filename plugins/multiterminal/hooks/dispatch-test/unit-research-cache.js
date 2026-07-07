#!/usr/bin/env node
/**
 * Unit test for research-cache-hook.run() (ticket 42c91001).
 *
 * The Pre cache-hit and Post auto-save paths fire live REST calls, so the
 * equivalence harness only covers the self-gate/no-op branches (non-Web tool,
 * short query, short/error output). The hit-format and save-body logic are
 * proven here with a stubbed httpRequest — no live knowledge-base calls.
 */
const assert = require('assert');
const { run } = require('../research-cache-hook.js');

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed++; }

function stubHttp(over = {}) {
  const calls = [];
  const fn = async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === 'GET') return over.getResult !== undefined ? over.getResult : { hit: false };
    return over.postResult !== undefined ? over.postResult : {};
  };
  fn.calls = calls;
  return fn;
}

async function main() {
  // ── 1. Pre exact hit → formatted cached entry as stdout context ──
  {
    const h = stubHttp({ getResult: { hit: true, source: 'exact', result: { title: 'Foo API', content: 'use bar()', createdAt: '2026-07-01', sourceAgent: 'Bob' } } });
    const r = await run({ tool_name: 'WebSearch', tool_input: { query: 'how to foo' } }, { httpRequest: h, env: {} });
    ok(r.exitCode === 0, 'exit 0');
    ok(r.stdout.startsWith('[Research Cache] Previous research found:'), 'cache header');
    ok(r.stdout.includes('**Foo API**') && r.stdout.includes('use bar()'), 'entry title + content');
    ok(r.stdout.includes('Cached 2026-07-01 by Bob'), 'provenance line');
    ok(h.calls[0].method === 'GET' && h.calls[0].path.includes(encodeURIComponent('how to foo')), 'GET with encoded query');
  }

  // ── 2. Pre fuzzy (fts) hit → all entries + count ──
  {
    const h = stubHttp({ getResult: { hit: true, source: 'fts', results: [{ title: 'A', content: 'aaa' }, { title: 'B', content: 'bbb' }] } });
    const r = await run({ tool_name: 'WebSearch', tool_input: { query: 'search term' } }, { httpRequest: h, env: {} });
    ok(r.stdout.includes('**A**') && r.stdout.includes('**B**'), 'fts lists entries');
    ok(r.stdout.includes('2 related entries'), 'fts count');
  }

  // ── 3. Pre miss → no stdout ──
  {
    const h = stubHttp({ getResult: { hit: false } });
    const r = await run({ tool_name: 'WebFetch', tool_input: { url: 'http://x', prompt: 'p' } }, { httpRequest: h, env: {} });
    ok(!r.stdout, 'miss → no context');
    ok(h.calls.length === 1 && h.calls[0].method === 'GET', 'miss → one GET, no POST');
  }

  // ── 4. Pre non-Web tool → self-gate, zero calls ──
  {
    const h = stubHttp();
    const r = await run({ tool_name: 'Read', tool_input: {} }, { httpRequest: h, env: {} });
    ok(!r.stdout && h.calls.length === 0, 'non-Web → self-gate, zero calls');
  }

  // ── 5. Post save → POST with cache body, no stdout ──
  {
    const h = stubHttp();
    const output = 'A sufficiently long web research result that easily exceeds the fifty character minimum.';
    const r = await run({ tool_name: 'WebSearch', tool_input: { query: 'how to foo' }, tool_output: output }, { httpRequest: h, env: { MULTITERMINAL_NAME: 'Henry' } });
    ok(!r.stdout, 'post → no stdout');
    const post = h.calls.find(c => c.method === 'POST');
    ok(post && post.body.query === 'how to foo', 'POST body carries query');
    ok(post.body.sourceAgent === 'Henry', 'POST body carries agent name');
    ok(post.body.tags === 'auto-cached,websearch', 'POST tags include lowercased tool');
  }

  // ── 6. Post error output → skip save ──
  {
    const h = stubHttp();
    const r = await run({ tool_name: 'WebSearch', tool_input: { query: 'how to foo' }, tool_output: 'Error: request failed and this text is padded past fifty characters total' }, { httpRequest: h, env: {} });
    ok(!h.calls.some(c => c.method === 'POST'), 'error output → no save');
  }

  // ── 7. Post short output → skip save ──
  {
    const h = stubHttp();
    const r = await run({ tool_name: 'WebSearch', tool_input: { query: 'how to foo' }, tool_output: 'short' }, { httpRequest: h, env: {} });
    ok(!h.calls.some(c => c.method === 'POST'), 'short output → no save');
  }

  console.log(`research-cache run() unit: PASS (${passed} assertions)`);
}

main().catch((e) => { console.error(e); process.exit(1); });

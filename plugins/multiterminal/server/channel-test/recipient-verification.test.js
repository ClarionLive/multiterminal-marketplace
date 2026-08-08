#!/usr/bin/env node
/**
 * multiterminal-channel.mjs recipient-verification + dedup suite (ticket 6b093a22, GH#7).
 *
 * The defect: this server accepted ANY POST to its port and injected it into the
 * agent's session. MT delivers to the recipient's LAST RECORDED port and treats any
 * 2xx as proof of delivery, so a stale/reused port silently routed one agent's
 * messages into another agent's session while the broker marked them delivered.
 * That is GH#7's "Diana loses everything while Eve receives fine" signature, and it
 * is unfixable broker-side — only the process owning the port knows who it is.
 *
 * Runs the REAL server as a subprocess (not a reimplementation of its logic), with
 * MT_API_URL pointed at an unreachable host so the test cannot pollute the live
 * MultiTerminal registry with a fake terminal.
 *
 * Run: node recipient-verification.test.js
 */
// ESM, not CommonJS: server/package.json declares "type": "module", so a .js file
// here is an ES module. (The hooks/ suites are CJS because that directory isn't.)
import assert from 'node:assert';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, '..', 'multiterminal-channel.mjs');
const AGENT = 'TestAgent';

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed++; }

function canBind(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

/**
 * Pick a free port INSIDE 8800-8899.
 *
 * Not an arbitrary ephemeral port: multiterminal-channel.mjs's tryListen() calls
 * process.exit(1) the moment a candidate exceeds 8899, so handing it an OS-assigned
 * high port makes the server die at startup with "All ports in range 8800-8899 are
 * in use". Scans DOWNWARD from the top of the range because MultiTerminal allocates
 * real terminals upward from 8801 — this keeps the test away from live agents.
 */
async function freePort() {
  for (let port = 8899; port >= 8800; port--) {
    if (await canBind(port)) return port;
  }
  throw new Error('No free port in 8800-8899 for the test server.');
}

function post(port, urlPath, payload) {
  return new Promise((resolve, reject) => {
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(data); } catch { /* non-JSON body is a valid outcome to assert on */ }
          resolve({ status: res.statusCode, json, raw: data });
        });
      });
    req.on('error', reject);
    req.end(body);
  });
}

function getHealth(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health' }, (res) => {
      let d = ''; res.on('data', c => (d += c)); res.on('end', () => resolve(d));
    });
    req.on('error', reject);
  });
}

async function waitForServer(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await getHealth(port); return true; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 150));
  }
  return false;
}

async function main() {
  const port = await freePort();

  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      CHANNEL_PORT: String(port),
      MULTITERMINAL_NAME: AGENT,
      // Unreachable on purpose: the server's port-registration must NOT reach the real
      // MultiTerminal API and register a bogus "TestAgent" terminal.
      MT_API_URL: 'http://127.0.0.1:1',
      MULTITERMINAL_ID: 'test-terminal-id',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Keep the child's output so a startup failure reports WHY rather than just
  // "server came up: false".
  let childErr = '';
  child.stdout.resume();
  child.stderr.on('data', (c) => (childErr += c));
  child.on('error', (e) => (childErr += `spawn error: ${e.message}\n`));

  try {
    const up = await waitForServer(port);
    ok(up, `server came up on 127.0.0.1:${port}\n--- child stderr ---\n${childErr || '(none)'}`);
    console.log(`  ✓ real channel server running as ${AGENT} on ${port}`);

    // ── T1: correctly addressed message is delivered ──────────────────────────
    {
      const r = await post(port, '/message', { from: 'Sender', message: 'hello', id: 't1', to: AGENT });
      ok(r.status === 200, `T1 expected 200, got ${r.status}`);
      ok(r.json?.status === 'delivered', `T1 expected delivered, got ${JSON.stringify(r.json)}`);
      console.log('  ✓ T1 message addressed to us → 200 delivered');
    }

    // ── T2: THE FIX — a message for someone else is refused, and NOT with a 2xx ─
    {
      const r = await post(port, '/message', { from: 'Sender', message: 'for Diana', id: 't2', to: 'Diana' });
      ok(r.status === 409, `T2 expected 409, got ${r.status}`);
      ok(r.json?.status === 'wrong_recipient', `T2 expected wrong_recipient, got ${JSON.stringify(r.json)}`);
      ok(r.json?.addressedTo === 'Diana', 'T2 response names the intended recipient');
      // The status code is the load-bearing part: MT treats ANY 2xx as delivered, so a
      // 200 here is precisely how misrouted messages used to be marked delivered and lost.
      ok(r.status < 200 || r.status >= 300, 'T2 response is NOT 2xx — the queue row must stay retryable');
      console.log('  ✓ T2 message addressed to another agent → 409 wrong_recipient (non-2xx, stays retryable)');
    }

    // ── T3: BACKWARD COMPATIBILITY — no `to` at all must still be delivered ────
    // Pre-405273fd MT builds omit the field. Rejecting these would silently break
    // messaging for every agent running an older backend.
    {
      const r = await post(port, '/message', { from: 'Sender', message: 'legacy payload', id: 't3' });
      ok(r.status === 200, `T3 expected 200, got ${r.status}`);
      ok(r.json?.status === 'delivered', `T3 legacy payload must be delivered, got ${JSON.stringify(r.json)}`);
      console.log('  ✓ T3 legacy payload with no `to` → still delivered (no lockout of older MT builds)');
    }

    // ── T4: recipient match is case-insensitive ───────────────────────────────
    {
      const r = await post(port, '/message', { from: 'Sender', message: 'shouty', id: 't4', to: AGENT.toUpperCase() });
      ok(r.status === 200, `T4 expected 200, got ${r.status}`);
      ok(r.json?.status === 'delivered', 'T4 case-insensitive recipient match');
      console.log('  ✓ T4 `to` differing only in case → delivered');
    }

    // ── T5: replay of the same id is ignored, but with a 2xx ──────────────────
    {
      const first = await post(port, '/message', { from: 'Sender', message: 'once', id: 'dup-1', to: AGENT });
      ok(first.json?.status === 'delivered', 'T5 first send delivered');

      const second = await post(port, '/message', { from: 'Sender', message: 'once', id: 'dup-1', to: AGENT });
      ok(second.status === 200, `T5 expected 200 on duplicate, got ${second.status}`);
      ok(second.json?.status === 'duplicate_ignored', `T5 expected duplicate_ignored, got ${JSON.stringify(second.json)}`);
      // 2xx on purpose: it DID reach the agent, just earlier. A non-2xx would make MT
      // retry forever a message the agent has already seen.
      console.log('  ✓ T5 replayed id → 200 duplicate_ignored (not re-injected, not retried forever)');
    }

    // ── T6: NEGATIVE FIXTURE — dedup keys on id, it does not smother traffic ───
    {
      const a = await post(port, '/message', { from: 'Sender', message: 'first', id: 'distinct-a', to: AGENT });
      const b = await post(port, '/message', { from: 'Sender', message: 'second', id: 'distinct-b', to: AGENT });
      ok(a.json?.status === 'delivered', 'T6 distinct id a delivered');
      ok(b.json?.status === 'delivered', 'T6 distinct id b delivered');
      console.log('  ✓ T6 distinct ids → both delivered (dedup keys on id, not "seen something like this")');
    }

    // ── T7: NEGATIVE FIXTURE — no id means no dedup, never a silent drop ───────
    {
      const a = await post(port, '/message', { from: 'Sender', message: 'idless', to: AGENT });
      const b = await post(port, '/message', { from: 'Sender', message: 'idless', to: AGENT });
      ok(a.json?.status === 'delivered', 'T7 first id-less message delivered');
      ok(b.json?.status === 'delivered', 'T7 second id-less message delivered — absent id must not dedup');
      console.log('  ✓ T7 payloads with no id → both delivered (nothing to key on, so never dropped)');
    }

    console.log(`\nAll ${passed} assertions passed.`);
  } finally {
    child.kill();
  }
}

main().catch((err) => {
  console.error(`\nFAILED: ${err.message}`);
  process.exit(1);
});

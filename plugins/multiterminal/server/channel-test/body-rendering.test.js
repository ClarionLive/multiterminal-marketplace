#!/usr/bin/env node
/**
 * multiterminal-channel.mjs body-rendering suite (ticket 6b093a22 defect 1, GH#7).
 *
 * THE DEFECT: both POST handlers resolved the message body with
 *
 *     const content = msg.message || msg.content || body;
 *
 * An EMPTY STRING is falsy, so a message whose body was empty fell through the
 * whole chain to `body` — the RAW REQUEST TEXT — and the agent was shown
 * `{"from":"Bob","message":"","id":42,...}` as though Bob had typed that JSON.
 * Verified live on message 6889. Rendering an envelope as content is worse than
 * rendering nothing: it is indistinguishable from a sender who really did type
 * JSON, so the reader cannot tell a delivery bug from a strange colleague.
 *
 * WHY THIS SUITE ASSERTS ON INJECTED CONTENT, NOT ON HTTP STATUS: every case
 * below returned 200 "delivered" both before and after the fix. The status code
 * cannot see this bug — only the rendered body can. So the suite reads the real
 * `notifications/claude/channel` JSON-RPC frames off the server's stdout, which
 * is what the Claude Code session would have been shown.
 *
 * Like recipient-verification.test.js, this runs the REAL server as a subprocess
 * rather than reimplementing its logic, with MT_API_URL pointed at an
 * unreachable host so the test cannot register a bogus terminal with the live
 * MultiTerminal.
 *
 * Run: node body-rendering.test.js
 */
// ESM, not CommonJS: server/package.json declares "type": "module".
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

/**
 * The envelope keys that must NEVER appear in rendered content. This is the
 * actual regression guard: the old code leaked the whole request body here.
 */
function assertNotTheEnvelope(content, label) {
  ok(typeof content === 'string', `${label}: content is a string`);
  ok(!/"from"\s*:/.test(content), `${label}: rendered content must not contain the envelope's "from" key`);
  ok(!/"priority"\s*:/.test(content), `${label}: rendered content must not contain the envelope's "priority" key`);
  ok(!content.trim().startsWith('{'), `${label}: rendered content must not be a JSON object dump`);
}

function canBind(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

/**
 * Pick a free port INSIDE 8800-8899 — tryListen() process.exit(1)s above 8899,
 * so an OS-assigned ephemeral port kills the server at startup. Scans DOWNWARD
 * because MultiTerminal allocates real terminals upward from 8801.
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
          try { json = JSON.parse(data); } catch { /* non-JSON body is a valid outcome */ }
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
      // Unreachable on purpose: port-registration must NOT reach the real
      // MultiTerminal API and register a bogus "TestAgent" terminal.
      MT_API_URL: 'http://127.0.0.1:1',
      MULTITERMINAL_ID: 'test-terminal-id',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // The server speaks MCP over stdout as newline-delimited JSON-RPC. Nobody here
  // completes an initialize handshake, but the notifications are still written —
  // which is exactly the payload a Claude Code session would have received.
  const notifications = [];
  let stdoutBuf = '';
  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk;
    let nl;
    while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, nl).trim();
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line) continue;
      try {
        const frame = JSON.parse(line);
        if (frame.method === 'notifications/claude/channel') notifications.push(frame.params);
      } catch { /* non-JSON stdout is not a notification */ }
    }
  });

  let childErr = '';
  child.stderr.on('data', (c) => (childErr += c));
  child.on('error', (e) => (childErr += `spawn error: ${e.message}\n`));

  /** POST, then wait for the notification that POST produced (if any). */
  async function deliver(urlPath, payload, timeoutMs = 4000) {
    const before = notifications.length;
    const res = await post(port, urlPath, payload);
    const deadline = Date.now() + timeoutMs;
    while (notifications.length === before && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 25));
    }
    return { res, params: notifications[before] ?? null, injected: notifications.length > before };
  }

  try {
    const up = await waitForServer(port);
    ok(up, `server came up on 127.0.0.1:${port}\n--- child stderr ---\n${childErr || '(none)'}`);
    console.log(`  ✓ real channel server running as ${AGENT} on ${port}`);

    // ── B1: NEGATIVE FIXTURE — a real message is still rendered verbatim ───────
    // The fix must not "clean up" ordinary traffic. If this ever fails, the
    // marker logic has started eating real messages.
    {
      const { res, params } = await deliver('/message', { from: 'Bob', message: 'build is green', id: 'b1', to: AGENT });
      ok(res.status === 200, `B1 expected 200, got ${res.status}`);
      ok(params?.content === 'build is green', `B1 expected verbatim body, got ${JSON.stringify(params?.content)}`);
      console.log('  ✓ B1 ordinary message → rendered verbatim (fix does not touch healthy traffic)');
    }

    // ── B2: THE FIX — empty body renders a marker, NOT the raw envelope ───────
    // Pre-fix this injected `{"from":"Bob","message":"","id":"b2","to":"TestAgent"}`
    // as the message content. Both then and now the HTTP status is 200
    // "delivered", which is why status-only assertions cannot see this bug.
    {
      const { res, params } = await deliver('/message', { from: 'Bob', message: '', id: 'b2', to: AGENT });
      ok(res.status === 200, `B2 expected 200, got ${res.status}`);
      ok(params !== null, 'B2 an empty-bodied message is still delivered (marker, not silence)');
      ok(params.content.startsWith('(empty message'), `B2 expected the empty marker, got ${JSON.stringify(params.content)}`);
      assertNotTheEnvelope(params.content, 'B2');
      console.log('  ✓ B2 empty body → "(empty message …)" marker, envelope never leaked');
    }

    // ── B3: whitespace-only is empty too ──────────────────────────────────────
    // Matches MT's own store-side guard (MessageBroker.SendMessage uses
    // IsNullOrWhiteSpace, commit 6f89d11), so the two ends agree on "blank".
    {
      const { params } = await deliver('/message', { from: 'Bob', message: '   \n\t ', id: 'b3', to: AGENT });
      ok(params?.content.startsWith('(empty message'), `B3 expected the empty marker, got ${JSON.stringify(params?.content)}`);
      assertNotTheEnvelope(params.content, 'B3');
      console.log('  ✓ B3 whitespace-only body → empty marker (agrees with MT-side IsNullOrWhiteSpace)');
    }

    // ── B4: BACKWARD COMPATIBILITY — the shape fallback still works ───────────
    // The `message || content` chain was defensive about a MISSING key and that
    // property is load-bearing: the inbox-file shape uses `Content`. The fix
    // removes the empty-string fall-through WITHOUT removing shape tolerance.
    {
      const { params } = await deliver('/message', { from: 'Bob', content: 'via the content key', id: 'b4', to: AGENT });
      ok(params?.content === 'via the content key', `B4 expected content-key fallback, got ${JSON.stringify(params?.content)}`);
      console.log('  ✓ B4 `content` key instead of `message` → still rendered (shape tolerance preserved)');
    }

    // ── B5: an empty key must not shadow a filled sibling ─────────────────────
    {
      const { params } = await deliver('/message', { from: 'Bob', message: '', content: 'the real text', id: 'b5', to: AGENT });
      ok(params?.content === 'the real text', `B5 first NON-EMPTY key should win, got ${JSON.stringify(params?.content)}`);
      console.log('  ✓ B5 empty `message` + filled `content` → the filled one wins');
    }

    // ── B6: unrecognised shape is LABELLED, never passed off as a message ─────
    // The old code dumped the envelope here as if the sender had typed it. The
    // payload is still shown (dropping it silently is defect 2's bug, in
    // inbox-check-hook.js) — but explicitly marked as a payload, and bounded.
    {
      const { params } = await deliver('/message', { from: 'Bob', bodyText: 'wrong key entirely', id: 'b6', to: AGENT });
      ok(params !== null, 'B6 unrecognised shape is still surfaced, not silently dropped');
      ok(params.content.startsWith('(unrecognised message payload'), `B6 expected the unrecognised marker, got ${JSON.stringify(params.content)}`);
      ok(!params.content.trim().startsWith('{'), 'B6 content is a labelled diagnostic, not a bare JSON dump');
      console.log('  ✓ B6 no body key at all → labelled "(unrecognised message payload …)" diagnostic');
    }

    // ── B7: an explicit null body is empty, not unrecognised ──────────────────
    {
      const { params } = await deliver('/message', { from: 'Bob', message: null, id: 'b7', to: AGENT });
      ok(params?.content.startsWith('(empty message'), `B7 expected the empty marker, got ${JSON.stringify(params?.content)}`);
      console.log('  ✓ B7 `message: null` → empty marker (key present, value absent)');
    }

    // ── B8: a non-string body no longer 400s ─────────────────────────────────
    // Pre-fix, `content.substring(0, 80)` on the log line threw TypeError for a
    // numeric body, so the send was answered 400 and the sender saw a failure
    // for a message that was structurally fine.
    {
      const { res, params } = await deliver('/message', { from: 'Bob', message: 42, id: 'b8', to: AGENT });
      ok(res.status === 200, `B8 expected 200, got ${res.status} (raw: ${res.raw})`);
      ok(params?.content === '42', `B8 expected stringified body, got ${JSON.stringify(params?.content)}`);
      console.log('  ✓ B8 numeric body → stringified and delivered (was a 400 from content.substring)');
    }

    // ── B9: /broadcast had the SAME defect and is fixed too ───────────────────
    // The ticket recorded only the POST /message site. `/broadcast` skips
    // recipient VERIFICATION on purpose (a broadcast has no meaningful `to`);
    // it was never exempt from body rendering.
    {
      const { res, params } = await deliver('/broadcast', { from: 'Bob', message: '' });
      ok(res.status === 200, `B9 expected 200, got ${res.status}`);
      ok(params?.content.startsWith('(empty message'), `B9 broadcast expected the empty marker, got ${JSON.stringify(params?.content)}`);
      assertNotTheEnvelope(params.content, 'B9');
      ok(params.meta?.message_type === 'broadcast', 'B9 is genuinely the broadcast path');
      console.log('  ✓ B9 /broadcast empty body → same marker (second copy of the defect, closed)');
    }

    // ── B10: the inbox-file shape is understood, not treated as unrecognised ──
    // The `meta.from` assertion is the load-bearing half. An earlier revision
    // understood this payload's BODY but still read the sender as `msg.from`
    // only, so it rendered the right text attributed to "unknown" — a
    // half-understood payload, and the test that omitted this line baked it in.
    {
      const { params } = await deliver('/message', { Sender: 'Bob', Content: 'file-shaped payload', id: 'b10', to: AGENT });
      ok(params?.content === 'file-shaped payload', `B10 expected Content-key support, got ${JSON.stringify(params?.content)}`);
      ok(params?.meta?.from === 'Bob', `B10 sender must resolve from Sender too, got ${JSON.stringify(params?.meta?.from)}`);
      console.log('  ✓ B10 inbox-file shape (`Content`/`Sender`) → body AND sender both resolved');
    }

    // ── B11: an object-valued body must not become "[object Object]" ──────────
    // `String(value)` silently destroyed structured content with no diagnostic —
    // the exact class of loss this ticket exists to close, reintroduced by the
    // fix for it. Three pipeline gates flagged this independently.
    {
      const { params } = await deliver('/message', { from: 'Bob', message: { type: 'text', text: 'real words' }, id: 'b11', to: AGENT });
      ok(!params?.content.includes('[object Object]'), `B11 structured body must not stringify to [object Object], got ${JSON.stringify(params?.content)}`);
      ok(params?.content.includes('real words'), `B11 structured body must stay readable, got ${JSON.stringify(params?.content)}`);
      console.log('  ✓ B11 object-valued body → JSON-rendered, content preserved');
    }

    // ── B12: sender key precedence matches the inbox hook exactly ─────────────
    // Both files now share one ordered key list. If someone re-inverts one of
    // them, this and the hook's D12 disagree and the drift is caught.
    {
      const { params } = await deliver('/message', { from: 'Bob', sender: 'NotBob', message: 'precedence', id: 'b12', to: AGENT });
      ok(params?.meta?.from === 'Bob', `B12 'from' must win over 'sender', got ${JSON.stringify(params?.meta?.from)}`);
      console.log('  ✓ B12 sender precedence: from > sender (same order as the hook)');
    }

    // ── B13: THE PROCESS MUST SURVIVE AN ABORTED REQUEST ──────────────────────
    // The body-read loop used to sit OUTSIDE the try/catch. A client that
    // disconnected mid-body rejected the async iterator, and because the request
    // handler is async that became an unhandled rejection: THE WHOLE PROCESS
    // EXITED(1), taking channel delivery and the agent's reply/send MCP tools
    // with it. One truncated POST to localhost was enough.
    {
      await new Promise((resolve) => {
        const req = http.request(
          { host: '127.0.0.1', port, path: '/message', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': '500' } },
          () => resolve());
        req.on('error', () => resolve()); // the abort surfaces here; that's expected
        req.write('{"from":"Bob","message":"truncated'); // far short of Content-Length
        setTimeout(() => { req.destroy(); resolve(); }, 100);
      });
      await new Promise(r => setTimeout(r, 400));

      // Still alive? Both checks matter: health proves the process, delivery
      // proves the handler still works rather than merely the socket accepting.
      let health = null;
      try { health = await getHealth(port); } catch { /* server died */ }
      ok(health !== null, 'B13 server must survive a client that aborts mid-body (it used to exit code 1)');

      const { res, params } = await deliver('/message', { from: 'Bob', message: 'still here', id: 'b13', to: AGENT });
      ok(res.status === 200, `B13 expected the server to keep serving, got ${res.status}`);
      ok(params?.content === 'still here', 'B13 delivery still works after an aborted request');
      console.log('  ✓ B13 aborted mid-body POST → server survives and keeps delivering');
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

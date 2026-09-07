#!/usr/bin/env node
/**
 * multiterminal-channel.mjs adoption LATENCY suite (ticket c9285d2a, checklist item 2).
 *
 * ─── Why this suite exists, and why the obvious test would have been useless ───────────────
 *
 * Item 2 shipped working adoption and a broken promise. Its acceptance criterion was
 * "add a faster initial poll that backs off, since 30s is too slow to feel interactive",
 * and the delivered code polled on a ramp that settled at 30s. It built clean, passed three
 * pipeline runs and a Run 3b verifier PASS, and the defect surfaced the first time a human
 * actually registered a terminal:
 *
 *     registered ~8s into the process's life  ->  reachable after  8.1s
 *     registered past the ramp                ->  reachable after 30.2s
 *
 * Same code, same machine. The only variable was when the person typed.
 *
 * Every existing test missed it because they all assert that adoption EVENTUALLY succeeds,
 * which is true at ANY latency — including 30s, including 30 minutes. That is the fifth time
 * on this ticket that a fact asserted an ACT rather than what the act is FOR. So these two
 * facts deliberately assert TIMING and nothing else; adoption succeeding is a precondition
 * here, not the claim.
 *
 * ─── Falsifiability (the property that makes these facts worth having) ─────────────────────
 *
 * Both facts FAIL against the pre-fix schedule. Poll times from process start:
 *
 *   old [500,500,1000,1000,2000,3000,5000,10000,30000]  ->  0 .5 1 2 3 5 8 13 23 53 83 ...
 *   new [500,500,1000,1000,2000,3000]                   ->  0 .5 1 2 3 5 8 11 14 17 20 23 26 ...
 *
 *   FACT 1 (tail):    old steady gap = 30s   vs  assertion <= 3.5s   -> FAILS
 *   FACT 2 (latency): claim appears at t=25s; old next poll is t=53s -> 28s, vs <= 8s -> FAILS
 *                     new next poll is t=26s -> ~1s                             -> passes
 *
 * The t=25s claim instant is not arbitrary: it sits AFTER the old ramp's last short step
 * (t=23) and BEFORE its next (t=53), which is the widest part of the old schedule and the
 * exact window a real user lands in. A claim planted early would be caught quickly by BOTH
 * schedules and the suite would go green on the bug — the precise trap this file exists to
 * avoid.
 *
 * ─── Isolation ────────────────────────────────────────────────────────────────────────────
 *
 * Runs the REAL server as a subprocess (not a reimplementation), with MT_API_URL pointed at a
 * fake broker inside this process, so it cannot read or pollute the live MultiTerminal
 * registry. MULTITERMINAL_NAME is explicitly deleted from the child env: an inherited name
 * would bind the server at boot and skip waitForAdoption() entirely, making both facts vacuous.
 *
 * Costs ~30s of wall clock. That is deliberate — the defect is measured in tens of seconds, so
 * a fast test cannot see it. Large margins were chosen over speed because a flaky timing test
 * on THIS ticket would be worse than a slow one.
 *
 * Run: node adoption-latency.test.js
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
const ADOPTED_NAME = 'LatencyProbe';

/** Plant the claim here — inside the old schedule's widest gap (23s..53s). See header. */
const CLAIM_AT_MS = 25_000;
/** FACT 2 threshold. New schedule delivers ~1s; old delivers 28s. */
const MAX_ADOPTION_LATENCY_MS = 8_000;
/** FACT 1 threshold. New tail is 3s; old tail is 30s. Allows jitter without admitting 30s. */
const MAX_STEADY_POLL_GAP_MS = 3_500;
/** Give the run headroom past the claim before declaring failure. */
const OVERALL_TIMEOUT_MS = 45_000;

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed++; console.log(`  ok - ${msg}`); }

function canBind(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

/**
 * Pick a free port INSIDE 8800-8899 for the child's CHANNEL_PORT.
 *
 * Not an arbitrary ephemeral port: the server's tryListen() falls back within that band, and
 * a live MultiTerminal on this machine already holds the low ones (8800/8801/8802 were all in
 * use during this ticket's live run). Scanning downward from the top keeps the test clear of
 * real terminals.
 */
async function freeChannelPort() {
  for (let p = 8899; p >= 8850; p--) {
    if (await canBind(p)) return p;
  }
  throw new Error('no free port in 8850-8899 for the child channel server');
}

async function main() {
  const channelPort = await freeChannelPort();

  // ─── Fake broker ────────────────────────────────────────────────────────────────────────
  const identityPolls = [];      // ms since child spawn, one entry per channel-identity GET
  let registerPost = null;       // first POST /api/messaging/register body + timestamp
  let claimEnabledAt = null;     // when the fake broker started answering with a name
  let t0 = null;                 // child spawn instant

  const broker = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const now = Date.now();

    if (url.pathname === '/api/messaging/channel-identity') {
      identityPolls.push(now - t0);
      const claiming = claimEnabledAt !== null && now >= claimEnabledAt;
      if (!claiming) {
        // 404 is the server's normal "nobody has claimed a name" answer.
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
         .end(JSON.stringify({ name: ADOPTED_NAME, ppid: url.searchParams.get('ppid') }));
      return;
    }

    if (url.pathname === '/api/messaging/register' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        if (!registerPost) {
          let parsed = null;
          try { parsed = JSON.parse(body); } catch { /* recorded as null below */ }
          registerPost = { at: now - t0, body: parsed };
        }
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
      });
      return;
    }

    if (url.pathname === '/api/messaging/terminals') {
      // The server verifies its port "stuck" by reading this back. Reflect whatever it sent,
      // so registerPortOnce() returns true and adoption completes rather than retrying.
      const list = registerPost?.body
        ? [{ name: registerPost.body.name, channelPort: registerPost.body.channelPort }]
        : [];
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(list));
      return;
    }

    res.writeHead(404).end();
  });

  await new Promise((r) => broker.listen(0, '127.0.0.1', r));
  const brokerPort = broker.address().port;

  // ─── Spawn the REAL server, deliberately nameless ───────────────────────────────────────
  const env = { ...process.env };
  delete env.MULTITERMINAL_NAME;        // MUST be unset: a named server never calls waitForAdoption()
  delete env.MULTITERMINAL_LAUNCH_NONCE;
  env.MT_API_URL = `http://127.0.0.1:${brokerPort}`;
  env.CHANNEL_PORT = String(channelPort);

  t0 = Date.now();
  const child = spawn(process.execPath, [SERVER], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });

  const cleanup = () => {
    try { child.kill(); } catch { /* already gone */ }
    try { broker.close(); } catch { /* already closed */ }
  };

  try {
    // Let the ramp run out, then plant the claim inside the old schedule's widest gap.
    await new Promise((r) => setTimeout(r, CLAIM_AT_MS));
    claimEnabledAt = Date.now();

    // Wait for adoption to actually complete (the port report), or time out.
    const deadline = Date.now() + (OVERALL_TIMEOUT_MS - CLAIM_AT_MS);
    while (!registerPost && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }

    console.log(`\nadoption-latency (channelPort=${channelPort}, brokerPort=${brokerPort})`);
    console.log(`  poll times since spawn (ms): ${identityPolls.join(', ')}`);

    // ─── FACT 1: the steady-state tail is short ───────────────────────────────────────────
    // Pins the SCHEDULE directly. Old tail 30s; asserted <= 3.5s. Gaps are measured only
    // after the ramp (>5s in), since the ramp's own sub-second steps would flatter the result.
    const tailPolls = identityPolls.filter((t) => t > 5_000 && t < CLAIM_AT_MS);
    assert.ok(
      tailPolls.length >= 3,
      `expected several polls between the ramp and the claim; saw ${tailPolls.length}. ` +
      `A 30s tail produces at most one here — which is itself the bug.`,
    );
    const gaps = tailPolls.slice(1).map((t, i) => t - tailPolls[i]);
    const worstGap = Math.max(...gaps);
    ok(
      worstGap <= MAX_STEADY_POLL_GAP_MS,
      `steady-state poll gap is ${worstGap}ms (<= ${MAX_STEADY_POLL_GAP_MS}ms). ` +
      `The pre-fix tail was 30000ms, so this fails against the old schedule.`,
    );

    // ─── FACT 2: a LATE claim is still discovered promptly, and adoption completes ────────
    // This is the user-visible promise: it should not matter whether you register at second 3
    // or minute 30. Old schedule would not poll again until t=53s -> ~28s latency.
    assert.ok(
      registerPost,
      `server never reported its port within ${OVERALL_TIMEOUT_MS}ms of spawn. ` +
      `Adoption did not complete at all.\n--- child stderr ---\n${stderr}`,
    );
    const discoveryPoll = identityPolls.find((t) => t0 + t >= claimEnabledAt);
    assert.ok(discoveryPoll !== undefined, 'no poll observed at or after the claim was planted');
    const latency = (t0 + discoveryPoll) - claimEnabledAt;
    ok(
      latency <= MAX_ADOPTION_LATENCY_MS,
      `a claim planted ${CLAIM_AT_MS}ms after start was discovered ${latency}ms later ` +
      `(<= ${MAX_ADOPTION_LATENCY_MS}ms). The old schedule's next poll was ~28s away.`,
    );

    // Precondition, not the claim: prove the timing above describes REAL adoption.
    ok(
      registerPost.body?.name === ADOPTED_NAME,
      `adoption actually happened and bound the claimed name ` +
      `(reported '${registerPost.body?.name}' on port ${registerPost.body?.channelPort})`,
    );
    ok(
      registerPost.body?.ownerPid === process.pid,
      `port report carries this test process's pid as ownerPid (${registerPost.body?.ownerPid}) — ` +
      `the ppid correlation item 2 is built on`,
    );

    console.log(`\n${passed} assertions passed`);
  } finally {
    cleanup();
  }
}

main().catch((err) => {
  console.error(`\nFAILED: ${err.message}`);
  process.exit(1);
});

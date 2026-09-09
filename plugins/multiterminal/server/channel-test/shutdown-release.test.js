#!/usr/bin/env node
/**
 * multiterminal-channel.mjs shutdown-release suite (ticket d1151661, checklist item 1).
 *
 * ─── What this is for ──────────────────────────────────────────────────────────────────────
 *
 * Owner report: "/quit and Robin is still in the Terminals list even though his terminal is
 * gone." For an ADOPTED session there was no release path at all — the SessionEnd hook
 * early-returns when MULTITERMINAL_NAME is unset (the defining property of adoption),
 * UnregisterTerminal needs a docId such a row never has, this server had NO exit handling
 * whatsoever, and there is no reaper. Four ways to release a row, none of them reachable.
 *
 * ─── Why stdin, and not just signals ───────────────────────────────────────────────────────
 *
 * The obvious implementation is a SIGTERM handler, and on Windows it would be DEAD CODE:
 * `process.kill(pid, 'SIGTERM')` maps to TerminateProcess and no handler runs. MT ships on
 * Windows. The portable shutdown that genuinely happens to a stdio MCP server is the parent
 * closing our stdin, so that is the path these facts exercise — deliberately, because a suite
 * that only tested signals would pass on POSIX and certify nothing about the platform in use.
 *
 * ─── FACT 2 is the load-bearing one ────────────────────────────────────────────────────────
 *
 * Registering ANY listener for SIGINT/SIGTERM SUPPRESSES Node's default handler — the one that
 * terminates the process. So the naive version of this feature stops Ctrl+C from stopping the
 * server, and the same shape applies to the stdin path: releasing the row but never exiting
 * leaves a process holding a channel port after its parent is gone. FACT 1 passes happily in
 * that world; only FACT 2 sees it. That is the same trap this ticket's other half documents —
 * the intuitive assertion is structurally unable to observe the dangerous mistake.
 *
 * ─── Isolation ─────────────────────────────────────────────────────────────────────────────
 *
 * Runs the REAL server as a subprocess against a fake broker inside this process, so it can
 * neither read nor pollute the live MultiTerminal registry.
 *
 * Run: node shutdown-release.test.js
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
const AGENT = 'ShutdownProbe';

/** The server's own cap is RELEASE_TIMEOUT_MS = 1500. Allow room without admitting a hang. */
const MAX_HUNG_SHUTDOWN_MS = 6_000;
/** A healthy release is a loopback POST; this is generous. */
const MAX_SHUTDOWN_MS = 10_000;
/** How long a dormant server is given to prove it is polling before we close its stdin. */
const DORMANT_SETTLE_MS = 2_000;

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed++; console.log(`  ✓ ${msg}`); }

function canBind(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

/** Same reasoning as the adoption-latency suite: stay inside 8800-8899 but clear of real terminals. */
async function freeChannelPort() {
  for (let p = 8899; p >= 8850; p--) {
    if (await canBind(p)) return p;
  }
  throw new Error('no free port in 8850-8899 for the child channel server');
}

/**
 * A fake MT. `hangDisconnect` makes /api/messaging/disconnect accept the connection and then
 * never answer — the half-dead broker that FACT 4 says must not be able to hold a terminal open.
 */
function startBroker({ hangDisconnect = false } = {}) {
  const state = { disconnects: [], registerBody: null, identityPolls: 0 };
  const heldSockets = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');

    if (url.pathname === '/api/messaging/disconnect' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(body); } catch { /* recorded as null */ }
        state.disconnects.push(parsed);
        if (hangDisconnect) {
          heldSockets.push(req.socket);   // accepted, never answered
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
      });
      return;
    }

    if (url.pathname === '/api/messaging/register' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try { state.registerBody = JSON.parse(body); } catch { /* left null */ }
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
      });
      return;
    }

    if (url.pathname === '/api/messaging/terminals') {
      const list = state.registerBody
        ? [{ name: state.registerBody.name, channelPort: state.registerBody.channelPort }]
        : [];
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(list));
      return;
    }

    if (url.pathname === '/api/messaging/channel-identity') {
      state.identityPolls++;
      res.writeHead(404).end();          // nobody ever claims a name: keeps a dormant server dormant
      return;
    }

    res.writeHead(404).end();
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        state,
        port: server.address().port,
        close: () => {
          for (const s of heldSockets) { try { s.destroy(); } catch { /* gone */ } }
          try { server.close(); } catch { /* already closed */ }
        },
      });
    });
  });
}

function spawnServer({ brokerPort, channelPort, named }) {
  const env = { ...process.env };
  if (named) {
    env.MULTITERMINAL_NAME = AGENT;
  } else {
    // MUST be unset, or the server binds at boot and the dormant fact goes vacuous.
    delete env.MULTITERMINAL_NAME;
  }
  delete env.MULTITERMINAL_LAUNCH_NONCE;
  env.MT_API_URL = `http://127.0.0.1:${brokerPort}`;
  env.CHANNEL_PORT = String(channelPort);

  const child = spawn(process.execPath, [SERVER], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stdout.resume();
  child.stderr.on('data', (c) => { stderr += c; });

  const exited = new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal, at: Date.now() }));
  });

  return { child, exited, stderr: () => stderr };
}

function waitUntil(pred, timeoutMs, stepMs = 50) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (pred()) return resolve(true);
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(tick, stepMs);
    };
    tick();
  });
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((r) => setTimeout(() => r(null), ms))]);
}

async function main() {
  // ─── FACTS 1 & 2: a bound server releases its name on stdin close, AND exits ─────────────
  {
    const channelPort = await freeChannelPort();
    const broker = await startBroker();
    const { child, exited, stderr } = spawnServer({ brokerPort: broker.port, channelPort, named: true });

    try {
      // PRECONDITION: the server must actually be up and registered, or closing stdin proves
      // nothing about a terminal that was never in the roster to begin with.
      const registered = await waitUntil(() => broker.state.registerBody !== null, 15_000);
      assert.ok(registered,
        `server never reported its port, so it was never in the roster.\n--- stderr ---\n${stderr()}`);

      child.stdin.end();                 // the parent going away: the real MCP shutdown

      const gone = await withTimeout(exited, MAX_SHUTDOWN_MS);

      // FACT 1 — the row is released, by name.
      ok(
        broker.state.disconnects.length === 1 && broker.state.disconnects[0]?.name === AGENT,
        `closing stdin POSTs exactly one disconnect naming "${AGENT}" ` +
        `(saw ${JSON.stringify(broker.state.disconnects)})`,
      );

      // FACT 2 — ⚠️ THE LOAD-BEARING ONE. Release WITHOUT exit leaves a process holding a
      // channel port after its parent is gone, and FACT 1 cannot see that at all.
      ok(
        gone !== null,
        `the process actually EXITS after releasing (within ${MAX_SHUTDOWN_MS}ms) — ` +
        `releasing without exiting would leak a process still holding port ${channelPort}`,
      );
    } finally {
      try { child.kill(); } catch { /* already gone */ }
      broker.close();
    }
  }

  // ─── FACT 3: a dormant server releases NOTHING ──────────────────────────────────────────
  {
    const channelPort = await freeChannelPort();
    const broker = await startBroker();
    const { child, exited, stderr } = spawnServer({ brokerPort: broker.port, channelPort, named: false });

    try {
      // PRECONDITION: prove it is genuinely dormant-and-polling rather than dead on arrival —
      // a server that crashed at boot would also "release nothing", vacuously.
      const polling = await waitUntil(() => broker.state.identityPolls > 0, 15_000);
      assert.ok(polling,
        `dormant server never polled for an identity, so it was not actually running.` +
        `\n--- stderr ---\n${stderr()}`);
      await new Promise((r) => setTimeout(r, DORMANT_SETTLE_MS));

      assert.ok(broker.state.registerBody === null,
        'a dormant server must not have registered a port; this fact is about an UNBOUND session');

      child.stdin.end();
      const gone = await withTimeout(exited, MAX_SHUTDOWN_MS);

      ok(
        broker.state.disconnects.length === 0,
        'a dormant (unbound) session releases NOTHING on shutdown — it never claimed a name, ' +
        'so it has none to give back and must not disconnect someone else\'s row',
      );
      ok(gone !== null, `a dormant session still exits cleanly on stdin close (within ${MAX_SHUTDOWN_MS}ms)`);
    } finally {
      try { child.kill(); } catch { /* already gone */ }
      broker.close();
    }
  }

  // ─── FACT 4: a hung broker cannot hold the shutdown open ────────────────────────────────
  {
    const channelPort = await freeChannelPort();
    const broker = await startBroker({ hangDisconnect: true });
    const { child, exited, stderr } = spawnServer({ brokerPort: broker.port, channelPort, named: true });

    try {
      const registered = await waitUntil(() => broker.state.registerBody !== null, 15_000);
      assert.ok(registered, `server never registered.\n--- stderr ---\n${stderr()}`);

      const t0 = Date.now();
      child.stdin.end();
      const gone = await withTimeout(exited, MAX_HUNG_SHUTDOWN_MS);

      // PRECONDITION: the POST must actually have been made and left hanging, or this fact is
      // just re-testing the happy path with extra steps.
      assert.ok(broker.state.disconnects.length === 1,
        'the hung-broker fact requires the disconnect to have been attempted and stalled');

      ok(
        gone !== null,
        `a broker that accepts the disconnect and never answers cannot hold shutdown past ` +
        `${MAX_HUNG_SHUTDOWN_MS}ms (took ${Date.now() - t0}ms) — the release timeout is what ` +
        `stops a half-dead MT from pinning a terminal open`,
      );
    } finally {
      try { child.kill(); } catch { /* already gone */ }
      broker.close();
    }
  }

  console.log(`\nAll ${passed} assertions passed.`);
}

main().catch((err) => {
  console.error(`\nFAILED: ${err.message}`);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * desktop-presence-hook.js
 *
 * Claude Code UserPromptSubmit hook. When the user submits a REAL desktop
 * prompt (keyboard input at the desk), this fires and flips
 * MessageBroker.IsRemoteMode to false — signaling "user is at the desk,
 * stop mirroring prompts to phone."
 *
 * IMPORTANT: INJECTED prompts from the phone (messages routed to desktop
 * Claude sessions by MultiTerminal) also fire UserPromptSubmit. Those must
 * NOT flip remoteMode off — the user is at the phone, not the desk. We
 * detect them by reading the JSON payload on stdin and testing the prompt
 * against INJECTED_PROMPT_MARKER, then skip the POST in that case.
 *
 * The marker is the "[MultiTerminal message from ...]" prefix MT writes on
 * every message it injects into a session. Missing it is a live, silent bug:
 * see the marker's own comment for what it cost.
 *
 * Paired with ClaudeRemote's MessagesProxy X-Source: phone header which
 * flips remote mode on. Together they auto-infer presence from user
 * actions without requiring a manual toggle.
 *
 * Idempotent on the MT side: SetRemoteMode short-circuits when the value
 * isn't changing, so firing this on every desktop prompt submission is cheap.
 *
 * Behavior:
 *   - stdin prompt was injected by MT → exit 0 silently (skip flip)
 *   - MT not reachable on loopback:5050 → exit 0 silently (fast path)
 *   - POST /api/remote-mode {enabled:false} → exit 0
 *   - Any error → exit 0 silently (never block Claude)
 */
const http = require('http');

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(''));
    setTimeout(() => resolve(data), 200);
  });
}

// A prompt MultiTerminal INJECTED, as opposed to one the Owner typed.
//
// MT injects into the session's named pipe (0ff1b520 item 4), and every such
// message begins "[MultiTerminal message from <name>]". That prefix is the only
// thing distinguishing it from typed input — there is no tag.
//
// ⚠️ MISSING THIS PREFIX FAILS SILENTLY.
// When this matched only the retired channel server's <channel> tag, a phone
// message arriving over the pipe was INDISTINGUISHABLE from
// keyboard input: the hook flipped remote mode OFF on the very message that had
// just armed it via ClaudeRemote's `X-Source: phone` header, so the Owner's reply
// died at ForwardMessagePushAsync's `if (!IsRemoteMode) return;` with no error
// anywhere. Observed live 2026-09-22, twice, before this line existed.
//
// ONE constant, used by BOTH the dispatcher path and the CLI shim below. They are
// separate code paths that must agree, and the cost of them disagreeing is this
// same invisible failure — so the marker does not get written out twice.
const INJECTED_PROMPT_MARKER = /^\s*\[MultiTerminal message from /m;

function isInjectedPrompt(stdinData) {
  if (!stdinData) return false;
  try {
    const payload = JSON.parse(stdinData);
    const prompt = payload.prompt || '';
    return INJECTED_PROMPT_MARKER.test(prompt);
  } catch {
    return INJECTED_PROMPT_MARKER.test(stdinData);
  }
}

function postRemoteModeOff() {
  return new Promise((resolve) => {
    const body = JSON.stringify({ enabled: false });
    const req = http.request(
      {
        host: '127.0.0.1',
        port: 5050,
        path: '/api/remote-mode',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        },
        timeout: 800
      },
      (res) => {
        res.resume();
        res.on('end', resolve);
      }
    );
    req.on('error', () => resolve());
    req.on('timeout', () => { req.destroy(); resolve(); });
    req.write(body);
    req.end();
  });
}

// ── Core (dispatcher-callable) ───────────────────────────────────────
// ASYNC class (async:true → async dispatch head under B2). Flips MT remote-mode
// off on a real desktop prompt; skips for MT-injected (phone) prompts. In
// the dispatcher, hookData is already parsed, so the marker is checked on
// hookData.prompt; postRemoteModeOff is injectable so tests don't hit :5050
// (ticket 42c91001). No stdout; always returns {exitCode: 0}.
async function run(hookData, deps = {}) {
  const _post = deps.postRemoteModeOff || postRemoteModeOff;
  try {
    const prompt = (hookData && hookData.prompt) || '';
    if (INJECTED_PROMPT_MARKER.test(prompt)) {
      // Injected by MT, not typed — the Owner did not touch the keyboard, so this is not evidence of desk presence.
      return { exitCode: 0 };
    }
    await _post();
  } catch {
    // swallow — hook must never block Claude
  }
  return { exitCode: 0 };
}

module.exports = { run };

// ── CLI shim (standalone invocation — preserves exact prior behavior) ─
// Kept raw-stdin-based (isInjectedPrompt handles the JSON-or-raw fallback)
// so standalone behavior is byte-identical to the pre-refactor hook.
if (require.main === module) {
  (async () => {
    try {
      const stdinData = await readStdin();
      if (isInjectedPrompt(stdinData)) {
        // Phone-originated message routed through desktop Claude — user is at phone, not desk.
        process.exit(0);
      }
      await postRemoteModeOff();
    } catch {
      // swallow — hook must never block Claude
    }
    process.exit(0);
  })();
}

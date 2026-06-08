#!/usr/bin/env node
/**
 * desktop-presence-hook.js
 *
 * Claude Code UserPromptSubmit hook. When the user submits a REAL desktop
 * prompt (keyboard input at the desk), this fires and flips
 * MessageBroker.IsRemoteMode to false — signaling "user is at the desk,
 * stop mirroring prompts to phone."
 *
 * IMPORTANT: Channel-injected prompts from the phone (messages routed to
 * desktop Claude sessions via the multiterminal-channel plugin) also fire
 * UserPromptSubmit. Those must NOT flip remoteMode off — the user is at
 * the phone, not the desk. We detect channel-injected prompts by reading
 * the JSON payload on stdin and looking for the <channel source="plugin:
 * multiterminal..."> tag in the prompt, then skip the POST in that case.
 *
 * Paired with ClaudeRemote's MessagesProxy X-Source: phone header which
 * flips remote mode on. Together they auto-infer presence from user
 * actions without requiring a manual toggle.
 *
 * Idempotent on the MT side: SetRemoteMode short-circuits when the value
 * isn't changing, so firing this on every desktop prompt submission is cheap.
 *
 * Behavior:
 *   - stdin prompt is channel-injected → exit 0 silently (skip flip)
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

function isChannelInjectedPrompt(stdinData) {
  if (!stdinData) return false;
  const marker = /<channel\s+source="plugin:multiterminal/;
  try {
    const payload = JSON.parse(stdinData);
    const prompt = payload.prompt || '';
    return marker.test(prompt);
  } catch {
    return marker.test(stdinData);
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

(async () => {
  try {
    const stdinData = await readStdin();
    if (isChannelInjectedPrompt(stdinData)) {
      // Phone-originated message routed through desktop Claude — user is at phone, not desk.
      process.exit(0);
    }
    await postRemoteModeOff();
  } catch {
    // swallow — hook must never block Claude
  }
  process.exit(0);
})();

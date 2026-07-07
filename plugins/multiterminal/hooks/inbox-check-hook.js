#!/usr/bin/env node
/**
 * inbox-check-hook.js
 *
 * Claude Code hook that checks for pending messages in a file-based inbox.
 * Designed for PostToolUse and Stop hooks to deliver inter-terminal messages
 * to Claude Code agents without ConPTY injection.
 *
 * Inbox file: %APPDATA%/multiterminal/inbox/{MULTITERMINAL_NAME}.json
 * Format: JSON array of [{id, sender, content, timestamp}]
 *
 * Behavior:
 *   - No inbox file → exit 0 silently (fast path, < 30ms)
 *   - Inbox exists → read, delete, format messages for Claude
 *   - Stop hooks → JSON with decision:"block" to keep Claude processing
 *   - Other hooks → plain text stdout as additional context
 *   - Any error → exit 0 silently (never block Claude)
 */
const fs = require('fs');
const path = require('path');

// ── Core (dispatcher-callable) ───────────────────────────────────────
// inbox-check ignores stdin — it reads the file-based inbox using the hook
// event name (was argv[2]) + MULTITERMINAL_NAME. Deps are injectable (fs / name
// / inboxPath / hookType) so tests can exercise the read+delete+decision path
// with an in-memory stub instead of the live inbox (ticket 42c91001). Returns
// {exitCode, stdout}; sync/decision class — Stop/SubagentStop emit a
// {decision:'block'} that Claude waits on, so this lands in the SYNC dispatch
// head under B2, not the async one.
function run(hookData, opts = {}) {
  const _fs = opts.fs || fs;
  const name = opts.name !== undefined ? opts.name : process.env.MULTITERMINAL_NAME;
  const hookType = opts.hookType || '';

  if (!name) {
    return { exitCode: 0 };
  }

  const inboxPath = opts.inboxPath
    || path.join(process.env.APPDATA || '', 'multiterminal', 'inbox', name + '.json');

  // Fast path: no inbox file means no messages
  if (!_fs.existsSync(inboxPath)) {
    return { exitCode: 0 };
  }

  // Read and delete inbox file (atomic: read then unlink)
  let raw;
  try {
    raw = _fs.readFileSync(inboxPath, 'utf8');
    _fs.unlinkSync(inboxPath);
  } catch (e) {
    // File may have been consumed by another process
    return { exitCode: 0 };
  }

  // Parse messages
  let messages;
  try {
    messages = JSON.parse(raw);
  } catch (e) {
    return { exitCode: 0 };
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    return { exitCode: 0 };
  }

  // Format messages
  const lines = ['## Incoming Messages'];
  for (const msg of messages) {
    const sender = msg.Sender || msg.sender;
    const content = msg.Content || msg.content;
    if (msg && sender && content) {
      lines.push(`[${sender}]: ${content}`);
    }
  }

  if (lines.length === 1) {
    // No valid messages after filtering
    return { exitCode: 0 };
  }

  const formatted = lines.join('\n');

  // Stop/SubagentStop: block stopping so Claude processes the messages.
  if (hookType === 'Stop' || hookType === 'SubagentStop') {
    return { exitCode: 0, stdout: JSON.stringify({ decision: 'block', reason: formatted }) };
  }
  // For PostToolUse, PreToolUse, etc. — plain text becomes context.
  return { exitCode: 0, stdout: formatted };
}

module.exports = { run };

// ── CLI shim (standalone invocation — preserves exact prior behavior) ─
if (require.main === module) {
  // Hook type passed as command-line argument (avoids slow stdin reading);
  // inbox-check historically ignores stdin.
  const hookType = process.argv[2] || '';
  const { exitCode, stdout } = run({}, { hookType });
  if (stdout) {
    console.log(stdout);
  }
  process.exit(exitCode || 0);
}

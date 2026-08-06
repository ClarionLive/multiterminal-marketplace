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
 *   — the channel POST shape ({from, message, ...}) is accepted too; see the
 *     formatMessage() block below for the full key list and why.
 *
 * Behavior:
 *   - No inbox file → exit 0 silently (fast path, < 30ms)
 *   - Inbox exists → read, delete, format messages for Claude
 *   - Every entry produces exactly one line — a message is NEVER dropped for
 *     being empty or oddly shaped (ticket 6b093a22 defect 2)
 *   - Stop hooks → JSON with decision:"block" to keep Claude processing
 *   - Other hooks → plain text stdout as additional context
 *   - Any error → exit 0 silently (never block Claude)
 */
const fs = require('fs');
const path = require('path');

// ── Message body resolution (GH#7, ticket 6b093a22 defect 2) ─────────────
//
// The old formatter was:
//
//     const sender  = msg.Sender  || msg.sender;
//     const content = msg.Content || msg.content;
//     if (msg && sender && content) { lines.push(`[${sender}]: ${content}`); }
//
// which SILENTLY DROPPED anything it didn't recognise. Three ways to lose a
// message, none of them leaving a trace:
//
//   1. `message` was never accepted. The channel POST shape is
//      {from, message, ...} — write one of those to the inbox file and it
//      vanished, because neither `Sender` nor `Content` is present.
//   2. An EMPTY body is falsy, so `content` failed the `&&` and the message
//      was dropped rather than shown as empty.
//   3. If EVERY message was filtered, `lines.length === 1` and the hook exits
//      0 with no stdout at all — so the recipient cannot tell the difference
//      between "no mail" and "your mail was discarded".
//
// Verified live via this hook's own injectable-deps entry point: empty body →
// nothing surfaced; channel-shaped payload → nothing surfaced; a mixed batch →
// the empty message vanished while its siblings rendered, so the loss was
// invisible even when other mail arrived.
//
// A dropped message is the worst outcome available here — worse than an ugly
// one. Every entry now produces exactly one line.
//
// Kept deliberately in sync with server/multiterminal-channel.mjs, which had
// the mirror-image defect (it rendered the raw envelope instead of dropping).
// Duplicated rather than shared because that file is an ESM module under
// server/ with its own package.json and node_modules, while this is CJS under
// hooks/. If you change the semantics here, change them there too.

const EMPTY_BODY_MARKER = '(empty message — the sender delivered a blank body)';
const SENDER_KEYS = ['Sender', 'sender', 'From', 'from'];
const CONTENT_KEYS = ['Content', 'content', 'Message', 'message'];

/** Bounded, single-line preview of an unrecognised entry, for diagnostics. */
function previewEntry(value, max = 200) {
  let text;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch (e) {
    text = String(value);
  }
  text = String(text === undefined ? value : text).replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max) + '…' : text;
}

/**
 * First non-empty value among `keys`.
 *
 * Returns {text, sawKey}: `text` is null when nothing renderable was found, and
 * `sawKey` distinguishes "the key was there but empty" (a real empty message)
 * from "no such key at all" (an unrecognised shape). Collapsing those two is
 * precisely what the `||` chain got wrong.
 */
function firstNonEmpty(obj, keys) {
  let sawKey = false;
  for (const key of keys) {
    if (!(key in obj)) continue;
    sawKey = true;
    const value = obj[key];
    if (value === null || value === undefined) continue;
    const text = String(value);
    if (text.trim() !== '') return { text, sawKey: true };
  }
  return { text: null, sawKey };
}

/** Render one inbox entry as exactly one line. Never returns null. */
function formatMessage(msg) {
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) {
    return `[unknown]: (unreadable inbox entry: ${previewEntry(msg)})`;
  }

  const sender = firstNonEmpty(msg, SENDER_KEYS).text || 'unknown sender';
  const body = firstNonEmpty(msg, CONTENT_KEYS);

  if (body.text !== null) return `[${sender}]: ${body.text}`;
  if (body.sawKey) return `[${sender}]: ${EMPTY_BODY_MARKER}`;
  return `[${sender}]: (unrecognised inbox entry — no content field: ${previewEntry(msg)})`;
}

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

  // Format messages. One line per entry, unconditionally — see the
  // formatMessage() block above for why nothing is filtered out any more.
  const lines = ['## Incoming Messages'];
  for (const msg of messages) {
    lines.push(formatMessage(msg));
  }

  if (lines.length === 1) {
    // Defensive backstop only. The empty/non-array cases already returned
    // above, and formatMessage() never skips an entry, so reaching this with a
    // non-empty `messages` is now impossible by construction.
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

module.exports = { run, formatMessage };

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

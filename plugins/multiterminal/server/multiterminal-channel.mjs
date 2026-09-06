#!/usr/bin/env node
/**
 * MultiTerminal Channel — Claude Code Channels MCP Server
 *
 * Bridges MultiTerminal's agent-to-agent messaging into Claude Code sessions
 * via the native Channels protocol. Replaces the [cm] ConPTY nudge hack.
 *
 * Each Claude Code terminal runs this as an MCP server. It:
 *   1. Listens on an HTTP port for incoming messages from other agents
 *   2. Pushes them as <channel> events into the Claude Code session
 *   3. Exposes a "reply" tool so Claude can send messages back
 *
 * Environment variables:
 *   CHANNEL_PORT        — HTTP port to listen on (default: 8800)
 *   MULTITERMINAL_NAME  — This terminal's agent name
 *   MT_API_URL          — MultiTerminal REST API base URL (default: http://localhost:5050)
 *   MULTITERMINAL_ID    — This terminal's ID (for send_message routing)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import http from 'node:http';

const CHANNEL_PORT = parseInt(process.env.CHANNEL_PORT || '8800', 10);
// Identity (task c9285d2a). This used to be a const defaulting to 'unknown', which meant a
// session nobody had named still registered itself into MT's roster under that placeholder —
// every such session claiming the SAME name, each on its own port, last writer winning. It starts
// UNSET instead: while unbound this server registers nothing, claims no name, and answers no
// message. A `let` rather than a const because adoption rebinds it once a session registers.
let agentName = process.env.MULTITERMINAL_NAME || null;

/** True once this session has an identity — from the environment, or later by adoption. */
function isBound() {
  return agentName !== null;
}

/** Display-only. Never use this as an address: 'unbound' is not a name, it is the absence of one. */
function nameForLog() {
  return agentName ?? 'unbound';
}
const MT_API_URL = process.env.MT_API_URL || 'http://localhost:5050';
const TERMINAL_ID = process.env.MULTITERMINAL_ID || '';
// Proof-of-origin (task c9285d2a). MT seeds a per-launch secret into the terminal's child
// environment and we inherit it. Echoing it on the port report is what lets the broker tell
// THIS terminal re-reporting its own port apart from a foreign process claiming the same
// name: a same-name registration that cannot present the row's nonce is refused. Without
// this, the port report itself would be refused by that gate and push delivery would die
// silently. Empty outside MT (nothing seeded it) — the broker fails open for unseeded rows.
const LAUNCH_NONCE = process.env.MULTITERMINAL_LAUNCH_NONCE || '';

// Track the actual listening port (may differ from CHANNEL_PORT after fallback)
let actualPort = CHANNEL_PORT;

// Whether we actually bound a port. Distinct from actualPort, which is seeded with the DEFAULT and
// so reads as 8800 even when nothing was ever bound — a dormant session logging ':8800' would send
// someone hunting a port conflict that does not exist.
let listening = false;

// Logging to stderr (stdout is reserved for MCP stdio transport)
function log(msg) {
  process.stderr.write(`[mt-channel:${nameForLog()}:${listening ? actualPort : '-'}] ${msg}\n`);
}

// ─── Report actual port to broker ─────────────────────────────────────────────

async function registerPortOnce(port) {
  // Defensive: the caller is already gated on isBound(), but a roster row is the one side effect
  // that outlives this process, so refuse it here too rather than trusting one call site.
  if (!isBound()) {
    log('Not registering a port: this session has no identity.');
    return false;
  }
  try {
    const payload = JSON.stringify({
      name: agentName,
      channelPort: port,
      ...(LAUNCH_NONCE ? { nonce: LAUNCH_NONCE } : {}),
    });
    await fetch(`${MT_API_URL}/api/messaging/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    });

    // Verify the port stuck by checking the terminals list
    const verifyRes = await fetch(`${MT_API_URL}/api/messaging/terminals`);
    if (verifyRes.ok) {
      const terminals = await verifyRes.json();
      const me = terminals.find(t => t.name.toLowerCase() === agentName.toLowerCase());
      if (me && me.channelPort === port) {
        return true;
      }
      log(`Port registration didn't stick (broker has ${me?.channelPort}, need ${port})`);
    }
  } catch (err) {
    log(`Port registration failed: ${err.message}`);
  }
  return false;
}

async function reportPortToBroker(port) {
  // Retry with verification — the agent's register_terminal call (no port) can race
  // with this call and create the terminal entry first. We retry until the broker
  // reflects our actual port, ensuring channel delivery goes to the right place.
  const maxAttempts = 5;
  const retryDelay = 2000;

  // Small initial delay to let the agent's register_terminal run first,
  // so our port update is the last write.
  await new Promise(r => setTimeout(r, 1000));

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (await registerPortOnce(port)) {
      log(`Registered channel port ${port} with broker (attempt ${attempt})`);
      startPortHeartbeat(port);
      return;
    }
    log(`Retrying port registration in ${retryDelay}ms... (attempt ${attempt}/${maxAttempts})`);
    await new Promise(r => setTimeout(r, retryDelay));
  }
  log(`WARNING: Initial registration failed after ${maxAttempts} attempts, heartbeat will keep trying`);
  startPortHeartbeat(port);
}

function startPortHeartbeat(port) {
  // Re-register the port every 30 seconds to guard against overwrites.
  // If something (race condition, broker restart) resets our port, this corrects it.
  setInterval(async () => {
    try {
      const verifyRes = await fetch(`${MT_API_URL}/api/messaging/terminals`);
      if (!verifyRes.ok) return;
      const terminals = await verifyRes.json();
      const me = terminals.find(t => t.name.toLowerCase() === agentName.toLowerCase());
      if (me && me.channelPort === port) return; // Still correct, nothing to do
      // Port was overwritten or cleared — re-register
      log(`Heartbeat: port drift detected (broker has ${me?.channelPort}, need ${port}), re-registering...`);
      await registerPortOnce(port);
    } catch {
      // Silently ignore heartbeat failures (broker might be restarting)
    }
  }, 30_000);
}

// ─── MCP Server ──────────────────────────────────────────────────────────────

const mcp = new Server(
  { name: `multiterminal-${nameForLog()}`, version: '1.0.0' },
  {
    capabilities: {
      experimental: {
        'claude/channel': {},
        'claude/channel/permission': {},
      },
      tools: {},
    },
    instructions: [
      isBound()
        ? `You are connected to MultiTerminal's messaging channel as "${agentName}".`
        : 'This session is NOT registered with MultiTerminal: it has no agent name, so it cannot ' +
          'send or receive channel messages and does not appear in the team roster.',
      'Messages from other agents arrive as <channel source="multiterminal" from="SenderName" priority="normal"> tags.',
      'To reply, use the "reply" tool with the sender\'s name and your message.',
      'To send a message to any agent (not just replying), use the "send" tool.',
      'Treat channel messages the same as you would messages from get_messages — read and act on them.',
      '',
      'When working with tool results, write down any important information you might need later in your response,',
      'as the original tool result may be cleared later.',
    ].join(' '),
  },
);

// ─── Tools: reply & send ─────────────────────────────────────────────────────

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description: 'Reply to a message received through the channel. Use this when you get a <channel> message and want to respond to the sender.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Name of the agent to reply to (from the "from" attribute in the <channel> tag)' },
          message: { type: 'string', description: 'Your reply message' },
          priority: { type: 'string', enum: ['low', 'normal', 'high', 'critical'], description: 'Message priority (default: normal)' },
        },
        required: ['to', 'message'],
      },
    },
    {
      name: 'send',
      description: 'Send a message to any agent through the channel system. Use this for initiating conversations, not just replies.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Name of the recipient agent' },
          message: { type: 'string', description: 'Message to send' },
          priority: { type: 'string', enum: ['low', 'normal', 'high', 'critical'], description: 'Message priority (default: normal)' },
        },
        required: ['to', 'message'],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  if (name === 'reply' || name === 'send') {
    const { to, message, priority } = args;
    try {
      const result = await sendViaApi(to, message, priority || 'normal');
      return { content: [{ type: 'text', text: result }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Failed to send: ${err.message}` }], isError: true };
    }
  }

  throw new Error(`Unknown tool: ${name}`);
});

// ─── Permission Relay ─────────────────────────────────────────────────────────
// When Claude needs tool approval, forward the prompt to ClaudeRemote so
// John can approve/deny from his phone. Reply "yes <id>" or "no <id>".

const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no|always)\s+([a-km-z]{5})\s*$/i;

// Track pending permission requests (reqId → toolName) and always-allowed tools
const pendingPermissions = new Map();   // lowercased reqId → { toolName, originalId }
const alwaysAllowedTools = new Set();   // tool names auto-approved for this session

const PermissionRequestSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
});

mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  // Auto-approve if this tool was previously "always allowed"
  if (alwaysAllowedTools.has(params.tool_name)) {
    await mcp.notification({
      method: 'notifications/claude/channel/permission',
      params: { request_id: params.request_id, behavior: 'allow' },
    });
    log(`Auto-approved ${params.tool_name} [${params.request_id}] (always-allow)`);
    return;
  }

  // Remember this request so we can map reqId → tool_name when verdict arrives
  pendingPermissions.set(params.request_id.toLowerCase(), {
    toolName: params.tool_name,
    originalId: params.request_id,
  });

  // Structured prefix lets ClaudeRemote detect this as a permission request
  // and render approve/deny/always buttons instead of raw text.
  // Format: [PERMISSION_REQUEST:requestId:agentName:toolName]
  const prefix = `[PERMISSION_REQUEST:${params.request_id}:${nameForLog()}:${params.tool_name}]`;
  const prompt = `${prefix}\n🔐 ${nameForLog()} wants to run ${params.tool_name}:\n${params.description}`;

  try {
    await sendViaApi('ClaudeRemote', prompt, 'high');
    log(`Permission prompt forwarded to ClaudeRemote: ${params.tool_name} [${params.request_id}]`);
  } catch (err) {
    log(`Failed to forward permission prompt: ${err.message}`);
  }
});

// ─── Send message via MultiTerminal REST API ─────────────────────────────────

async function sendViaApi(to, message, priority) {
  // fromTerminalId IS the agent name (below), so an unbound session cannot send: it would have to
  // invent a sender. Fail loudly here rather than posting a message attributed to nobody.
  if (!isBound()) {
    throw new Error(
      'This session is not registered with MultiTerminal, so it has no name to send from. ' +
      'Register the terminal first, then retry.',
    );
  }
  // Use agentName as fromTerminalId — TERMINAL_ID is not available at startup
  // because it's assigned during registration (after the MCP server is already running).
  // MessageBroker.GetTerminal() resolves by name, so this works.
  const payload = JSON.stringify({
    fromTerminalId: agentName,
    to,
    message,
    priority,
  });

  const url = `${MT_API_URL}/api/messaging/send`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API returned ${res.status}: ${body}`);
  }

  log(`Sent message to ${to}: ${message.substring(0, 80)}...`);
  return `Message sent to ${to}`;
}

// ─── Recipient verification + replay dedup (GH#7, ticket 6b093a22) ───────────
//
// This server used to accept ANY POST to its port and inject it into this
// agent's session. MultiTerminal delivers by POSTing to the recipient's LAST
// RECORDED port and treats any 2xx as proof of delivery, so a stale or reused
// port silently routed one agent's messages into another agent's session — and
// the broker marked them delivered. That is the "Diana loses everything while
// Eve receives fine" signature in GH#7, and it cannot be fixed broker-side:
// only the process that owns the port knows who it actually is.
//
// MT ticket 405273fd added `id` and `to` to the channel payload specifically so
// this check could exist. This is that check.

const SEEN_MESSAGE_TTL_MS = 10 * 60 * 1000;
const SEEN_MESSAGE_MAX = 500;

/** messageId -> receipt timestamp. Map iteration is insertion-ordered, which pruning relies on. */
const seenMessageIds = new Map();

/**
 * True when a payload is addressed to this agent.
 *
 * A payload with NO `to` is ACCEPTED. That is deliberate and load-bearing:
 * older MT builds (pre-405273fd) omit the field entirely, and rejecting those
 * would silently break messaging for every agent running against an older
 * backend. We reject only on positive evidence of misdelivery — `to` present
 * AND naming somebody else.
 */
function isAddressedToMe(to) {
  // An unbound session has no name, so nothing can be addressed to it — INCLUDING the
  // omitted-recipient case below. That tolerance exists for older MT builds that sent no `to`
  // field; read while unbound it would turn 'I don't know who this is for' into 'it is for me',
  // which is how an unnamed session would end up swallowing another agent's mail.
  if (!isBound()) return false;
  if (to === undefined || to === null || to === '') return true;
  return String(to).toLowerCase() === agentName.toLowerCase();
}

/**
 * True when this message id has already been injected recently.
 *
 * MT keeps a failed delivery retryable while ALSO writing an inbox-file copy,
 * so a recovered channel can legitimately receive a message the agent already
 * saw. Deduping here is what makes that belt-and-retry design safe.
 * Payloads without an id are never deduped (nothing to key on).
 *
 * CHECKING AND MARKING ARE SEPARATE ON PURPOSE — see markMessageSeen().
 */
function hasSeenMessage(id) {
  if (id === undefined || id === null || id === '') return false;

  const cutoff = Date.now() - SEEN_MESSAGE_TTL_MS;
  for (const [seenId, at] of seenMessageIds) {
    if (at >= cutoff) break; // insertion-ordered: first fresh entry ends the sweep
    seenMessageIds.delete(seenId);
  }

  return seenMessageIds.has(String(id));
}

/**
 * Record an id as delivered. Call this ONLY after the message has actually
 * reached the agent — never before.
 *
 * An earlier revision marked the id inside the duplicate CHECK, i.e. before the
 * awaited mcp.notification(). If that notification then threw, the handler
 * answered 400, MT wrote its inbox belt and left the row pending (correct), but
 * the Tier-3 RETRY hit the already-marked id and got back 200
 * `duplicate_ignored` — so MT marked the message DELIVERED even though the
 * channel had never injected it. Not a total loss (the belt still surfaces it
 * on the recipient's next hook run), but it silently downgrades a channel
 * delivery to the file path that "may not surface until the next hook fires,
 * possibly never for an idle terminal" — while telling the broker it succeeded.
 * That is precisely the delivered-but-wasn't accounting bug GH#7 / ticket
 * 405273fd exists to kill, reappearing through a side door.
 *
 * Marking after the fact means a failed injection stays retryable, and the
 * retry actually re-injects.
 */
function markMessageSeen(id) {
  if (id === undefined || id === null || id === '') return;
  seenMessageIds.set(String(id), Date.now());
  while (seenMessageIds.size > SEEN_MESSAGE_MAX) {
    seenMessageIds.delete(seenMessageIds.keys().next().value);
  }
}

// ─── Message body resolution (GH#7, ticket 6b093a22 defect 1) ────────────────
//
// The old chain was:
//
//     const content = msg.message || msg.content || body;
//
// which reads as defensive but conflates three very different situations,
// because an EMPTY STRING is falsy:
//
//   key absent            -> fall through to the next shape.   CORRECT, and
//                            load-bearing: the inbox-file shape uses `Content`
//                            while the channel POST uses `message`.
//   key present but EMPTY -> ALSO fell through — past `content`, past
//                            everything, all the way to `body`, the raw request
//                            text. The agent was then shown
//                            `{"from":"Bob","message":"","id":42,...}` as if
//                            that JSON were the message Bob had typed.
//                            Verified live on message 6889.
//   no body key at all    -> same raw-envelope dump.
//
// Rendering an envelope as content is worse than rendering nothing: it is
// indistinguishable from a sender who genuinely typed JSON, so the reader
// cannot tell a delivery bug from a weird colleague. Each case is now named
// explicitly and the envelope is NEVER passed off as somebody's words.
//
// Kept deliberately in sync with hooks/inbox-check-hook.js, which had the
// mirror-image defect (it dropped these payloads silently instead). The logic
// is duplicated rather than shared because that hook is CJS under hooks/ while
// this is an ESM module under server/ with its own package.json and
// node_modules — a shared import across that boundary costs more than 20 lines
// of duplication. If you change the semantics here, change them there too.

const EMPTY_BODY_MARKER = '(empty message — the sender delivered a blank body)';

// The key lists are IDENTICAL to hooks/inbox-check-hook.js, in the same order,
// on purpose. An earlier revision let each file lead with its own native shape
// (`message` here, `Content` there) which silently inverted precedence: a
// payload carrying BOTH keys rendered one thing on the channel and the other in
// the hook, and each file's tests pinned its own answer, so the suites locked in
// the disagreement. One order, both files, no exceptions.
const SENDER_KEYS = ['from', 'sender', 'From', 'Sender'];
const CONTENT_KEYS = ['message', 'content', 'Message', 'Content'];

/** Bounded, single-line preview of a VALUE we intend to render, for diagnostics. */
function previewPayload(raw, max = 300) {
  const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Describe an unrecognised payload by its KEY NAMES ONLY — never its values.
 *
 * An earlier revision echoed the whole raw request body here. That told a
 * reader what shape had arrived, but it also piped every field of an
 * unrecognised envelope — routing data, ids, timestamps, and any field a future
 * writer adds — straight into the agent's context, for a payload we had by
 * definition failed to understand. Key names answer the actual diagnostic
 * question ("which field did the sender use?") and carry no values.
 */
function describeShape(msg) {
  if (msg === null) return 'null';
  if (Array.isArray(msg)) return `array[${msg.length}]`;
  if (typeof msg !== 'object') return typeof msg;
  const keys = Object.keys(msg);
  if (keys.length === 0) return 'object with no keys';
  const shown = keys.slice(0, 20).map(k => previewPayload(k, 40));
  return `keys=${shown.join(',')}${keys.length > shown.length ? ',…' : ''}`;
}

/**
 * Coerce one field value to display text, without ever inventing content.
 *
 * `String(value)` alone turns an object body into the literal "[object Object]",
 * which destroys the content silently and unlabelled — the exact class of loss
 * this whole change exists to close. Structured values are JSON-rendered
 * instead, so `{"message":{"text":"real words"}}` stays readable.
 */
function coerceField(value) {
  if (typeof value === 'object') { // arrays included; null is filtered by the caller
    let json;
    try {
      json = JSON.stringify(value);
    } catch {
      json = null; // circular
    }
    return previewPayload(json ?? '(unrenderable value)');
  }
  try {
    return String(value);
  } catch {
    // Only reachable for exotic values a JSON payload cannot produce (Symbol,
    // a throwing Symbol.toPrimitive). Never let coercion kill the delivery.
    return '(unrenderable value)';
  }
}

/** First non-empty value among `keys`, or null. `sawKey` reports "present but empty". */
function firstNonEmpty(obj, keys) {
  let sawKey = false;
  if (obj === null || typeof obj !== 'object') return { text: null, sawKey };
  for (const key of keys) {
    if (!(key in obj)) continue; // absent — try the next shape
    sawKey = true;
    const value = obj[key];
    if (value === null || value === undefined) continue;
    const text = coerceField(value);
    if (text.trim() !== '') return { text, sawKey: true }; // first non-empty wins
  }
  return { text: null, sawKey };
}

/**
 * Resolve the sender name of an inbound payload.
 *
 * Reads the same SENDER_KEYS the inbox hook does. Before this, the channel read
 * only `msg.from`, so an inbox-shaped `{Sender:'Bob', Content:'x'}` rendered its
 * BODY correctly but attributed it to "unknown" — half-understanding a payload
 * is its own defect.
 */
function resolveFrom(msg) {
  return firstNonEmpty(msg, SENDER_KEYS).text || 'unknown';
}

/**
 * Resolve the human-readable body of an inbound payload.
 *
 * Returns a string that is ALWAYS safe to `.substring()` and to inject as
 * channel content. When the payload carries nothing renderable, the string is
 * an explicit, self-describing marker rather than the envelope.
 *
 * @param {unknown} msg the parsed payload
 */
function resolveContent(msg) {
  // A bare JSON string payload IS the message.
  if (typeof msg === 'string') {
    return msg.trim() === '' ? EMPTY_BODY_MARKER : msg;
  }

  const body = firstNonEmpty(msg, CONTENT_KEYS);
  if (body.text !== null) return body.text;

  // A body key was there, it was just empty. Say exactly that.
  if (body.sawKey) return EMPTY_BODY_MARKER;

  // No body key at all — an unrecognised shape. Report its SHAPE, labelled,
  // never as if the sender had typed it, and never the values.
  return `(unrecognised message payload — no "message" or "content" field: ${describeShape(msg)})`;
}

// ─── HTTP Server: receive messages from other agents/broker ──────────────────

const httpServer = http.createServer(async (req, res) => {
  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', agent: agentName, port: actualPort }));
    return;
  }

  // Receive a message (POST /message)
  if (req.method === 'POST' && req.url === '/message') {
    let body = '';
    // The read MUST be guarded. If the client disconnects mid-body, Node's
    // abortIncoming rejects this async iterator; because the request handler is
    // itself async, that becomes an unhandled rejection and THE WHOLE PROCESS
    // EXITS(1) — taking this agent's channel delivery and its reply/send MCP
    // tools with it until the session restarts. One truncated POST to localhost
    // was enough. (A complete-body-then-abort, e.g. MT's 5s HttpClient timeout,
    // is harmless — only a truncated body triggers it.)
    try {
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 1_000_000) { res.writeHead(413); res.end('Payload too large'); return; }
      }
    } catch (err) {
      log(`Aborted request on ${req.url}: ${err.message}`);
      res.destroy();
      return;
    }

    try {
      const msg = JSON.parse(body);
      const from = resolveFrom(msg);
      const content = resolveContent(msg);
      const priority = msg.priority || 'normal';
      const messageType = msg.messageType || 'direct';

      // Wrong recipient — someone else's message arrived on our port (stale/reused
      // port). Refuse it. 409 is deliberately NON-2xx: MT treats any 2xx as proof of
      // delivery, so answering 200 here is exactly how these messages used to be
      // marked delivered and lost. A non-2xx leaves the queue row retryable, and the
      // message reaches its real recipient once the port record corrects itself.
      if (!isAddressedToMe(msg.to)) {
        log(`REFUSED message ${msg.id ?? '?'} from ${from}: addressed to "${msg.to}", but this port belongs to ${agentName}`);
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'wrong_recipient',
          agent: agentName,
          addressedTo: msg.to,
        }));
        return;
      }

      // Already injected — a Tier-3 retry after the inbox-file belt already ran, or
      // a double-send. 2xx (not 409): the message genuinely reached this agent, just
      // earlier, so MT should mark it delivered rather than retry it forever.
      if (hasSeenMessage(msg.id)) {
        log(`Ignored duplicate message ${msg.id} from ${from} (already delivered)`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'duplicate_ignored', agent: agentName }));
        return;
      }

      // Check for permission verdict reply (e.g. "yes abcde", "no abcde", or "always abcde")
      const verdict = PERMISSION_REPLY_RE.exec(content);
      if (verdict) {
        const word = verdict[1].toLowerCase();
        const reqId = verdict[2].toLowerCase();

        // Look up the original request_id and tool name
        const entry = pendingPermissions.get(reqId);
        const originalId = entry?.originalId || reqId;
        pendingPermissions.delete(reqId);

        // "always" = allow this request AND remember the tool for auto-approve
        if (word === 'always' && entry) {
          alwaysAllowedTools.add(entry.toolName);
          log(`Always-allow registered for tool: ${entry.toolName}`);
        }

        await mcp.notification({
          method: 'notifications/claude/channel/permission',
          params: {
            request_id: originalId,
            behavior: word === 'always' || word.startsWith('y') ? 'allow' : 'deny',
          },
        });

        markMessageSeen(msg.id); // handled successfully — a replay is a genuine duplicate
        log(`Permission verdict from ${from}: ${word} ${reqId}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'verdict_recorded', agent: agentName }));
        return;
      }

      // Push as channel event into the Claude Code session
      await mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content: content,
          meta: {
            from,
            priority,
            message_type: messageType,
            timestamp: msg.timestamp || new Date().toISOString(),
          },
        },
      });

      // ONLY NOW is the id recorded — the await above has actually injected it.
      // Marking earlier turned a failed injection into a permanent
      // `duplicate_ignored` 200 on the retry, i.e. delivered-but-wasn't.
      markMessageSeen(msg.id);

      log(`Received message from ${from}: ${content.substring(0, 80)}...`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'delivered', agent: agentName }));
    } catch (err) {
      log(`Error processing message: ${err.message}`);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Broadcast (POST /broadcast) — same format, just a different endpoint for clarity
  if (req.method === 'POST' && req.url === '/broadcast') {
    let body = '';
    // Guarded for the same reason as POST /message — see the note there. An
    // aborted body-read here killed the process just as dead.
    try {
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 1_000_000) { res.writeHead(413); res.end('Payload too large'); return; }
      }
    } catch (err) {
      log(`Aborted request on ${req.url}: ${err.message}`);
      res.destroy();
      return;
    }

    try {
      const msg = JSON.parse(body);
      const from = resolveFrom(msg);
      // Same defect as POST /message had — a broadcast with an empty body
      // rendered the raw envelope too. Recipient VERIFICATION is what /broadcast
      // deliberately skips (a broadcast has no meaningful `to`); body rendering
      // is not exempt.
      const content = resolveContent(msg);

      await mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content: content,
          meta: {
            from,
            priority: msg.priority || 'normal',
            message_type: 'broadcast',
            timestamp: msg.timestamp || new Date().toISOString(),
          },
        },
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'delivered', agent: agentName }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

// ─── Start ───────────────────────────────────────────────────────────────────

// Connect MCP over stdio first
await mcp.connect(new StdioServerTransport());
log('MCP connected over stdio');

// Try ports in the allowed range (8800-8899) until one is free
function tryListen(port) {
  if (port > 8899) {
    log('ERROR: All ports in range 8800-8899 are in use!');
    process.exit(1);
  }

  const server = httpServer;
  server.removeAllListeners('error');
  server.removeAllListeners('listening');
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log(`Port ${port} in use, trying ${port + 1}...`);
      tryListen(port + 1);
    } else {
      log(`HTTP server error: ${err.message}`);
    }
  });

  server.listen(port, '127.0.0.1', () => {
    actualPort = port;
    listening = true;
    log(`HTTP listener ready on port ${actualPort}`);
    reportPortToBroker(actualPort);
  });
}

if (isBound()) {
  tryListen(CHANNEL_PORT);
} else {
  // No identity, so no listener and no roster row. Nothing can route to this session, so a port
  // would only be a surface with no purpose. The MCP server above is still connected, which is
  // deliberate: exiting here would show up in Claude Code as a FAILED MCP server, trading one
  // confusing line at startup for another. Dormant and quiet is the point.
  log(
    'Dormant: no MULTITERMINAL_NAME, so this session is not registered and cannot send or ' +
    'receive. Nothing was written to the roster.',
  );
}

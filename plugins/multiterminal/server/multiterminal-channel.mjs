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
const AGENT_NAME = process.env.MULTITERMINAL_NAME || 'unknown';
const MT_API_URL = process.env.MT_API_URL || 'http://localhost:5050';
const TERMINAL_ID = process.env.MULTITERMINAL_ID || '';

// Track the actual listening port (may differ from CHANNEL_PORT after fallback)
let actualPort = CHANNEL_PORT;

// Logging to stderr (stdout is reserved for MCP stdio transport)
function log(msg) {
  process.stderr.write(`[mt-channel:${AGENT_NAME}:${actualPort}] ${msg}\n`);
}

// ─── Report actual port to broker ─────────────────────────────────────────────

async function registerPortOnce(port) {
  try {
    const payload = JSON.stringify({
      name: AGENT_NAME,
      channelPort: port,
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
      const me = terminals.find(t => t.name.toLowerCase() === AGENT_NAME.toLowerCase());
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
      const me = terminals.find(t => t.name.toLowerCase() === AGENT_NAME.toLowerCase());
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
  { name: `multiterminal-${AGENT_NAME}`, version: '1.0.0' },
  {
    capabilities: {
      experimental: {
        'claude/channel': {},
        'claude/channel/permission': {},
      },
      tools: {},
    },
    instructions: [
      `You are connected to MultiTerminal's messaging channel as "${AGENT_NAME}".`,
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
  const prefix = `[PERMISSION_REQUEST:${params.request_id}:${AGENT_NAME}:${params.tool_name}]`;
  const prompt = `${prefix}\n🔐 ${AGENT_NAME} wants to run ${params.tool_name}:\n${params.description}`;

  try {
    await sendViaApi('ClaudeRemote', prompt, 'high');
    log(`Permission prompt forwarded to ClaudeRemote: ${params.tool_name} [${params.request_id}]`);
  } catch (err) {
    log(`Failed to forward permission prompt: ${err.message}`);
  }
});

// ─── Send message via MultiTerminal REST API ─────────────────────────────────

async function sendViaApi(to, message, priority) {
  // Use AGENT_NAME as fromTerminalId — TERMINAL_ID is not available at startup
  // because it's assigned during registration (after the MCP server is already running).
  // MessageBroker.GetTerminal() resolves by name, so this works.
  const payload = JSON.stringify({
    fromTerminalId: AGENT_NAME,
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
  if (to === undefined || to === null || to === '') return true;
  return String(to).toLowerCase() === AGENT_NAME.toLowerCase();
}

/**
 * True when this message id has already been injected recently.
 *
 * MT keeps a failed delivery retryable while ALSO writing an inbox-file copy,
 * so a recovered channel can legitimately receive a message the agent already
 * saw. Deduping here is what makes that belt-and-retry design safe.
 * Payloads without an id are never deduped (nothing to key on).
 */
function isDuplicateMessage(id) {
  if (id === undefined || id === null || id === '') return false;
  const key = String(id);

  const cutoff = Date.now() - SEEN_MESSAGE_TTL_MS;
  for (const [seenId, at] of seenMessageIds) {
    if (at >= cutoff) break; // insertion-ordered: first fresh entry ends the sweep
    seenMessageIds.delete(seenId);
  }

  if (seenMessageIds.has(key)) return true;

  seenMessageIds.set(key, Date.now());
  while (seenMessageIds.size > SEEN_MESSAGE_MAX) {
    seenMessageIds.delete(seenMessageIds.keys().next().value);
  }
  return false;
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

/** Bounded, single-line preview of an unrecognised payload, for diagnostics. */
function previewPayload(raw, max = 300) {
  const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Resolve the human-readable body of an inbound payload.
 *
 * Returns a string that is ALWAYS safe to `.substring()` and to inject as
 * channel content. When the payload carries nothing renderable, the string is
 * an explicit, self-describing marker rather than the envelope.
 *
 * @param {unknown} msg     the parsed payload
 * @param {string}  rawBody the original request text (diagnostics only — never
 *                          returned as if it were the sender's message)
 */
function resolveContent(msg, rawBody) {
  // A bare JSON string payload IS the message.
  if (typeof msg === 'string') {
    return msg.trim() === '' ? EMPTY_BODY_MARKER : msg;
  }

  // `Content` is accepted too: it is the documented inbox-file shape
  // ([{Id, Sender, Content, Timestamp}]), so honouring it keeps a
  // correctly-shaped-but-unexpected payload out of the unrecognised branch.
  let sawBodyKey = false;
  if (msg !== null && typeof msg === 'object') {
    for (const key of ['message', 'content', 'Content']) {
      if (!(key in msg)) continue; // absent — try the next shape
      sawBodyKey = true;
      const value = msg[key];
      if (value === null || value === undefined) continue;
      const text = String(value);
      if (text.trim() !== '') return text; // first non-empty wins
    }
  }

  // A body key was there, it was just empty. Say exactly that.
  if (sawBodyKey) return EMPTY_BODY_MARKER;

  // No body key at all — an unrecognised shape. Show it LABELLED as a payload,
  // never as if the sender had typed it, and never unbounded.
  return `(unrecognised message payload — no "message" or "content" field: ${previewPayload(rawBody)})`;
}

// ─── HTTP Server: receive messages from other agents/broker ──────────────────

const httpServer = http.createServer(async (req, res) => {
  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', agent: AGENT_NAME, port: actualPort }));
    return;
  }

  // Receive a message (POST /message)
  if (req.method === 'POST' && req.url === '/message') {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 1_000_000) { res.writeHead(413); res.end('Payload too large'); return; }
    }

    try {
      const msg = JSON.parse(body);
      const from = msg.from || 'unknown';
      const content = resolveContent(msg, body);
      const priority = msg.priority || 'normal';
      const messageType = msg.messageType || 'direct';

      // Wrong recipient — someone else's message arrived on our port (stale/reused
      // port). Refuse it. 409 is deliberately NON-2xx: MT treats any 2xx as proof of
      // delivery, so answering 200 here is exactly how these messages used to be
      // marked delivered and lost. A non-2xx leaves the queue row retryable, and the
      // message reaches its real recipient once the port record corrects itself.
      if (!isAddressedToMe(msg.to)) {
        log(`REFUSED message ${msg.id ?? '?'} from ${from}: addressed to "${msg.to}", but this port belongs to ${AGENT_NAME}`);
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'wrong_recipient',
          agent: AGENT_NAME,
          addressedTo: msg.to,
        }));
        return;
      }

      // Already injected — a Tier-3 retry after the inbox-file belt already ran, or
      // a double-send. 2xx (not 409): the message genuinely reached this agent, just
      // earlier, so MT should mark it delivered rather than retry it forever.
      if (isDuplicateMessage(msg.id)) {
        log(`Ignored duplicate message ${msg.id} from ${from} (already delivered)`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'duplicate_ignored', agent: AGENT_NAME }));
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

        log(`Permission verdict from ${from}: ${word} ${reqId}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'verdict_recorded', agent: AGENT_NAME }));
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

      log(`Received message from ${from}: ${content.substring(0, 80)}...`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'delivered', agent: AGENT_NAME }));
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
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 1_000_000) { res.writeHead(413); res.end('Payload too large'); return; }
    }

    try {
      const msg = JSON.parse(body);
      const from = msg.from || 'unknown';
      // Same defect as POST /message had — a broadcast with an empty body
      // rendered the raw envelope too. Recipient VERIFICATION is what /broadcast
      // deliberately skips (a broadcast has no meaningful `to`); body rendering
      // is not exempt.
      const content = resolveContent(msg, body);

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
      res.end(JSON.stringify({ status: 'delivered', agent: AGENT_NAME }));
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
    log(`HTTP listener ready on port ${actualPort}`);
    reportPortToBroker(actualPort);
  });
}

tryListen(CHANNEL_PORT);

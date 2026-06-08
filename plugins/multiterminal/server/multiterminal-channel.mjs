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
      const content = msg.message || msg.content || body;
      const priority = msg.priority || 'normal';
      const messageType = msg.messageType || 'direct';

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
      const content = msg.message || msg.content || body;

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

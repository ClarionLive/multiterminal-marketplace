#!/usr/bin/env node
/**
 * research-cache-hook.js — PreToolUse + PostToolUse hook for knowledge auto-caching.
 *
 * PreToolUse (WebSearch/WebFetch):
 *   Queries the knowledge base for cached research matching the query/URL.
 *   If a hit is found, returns it as context so the agent can skip redundant searches.
 *   Never blocks — provides cached results as supplementary context.
 *
 * PostToolUse (WebSearch/WebFetch):
 *   Auto-saves a summarized version of web research results to the knowledge base
 *   for future agents to reuse. Deduplication via SHA256 query hash.
 *
 * Registered in settings.local.json:
 *   PreToolUse  matcher: "WebSearch|WebFetch"
 *   PostToolUse matcher: "WebSearch|WebFetch"
 */
const http = require('http');

const API_PORT = 5050;
const API_TIMEOUT = 5000;

// ── Helpers ──────────────────────────────────────────────────────────

function httpRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1',
      port: API_PORT,
      path,
      method,
      headers: { 'Content-Type': 'application/json' },
      timeout: API_TIMEOUT
    };

    const req = http.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });

    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * Extract a search query from tool input.
 * WebSearch: input.query
 * WebFetch: input.url (use URL as the lookup key) + input.prompt
 */
function extractQuery(toolName, toolInput) {
  if (toolName === 'WebSearch') {
    return toolInput.query || '';
  }
  if (toolName === 'WebFetch') {
    // Combine URL + prompt for better matching
    const url = toolInput.url || '';
    const prompt = toolInput.prompt || '';
    return prompt ? `${url} ${prompt}` : url;
  }
  return '';
}

/**
 * Truncate content to a reasonable size for caching.
 * We store summaries, not full page dumps.
 */
function truncateContent(text, maxLen = 4000) {
  if (!text || text.length <= maxLen) return text;
  return text.substring(0, maxLen) + '\n\n[Truncated — original was ' + text.length + ' chars]';
}

// ── Main ─────────────────────────────────────────────────────────────

// ── Core (dispatcher-callable) ───────────────────────────────────────
// Parsed hookData in (CLI shim reads stdin). Injectable httpRequest + env so the
// cache-lookup (Pre) and auto-save (Post) paths are unit-testable with a stubbed
// REST client — no live calls (ticket 42c91001). SELF-GATES via extractQuery():
// any non-Web tool yields '' → short-circuit, so a matcher-blind dispatch on
// Pre/PostToolUse is safe. Returns {exitCode:0, stdout?}; the Pre cache-hit
// stdout has NO trailing newline (byte-identical to process.stdout.write).
async function run(hookData, deps = {}) {
  const _httpRequest = deps.httpRequest || httpRequest;
  const env = deps.env || process.env;

  const toolName = hookData && hookData.tool_name;
  const toolInput = (hookData && hookData.tool_input) || {};
  const toolOutput = hookData ? hookData.tool_output : undefined; // undefined for Pre, present for Post

  const isPost = toolOutput !== undefined;
  if (isPost) {
    return handlePostToolUse(toolName, toolInput, toolOutput, _httpRequest, env);
  }
  return handlePreToolUse(toolName, toolInput, _httpRequest);
}

module.exports = { run };

// ── PreToolUse: Check cache before searching ─────────────────────────

async function handlePreToolUse(toolName, toolInput, _httpRequest) {
  const query = extractQuery(toolName, toolInput);
  if (!query || query.length < 5) {
    // Too short to meaningfully cache-check
    return { exitCode: 0 };
  }

  try {
    const result = await _httpRequest('GET',
      `/api/knowledge/research-cache?query=${encodeURIComponent(query)}`);

    if (result && result.hit) {
      // Format cached results as context for the agent
      let msg = '[Research Cache] Previous research found:\n\n';

      if (result.source === 'exact' && result.result) {
        const entry = result.result;
        msg += `**${entry.title}**\n`;
        msg += `${entry.content}\n\n`;
        msg += `_(Cached ${entry.createdAt} by ${entry.sourceAgent || 'unknown'})_\n`;
        msg += `\nThis cached result may answer your query. The search will still proceed.`;
      } else if (result.source === 'fts' && result.results) {
        msg += result.results.map(e =>
          `**${e.title}**\n${truncateContent(e.content, 500)}`
        ).join('\n\n---\n\n');
        msg += `\n\n_(${result.results.length} related entries found via fuzzy match. The search will still proceed.)_`;
      }

      // Output as context — don't block the tool
      return { exitCode: 0, stdout: msg };
    }
  } catch {
    // Fail open — don't interfere with the search
  }

  return { exitCode: 0 };
}

// ── PostToolUse: Auto-save research results ──────────────────────────

async function handlePostToolUse(toolName, toolInput, toolOutput, _httpRequest, env) {
  const query = extractQuery(toolName, toolInput);
  if (!query || query.length < 5) {
    return { exitCode: 0 };
  }

  // Parse tool output
  let outputText = '';
  if (typeof toolOutput === 'string') {
    outputText = toolOutput;
  } else if (toolOutput && typeof toolOutput === 'object') {
    outputText = JSON.stringify(toolOutput);
  }

  // Skip empty or error results
  if (!outputText || outputText.length < 50) {
    return { exitCode: 0 };
  }

  // Skip error responses
  if (outputText.startsWith('Error:') || outputText.startsWith('Request failed')) {
    return { exitCode: 0 };
  }

  try {
    const agentName = env.MULTITERMINAL_NAME || 'unknown';
    const sourceUrl = toolInput.url || toolInput.query || '';

    // Build a title from the query
    let title = query;
    if (title.length > 120) title = title.substring(0, 120) + '...';

    await _httpRequest('POST', '/api/knowledge/research-cache', {
      query: query,
      title: title,
      content: truncateContent(outputText),
      sourceAgent: agentName,
      sourceUrl: sourceUrl,
      tags: `auto-cached,${toolName.toLowerCase()}`
    });
  } catch {
    // Fail silently — don't break the agent's flow
  }

  return { exitCode: 0 };
}

// ── CLI shim (standalone invocation — preserves exact prior behavior) ─
if (require.main === module) {
  (async () => {
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
    }
    let hookData;
    try {
      hookData = JSON.parse(input);
    } catch {
      process.exit(0);
      return;
    }
    let out = { exitCode: 0 };
    try { out = await run(hookData, {}); } catch { out = { exitCode: 0 }; }
    if (out && out.stdout) process.stdout.write(out.stdout);
    process.exit((out && out.exitCode) || 0);
  })().catch(() => process.exit(0));
}

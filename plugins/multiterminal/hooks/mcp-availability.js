/**
 * Does this MT-launched session have MultiTerminal's own MCP server? (ticket a796e5f9, GitHub #25)
 *
 * A session can start with the plugin loaded (hooks fire, skills listed) and NO `multiterminal` MCP
 * server: on 2.1.0 MT never wrote %APPDATA%\multiterminal\.mcp.json, so every launch silently dropped
 * --mcp-config. The SessionStart banner then looked normal while every MT skill degraded. This module
 * makes that case loud.
 *
 * A hook cannot see the session's MCP server list, so it checks what an MT launch depends on:
 *   1. %APPDATA%\multiterminal\.mcp.json exists, parses, and has a `multiterminal` entry whose
 *      absolute paths exist (MT passes this file via --mcp-config), OR the user registered the
 *      server themselves in the user-scope .claude.json (the opt-in global registration, GH#2);
 *   2. MT's REST API answers, since every MT tool is a call to it.
 * It does NOT see the launch's command line, so a file that is present but not passed (an MT older
 * than this check) is reported healthy.
 *
 * Only judges MT launches (MULTITERMINAL_DOC_ID set): a bare `claude` with the plugin never had the
 * server, and a warning there would be noise.
 */
const fs = require('fs');
const path = require('path');

const SERVER_NAME = 'multiterminal';
const API_HOST = '127.0.0.1'; // not localhost: it can resolve to ::1 first, and MT listens on IPv4
const API_PORT = 5050;
const API_TIMEOUT_MS = 1500;

function readJson(file, deps) {
  let text;
  try {
    text = deps.readFile(file);
  } catch {
    return { missing: true };
  }
  try {
    return { json: JSON.parse(text) };
  } catch (err) {
    return { error: err.message };
  }
}

function serverEntry(json) {
  const servers = json && typeof json === 'object' ? json.mcpServers : null;
  const entry = servers && typeof servers === 'object' ? servers[SERVER_NAME] : null;
  return entry && typeof entry === 'object' ? entry : null;
}

/** The user-scope Claude Code config: $CLAUDE_CONFIG_DIR\.claude.json, else %USERPROFILE%\.claude.json. */
function userScopeConfigPath(env) {
  if (env.CLAUDE_CONFIG_DIR) return path.join(env.CLAUDE_CONFIG_DIR, '.claude.json');
  const home = env.USERPROFILE || env.HOME;
  return home ? path.join(home, '.claude.json') : null;
}

const MAX_VALUE_CHARS = 200;

/**
 * A value from disk or an error message, made safe to print inside hook output: control characters
 * (newlines included) become spaces, so a crafted path cannot add lines of its own to the agent's
 * context, and it is capped at MAX_VALUE_CHARS.
 */
function clean(value) {
  const flat = String(value).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ');
  return flat.length > MAX_VALUE_CHARS ? flat.slice(0, MAX_VALUE_CHARS) + '…' : flat;
}

const FIX_REOPEN = 'Open a new terminal: MultiTerminal repairs this file before every launch. If it keeps happening, update MultiTerminal (2.1.0 and older never write the file).';
const FIX_REINSTALL = 'MultiTerminal\'s MCP server is not installed in this Windows profile. Reinstall MultiTerminal while signed in as the Windows user who runs it (an install with another account\'s administrator password puts it in that account\'s profile).';

/**
 * Null when the config side looks fine (or this is not an MT launch); otherwise { cause, fix }, each
 * one sentence. Pure apart from `deps` (readFile, exists), so tests need no real files.
 */
function mcpConfigProblem(env, deps = {}) {
  const d = {
    readFile: deps.readFile || ((f) => fs.readFileSync(f, 'utf8')),
    exists: deps.exists || ((p) => fs.existsSync(p)),
  };
  if (!env.MULTITERMINAL_DOC_ID || !env.APPDATA) return null;

  const configPath = path.join(env.APPDATA, 'multiterminal', '.mcp.json');
  const shown = clean(configPath);
  const central = readJson(configPath, d);

  let problem;
  let entry = null;
  if (central.missing) problem = { cause: `${shown} does not exist, so MultiTerminal launched this session without --mcp-config`, fix: FIX_REOPEN };
  else if (central.error) problem = { cause: `${shown} is not valid JSON (${clean(central.error)})`, fix: FIX_REOPEN };
  else if (!(entry = serverEntry(central.json))) problem = { cause: `${shown} has no "${SERVER_NAME}" server entry`, fix: FIX_REINSTALL };

  if (entry) {
    const args = Array.isArray(entry.args) ? entry.args : [];
    for (const p of [entry.command, ...args]) {
      // Drive-rooted paths only, as MT writes them; a bare `node` resolves through PATH.
      if (typeof p === 'string' && /^[A-Za-z]:[\\/]/.test(p) && !d.exists(p)) {
        return { cause: `the "${SERVER_NAME}" server in ${shown} points at a file that does not exist: ${clean(p)}`, fix: FIX_REOPEN };
      }
    }
    return null;
  }

  // The central file cannot supply the server; a user-scope registration still would.
  const userPath = userScopeConfigPath(env);
  if (userPath) {
    const user = readJson(userPath, d);
    if (user.json && serverEntry(user.json)) return null;
  }
  return problem;
}

/**
 * Resolves true when MT's REST API answers at all (any HTTP status), false on error or timeout. Never
 * rejects. The timer is a TOTAL deadline (connect + response), not Node's idle-socket timeout, so a hung
 * MT that accepts the connection and never answers still costs at most timeoutMs.
 */
function mtApiReachable(deps = {}) {
  const http = deps.http || require('http');
  const timeoutMs = deps.timeoutMs || API_TIMEOUT_MS;
  return new Promise((resolve) => {
    let req;
    const timer = setTimeout(() => { try { req && req.destroy(); } catch { /* already gone */ } resolve(false); }, timeoutMs);
    const done = (value) => { clearTimeout(timer); resolve(value); };
    try {
      req = http.request(
        { hostname: API_HOST, port: API_PORT, path: '/api/health', method: 'GET' },
        (res) => { res.resume(); done(true); });
      req.on('error', () => done(false));
      req.end();
    } catch {
      done(false);
    }
  });
}

/**
 * The warning to print at the very top of SessionStart output, or '' when all is well.
 *
 * FAILS OPEN: if the check itself breaks, it returns '' (no warning) and reports the error on stderr.
 * A bug here must never take the SessionStart hook down, and a false alarm on every healthy session
 * would teach everyone to ignore the warning.
 */
async function multiterminalMcpWarning(env, deps = {}) {
  try {
    if (!env.MULTITERMINAL_DOC_ID) return '';
    const problems = [];
    const configProblem = mcpConfigProblem(env, deps);
    if (configProblem) problems.push(configProblem);
    if (!(await mtApiReachable(deps))) {
      problems.push({
        cause: `MultiTerminal's API at http://${API_HOST}:${API_PORT} is not answering`,
        fix: 'Make sure MultiTerminal is running and has finished starting, then open a new terminal.',
      });
    }
    if (problems.length === 0) return '';

    return [
      '## ⚠️⚠️ MULTITERMINAL TOOLS UNAVAILABLE IN THIS SESSION ⚠️⚠️',
      'The multiterminal MCP server (mcp__multiterminal__* tools) is missing or cannot work here, so',
      'registration, the task board, messaging and every MultiTerminal skill will fail or degrade.',
      ...problems.flatMap((p) => [`- Cause: ${p.cause}.`, `  Fix: ${p.fix}`]),
      'TELL THE USER THIS WARNING FIRST, before anything else, in plain words. Do not report a',
      'MultiTerminal skill step as done when its tool was not available.',
      'If the problem stays, report it at https://github.com/ClarionLive/multiterminal/issues (#25).',
    ].join('\n');
  } catch (err) {
    const report = deps.onError || ((msg) => console.error(msg));
    report(`mcp-availability: check failed, no warning shown (fail-open): ${err && err.message}`);
    return '';
  }
}

module.exports = { multiterminalMcpWarning, mcpConfigProblem, mtApiReachable, userScopeConfigPath, clean };

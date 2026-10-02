#!/usr/bin/env node
/**
 * Unit test for mcp-availability.js (ticket a796e5f9, GitHub #25): an MT-launched session without
 * MultiTerminal's MCP server gets a loud SessionStart warning instead of a normal-looking banner.
 *
 * No real files and no real network: readFile/exists and http are injected.
 */
const assert = require('assert');
const { EventEmitter } = require('events');
const { multiterminalMcpWarning, mcpConfigProblem } = require('../mcp-availability.js');

const APPDATA = 'C:\\Users\\Someone\\AppData\\Roaming';
const CENTRAL = `${APPDATA}\\multiterminal\\.mcp.json`;
const INDEX_JS = `${APPDATA}\\multiterminal\\mcp\\index.js`;
const USER_CFG = 'C:\\Users\\Someone\\.claude.json';
const ENV = { MULTITERMINAL_DOC_ID: 'abc123', APPDATA, USERPROFILE: 'C:\\Users\\Someone' };

const healthy = JSON.stringify({ mcpServers: { multiterminal: { type: 'stdio', command: 'node', args: [INDEX_JS] } } });
const gatewayOnly = JSON.stringify({ mcpServers: { 'mcp-gateway': { command: 'C:\\x\\McpGateway.exe', args: [] } } });

function fsWith(files, existing = Object.keys(files)) {
  const set = new Set(existing);
  return {
    readFile: (f) => { if (!(f in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return files[f]; },
    exists: (p) => set.has(p),
  };
}

/** A fake http whose request answers (or errors) on the next tick, and counts calls. */
function fakeHttp(answers) {
  const fake = {
    calls: 0,
    request(opts, onResponse) {
      fake.calls++;
      const req = new EventEmitter();
      req.end = () => setImmediate(() => {
        if (answers) { const res = new EventEmitter(); res.resume = () => {}; onResponse(res); }
        else req.emit('error', new Error('ECONNREFUSED'));
      });
      req.destroy = () => {};
      return req;
    },
  };
  return fake;
}

let passed = 0;
function ok(cond, label) { assert.ok(cond, label); passed++; }

(async () => {
  // --- config side (pure) ---
  ok(mcpConfigProblem(ENV, fsWith({ [CENTRAL]: healthy }, [INDEX_JS])) === null, 'healthy central file -> no problem');
  ok(/does not exist/.test(mcpConfigProblem(ENV, fsWith({}))), 'missing central file is a problem (the 2.1.0 / #25 shape)');
  ok(/not valid JSON/.test(mcpConfigProblem(ENV, fsWith({ [CENTRAL]: '{ broken' }))), 'unparseable file is a problem');
  ok(/no "multiterminal"/.test(mcpConfigProblem(ENV, fsWith({ [CENTRAL]: gatewayOnly }))), 'gateway-only file is a problem (elevated-install shape)');
  ok(/does not exist: .*index\.js/.test(mcpConfigProblem(ENV, fsWith({ [CENTRAL]: healthy }, []))), 'entry naming a missing index.js is a problem');
  ok(mcpConfigProblem(ENV, fsWith({ [USER_CFG]: healthy }, [INDEX_JS])) === null, 'no central file but a user-scope registration -> fine (GH#2 opt-in)');
  ok(mcpConfigProblem({ ...ENV, CLAUDE_CONFIG_DIR: 'D:\\profiles\\work' },
    fsWith({ 'D:\\profiles\\work\\.claude.json': healthy })) === null, 'CLAUDE_CONFIG_DIR user-scope file is the one consulted');
  ok(mcpConfigProblem({ APPDATA }, fsWith({})) === null, 'not an MT launch -> never judged');

  // --- the warning ---
  const okHttp = fakeHttp(true);
  ok(await multiterminalMcpWarning(ENV, { ...fsWith({ [CENTRAL]: healthy }, [INDEX_JS]), http: okHttp }) === '', 'all healthy -> no warning');
  ok(okHttp.calls === 1, 'API probed once');

  const w = await multiterminalMcpWarning(ENV, { ...fsWith({}), http: fakeHttp(true) });
  ok(/MULTITERMINAL TOOLS UNAVAILABLE/.test(w) && /TELL THE USER/.test(w), 'missing config -> loud warning');

  const down = await multiterminalMcpWarning(ENV, { ...fsWith({ [CENTRAL]: healthy }, [INDEX_JS]), http: fakeHttp(false) });
  ok(/API .* is not answering/.test(down), 'API down -> warning names it');

  const noProbe = fakeHttp(true);
  ok(await multiterminalMcpWarning({ APPDATA }, { ...fsWith({}), http: noProbe }) === '' && noProbe.calls === 0,
    'not an MT launch -> no warning and no network call');

  const throwing = { readFile: () => { throw new Error('x'); }, exists: () => { throw new Error('boom'); }, http: fakeHttp(true) };
  ok(typeof (await multiterminalMcpWarning(ENV, { ...throwing, readFile: () => healthy })) === 'string', 'a throwing dependency never escapes');

  console.log(`unit-mcp-availability: ${passed} passed`);
})().catch((err) => { console.error(err); process.exit(1); });

/**
 * Network tripwire for hook tests (ticket 9a731cda). NOT a unit-*.js, so run-all does not run it.
 *
 * The hooks hard-code localhost:5050 / 127.0.0.1:5050, which on a developer machine is the LIVE
 * MultiTerminal. A test that drives a hook must never be able to reach it, even when the guard
 * under test is broken — and a broken guard is exactly what a falsification run produces.
 *
 * Loaded two ways:
 *   - in-process: require('./_net-tripwire.js') at the top of a unit test;
 *   - in a child: NODE_OPTIONS="--require <abs path>" so it is installed before the hook's code runs.
 *
 * Every outbound connection path Node offers (http/https request+get, net/tls connect, the
 * net.Socket connect method underneath them all, and global fetch) is replaced by a function that
 * RECORDS the attempt and THROWS. Recording is what makes "no call was made" checkable: a hook
 * wraps its http calls in try/catch, so a throw alone would be swallowed silently. When
 * NET_TRIPWIRE_LOG names a file, each attempt appends one line to it; attempts are also kept in
 * `attempts` for in-process callers.
 *
 * This blocks ALL outbound connections, not only :5050. The hooks under test have no legitimate
 * network use in a test, so there is no allowlist to get wrong.
 */
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');

const attempts = [];

function describe(args) {
  try {
    const a = args[0];
    if (typeof a === 'string') return a;
    if (a instanceof URL) return a.href;
    if (a && typeof a === 'object') {
      const host = a.hostname || a.host || a.path || '?';
      return `${host}:${a.port || ''}${a.path && a.hostname ? a.path : ''}`;
    }
    if (typeof a === 'number') return `port ${a} ${typeof args[1] === 'string' ? args[1] : ''}`;
  } catch (_e) { /* fall through */ }
  return '<unknown target>';
}

function trip(kind, args) {
  const line = `${kind} ${describe(args)}`;
  attempts.push(line);
  if (process.env.NET_TRIPWIRE_LOG) {
    try { fs.appendFileSync(process.env.NET_TRIPWIRE_LOG, line + '\n'); } catch (_e) { /* ignore */ }
  }
  throw new Error(`NET TRIPWIRE: outbound connection attempted in a test (${line})`);
}

http.request = (...args) => trip('http.request', args);
http.get = (...args) => trip('http.get', args);
https.request = (...args) => trip('https.request', args);
https.get = (...args) => trip('https.get', args);
net.connect = (...args) => trip('net.connect', args);
net.createConnection = (...args) => trip('net.createConnection', args);
tls.connect = (...args) => trip('tls.connect', args);
net.Socket.prototype.connect = function connect(...args) { return trip('net.Socket.connect', args); };
if (typeof globalThis.fetch === 'function') {
  globalThis.fetch = (...args) => {
    try { trip('fetch', args); } catch (e) { return Promise.reject(e); }
    return Promise.reject(new Error('unreachable'));
  };
}

module.exports = { attempts };

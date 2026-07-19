#!/usr/bin/env node
/**
 * Unit test for context-threshold-hook.run() (ticket 42c91001).
 *
 * WHY A UNIT TEST IN ADDITION TO THE EQUIVALENCE HARNESS: the nudge path WRITES
 * a debounce marker file (and the reset path DELETES it), so running the same
 * band twice is deliberately non-idempotent — exactly what the spawn-equivalence
 * harness (which runs each fixture twice) can't cover without a shared live
 * %TEMP%. The equivalence fixtures therefore only prove the idempotent no-op
 * branches (no name / no statusline file); the band-selection, debounce,
 * escalation, and reset logic are proven here with an in-memory fs + a fixed
 * clock — zero live statusline/marker files touched.
 */
const assert = require('assert');
const path = require('path');
const { run } = require('../context-threshold-hook.js');

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed++; }

// In-memory fs keyed on the exact path.join()'d paths run() builds.
function memFs(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    _store: store,
    existsSync: (p) => store.has(p),
    readFileSync: (p) => { if (!store.has(p)) { const e = new Error('ENOENT ' + p); e.code = 'ENOENT'; throw e; } return store.get(p); },
    writeFileSync: (p, data) => { store.set(p, String(data)); },
    unlinkSync: (p) => { store.delete(p); },
    readdirSync: (dir) => {
      const out = [];
      for (const k of store.keys()) if (path.dirname(k) === dir) out.push(path.basename(k));
      return out;
    },
  };
}

// Use a platform-native temp path so path.join round-trips (dirname of a
// join()'d key equals TMP) — mirrors what os.tmpdir() gives the real hook.
const TMP = path.join(require('os').tmpdir(), 'ctx-unit-42c91001');
const NAME = 'Tester';
const DOC = 'doc1';
const statusPath = path.join(TMP, `mt-statusline-${NAME}-${DOC}.json`);
const markerPath = path.join(TMP, `mt-ctx-nudge-${NAME}.json`);
const NOW = 1_700_000_000_000;
const baseEnv = { MULTITERMINAL_NAME: NAME, MULTITERMINAL_DOC_ID: DOC };

function statusFile(pct, tsOffsetMs = 0) {
  return JSON.stringify({ contextPct: pct, timestamp: NOW - tsOffsetMs });
}
function call(fs, envOverride = {}) {
  return run({}, { fs, tmp: TMP, now: NOW, env: { ...baseEnv, ...envOverride } });
}

// ── 1. First crossing of 80 band → 🟠 nudge + marker written at band 80 ──
{
  const fs = memFs({ [statusPath]: statusFile(85) });
  const r = call(fs);
  ok(r.exitCode === 0, 'band-80 exit 0');
  ok(r.stdout && r.stdout.includes('🟠') && r.stdout.includes('85%'), 'band-80 emits 🟠 nudge with pct');
  ok(r.stdout.includes('compact_my_context') && r.stdout.includes('clear_my_context'),
    'band-80 offers BOTH compact and clear (agent chooses)');
  const marker = JSON.parse(fs._store.get(markerPath));
  ok(marker.band === 80, 'band-80 marker persisted at 80');
}

// ── 2. Debounce: same band already recorded → no re-nudge ──
{
  const fs = memFs({
    [statusPath]: statusFile(85),
    [markerPath]: JSON.stringify({ band: 80, pct: 85, ts: NOW - 1000 }),
  });
  const r = call(fs);
  ok(!r.stdout, 'debounce: no nudge when marker.band >= band');
}

// ── 3. Escalation: recorded 80, now 92 → 🔴 nudge + marker bumped to 90 ──
{
  const fs = memFs({
    [statusPath]: statusFile(92),
    [markerPath]: JSON.stringify({ band: 80, pct: 85, ts: NOW - 1000 }),
  });
  const r = call(fs);
  ok(r.stdout && r.stdout.includes('🔴') && r.stdout.includes('92%'), 'escalation emits 🔴 at 90 band');
  ok(r.stdout.includes('compact_my_context') && r.stdout.includes('clear_my_context'),
    'band-90 offers BOTH compact and clear (agent chooses)');
  ok(JSON.parse(fs._store.get(markerPath)).band === 90, 'escalation marker bumped to 90');
}

// ── 4. Reset: below threshold clears any existing marker, no nudge ──
{
  const fs = memFs({
    [statusPath]: statusFile(40),
    [markerPath]: JSON.stringify({ band: 80, pct: 85, ts: NOW - 1000 }),
  });
  const r = call(fs);
  ok(!r.stdout, 'below-threshold: no nudge');
  ok(!fs._store.has(markerPath), 'below-threshold: marker unlinked (reset)');
}

// ── 5. Stale reading (> 5 min old) → ignored, no nudge, no marker write ──
{
  const fs = memFs({ [statusPath]: statusFile(95, 6 * 60 * 1000) });
  const r = call(fs);
  ok(!r.stdout, 'stale reading: no nudge');
  ok(!fs._store.has(markerPath), 'stale reading: no marker written');
}

// ── 6. Custom threshold raises the 🟡 band and drops fixed bands below it ──
{
  const fs = memFs({ [statusPath]: statusFile(88) });
  const r = call(fs, { MULTITERMINAL_CONTEXT_THRESHOLD: '85' });
  ok(r.stdout && r.stdout.includes('🟠'), 'threshold 85, pct 88 → 80 band still applies (88>=80)');
}

// ── 7. No name → no output (not a MultiTerminal terminal) ──
{
  const r = call(memFs({ [statusPath]: statusFile(95) }), { MULTITERMINAL_NAME: '' });
  ok(!r.stdout && r.exitCode === 0, 'no name → silent exit 0');
}

// ── 8. No statusline file (via readdir path, no docId) → no output ──
{
  const r = run({}, { fs: memFs({}), tmp: TMP, now: NOW, env: { MULTITERMINAL_NAME: NAME } });
  ok(!r.stdout && r.exitCode === 0, 'no statusline file → silent exit 0');
}

// ── 9. readdir fallback (no docId) finds the freshest statusline file ──
{
  const noDocPath = path.join(TMP, `mt-statusline-${NAME}-docX.json`);
  const fs = memFs({ [noDocPath]: statusFile(91) });
  const r = run({}, { fs, tmp: TMP, now: NOW, env: { MULTITERMINAL_NAME: NAME } });
  ok(r.stdout && r.stdout.includes('🔴'), 'readdir fallback resolves file → 🔴 at 91%');
}

// ── 10. 🟡 band (lowest) also offers BOTH compact and clear ──
{
  const fs = memFs({ [statusPath]: statusFile(72) });
  const r = call(fs);
  ok(r.stdout && r.stdout.includes('🟡') && r.stdout.includes('72%'), 'band-70 emits 🟡 nudge with pct');
  ok(r.stdout.includes('compact_my_context') && r.stdout.includes('clear_my_context'),
    'band-70 offers BOTH compact and clear (agent chooses)');
}

console.log(`context-threshold run() unit: PASS (${passed} assertions)`);

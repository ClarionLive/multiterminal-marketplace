#!/usr/bin/env node
/**
 * Shim-equivalence harness (ticket 42c91001, dispatcher merge).
 *
 * Proves a refactored hook (run()+CLI-shim form) behaves BYTE-IDENTICALLY to its
 * pre-refactor version when invoked standalone — which is exactly how hooks.json
 * invokes it (`node X.js [arg]`). A passing run means the live swap is safe.
 *
 * Usage:
 *   node equivalence.js <fileA> <fileB> <fixtures.json>
 *   fileA = baseline (e.g. the HEAD version), fileB = refactored candidate.
 *
 * Fixtures JSON = array of cases: { name, stdin (object|string), argv?, env? }.
 * Each case is piped through BOTH files; stdout/stderr/exit are compared.
 * Fixtures MUST target branches that are safe to execute twice (no real spawns /
 * no destructive I/O) — side-effecting hooks use injected-dep stubs via env, see
 * their fixtures. Exit non-zero if any case diverges.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');

function runHook(file, fixture) {
  const input = typeof fixture.stdin === 'string'
    ? fixture.stdin
    : JSON.stringify(fixture.stdin == null ? {} : fixture.stdin);
  const res = spawnSync('node', [file, ...(fixture.argv || [])], {
    input,
    env: { ...process.env, ...(fixture.env || {}) },
    encoding: 'utf8',
    timeout: 15000,
  });
  return { stdout: res.stdout || '', stderr: res.stderr || '', status: res.status };
}

function main() {
  const [, , fileA, fileB, fixturesFile] = process.argv;
  if (!fileA || !fileB || !fixturesFile) {
    console.error('usage: node equivalence.js <fileA> <fileB> <fixtures.json>');
    process.exit(2);
  }
  const cases = JSON.parse(fs.readFileSync(fixturesFile, 'utf8'));
  let pass = 0;
  let fail = 0;
  for (const fx of cases) {
    const a = runHook(fileA, fx);
    const b = runHook(fileB, fx);
    const same = a.stdout === b.stdout && a.stderr === b.stderr && a.status === b.status;
    if (same) {
      pass++;
      console.log(`  ✓ ${fx.name}`);
    } else {
      fail++;
      console.log(`  ✗ ${fx.name}`);
      if (a.stdout !== b.stdout) console.log(`      stdout A=${JSON.stringify(a.stdout)}\n             B=${JSON.stringify(b.stdout)}`);
      if (a.stderr !== b.stderr) console.log(`      stderr A=${JSON.stringify(a.stderr)}\n             B=${JSON.stringify(b.stderr)}`);
      if (a.status !== b.status) console.log(`      exit   A=${a.status} B=${b.status}`);
    }
  }
  console.log(`\nEQUIVALENCE ${fileA}\n         vs ${fileB}\n  => ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

main();

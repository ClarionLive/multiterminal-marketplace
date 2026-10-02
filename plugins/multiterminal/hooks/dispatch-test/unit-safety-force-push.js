#!/usr/bin/env node
/**
 * Unit test for safety-hook's force-push rule (ticket e0fa9d90, GitHub #28).
 *
 * The rule was /\bgit\s+push\s+.*(-f|--force)\b/. Its greedy .* ran through
 * &&, ; and |, so a `git push` followed by ANY later command carrying -f
 * (rm -f, tail -f, grep -f) was gated as a force push. The fix stops the scan
 * at those separators, as clarion-assistant's copy already did (its GitHub #67).
 *
 * Both directions are pinned: the chained commands from the issue must not raise
 * the force-push prompt, and real force pushes, including one chained to an
 * rm -f, must still raise it. The NOT_FORCE cases check the force-push reason
 * only, so a different rule asking about the same command does not count as a
 * pass or a failure here.
 *
 * Falsified when written: against the old .* pattern, 7 of 17 cases went red,
 * exactly the seven chained NOT_FORCE cases. The two plain pushes and every
 * FORCE case stayed green, as they should under either pattern.
 */
const { run } = require('../safety-hook.js');

const FORCE_REASON = 'Force-push detected';

function decisionFor(command) {
  const { stdout } = run({ tool_name: 'Bash', tool_input: { command } });
  if (!stdout) return { decision: 'allow', reason: '' };
  const out = JSON.parse(stdout).hookSpecificOutput;
  return { decision: out.permissionDecision, reason: out.permissionDecisionReason };
}

// Not force pushes: the -f belongs to a later command in the chain.
const NOT_FORCE = [
  // The four reproductions from GitHub #28, verbatim.
  'git push && rm -f build.log',
  'git push && tail -f server.log',
  'git push origin main; grep -f patterns.txt out.txt',
  'git push 2>&1 | tail -3 && rm -f ./scratch/session_log.md',
  // The same shape after other separators and with other -f programs.
  'git push -q && rm -f x',
  'git push origin task/x || docker build -f Dockerfile .',
  'git push | ssh -f host true',
  // A plain push is not a force push either.
  'git push',
  'git push origin main',
];

// Force pushes: MUST raise the force-push prompt.
const FORCE = [
  'git push -f',
  'git push --force',
  'git push origin main --force',
  'git push --force-with-lease',
  'git push origin main -f',
  'git push -f origin main',
  // A real force push stays gated when a later command also has -f.
  'git push -f && rm -f x',
  'cd repo && git push --force origin main',
];

const failures = [];
let checked = 0;

for (const command of NOT_FORCE) {
  checked++;
  const { reason } = decisionFor(command);
  if (reason.startsWith(FORCE_REASON)) failures.push(`should NOT ask about a force push, but did: ${command}`);
}

for (const command of FORCE) {
  checked++;
  const { decision, reason } = decisionFor(command);
  if (decision !== 'ask' || !reason.startsWith(FORCE_REASON)) {
    failures.push(`should ask about a force push, got ${decision} (${reason || 'no reason'}): ${command}`);
  }
}

if (failures.length > 0) {
  console.error(`FAIL: ${failures.length} of ${checked} cases`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log(`PASS: ${checked} force-push cases`);

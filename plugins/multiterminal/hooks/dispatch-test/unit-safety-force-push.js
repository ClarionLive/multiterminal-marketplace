#!/usr/bin/env node
/**
 * Unit test for safety-hook's force-push rule (ticket e0fa9d90, GitHub #28).
 *
 * The rule was /\bgit\s+push\s+.*(-f|--force)\b/. Its greedy .* ran through &&, ; and |, so a
 * `git push` followed by ANY later command carrying -f (rm -f, tail -f, grep -f) was gated as a force
 * push. The first fix stopped the scan at those separators, as clarion-assistant's copy already did
 * (its GitHub #67). Pipeline run 1 then found what a regex over the raw text still gets wrong: a
 * redirection's & (2>&1) ended the scan early, a newline did not end it, a line continuation did, and
 * a separator inside quotes did. safety-hook.js now normalizes the command first (isForcePush).
 *
 * Both directions are pinned: NOT_FORCE must not raise the force-push prompt, FORCE must. NOT_FORCE
 * checks the force-push reason only, so a different rule asking about the same command does not count
 * as a pass or a failure here.
 *
 * THE SAME TABLE is run against clarion-assistant's copy of safety-hook.js when it is installed under
 * %USERPROFILE%\.claude\plugins\marketplaces (or named by SAFETY_HOOK_CA_PATH), because the two plugins
 * ship divergent copies and #28 was a fix made in one and missed in the other. That copy exports
 * nothing, so it is driven as a child process through stdin, as Claude Code runs it. When it is not
 * installed the run says so and checks this plugin only. A divergence fails this test: the point is
 * that a fix in one copy cannot silently miss the other.
 *
 * Falsified when written (2026-10-02), expectation stated before each run:
 *   - against the original .* pattern, 7 of the first 17 cases went red, exactly the seven chained
 *     NOT_FORCE cases;
 *   - against the first fix (/\bgit\s+push\s+[^&;|]*(-f\b|--force\b)/, which is also what
 *     clarion-assistant ships), 6 of 30 went red as predicted: the three line-break NOT_FORCE cases,
 *     hotfix-f, `2>&1 --force` and `-o "a;b" --force`;
 *   - against the original .* pattern on the full 30, 13 went red (observed, not predicted beforehand).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { run } = require('../safety-hook.js');

const FORCE_REASON = 'Force-push detected';

// Not force pushes: the -f belongs to another command, or there is no force flag at all.
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
  // Pipeline run 1: a line break ends the command (LF and CRLF).
  'git push\nrm -f x',
  'git push origin main\nrm -f x',
  'git push origin main\r\nrm -f x',
  // Pipeline run 1: a separator inside quotes is an argument, and there is no force flag here.
  'git push -o "a;b"',
  // A redirection's & is not a separator, and these push with no force flag.
  'git push &>/dev/null && rm -f x',
  'git push 2>&- ; rm -f x',
  // A branch whose name ends in -f is not a flag.
  'git push origin hotfix-f',
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
  // Pipeline run 1: the & of a redirection must not end the scan.
  'git push origin main 2>&1 --force',
  // Pipeline run 1: a line continuation (bash, then PowerShell) keeps it one command.
  'git push \\\n  --force',
  'git push `\n  --force',
  // A separator inside quotes must not end the scan, and a quoted flag is still the flag.
  'git push -o "a;b" --force',
  'git push "--force"',
  // The forced push is the second one.
  'git push origin main 2>&1 | tail -3 && git push -f',
];

// ── The decision of each copy ──
function fromStdout(stdout) {
  if (!stdout || !stdout.trim()) return { decision: 'allow', reason: '' };
  const out = JSON.parse(stdout).hookSpecificOutput;
  return { decision: out.permissionDecision, reason: out.permissionDecisionReason || '' };
}

const thisPlugin = (command) => fromStdout(run({ tool_name: 'Bash', tool_input: { command } }).stdout);

function findClarionAssistantCopy() {
  if (process.env.SAFETY_HOOK_CA_PATH) return fs.existsSync(process.env.SAFETY_HOOK_CA_PATH) ? process.env.SAFETY_HOOK_CA_PATH : null;
  const root = path.join(os.homedir(), '.claude', 'plugins', 'marketplaces');
  if (!fs.existsSync(root)) return null;
  for (const market of fs.readdirSync(root)) {
    if (!/clarion/i.test(market)) continue;
    const plugins = path.join(root, market, 'plugins');
    if (!fs.existsSync(plugins)) continue;
    for (const plugin of fs.readdirSync(plugins)) {
      const candidate = path.join(plugins, plugin, 'hooks', 'safety-hook.js');
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function childCopy(hookPath) {
  return (command) => {
    const r = spawnSync(process.execPath, [hookPath], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
      encoding: 'utf8',
      timeout: 10000,
    });
    if (r.error || r.status !== 0) throw new Error(`${hookPath} did not run: ${r.error || `exit ${r.status}`}`);
    return fromStdout(r.stdout);
  };
}

function check(label, decisionFor) {
  const failures = [];
  for (const command of NOT_FORCE) {
    if (decisionFor(command).reason.startsWith(FORCE_REASON)) {
      failures.push(`should NOT ask about a force push, but did: ${JSON.stringify(command)}`);
    }
  }
  for (const command of FORCE) {
    const { decision, reason } = decisionFor(command);
    if (decision !== 'ask' || !reason.startsWith(FORCE_REASON)) {
      failures.push(`should ask about a force push, got ${decision} (${reason || 'no reason'}): ${JSON.stringify(command)}`);
    }
  }
  const total = NOT_FORCE.length + FORCE.length;
  if (failures.length > 0) {
    console.error(`FAIL [${label}]: ${failures.length} of ${total} cases`);
    for (const f of failures) console.error(`  - ${f}`);
  } else {
    console.log(`  ok [${label}]: ${total} cases`);
  }
  return failures.length;
}

let failed = check('multiterminal', thisPlugin);

const ca = findClarionAssistantCopy();
if (ca) {
  failed += check(`clarion-assistant ${ca}`, childCopy(ca));
} else {
  console.log('  note: clarion-assistant safety-hook.js not installed, so only this plugin was checked');
}

if (failed > 0) process.exit(1);
console.log(`PASS: ${NOT_FORCE.length + FORCE.length} force-push cases${ca ? ', both plugins' : ''}`);

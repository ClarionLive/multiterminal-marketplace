#!/usr/bin/env node
/**
 * Unit test for safety-hook's process-kill rule (ticket 24a72aa1).
 *
 * The rule used to ask whenever the word "kill" appeared anywhere in a Bash
 * command, so a helper grepping for '"quit"\|"kill"' sat on a confirmation
 * prompt until the Owner answered it. These cases pin both directions:
 * mentions of a kill must pass silently, and kills that are actually run —
 * including pkill/killall, which the old rule missed — must still ask.
 *
 * Unlike its siblings, this file collects every failing case before exiting,
 * so a mutation run reports exactly which cases went red instead of the first.
 */
const { run } = require('../safety-hook.js');

const KILL_REASON = 'Process termination detected';

function decisionFor(command) {
  const { stdout } = run({ tool_name: 'Bash', tool_input: { command } });
  if (!stdout) return { decision: 'allow', reason: '' };
  const out = JSON.parse(stdout).hookSpecificOutput;
  return { decision: out.permissionDecision, reason: out.permissionDecisionReason };
}

// Mentions of a kill: must NOT raise the kill prompt.
const MENTIONS = [
  // The command from the Owner's screenshot, verbatim.
  'cd "H:/DevLaptop/Projects/ClarionDebugger/.claude/worktrees/w5-e/src/ClarionDbg.Cli" && grep -n "chosen by\\|pause: thread" ProtocolCheck*.cs | head; grep -n \'"quit"\\|"kill"\' *.cs | head -20',
  'git commit -m "A closed pane no longer needs a kill to go away"',
  "echo 'taskkill is how the old launcher stopped it'",
  'grep -rn "Stop-Process" .',
  'grep -n kill *.cs',
  'cat docs/kill-switch.md',
  'rg -n "pkill|killall" hooks/',
  // A separator INSIDE the quotes puts the word in command position; only the
  // quote-stripping keeps these silent.
  'git commit -m "Retry once; kill the stale helper after"',
  "echo 'ps | pkill'",
];

// Kills that are run: MUST raise the kill prompt.
const KILLS = [
  'taskkill /IM foo.exe /F',
  'kill -9 123',
  'cd build && kill 123',
  'echo stopping; Stop-Process -Id 5',
  'pkill node',
  'killall node',
  'ps aux | grep node | xargs kill',
  'sudo kill 1',
  '/c/Windows/System32/taskkill.exe /PID 5',
  '(kill 1)',
  'echo $(pkill x)',
  'echo a\nkill 5',
  // Nested shells: the quoted text is itself a command, so it is still checked.
  'powershell -Command "Stop-Process -Name MultiTerminal"',
  "pwsh -c 'Get-Process x | Stop-Process'",
  'bash -c "kill 1"',
];

const failures = [];
let checked = 0;

for (const command of MENTIONS) {
  checked++;
  const { reason } = decisionFor(command);
  if (reason.startsWith(KILL_REASON)) failures.push(`should NOT ask, but asked: ${command}`);
}

for (const command of KILLS) {
  checked++;
  const { decision, reason } = decisionFor(command);
  if (decision !== 'ask' || !reason.startsWith(KILL_REASON)) {
    failures.push(`should ask, got ${decision}: ${command}`);
  }
}

// The rule table still honours plain `pattern` rules: a deny rule before the kill
// rule and an ask rule after it both keep working.
checked++;
if (decisionFor('git add -A').decision !== 'deny') failures.push('git add -A is no longer denied');
checked++;
if (!decisionFor('reg add HKCU\\Software\\X').reason.startsWith('Windows registry')) {
  failures.push('reg add no longer asks');
}

if (failures.length > 0) {
  console.error(`FAIL: ${failures.length} of ${checked} cases`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`PASS: ${checked} cases`);

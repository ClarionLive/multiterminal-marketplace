#!/usr/bin/env node
/**
 * agent-rules-hook.js — SessionStart hook (matcher "startup|resume|clear|compact"), task 9d3404d9.
 *
 * Prints the universal MultiTerminal agent rules (../agent-rules.md) into every MT session, in
 * every project, on a normal AND a quiet start, and again after compaction.
 *
 * Why a hook of its own, rather than a section of session-status-hook's output:
 *   - Claude Code does not load a CLAUDE.md at a plugin's root, so the plugin's rules can only reach
 *     a session as hook output.
 *   - Hook output is capped at 10,000 characters PER HOOK COMMAND ("Claude Code measures each string
 *     on its own, even when several hooks run for the same event"); over the cap the model sees only
 *     a 2,000-character preview. session-status-hook's output was measured at 14.8KB in an MT-repo
 *     pane, so rules printed there were mostly cut. A separate command gets its own budget, and the
 *     status hook's prefetch, knowledge and board can never push the rules out of it.
 *     (Source: code.claude.com/docs/en/hooks, output limits.)
 *   - SessionStart hooks run in parallel and the order of their outputs in context is not
 *     specified. So this hook cannot rely on being printed before or after session-status-hook's
 *     quiet note or a helper's "YOUR FIRST ACTION" line. It carries its own: a helper header that
 *     defers to the first action, and a quiet footer that ends the rules on "wait for the user".
 *
 * The rules file is read relative to THIS file, never the cwd: the old multiterminal-rules.md was
 * read from the launch folder and so existed only in sessions launched in the MT repo.
 *
 * Silent in a ClarionAssistant tab (messaging only; .claude/rules/ca-embedded-sessions.md) and in
 * a session that is not an MT terminal (no MULTITERMINAL_NAME). Never fails a startup.
 */
const fs = require('fs');
const path = require('path');
const { isClarionEmbedded } = require('./embedded-session.js');
const { isQuietStart } = require('./session-status-hook.js');

const RULES_PATH = path.join(__dirname, '..', 'agent-rules.md');

// The rules block must stay well inside the 10,000-character hook cap with room for the header and
// footer below. Asserted by dispatch-test/unit-agent-rules.js against the real file.
const RULES_BUDGET_CHARS = 6000;

const HELPER_HEADER = 'Spawned helper: if your SessionStart output says YOUR FIRST ACTION, do that before anything below. These rules govern how you work, not what comes first.';
const QUIET_FOOTER = [
  '## Quiet start',
  "Quiet start is on for this project. Nothing above asks you to act before the user speaks: wait for the user's first message and act on that.",
];

// Pure apart from the injected fs. Returns { exitCode: 0, stdout }.
function run(hookData, deps = {}) {
  const env = deps.env || process.env;
  const _fs = deps.fs || fs;
  const rulesPath = deps.rulesPath || RULES_PATH;
  if (isClarionEmbedded(env) || !env.MULTITERMINAL_NAME) return { exitCode: 0, stdout: '' };

  let rules = '';
  try {
    rules = String(_fs.readFileSync(rulesPath, 'utf-8')).trim();
  } catch (_e) {
    return { exitCode: 0, stdout: '' };
  }
  if (!rules) return { exitCode: 0, stdout: '' };

  const source = (hookData && hookData.source) || '';
  // Same conditions session-status-hook uses: a helper takes its first-action branch on any
  // source but /clear, and after compaction neither note applies (the session is mid-work).
  const helperFirst = !!env.MULTITERMINAL_SPAWNER && source !== 'clear' && source !== 'compact';
  const quiet = isQuietStart(env) && source !== 'compact';

  const out = [];
  if (helperFirst) out.push(HELPER_HEADER, '');
  out.push(rules);
  if (quiet) out.push('', ...QUIET_FOOTER);
  return { exitCode: 0, stdout: out.join('\n') + '\n' };
}

module.exports = { run, RULES_PATH, RULES_BUDGET_CHARS, HELPER_HEADER, QUIET_FOOTER };

if (require.main === module) {
  (async () => {
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    let hookData = {};
    try { hookData = input.trim() ? JSON.parse(input) : {}; } catch (_e) { hookData = {}; }
    let out = { exitCode: 0 };
    try { out = run(hookData); } catch (_e) { out = { exitCode: 0 }; }
    if (out && out.stdout) process.stdout.write(out.stdout);
    process.exit(0);
  })().catch(() => process.exit(0));
}

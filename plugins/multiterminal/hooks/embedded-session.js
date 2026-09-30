/**
 * embedded-session.js — is this Claude Code session a ClarionAssistant tab? (ticket 9a731cda)
 *
 * ClarionAssistant (CA) hosts Claude Code sessions inside the Clarion IDE, not in MultiTerminal
 * panes, and loads this whole plugin via --plugin-dir. A CA tab's environment carries
 * CLARION_ASSISTANT_EMBEDDED=1 and MULTITERMINAL_NAME=CA-<slug>, but no MULTITERMINAL_DOC_ID and
 * no MULTITERMINAL_LAUNCH_NONCE. Because MULTITERMINAL_NAME is set, every "MT-only" guard that keys
 * on the name alone lets a CA tab through.
 *
 * Owner decision: CA tabs get MESSAGING ONLY from this plugin. Native delivery is MT's MCP server's
 * job; the plugin's single CA job is the inbox fallback (inbox-check-hook). Every other hook either
 * skips itself (standalone hooks) or is filtered out by the dispatcher's allowlist.
 *
 * The truth table is pinned by dispatch-test/unit-embedded-session.js. "0" and "false" count as
 * NOT embedded so an explicit opt-out reads the way it looks; the previous inline checks
 * (`if (process.env.CLARION_ASSISTANT_EMBEDDED)`) treated "0" as embedded.
 *
 * MIRRORED in MultiTerminal's mcp/index.js (isClarionEmbedded), which decides whether the same
 * session registers itself as a CA tab. The two ship separately and cannot share code; they must
 * agree, or one session is a CA tab to the MCP server and an MT pane to these hooks.
 */
function isClarionEmbedded(env) {
  if (!env || typeof env !== 'object') return false;
  const v = env.CLARION_ASSISTANT_EMBEDDED;
  if (typeof v !== 'string' || v === '') return false;
  const norm = v.trim().toLowerCase();
  return norm !== '' && norm !== '0' && norm !== 'false';
}

module.exports = { isClarionEmbedded };

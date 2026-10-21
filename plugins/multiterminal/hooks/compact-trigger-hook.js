#!/usr/bin/env node
/**
 * compact-trigger-hook.js — PreCompact leaf (dispatched), MultiTerminal ticket c0ebcfd4.
 *
 * Tells MultiTerminal whether the compaction about to run is manual or automatic. SessionStart(compact)
 * fires for both and does not say which, and only a MANUAL compaction may claim the continue request
 * an agent made with compact_my_context: an automatic compaction can run mid-turn while the agent's
 * requested /compact is still waiting for the turn to end, and must leave that request for it.
 *
 * Self-gates on PreCompact. Skipped in ClarionAssistant tabs and in sessions that are not an MT pane
 * (no MULTITERMINAL_NAME or MULTITERMINAL_DOC_ID). An unknown trigger is not sent. No stdout; never
 * throws; the POST times out after 2s so the sync PreCompact head stays inside its 8s budget.
 */
const { isClarionEmbedded } = require('./embedded-session.js');
const { postToMt } = require('./session-compact-hook.js');

async function run(hookData, deps = {}) {
  const env = deps.env || process.env;
  const data = hookData || {};
  const event = data.hook_event_name || (deps.hookType) || '';
  if (event && event !== 'PreCompact') return { exitCode: 0 };
  if (isClarionEmbedded(env)) return { exitCode: 0 };
  const agentName = env.MULTITERMINAL_NAME || '';
  const docId = env.MULTITERMINAL_DOC_ID || '';
  const trigger = data.trigger;
  if (!agentName || !docId || (trigger !== 'manual' && trigger !== 'auto')) return { exitCode: 0 };
  const post = deps.post || ((b) => postToMt('/api/terminals/compact-starting', b, 2000));
  try { await post({ agentName, docId, trigger }); } catch { /* never fails the hook */ }
  return { exitCode: 0 };
}

module.exports = { run };

#!/usr/bin/env node
/**
 * Stop Relay Hook — notifies ClaudeRemote when the agent is waiting for input.
 *
 * When remote mode is on and the agent stops (waiting for user input),
 * sends a notification to ClaudeRemote so the user knows to respond.
 * The user replies via the ClaudeRemote channel.
 */

const MT_API = process.env.MT_API_URL || 'http://localhost:5050';
const AGENT_NAME = process.env.MULTITERMINAL_NAME || 'unknown';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', async () => {
  try {
    // Check remote mode — if off, do nothing
    const modeRes = await fetch(`${MT_API}/api/remote-mode`);
    if (!modeRes.ok) process.exit(0);
    const modeData = await modeRes.json();
    if (!modeData.remote_mode) process.exit(0);

    // Parse stop event for context
    let stopReason = 'end_turn';
    try {
      const event = JSON.parse(input);
      stopReason = event.stop_reason || 'end_turn';
    } catch {}

    // Only notify on end_turn (agent waiting for input), not on errors/max_turns
    if (stopReason !== 'end_turn') process.exit(0);

    // Send notification to ClaudeRemote
    await fetch(`${MT_API}/api/messaging/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fromTerminalId: AGENT_NAME,
        to: 'ClaudeRemote',
        message: `[WAITING_FOR_INPUT:${AGENT_NAME}] ${AGENT_NAME} is waiting for your response.`,
        priority: 'high'
      })
    });

    process.exit(0);
  } catch {
    process.exit(0);
  }
});

#!/usr/bin/env node
/**
 * Unit test for notification-hook.run() (ticket 42c91001).
 * Proves the Notification→payload mapping + POST with a spy callApi — never hits
 * :5050. Equivalence harness covers the wrapper on non-Notification branches.
 */
process.env.MULTITERMINAL_NAME = 'Henry';
const assert = require('assert');
const { run } = require('../notification-hook.js');

async function main() {
  let posted = null;
  const apiSpy = (apiPath, method, body) => { posted = { apiPath, method, body }; return Promise.resolve({ ok: true, data: {} }); };

  // Notification event → POST /api/notifications with mapped type + message.
  await run({ hook_event_name: 'Notification', notification_type: 'idle_prompt', session_id: 's1' }, { callApi: apiSpy });
  assert.ok(posted, 'Notification → callApi');
  assert.strictEqual(posted.apiPath, '/api/notifications', 'posts to notifications endpoint');
  assert.strictEqual(posted.body.notification_type, 'permission_request', 'idle_prompt → permission_request');
  assert.ok(posted.body.message.includes('waiting'), 'idle_prompt message text');
  assert.strictEqual(posted.body.agent_name, 'Henry', 'agent name from env');

  // Non-Notification event → no POST.
  posted = null;
  await run({ hook_event_name: 'PostToolUse' }, { callApi: apiSpy });
  assert.strictEqual(posted, null, 'non-Notification → no callApi');

  const r = await run({ hook_event_name: 'Notification', notification_type: 'x' }, { callApi: apiSpy });
  assert.strictEqual(r.exitCode, 0, 'returns exitCode 0');

  console.log('notification run() unit: PASS (6 assertions)');
}

main().catch((e) => { console.error(e); process.exit(1); });

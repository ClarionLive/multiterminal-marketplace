#!/usr/bin/env node
/**
 * Unit test for notification-hook.run() (ticket 42c91001).
 * Proves the Notification→payload mapping + POST with a spy callApi — never hits
 * :5050. Equivalence harness covers the wrapper on non-Notification branches.
 */
process.env.MULTITERMINAL_NAME = 'Henry';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run, resolveProjectName, readProjectName } = require('../notification-hook.js');

/**
 * MultiTerminal task 42052f0c — the attention rail's project line was blank for almost
 * every agent, because this hook joined cwd + '.claude/project.json' ONCE. MT's task
 * worktrees live at <repo>/.claude/worktrees/<taskId> and hold no project.json of their
 * own, so every agent working in a worktree — now the normal case — reported ''.
 *
 * Hermetic: builds its own tree under os.tmpdir() rather than asserting against whatever
 * repo happens to be on the machine.
 */
function projectResolutionTests() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-proj-'));
  const claudeDir = path.join(root, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'project.json'), JSON.stringify({ name: 'DemoProject' }));

  const worktree = path.join(claudeDir, 'worktrees', 'a1b2c3d4');
  fs.mkdirSync(worktree, { recursive: true });

  assert.strictEqual(resolveProjectName(root), 'DemoProject', 'repo root resolves');

  // THE REGRESSION, stated so it is falsifiable rather than merely described.
  // readProjectName IS the old single-join behaviour, so these two lines are the before
  // and after of the fix standing side by side. If someone reverts resolveProjectName to
  // a plain join, the second assertion goes red immediately.
  assert.strictEqual(readProjectName(worktree), '', 'old single-join behaviour: worktree finds nothing');
  assert.strictEqual(resolveProjectName(worktree), 'DemoProject', 'worktree resolves to its repo root');

  // Windows separators are what Claude Code actually supplies in hookData.cwd.
  assert.strictEqual(
    resolveProjectName(worktree.replace(/\//g, '\\')),
    'DemoProject',
    'worktree resolves with backslash separators');

  // A directory with no project of its own stays honestly blank rather than adopting an
  // unrelated ancestor's project — the reason this strips the worktree suffix instead of
  // walking up the tree looking for any project.json it can find.
  const orphan = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-orphan-'));
  assert.strictEqual(resolveProjectName(orphan), '', 'unrelated dir does not inherit a project');

  // A project.json that exists but names nothing is not an error.
  const nameless = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-nameless-'));
  fs.mkdirSync(path.join(nameless, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(nameless, '.claude', 'project.json'), '{"id":"x"}');
  assert.strictEqual(resolveProjectName(nameless), '', 'project.json without a name → empty');

  // Malformed JSON must not throw — the project name is optional metadata and must never
  // take a notification down.
  const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-broken-'));
  fs.mkdirSync(path.join(broken, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(broken, '.claude', 'project.json'), '{not json');
  assert.strictEqual(resolveProjectName(broken), '', 'malformed project.json → empty, no throw');

  assert.strictEqual(resolveProjectName(''), '', 'empty cwd → empty');
  assert.strictEqual(resolveProjectName(null), '', 'null cwd → empty');

  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(orphan, { recursive: true, force: true });
  fs.rmSync(nameless, { recursive: true, force: true });
  fs.rmSync(broken, { recursive: true, force: true });

  console.log('notification resolveProjectName unit: PASS (10 assertions)');
}

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

  projectResolutionTests();
}

main().catch((e) => { console.error(e); process.exit(1); });

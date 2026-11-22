'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');

const [before, reopened, central] = process.argv.slice(2).map(path =>
  JSON.parse(readFileSync(path, 'utf8'))
);
assert.match(process.env.NS_EXPECTED_MOBILE_BUNDLE ?? '', /^\/mobile\/assets\/index-[^/]+\.js$/);
for (const view of [before, reopened]) {
  assert.equal(view.origin, 'https://127.0.0.1:18443');
  assert.equal(view.bundle, process.env.NS_EXPECTED_MOBILE_BUNDLE);
  assert.equal(view.connection, '已连接');
  assert.equal(view.readback.status, 200);
  assert.match(view.readback.sessionMarker, /^[\da-f]{64}$/);
  assert.equal(view.secure, true);
  assert.equal(view.visible, true);
  assert.equal(view.standalone, true);
  assert.equal(view.workerControlled, true);
  assert.equal(view.isPrivate, false);
  assert.match(view.focus, /u12 org\.mozilla\.firefox\/org\.mozilla\.fenix\.customtabs\.ExternalAppBrowserActivity/);
}
assert.notEqual(before.pid, reopened.pid);
assert.equal(before.readback.sessionMarker, reopened.readback.sessionMarker);
assert.deepEqual(before.observed, reopened.observed);

const { topicKey, messages, executions } = reopened.observed;
assert.equal(topicKey, central.sharedTopicId);
assert.equal(central.work.state, 'completed');
assert.equal(central.work.attempts, 1);
assert.deepEqual(executions, [{ id: central.work.id, state: 'completed' }]);
assert.deepEqual(messages.map(({ id, role, sha256 }) => ({ id, role, contentSha256: sha256 })),
  central.journal.map(({ id, role, contentSha256 }) => ({ id, role, contentSha256 })));
assert.deepEqual(messages.map(message => message.id), [central.work.user_message_id, central.work.reply_message_id]);
assert.equal(new Set(messages.map(message => message.id)).size, 2);

console.log(JSON.stringify({
  verified: true,
  androidUser: 12,
  bundle: reopened.bundle,
  beforePid: before.pid,
  coldPid: reopened.pid,
  unchangedSessionMarker: true,
  topicKey,
  messages,
  executions,
}, null, 2));

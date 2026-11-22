'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const run = process.argv[2];
const read = name => JSON.parse(fs.readFileSync(path.join(run, name), 'utf8'));
const ready = read('ready.json');
const status = read('status.json');
assert.equal(status.work.length, 1);
assert.equal(status.providerCalls, 1);
assert.equal(status.totalProviderRequests, 1);
const work = status.work[0];
assert.equal(work.state, 'completed');
assert.equal(work.attempts, 1);
const { itemId, topicId } = ready.desktopDescriptor;
const history = read(path.join('profile-A', 'UserData', itemId, 'topics', topicId, 'history.json'));

function messageHash(id, message) {
    assert.equal(typeof message.content, 'string');
    return { id, role: message.role, utf8Bytes: Buffer.byteLength(message.content, 'utf8'), contentSha256: createHash('sha256').update(message.content, 'utf8').digest('hex') };
}
const ids = [work.user_message_id, work.reply_message_id];
const db = new DatabaseSync(path.join(run, 'data', 'central.sqlite'), { readOnly: true });
try {
    assert.equal(db.prepare('SELECT count(*) AS n FROM mobile_executions').get().n, 1);
    const rows = db.prepare('SELECT seq,msg_id,message_json FROM journal WHERE topic_id=? ORDER BY seq').all(ready.sharedTopicId);
    assert.equal(rows.length, (status.seedCount || 0) + 2);
    const added = rows.slice(-2);
    assert.deepEqual(added.map(row => row.msg_id), ids);
    assert.equal(added[0].seq, work.user_seq);
    const journal = added.map(row => messageHash(row.msg_id, JSON.parse(row.message_json)));
    const desktop = ids.map(id => messageHash(id, history.find(row => row.id === id)));
    assert.deepEqual(desktop, journal);
    assert.deepEqual(journal.map(row => row.role), ['user', 'assistant']);
    console.log(JSON.stringify({ sharedTopicId: ready.sharedTopicId, topicId, work, sequences: added.map(row => row.seq), journal, desktop }, null, 2));
} finally {
    db.close();
}

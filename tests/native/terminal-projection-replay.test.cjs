'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SharedSessionClient } = require('../../apps/desktop/modules/services/nativeSync/sharedSessionClient');

function fixture({ verifyError } = {}) {
    const mapping = { sharedId: 'topic', local: { itemId: 'agent', topicId: 'topic' } };
    const accepted = { id: 'work', requestId: 'request', userMessageId: 'user', state: 'review_required', userSeq: 7, replySeq: null };
    const record = {
        sharedId: mapping.sharedId, serverSession: true, serverProjectionPending: false,
        phase: accepted.state, accepted, body: { requestId: 'request' },
    };
    const operations = [];
    const runtime = {
        execution: {
            state: { requests: { request: record } },
            sessionStore: { async save(entry) { operations.push(['pending', entry.serverProjectionPending]); } },
            async consumeInputs(ids) { operations.push(['consume', ids]); },
        },
        async syncExecutionTopic(topic, { minSeq }) {
            operations.push(['verify', topic.sharedId, minSeq]);
            if (verifyError) throw verifyError;
        },
    };
    return { client: new SharedSessionClient(runtime), mapping, record, accepted, operations };
}

test('replayed terminal snapshot verifies History at the original watermark without rewriting pending', async () => {
    const { client, record, mapping, accepted, operations } = fixture();
    await client.project(record, mapping, { minSeq: 7, request: accepted, settledReplay: true });
    assert.equal(record.serverProjectionPending, false);
    assert.deepEqual(operations, [['verify', 'topic', 7], ['consume', ['request']]]);
});

test('a different terminal watermark still uses the durable projection path', async () => {
    const { client, record, mapping, accepted, operations } = fixture();
    await client.project(record, mapping, { minSeq: 8, request: { ...accepted, userSeq: 8 }, settledReplay: true });
    assert.deepEqual(operations, [
        ['verify', 'topic', 8], ['pending', true], ['consume', ['request']], ['pending', false],
    ]);
});

test('failed History verification records recovery for the original terminal Work', async () => {
    const verifyError = new Error('History unavailable');
    const { client, record, mapping, accepted, operations } = fixture({ verifyError });
    await assert.rejects(client.project(record, mapping, { minSeq: 7, request: accepted, settledReplay: true }), verifyError);
    assert.deepEqual(operations, [['verify', 'topic', 7], ['pending', true]]);
    assert.equal(record.serverProjectionPending, true);
    assert.equal(record.accepted.id, 'work');
    assert.equal(record.phase, 'review_required');
    assert.ok(client.activeRecords.has(record));
});

'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { messageHash, messageKey, wireTopic } = require('../../apps/desktop/modules/services/nativeSync/protocol');
const sharedGroup = require('../../apps/desktop/modules/services/nativeSync/sharedGroup');
const { capability, executeAction, observe } = require('../../apps/desktop/modules/services/nativeSync/sharedGroupHandoff');

test('group continuation with lost ACK can be retried with the same receipt, but an already-dispatched member cannot run again', async () => {
    const descriptor = { itemType: 'group', itemId: 'groupB', topicId: 'topicB' };
    const mapping = { local: descriptor, sharedId: 'sharedTopic', shared: { itemType: 'group', itemId: 'sharedGroup', topicId: 'sharedTopic' } };
    const user = { id: 'original-input', role: 'user', content: 'Original text' };
    const first = { id: 'reply_group_work_0', role: 'assistant', agentId: 'memberA', content: 'First result', timestamp: 2 };
    const work = {
        id: 'work', requestId: user.id, sharedId: mapping.sharedId, state: 'dispatched', userSeq: 1, configHash: 'frozen',
        turn: { controlMode: capability, plan: ['memberA', 'memberB'], userMessageId: user.id },
        groupHandoff: { state: 'awaiting_continue', executor: 'desktop:deviceB', executorVersion: 1, nextOrdinal: 1, firstReplySeq: 2 },
        nativeRequests: [{ id: 'group_work_0', ordinal: 0, state: 'model_terminal' }],
    };
    const receipts = [];
    const config = { hash: 'frozen', owner: { kind: 'group', config: {} }, rules: [] };
    const ack = { seq: 2, hash: messageHash(first), deleted: false };
    let launches = 0;
    function openDesktop() {
        const runtime = {
            ready: true, connection: { deviceId: 'deviceB', sharedSpaceId: 'space' }, capabilities: { features: [capability] },
            assertSharedAccess() {}, executionMapping: async () => mapping, isLocalVisible: () => true,
            nativeObject: () => ({}), localFor: id => ({ localId: id }),
            adapter: { canonical: row => row, state: { acked: { [messageKey({ ...wireTopic(mapping.shared), msgId: first.id })]: ack } } },
            matching: { assert() {} }, state: { objects: { sharedTopic: { parentId: 'sharedGroup' } } },
            syncExecutionTopic: async (_mapping, { minSeq }) => assert.equal(minSeq, 2),
            replica: { queue: { read: async () => [user, first] } },
            async send(path, request) {
                if (path.includes('/group-continue')) {
                    receipts.push(request.body);
                    work.groupHandoff.state = 'continuing';
                    if (receipts.length === 1) throw Object.assign(Error('lost ACK'), { code: 'NETWORK_UNAVAILABLE' });
                }
                if (path.includes('/request-config')) return { config };
                return { request: structuredClone(work) };
            },
        };
        return {
            runtime, liveGroups: new Set(), state: { requests: {} }, save: async () => {},
            run: async (_key, action) => action(), mapping: () => mapping,
            groupResult: (record, frozen, original, history) => ({ record, frozen, original, history, config: {}, members: [], userMessage: original }),
        };
    }
    const payload = { descriptor, action: 'continue', workId: work.id, expectedExecutor: 'desktop:deviceB', expectedExecutorVersion: 1 };
    const invoke = async (prepared, ordinal) => {
        launches++;
        assert.equal(ordinal, 1);
        assert.equal(prepared.record.accepted.id, work.id);
        assert.deepEqual(prepared.history, [user, first]);
        work.nativeRequests.push({ id: 'group_work_1', ordinal: 1, state: 'dispatched' });
    };
    await assert.rejects(executeAction(openDesktop(), payload, invoke), { code: 'NETWORK_UNAVAILABLE' });
    assert.equal(launches, 0);
    const reopened = openDesktop();
    assert.equal((await observe(reopened, mapping, { refresh: true, connection: 'online' })).canContinue, true);
    let reads = 0;
    reopened.runtime.replica.queue.read = async () => [user, ++reads === 1 ? first : { ...first, content: 'Stale local edit' }];
    const queue = { syncPolicy: { sharedExecution: reopened } };
    await assert.rejects(sharedGroup.action(queue, payload, () => {}, async () => null, async () => {
        await sharedGroup.history(descriptor.itemId, descriptor.topicId, []);
        assert.fail('a stale member reply reached the group runner');
    }), { code: 'SHARED_GROUP_HISTORY_NOT_CONFIRMED' });
    assert.equal(reads, 2);
    assert.equal(launches, 0);
    reopened.runtime.replica.queue.read = async () => [user, first];
    await executeAction(reopened, payload, invoke);
    assert.equal(launches, 1);
    assert.deepEqual(receipts[0], receipts[1]);
    const afterDispatch = openDesktop();
    const status = await observe(afterDispatch, mapping, { refresh: true, connection: 'online' });
    assert.equal(status.state, 'review_required');
    assert.equal(status.canContinue, false);
    await executeAction(afterDispatch, payload, invoke);
    assert.equal(launches, 1);
    const second = work.nativeRequests[1];
    second.state = 'unknown';
    second.memberId = 'memberB';
    work.state = work.groupHandoff.state = 'review_required';
    const review = await observe(afterDispatch, mapping, { refresh: true, connection: 'online' });
    assert.equal(review.state, 'review_required');
    assert.equal(review.unknownMember.ordinal, 1);

    work.state = work.groupHandoff.state = 'abandoned';
    const closed = await observe(afterDispatch, mapping, { refresh: true, connection: 'online' });
    assert.equal(closed.state, 'abandoned');
    assert.deepEqual(closed.unknownMember, review.unknownMember);
    assert.equal(closed.canContinue, false);
    assert.equal(closed.canHandoff, false);
    afterDispatch.runtime.send = async () => {
        afterDispatch.runtime.backgroundDenied = true;
        return { request: work };
    };
    assert.equal(await observe(afterDispatch, mapping, { refresh: true, connection: 'online' }), null);
});

test('explicit abandonment binds an adopted group request to its Work, topic and current executor', async () => {
    const { SharedExecution } = require('../../apps/desktop/modules/services/nativeSync/sharedExecution');
    const descriptor = { itemType: 'group', itemId: 'groupB', topicId: 'topicB' };
    const workId = 'work';
    const requestId = 'origin-input';
    const record = {
        adoptGroupWork: true, descriptor, sharedId: 'topic', phase: 'accepted',
        body: { requestId, controlMode: capability },
        accepted: { id: workId, requestId, sharedId: 'topic', state: 'review_required', groupHandoff: { executor: 'desktop:deviceB' } },
    };
    const writes = [];
    const desktop = {
        state: { requests: { ['group-handoff:' + workId]: record } },
        runtime: { connection: { sharedSpaceId: 'space', deviceId: 'deviceB' }, async send(path, options) {
            writes.push({ path, body: options.body });
            record.accepted.state = 'abandoned';
            return { request: record.accepted };
        } },
        mapping: scope => ({ sharedId: scope.topicId === descriptor.topicId ? 'topic' : 'other-topic' }),
        run: (_key, action) => action(), freshAdmissions: new Set(), save: async () => {},
        refresh: async () => record.accepted,
    };
    const abandon = changes => SharedExecution.prototype.abandon.call(desktop, {
        descriptor, workId, requestId, confirmed: true, ...changes,
    });
    await assert.rejects(abandon({ confirmed: false }), { code: 'SHARED_REVIEW_CONFIRMATION_REQUIRED' });
    await assert.rejects(abandon({ workId: 'another-work' }), { code: 'SHARED_REQUEST_NOT_FOUND' });
    await assert.rejects(abandon({ requestId: 'another-input' }), { code: 'SHARED_REQUEST_NOT_FOUND' });
    await assert.rejects(abandon({ descriptor: { ...descriptor, topicId: 'other' } }), { code: 'SHARED_REQUEST_NOT_FOUND' });
    record.accepted.groupHandoff.executor = 'desktop:another-device';
    await assert.rejects(abandon({}), { code: 'SHARED_REQUEST_OWNER_REQUIRED' });
    assert.equal(writes.length, 0);
    assert.equal(record.accepted.state, 'review_required');
    record.accepted.groupHandoff.executor = 'desktop:deviceB';
    assert.deepEqual(await abandon({}), { success: true });
    assert.equal(writes[0].body.admissionId, workId);
    assert.equal(record.phase, 'abandoned');
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const path = require('node:path');
const { fixture } = require('./f06-host-fixture.cjs');
const { openAdmission, creation, creationContext, reply, replyContext } = require('./topic-sponsor-restart-worker.cjs');

const scope = topicId => ({ itemId: 'agent_a', itemType: 'agent', topicId });
const deleted = /HISTORY_TOPIC_DELETED|HISTORY_DELETION_FENCED|未找到话题|目标话题不存在/;
const child = (f, phase) => promisify(execFile)(process.execPath, [
    require.resolve('./topic-sponsor-restart-worker.cjs'), f.root, phase,
], { timeout: 10000, env: { PATH: process.env.PATH }, cwd: f.root });
async function cold(f, phase) {
    const { stdout } = await child(f, phase);
    return JSON.parse(stdout.split('\n').find(line => line.startsWith('SPONSOR_PROBE ')).slice('SPONSOR_PROBE '.length));
}
async function remove(f, id) {
    const result = await f.call('delete-topic', 'agent_a', id);
    assert.equal(result.success, true, JSON.stringify(result));
}
async function gone(f, id) {
    const current = await f.config();
    assert.ok(current._historyDeletedTopics.includes(id));
    assert.ok(current.topics.every(topic => topic.id !== id));
    await assert.rejects(fs.lstat(path.dirname(f.queue.getHistoryPath('agent_a', id))), { code: 'ENOENT' });
}

test('a late Flowlock creation ACK and replays in this host and a new process cannot publish the deleted topic', async t => {
    const f = await fixture(t);
    const initialized = Promise.withResolvers(), release = Promise.withResolvers();
    t.after(() => release.resolve());
    const initialize = f.queue.initializeIfMissing.bind(f.queue);
    f.queue.initializeIfMissing = async (target, rows) => {
        const result = await initialize(target, rows);
        initialized.resolve(target);
        await release.promise;
        return result;
    };
    const late = f.service.processTopicCommand(creation, creationContext);
    const target = await initialized.promise;
    assert.equal((await f.queue.read(target)).length, 1);
    await remove(f, target.topicId);
    release.resolve();
    await assert.rejects(late, deleted);
    await assert.rejects(f.service.processTopicCommand(creation, creationContext), deleted);
    const next = await cold(f, 'replay-creation');
    assert.match(next.rejected, deleted);
    await gone(f, target.topicId);
});

test('deletion while the accepted reply is committing its advance reservation denies the late ACK and prevents dispatch', async t => {
    const f = await fixture(t);
    await f.queue.initializeIfMissing(scope(reply.topic_id), []);
    let dispatches = 0;
    const host = await openAdmission(f, () => { dispatches++; });
    const resuming = Promise.withResolvers(), reserved = Promise.withResolvers();
    t.after(async () => { resuming.resolve(); await host.dispose(); });
    const save = host.service.store.save.bind(host.service.store);
    host.service.store.save = async (...args) => {
        await save(...args);
        if (args[0].some(entry => entry.state === 'advancing')) {
            reserved.resolve();
            await resuming.promise;
        }
    };
    const deliver = f.service.topicDelivery;
    f.service.topicDelivery = async (...args) => {
        const receipt = await deliver(...args);
        await resuming.promise;
        return receipt;
    };
    const late = f.service.processTopicCommand(reply, replyContext);
    await reserved.promise;
    assert.equal((await f.queue.read(scope(reply.topic_id))).length, 1);
    await remove(f, reply.topic_id);
    resuming.resolve();
    await assert.rejects(late, deleted);
    // Same in-memory receipt must not allow a deleted target to be accepted again.
    await assert.rejects(f.service.processTopicCommand(reply, replyContext), deleted);
    await host.service.tail;
    await new Promise(resolve => setImmediate(resolve));
    await host.service.tail;
    assert.equal(dispatches, 0);
    assert.match((await cold(f, 'replay-reply')).rejected, deleted);
    await gone(f, reply.topic_id);
});

test('process death after native handoff keeps the original admission identity and never blindly dispatches again', async t => {
    const f = await fixture(t);
    await f.queue.initializeIfMissing(scope(reply.topic_id), []);
    await assert.rejects(child(f, 'crash-after-dispatch'), { signal: 'SIGKILL' });
    const history = await f.queue.read(scope(reply.topic_id));
    assert.equal(history.length, 1);
    assert.equal((await cold(f, 'conflict-reply')).rejected, 'TOPIC_REPLY_REQUEST_CONFLICT');
    const first = await cold(f, 'replay-reply');
    assert.equal(first.entries.length, 1);
    assert.equal(first.entries[0].state, 'uncertain');
    assert.equal(first.receipt.entryId, first.entries[0].entryId);
    assert.equal(first.receipt.message_id, history[0].id);
    assert.deepEqual(await f.queue.read(scope(reply.topic_id)), history);
    await remove(f, reply.topic_id);
    assert.match((await cold(f, 'replay-reply')).rejected, deleted);
    await gone(f, reply.topic_id);
    const late = await cold(f, 'late-terminal');
    assert.equal(late.result.success, false);
    assert.equal(late.entries[0].state, 'uncertain');
    await gone(f, reply.topic_id);
    const attempts = (await fs.readFile(path.join(f.root, 'sponsor-advance.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(attempts.map(record => record.messageId), [history[0].id]);
});


test('reusing a reply ID revalidates the live route, sender and request rather than adopting the cached owner', async t => {
    const f = await fixture(t);
    await f.queue.initializeIfMissing(scope(reply.topic_id), []);
    const host = await openAdmission(f, () => assert.fail('silent delivery cannot dispatch'));
    t.after(() => host.dispose());
    const context = { ...replyContext, topicSponsorReplyPolicy: { enabled: false } };
    const accepted = await f.service.processTopicCommand(reply, context);
    const duplicate = await f.service.processTopicCommand(reply, context);
    assert.equal(duplicate.entryId, accepted.entryId);
    assert.equal(duplicate.message_id, accepted.message_id);
    assert.equal(duplicate.replayed, true);
    await assert.rejects(f.service.processTopicCommand({ ...reply, message: 'changed' }, context), /TOPIC_REPLY_REQUEST_CONFLICT/);
    const other = await f.call('create-agent', 'Alternative Speaker');
    assert.ok(other.success);
    await assert.rejects(f.service.processTopicCommand({ ...reply, sender_id: other.agentId }, context), /TOPIC_REPLY_REQUEST_CONFLICT/);

    const second = { ...scope(reply.topic_id), itemId: other.agentId };
    await f.manager.updateAgentConfig(other.agentId, config => ({
        ...config, topics: [...config.topics, { id: reply.topic_id, name: 'Different target' }],
    }));
    await f.queue.initializeIfMissing(second, []);
    await assert.rejects(f.service.processTopicCommand(reply, context), /归属不唯一/);
    await remove(f, reply.topic_id);
    await assert.rejects(f.service.processTopicCommand(reply, context), /TOPIC_REPLY_REQUEST_CONFLICT/);
    assert.deepEqual(await f.queue.read(second), []);
    await gone(f, reply.topic_id);
});


test('replaying a settled keyed reply in a new process returns its original receipt without a second History append', async t => {
    const f = await fixture(t);
    await f.queue.initializeIfMissing(scope(reply.topic_id), []);
    const first = await cold(f, 'silent-reply');
    assert.equal(first.receipt.queued, true);
    assert.deepEqual(first.entries, []);
    const file = f.queue.getHistoryPath('agent_a', reply.topic_id);
    const before = await fs.readFile(file, 'utf8');
    const next = await cold(f, 'silent-reply');
    assert.equal(next.receipt.queued, false);
    assert.equal(next.receipt.replayed, true);
    assert.equal(next.receipt.entryId, first.receipt.entryId);
    assert.equal(next.receipt.message_id, first.receipt.message_id);
    assert.deepEqual(next.entries, []);
    assert.equal(await fs.readFile(file, 'utf8'), before);
    assert.equal(JSON.parse(before).length, 1);
    // A later user edit/deletion of the accepted message cannot erase the admission proof.
    await f.queue.mutate(scope(reply.topic_id), history => history.map(row => ({ ...row, content: 'edited fixture' })));
    const edited = await cold(f, 'silent-reply');
    assert.equal(edited.receipt.entryId, first.receipt.entryId);
    assert.deepEqual((await f.queue.read(scope(reply.topic_id))).map(row => row.content), ['edited fixture']);
    await f.queue.mutate(scope(reply.topic_id), () => []);
    const erased = await cold(f, 'silent-reply');
    assert.equal(erased.receipt.entryId, first.receipt.entryId);
    assert.equal(erased.receipt.message_id, first.receipt.message_id);
    assert.deepEqual(await f.queue.read(scope(reply.topic_id)), []);
    await assert.rejects(fs.stat(path.join(f.root, 'sponsor-advance.jsonl')), { code: 'ENOENT' });
});


test('v2 pending recovery adopts original IDs; unrelated native v3 receipts survive journal updates', async t => {
    const f = await fixture(t);
    const target = scope(reply.topic_id);
    await f.queue.initializeIfMissing(target, []);
    const journal = path.join(f.root, 'TopicMessageQueue', 'pending.json');
    await fs.mkdir(path.dirname(journal), { recursive: true });
    const legacy = {
        entryId: 'legacy-entry', requestId: replyContext.requestId, scope: target,
        state: 'advancing', committed: true, leaseToken: 'legacy-attempt',
        triggerPolicy: 'reply', message: { id: 'legacy-message', role: 'assistant', agentId: 'agent_a',
            name: 'Synthetic Agent', content: '[Synthetic Agent的发言]:\nOne admitted reply', _metadata: { isPluginReply: true } },
    };
    await fs.writeFile(journal, JSON.stringify({ version: 2, standaloneLeases: [], entries: [legacy] }));
    const adopted = await cold(f, 'replay-reply');
    assert.equal(adopted.receipt.entryId, legacy.entryId);
    assert.equal(adopted.receipt.message_id, legacy.message.id);
    assert.equal(adopted.entries[0].state, 'uncertain');
    const upgraded = JSON.parse(await fs.readFile(journal));
    assert.equal(upgraded.version, 3);
    assert.equal(upgraded.dispatchReceipts.length, 1);
    const oldReceipt = { key: 'a'.repeat(64), fingerprint: 'b'.repeat(64), scope: target,
        messageId: 'historical-dispatch', entryId: 'historical-entry', retainedExtension: { revision: 1 } };
    upgraded.dispatchReceipts.unshift(oldReceipt);
    // Recovery has to republish the standalone lease diagnostics.
    upgraded.standaloneLeases.push({ scope: target, token: 'unrelated-interrupted-lease' });
    await fs.writeFile(journal, JSON.stringify(upgraded));
    const again = await cold(f, 'replay-reply');
    assert.equal(again.receipt.entryId, legacy.entryId);
    assert.equal(again.receipt.state, 'uncertain');
    const final = JSON.parse(await fs.readFile(journal));
    assert.deepEqual(final.dispatchReceipts, upgraded.dispatchReceipts);
    assert.deepEqual(final.standaloneLeases, []);
    assert.deepEqual(await f.queue.read(target), []);
    await assert.rejects(fs.stat(path.join(f.root, 'sponsor-advance.jsonl')), { code: 'ENOENT' });
});

test('guarded TopicSponsor rejection keeps the existing config bytes and other native histories writable', async t => {
    const f = await fixture(t);
    const { HistoryAuthority } = require('../modules/services/historyAuthority');
    await fs.mkdir(path.join(f.root, 'AgentGroups'), { recursive: true });
    const sibling = scope(reply.topic_id);
    await f.queue.initializeIfMissing(sibling, []);
    const authority = new HistoryAuthority({ queue: f.queue, noChildConfirmed: true,
        deriveProtection: async () => ({ protectAll: false }) });
    try {
        await authority.refresh();
        const accepted = await f.service.processTopicCommand(creation, creationContext);
        await remove(f, accepted.topic_id);
        const primary = path.join(f.agentDir, 'agent_a', 'config.json');
        const bytes = await fs.readFile(primary), ino = (await fs.stat(primary)).ino;
        await assert.rejects(f.service.processTopicCommand(creation, creationContext), deleted);
        assert.equal((await fs.stat(primary)).ino, ino);
        assert.deepEqual(await fs.readFile(primary), bytes);
        await f.queue.mutate(sibling, () => [{ id: 'retained-sibling', role: 'user', content: 'still writable' }]);
        assert.equal((await f.queue.read(sibling))[0].id, 'retained-sibling');
    } finally {
        await f.queue.dispose();
        authority.releaseAfterQueueDispose();
    }
});

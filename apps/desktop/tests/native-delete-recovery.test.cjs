'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { fixture, openFixture } = require('./f06-host-fixture.cjs');

const agentId = 'agent_a';
const old = { itemId: agentId, itemType: 'agent', topicId: 'old_topic' };
const kept = { ...old, topicId: 'sibling' };
const retainedMessage = { id: 'keep-without-overwrite', role: 'user', content: 'synthetic retained History' };

function processFor(t, root, stage, scope = old) {
    const child = fork(path.join(__dirname, 'native-delete-recovery-worker.cjs'), [root, stage, scope.itemType, scope.itemId, scope.topicId], {
        cwd: root, env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, LANG: 'C.UTF-8' },
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    const exit = once(child, 'exit');
    t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await exit;
    });
    const first = Promise.race([
        once(child, 'message').then(([message]) => message),
        exit.then(status => { throw Error('Worker exited before its IPC checkpoint: ' + status); }),
    ]);
    return { child, exit, first };
}

async function coldDelete(t, root, scope = old) {
    const { first, exit } = processFor(t, root, 'resume', scope);
    const { result, error } = await first;
    assert.ifError(error);
    assert.deepEqual(await exit, [0, null]);
    assert.equal(result.success, true, JSON.stringify(result));
    return result;
}

for (const stage of ['marker-published', 'config-committed', 'partial-directory', 'clean-before-reply']) {
    test('native topic deletion resumes after SIGKILL at ' + stage, { timeout: 30000 }, async t => {
        const lastTopic = stage === 'marker-published';
        const topics = lastTopic ? [{ id: old.topicId }] : [{ id: old.topicId }, { id: kept.topicId }];
        const f = await fixture(t, { topics });
        await f.queue.write(old, [{ id: 'remove-me' }]);
        if (!lastTopic) await f.queue.write(kept, [retainedMessage]);
        const configBefore = await f.config();
        const deletedDir = path.dirname(f.queue.getHistoryPath(agentId, old.topicId));
        const fileCount = 2048;
        if (stage === 'partial-directory') {
            for (let offset = 0; offset < fileCount; offset += 64) {
                await Promise.all(Array.from({length: 64}, (_, i) => fs.writeFile(path.join(deletedDir, 'asset-' + (offset + i)), 'x')));
            }
        }
        const victim = processFor(t, f.root, stage);
        assert.deepEqual(await victim.first, { checkpoint: stage });
        if (stage === 'partial-directory') {
            // Observe real recursive filesystem removal from a separate process.
            victim.child.send('remove');
            const deadline = Date.now() + 8000;
            while ((await fs.readdir(deletedDir)).length === fileCount + 1) {
                assert.ok(Date.now() < deadline, 'directory cleanup did not start');
                await delay(1);
            }
        }
        victim.child.kill('SIGKILL');
        assert.deepEqual(await victim.exit, [null, 'SIGKILL']);

        const primary = await f.config();
        assert.deepEqual(primary._historyDeletedTopics, [old.topicId]);
        assert.ok(!primary.topics.some(topic => topic.id === old.topicId));
        if (stage === 'partial-directory') {
            const remaining = await fs.readdir(deletedDir);
            assert.ok(remaining.length > 0 && remaining.length < fileCount + 1, 'expected partially removed physical directory');
            t.diagnostic('SIGKILL left ' + remaining.length + ' of ' + (fileCount + 1) + ' files');
        } else if (stage === 'clean-before-reply') {
            await assert.rejects(fs.stat(deletedDir), { code: 'ENOENT' });
        } else {
            assert.deepEqual(await f.queue.read(old), [{ id: 'remove-me' }]);
        }

        const restarted = openFixture(f.root);
        t.after(() => restarted.queue.dispose());
        await assert.rejects(restarted.queue.write(old, [{ id: 'late' }]), { code: 'HISTORY_TOPIC_DELETED' });
        const live = { ...old, topicId: primary.topics[0].id };
        const lock = path.join(f.agentDir, agentId, 'config.json.lock');
        if (lastTopic) {
            // This lock can survive a process exit after rename. Recovery needs no lock theft.
            assert.ok((await fs.stat(lock)).isFile());
            await restarted.queue.write(live, [retainedMessage]);
        }
        const first = await coldDelete(t, f.root);
        const replay = await coldDelete(t, f.root);
        assert.deepEqual(replay, first);
        assert.deepEqual((await f.config()).topics, primary.topics);
        assert.deepEqual(await restarted.queue.read(live), [retainedMessage]);
        await assert.rejects(fs.stat(deletedDir), { code: 'ENOENT' });
        await assert.rejects(restarted.queue.initializeIfMissing(old), { code: 'HISTORY_TOPIC_DELETED' });
        if (lastTopic) {
            assert.ok((await fs.stat(lock)).isFile());
        } else {
            await assert.rejects(restarted.manager.writeAgentConfig(agentId, configBefore), /HISTORY_TOPIC_DELETED/);
        }
        assert.deepEqual((await f.config())._historyDeletedTopics, [old.topicId]);
    });
}


test('group last-topic config commit recovers only the replacement History', async t => {
    const f = await fixture(t);
    const result = await f.group.createAgentGroup('Cold group deletion');
    const group = result.agentGroup;
    const scope = { itemId: group.id, itemType: 'group', topicId: group.topics[0].id };
    await f.queue.write(scope, [{ id: 'old-group-message' }]);
    const configPath = path.join(f.root, 'AgentGroups', group.id, 'config.json');
    const worker = processFor(t, f.root, 'marker-published', scope);
    assert.deepEqual(await worker.first, { checkpoint: 'marker-published' });
    worker.child.kill('SIGKILL');
    assert.deepEqual(await worker.exit, [null, 'SIGKILL']);
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
    const [replacement] = config.topics;
    assert.ok(config._historyDeletedTopics.includes(scope.topicId));
    assert.equal(replacement._historyReplacementFor, scope.topicId);
    const file = f.queue.getHistoryPath(scope.itemId, replacement.id);
    await assert.rejects(fs.stat(file), { code: 'ENOENT' });
    const reopen = openFixture(f.root);
    t.after(() => reopen.queue.dispose());
    // A registered topic without a physical History is valid. Retrying a
    // different topic deletion must not initialize it as a side effect.
    await reopen.group.mutateGroupConfig(group.id, current => ({
        ...current, topics: [...current.topics, { id: 'other-new', name: 'Unrelated' }]
    }));
    const first = await coldDelete(t, f.root, scope);
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), []);
    await reopen.queue.write({ ...scope, topicId: replacement.id }, [retainedMessage]);
    assert.deepEqual(await coldDelete(t, f.root, scope), first);
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), [retainedMessage]);
    await assert.rejects(fs.stat(reopen.queue.getHistoryPath(scope.itemId, 'other-new')), { code: 'ENOENT' });
    await assert.rejects(fs.stat(path.dirname(reopen.queue.getHistoryPath(scope.itemId, scope.topicId))), { code: 'ENOENT' });
    await assert.rejects(reopen.queue.write(scope, [{ id: 'late-group' }]), /HISTORY_TOPIC_DELETED/);
});

test('legacy topic backup is pruned under the config lock and rejects a foreign link', async t => {
    const extra = { ...old, topicId: 'second' };
    const topics = [old, extra, kept].map(({ topicId }) => ({ id: topicId }));
    const f = await fixture(t, { topics });
    const backup = path.join(f.agentDir, agentId, 'config.topic.backup.json');
    const external = path.join(f.root, 'foreign-backup.json');
    await fs.writeFile(external, JSON.stringify({ topics }));
    await fs.link(external, backup);
    await f.queue.write(old, [{ id: 'preserved-on-refusal' }]);
    const rejected = await f.call('delete-topic', agentId, old.topicId);
    assert.equal(rejected.code, 'UNSAFE_HISTORY_FILE');
    assert.deepEqual((await f.config()).topics, topics);
    assert.deepEqual(await f.queue.read(old), [{ id: 'preserved-on-refusal' }]);
    await fs.unlink(backup);
    await fs.writeFile(backup, JSON.stringify({ topics, unrelated: 'retained' }));
    const removed = await Promise.all([old, extra].map(scope => f.call('delete-topic', agentId, scope.topicId)));
    for (const answer of removed) assert.equal(answer.success, true, JSON.stringify(answer));
    assert.deepEqual(JSON.parse(await fs.readFile(backup, 'utf8')), { topics: [{ id: kept.topicId }], unrelated: 'retained' });
    assert.deepEqual(JSON.parse(await fs.readFile(external, 'utf8')), { topics });
});

test('a moved UserData ancestor is rechecked after config commit before physical cleanup', async t => {
    const f = await fixture(t, { topics: [{id: old.topicId}, {id: kept.topicId}] });
    const topics = path.join(f.userDataDir, agentId, 'topics');
    const isolated = path.join(f.root, 'foreign-topics');
    const foreignFile = path.join(isolated, old.topicId, 'must-survive.txt');
    await fs.mkdir(path.dirname(foreignFile), {recursive:true});
    await fs.writeFile(foreignFile, 'another directory');
    await f.queue.write(old, [{id:'local'}]);
    const save = f.manager.updateAgentConfig.bind(f.manager);
    f.manager.updateAgentConfig = async (...args) => {
        const result = await save(...args);
        await fs.rename(topics, topics+'-original');
        await fs.symlink(isolated, topics, process.platform === 'win32' ? 'junction' : 'dir');
        return result;
    };
    const refusal = await f.call('delete-topic', agentId, old.topicId);
    assert.equal(refusal.code, 'UNSAFE_HISTORY_ANCESTOR');
    assert.equal(await fs.readFile(foreignFile, 'utf8'), 'another directory');
    assert.deepEqual((await f.config())._historyDeletedTopics, [old.topicId]);
    await fs.unlink(topics);
    await fs.rename(topics+'-original', topics);
    assert.equal((await coldDelete(t, f.root)).success, true);
    await assert.rejects(fs.stat(path.join(topics, old.topicId)), {code:'ENOENT'});
    assert.equal(await fs.readFile(foreignFile, 'utf8'), 'another directory');
});

test('a confirmed SideChat cleanup failure remains retryable after its parent has been removed', async t => {
    const f = await fixture(t, { topics: [{id: old.topicId}, {id: kept.topicId}] });
    await f.queue.write(old, [{id:'old'}]);
    const created = await f.call('side-chat:create-child', agentId);
    assert.equal(created.success, true, JSON.stringify(created));
    const bound = await f.call('side-chat:save-metadata', {
        parent: {itemId:agentId, topicId:old.topicId}, child: {itemId:agentId, topicId:created.topicId}
    });
    assert.equal(bound.success, true, JSON.stringify(bound));
    const childDir = path.dirname(f.queue.getHistoryPath(agentId, created.topicId));
    const blockedPath = path.join(childDir, 'history.json');
    const promises = require('fs-extra').promises;
    const remove = promises.rm;
    promises.rm = async (file, options) => {
        if (file === blockedPath) throw Object.assign(new Error('fixture cleanup failure'), {code:'EACCES'});
        return remove(file, options);
    };
    try {
        const failure = await f.call('delete-topic', agentId, old.topicId);
        assert.equal(failure.code, 'EACCES', JSON.stringify(failure));
        assert.equal((await fs.stat(blockedPath)).isFile(), true);
    } finally { promises.rm = remove; }
    await assert.rejects(fs.stat(path.dirname(f.queue.getHistoryPath(agentId, old.topicId))), {code:'ENOENT'});
    assert.equal((await coldDelete(t, f.root)).success, true);
    await assert.rejects(fs.stat(childDir), {code:'ENOENT'});
});

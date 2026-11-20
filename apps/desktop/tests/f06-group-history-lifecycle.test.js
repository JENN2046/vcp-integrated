'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { HistoryMutationQueue } = require('../modules/services/historyMutationQueue');

async function fixture(t, withQueue = true) {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'f06-group-'));
    t.after(() => fsp.rm(root, { recursive: true, force: true }));
    const filename = path.resolve(__dirname, '../Groupmodules/groupchat.js');
    const localRequire = createRequire(filename), module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        module, exports: module.exports, console: { log() {}, error() {}, warn() {} },
        Date: class extends Date { static now() { return 123456789; } },
        require: name => {
            if (name === 'electron') return { ipcMain: {} };
            if (['../modules/modelTrajectory', '../modules/contextSanitizer', '../modules/fileManager', '../modules/ipc/canvasHandlers', '../modules/ipc/tavernHandlers', '../modules/tavernRulesEngine', './topicTitleManager', './jevGroupSessionOrchestrator'].includes(name)) return {};
            return localRequire(name);
        },
    }, { filename });
    const api = module.exports;
    const userDataDir = path.join(root, 'UserData');
    api.initializePaths({ APP_DATA_ROOT_IN_PROJECT: root, USER_DATA_DIR: userDataDir, AGENT_DIR: path.join(root, 'Agents') });
    const queue = new HistoryMutationQueue({ userDataDir });
    if (withQueue) api.initializeRuntimeServices({ historyMutationQueue: queue });
    t.after(() => queue.dispose());
    return { root, userDataDir, api, queue };
}

test('group owner and topic identity remains unique in the same millisecond; concurrent creates preserve all topics', async t => {
    const f = await fixture(t);
    const owners = await Promise.all(Array.from({ length: 8 }, () => f.api.createAgentGroup('same-name')));
    assert(owners.every(result => result.success));
    assert.equal(new Set(owners.map(result => result.agentGroup.id)).size, 8);
    const groupId = owners[0].agentGroup.id;
    const created = await Promise.all(Array.from({ length: 24 }, () => f.api.createNewTopicForGroup(groupId, 'parallel')));
    assert(created.every(result => result.success), JSON.stringify(created.filter(result => !result.success)));
    assert.equal(new Set(created.map(result => result.topicId)).size, 24);
    assert.equal((await f.api.getAgentGroupConfig(groupId)).topics.length, 25);
});

test('group initialization and concurrent appends retain accepted messages', async t => {
    const f = await fixture(t), owner = await f.api.createAgentGroup('append');
    const groupId = owner.agentGroup.id, topicId = owner.agentGroup.topics[0].id;
    const descriptor = { itemId: groupId, itemType: 'group', topicId };
    await Promise.all(Array.from({ length: 20 }, (_, i) => Promise.all([
        f.api.appendGroupHistoryMessage(groupId, topicId, { id: `m${i}` }),
        f.queue.initializeIfMissing(descriptor, []),
    ])));
    assert.equal((await f.api.getGroupChatHistory(groupId, topicId)).length, 20);
});

test('group deletion fences queued writes, replacement uses a fresh identity, old settings saves cannot re-add the topic', async t => {
    const f = await fixture(t), owner = await f.api.createAgentGroup('delete');
    const groupId = owner.agentGroup.id, topicId = owner.agentGroup.topics[0].id;
    const staleConfig = await f.api.getAgentGroupConfig(groupId);
    let release, started;
    const ready = new Promise(resolve => { started = resolve; });
    const pause = new Promise(resolve => { release = resolve; });
    const blocker = f.queue.run({ itemId: groupId, itemType: 'group', topicId }, async () => { started(); await pause; });
    await ready;
    const late = f.api.appendGroupHistoryMessage(groupId, topicId, { id: 'late' });
    const rejected = assert.rejects(late, /FENCED|DELETED/);
    const deleted = f.api.deleteGroupTopic(groupId, topicId);
    release(); await blocker; await rejected;
    const result = await deleted;
    assert.equal(result.success, true, result.error);
    assert.notEqual(result.remainingTopics[0].id, topicId);
    assert.equal(fs.existsSync(f.queue.getHistoryPath(groupId, topicId)), false);
    await f.api.saveAgentGroupConfig(groupId, staleConfig);
    assert.equal((await f.api.getAgentGroupConfig(groupId)).topics.some(topic => topic.id === topicId), false);
    const restarted = new HistoryMutationQueue({ userDataDir: f.userDataDir });
    t.after(() => restarted.dispose());
    await assert.rejects(restarted.write({ itemId: groupId, itemType: 'group', topicId }, []), /DELETED/);
});

test('group deletion failure leaves a durable owner denial across restart', async t => {
    const f = await fixture(t), owner = await f.api.createAgentGroup('unknown');
    const groupId = owner.agentGroup.id, topicId = owner.agentGroup.topics[0].id;
    const fsExtra = require('fs-extra'), originalRemove = fsExtra.remove;
    fsExtra.remove = async target => {
        if (target === path.join(f.userDataDir, groupId)) throw new Error('injected remove failure');
        return originalRemove(target);
    };
    let result;
    try { result = await f.api.deleteAgentGroup(groupId); } finally { fsExtra.remove = originalRemove; }
    assert.equal(result.success, false);
    assert.equal(JSON.parse(await fsp.readFile(path.join(f.root, 'AgentGroups', groupId, 'config.json'), 'utf8'))._historyDeleting, true);
    assert.equal(await f.api.getAgentGroupConfig(groupId), null);
    const restarted = new HistoryMutationQueue({ userDataDir: f.userDataDir });
    t.after(() => restarted.dispose());
    await assert.rejects(restarted.initializeIfMissing({ itemId: groupId, itemType: 'group', topicId }, []), /UNVERIFIED/);
});

test('group writes fail closed without the injected queue', async t => {
    const f = await fixture(t, false);
    const result = await f.api.createAgentGroup('no-queue');
    assert.equal(result.success, false);
    await assert.rejects(f.api.appendGroupHistoryMessage('missing', 'missing', { id: 'x' }), /unavailable/);
    assert.equal(fs.existsSync(f.userDataDir), false);
});


test('group creation refuses malformed current lifecycle config without repairing it into authority', async t => {
    const f = await fixture(t), owner = await f.api.createAgentGroup('corrupt');
    const groupId = owner.agentGroup.id;
    const configPath = path.join(f.root, 'AgentGroups', groupId, 'config.json');
    const invalid = JSON.stringify({ id: groupId, topics: {} });
    await fsp.writeFile(configPath, invalid);
    const result = await f.api.createNewTopicForGroup(groupId, 'must-deny');
    assert.equal(result.success, false);
    assert.equal(await fsp.readFile(configPath, 'utf8'), invalid);
});


for (const ownerDeletion of [true, false]) {
    test(`group ${ownerDeletion ? 'owner' : 'topic'} deletion resumes from native tombstones after rm failure and restart`, async t => {
        const f = await fixture(t), owner = await f.api.createAgentGroup('resume');
        const groupId = owner.agentGroup.id, topicId = owner.agentGroup.topics[0].id;
        const historyPath = f.queue.getHistoryPath(groupId, topicId);
        await f.api.appendGroupHistoryMessage(groupId, topicId, { id: 'accepted-before-delete' });
        const bytes = await fsp.readFile(historyPath, 'utf8');
        const target = ownerDeletion ? path.join(f.userDataDir, groupId) : path.dirname(historyPath);
        const fsExtra = require('fs-extra'), originalRemove = fsExtra.remove;
        fsExtra.remove = async file => {
            if (file === target) throw new Error('injected physical removal failure');
            return originalRemove(file);
        };
        const remove = () => ownerDeletion ? f.api.deleteAgentGroup(groupId) : f.api.deleteGroupTopic(groupId, topicId);
        let failed;
        try { failed = await remove(); } finally { fsExtra.remove = originalRemove; }
        assert.equal(failed.success, false);
        assert.equal(await fsp.readFile(historyPath, 'utf8'), bytes);
        const restarted = new HistoryMutationQueue({ userDataDir: f.userDataDir });
        t.after(() => restarted.dispose());
        f.api.initializeRuntimeServices({ historyMutationQueue: restarted });
        await assert.rejects(restarted.write({ itemId: groupId, itemType: 'group', topicId }, []), /DELETED|UNVERIFIED/);
        const retried = await remove();
        assert.equal(retried.success, true, retried.error);
        assert.equal(fs.existsSync(historyPath), false);
        const current = JSON.parse(await fsp.readFile(path.join(f.root, 'AgentGroups', groupId, 'config.json'), 'utf8'));
        if (ownerDeletion) {
            assert.equal(current._historyDeleting, true);
            assert.equal(current.topics.length, 0);
        } else {
            assert(current._historyDeletedTopics.includes(topicId));
            assert.equal(current.topics.length, 1);
            assert.equal(fs.existsSync(restarted.getHistoryPath(groupId, current.topics[0].id)), true);
        }
    });
}


test('internal Group materialization publishes config only and rejects existing identities, aliases and tombstones', async t => {
    const f = await fixture(t);
    const groupId = 'mapped-owner-identity';
    const first = await f.api.initializeAgentGroupConfig(groupId, { name: 'Mapped', topics: [] });
    assert.equal(first.success, true, first.error);
    assert.equal(first.agentGroup.id, groupId);
    assert.equal(first.agentGroup.mode, 'sequential');
    assert.equal(fs.existsSync(path.join(f.userDataDir, groupId)), false);
    const configPath = path.join(f.root, 'AgentGroups', groupId, 'config.json');
    const bytes = await fsp.readFile(configPath, 'utf8');
    const repeated = await f.api.initializeAgentGroupConfig(groupId, { name: 'Must not replace' });
    assert.equal(repeated.success, false);
    assert.equal(await fsp.readFile(configPath, 'utf8'), bytes);
    const concurrent = await Promise.all(Array.from({ length: 8 }, () => f.api.initializeAgentGroupConfig('one-owner', { topics: [] })));
    assert.equal(concurrent.filter(result => result.success).length, 1);
    const alias = path.join(f.root, 'AgentGroups', 'alias-owner');
    await fsp.symlink(path.join(f.root, 'AgentGroups', groupId), alias);
    assert.equal((await f.api.initializeAgentGroupConfig('alias-owner', {})).success, false);
    assert.equal((await f.api.initializeAgentGroupConfig('../escape', {})).success, false);
    await fsp.mkdir(path.join(f.root, 'Agents', 'agent-owner'), { recursive: true });
    assert.equal((await f.api.initializeAgentGroupConfig('agent-owner', {})).success, false);
    const removed = await f.api.deleteAgentGroup(groupId);
    assert.equal(removed.success, true, removed.error);
    const tombstone = await fsp.readFile(configPath, 'utf8');
    assert.equal((await f.api.initializeAgentGroupConfig(groupId, { name: 'Must stay deleted' })).success, false);
    assert.equal(await fsp.readFile(configPath, 'utf8'), tombstone);
});


test('Group owner cleanup preserves config and owned/unknown lock/temp facts', async t => {
    const f = await fixture(t), created = await f.api.createAgentGroup('preserve-owner-facts');
    const groupId = created.agentGroup.id;
    const ownerDir = path.join(f.root, 'AgentGroups', groupId);
    const retained = ['config.json.lock', 'owned.lock', 'unknown.lock', 'pending.tmp', 'config.json.unknown.tmp'];
    for (const file of retained) await fsp.writeFile(path.join(ownerDir, file), `preserve:${file}`);
    const result = await f.api.deleteAgentGroup(groupId);
    assert.equal(result.success, true, result.error);
    assert.equal(JSON.parse(await fsp.readFile(path.join(ownerDir, 'config.json'), 'utf8'))._historyDeleting, true);
    for (const file of retained) assert.equal(await fsp.readFile(path.join(ownerDir, file), 'utf8'), `preserve:${file}`);
});

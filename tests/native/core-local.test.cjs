'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { BOX, CHAT, wait } = require('./fixtures/sharedSingleHarness.cjs');
const { host, localProvider } = require('./fixtures/coreSingleHarness.cjs');

test('ToolBox starts local Core without loading the sync runtime and a native topic sends and reopens', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'core-local-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const provider = await localProvider(t);
    const { chat } = host(provider);
    const express = require(BOX + '/node_modules/express');
    const { startCoreHost } = require(BOX + '/core/host');
    const token = 'isolated-core-key';
    const env = { VCP_CORE_DATA_DIR: path.join(root, 'data') };
    const app = express();
    app.use(express.json());
    let core = startCoreHost({ app, chat, env, listenHost: '127.0.0.1', serverKey: token });
    let srv = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
    t.after(async () => { srv.closeAllConnections(); await new Promise(resolve => srv.close(resolve)); await core.close(); });
    const url = 'http://127.0.0.1:' + srv.address().port;
    const forbidden = await fetch(url + '/api/core/personal/directory');
    assert.equal(forbidden.status, 403);

    const profile = path.join(root, 'profile');
    const agent = { name: 'Personal test', systemPrompt: 'An isolated test', model: 'fixture', topics: [{ id: 'Topic', name: 'Local topic' }] };
    const { HistoryMutationQueue } = require(CHAT + '/modules/services/historyMutationQueue');
    const queue = new HistoryMutationQueue({ userDataDir: path.join(profile, 'UserData') });
    await fs.mkdir(path.join(profile, 'Agents', 'Agent'), { recursive: true });
    await fs.writeFile(path.join(profile, 'Agents', 'Agent', 'config.json'), JSON.stringify({ id: 'Agent', ...agent }));
    const args = { queue, appDataRoot: profile, workspace: 'personal',
        readSettings: async () => ({ vcpServerUrl: url + '/v1/chat/completions', vcpApiKey: token }),
        readAgent: async () => agent, readGroup: async () => ({
            name: 'Personal group', mode: 'sequential', members: ['Agent'], topics: [{ id: 'GroupTopic', name: 'Group topic' }]
        }), readRules: async () => [], notify: () => {}, notifyExecutionStatus: () => {} };
    const { openLocalCore, mapTopic } = require(CHAT + '/modules/services/localCoreRuntime');
    const rt = await openLocalCore(args);
    const descriptor = { itemType: 'agent', itemId: 'Agent', topicId: 'Topic' };
    const empty = await rt.coreSingle.history(descriptor);
    assert.deepEqual(empty.history, []);
    const receipt = await rt.prepareSharedSend({ descriptor, message: { content: 'Local native input', role: 'user' } });
    const workId = receipt.serverSession.executionId;
    await wait(() => core.store.db.prepare('SELECT status FROM works WHERE id=?').get(workId)?.status === 'completed', 'local core work complete');
    await rt.close();
    const reopened = await openLocalCore(args);

    const saved = await reopened.coreSingle.history(descriptor);
    assert.deepEqual(saved.history.map(item => item.content), ['Local native input', 'core reply']);
    assert.equal(provider.calls.length, 1);
    const group = { itemType: 'group', itemId: 'Group', topicId: 'GroupTopic' };
    const groupReceipt = await reopened.prepareSharedSend({ descriptor: group, message: { content: 'Group input', role: 'user' } });
    const groupWork = groupReceipt.serverSession.executionId;
    await wait(() => core.store.db.prepare('SELECT status FROM works WHERE id=?').get(groupWork)?.status === 'completed', 'local group complete');
    const groupHistory = await reopened.coreSingle.history(group);
    assert.deepEqual(groupHistory.history.map(item => item.content), ['Group input','core reply']);
    assert.equal(groupHistory.history[1].agentId, 'Agent');
    assert.equal(provider.calls.length, 2);

    const side = { itemType: 'agent', itemId: 'Agent', topicId: 'sidechat_1_a' };
    const sideDir = path.dirname(queue.getHistoryPath(side.itemId, side.topicId));
    await fs.mkdir(sideDir, { recursive: true });
    await fs.writeFile(path.join(sideDir, 'sidechat-child.json'), JSON.stringify({ agentId: side.itemId, topicId: side.topicId, parentTopicId: 'Topic', schemaVersion: 1, ephemeral: true }));
    await queue.initializeIfMissing(side, []);
    await queue.mutate(side, () => [{ id: 'side-message', role: 'user', content: 'Local side discussion' }]);
    assert.equal((await queue.inspect(side)).history[0].content, 'Local side discussion');
    assert.equal(core.store.db.prepare('SELECT count(*) n FROM core_topics WHERE native_topic=?').get(side.topicId).n, 0);

    assert.equal((await queue.inspect(descriptor)).exists, false);
    assert.equal(core.store.db.prepare('SELECT count(*) n FROM core_topics WHERE id=?').get(mapTopic(descriptor).sharedId).n, 1);
    const actor = { ...core.local.actor };
    const memory = { key: mapTopic(descriptor).sharedId, workspace: 'personal', actor };
    const listed = await core.memoryTool(memory, 'TopicMemo', { maid: agent.name, command: 'ListTopics' });
    assert.match(listed, /Local topic/);
    const targetKey = require(BOX + '/core/localWorkspace').localTopicKey('agent', 'Agent', 'Disposable');
    await core.local.define(targetKey, { ownerType: 'agent', ownerId: 'Agent', topicId: 'Disposable',
        name: 'Deleted memo marker', config: { name: agent.name, model: 'fixture', systemPrompt: 'Disposable' } }, () => true);
    assert.match(await core.memoryTool(memory, 'TopicMemo', { maid: agent.name }), /Deleted memo marker/);
    core.local.remove('agent', 'Agent', targetKey, core.local.actor, 'delete_disposable', () => {});
    assert.doesNotMatch(await core.memoryTool(memory, 'TopicMemo', { maid: agent.name }), /Deleted memo marker/);
    await assert.rejects(core.memoryTool(memory, 'TopicMemo', {
        maid: agent.name, command: 'GetTopicContent', topicId: targetKey
    }), /未找到 ID/);

    const marker = path.join(profile, '.vcp-core', 'profile.json');
    const bound = JSON.parse(await fs.readFile(marker, 'utf8'));
    assert.equal(bound.storageId, core.store.storageId);
    await reopened.close();
    await new Promise(resolve => srv.close(resolve));
    await core.close();
    const offline = await openLocalCore(args);
    assert.equal((await offline.coreSingle.history(descriptor)).offline, true);
    await offline.close();
    const replacement = express();
    replacement.use(express.json());
    core = startCoreHost({ app: replacement, chat, env: { VCP_CORE_DATA_DIR: path.join(root, 'empty') },
        listenHost: '127.0.0.1', serverKey: token });
    srv = await new Promise(resolve => {
        const server = replacement.listen(Number(new URL(url).port), '127.0.0.1', () => resolve(server));
    });
    await assert.rejects(openLocalCore(args), { code: 'CORE_DATABASE_IDENTITY_MISMATCH' });
    assert.equal(core.store.db.prepare('SELECT count(*) n FROM core_topics').get().n, 0);
    assert.deepEqual(JSON.parse(await fs.readFile(marker, 'utf8')), bound);
    assert.ok(!Object.keys(require.cache).some(file => /NativeSync[\\/]native-sync\.js$/.test(file)));
});

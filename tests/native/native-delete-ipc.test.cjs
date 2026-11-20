'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');
const { fixture, CHAT } = require('./fixtures/sharedSingleHarness.cjs');
const loadGroup = require('./fixtures/nativeGroupModule.cjs');
const AgentConfigManager = require(CHAT + '/modules/utils/agentConfigManager');

const channels = [
    ['delete-agent', 'agentHandlers', 'agent', false],
    ['delete-agent-group', 'groupChatHandlers', 'group', false],
    ['delete-topic', 'chatHandlers', 'agent', true],
    ['delete-group-topic', 'groupChatHandlers', 'group', true],
];

const confirmation = ({ expectedVersion, expectedBinding, operationId }) => ({
    confirmed: true, mode: 'all', expectedVersion, expectedBinding, operationId,
});

async function registerHandler(desktop, moduleName, channel, overrides = {}) {
    const ipcPath = path.join(CHAT, 'modules/ipc', moduleName + '.js');
    const hostRequire = createRequire(ipcPath);
    const paths = {
        APP_DATA_ROOT_IN_PROJECT: desktop.data,
        AGENT_DIR: path.join(desktop.data, 'Agents'),
        USER_DATA_DIR: path.join(desktop.data, 'UserData'),
    };
    const group = loadGroup(CHAT);
    group.initializePaths(paths);
    if (overrides.createGroupTopic) group.createNewTopicForGroup = overrides.createGroupTopic;
    const handlers = new Map();
    const module = { exports: {} };
    new Function('require', 'module', '__filename', '__dirname', await fs.readFile(ipcPath, 'utf8'))(name => {
        if (name === 'electron') return { ipcMain: { handle: (name, handler) => handlers.set(name, handler) } };
        if (name === '../../Groupmodules/groupchat') return group;
        if (name === '../modelTrajectory') {
            return { clearTrajectoryOf: async () => {}, clearTrajectoriesOfOwner: async () => {} };
        }
        if (name === '../agentMood') return { getAgentMoodStore: () => null };
        if (name === '../services/portraitOptimizer') return { withPortraitLock: (_directory, run) => run() };
        if (name === './sideChatHandlers') return { removeSideChatChildrenOfParent: async () => {} };
        return hostRequire(name);
    }, module, ipcPath, path.dirname(ipcPath));
    const context = {
        ...paths,
        historyMutationQueue: desktop.queue,
        agentConfigManager: new AgentConfigManager(paths.AGENT_DIR),
    };
    if (process.env.NATIVESYNC_DELETE_BASELINE !== '1' && !overrides.omitDeletionProvider) {
        const { createOwnerDeletion } = hostRequire('../services/nativeSync/nativeOwnerDeletion');
        const { runtimeForRoot } = hostRequire('../services/nativeSync/sharedHost');
        context.beforeOwnerDelete = createOwnerDeletion({
            root: desktop.data,
            getRuntime: () => runtimeForRoot(desktop.data),
        });
    }
    if (moduleName === 'agentHandlers') module.exports.initialize(context);
    else module.exports.initialize({}, context);
    assert.equal(typeof handlers.get(channel), 'function');
    return handlers.get(channel);
}

async function harness(t, moduleName, channel, kind, isTopic, overrides) {
    const f = await fixture(t);
    t.after(() => fs.rm(f.root, { force: true, recursive: true }));
    let owner = f.owner;
    let topic = f.topic;
    if (kind === 'group') {
        owner = f.shared.create(f.actor('A'), {
            sharedSpaceId: 'sharedAB', opId: 'delete-test-group', kind, localId: 'delete-group',
            config: { name: 'Synthetic group', mode: 'invite_only', members: [f.owner.id] },
        }).object;
        topic = f.shared.create(f.actor('A'), {
            sharedSpaceId: 'sharedAB', opId: 'delete-test-topic', kind: 'topic', parentId: owner.id,
            localId: 'topic', localParent: 'delete-group', config: { name: 'Synthetic topic' },
        }).object;
    }
    const desktop = await f.desktop('A');
    const { runtime, queue } = desktop;
    const itemId = runtime.localFor(owner.id).localId;
    const topicId = runtime.localFor(topic.id).localId;
    const scope = { itemType: kind, itemId, ...(isTopic ? { topicId } : {}) };
    const args = isTopic ? [itemId, topicId] : [itemId];
    const id = isTopic ? topic.id : owner.id;
    const config = path.join(desktop.data, kind === 'agent' ? 'Agents' : 'AgentGroups', itemId, 'config.json');
    const history = queue.getHistoryPath(itemId, topicId);
    await fs.mkdir(path.dirname(history), { recursive: true });
    await fs.writeFile(history, "[]");
    const handler = await registerHandler(desktop, moduleName, channel, overrides);
    t.after(() => assert.equal(f.calls(), 0));
    return { f, desktop, runtime, scope, args, id, owner, topic, config, history, handler };
}

async function checkRefusal(t, scenario, h, invoke, expectedError) {
    const before = await Promise.all([fs.readFile(h.config), fs.readFile(h.history)]);
    const metrics = h.f.store.metrics();
    let nativeDeletes = 0;
    t.mock.method(h.desktop.queue, 'deleteHistory', async () => {
        nativeDeletes++;
        throw Object.assign(new Error('Unexpected permanent native delete'), { code: 'UNEXPECTED_NATIVE_DELETE' });
    });
    const outcome = await invoke().then(value => ({ value }), error => ({ rejected: error.code || error.message }));
    t.diagnostic(scenario + ' ' + JSON.stringify({ outcome, nativeDeletes }));
    assert.equal(nativeDeletes, 0);
    assert.equal(outcome.value?.success, false, JSON.stringify(outcome));
    if (expectedError) assert.equal(outcome.value.error, expectedError);
    else assert.equal(typeof outcome.value.error, 'string');
    assert.deepEqual(await Promise.all([fs.readFile(h.config), fs.readFile(h.history)]), before);
    assert.deepEqual(h.f.store.metrics(), metrics);
    assert.equal(h.f.shared.get(h.f.actor('A'), 'sharedAB', h.id).deleted, false);
}

for (const [channel, moduleName, kind, isTopic] of channels) {
    test(channel + ' refuses a shared preview after its binding disappears', async t => {
        const h = await harness(t, moduleName, channel, kind, isTopic);
        const options = confirmation(await h.runtime.nativeDeletionContext(h.scope));
        // Keep both native files on disk while removing the registry's in-memory binding.
        delete h.runtime.state.locals[h.owner.id];
        await checkRefusal(t, 'lost binding', h, () => h.handler({}, ...h.args, options), 'SHARED_NATIVE_BINDING_CHANGED');
    });

    test(channel + ' refuses an unclassified object in the joined directory', async t => {
        const h = await harness(t, moduleName, channel, kind, isTopic);
        delete h.runtime.state.locals[h.owner.id];
        await checkRefusal(t, 'missing ownership record', h, () => h.handler({}, ...h.args));
    });

    test(channel + ' refuses a shared preview after the binding changes', async t => {
        const h = await harness(t, moduleName, channel, kind, isTopic);
        const options = confirmation(await h.runtime.nativeDeletionContext(h.scope));
        const initial = h.runtime.binding.bind(h.runtime);
        t.mock.method(h.runtime, 'binding', () => ({ ...initial(), deviceId: 'different-device' }));
        await checkRefusal(t, 'changed binding', h, () => h.handler({}, ...h.args, options), 'SHARED_NATIVE_BINDING_CHANGED');
    });

    test(channel + ' refuses a shared preview after the feature runtime closes', async t => {
        const h = await harness(t, moduleName, channel, kind, isTopic);
        const options = confirmation(await h.runtime.nativeDeletionContext(h.scope));
        await h.runtime.close();
        await checkRefusal(t, 'feature unavailable', h, () => h.handler({}, ...h.args, options), 'SHARED_NATIVE_BINDING_CHANGED');
    });

    test(channel + ' reports ownership lookup errors through the IPC receipt', async t => {
        const h = await harness(t, moduleName, channel, kind, isTopic);
        t.mock.method(h.runtime, 'nativeObject', () => { throw Object.assign(new Error('Unavailable'), { code: 'EIO' }); });
        await checkRefusal(t, 'ownership unreadable', h, () => h.handler({}, ...h.args), 'EIO');
    });

    test(channel + ' refuses when a live shared removal throws', async t => {
        const h = await harness(t, moduleName, channel, kind, isTopic);
        const options = confirmation(await h.runtime.nativeDeletionContext(h.scope));
        const removal = t.mock.method(h.runtime, 'removeNativeObject', async () => {
            throw Object.assign(new Error('Shared deletion request failed'), { code: 'NETWORK_UNAVAILABLE' });
        });
        await checkRefusal(t, 'shared error', h, () => h.handler({}, ...h.args, options), 'NETWORK_UNAVAILABLE');
        assert.equal(removal.mock.callCount(), 1);
    });
}

for (const [channel, moduleName, kind, isTopic] of channels) {
    test(channel + ' refuses an unclassified object when the shared runtime is unavailable', async t => {
        const h = await harness(t, moduleName, channel, kind, isTopic);
        await h.runtime.close();
        await checkRefusal(t, 'no authority or confirmation', h, () => h.handler({}, ...h.args));
    });

    test(channel + ' refuses confirmation with the deletion provider absent', async t => {
        const h = await harness(t, moduleName, channel, kind, isTopic, { omitDeletionProvider: true });
        const { expectedBinding } = await h.runtime.nativeDeletionContext(h.scope);
        await h.runtime.close();
        await checkRefusal(t, 'provider absent with a partial confirmation', h,
            () => h.handler({}, ...h.args, { expectedBinding }), 'SHARED_NATIVE_BINDING_CHANGED');
    });

    test(channel + ' requires confirmation for a known shared object', async t => {
        const h = await harness(t, moduleName, channel, kind, isTopic);
        await checkRefusal(t, 'confirmation missing', h, () => h.handler({}, ...h.args), 'SHARED_DELETE_CONFIRMATION_REQUIRED');
    });

    test(channel + ' preserves native deletion for an ordinary object', async t => {
        const os = require('node:os');
        const { HistoryMutationQueue } = require(CHAT + '/modules/services/historyMutationQueue');
        const data = await fs.mkdtemp(path.join(os.tmpdir(), 'ns-native-delete-'));
        const queue = new HistoryMutationQueue({
            agentDir: path.join(data, 'Agents'), groupDir: path.join(data, 'AgentGroups'),
            userDataDir: path.join(data, 'UserData'),
        });
        t.after(async () => {
            await queue.dispose();
            await fs.rm(data, { force: true, recursive: true });
        });
        const id = 'local-owner';
        const topic = 'local-topic';
        const config = path.join(data, kind === 'agent' ? 'Agents' : 'AgentGroups', id, 'config.json');
        const history = queue.getHistoryPath(id, topic);
        await fs.mkdir(path.dirname(config), { recursive: true });
        await fs.writeFile(config, JSON.stringify({
            id, name: 'Local owner', mode: 'invite_only', members: [], topics: [{ id: topic, name: 'Local topic' }],
        }));
        await fs.mkdir(path.dirname(history), { recursive: true });
        await fs.writeFile(history, '[]');
        const handler = await registerHandler({ data, queue }, moduleName, channel);
        const receipt = await handler({}, ...(isTopic ? [id, topic] : [id]));
        assert.equal(receipt.success, true, JSON.stringify(receipt));
        await assert.rejects(fs.stat(history), { code: 'ENOENT' });
        const remaining = JSON.parse(await fs.readFile(config, 'utf8'));
        if (isTopic) {
            assert.equal(receipt.remainingTopics.length, 1);
            assert.notEqual(receipt.remainingTopics[0].id, topic);
            assert.deepEqual(remaining.topics.map(value => value.id), receipt.remainingTopics.map(value => value.id));
        } else {
            assert.equal(remaining._historyDeleting, true);
            assert.deepEqual(remaining.topics, []);
        }
    });

    if (isTopic) {
        test(channel + ' preserves the accepted removal when local topic refresh fails', async t => {
            const h = await harness(t, moduleName, channel, kind, isTopic);
            const options = confirmation(await h.runtime.nativeDeletionContext(h.scope));
            const remove = h.runtime.directoryState.remove.bind(h.runtime.directoryState);
            t.mock.method(h.runtime.directoryState, 'remove', async request => {
                const accepted = await remove(request);
                t.mock.method(h.runtime.host, 'readNativeOwner', async () => {
                    throw Object.assign(new Error('Topic refresh failed'), { code: 'EIO' });
                });
                return accepted;
            });
            const receipt = await h.handler({}, ...h.args, options);
            assert.equal(h.f.shared.get(h.f.actor('A'), 'sharedAB', h.topic.id).deleted, true);
            assert.equal(h.f.shared.get(h.f.actor('A'), 'sharedAB', h.owner.id).deleted, false);
            assert.equal(receipt.success, true, JSON.stringify(receipt));
            assert.equal(receipt.removed, 'all');
            assert.match(receipt.warning, /Topic refresh failed|EIO/);
        });

        test(channel + ' preserves the accepted removal when replacement fails', async t => {
            const h = await harness(t, moduleName, channel, kind, isTopic, {
                createGroupTopic: async () => { throw Object.assign(new Error('Replacement failed'), { code: 'EIO' }); },
            });
            const options = confirmation(await h.runtime.nativeDeletionContext(h.scope));
            if (kind === 'agent') {
                t.mock.method(h.runtime, 'assertNativeMutation', () => {
                    throw Object.assign(new Error('Replacement failed'), { code: 'EIO' });
                });
            }
            const receipt = await h.handler({}, ...h.args, options);
            assert.equal(h.f.shared.get(h.f.actor('A'), 'sharedAB', h.topic.id).deleted, true);
            assert.equal(h.f.shared.get(h.f.actor('A'), 'sharedAB', h.owner.id).deleted, false);
            assert.equal(receipt.success, true, JSON.stringify(receipt));
            assert.equal(receipt.removed, 'all');
            assert.deepEqual(receipt.remainingTopics, []);
            assert.match(receipt.warning, /Replacement failed|EIO/);

            const replay = await h.handler({}, ...h.args, options);
            assert.equal(replay.success, true, JSON.stringify(replay));
            assert.equal(replay.replayed, true);
            assert.equal(replay.removed, 'all');
        });
    }
}

function removePosts(service) {
    return service.control.trace.filter(({ method, route }) => method === 'POST' && route === '/api/v1/sync/shared/remove');
}

function removalReceiptCount({ f }, operationId) {
    return f.shared.db.prepare('SELECT count(*) AS total FROM shared_receipts WHERE principal=? AND op_id=?')
        .get(f.actor('A').principal, operationId).total;
}

async function persistedRemoval({ runtime, id }) {
    return JSON.parse(await fs.readFile(runtime.file, 'utf8')).localRemovals[id];
}

test('delete-agent rechecks the target binding after directory replica synchronization', async t => {
    const h = await harness(t, 'agentHandlers', 'delete-agent', 'agent', false);
    const options = confirmation(await h.runtime.nativeDeletionContext(h.scope));
    h.f.control.trace = [];
    const sync = h.runtime.replica.sync.bind(h.runtime.replica);
    const resync = t.mock.method(h.runtime.replica, 'sync', async (...args) => {
        const result = await sync(...args);
        h.runtime.state.locals[h.id].localId = 'synthetic-rebound-owner';
        return result;
    });

    const receipt = await h.handler({}, ...h.args, options);
    const durable = await persistedRemoval(h);
    t.diagnostic(JSON.stringify({ receipt, removePosts: removePosts(h.f).length, stage: durable?.stage }));
    assert.equal(resync.mock.callCount(), 1);
    assert.equal(removePosts(h.f).length, 0);
    assert.equal(removalReceiptCount(h, options.operationId), 0);
    assert.equal(durable, undefined);
    assert.equal(h.runtime.state.localRemovals[h.id], undefined);
    assert.deepEqual(receipt, { success: false, error: 'SHARED_NATIVE_BINDING_CHANGED' });
    assert.equal(h.f.shared.get(h.f.actor('A'), 'sharedAB', h.id).deleted, false);
});

test('delete-agent keeps and replays its receipt when the post-archive bindings refresh fails', async t => {
    const h = await harness(t, 'agentHandlers', 'delete-agent', 'agent', false);
    const options = confirmation(await h.runtime.nativeDeletionContext(h.scope));
    h.f.control.trace = [];
    const bindings = h.runtime.directoryState.bindings.bind(h.runtime.directoryState);
    let failedRefreshes = 0;
    t.mock.method(h.runtime.directoryState, 'bindings', async (...args) => {
        if ((await persistedRemoval(h))?.stage !== 'removed') return bindings(...args);
        failedRefreshes++;
        throw Object.assign(new Error('Bindings refresh failed'), { code: 'EIO' });
    });

    const receipt = await h.handler({}, ...h.args, options);
    const durable = await persistedRemoval(h);
    t.diagnostic(JSON.stringify({ receipt, removePosts: removePosts(h.f).length, stage: durable?.stage }));
    assert.equal(failedRefreshes, 1);
    assert.equal(durable?.stage, 'removed');
    assert.equal(durable.body.opId, options.operationId);
    assert.equal(h.f.shared.get(h.f.actor('A'), 'sharedAB', h.id).deleted, true);
    assert.equal(removePosts(h.f).length, 1);
    assert.equal(removalReceiptCount(h, options.operationId), 1);
    assert.equal(receipt.success, true, JSON.stringify(receipt));
    assert.equal(receipt.removed, 'all');
    assert.match(receipt.warning, /Bindings refresh failed|EIO/);

    const replay = await h.handler({}, ...h.args, options);
    assert.equal(replay.success, true, JSON.stringify(replay));
    assert.equal(replay.replayed, true);
    assert.equal(removePosts(h.f).length, 1);
    assert.equal(removalReceiptCount(h, options.operationId), 1);
});

function removeTopicFromSettings({ f, runtime }, topic) {
    return runtime.sharedConfigRequest({
        route: 'shared/local-remove',
        body: { sharedSpaceId: 'sharedAB', sharedId: topic.id, mode: 'device',
            expectedVersion: f.shared.get(f.actor('A'), 'sharedAB', topic.id).version, confirmed: true },
    });
}

test('the shared directory cannot remove the only local topic from this device', async t => {
    const h = await harness(t, 'chatHandlers', 'delete-topic', 'agent', true);
    h.f.control.trace = [];

    await assert.rejects(removeTopicFromSettings(h, h.topic), { code: 'SHARED_LAST_LOCAL_TOPIC' });
    assert.equal(removePosts(h.f).length, 0);
    assert.equal(await persistedRemoval(h), undefined);
    assert.equal(h.runtime.isLocalVisible(h.topic.id), true);
    assert.equal(h.f.shared.get(h.f.actor('A'), 'sharedAB', h.topic.id).deleted, false);
});

for (const settingsFirst of [true, false]) {
    test('native topic and shared directory removals leave one local topic when ' +
        (settingsFirst ? 'settings starts first' : 'the native IPC starts first'), async t => {
        const h = await harness(t, 'chatHandlers', 'delete-topic', 'agent', true);
        const second = h.f.shared.create(h.f.actor('A'), {
            sharedSpaceId: 'sharedAB', opId: 'second-racing-topic', kind: 'topic',
            parentId: h.owner.id, localId: 'second', localParent: 'origin', config: { name: 'Second' },
        }).object;
        await h.runtime.tick();
        const secondLocal = h.runtime.localFor(second.id).localId;
        const before = await h.runtime.host.readNativeOwner('agent', h.scope.itemId);
        assert.deepEqual(new Set(before.topics.map(({ id }) => id)), new Set([h.scope.topicId, secondLocal]));
        const options = { ...confirmation(await h.runtime.nativeDeletionContext(h.scope)), mode: 'device' };
        const native = () => h.handler({}, ...h.args, options);
        const settings = () => removeTopicFromSettings(h, second);
        h.f.control.trace = [];

        const order = settingsFirst ? [settings, native] : [native, settings];
        const entered = Promise.withResolvers();
        const resume = Promise.withResolvers();
        const sync = h.runtime.replica.sync.bind(h.runtime.replica);
        t.mock.method(h.runtime.replica, 'sync', async (...args) => {
            entered.resolve();
            await resume.promise;
            return sync(...args);
        });
        const directoryRemove = t.mock.method(h.runtime.directoryState, 'remove');
        const first = order[0]();
        let secondRemoval;
        let callsWhileFirstWaited;
        try {
            await Promise.race([entered.promise, first.then(() => assert.fail('First removal never reached replica sync'))]);
            secondRemoval = order[1]();
            await new Promise(resolve => setImmediate(resolve));
            callsWhileFirstWaited = directoryRemove.mock.callCount();
        } finally {
            resume.resolve();
        }
        const results = await Promise.allSettled([first, secondRemoval]);
        assert.equal(callsWhileFirstWaited, 1, 'both callers reached the directory before the first removal finished');
        const successes = results.filter(result => result.status === 'fulfilled' && result.value.removed === 'device');
        const errors = results.map(result => result.status === 'rejected' ? result.reason.code : result.value.error)
            .filter(Boolean);
        assert.equal(successes.length, 1);
        assert.deepEqual(errors, ['SHARED_LAST_LOCAL_TOPIC']);
        assert.equal(removePosts(h.f).length, 1);
        const local = await h.runtime.host.readNativeOwner('agent', h.scope.itemId);
        assert.equal(local.topics.length, 1);
        assert.equal([h.topic.id, second.id].filter(id => h.runtime.isLocalVisible(id)).length, 1);
        for (const id of [h.topic.id, second.id]) {
            assert.equal(h.f.shared.get(h.f.actor('A'), 'sharedAB', id).deleted, false);
        }
    });
}

for (const [channel, moduleName, kind, isTopic] of channels.filter(row => !row[3])) {
    test(channel + ' routes an explicit device confirmation without deleting the peer owner', async t => {
        const h = await harness(t, moduleName, channel, kind, isTopic);
        const peer = await h.f.desktop('B');
        const options = { ...confirmation(await h.runtime.nativeDeletionContext(h.scope)), mode: 'device' };
        const receipt = await h.handler({}, ...h.args, options);
        assert.equal(receipt.success, true);
        assert.equal(receipt.removed, 'device');
        const replay = await h.handler({}, ...h.args, options);
        assert.equal(replay.replayed, true);
        assert.equal(removalReceiptCount(h, options.operationId), 1);
        await peer.runtime.tick();
        assert.equal(h.runtime.isLocalVisible(h.id), false);
        assert.equal(peer.runtime.isLocalVisible(h.id), true);
        assert.equal(h.f.shared.get(h.f.actor('B'), 'sharedAB', h.id).deleted, false);
    });
}

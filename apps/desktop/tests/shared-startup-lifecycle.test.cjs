'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createAppFeatures } = require('../modules/appFeatures');
const { createDesktopRuntimeLifecycle } = require('../modules/nativeSyncDesktopRuntime/lifecycle');
const { createQuitAdmission } = require('../modules/services/quitAdmission.cjs');
const { prepareLocalHistoryAuthority } = require('../modules/services/nativeSync/historyAuthority');
const { HistoryAuthority } = require('../modules/services/historyAuthority');
const { HistoryMutationQueue } = require('../modules/services/historyMutationQueue');

const deferred = () => Promise.withResolvers();
const unexpected = value => assert.fail(value?.code || 'unexpected startup error');

test('waits for actual History readiness without holding quit admission; cancelled quit permits startup', async () => {
    const gate = createQuitAdmission();
    const hold = deferred();
    const entered = deferred();
    const instance = { close() {} };
    const life = createDesktopRuntimeLifecycle({
        async start({ waitForHistoryAuthority }) {
            entered.resolve();
            await waitForHistoryAuthority();
            return instance;
        },
        waitForHistory: () => hold.promise,
        onStartupError: unexpected,
    });
    await entered.promise;
    assert.equal(life.getRuntime(), null);
    assert.equal(gate.begin(), false);
    gate.resume();
    hold.resolve();
    assert.equal(await life.ready, instance);
    assert.equal(life.getRuntime(), instance);
    await life.close();
});

test('committed shutdown cancels the startup wait for History', async () => {
    const entered = deferred();
    const life = createDesktopRuntimeLifecycle({
        async start({ waitForHistoryAuthority }) {
            entered.resolve();
            await waitForHistoryAuthority();
            assert.fail('started after teardown');
        },
        waitForHistory: () => deferred().promise,
        onStartupError: unexpected,
    });
    await entered.promise;
    await life.close();
    await assert.rejects(life.ready, { code: 'APPLICATION_SHUTTING_DOWN' });
});

test('late runtime stays private and closes exactly once', async () => {
    const hold = deferred();
    const entered = deferred();
    let closed = 0;
    const life = createDesktopRuntimeLifecycle({
        start({ isStopping }) {
            assert.equal(isStopping(), false);
            entered.resolve(isStopping);
            return hold.promise;
        },
        onStartupError: unexpected,
    });
    const isStopping = await entered.promise;
    life.beginShutdown();
    assert.equal(isStopping(), true);
    const closing = life.close();
    assert.equal(life.close(), closing);
    hold.resolve({ close: async () => { closed++; } });
    assert.equal(await life.ready, null);
    await closing;
    assert.equal(life.getRuntime(), null);
    assert.equal(closed, 1);
});

test('partial runtime close failure stays observable on retries', async () => {
    let closes = 0;
    const life = createDesktopRuntimeLifecycle({
        start: () => ({ async close() { closes++; throw Error('partial runtime cleanup'); } }),
        onStartupError: unexpected,
    });
    await life.ready;
    await assert.rejects(life.close(), /partial runtime cleanup/);
    assert.equal(life.getRuntime(), null);
    await assert.rejects(life.close(), /partial runtime cleanup/);
    assert.equal(closes, 1);
});

test('factory failure is recorded and cannot publish a runtime', async () => {
    const failures = [];
    const life = createDesktopRuntimeLifecycle({
        start: () => { throw Object.assign(Error('startup failed'), { code: 'SYNTHETIC_FAILURE' }); },
        onStartupError: error => failures.push(error.code),
    });
    await assert.rejects(life.ready, { code: 'SYNTHETIC_FAILURE' });
    assert.deepEqual(failures, ['SYNTHETIC_FAILURE']);
    assert.equal(life.getRuntime(), null);
    await life.close();
});

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ns-startup-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return root;
}

for (const disabled of ['NativeSyncSettings', 'NativeSyncDesktopRuntime', null]) {
    test(`real feature discovery honors independent activation (${disabled || 'missing runtime'})`, async t => {
        const root = await fixture(t);
        const projectRoot = path.join(root, 'app');
        const modules = path.join(projectRoot, 'modules');
        for (const folder of ['nativeSyncDesktopRuntime', 'nativeSyncSettings']) {
            if (!disabled && folder === 'nativeSyncDesktopRuntime') continue;
            await fs.mkdir(path.join(modules, folder), { recursive: true });
            await fs.copyFile(path.join(__dirname, '../modules', folder, 'feature.json'), path.join(modules, folder, 'feature.json'));
        }
        await fs.writeFile(path.join(root, 'features.json'), JSON.stringify({ disabled: disabled ? [disabled] : [] }));
        const registered = [];
        const loader = createAppFeatures({ projectRoot, appDataRoot: root, requireModule: main => ({
            register() {
                registered.push(path.basename(path.dirname(main)));
                return { example: true };
            },
        }) });
        loader.registerAll({});
        loader.registerAll({});
        const runtime = disabled === 'NativeSyncSettings';
        assert.deepEqual(registered, [runtime ? 'nativeSyncDesktopRuntime' : 'nativeSyncSettings']);
        assert.equal(loader.getHandle('NativeSyncDesktopRuntime')?.example ?? false, runtime);
    });
}

test('actual dormant feature owns one IPC registration set and performs no network or settings reads', async t => {
    const appDataRoot = await fixture(t);
    const ipc = new Map(), added = [], removed = [];
    const ipcMain = {
        handle(channel, handler) {
            assert.equal(ipc.has(channel), false);
            added.push(channel);
            ipc.set(channel, handler);
        },
        removeHandler(channel) {
            assert.equal(ipc.delete(channel), true);
            removed.push(channel);
        },
    };
    const queue = { configureSync(policy) { this.syncPolicy = policy; } };
    const localHistoryAuthority = await prepareLocalHistoryAuthority({ queue, appDataRoot });
    await fs.writeFile(path.join(appDataRoot, 'features.json'), JSON.stringify({ disabled: ['NativeSyncSettings'] }));
    const loader = createAppFeatures({
        projectRoot: path.resolve(__dirname, '..'),
        appDataRoot,
        requireModule: main => main.includes('nativeSyncDesktopRuntime') ? require(main) : { register() {} },
    });
    const host = {
        appDataRoot,
        historyQueue: () => queue,
        readSettings: () => assert.fail('settings read'),
        nativeSync: {
            ipcMain, localHistoryAuthority,
            waitForHistory: () => assert.fail('CDS wait'),
            agentConfigManager: {
                readAgentConfig() { assert.fail('unexpected agent read'); },
                updateAgentConfig() { assert.fail('unexpected agent update'); },
                writeAgentConfig() { assert.fail('unexpected agent write'); },
                on() { assert.fail('unexpected subscription'); },
            },
        },
    };
    loader.registerAll(host);
    const life = loader.getHandle('NativeSyncDesktopRuntime');
    assert.ok(await life.ready);
    loader.registerAll(host);
    assert.equal(loader.getHandle('NativeSyncDesktopRuntime'), life);
    assert.ok(added.length > 0);
    await loader.disposeAll();
    assert.equal(ipc.size, added.length, 'explicit shutdown owns runtime IPC disposal');
    await Promise.all([life.close(), life.close()]);
    assert.deepEqual([...removed].sort(), [...added].sort());
});

for (const type of ['shared-directory', 'selected-connection', 'invalid-connection', 'local']) {
    test(`early History allowance derives from retained facts (${type})`, async t => {
        const appDataRoot = await fixture(t);
        const data = path.join(appDataRoot, '.native-sync');
        await fs.mkdir(data);
        const topic = { itemType: 'agent', itemId: 'agentA', topicId: 'topicA' };
        const other = { ...topic, topicId: 'topicB' };
        if (type === 'shared-directory') {
            await fs.mkdir(path.join(data, 'shared', 'bound-shared'), { recursive: true });
            await fs.writeFile(path.join(data, 'connection.json'), JSON.stringify({ enabled: false }));
        }
        if (type === 'selected-connection') await fs.writeFile(path.join(data, 'connection.json'), JSON.stringify({
            version: 1, enabled: true, topics: [topic], historySelectionApproved: true,
        }));
        if (type === 'invalid-connection') await fs.writeFile(path.join(data, 'connection.json'), '{');
        const queue = { configureSync(policy) { this.syncPolicy = policy; } };
        await prepareLocalHistoryAuthority({ queue, appDataRoot });
        const policy = queue.syncPolicy;
        if (type === 'local') {
            assert.equal(policy, undefined);
            return;
        }
        await assert.rejects(policy.beforeMutation(topic), { code: 'SYNC_STARTUP_RECOVERY_REQUIRED' });
        await assert.rejects(policy.beginDelete({itemType: topic.itemType, itemId: topic.itemId}), { code: 'SYNC_STARTUP_RECOVERY_REQUIRED' });
        if (type === 'selected-connection') await policy.beforeMutation(other);
        else await assert.rejects(policy.beforeMutation(other), { code: 'SYNC_STARTUP_RECOVERY_REQUIRED' });
    });
}

test('optional CDS settling without authority cannot grant native History admission', async () => {
    const authority = new HistoryAuthority({ queue: { ownerDirectories: {}, drainForAuthority: async () => {} } });
    try {
        const life = createDesktopRuntimeLifecycle({
            async start({ waitForHistoryAuthority }) {
                await waitForHistoryAuthority();
                authority.assertNativeAdmission();
            },
            waitForHistory: async () => null,
            onStartupError: () => {},
        });
        await assert.rejects(life.ready, { code: 'HISTORY_AUTHORITY_PENDING' });
        await life.close();
    } finally { await authority.close(); }
});


for (const shared of [true, false]) {
    test(`real Queue honors disabled connection with ${shared ? 'retained Shared join' : 'no binding'}`, async t => {
        const appDataRoot = await fixture(t);
        const ownerRoot = path.join(appDataRoot, 'Agents', 'one');
        const userDataDir = path.join(appDataRoot, 'UserData');
        const history = path.join(userDataDir, 'one', 'topics', 'topic', 'history.json');
        const sync = path.join(appDataRoot, '.native-sync');
        await Promise.all([ownerRoot, path.dirname(history), sync, path.join(appDataRoot, 'AgentGroups')]
            .map(dir => fs.mkdir(dir, {recursive:true})));
        await fs.writeFile(path.join(ownerRoot, 'config.json'), JSON.stringify({id:'one', topics:[{id:'topic'}]}));
        await fs.writeFile(history, '[]');
        await fs.writeFile(path.join(sync, 'connection.json'), JSON.stringify({
            version:1, enabled:false,
            ...(shared ? {sharedSpaceId:'original-space', sharedJoinOpId:'original-join'} : {}),
        }));
        const queue = new HistoryMutationQueue({userDataDir});
        await prepareLocalHistoryAuthority({queue, appDataRoot});
        const authority = new HistoryAuthority({
            queue, noChildConfirmed:true,
            deriveProtection: () => require('../modules/services/nativeSync/historyAuthority').deriveHistoryProtection({appDataRoot}),
        });
        try {
            await authority.refresh();
            const descriptor = {itemType:'agent',itemId:'one',topicId:'topic'};
            const update = () => queue.mutate(descriptor, () => [{id:'local',role:'user',content:'synthetic'}]);
            if (shared) {
                await assert.rejects(update(), {code:'SYNC_STARTUP_RECOVERY_REQUIRED'});
                assert.equal(await fs.readFile(history, 'utf8'), '[]');
            } else assert.equal((await update()).success, true);
        } finally {
            await authority.close();
            await queue.dispose();
        }
    });
}

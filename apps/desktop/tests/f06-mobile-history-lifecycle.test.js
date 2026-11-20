'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { HistoryMutationQueue } = require('../modules/services/historyMutationQueue');
const lifecycle = require('../VCPDistributedServer/Plugin/VCPMobileSync/sync/historyLifecycle');
// Only metadata indexing is simulated. All lifecycle and History I/O below use the real host queue.
const db = require('../VCPDistributedServer/Plugin/VCPMobileSync/core/db');
const owners = new Map(), topics = new Map();
const key = x => `${x.ownerType}:${x.ownerId}:${x.topicId || ''}`;
db.getDb = () => ({ prepare() { return { run() { return { changes: 1 }; }, all() { return []; } }; } });
db.getOwnerState = identity => owners.get(key(identity));
db.getTopicState = identity => topics.get(key(identity));
db.upsertTopicState = identity => { topics.set(key(identity), { topic_id: identity.topicId, owner_type: identity.ownerType, owner_id: identity.ownerId, deleted_at: null }); return { changes: 1 }; };
db.upsertTopicTombstone = identity => topics.set(key(identity), { topic_id: identity.topicId, owner_type: identity.ownerType, owner_id: identity.ownerId, deleted_at: identity.deletedAt });
db.upsertOwnerTombstone = identity => owners.set(key(identity), { owner_type: identity.ownerType, owner_id: identity.ownerId, config_path: identity.configPath, deleted_at: identity.deletedAt });
db.refreshOwnerContentHash = () => '';
const { writeHistoryAtomic, readHistoryStrict } = require('../VCPDistributedServer/Plugin/VCPMobileSync/sync/message');
const { uploadEntity, deleteEntity, repairTopicProjectionsFromDisk, scanPhysicalTopicTree } = require('../VCPDistributedServer/Plugin/VCPMobileSync/sync/entity');

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'f06-mobile-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const queue = new HistoryMutationQueue({ userDataDir: path.join(root, 'UserData') });
    const configServices = require('./helpers/f06-native-config-services.cjs').createNativeConfigServices(root, queue);
    lifecycle.configureHistoryLifecycle(queue, root, configServices);
    t.after(() => queue.dispose());
    const configPath = path.join(root, 'Agents', 'owner', 'config.json');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify({ name: 'Synthetic', topics: [{ id: 'topic', name: 'Synthetic', createdAt: 1 }] }));
    owners.clear(); topics.clear();
    owners.set('agent:owner:', { owner_type: 'agent', owner_id: 'owner', config_path: configPath, deleted_at: null });
    topics.set('agent:owner:topic', { owner_type: 'agent', owner_id: 'owner', topic_id: 'topic', config_path: configPath, deleted_at: null });
    const descriptor = { itemId: 'owner', itemType: 'agent', topicId: 'topic' };
    await queue.initializeIfMissing(descriptor, []);
    return { root, queue, descriptor, configPath, configServices, historyPath: queue.getHistoryPath('owner', 'topic') };
}

test('MobileSync writer shares native serialization and retains expected-hash rejection', async t => {
    const f = await fixture(t);
    const before = await readHistoryStrict(f.historyPath);
    await f.queue.mutate(f.descriptor, history => [...history, { id: 'native' }]);
    await assert.rejects(writeHistoryAtomic(f.historyPath, [{ id: 'mobile-stale' }], before.sourceHash), /changed concurrently/);
    assert.deepEqual((await readHistoryStrict(f.historyPath)).history, [{ id: 'native' }]);
    const fresh = await readHistoryStrict(f.historyPath);
    await writeHistoryAtomic(f.historyPath, [...fresh.history, { id: 'mobile' }], fresh.sourceHash);
    assert.equal((await readHistoryStrict(f.historyPath)).history.length, 2);
});

test('MobileSync topic publishes config before initialization; deletion persists denial and old upload cannot restore it', async t => {
    const f = await fixture(t);
    const data = { id: 'remote', ownerId: 'owner', name: 'Remote', createdAt: 2, configHash: 'a'.repeat(64), updatedAt: 2 };
    const created = await uploadEntity({ id: 'remote', type: 'agent_topic', ownerType: 'agent', ownerId: 'owner', data, appDataPath: f.root });
    assert.equal(created.success, true, JSON.stringify(created));
    assert.deepEqual(JSON.parse(await fs.readFile(f.queue.getHistoryPath('owner', 'remote'), 'utf8')), []);
    const removed = await deleteEntity({ id: 'remote', type: 'agent_topic', ownerType: 'agent', ownerId: 'owner', deletedAt: 3, appDataPath: f.root });
    assert.equal(removed.success, true, JSON.stringify(removed));
    const config = JSON.parse(await fs.readFile(f.configPath, 'utf8'));
    assert(config._historyDeletedTopics.includes('remote'));
    assert(!config.topics.some(topic => topic.id === 'remote'));
    const retried = await uploadEntity({ id: 'remote', type: 'agent_topic', ownerType: 'agent', ownerId: 'owner', data, appDataPath: f.root });
    assert.equal(retried.success, false);
    const restarted = new HistoryMutationQueue({ userDataDir: path.join(f.root, 'UserData') });
    t.after(() => restarted.dispose());
    await assert.rejects(restarted.initializeIfMissing({ ...f.descriptor, topicId: 'remote' }, []), /DELETED/);
});

test('MobileSync repair does not re-authorize deleted topics or rebuild a corrupt config from backups', async t => {
    const f = await fixture(t);
    const config = JSON.parse(await fs.readFile(f.configPath, 'utf8'));
    config.topics = []; config._historyDeletedTopics = ['topic'];
    await fs.writeFile(f.configPath, JSON.stringify(config));
    await repairTopicProjectionsFromDisk(f.root);
    assert.equal(JSON.parse(await fs.readFile(f.configPath, 'utf8')).topics.length, 0);
    await fs.writeFile(`${f.configPath}.backup`, JSON.stringify({ topics: [{ id: 'topic' }] }));
    await fs.writeFile(f.configPath, 'corrupt');
    await assert.rejects(repairTopicProjectionsFromDisk(f.root), /authorization recovery is denied/);
    assert.equal(await fs.readFile(f.configPath, 'utf8'), 'corrupt');
});

test('MobileSync owner deletion keeps the native tombstone and startup scan excludes it', async t => {
    const f = await fixture(t);
    const result = await deleteEntity({ id: 'owner', type: 'agent', deletedAt: 4, appDataPath: f.root });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(JSON.parse(await fs.readFile(f.configPath, 'utf8'))._historyDeleting, true);
    assert.equal((await scanPhysicalTopicTree(f.root)).size, 0);
});

test('MobileSync has no direct-write fallback without a matching host queue', async t => {
    const f = await fixture(t);
    assert.throws(() => lifecycle.configureHistoryLifecycle(f.queue, path.join(f.root, 'other')), /differs/);
    lifecycle.configureHistoryLifecycle(null, f.root);
    await assert.rejects(writeHistoryAtomic(f.historyPath, [], null), /requires the host/);
    assert.deepEqual((await readHistoryStrict(f.historyPath)).history, []);
});

for (const operationKind of ['upload', 'repair']) for (const ownerDeletion of [false, true]) {
  test(`MobileSync group ${operationKind} shares the native config transaction during ${ownerDeletion ? 'owner' : 'topic'} deletion`, async t => {
    const f = await fixture(t);
    const vm = require('node:vm'), nativeFs = require('node:fs');
    const { createRequire } = require('node:module');
    const filename = path.resolve(__dirname, '../Groupmodules/groupchat.js');
    const localRequire = createRequire(filename), module = { exports: {} };
    vm.runInNewContext(nativeFs.readFileSync(filename, 'utf8'), {
        module, exports: module.exports, console: { log() {}, error() {}, warn() {} },
        require(name) {
            if (name === 'electron') return { ipcMain: {} };
            if (['../modules/modelTrajectory', '../modules/contextSanitizer', '../modules/fileManager', '../modules/ipc/canvasHandlers', '../modules/ipc/tavernHandlers', '../modules/tavernRulesEngine', './topicTitleManager', './jevGroupSessionOrchestrator'].includes(name)) return {};
            return localRequire(name);
        },
    }, { filename });
    const group = module.exports;
    group.initializePaths({ APP_DATA_ROOT_IN_PROJECT: f.root, USER_DATA_DIR: path.join(f.root, 'UserData'), AGENT_DIR: path.join(f.root, 'Agents') });
    group.initializeRuntimeServices({ historyMutationQueue: f.queue });
    const created = await group.createAgentGroup('race');
    assert.equal(created.success, true, created.error);
    const groupId = created.agentGroup.id, topicId = created.agentGroup.topics[0].id;
    const configPath = path.join(f.root, 'AgentGroups', groupId, 'config.json');
    owners.set(`group:${groupId}:`, { owner_type: 'group', owner_id: groupId, config_path: configPath, deleted_at: null });
    lifecycle.configureHistoryLifecycle(f.queue, f.root, { groupConfigMutator: group.mutateGroupConfig });
    if (operationKind === 'repair') {
        const stale = await group.createNewTopicForGroup(groupId, 'Stale metadata');
        assert.equal(stale.success, true, stale.error);
        topics.set(`group:${groupId}:${stale.topicId}`, { owner_type: 'group', owner_id: groupId, topic_id: stale.topicId, deleted_at: 1 });
    }
    let pause, entered;
    const enteredPromise = new Promise(resolve => { entered = resolve; });
    const pausePromise = new Promise(resolve => { pause = resolve; });
    const originalOpen = fs.open;
    let intercepted = false;
    fs.open = async function(file, ...args) {
        const handle = await originalOpen.call(this, file, ...args);
        if (!intercepted && String(file).startsWith(`${configPath}.`) && !String(file).includes('.backup')) {
            intercepted = true;
            const originalSync = handle.sync.bind(handle);
            handle.sync = async () => { await originalSync(); entered(); await pausePromise; };
        }
        return handle;
    };
    try {
        const uploaded = operationKind === 'upload'
            ? uploadEntity({ id: groupId, type: 'group', data: { name: 'Mobile changed' }, appDataPath: f.root })
            : repairTopicProjectionsFromDisk(f.root).then(() => ({ success: true }));
        await enteredPromise;
        let deletionFinished = false;
        const deleted = (ownerDeletion ? group.deleteAgentGroup(groupId) : group.deleteGroupTopic(groupId, topicId)).then(result => { deletionFinished = true; return result; });
        await new Promise(resolve => setTimeout(resolve, 40));
        const deletedWhileWriterHeld = deletionFinished;
        pause();
        const [uploadResult, deleteResult] = await Promise.all([uploaded, deleted]);
        assert.equal(uploadResult.success, true, JSON.stringify(uploadResult));
        assert.equal(deleteResult.success, true, deleteResult.error);
        const final = JSON.parse(await fs.readFile(configPath, 'utf8'));
        assert.equal(deletedWhileWriterHeld, false, 'native deletion bypassed the MobileSync config transaction');
        if (ownerDeletion) assert.equal(final._historyDeleting, true, 'late MobileSync publication erased the owner deletion fact');
        else assert(final._historyDeletedTopics?.includes(topicId), 'late MobileSync publication erased the topic deletion fact');
        assert(!final.topics.some(topic => topic.id === topicId));
    } finally { fs.open = originalOpen; pause(); }
});

}


test('MobileSync owner cleanup preserves owned and unknown lock/temp facts until the native manager releases its own lock', async t => {
    const f = await fixture(t);
    const managerModule = process.env.NS_F06_B_MANAGER_MODULE || path.resolve(__dirname, '../modules/utils/agentConfigManager.js');
    const Manager = require(managerModule);
    const manager = new Manager(path.join(f.root, 'Agents'));
    t.diagnostic(`managerModule=${managerModule};sha256=${require('node:crypto').createHash('sha256').update(await fs.readFile(managerModule)).digest('hex')}`);
    lifecycle.configureHistoryLifecycle(f.queue, f.root, { ...f.configServices, agentConfigManager: manager });
    const ownerDir = path.dirname(f.configPath);
    const retained = ['owned.lock', 'unknown.lock', 'pending.tmp', 'config.json.unknown.tmp'];
    for (const file of retained) await fs.writeFile(path.join(ownerDir, file), `preserve:${file}`);
    const lockPath = `${f.configPath}.lock`;
    const originalRelease = manager.releaseLock.bind(manager);
    let entered, release;
    const enteredPromise = new Promise(resolve => { entered = resolve; });
    const releasePromise = new Promise(resolve => { release = resolve; });
    let releaseComplete;
    const completePromise = new Promise(resolve => { releaseComplete = resolve; });
    let managerReleasing = false;
    manager.releaseLock = async (...args) => {
        entered(); await releasePromise;
        managerReleasing = true;
        try { return await originalRelease(...args); } finally { managerReleasing = false; releaseComplete(); }
    };
    const fsExtra = require('fs-extra'), originalRemove = fsExtra.remove;
    const removedLockBy = [];
    fsExtra.remove = async (target, ...args) => {
        if (target === lockPath) removedLockBy.push(managerReleasing ? 'native-manager' : 'other');
        return originalRemove(target, ...args);
    };
    try {
        const deletion = deleteEntity({ id: 'owner', type: 'agent', deletedAt: 9, appDataPath: f.root });
        await enteredPromise;
        const ownedToken = await fs.readFile(lockPath, 'utf8');
        const result = await deletion;
        assert.equal(result.success, true, JSON.stringify(result));
        assert.equal(await fs.readFile(lockPath, 'utf8'), ownedToken);
        assert.equal(JSON.parse(await fs.readFile(f.configPath, 'utf8'))._historyDeleting, true);
        for (const file of retained) assert.equal(await fs.readFile(path.join(ownerDir, file), 'utf8'), `preserve:${file}`);
        assert.deepEqual(removedLockBy, []);
        release(); await completePromise;
        await assert.rejects(fs.stat(lockPath), { code: 'ENOENT' });
        assert.deepEqual(removedLockBy, ['native-manager']);
        for (const file of retained) assert.equal(await fs.readFile(path.join(ownerDir, file), 'utf8'), `preserve:${file}`);
    } finally { release(); await completePromise; fsExtra.remove = originalRemove; }
});

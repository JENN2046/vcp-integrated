'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const { HistoryMutationQueue } = require('../modules/services/historyMutationQueue');
const { createTopicExecutionAuthority } = require('../modules/services/topicExecutionAuthority');
async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shared-topic-authority-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(path.join(root, 'Agents', 'owner'), { recursive: true });
    await fs.writeFile(path.join(root, 'Agents', 'owner', 'config.json'), JSON.stringify({ topics: [{ id: 'topic' }] }));
    const scope = { itemType: 'agent', itemId: 'owner', topicId: 'topic' };
    const queue = new HistoryMutationQueue({ userDataDir: path.join(root, 'UserData') });
    t.after(() => queue.dispose());
    const runtime = {
        ready: true, state: {
            locals: { agent: { kind: 'agent', localId: 'owner' }, sharedTopic: { kind: 'topic', localParent: 'owner', localId: 'topic' } },
            objects: { agent: { kind: 'agent' }, sharedTopic: { kind: 'topic', parentId: 'agent' } },
        },
        matching: { assert() {} }, isLocalVisible: () => true,
        execution: { mapping: () => ({ sharedId: 'sharedTopic' }) },
    };
    const authority = createTopicExecutionAuthority({ appDataRoot: root, getQueue: () => queue, getRuntime: () => runtime });
    return { root, scope, queue, runtime, authority, history: path.join(root, 'UserData/owner/topics/topic/history.json') };
}
test('validated shared empty topic uses real Queue snapshot without creating History or Journal', async t => {
    const x = await fixture(t);
    assert.deepEqual(await x.authority.classify(x.scope), { success: true, kind: 'shared', sharedId: 'sharedTopic' });
    await assert.rejects(fs.stat(x.history), { code: 'ENOENT' });
    await assert.rejects(fs.stat(path.join(x.root, '.native-sync')), { code: 'ENOENT' });
    await assert.rejects(fs.stat(path.join(x.root, 'UserData')), { code: 'ENOENT' });
});
test('local missing History still rejects; existing local and owner-only paths retain semantics', async t => {
    const x = await fixture(t), authority = createTopicExecutionAuthority({ appDataRoot: x.root, getQueue: () => x.queue, getRuntime: () => null });
    assert.equal((await authority.classify(x.scope)).code, 'ENOENT');
    assert.equal((await authority.classify(x.scope, { ownerOnly: true })).kind, 'local');
    await fs.mkdir(path.dirname(x.history), { recursive: true }); await fs.writeFile(x.history, '[]');
    assert.equal((await authority.classify(x.scope)).kind, 'local');
});
for (const [name, mutate, code] of [
    ['unready', x => { x.runtime.ready = false; }, 'SHARED_STARTUP_PENDING'],
    ['closed', x => { x.runtime.closed = true; }, 'SHARED_STARTUP_PENDING'],
    ['paused', x => { x.runtime.directoryPaused = true; }, 'SHARED_STARTUP_PENDING'],
    ['retired owner', x => { x.runtime.state.retiredOwners = { 'agent:owner': true }; }, 'SHARED_OBJECT_MERGED'],
    ['hidden owner', x => { x.runtime.isLocalVisible = id => id !== 'agent'; }, 'SHARED_LOCAL_REMOVED'],
    ['hidden topic', x => { x.runtime.isLocalVisible = id => id !== 'sharedTopic'; }, 'SHARED_LOCAL_MAPPING_PENDING'],
    ['wrong topic parent', x => { x.runtime.state.objects.sharedTopic.parentId = 'other'; }, 'SHARED_LOCAL_MAPPING_PENDING'],
    ['execution mismatch', x => { x.runtime.execution.mapping = () => ({ sharedId: 'other' }); }, 'SHARED_LOCAL_MAPPING_PENDING'],
    ['matching conflict', x => { x.runtime.matching.assert = () => { throw Object.assign(Error(), { code: 'SHARED_MATCHING_CONFLICT' }); }; }, 'SHARED_MATCHING_CONFLICT'],
    ['duplicate owner', x => { x.runtime.state.locals.other = { kind: 'agent', localId: 'owner' }; x.runtime.state.objects.other = {}; }, 'SHARED_LOCAL_MAPPING_PENDING'],
    ['topic alias', x => { x.runtime.state.locals.sharedTopic.aliasOf = 'other'; }, 'SHARED_LOCAL_MAPPING_PENDING'],
]) test(name + ' stays rejected without materializing History', async t => {
    const x = await fixture(t); mutate(x);
    assert.equal((await x.authority.classify(x.scope)).code, code);
    await assert.rejects(fs.stat(x.history), { code: 'ENOENT' });
});
for (const location of ['history', 'ancestor']) test('real Queue rejects shared ' + location + ' symlink', async t => {
    const x = await fixture(t), target = path.join(x.root, 'synthetic-target');
    if (location === 'history') {
        await fs.mkdir(path.dirname(x.history), { recursive: true }); await fs.writeFile(target, '[]'); await fs.symlink(target, x.history);
    } else {
        await fs.mkdir(target); await fs.mkdir(path.join(x.root, 'UserData')); await fs.symlink(target, path.join(x.root, 'UserData/owner'));
    }
    const result = await x.authority.classify(x.scope); assert.equal(result.success, false); assert.equal(result.code, location === 'history' ? 'UNSAFE_HISTORY_FILE' : 'UNSAFE_HISTORY_ANCESTOR');
    if (location === 'history') assert.equal(await fs.readFile(target, 'utf8'), '[]');
});

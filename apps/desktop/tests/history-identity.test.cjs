'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsExtra = require('fs-extra');
const os = require('node:os');
const path = require('node:path');
const { HistoryAuthority } = require('../modules/services/historyAuthority');
const { HistoryMutationQueue } = require('../modules/services/historyMutationQueue');
const { SharedQueue } = require('../modules/services/nativeSync/sharedQueue');

const local = { itemType: 'agent', itemId: 'local_agent', topicId: 'local_topic' };
const shared = { itemType: 'agent', itemId: 'shared_agent', topicId: 'shared_topic' };
const oldRows = [{ id: 'prior' }];
const nextRows = [...oldRows, { id: 'checkpoint' }];
const identity = ({ dev, ino, nlink }) => ({ dev, ino, nlink });

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-history-identity-'));
    const native = new HistoryMutationQueue({ userDataDir: path.join(root, 'UserData') });
    const replica = new SharedQueue(native, [{ local, shared }], 'fixture');
    const file = native.getHistoryPath(local.itemId, local.topicId);
    t.after(async () => {
        await native.dispose();
        await fs.rm(root, { recursive: true, force: true });
    });
    const config = path.join(root, 'Agents', local.itemId, 'config.json');
    await fs.mkdir(path.dirname(config), { recursive: true });
    await fs.writeFile(config, JSON.stringify({ id: local.itemId, topics: [{ id: local.topicId }] }));
    await native.initializeIfMissing(local, oldRows);
    replica.configureSync({ isEnabled: () => true }, async () => {});
    return { root, native, replica, file };
}

function delayFirstHistoryOpen(t, file, onOpen) {
    const open = fs.open;
    const lstat = fsExtra.lstat;
    let lastPathIdentity, intercepted = false;
    t.mock.method(fsExtra, 'lstat', async (target, ...args) => {
        const stat = await lstat(target, ...args);
        if (target === file && !intercepted) lastPathIdentity = identity(stat);
        return stat;
    });
    t.mock.method(fs, 'open', async (target, ...args) => {
        if (target !== file || intercepted) return open(target, ...args);
        intercepted = true;
        return onOpen(() => open(target, ...args), lastPathIdentity);
    });
}

test('an unqueued read straddling the real shared writer fails the inode check', async t => {
    const { native, replica, file } = await fixture(t);
    delayFirstHistoryOpen(t, file, async (open, before) => {
        await replica.mutate({ ...shared, syncSource: 'remote' }, () => nextRows);
        const handle = await open();
        const actual = identity(await handle.stat());
        t.diagnostic(JSON.stringify({ writer: 'SharedQueue.mutate → HistoryMutationQueue → durableJson rename', path: 'UserData/local_agent/topics/local_topic/history.json', lstat: before, fstat: actual }));
        assert.equal(actual.dev, before.dev);
        assert.notEqual(actual.ino, before.ino);
        assert.equal(actual.nlink, 1);
        return handle;
    });
    await assert.rejects(native.read(local), { code: 'HISTORY_IDENTITY_CHANGED' });
    assert.deepEqual(await replica.read(shared), nextRows);
});

test('shared reads and projections take the same topic slot', async t => {
    const { native, replica, file } = await fixture(t);
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    delayFirstHistoryOpen(t, file, async (open, before) => {
        entered.resolve(native.isOperationActive());
        await release.promise;
        const handle = await open();
        const duringRead = identity(await handle.stat());
        assert.deepEqual(duringRead, before);
        t.diagnostic(JSON.stringify({ lstat: before, fstat: duringRead }));
        return handle;
    });

    const reading = replica.read(shared);
    const wasQueued = await entered.promise;
    const projected = replica.mutate({ ...shared, syncSource: 'remote' }, () => nextRows);
    release.resolve();
    assert.deepEqual(await reading, oldRows);
    await projected;
    assert.equal(wasQueued, true);
    assert.deepEqual(await replica.run(shared, () => replica.read(shared)), nextRows);
});

test('shared reads wait for an active authority transition and respect closure', async t => {
    const { native, replica } = await fixture(t);
    await fs.mkdir(native.ownerDirectories.group, { recursive: true });
    const authority = new HistoryAuthority({ queue: native, noChildConfirmed: true });
    t.after(async () => {
        await native.dispose();
        authority.releaseAfterQueueDispose();
    });
    await authority.refresh();
    const started = Promise.withResolvers();
    const release = Promise.withResolvers();
    const transition = authority.withChange(async () => {
        started.resolve();
        await release.promise;
    });
    await started.promise;
    const reading = replica.read(shared);
    try {
        await assert.rejects(native.run(local, () => {}), { code: 'HISTORY_AUTHORITY_PENDING' });
    } finally {
        release.resolve();
    }
    await transition;
    assert.deepEqual(await reading, oldRows);
    await authority.close();
    await assert.rejects(replica.read(shared), { code: 'HISTORY_AUTHORITY_PENDING' });
});

test('a replacement from outside the queue is still rejected', async t => {
    const { replica, file } = await fixture(t);
    delayFirstHistoryOpen(t, file, async (open, before) => {
        const replacement = file + '.unrecognized';
        await fs.writeFile(replacement, JSON.stringify(nextRows), { flag: 'wx' });
        await fs.rename(replacement, file);
        const handle = await open();
        const actual = identity(await handle.stat());
        assert.notEqual(actual.ino, before.ino);
        t.diagnostic(JSON.stringify({ lstat: before, fstat: actual }));
        return handle;
    });
    await assert.rejects(replica.read(shared), { code: 'HISTORY_IDENTITY_CHANGED' });
});

test('a hard link added after lstat is rejected even when dev and ino still match', async t => {
    const { replica, file } = await fixture(t);
    delayFirstHistoryOpen(t, file, async (open, before) => {
        await fs.link(file, file + '.alias');
        const handle = await open();
        const actual = identity(await handle.stat());
        assert.deepEqual(actual, { ...before, nlink: 2 });
        t.diagnostic(JSON.stringify({ lstat: before, fstat: actual }));
        return handle;
    });
    await assert.rejects(replica.read(shared), { code: 'HISTORY_IDENTITY_CHANGED' });
    await assert.rejects(replica.read(shared), { code: 'UNSAFE_HISTORY_FILE' });
});

test('leaf and ancestor symlinks and opposite owner types remain rejected', { skip: process.platform === 'win32' }, async t => {
    const { root, replica, file } = await fixture(t);
    await fs.rename(file, file + '.alias');
    await fs.symlink(file + '.alias', file);
    await assert.rejects(replica.read(shared), { code: 'UNSAFE_HISTORY_FILE' });
    await fs.unlink(file);
    await fs.rename(file + '.alias', file);
    const dir = path.dirname(file);
    await fs.rename(dir, dir + '.alias');
    await fs.symlink(dir + '.alias', dir, 'dir');
    await assert.rejects(replica.read(shared), { code: 'UNSAFE_HISTORY_ANCESTOR' });
    await fs.unlink(dir);
    await fs.rename(dir + '.alias', dir);

    const group = path.join(root, 'AgentGroups', local.itemId);
    await fs.mkdir(group, { recursive: true });
    await fs.writeFile(path.join(group, 'config.json'), JSON.stringify({ topics: [{ id: local.topicId }] }));
    await assert.rejects(replica.mutate({ ...shared, syncSource: 'remote' }, () => nextRows), { code: 'HISTORY_OWNER_AMBIGUOUS' });
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), oldRows);
});

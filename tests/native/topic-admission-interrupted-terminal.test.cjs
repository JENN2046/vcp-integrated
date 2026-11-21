'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { HistoryMutationQueue } = require('../../apps/desktop/modules/services/historyMutationQueue');
const { createTopicMessageAdmissionHost } = require('../../apps/desktop/modules/services/topicMessageAdmissionHost');

const scope = { itemType: 'agent', itemId: 'agent', topicId: 'topic' };
const otherScope = { ...scope, topicId: 'other-topic' };
const token = 'original-request';
const interrupted = {
    id: `admission_${token}`,
    role: 'assistant',
    admissionToken: token,
    finishReason: 'interrupted',
    content: 'Synthetic model prefix',
};

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'topic-admission-terminal-'));
    const historyQueue = new HistoryMutationQueue({ userDataDir: path.join(root, 'UserData') });
    const handlers = new Map();
    const sent = [];
    const sender = { id: 1, isDestroyed: () => false, send: (...args) => sent.push(args) };
    const start = () => createTopicMessageAdmissionHost({
        appDataRoot: root,
        historyQueue,
        validate: target => fs.access(historyQueue.getHistoryPath(target.itemId, target.topicId)),
        getMainWindow: () => ({ isDestroyed: () => false, webContents: sender }),
        ipcMain: {
            handle: (channel, handler) => handlers.set(channel, handler),
            removeHandler: channel => handlers.delete(channel),
        },
    });
    let host;
    t.after(async () => {
        try {
            await host?.dispose();
            await historyQueue.dispose();
        }
        finally { await fs.rm(root, { recursive: true, force: true }); }
    });
    const owner = path.join(root, 'Agents', scope.itemId);
    await fs.mkdir(owner, { recursive: true });
    await fs.writeFile(path.join(owner, 'config.json'), JSON.stringify({
        id: scope.itemId, topics: [scope, otherScope].map(({ topicId }) => ({ id: topicId })),
    }));
    for (const target of [scope, otherScope]) {
        const file = historyQueue.getHistoryPath(target.itemId, target.topicId);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, '[]');
    }
    host = await start();
    const invoke = (method, ...args) => handlers.get(`topic-admission:${method}`)({ sender }, ...args);
    return {
        invoke,
        sent,
        read: target => historyQueue.read(target),
        persist: (message, target = scope) => invoke('persist-assistant', target, message),
        async restart() {
            await host.dispose();
            host = await start();
        },
    };
}

test('an active local admission can durably save and replay only its original interrupted assistant terminal', async t => {
    const f = await fixture(t);
    assert.deepEqual(await f.invoke('acquire', scope, token), { success: true, token });
    const persisted = { ...interrupted, admissionTerminal: true };
    const receipt = { success: true, messageId: interrupted.id, history: [persisted] };
    assert.deepEqual(await f.persist(interrupted), receipt);
    assert.deepEqual(await f.persist(interrupted), receipt);
    assert.deepEqual(await f.persist({ ...interrupted, content: 'Different prefix' }), {
        success: false, error: 'NATIVE_TERMINAL_CONFLICT',
    });
    assert.deepEqual(await f.read(scope), [persisted]);
});

test('interrupted terminal persistence refuses missing, foreign, or released admission ownership', async t => {
    const f = await fixture(t);
    const stale = { success: false, error: 'STALE_LEASE' };
    assert.deepEqual(await f.persist(interrupted), stale);
    assert.deepEqual(await f.invoke('acquire', scope, token), { success: true, token });
    assert.deepEqual(await f.persist(interrupted, otherScope), stale);
    assert.deepEqual(await f.persist({
        ...interrupted, id: 'admission_foreign', admissionToken: 'foreign',
    }), stale);
    assert.deepEqual(await f.invoke('release', scope, token, { saved: true }), { success: true });
    assert.deepEqual(await f.persist(interrupted), stale);
    assert.deepEqual(await f.read(scope), []);
    assert.deepEqual(await f.read(otherScope), []);
});

test('invalid interrupted terminals stay unsaved and ordinary completed terminals still commit', async t => {
    const f = await fixture(t);
    assert.deepEqual(await f.invoke('acquire', scope, token), { success: true, token });
    for (const overrides of [
        { id: 'unrelated-assistant' },
        { admissionToken: undefined },
        { content: '   ' },
        { finishReason: 'length' },
        { error: 'synthetic provider error' },
        { nativeFailure: true },
    ]) {
        assert.deepEqual(await f.persist({ ...interrupted, ...overrides }), {
            success: false, error: 'NATIVE_TERMINAL_REVIEW_REQUIRED',
        }, JSON.stringify(overrides));
    }
    assert.deepEqual(await f.read(scope), []);
    const completed = { ...interrupted, finishReason: 'completed', content: 'Synthetic completed reply' };
    const persisted = { ...completed, admissionTerminal: true };
    assert.equal((await f.persist(completed, otherScope)).success, true);
    assert.deepEqual(await f.read(otherScope), [persisted]);
    assert.equal((await f.persist(completed)).success, true);
    assert.deepEqual(await f.persist(interrupted), { success: false, error: 'NATIVE_TERMINAL_CONFLICT' });
    assert.deepEqual(await f.read(scope), [persisted]);
});

test('restart keeps an interrupted terminal under review without dispatching another model round', async t => {
    const f = await fixture(t);
    assert.deepEqual(await f.invoke('acquire', scope, token), { success: true, token });
    assert.equal((await f.persist(interrupted)).success, true);
    await f.restart();
    const { entries: [entry, ...otherEntries] } = await f.invoke('list', scope);
    assert.deepEqual(otherEntries, []);
    assert.equal(entry.state, 'uncertain');
    assert.equal(entry.leaseToken, token);
    const reconciliation = await f.invoke('reconcile', scope, entry.entryId);
    assert.equal(reconciliation.success, false);
    assert.equal(reconciliation.code, 'TERMINAL_UNCONFIRMED');
    assert.deepEqual((await f.invoke('list', scope)).entries, [entry]);
    assert.deepEqual(await f.read(scope), [{ ...interrupted, admissionTerminal: true }]);
    assert.equal(f.sent.some(([channel]) => channel === 'topic-admission:advance'), false);
});

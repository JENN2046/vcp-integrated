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
    const authority = createTopicExecutionAuthority({ appDataRoot: root, getQueue: () => queue });
    return { root, scope, queue, authority, history: path.join(root, 'UserData/owner/topics/topic/history.json') };
}
test('a valid Core topic has formal authority before native History exists', async t => {
    const x = await fixture(t);
    const { mapTopic } = require('../modules/services/localCoreRuntime');
    x.queue.coreClient = { mapping: mapTopic };
    assert.deepEqual(await x.authority.classify(x.scope), {
        success: true, kind: 'shared', core: true, sharedId: mapTopic(x.scope).sharedId
    });
    await assert.rejects(fs.stat(path.join(x.root, '.native-sync')), { code: 'ENOENT' });
    await assert.rejects(fs.stat(x.history), { code: 'ENOENT' });
});
test('local missing History still rejects; existing local and owner-only paths retain semantics', async t => {
    const x = await fixture(t), authority = createTopicExecutionAuthority({ appDataRoot: x.root, getQueue: () => x.queue });
    assert.equal((await authority.classify(x.scope)).code, 'ENOENT');
    assert.equal((await authority.classify(x.scope, { ownerOnly: true })).kind, 'local');
    await fs.mkdir(path.dirname(x.history), { recursive: true }); await fs.writeFile(x.history, '[]');
    assert.equal((await authority.classify(x.scope)).kind, 'local');
});
test('a retired profile cannot be opened as a local conversation', async t => {
    const x = await fixture(t);
    const directory = path.join(x.root, '.native-sync', 'shared');
    await fs.mkdir(path.join(directory, 'retired'), { recursive: true });
    await fs.mkdir(path.dirname(x.history), { recursive: true });
    await fs.writeFile(x.history, '[]');
    assert.equal((await x.authority.classify(x.scope)).code, 'SHARED_AUTHORITY_UNAVAILABLE');
});

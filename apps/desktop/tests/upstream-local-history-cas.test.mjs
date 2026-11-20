import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import queueModule from '../modules/services/historyMutationQueue.js';
import { createChatRepository } from '../modules/chat/chatRepository.js';
import { createChatHistoryMutationAuthority } from '../modules/chat/chatHistoryMutationAuthority.js';
const { HistoryMutationQueue } = queueModule;
for (const itemType of ['agent', 'group']) test(`${itemType} local CAS compares the queued native disk snapshot, without affecting shared revision rules`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ns-local-cas-'));
    const ownerRoot = path.join(root, itemType === 'agent' ? 'Agents' : 'AgentGroups', 'owner');
    await fs.mkdir(ownerRoot, { recursive: true });
    await fs.writeFile(path.join(ownerRoot, 'config.json'), JSON.stringify({ topics: [{ id: 'topic' }] }));
    const queue = new HistoryMutationQueue({ userDataDir: path.join(root, 'UserData') });
    const descriptor = { itemId: 'owner', itemType, topicId: 'topic' };
    const first = [{ id: 'one', role: 'user', content: 'old' }];
    await queue.replace(descriptor, first);
    const api = {
        getNativeHistorySnapshot: async () => ({ syncEnabled: false }),
        getChatHistory: () => queue.read(descriptor), getGroupChatHistory: () => queue.read(descriptor),
        saveChatHistory: (_id, _topic, history, options) => queue.replace(descriptor, history, { ...options, requireExisting: true }),
        saveGroupChatHistory: (_id, _topic, history, options) => queue.replace(descriptor, history, { ...options, requireExisting: true }),
    };
    const authority = createChatHistoryMutationAuthority({ repository: createChatRepository(api) });
    t.after(async () => { await authority.dispose(); await queue.dispose(); await fs.rm(root, { recursive: true, force: true }); });
    let transforms = 0;
    await assert.rejects(authority.mutate(descriptor, async history => {
        transforms++;
        await queue.mutate(descriptor, current => [...current, { id: 'concurrent', content: 'keep' }]);
        history[0].content = 'stale overwrite';
        return history;
    }), { code: 'HISTORY_CONFLICT' });
    assert.equal(transforms, 1);
    assert.equal((await queue.read(descriptor))[0].content, 'old');
    assert.equal((await queue.read(descriptor))[1].id, 'concurrent');
    const good = await authority.mutate(descriptor, h => h.map(m => m.id === 'one' ? { ...m, content: 'new' } : m));
    assert.equal(good.history.length, 2);
    assert.equal((await queue.read(descriptor))[0].content, 'new');
    await queue.deleteHistory(descriptor, async () => { await fs.rm(queue.getHistoryPath('owner', 'topic')); });
    await assert.rejects(authority.replace(descriptor, []));
    await assert.rejects(fs.stat(queue.getHistoryPath('owner', 'topic')), { code: 'ENOENT' });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatRepository, normalizeChatRepositoryError } from '../modules/chat/chatRepository.js';
import { createChatHistoryMutationAuthority } from '../modules/chat/chatHistoryMutationAuthority.js';
const scope = { itemType: 'agent', itemId: 'a', topicId: 't' };
const deferred = () => { let resolve; return { promise: new Promise(r => { resolve = r; }), resolve: value => resolve(value) }; };

for (const code of ['HISTORY_CONFLICT', 'HISTORY_REVISION_REQUIRED', 'HISTORY_REVISION_CONFLICT', 'HISTORY_PUBLISH_OUTCOME_UNKNOWN']) {
    test(`structured and legacy IPC errors retain ${code} without retry or replace`, async () => {
        for (const failure of [{ success: false, error: code, status: 'unknown' }, { error: { message: 'refused', code }, status: 'unknown' }]) {
            let commits = 0;
            const authority = createChatHistoryMutationAuthority({ repository: {
                getHistory: async () => [], saveHistory: async () => assert.fail('no fallback replace'),
                commitMessages: async () => { commits++; return failure; },
            } });
            await assert.rejects(authority.append(scope, { id: 'one' }), error => error.code === code && error.status === 'unknown');
            assert.equal(commits, 1);
            await authority.dispose();
        }
    });
}

test('a structured thrown error is normalized, including its unknown commit identity', async () => {
    const error = normalizeChatRepositoryError({ error: { code: 'HISTORY_PUBLISH_OUTCOME_UNKNOWN', message: 'sync failed' }, status: 'unknown', commitId: 'original' });
    assert.ok(error instanceof Error);
    assert.equal(error.code, 'HISTORY_PUBLISH_OUTCOME_UNKNOWN');
    assert.equal(error.commitId, 'original');
    assert.equal(error.message, 'sync failed');
});

test('shared immutable receipts keep native revision identity and never borrow a newer revision', async () => {
    let revision = 'r1';
    const history = [{ id: 'one', content: { text: 'initial' } }];
    let lastGuard;
    const repository = createChatRepository({
        getNativeHistorySnapshot: async () => ({ syncEnabled: true, history: structuredClone(history), revision }),
        commitNativeHistoryMessages: async () => ({ success: true, history: structuredClone(history), revision: 'r2' }),
        saveChatHistory: async (_id, _topic, _history, guard) => { lastGuard = guard; return { success: true, history: structuredClone(history), revision: 'r3' }; },
    });
    await repository.getHistory('a', 'agent', 't');
    const authority = createChatHistoryMutationAuthority({ repository });
    const outcome = await authority.append(scope, { id: 'two' });
    assert.equal(repository.revisionOf(outcome.history), 'r2');
    assert.equal(repository.revisionOf(outcome.result.history), 'r2');
    assert.throws(() => { outcome.history[0].content.text = 'mutated'; }, TypeError);
    assert.throws(() => { outcome.result.history[0].content.text = 'mutated'; }, TypeError);
    revision = 'r-newer'; await repository.getHistory('a', 'agent', 't');
    await authority.replace(scope, outcome.history);
    assert.equal(lastGuard, 'r2');
    await assert.rejects(authority.replace(scope, structuredClone(outcome.history)), { code: 'HISTORY_REVISION_REQUIRED' });
    await authority.dispose();
});

test('nonshared mutate passes its exact old snapshot CAS and never repeats an async transform', async () => {
    let transforms = 0, saves = 0;
    const before = [{ id: 'one', content: 'old' }];
    const repository = createChatRepository({
        getNativeHistorySnapshot: async () => ({ syncEnabled: false }),
        getChatHistory: async () => structuredClone(before),
        saveChatHistory: async (_id, _topic, _history, options) => {
            saves++; assert.deepEqual(options.expectedHistory, before);
            return { success: false, error: { code: 'HISTORY_CONFLICT', message: 'stale' } };
        },
    });
    const authority = createChatHistoryMutationAuthority({ repository });
    await assert.rejects(authority.mutate(scope, async h => { transforms++; return [...h, { id: 'two' }]; }), { code: 'HISTORY_CONFLICT' });
    assert.equal(transforms, 1); assert.equal(saves, 1);
    await authority.dispose();
});

test('malformed post-save receipt preserves the successful save and safe history without replay', async () => {
    let saves = 0;
    const authority = createChatHistoryMutationAuthority({ repository: {
        getHistory: async () => [],
        saveHistory: async () => { saves++; return { success: true, nonData: () => {} }; },
    } });
    const outcome = await authority.replace(scope, [{ id: 'one', data: { text: 'saved' } }]);
    assert.equal(saves, 1);
    assert.equal(outcome.result.success, true);
    assert.equal(outcome.result.receiptUnavailable, true);
    assert.equal(outcome.history[0].data.text, 'saved');
    assert.ok(Object.isFrozen(outcome.history[0].data));
    await authority.dispose();
});

test('message commit receipt errors retain the native history when metadata is not plain data', async () => {
    const nativeHistory = [{ id: 'one', content: 'saved' }];
    const authority = createChatHistoryMutationAuthority({ repository: {
        getHistory: async () => [], saveHistory: async () => assert.fail('no replace'),
        commitMessages: async () => ({ success: true, history: nativeHistory, extra: new Date() }),
    } });
    const outcome = await authority.append(scope, { id: 'one' });
    assert.equal(outcome.history, nativeHistory);
    assert.ok(Object.isFrozen(outcome.history[0]));
    assert.equal(outcome.result.receiptUnavailable, true);
    await authority.dispose();
});

test('all dispose callers wait for the same accepted drain; queued replace snapshots cannot be changed', async () => {
    const hold = deferred();
    const writes = [];
    const authority = createChatHistoryMutationAuthority({ repository: {
        getHistory: async () => [], saveHistory: async (_id, _type, _topic, history) => { writes.push(history); if (writes.length === 1) await hold.promise; return { success: true }; },
    } });
    const first = authority.replace(scope, []);
    const original = [{ id: 'one', content: { text: 'original' } }];
    const second = authority.replace(scope, original);
    original[0].content.text = 'changed';
    const drain = authority.dispose();
    assert.equal(authority.dispose(), drain);
    let finished = false; drain.then(() => { finished = true; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(finished, false);
    await assert.rejects(authority.append(scope, { id: 'late' }), /disposed/);
    hold.resolve(); await Promise.all([first, second, drain]);
    assert.equal(writes[1][0].content.text, 'original');
    assert.equal(authority.diagnostics().pendingConversations, 0);
});

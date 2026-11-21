const test = require('node:test');
const assert = require('node:assert/strict');

test('send-state projection settles immediately after terminal projection, before durable persistence', async () => {
    const { createMainChatStreamConsumer } = await import('../modules/renderer/mainChatStreamConsumer.js');

    let releasePersistence;
    const persistenceGate = new Promise(resolve => { releasePersistence = resolve; });
    const calls = [];
    const capabilities = {
        start: async () => {},
        append() {},
        projectTerminal: async () => {
            calls.push('project-terminal');
            return {
                messageId: 'terminal-order',
                context: { agentId: 'agent-a', topicId: 'topic-a' },
                content: 'done',
                finishReason: 'completed',
                history: [],
            };
        },
        onProjectionSettled() {
            calls.push('projection-settled');
        },
        async persistTerminal() {
            calls.push('persist-start');
            await persistenceGate;
            calls.push('persist-end');
            return { success: true };
        },
        setPersistenceState() {},
        async afterPersist() {},
    };
    const consumer = createMainChatStreamConsumer({
        type: 'start',
        messageId: 'terminal-order',
        streamOperationId: 'operation-a',
        context: { agentId: 'agent-a', topicId: 'topic-a' },
    }, capabilities);

    await consumer.prepare({
        type: 'start',
        messageId: 'terminal-order',
        streamOperationId: 'operation-a',
        context: { agentId: 'agent-a', topicId: 'topic-a' },
    });

    const persistence = consumer.persist({
        terminal: {
            kind: 'completed',
            fullResponse: 'done',
            context: { agentId: 'agent-a', topicId: 'topic-a' },
        },
        snapshot: { text: 'done' },
    });
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(calls, [
        'project-terminal',
        'projection-settled',
        'persist-start',
    ]);

    releasePersistence();
    await persistence;
    assert.deepEqual(calls, [
        'project-terminal',
        'projection-settled',
        'persist-start',
        'persist-end',
    ]);
});
test('an archived pause with an empty prefix replaces transient text without persisting again', async () => {
    const { createMainChatStreamConsumer } = await import('../modules/renderer/mainChatStreamConsumer.js');
    const context = { agentId: 'agent-a', topicId: 'topic-a' };
    const paused = { id: 'paused-turn', role: 'assistant', content: '', timestamp: 1, finishReason: 'interrupted' };
    const calls = [];
    const consumer = createMainChatStreamConsumer({
        type: 'start', messageId: paused.id, streamOperationId: 'operation-a', context,
    }, {
        async projectTerminal(...args) {
            calls.push(['project', ...args]);
            return { content: '' };
        },
        beginHistoryPersistence() {
            return saved => calls.push(['release', saved]);
        },
        setPersistenceState(...args) {
            calls.push(['state', ...args]);
        },
        persistTerminal() {
            assert.fail('an archived pause is already persisted');
        },
    });

    const result = await consumer.persist({
        terminal: { kind: 'cancelled', finishReason: 'interrupted', context, pausedWorkMessage: paused },
        snapshot: { text: 'transient pre-checkpoint text' },
    });

    assert.equal(result, paused);
    assert.deepEqual(calls, [
        ['project', paused.id, 'interrupted', context, {
            fullResponse: '', error: '', streamOperationId: 'operation-a', authoritativeContent: true,
        }],
        ['release', true],
        ['state', paused.id, 'saved'],
    ]);
});

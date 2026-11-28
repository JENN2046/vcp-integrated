const test = require('node:test');
const assert = require('node:assert/strict');

const call = id => ({
    id, type: 'function',
    function: { name: 'vcptools', arguments: '{"tool_name":"Demo"}' },
});
const signed = id => ({
    ...call(id),
    extra_content: { vendor: { flags: [id, null] }, google: { thought_signature: '  +/=\n签' + id + ' '.repeat(1024) } },
});
const receipt = id => `<<<[VCP_TOOL_BATCH_START:${id}]>>>\n回执 ${id}\n<<<[VCP_TOOL_BATCH_END:${id}]>>>`;
const batch = id => `\n<<<[ROLE_DIVIDE_USER]>>>\n${receipt(id)}\n<<<[END_ROLE_DIVIDE_USER]>>>\n`;
const frame = (tool_calls, content) => ({ choices: [{ index: 0, delta: { content, tool_calls } }] });
const complete = calls => frame(calls.map((entry, index) => ({ ...entry, index })));

async function runStream(chunks, { cancel = false } = {}) {
    const [
        { createVcpStreamBridge },
        { createMainChatStreamConsumer },
        { createStreamTransientHistory },
        { createChatHistoryPersistence },
    ] = await Promise.all([
        import('../modules/chat/vcpStreamBridge.js'),
        import('../modules/renderer/mainChatStreamConsumer.js'),
        import('../modules/chat/streamTransientHistory.js'),
        import('../modules/chat/chatHistoryPersistence.js'),
    ]);
    const messageId = 'reply';
    const context = { agentId: 'agent', topicId: 'topic' };
    const appendOrder = [];
    let visible = [], saved;
    let notify;
    const settled = new Promise(resolve => { notify = resolve; });
    const repository = {
        getHistory: async () => [],
        saveHistory: async () => assert.fail('must use the assistant transaction'),
        persistAssistant: async (_scope, terminal) => {
            saved = JSON.parse(JSON.stringify(terminal));
            return { success: true };
        },
    };
    const transient = createStreamTransientHistory({
        repository, currentHistory: { get: () => visible, replace: history => { visible = history; } },
    });
    const persistence = createChatHistoryPersistence(repository);
    const bridge = createVcpStreamBridge({
        createConsumer: event => createMainChatStreamConsumer(event, {
            start: message => transient.prepare(message, context, { visible: true }),
            append: (_id, value) => appendOrder.push(value),
            async projectTerminal(id, finishReason, streamContext, { fullResponse, assistantSegments }) {
                const projected = await transient.finalize({
                    messageId: id, context: streamContext, content: fullResponse, assistantSegments, finishReason, visible: true,
                });
                return { ...projected, context: streamContext, content: fullResponse, messageId: id, finishReason };
            },
            persistTerminal: projected => persistence.commit(projected),
            onSettled: notify,
        }),
    });
    const event = (type, extra) => bridge.accept({ messageId, context, type, ...extra });
    const contentChunk = content => ({ choices: [{ delta: { content } }] });
    event('start');
    for (const chunk of chunks) event('data', { chunk: typeof chunk === 'string' ? contentChunk(chunk) : chunk });
    if (cancel) await bridge.cancelOperation(messageId);
    else event('end');
    const outcome = await settled;
    await bridge.dispose();
    assert.equal(outcome.event.outcome.persistence.status, 'saved');
    return { saved, appendOrder };
}

test('two hosted rounds keep batch positions and original parallel IDs through durable history', { timeout: 3000 }, async () => {
    const first = [signed('a'), signed('b')], second = [signed('c')];
    const { saved, appendOrder } = await runStream([
        frame(first.map((entry, index) => ({
            ...entry, index, function: { ...entry.function, arguments: '{"tool_' },
        })), 'A'),
        frame([1, 0].map(index => ({
            index, id: first[index].id, function: { arguments: 'name":"Demo"}' },
            extra_content: { google: first[index].extra_content.google, vendor: first[index].extra_content.vendor },
        }))),
        batch('one').slice(0, -8), batch('one').slice(-8) + 'B',
        complete(second), batch('two') + 'C',
    ]);
    assert.deepEqual(appendOrder, ['A', { vcpHostedToolCalls: first },
        batch('one').slice(0, -8), batch('one').slice(-8) + 'B',
        { vcpHostedToolCalls: second }, batch('two') + 'C']);
    assert.deepEqual(saved.assistantSegments, [
        { content: 'A' }, { tool_calls: first }, { content: batch('one'), receipt: true }, { content: 'B' },
        { tool_calls: second }, { content: batch('two'), receipt: true }, { content: 'C' },
    ]);
    assert.equal(saved.content, `A${batch('one')}B${batch('two')}C`);
});

test('FC-only cancellation persists the partial call without injecting placeholder text', { timeout: 3000 }, async () => {
    const tools = [call('a')];
    const { saved } = await runStream([complete(tools)], { cancel: true });
    assert.equal(saved.content, '');
    assert.deepEqual(saved.assistantSegments, [{ tool_calls: tools }]);
    assert.equal(saved.finishReason, 'cancelled');
});

test('request assembly sends standard messages and closes every original call ID', async () => {
    const { assembleRequestMessages } = await import('../modules/chat/chatContextPipeline.js');
    const first = [signed('a'), signed('b')], second = [signed('c')];
    const { saved } = await runStream([
        'A', complete(first), batch('one'), 'B',
        complete(second), receipt('two') + 'C',
    ]);
    const user = { id: 'next', role: 'user', content: 'next' };
    const { messagesForVCP, retainedHistory } = await assembleRequestMessages({
        electronAPI: {}, context: { agentId: 'a' }, tavernRules: [],
        history: [{ id: 'prior', role: 'user', content: 'prior' }, saved, user],
        agentConfig: { contextMessageWindowSize: 2 },
        systemPromptPrefix: '', systemPromptAppend: '',
        buildMessageContent: ({ message }) => message.content,
    });
    assert.equal(retainedHistory.length, 2);
    assert.deepEqual(messagesForVCP.map(message => message.role),
        ['assistant', 'tool', 'tool', 'user', 'assistant', 'tool', 'user', 'assistant', 'user']);
    const summary = '原始结果保留上下文摘要';
    assert.deepEqual(messagesForVCP.map(message => message.content[0].text),
        ['A', summary, summary, receipt('one'), 'B', summary, receipt('two'), 'C', 'next']);
    assert.deepEqual(messagesForVCP.filter(message => message.tool_calls).map(message => message.tool_calls), [first, second]);
    assert.deepEqual(messagesForVCP.filter(message => message.role === 'tool').map(message => message.tool_call_id), ['a', 'b', 'c']);
    assert.ok(messagesForVCP.every(message => !Object.hasOwn(message, '__vcpHostedHistoryCalls')));
});


test('editing model prose keeps flattened history and structured FC replay in sync', async () => {
    const { reconcileEditedAssistantSegments, expandHostedHistoryMessage } = await import('../modules/chat/hostedToolHistory.js');
    const original = 'before' + batch('one') + 'after';
    const segments = [{ content: 'before' }, { tool_calls: [signed('a')] },
        { content: batch('one'), receipt: true }, { content: 'after' }];
    assert.equal(reconcileEditedAssistantSegments(segments, original), segments);
    for (const text of [original.replace('before', 'new before'), original + '!', '']) {
        const edited = reconcileEditedAssistantSegments(segments, text);
        assert.equal(edited.map(segment => segment.content ?? '').join(''), text);
        assert.equal(edited[1], segments[1]);
        const replay = expandHostedHistoryMessage(JSON.parse(JSON.stringify({ role: 'assistant', content: text, assistantSegments: edited })));
        assert.deepEqual(replay.filter(message => message.role === 'tool').map(message => message.tool_call_id), text ? ['a'] : []);
        assert.deepEqual(replay.flatMap(message => message.tool_calls ?? []), text ? [signed('a')] : []);
    }
});

test('conflicting metadata drops only its slot, including after further matching fragments', async () => {
    const { createNativeToolCallStream } = await import('../modules/chat/nativeToolCallStream.js');
    const decoder = createNativeToolCallStream();
    const bad = signed('bad'), good = signed('good');
    decoder.push(frame([{ index: 4, ...bad }, { index: 2, ...call('good') }]));
    decoder.push(frame([{ index: 4, extra_content: good.extra_content }, { index: 2, extra_content: good.extra_content }]));
    decoder.push(frame([{ index: 4, extra_content: bad.extra_content }]));
    assert.deepEqual(decoder.flush(), [{ vcpHostedToolCalls: [good] }]);
    // After the batch, indices may be reused with fresh metadata.
    const next = { ...call('next'), extra_content: null };
    const full = { choices: [{ message: { tool_calls: [next] } }] };
    assert.deepEqual(decoder.push(full), [{ vcpHostedToolCalls: [next] }]);
});

test('a different ID cannot claim a signed slot, and an unbound fragment cannot supply its signature', async () => {
    const { createNativeToolCallStream } = await import('../modules/chat/nativeToolCallStream.js');
    const decoder = createNativeToolCallStream();
    const first = signed('one'), second = call('two');
    decoder.push(complete([first, second]));
    decoder.push(frame([{ index: 0, id: 'different', extra_content: first.extra_content }]));
    decoder.push(frame([{ extra_content: first.extra_content }]));
    assert.deepEqual(decoder.flush(), [{ vcpHostedToolCalls: [second] }]);
});

test('the session owns an immutable copy of the complete call record', async () => {
    const { createStreamSession } = await import('../modules/chat/streamSession.js');
    const session = createStreamSession({ sessionId: 'reply', conversationKey: 'topic' });
    const input = signed('one');
    const expected = structuredClone(input);
    session.pushChunk({ vcpHostedToolCalls: [input] });
    input.extra_content.google.thought_signature = 'changed outside the session';
    const [stored] = session.snapshot.assistantSegments[0].tool_calls;
    assert.deepEqual(stored, expected);
    assert.ok(Object.isFrozen(stored.extra_content.google));
    assert.ok(Object.isFrozen(stored.extra_content.vendor.flags));
});

test('legacy unsigned deltas still assemble by position', async () => {
    const { createNativeToolCallStream } = await import('../modules/chat/nativeToolCallStream.js');
    const decoder = createNativeToolCallStream();
    const original = call('legacy');
    decoder.push(frame([{ ...original, function: { name: 'vcptools', arguments: '{"tool_' } }]));
    decoder.push(frame([{ function: { arguments: 'name":"Demo"}' } }]));
    assert.deepEqual(decoder.flush(), [{ vcpHostedToolCalls: [original] }]);
});

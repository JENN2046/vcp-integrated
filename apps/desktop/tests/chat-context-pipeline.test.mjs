import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import engine from '../modules/tavernRulesEngine.js';
import { assembleRequestMessages } from '../modules/chat/chatContextPipeline.js';
import { createSingleChatRequestOrchestrator } from '../modules/chat/singleChatRequestOrchestrator.js';

const context = { agentId: 'a', topicId: 't' };
const rule = (type, content) => ({ id: type, type, content, enabled: true, scope: 'agent', wrap: false });
function fixture(systemPrompt = 'You are {{AgentName}}. {{VCPChatWorkSpace}}') {
    const snapshot = { success: true, rules: [
        rule('system_suffix', 'SUFFIX {{VCPChatWorkSpace}}'), rule('user_suffix', 'USER'),
        { ...rule('context_inject', 'INJECT'), role: 'assistant', depth: 0 },
    ] };
    const calls = [];
    return {
        snapshot, calls,
        agentConfig: { name: 'Kerr', systemPrompt, agentDataPath: 'H:\\Agents\\a', topics: [{ id: 't', createdAt: '2026-11-03T00:00:00' }] },
        electronAPI: {
            resolveConversationContext: async owner => { calls.push(['resolve', owner]); return snapshot; },
            tavernGetRules: async () => { throw new Error('global fallback forbidden'); },
            expandWorkspacePlaceholders: async (text, received) => {
                assert.equal(received, snapshot);
                calls.push(['expand', text]);
                return { success: true, text: text.replaceAll('{{VCPChatWorkSpace}}', 'TREE') };
            },
        },
    };
}

test('normal adapter and alternate entry intents produce identical messages and one expansion each', async () => {
    const f = fixture();
    const history = [{ id: 'u', role: 'user', content: 'hello', timestamp: 42 }];
    const before = structuredClone(history);
    const options = { ...f, tavernEngine: engine, history, context, currentUserMessageId: 'u' };
    const normal = await createSingleChatRequestOrchestrator({ ...f, tavernEngine: engine }).buildRequest({
        ...options, settings: {}, messageId: 'reply',
    });
    for (const mode of ['regenerate', 'continue', 'flowlock']) {
        const result = await assembleRequestMessages({ ...options, mode });
        assert.deepEqual(result.messagesForVCP, normal.messages);
    }
    assert.equal(f.calls.filter(([kind]) => kind === 'expand').length, 4);
    assert.match(normal.messages[0].content, /当前聊天记录文件路径: H:\\Agents\\a\\topics\\t\\history.json/);
    assert.match(normal.messages[0].content, /You are Kerr\. TREE\n\nSUFFIX TREE/);
    assert.deepEqual(history, before);
});

test('rules-only prompts expand once with supplied snapshot and skip global resolution', async () => {
    const f = fixture('');
    f.electronAPI.resolveConversationContext = () => { throw new Error('must reuse snapshot'); };
    const result = await assembleRequestMessages({
        ...f, tavernEngine: engine, context, history: [], conversationSnapshot: f.snapshot,
    });
    assert.equal(result.messagesForVCP[0].content, 'SUFFIX TREE');
    assert.equal(f.calls.length, 1);
});

test('temporary prompt alone receives user suffix; multimodal history and timestamp remain intact', async () => {
    const f = fixture();
    const result = await assembleRequestMessages({
        ...f, tavernEngine: engine, context,
        history: [{ id: 'u', role: 'user', timestamp: 10, content: [
            { type: 'text', text: 'old' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,x' } },
        ] }],
        temporaryPrompt: 'continue',
    });
    const users = result.messagesForVCP.filter(m => m.role === 'user');
    assert.equal(users[0].content[0].text, 'old');
    assert.equal(users[0].content[1].image_url.url, 'data:image/png;base64,x');
    assert.equal(users[0].__vcpchatTimestampMeta.timestamp, 10);
    assert.equal(users[1].content[0].text, 'continue\n\nUSER');
});

test('checkpoint bypasses builders and suffixes and removes earlier history', async () => {
    const f = fixture();
    const checkpoint = { role: 'user', content: 'RAW $&', contextCompaction: {
        kind: 'vchat-context-checkpoint', version: 1, checkpoint: 'raw',
    } };
    const result = await assembleRequestMessages({
        ...f, tavernEngine: engine, context, history: [{ role: 'user', content: 'OLD' }, checkpoint],
        currentUserMessage: checkpoint,
        buildMessageContent: () => { throw new Error('checkpoint must bypass'); },
    });
    assert.equal(result.messagesForVCP[1].content[0].text, 'RAW $&');
    assert.equal(result.messagesForVCP[1].__vcpContextCheckpoint, true);
});

test('snapshot failure aborts; workspace failure preserves the original prompt', async () => {
    const f = fixture();
    await assert.rejects(assembleRequestMessages({
        ...f, context, history: [], conversationSnapshot: { success: false, error: 'denied' },
    }), /denied/);
    f.electronAPI.expandWorkspacePlaceholders = async () => { throw new Error('offline'); };
    const result = await assembleRequestMessages({ ...f, tavernEngine: engine, context, history: [] });
    assert.match(result.messagesForVCP[0].content, /\{\{VCPChatWorkSpace\}\}/);
});

test('four entry points delegate and cannot own Tavern/system/workspace assembly', () => {
    for (const path of [
        'modules/chat/singleChatRequestOrchestrator.js', 'modules/renderer/messageContextMenu.js',
        'modules/event-listeners.js', 'Flowlockmodules/flowlock-integration.js',
    ]) {
        const source = fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');
        assert.match(source, /await assembleRequestMessages\(/, path);
        assert.doesNotMatch(source, /\.applySystemSuffix\(|\.applyContextInject\(|\.expandWorkspacePlaceholders\(/, path);
    }
});
test('shared send keeps creation time and user text, but omits the physical History hint', async () => {
    const f = fixture('Keep the user-supplied /user/example/history.json');
    const text = 'literal file:///user/example.txt';
    const { messagesForVCP } = await assembleRequestMessages({
        ...f, sharedTopic: true, context, history: [{ role: 'user', content: text }], tavernRules: [],
    });
    assert.doesNotMatch(messagesForVCP[0].content, /当前聊天记录文件路径/);
    assert.match(messagesForVCP[0].content, /当前话题创建于:/);
    assert.ok(messagesForVCP[0].content.includes('/user/example/history.json'));
    assert.equal(messagesForVCP[1].content[0].text, text);
});

test('an explicit system tool ban removes only the inline text file locator on shared sends', async () => {
    const marker = '[[VCPToolUse=Forbidden]]';
    const f = fixture('persona');
    const text = 'a\nb\n';
    const attachment = { name:'note.txt', type:'text/plain', internalPath:'file:///private/note.txt', extractedText:text };
    const history = [{ id:'one', role:'user', content:marker, attachments:[attachment] }];
    const original = structuredClone(history);
    async function packet(rules) {
        return (await assembleRequestMessages({ ...f, sharedTopic:true, context, history, tavernRules:rules, tavernEngine:engine }))
            .messagesForVCP.at(-1).content[0].text;
    }
    assert.ok((await packet([])).includes('[附加文件: file:///private/note.txt]'));
    const noTools = [rule('system_suffix', marker)];
    assert.equal(await packet(noTools), marker + '\n\n[附加文件: note.txt]\n' + text + '\n[/附加文件结束: note.txt]');
    assert.deepEqual(history, original);
    attachment.isLiveReference = true;
    assert.ok((await packet(noTools)).includes('file:///private/note.txt'));
});

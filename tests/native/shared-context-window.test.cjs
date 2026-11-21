'use strict';
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const path = require('node:path');
const test = require('node:test');
const server = createRequire(path.join(process.env.VCP_TEST_SERVER || path.resolve(__dirname, '../../apps/server'), 'package.json'));
const kernel = server('@vcp/native-history-window');
const { effectiveRequest } = server('./Plugin/NativeSync/mobile/effectiveContext');

test('the desktop compaction API and the worker resolve the native history window', async () => {
    const desktop = await import('../../apps/desktop/modules/chat/contextCompactionState.js');
    assert.equal(desktop.effectiveContextHistory, kernel.effectiveContextHistory);
    assert.equal(desktop.isContextCheckpoint, kernel.isContextCheckpoint);
});

test('shared assembly reads content only for retained non-checkpoint rows and leaves history intact', async () => {
    const checkpoint = (id, version = 1) => ({id, role:'user', content:id,
        contextCompaction:{kind:kernel.COMPACTION_KIND, version, checkpoint:id}});
    const history = [
        checkpoint('older'), {id:'archived',role:'user',content:'old',attachments:[{id:'old-file'}]},
        checkpoint('latest'), {id:'placeholder',role:'assistant',isThinking:true,content:'…'},
        {id:'retained',role:'assistant',content:'reply',attachments:[{id:'current-file'}]},
        checkpoint('unsupported-version', 2), {id:'current',role:'user',content:'hello'},
    ];
    const before = structuredClone(history);
    const readIds = [];
    const packet = await effectiveRequest(history, {systemPrompt:'prompt'}, 'current', async message => {
        readIds.push(message.id);
        return [{type:'text',text:message.content}];
    });
    assert.deepEqual(readIds, ['retained','unsupported-version','current']);
    assert.deepEqual(packet.slice(1).map(message => message.content[0].text), ['latest','reply','unsupported-version','hello']);
    assert.deepEqual(history, before);
});

test('a historical system message does not consume single-chat Tavern injection depth', async () => {
    const { assembleRequestMessages } = await import('../../apps/desktop/modules/chat/chatContextPipeline.js');
    const engine = server('@vcp/core-rules/tavern');
    const history = [
        { role: 'user', id: 'first', content: 'first', timestamp: 1 },
        { role: 'system', id: 'notice', content: 'notice', timestamp: 2 },
        { role: 'user', id: 'current', content: 'last', timestamp: 3 },
    ];
    const rules = [{ type:'context_inject', role:'assistant', scope:'agent', enabled:true, wrap:false, depth:2, content:'depth two' }];
    const config = { systemPrompt:'prompt', tavernRules:rules };
    const assemble = tavernRules => assembleRequestMessages({
        context:{agentId:'agent', topicId:'topic'}, agentConfig:config, history, electronAPI:{},
        tavernRules, tavernEngine:engine, currentUserMessageId:'current',
    }).then(result => result.messagesForVCP);
    const before = structuredClone(history);
    const native = await assemble(rules);
    const shared = await effectiveRequest(history, config, 'current');
    const body = row => typeof row.content === 'string' ? row.content : row.content[0].text;
    assert.deepEqual(native.map(body), ['prompt', 'notice', 'depth two', 'first', 'last']);
    assert.deepEqual(shared, native);
    assert.deepEqual(shared.map(row => row.__vcpchatTimestampMeta?.messageId ?? null),
        [null, 'notice', null, 'first', 'current']);
    assert.deepEqual(await effectiveRequest(history, { ...config, tavernRules:[] }, 'current'), await assemble([]));
    assert.deepEqual(history, before);
});

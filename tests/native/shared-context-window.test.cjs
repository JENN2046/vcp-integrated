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

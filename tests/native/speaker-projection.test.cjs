'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = process.env.VCP_TEST_SERVER || path.resolve(__dirname, '../../apps/server');
const { projectToolBatchForUpstream } = require(root + '/modules/toolResultBatch');
const ToolExecutor = require(root + '/modules/vcpLoop/toolExecutor');

test('only outbound conversational display names are omitted from the packet', () => {
    for (const role of ['system','developer','user','assistant','tool','function']) {
        for (const content of ['text', [{type:'text',text:'a'},{type:'text',text:'b'}], [{type:'image_url',image_url:{url:'fixture'}}]]) {
            const row = Object.freeze({role,name:'历史访客',content});
            const original = Object.freeze({messages:Object.freeze([row]),stream:true});
            for (let i=0;i<2;i++) {
                const [out] = projectToolBatchForUpstream(original).messages;
                assert.equal(Object.hasOwn(out,'name'), ['tool','function'].includes(role));
                if (Object.hasOwn(out,'name')) assert.equal(out.name,row.name);
                assert.deepEqual(out.content,content);
                assert.equal(row.name,'历史访客');
            }
        }
    }
});

test('semantic River projects existing speaker names without guessing them from the text', async () => {
    const registry = {};
    const embeddings = { getBatchEmbeddingsCached: async texts => texts.map(() => [1,0]) };
    const executor = new ToolExecutor({pluginManager:{executionBridgeRegistry:registry,messagePreprocessors:new Map([['RAGDiaryPlugin',embeddings]])}});
    const stop = Error('end of synthetic preparation');
    let rows;
    const release = ToolExecutor.registerToolPreparation(registry,'FixtureSpeaker',async ({args})=>{
        rows=args.river_context;
        throw stop;
    });
    const same = '[另一位的发言]: synthetic speaker example';
    try {
        await assert.rejects(executor.execute({name:'FixtureSpeaker',args:{query:'fixture'},river:'semantic:3'},'127.0.0.1',[
            {role:'assistant',name:'  成员甲  ',content:same},{role:'assistant',name:'  ',content:same},{role:'user',content:same},
        ]), e=>e===stop);
    } finally { release(); }
    assert.deepEqual(rows.map(row=>[row._river_index,row.role,row.content]),[
        [0,'assistant',same],[1,'assistant',same],[2,'user',same],
    ]);
    assert(rows.every(row => row._river_score === 1 / (1 + 1e-8)));
    assert.deepEqual(rows.map(row=>Object.hasOwn(row,'name') ? row.name : null),['成员甲',null,null]);
});

test('the group label is idempotent only for the speaker identified by History', () => {
    const {withGroupSpeaker} = require('../../packages/core-rules/group/speaker');
    assert.equal(withGroupSpeaker('[甲的发言]: 原文','甲'),'[甲的发言]: 原文');
    assert.equal(withGroupSpeaker('[乙的发言]: 引文','甲'),'[甲的发言]: [乙的发言]: 引文');
    assert.equal(withGroupSpeaker('同文','甲'),'[甲的发言]: 同文');
    assert.equal(withGroupSpeaker('同文','乙'),'[乙的发言]: 同文');
});

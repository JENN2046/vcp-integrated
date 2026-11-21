'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

const { stage, inputs, replies, edited } = require('./controlled.cjs');

const seed = [
    { id:'compact-same-1', role:'user', content:'SYNTHETIC SAME TEXT', timestamp:1700000000001 },
    { id:'compact-same-2', role:'user', content:'SYNTHETIC SAME TEXT', timestamp:1700000000002 },
];
const input = 'SYNTHETIC REOPENED COMPACTION';
const tail = input + ' FIRST SEND';
const next = input + ' NEXT SEND';
const reply = '合成桌面回复完成。';
const checkpoint = '<context_checkpoint>\nSynthetic compaction summary. Unique marker COMPACT_DESKTOP_CHECKPOINT.\n</context_checkpoint>';
const summaryModel = 'synthetic-summary';
const capturePath = out => path.join(out, 'compaction-handler.jsonl');

function observe(out) {
    return {
        seedCount: seed.length,
        preload: require.resolve('../context-chain/server-capture.cjs'),
        handlerLog: capturePath(out),
        input,
        reply,
        seed(f, source) {
            const actor = f.actor('C');
            for (const message of seed) f.store.apply({
                ...source.topic, msgId:message.id, deviceId:actor.principal, opId:message.id, baseHash:null,
                action:'upsert', message,
            }, { sharedSpace:'sharedAB' });
        },
        respond,
    };
}

async function respond(body, row, res) {
    row.model = body.model;
    row.messages = body.messages;
    const control = inputs.indexOf(body.messages.at(-1)?.content);
    if (control >= 0) {
        row.fixtureControlled = true;
        const payload = {id:'synthetic-control-'+control,object:'chat.completion',created:1,model:'synthetic',
            choices:[{index:0,message:{role:'assistant',content:replies[control]},finish_reason:'stop'}]};
        res.writeHead(200, {'content-type':'application/json'});
        res.end(JSON.stringify(payload));
        return true;
    }
    if (body.model !== summaryModel) return false;
    assert.equal(body.stream, true);
    const frame = JSON.stringify({id:'synthetic-summary-result',object:'chat.completion.chunk',created:1,model:summaryModel,
        choices:[{index:0,delta:{role:'assistant',content:checkpoint},finish_reason:'stop'}]});
    res.writeHead(200, {'content-type':'text/event-stream'});
    res.end('data: ' + frame + '\n\ndata: [DONE]\n\n');
    return true;
}

module.exports = {
    priorRows: seed, edited, tail, next, reply, checkpoint, summaryModel, capturePath, observe, stage, inputs, replies,
    settings:{enableContextCompaction:true,contextCompactionModel:summaryModel},
};

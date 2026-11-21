'use strict';

const { setTimeout: delay } = require('node:timers/promises');

const stages = ['first', 'middle', 'finish'];
const seedCount = 32;
const stageNames = ['首段', '中段', '终段'];
const paragraph = '这是跨端实时观察的合成文本。共享会话按照同一条执行记录显示更新。观察端可以停在旧消息，继续查看选区或保留输入。此段的编号只用于核对顺序，不代表新的输入、任务或模型调用。';
const segments = stageNames.map((name, stage) => Array.from({ length:7 }, (_, i) =>
    `【${name} ${stage + 1}.${i + 1}】${paragraph}\n\n`));

function seedHistory(store, topic) {
    for (let i = 1; i <= seedCount; i++) {
        const id = 'hardware-seed-' + String(i).padStart(2, '0');
        const message = { id, role:i % 2 ? 'user' : 'assistant', timestamp:1700000000000+i,
            content:`合成旧记录 ${i}。这是联验前写入的历史，可以上滚并选中这条消息。\n\n${paragraph}` };
        store.apply({ ...topic, msgId:id, deviceId:'hardware-seed', opId:id, baseHash:null,
            action:'upsert', message }, { sharedSpace:'sharedAB' });
    }
}

function createStream() {
    let connection, advancing = false, phase = 0;
    const frames = [];
    const fragments = () => ({ stage:stages[phase-1] || 'waiting', frames:frames.length,
        characters:frames.reduce((sum,value)=>sum+value.length,0), ended:phase===stages.length });
    const write = value => connection.write('data: ' + JSON.stringify(value) + '\n\n');
    return {
        view: fragments,
        accept(response) {
            if (connection) throw Error('The hardware provider already accepted its single request');
            connection = response;
            response.writeHead(200, { 'content-type':'text/event-stream', 'cache-control':'no-cache' });
            response.flushHeaders();
        },
        async advance(stage) {
            if (!connection || connection.destroyed || advancing || stages[phase] !== stage) {
                throw Error('Stage unavailable or out of order');
            }
            advancing = true;
            try {
                for (const content of segments[phase]) {
                    if (connection.destroyed) throw Error('Provider connection closed');
                    const delta = frames.length ? { content } : { role:'assistant', content };
                    write({choices:[{index:0,delta,finish_reason:null}]});
                    frames.push(content);
                    await delay(100);
                }
                if (stage === 'finish') {
                    write({choices:[{index:0,delta:{},finish_reason:'stop'}]});
                    connection.end('data: [DONE]\n\n');
                }
                phase++;
                return fragments();
            } finally { advancing = false; }
        },
        close() { if (connection && !connection.writableEnded) connection.destroy(); },
    };
}
module.exports = { createStream, seedHistory, seedCount, stages };

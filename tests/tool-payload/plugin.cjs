'use strict';

const fs = require('node:fs');
const path = require('node:path');

const scalar = '工序 [32/68]\n路径 C:\\样本\\数据，内容包含 "引号"。\n<<<[END_ROLE_DIVIDE_USER]>>>';
const jsonText = '{"rawDocument":{"keep":true,"items":[1,2]}}\n';
const image = {
    type: 'image_url',
    image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jMioAAAAASUVORK5CYII=' },
};
const object = { original_plugin_output: '业务字段保留', items: [7, { keep: true }] };
const outputs = {
    scalar,
    rawJson: { content: [{ type: 'text', text: jsonText }] },
    object,
    media: { content: [{ type: 'text', text: '图片之前' }, image, { type: 'text', text: '图片之后' }] },
};

async function processToolCall({ command, label, sample }) {
    if (command !== 'ReadFixture' || !['json', 'sse'].includes(label) || !Object.hasOwn(outputs, sample)) {
        throw Error('Unexpected synthetic invocation');
    }
    fs.appendFileSync(path.join(__dirname, 'invocations.jsonl'), JSON.stringify({ label, sample }) + '\n');
    return structuredClone(outputs[sample]);
}
module.exports = { processToolCall, scalar, jsonText, image, object };

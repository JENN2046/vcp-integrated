'use strict';

const fs = require('node:fs');
const path = require('node:path');

const filename = 'synthetic-continuity.txt';
const content = '合成附件基线：北桥样本 73。\nSYNTHETIC_FILE_SENTINEL_73\n';
const marker = 'SYNTHETIC ATTACHMENT CONTINUITY';
const prompts = [marker + ' A — 请读附件并确认。', marker + ' B — 上一个文件的样本编号是多少？'];
const replies = ['已读取附件。', '原文件的样本编号是 73。'];
const file = out => path.join(out, filename);
const capture = out => path.join(out, 'attachment-handler.jsonl');

function observe(out) {
    fs.writeFileSync(file(out), content, { mode:0o600 });
    return {
        input:marker, preload:require.resolve('../context-chain/server-capture.cjs'),
        handlerLog:capture(out), observeAttachments:true, seedCount:0, seed() {},
        respond(body, row, res) {
            const user = body.messages.findLast(message => message.role === 'user');
            const requestText = JSON.stringify(user?.content);
            const index = prompts.findIndex(prompt => requestText?.includes(prompt));
            if (index < 0) return false;
            row.messages = body.messages;
            row.model = body.model;
            const reply = JSON.stringify(body.messages).includes('SYNTHETIC_FILE_SENTINEL_73')
                ? replies[index] : '合成 Provider 没有收到文件正文。';
            const result = { id:'attachment-fixture-' + index, object:'chat.completion', created:1, model:body.model,
                choices:[{ index:0, message:{ role:'assistant', content:reply }, finish_reason:'stop' }] };
            res.writeHead(200, {'content-type':'application/json'}).end(JSON.stringify(result));
            return true;
        },
    };
}

module.exports = { filename, content, prompts, replies, file, capture, observe };

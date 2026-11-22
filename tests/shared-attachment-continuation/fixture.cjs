'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');

const filename = 'synthetic-continuity.txt';
const content = '合成附件基线：北桥样本 73。\nSYNTHETIC_FILE_SENTINEL_73\n';
const forbiddenDirective = '[[VCPToolUse=Forbidden]]';
const toolsForbidden = process.env.NS_ATTACHMENT_TOOLS_FORBIDDEN === '1';
const marker = 'SYNTHETIC ATTACHMENT CONTINUITY';
const prompts = [marker + ' A — 请读附件并确认。', marker + ' B — 上一个文件的样本编号是多少？'];
const replies = ['已读取附件。', '原文件的样本编号是 73。'];
const file = out => path.join(out, filename);
const capture = out => path.join(out, 'attachment-handler.jsonl');

function observe(out) {
    fs.writeFileSync(file(out), content, { mode:0o600 });
    return {
        input:marker, preload:require.resolve('../context-chain/server-capture.cjs'),
        handlerLog:capture(out), observeAttachments:true, seedCount:0,
        seed({ shared, actor, owner }) {
            if (!toolsForbidden) return;
            shared.saveConfig(actor('A'), {
                sharedSpaceId:'sharedAB', sharedId:owner.id, opId:'attachment-fixture-forbid-tools',
                expectedVersion:owner.version, config:{...owner.config,
                    systemPrompt:forbiddenDirective + '\n' + owner.config.systemPrompt },
            });
        },
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

const ordinaryTool = require('../ordinary-tools/fixture.cjs');
const probeMarker = 'ORDINARY_TOOL_LOCAL';
const probeTool = {
    stage: ordinaryTool.stage,
    reply(body, row, calls) {
        return ordinaryTool.reply(body, row, calls.filter(call => call.id === row.id));
    },
};

async function verifyToolDirective({ service, out, cert }) {
    const results = [];
    for (const forbidden of [false, true]) {
        const before = ordinaryTool.counts(out).length;
        const requestId = 'attachment-tool-probe-' + (forbidden ? 'forbidden' : 'allowed');
        const body = JSON.stringify({ requestId, model:'synthetic', stream:false, messages:[
            { role:'system', content:forbidden ? forbiddenDirective + '\nSynthetic tool probe' : 'Synthetic tool probe' },
            { role:'user', content:probeMarker },
        ] });
        const reply = await new Promise((resolve, reject) => {
            const request = https.request(service.origin + '/v1/chat/completions', {
                method:'POST', ca:fs.readFileSync(cert), timeout:10000,
                headers:{ 'content-type':'application/json', authorization:'Bearer synthetic-only',
                    'content-length':Buffer.byteLength(body) },
            }, response => {
                const chunks = [];
                response.on('data', chunk => chunks.push(chunk));
                response.on('error', reject);
                response.on('end', () => {
                    try {
                        assert.equal(response.statusCode, 200);
                        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
                    } catch (error) {
                        reject(error);
                    }
                });
            });
            request.on('error', reject);
            request.on('timeout', () => request.destroy(Error('Synthetic tool probe timed out')));
            request.end(body);
        });
        const calls = service.calls.filter(row => row.id === requestId);
        const phases = calls.map(row => row.ordinaryPhase);
        const content = reply.choices?.[0]?.message?.content;
        const invocationCount = ordinaryTool.counts(out).filter(row => row.marker === probeMarker).length;
        const invocationDelta = invocationCount - before;
        assert.equal(invocationDelta, forbidden ? 0 : 1);
        assert.deepEqual(phases, forbidden ? ['tool-request'] : ['tool-request', 'continuation']);
        if (forbidden) {
            assert.ok(content.includes('<<<[TOOL_REQUEST]>>>'), 'forbidden tool syntax returned as inert output');
        } else {
            assert.ok(content.includes(ordinaryTool.finalText), 'allowed call completed native tool loop');
            assert.ok(calls[1].hasToolResult, 'allowed tool result was visible to the provider');
        }
        results.push({ forbidden, requestId, phases, invocationDelta, returnedInertToolSyntax:forbidden });
    }
    return results;
}

module.exports = { filename, content, marker, prompts, replies, file, capture, observe, forbiddenDirective, toolsForbidden, probeTool, verifyToolDirective };

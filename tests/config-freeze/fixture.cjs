'use strict';

const path = require('node:path');
const input = 'SYNTHETIC CONFIG FREEZE';
const oldPrompt = 'SYNTHETIC_FROZEN_PROMPT_OLD_727';
const updatedPrompt = 'SYNTHETIC_FROZEN_PROMPT_NEW_839';
const prompts = [input + ' A', input + ' B'];
const replies = ['Synthetic response A', 'Synthetic response B'];
const capture = out => path.join(out, 'config-freeze-handler.jsonl');

function observe(out) {
    return {
        input,
        preload:require.resolve('../context-chain/server-capture.cjs'),
        handlerLog:capture(out),
        agentConfig:{ systemPrompt:oldPrompt },
        seedCount:0,
        seed() {},
        respond(body, row, res) {
            const content = body.messages.findLast(message => message.role === 'user')?.content;
            const text = Array.isArray(content) ? content.map(part => part.text ?? '').join('') : content;
            const index = prompts.indexOf(text);
            if (index < 0) return false;
            row.messages = body.messages;
            row.model = body.model;
            row.temperature = body.temperature;
            row.max_tokens = body.max_tokens;
            row.input = text;
            const result = { id:'freeze-fixture-' + index, object:'chat.completion', created:1, model:body.model,
                choices:[{ index:0, message:{ role:'assistant', content:replies[index] }, finish_reason:'stop' }] };
            res.writeHead(200, {'content-type':'application/json'}).end(JSON.stringify(result));
            return true;
        },
    };
}

module.exports = { capture, input, oldPrompt, updatedPrompt, prompts, replies, observe };

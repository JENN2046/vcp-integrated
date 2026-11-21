'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');

const box = process.env.VCP_TEST_SERVER || path.resolve(__dirname, '../../apps/server');
const NonStreamHandler = require(box + '/modules/handlers/nonStreamHandler');
const StreamHandler = require(box + '/modules/handlers/streamHandler');
const execution = require(box + '/modules/requestExecutionContext');
const ToolCallParser = require(box + '/modules/vcpLoop/toolCallParser');

for (const streaming of [false, true]) {
    for (const showReasoning of [false, true]) {
        test(`${streaming ? 'SSE' : 'JSON'} records exactly the native display text before stop (reasoning display ${showReasoning})`, async t => {
            const proof = [];
            const wire = [];
            t.mock.method(execution, 'finalReplyPublisher', () => record => proof.push(record));
            const options = {
                originalBody: { requestId: 'final-output', model: 'synthetic', messages: [] },
                ToolCallParser, abortController: new AbortController(), apiRetries: 1,
                reasoningToContentEnabled: showReasoning, reasoningToContentModels: ['synthetic'],
            };
            const text = 'Formal reply.', explanation = 'Synthetic display detail';
            const expected = showReasoning ? `<think>\n${explanation}\n</think>\n${text}` : text;
            const checkProof = () => assert.deepEqual(proof, [{ content: expected, finishReason: 'stop' }]);
            if (streaming) {
                const packet = (delta, finish_reason = null) => 'data: ' + JSON.stringify({ choices: [{ delta, finish_reason }] }) + '\n\n';
                const body = Readable.from([
                    packet({ reasoning_content: explanation }), packet({ content: text }), packet({}, 'stop'), 'data: [DONE]\n\n',
                ].map(part => Buffer.from(part)));
                const res = {
                    write(part) { if (part.includes('"finish_reason":"stop"')) checkProof(); wire.push(part); },
                    end(part) { checkProof(); this.writableEnded = true; wire.push(part); },
                };
                const outcome = await new StreamHandler(options).handle({}, res, { ok: true, body });
                assert.ok(outcome.completed);
                const frames = wire.join('').split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
                assert.equal(frames.map(frame => frame.choices[0].delta.content || '').join(''), expected);
                assert.equal(frames.filter(frame => frame.choices[0].finish_reason === 'stop').length, 1);
            } else {
                const provider = Response.json({ choices: [{ message: { role: 'assistant', content: text, reasoning_content: explanation }, finish_reason: 'stop' }] });
                const res = { send(bytes) { checkProof(); this.writableEnded = true; wire.push(JSON.parse(bytes)); } };
                const outcome = await new NonStreamHandler(options).handle({}, res, provider);
                assert.ok(outcome.completed);
                assert.equal(wire[0].choices[0].message.content, expected);
            }
            checkProof();
        });
    }
}

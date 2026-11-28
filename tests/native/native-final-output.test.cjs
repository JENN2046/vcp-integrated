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

test('Core delta frames separate provider text, reasoning, and display markup', async t => {
    const { CoreTurnSink } = require(box + '/core/turnSink');
    const { signal } = new AbortController();
    const events = [];
    const sink = new CoreTurnSink({ signal, observe: (type, value) => events.push({ type, ...value }) });
    const frames = [];
    const onDelta = sink.onDelta.bind(sink);
    t.mock.method(sink, 'onDelta', frame => { frames.push(frame); onDelta(frame); });
    const stream = new StreamHandler({
        originalBody: { requestId: 'delta-contract', model: 'synthetic', messages: [] },
        ToolCallParser, abortController: { signal }, reasoningToContentEnabled: true, reasoningToContentModels: ['synthetic'],
    });
    const packet = delta => 'data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n';
    const body = Readable.from([
        packet({ reasoning_content: 'First thought.', content: 'Reply.' }),
        packet({ reasoning_content: 'Last thought.' }),
        'data: [DONE]\n\n',
    ].map(part => Buffer.from(part)));
    const outcome = await stream.execute(sink, { ok: true, body });
    const emitted = events.filter(event => event.type === 'delta');
    assert.ok(outcome.completed);
    assert.equal(outcome.content, 'Reply.');
    assert.equal(frames.map(frame => frame.textDelta).join(''), 'Reply.');
    assert.equal(frames.map(frame => frame.reasoningDelta).join(''), 'First thought.Last thought.');
    assert.equal(emitted.map(event => event.textDelta).join(''), 'Reply.');
    assert.equal(emitted.map(event => event.displayDelta).join(''), '<think>\nFirst thought.\n</think>\nReply.<think>\nLast thought.\n</think>\n');
    assert.ok(emitted.every(event => event.text === event.displayDelta));
    const closing = frames.find(frame => frame.displayDelta === '\n</think>\n');
    assert.deepEqual([closing.textDelta, closing.reasoningDelta], ['', '']);
});


test('Core observes a pure reasoning delta without changing the display text', () => {
    const { CoreTurnSink } = require(box + '/core/turnSink');
    const events = [];
    const sink = new CoreTurnSink({ signal: new AbortController().signal, observe: (_type, value) => events.push(value) });
    sink.onDelta({ reasoningDelta: 'Synthetic reasoning' });
    assert.deepEqual(events, [{ text: '', textDelta: '', displayDelta: '', reasoningDelta: 'Synthetic reasoning' }]);
});

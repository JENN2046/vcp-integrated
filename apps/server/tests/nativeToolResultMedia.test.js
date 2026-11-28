'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const StreamHandler = require('../modules/handlers/streamHandler');
const NonStreamHandler = require('../modules/handlers/nonStreamHandler');
const ToolCallParser = require('../modules/vcpLoop/toolCallParser');
const { projectToolBatchForUpstream } = require('../modules/toolResultBatch');

const call = id => ({ id, type: 'function', function: { name: 'demo', arguments: '{}' } });
const batch = (...ids) => ({ role: 'assistant', content: null, tool_calls: ids.map(call) });
const result = (id, content) => ({ role: 'tool', tool_call_id: id, content });
const image = (url, detail) => ({ type: 'image_url', image_url: { url, ...(detail ? { detail } : {}) } });

test('Chat projects Doubao-style images only after the whole native batch', () => {
    const png = image('data:image/png;base64,iVBORw0KGgo=');
    const remote = image('https://example.com/result.png', 'low');
    const messages = [
        batch('a', 'b'),
        result('a', [{ type: 'text', text: 'generated' }, png, remote]),
        result('b', '{"image_url":"https://example.com/link-only.png"}'),
        { role: 'user', content: 'another instruction' }
    ];
    const body = { model: 'vision', messages };
    const snapshot = structuredClone(body);
    const upstream = projectToolBatchForUpstream(body);

    assert.deepEqual(upstream.messages.map(message => message.role), ['assistant', 'tool', 'tool', 'user', 'user']);
    assert.deepEqual(upstream.messages.slice(1, 3).map(message => message.tool_call_id), ['a', 'b']);
    assert.match(upstream.messages[1].content, /^generated\n/);
    assert.equal(upstream.messages[2].content, messages[2].content);
    assert.deepEqual(upstream.messages[3].content.slice(1), [png, remote]);
    assert.match(upstream.messages[3].content[0].text, /"a"/);
    assert.doesNotMatch(JSON.stringify(upstream), /ROLE_DIVIDE|VCP_TOOL_PAYLOAD/);
    assert.deepEqual(body, snapshot);
    assert.deepEqual(projectToolBatchForUpstream(upstream), upstream);
});

test('unmatched or incomplete calls do not create synthetic user input', () => {
    for (const id of ['a', 'unknown']) {
        const messages = [batch('a', 'b'), result(id, [image('https://example.com/result.png')])];
        assert.deepEqual(projectToolBatchForUpstream({ messages }).messages, messages);
    }
});

test('an unsupported image scheme stays out of upstream media and does not erase text', () => {
    const body = { messages: [batch('a'), result('a', [
        { type: 'text', text: 'still here' },
        image('file:///example.png')
    ])] };
    const { messages } = projectToolBatchForUpstream(body);
    assert.equal(messages.length, 2);
    assert.match(messages[1].content, /^still here\n/);
    assert.doesNotMatch(messages[1].content, /file:/);
});

test('role divider leaves the native call and result envelopes opaque', () => {
    const divider = require('../modules/roleDivider');
    const literal = '<<<[ROLE_DIVIDE_USER]>>>literal<<<[END_ROLE_DIVIDE_USER]>>>';
    const messages = [
        { ...batch('a'), content: literal },
        result('a', [{ type: 'text', text: literal }, image('https://example.com/result.png')])
    ];
    const divided = divider.process(messages, {
        switches: { user: false, assistant: true, system: true },
        scanSwitches: { user: true, assistant: true, system: true, tool: true }
    });
    assert.deepEqual(divided, messages);
    assert.equal(projectToolBatchForUpstream({ messages: divided }).messages[2].role, 'user');
});

function providerResponse(stream, message, finishReason) {
    const choice = { index: 0, [stream ? 'delta' : 'message']: message, finish_reason: finishReason };
    const json = JSON.stringify({ choices: [choice] });
    return stream
        ? { ok: true, body: Readable.from(['data: ' + json + '\n\ndata: [DONE]\n\n']) }
        : { ok: true, arrayBuffer: async () => Buffer.from(json) };
}

for (const stream of [false, true]) {
    for (const mode of ['force-text', 'vision', 'MediaPlus']) {
        for (const archeryOnly of [false, true]) {
            test(`native FC media: stream=${stream}, ${mode}, archeryOnly=${archeryOnly}`, async () => {
                // The mixed batch collects normal receipts before Archery receipts,
                // even though the model requested the Archery call first.
                const ids = ['first', 'second'];
                const calls = ids.map((id, index) => ({
                    id, type: 'function', ...(stream && { index }),
                    function: { name: 'vcptools', arguments: JSON.stringify({
                        tool_name: 'FixtureImage', slot: id, ...(archeryOnly || index === 0 ? { archery: 'no_reply' } : {})
                    }) }
                }));
                const images = ids.map(id => image('https://example.test/' + id + '.png', 'high'));
                const visible = ids.map((id, i) => [{ type: 'text', text: 'visible-' + id }, images[i]]);
                const receipts = ids.map((id, i) => ({
                    success: true, recordId: 'record-' + id, raw: { result: 'raw-' + id },
                    content: [{ type: 'text', text: 'original-' + id }],
                    contentForAI: visible[i], approvalFeedbackContent: visible[i]
                }));
                const originals = structuredClone(receipts);
                const dispatched = [];
                const translated = [];
                const requests = [];
                const client = [];
                function execute(call) {
                    dispatched.push(call.args.slot);
                    return receipts[ids.indexOf(call.args.slot)];
                }
                const config = { fixture: true };
                const ctx = {
                    originalBody: { model: 'fixture', messages: [] }, abortController: new AbortController(),
                    ownsNativeVcpTools: true, ToolCallParser, SHOW_VCP_OUTPUT: true, isToolResultError: () => false,
                    shouldProcessMedia: mode === 'MediaPlus', shouldProcessMediaPlus: mode === 'MediaPlus',
                    isTextOnlyForceTranslateModel: mode === 'force-text', requestPreprocessorConfig: config,
                    pluginManager: {
                        messagePreprocessors: new Map([['ImageProcessor', {}]]),
                        async executeMessagePreprocessor(name, [message], suppliedConfig) {
                            assert.equal(name, 'ImageProcessor');
                            assert.equal(suppliedConfig, config);
                            const part = message.content.find(part => part.type === 'image_url');
                            translated.push(part.image_url.url);
                            part.type = 'text';
                            part.text = 'description-' + part.image_url.url.split('/').pop();
                            delete part.image_url;
                            return [message];
                        }
                    },
                    toolExecutor: { execute, executeAll: async calls => calls.map(execute) },
                    async fetchWithRetry(_url, options) {
                        requests.push(JSON.parse(options.body));
                        return providerResponse(stream, { role: 'assistant', content: 'finished' }, 'stop');
                    }
                };
                const res = { write: chunk => client.push(String(chunk)), end(chunk) {
                    if (chunk) this.write(chunk);
                    this.writableEnded = true;
                }, send(chunk) { this.end(chunk); } };
                const Handler = stream ? StreamHandler : NonStreamHandler;
                await new Handler(ctx).handle({}, res, providerResponse(stream, { role: 'assistant', content: null, tool_calls: calls }, 'tool_calls'));

                assert.deepEqual(dispatched.sort(), ids);
                assert.deepEqual(receipts, originals);
                assert.equal(requests.length, 1);
                assert.deepEqual(translated.sort(), mode === 'vision' ? [] : images.map(part => part.image_url.url));
                const messages = requests[0].messages;
                const tools = messages.filter(message => message.role === 'tool');
                assert.deepEqual(tools.map(message => message.tool_call_id), ids);
                for (const [i, message] of tools.entries()) {
                    assert.ok(message.content.includes('visible-' + ids[i]));
                    assert.ok(!message.content.includes(ids[1-i]));
                    assert.equal(message.content.includes('description-' + ids[i] + '.png'), mode !== 'vision');
                }
                const media = messages.filter(message => message.role === 'user');
                if (mode === 'force-text') assert.deepEqual(media, []);
                else {
                    assert.equal(media.length, 1);
                    assert.deepEqual(media[0].content.filter(part => part.type === 'image_url'), images);
                    assert.deepEqual(media[0].content.filter(part => part.type === 'text').map(part => part.text),
                        ids.map(id => 'Tool result "' + id + '" — image attachment(s):'));
                }
                assert.equal(client.join('').includes('raw-second'), !archeryOnly);
                assert.doesNotMatch(client.join(''), /raw-first|description-/);
                assert.match(client.join(''), /finished/);
            });
        }
    }
}

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../modules/ipc/groupChatHandlers.js'), 'utf8');
const start = source.indexOf("    ipcMain.handle('send-group-chat-message'");
const end = source.indexOf("    ipcMain.handle('inviteAgentToSpeak'", start);
const prelude = source.slice(source.indexOf('    const coreGroup = '), source.indexOf("    ipcMain.handle('get-group-chat-history'"));
assert.ok(start > 0 && end > start);

function fixture({ core = true, admission = true, admissionError } = {}) {
    const calls = { core: [], local: [] };
    const sender = {};
    let handler;
    const historyMutationQueue = { coreClient: core ? {
        owns: descriptor => descriptor.itemId === 'owned',
        async send(...input) {
            calls.core.push(input);
            if (admissionError) throw admissionError;
            return { success: true, core: true };
        }
    } : null };
    const context = {
        ipcMain: { handle: (name, callback) => {
            assert.equal(name, 'send-group-chat-message');
            handler = callback;
        } },
        mainWindow: { webContents: sender },
        historyMutationQueue,
        topicAdmission: admission ? { submit: async value => {
            calls.local.push(value);
            return { success: true, requestId: value.requestId };
        } } : null,
    };
    vm.runInNewContext(prelude + source.slice(start, end), context);
    return { calls, handler, sender };
}

const message = () => ({
    id: 'same-request-id',
    role: 'user',
    name: 'Synthetic',
    content: { text: 'native context' },
    originalUserText: 'user text',
    attachments: [],
    timestamp: 1,
});

function assertNoAdmission(calls) {
    assert.equal(calls.core.length, 0);
    assert.equal(calls.local.length, 0);
}

test('a Core group send retains identity and enters only Core admission', async () => {
    const f = fixture();
    const input = message();
    const receipt = await f.handler({ sender: f.sender }, 'owned', 'topic', input);
    assert.deepEqual({ ...receipt }, { success: true, core: true });
    assert.equal(f.calls.local.length, 0);
    assert.equal(f.calls.core.length, 1);
    const [scope, admittedMessage] = f.calls.core[0];
    assert.deepEqual({ ...scope }, { itemType: 'group', itemId: 'owned', topicId: 'topic' });
    assert.equal(admittedMessage.id, input.id);
    assert.equal(admittedMessage.content, input.originalUserText);
});

test('nonshared Group preserves original local TopicAdmission and original user text', async () => {
    const f = fixture({ core: false });
    const input = message();
    const receipt = await f.handler({ sender: f.sender }, 'owned', 'topic', input);

    assert.deepEqual(receipt, { success: true, requestId: input.id });
    assert.equal(f.calls.core.length, 0);
    assert.equal(f.calls.local.length, 1);
    const submitted = f.calls.local[0];
    assert.equal(submitted.requestId, input.id);
    assert.equal(submitted.message.id, input.id);
    assert.equal(submitted.message.content, input.originalUserText);
    assert.equal(submitted.message._metadata.groupRequestText, input.content.text);
});

test('a foreign renderer cannot invoke either admission owner', async () => {
    const f = fixture();
    const receipt = await f.handler({ sender: {} }, 'owned', 'topic', message());

    assert.equal(receipt.code, 'FORBIDDEN');
    assertNoAdmission(f.calls);
});

test('malformed user message is refused before selecting an admission owner', async () => {
    const f = fixture();
    const receipt = await f.handler({ sender: f.sender }, 'owned', 'topic', { ...message(), role: 'assistant' });

    assert.equal(receipt.success, false);
    assertNoAdmission(f.calls);

    // The unavailable admission service also blocks valid, authorized requests.
    for (const core of [true, false]) {
        const f = fixture({ core, admission: false });
        const receipt = await f.handler({ sender: f.sender }, 'owned', 'topic', message());

        assert.deepEqual({ ...receipt }, { success: false, error: '中央消息入场服务不可用' });
        assertNoAdmission(f.calls);
    }
});

test('Core refusal preserves its original reason without submitting a local Work', async () => {
    const f = fixture({ admissionError: Object.assign(Error('Topic was removed'), { code: 'CORE_TOPIC_NOT_FOUND' }) });
    const input = message();
    const receipt = await f.handler({ sender: f.sender }, 'owned', 'topic', input);
    assert.equal(receipt.success, false);
    assert.equal(receipt.error, 'Topic was removed');
    assert.equal(f.calls.core.length, 1);
    assert.equal(f.calls.core[0][1].id, input.id);
    assert.equal(f.calls.local.length, 0);
});

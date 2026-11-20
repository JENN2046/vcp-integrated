const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const sharedGroup = require('../modules/services/nativeSync/sharedGroup');

const source = fs.readFileSync(path.join(__dirname, '../modules/ipc/groupChatHandlers.js'), 'utf8');
const start = source.indexOf("    ipcMain.handle('send-group-chat-message'");
const end = source.indexOf("    ipcMain.handle('inviteAgentToSpeak'", start);
assert.ok(start > 0 && end > start);

function fixture({ shared = true, admission = true, admissionError, runnerError, runnerResult } = {}) {
    const calls = { prepare: [], runner: [], complete: [], local: [] };
    const sender = {};
    const emit = () => {};
    const lookup = () => {};
    const record = {
        accepted: { id: 'synthetic-work', turn: { plan: [] } },
        config: { owner: { config: {} }, rules: [] },
    };
    const execution = {
        runtime: { nativeObject: (kind, id) => kind === 'group' && id === 'owned' ? { id } : null },
        liveGroups: new Set(),
        mapping: () => ({}),
        prepare: async (...args) => {
            calls.prepare.push(args);
            if (admissionError) throw admissionError;
            return { config: {}, members: [], record };
        },
        groupDone: async value => { calls.complete.push(value); },
    };
    const historyMutationQueue = { syncPolicy: shared ? { sharedExecution: execution } : null };
    const handleGroupChatMessage = sharedGroup.wrap(historyMutationQueue, 'message', async (...args) => {
        calls.runner.push(args);
        if (runnerError) throw runnerError;
        return runnerResult;
    });
    let handler;
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
        groupChat: { handleGroupChatMessage },
        createStreamSender: () => emit,
        getAgentConfigById: lookup,
    };
    vm.runInNewContext(source.slice(start, end), context);
    return { calls, emit, execution, handler, record, sender };
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
    assert.equal(calls.prepare.length, 0);
    assert.equal(calls.runner.length, 0);
    assert.equal(calls.local.length, 0);
}

test('shared native Group sender retains message identity and enters only existing SharedGroup admission', async () => {
    const f = fixture();
    const input = message();
    const receipt = await f.handler({ sender: f.sender }, 'owned', 'topic', input);

    assert.deepEqual({ ...receipt }, { success: true });
    assert.equal(f.calls.local.length, 0);
    assert.equal(f.calls.prepare.length, 1);
    const [scope, admittedMessage] = f.calls.prepare[0];
    assert.deepEqual(scope, { itemType: 'group', itemId: 'owned', topicId: 'topic' });
    assert.equal(admittedMessage.id, input.id);
    assert.equal(admittedMessage.content, input.originalUserText);
    assert.equal(f.calls.runner.length, 1);
    assert.equal(f.calls.runner[0][2], input);
    assert.equal(f.calls.runner[0][3], f.emit);
    assert.deepEqual(f.calls.complete, [f.record]);
    assert.equal(f.execution.liveGroups.size, 0);
});

test('nonshared Group preserves original local TopicAdmission and original user text', async () => {
    const f = fixture({ shared: false });
    const input = message();
    const receipt = await f.handler({ sender: f.sender }, 'owned', 'topic', input);

    assert.deepEqual(receipt, { success: true, requestId: input.id });
    assert.equal(f.calls.prepare.length, 0);
    assert.equal(f.calls.runner.length, 0);
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
    for (const shared of [true, false]) {
        const f = fixture({ shared, admission: false });
        const receipt = await f.handler({ sender: f.sender }, 'owned', 'topic', message());

        assert.deepEqual({ ...receipt }, { success: false, error: '中央消息入场服务不可用' });
        assertNoAdmission(f.calls);
    }
});

test('shared refusal never falls through into local admission or retries the Group kernel', async () => {
    const f = fixture({ admissionError: new Error('SHARED_LOCAL_REMOVED') });
    const input = message();
    const receipt = await f.handler({ sender: f.sender }, 'owned', 'topic', input);

    assert.deepEqual({ ...receipt }, { success: false, error: 'SHARED_LOCAL_REMOVED' });
    assert.equal(f.calls.prepare.length, 1);
    assert.equal(f.calls.prepare[0][1].id, input.id);
    assert.equal(f.calls.runner.length, 0);
    assert.equal(f.calls.local.length, 0);
    assert.equal(f.calls.complete.length, 0);

    const failedRunner = fixture({ runnerError: new Error('SYNTHETIC_GROUP_RUNNER_FAILURE') });
    const failedReceipt = await failedRunner.handler({ sender: failedRunner.sender }, 'owned', 'topic', input);
    assert.deepEqual({ ...failedReceipt }, { success: false, error: 'SYNTHETIC_GROUP_RUNNER_FAILURE' });
    assert.equal(failedRunner.calls.prepare.length, 1);
    assert.equal(failedRunner.calls.runner.length, 1);
    assert.equal(failedRunner.calls.local.length, 0);
    assert.equal(failedRunner.calls.complete.length, 0);
    assert.equal(failedRunner.execution.liveGroups.size, 0);
});

test('completed native void result is a successful IPC receipt for the existing renderer', async () => {
    for (const runnerResult of [undefined, { internalResult: true }]) {
        const f = fixture({ runnerResult });
        const receipt = await f.handler({ sender: f.sender }, 'owned', 'topic', message());

        assert.deepEqual({ ...receipt }, { success: true });
        assert.equal(f.calls.runner.length, 1);
        assert.equal(f.calls.local.length, 0);
        assert.deepEqual(f.calls.complete, [f.record]);
    }
});

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { SharedExecution } = require('../modules/services/nativeSync/sharedExecution');
const { SharedRuntime } = require('../modules/services/nativeSync/sharedRuntime');

const descriptor = { itemType: 'agent', itemId: 'owner', topicId: 'topic' };
const attachment = { type: 'image/gif', name: 'test.gif', size: 24, src: '/synthetic/test.gif' };
const message = { id: 'message-1', role: 'user', content: 'Describe the image', attachments: [attachment] };
const fail = (code, status) => Object.assign(new Error(code), { code, status });

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shared-image-input-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    let model = 'text-model';
    let admissionError = null;
    let uploadError = null;
    let projected;
    const attempts = [];
    const runtime = Object.assign(Object.create(SharedRuntime.prototype), {
        root, dir: root, ready: true, assertSharedAccess() {},
        connection: { sharedSpaceId: 'space-1' },
        binding: () => 'test',
        capabilities: { features: ['shared-context-v1'] },
        state: { objects: { topic: { parentId: 'owner' }, owner: { id: 'owner' } } },
        configs: { state: { drafts: {} } },
        isLocalVisible: () => true,
        matching: { assert() {} },
        executionMapping: async () => ({ sharedId: 'topic' }),
        refreshForExecution: async () => ({ model, hash: model, head: 0 }),
        replica: { adapter: { canonical: value => value }, queue: { read: async () => [projected] } },
        attachments: {
            async uploadMessage(_descriptor, input) {
                if (uploadError) throw uploadError;
                return input;
            },
            async restoreRemote() {},
        },
        async syncExecutionTopic() {},
        async send(route, { body } = {}) {
            if (route.endsWith('/admit')) {
                attempts.push(body);
                if (admissionError) throw admissionError;
                if (model === 'text-model') throw fail('MODEL_IMAGE_UNSUPPORTED', 409);
                projected = body.message;
                return { id: 'receipt-1', configHash: model, userSeq: 1 };
            }
            assert.match(route, /request-config/);
            return {
                config: {
                    hash: model, owner: { kind: 'agent', config: { model } }, rules: [],
                },
            };
        },
    });
    async function loadExecution() {
        const execution = await SharedExecution.open(runtime);
        execution.mapping = () => ({ sharedId: 'topic', shared: descriptor });
        execution.waitProjection = async () => {};
        runtime.execution = execution;
    }
    await loadExecution();
    return {
        runtime, attempts, loadExecution,
        selectImageModel: () => { model = 'image-model'; },
        failAdmission: error => { admissionError = error; },
        failUpload: error => { uploadError = error; },
    };
}

test('confirmed image model rejection preserves pending input across restart and allows explicit retry with current config', async t => {
    const { runtime, attempts, loadExecution, selectImageModel } = await fixture(t);
    await assert.rejects(runtime.prepareSharedSend({ descriptor, message }), { code: 'MODEL_IMAGE_UNSUPPORTED' });
    await loadExecution();
    const [pending] = runtime.execution.localInputs(descriptor);
    assert.equal(pending.inputId, message.id);
    assert.equal(pending.accepted, false);
    assert.equal(pending.submissionUnconfirmed, false);
    assert.equal(pending.errorCode, 'MODEL_IMAGE_UNSUPPORTED');
    assert.deepEqual(pending.attachments, [{ name: attachment.name, size: attachment.size, type: attachment.type }]);
    selectImageModel();
    const result = await runtime.retrySharedInput({ descriptor, inputId: message.id });
    assert.equal(result.success, true);
    assert.equal(result.userMessage.id, message.id);
    assert.deepEqual(attempts.map(({ requestId, configHash }) => [requestId, configHash]), [
        [message.id, 'text-model'], [message.id, 'image-model'],
    ]);
});

test('explicitly pinned model remains bound after image model rejection', async t => {
    const { runtime, attempts, selectImageModel } = await fixture(t);
    const modelSaveRef = { opId: 'model-op', model: 'text-model' };
    await assert.rejects(runtime.prepareSharedSend({ descriptor, message, modelSaveRef }), { code: 'MODEL_IMAGE_UNSUPPORTED' });
    assert.deepEqual(runtime.execution.localInputs(descriptor)[0].modelSaveRef, modelSaveRef);
    selectImageModel();
    await assert.rejects(runtime.retrySharedInput({ descriptor, inputId: message.id }), { code: 'MODEL_SAVE_NOT_CURRENT' });
    assert.equal(attempts.length, 1);
});

test('failed format upload is immediately identifiable before admission', async t => {
    const { runtime, attempts, loadExecution, failUpload } = await fixture(t);
    failUpload(fail('ATTACHMENT_TYPE_REJECTED', 415));
    await assert.rejects(runtime.prepareSharedSend({ descriptor, message }), { code: 'ATTACHMENT_TYPE_REJECTED' });
    await loadExecution();
    const [pending] = runtime.execution.localInputs(descriptor);
    assert.equal(pending.errorCode, 'ATTACHMENT_TYPE_REJECTED');
    assert.equal(pending.submissionUnconfirmed, false);
    assert.equal(attempts.length, 0);
});

test('lost admission response remains unconfirmed', async t => {
    const { runtime, failAdmission } = await fixture(t);
    failAdmission(fail('NETWORK_UNAVAILABLE'));
    await assert.rejects(runtime.prepareSharedSend({ descriptor, message }), { code: 'NETWORK_UNAVAILABLE' });
    assert.equal(runtime.execution.localInputs(descriptor)[0].submissionUnconfirmed, true);
});

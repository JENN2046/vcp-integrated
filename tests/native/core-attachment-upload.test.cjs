'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { coreFixture, host, localProvider } = require('./fixtures/coreSingleHarness.cjs');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('GIF originals require valid image bytes, filename and MIME at upload completion', async t => {
    const provider = await localProvider(t);
    const f = await coreFixture(t, host(provider).chat);
    const { key: topicKey } = await f.define({});
    const { core } = f;
    const actor = core.local.actor;
    core.topic(actor, f.workspace, topicKey, 'execute');
    const store = core.attachments;
    const principal = actor.principal;
    const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');

    async function upload(bytes, name, type, requestId) {
        const { uploadId } = store.begin(principal, topicKey, {
            requestId, name, type, size: bytes.length, expectedHash: hash(bytes),
        });
        store.chunk(principal, topicKey, uploadId, { offset: 0, data: bytes.toString('base64') });
        return store.finish(principal, topicKey, uploadId);
    }

    for (const version of ['GIF87a', 'GIF89a']) {
        const bytes = Buffer.from(pixel);
        bytes.write(version, 0, 'ascii');
        const result = await upload(bytes, 'pixel.GIF', 'image/gif', 'version_' + version);
        assert.equal(result.type, 'image/gif');
        assert.deepEqual(store.readBlob(result.hash), bytes);
    }
    for (const [bytes, name, type, id] of [
        [pixel, 'pixel.png', 'image/gif', 'bad_extension'],
        [pixel, 'pixel.gif', 'image/jpeg', 'wrong_mime'],
        [pixel.subarray(0, 6), 'truncated.gif', 'image/gif', 'header_only'],
        [Buffer.from('plain text'), 'fake.gif', 'image/gif', 'fake_image'],
    ]) {
        await assert.rejects(upload(bytes, name, type, id), { code: 'ATTACHMENT_TYPE_REJECTED', status: 415 });
    }
});

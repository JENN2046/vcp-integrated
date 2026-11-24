'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const test = require('node:test');
const { BOX, fixture, wait } = require('./fixtures/sharedSingleHarness.cjs');
const sharp = require(BOX + '/node_modules/sharp');

test('shared mobile image and follow-up use the original upload after a lost admission receipt', async t => {
    const f = await fixture(t, { attachments: true, imageModels: [] });
    const sender = await f.phone();
    const reader = await f.phone({ permissions: ['read'] });
    const other = await f.phone();
    const route = '/conversations/' + f.topic.id;
    const uploads = route + '/attachments/uploads';
    const submit = route + '/messages';
    const bytes = await sharp({ create: { width: 3, height: 2, channels: 3, background: '#3366cc' } }).png().toBuffer();
    const expectedHash = createHash('sha256').update(bytes).digest('hex');
    const input = { requestId: 'fixture-png-upload', name: 'square.png', type: 'image/png', size: bytes.length, expectedHash };

    assert.equal((await reader.call(uploads, input, 403)).error.code, 'SHARED_PERMISSION_REQUIRED');
    const { uploadId } = await sender.call(uploads, input, 201);
    await sender.call(uploads + '/' + uploadId + '/chunks', { offset: 0, data: bytes.toString('base64') });
    assert.equal((await sender.call(uploads + '/' + uploadId + '/finish', {})).hash, expectedHash);
    const message = { requestId: 'shared-image-submit', text: 'Which color?', attachments: [uploadId] };
    assert.equal((await other.call(submit, message, 404)).error.code, 'UPLOAD_NOT_FOUND');
    assert.equal(f.store.metrics().journalRows, 0);

    f.control.dropMobileResponse = 1;
    await assert.rejects(sender.call(submit, message, 202));
    const pending = f.store.db.prepare('SELECT id, state FROM mobile_executions').get();
    assert.equal(pending.state, 'queued');
    assert.equal(f.calls(), 0);
    await f.reopenBackend();
    assert.equal((await sender.call(submit, message, 202)).id, pending.id);
    const requests = [];
    f.control.modelResponse = body => {
        requests.push(body);
        return { choices: [{ message: { content: 'Blue.' }, finish_reason: 'stop' }] };
    };
    const engine = f.portal.engine;
    engine.startDelayMs = 0;
    engine.db.prepare('UPDATE mobile_executions SET not_before=0 WHERE id=?').run(pending.id);
    engine.setEndpoint({ url: f.url + '/v1/chat/completions', key: 'synthetic-only' });
    const completed = id => wait(() => {
        const row = engine.get(id);
        if (row.error_code) throw Error(row.error_code);
        return row.state === 'completed';
    }, 'shared image reply');
    await completed(pending.id);
    const follow = { requestId: 'shared-image-followup', text: 'What color did you see?' };
    const second = await sender.call(submit, follow, 202);
    await completed(second.id);
    assert.equal((await sender.call(submit, follow, 202)).id, second.id);
    assert.equal((await sender.call(submit, message, 202)).id, pending.id);
    assert.equal(f.calls(), 2);
    assert.equal(f.store.metrics().journalRows, 4);
    const images = body => body.messages.filter(m => m.role === 'user').flatMap(m =>
        Array.isArray(m.content) ? m.content.filter(p => p.type === 'image_url').map(p => p.image_url.url) : []);
    assert.equal(images(requests[0]).length, 1);
    assert.match(images(requests[0])[0], /^data:image\/jpeg;base64,/);
    assert.deepEqual(images(requests[1]), images(requests[0]));
});

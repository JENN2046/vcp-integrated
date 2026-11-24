'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const test = require('node:test');

const server = process.env.VCP_TEST_SERVER || path.resolve(__dirname, '../../apps/server');
const requireServer = createRequire(path.join(server, 'package.json'));
const sharp = requireServer('sharp');
const { attachmentImages } = requireServer('@vcp/core-rules/attachment-images');
const { AttachmentStore, MAX_FILE, hash } = requireServer('./Plugin/NativeSync/mobile/attachments');

test('native attachment encoding shrinks oversized images and does not enlarge thumbnails', async () => {
    for (const [width, height, expected] of [[960, 480, [800, 400]], [4, 2, [4, 2]]]) {
        const png = await sharp({ create: { width, height, channels: 3, background: '#3366cc' } }).png().toBuffer();
        const { frames, isGif } = await attachmentImages(sharp, png);
        assert.equal(isGif, false);
        assert.equal(frames.length, 1);
        const encoded = await sharp(frames[0]).metadata();
        assert.equal(encoded.format, 'jpeg');
        assert.deepEqual([encoded.width, encoded.height], expected);
    }
});

test('native GIF encoding samples at 500 ms and stops at the worker frame or byte budget', async () => {
    const frameSize = 8 * 8 * 3;
    const raw = Buffer.concat(Array.from({ length: 7 }, (_, index) => Buffer.alloc(frameSize, index * 35)));
    const gif = await sharp(raw, { raw: { width: 8, height: 56, pageHeight: 8, channels: 3 } })
        .gif({ delay: Array(7).fill(100) }).toBuffer();
    const { frames, isGif } = await attachmentImages(sharp, gif, { gif: true });
    assert.equal(isGif, true);
    assert.equal(frames.length, 2);
    for (const [index, brightness] of [0, 175].entries()) {
        const part = sharp(frames[index]);
        assert.equal((await part.metadata()).format, 'jpeg');
        assert.ok(Math.abs((await part.raw().toBuffer())[0] - brightness) < 5);
    }

    const decodedPages = [];
    const countDecodes = (bytes, options) => {
        if (options.page !== undefined) decodedPages.push(options.page);
        return sharp(bytes, options);
    };
    const exhausted = { code: 'ATTACHMENT_REQUEST_BUDGET', status: 413 };
    await assert.rejects(attachmentImages(countDecodes, gif, { gif: true, maxFrames: 1 }), exhausted);
    assert.deepEqual(decodedPages.splice(0), [0]);
    const outputBytes = frames[0].length + frames[1].length;
    await assert.rejects(attachmentImages(countDecodes, gif, { gif: true, maxOutputBytes: outputBytes - 1 }), exhausted);
    assert.deepEqual(decodedPages, [0, 5]);
});

test('shared worker separately budgets the JPEG and requires the Journal-selected original hash', async () => {
    const bytes = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#3366cc' } }).png().toBuffer();
    const digest = hash(bytes);
    const blob = { hash: digest, size: bytes.length, type: 'image/png' };
    let originalReads = 0;
    const storage = {
        locate() { return { blob }; },
        readBlob(selectedHash) {
            assert.equal(selectedHash, digest);
            originalReads++;
            return bytes;
        },
    };
    const message = { id: 'user-photo', content: 'Picture', attachments: [{ id: 'photo', hash: digest }] };
    const budget = { bytes: MAX_FILE - bytes.length };
    const build = (message, budget) => AttachmentStore.prototype.content.call(storage, 'topic', message, true, budget, { nativeImages: true });
    const parts = await build(message, budget);
    assert.equal(budget.bytes, MAX_FILE);
    assert.ok(budget.imageBytes > 0);
    assert.match(parts[1].image_url.url, /^data:image\/jpeg;base64,/);

    await assert.rejects(build({ ...message, attachments: [{ id: 'photo', hash: '0'.repeat(64) }] }),
        { code: 'ATTACHMENT_BLOB_MISSING' });
    assert.equal(originalReads, 1);
    await assert.rejects(build(message, { bytes: 0, imageBytes: MAX_FILE - 1 }), { code: 'ATTACHMENT_REQUEST_BUDGET' });
});

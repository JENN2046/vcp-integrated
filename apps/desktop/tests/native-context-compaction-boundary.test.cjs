'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runNativeSend } = require('./helpers/native-send-fixture.cjs');

async function run(handled, rejectNative) {
    const calls = [];
    const { returned } = await runNativeSend({ handled, ok: !rejectNative, code: 'SYNTHETIC_REFUSAL' }, {
        stopBefore: 'uiAttachments',
        settings: { enableContextCompaction: true },
        shouldCompactContext: () => { calls.push('capacity'); return true; },
        compactContext: async () => calls.push('compact'),
    });
    return { result: returned, calls };
}

test('native-owned send never compacts legacy history even when automatic compaction is enabled', async () => {
    assert.deepEqual(await run(true, false), { result: 'continue', calls: [] });
});

test('ordinary legacy send retains the author automatic compaction path', async () => {
    assert.deepEqual(await run(false, false), { result: 'continue', calls: ['capacity', 'compact'] });
});

test('native preflight rejection returns before any history compaction', async () => {
    assert.deepEqual(await run(true, true), {
        result: { handled: true, ok: false, code: 'SYNTHETIC_REFUSAL' }, calls: [],
    });
});

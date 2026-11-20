'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SharedRuntime } = require('../../apps/desktop/modules/services/nativeSync/sharedRuntime');

function completedBaseline(watermark, cursor = 0, queuedCursor = cursor) {
    const state = { cursor };
    const writes = [];
    const adapter = { state, async transaction(mutate) {
        state.cursor = queuedCursor;
        mutate(state);
        writes.push(state.cursor);
    } };
    const runtime = Object.assign(Object.create(SharedRuntime.prototype), {
        replica: {adapter},
        state: {baselines: {topic: {complete: true, remote: {watermark}}}},
        isLocalVisible: () => true, mappings: () => [{sharedId:'topic'}],
    });
    return {runtime, writes, state};
}

test('empty completed baselines never rewrite an already durable zero cursor', async () => {
    const {runtime,writes} = completedBaseline(0);
    await runtime.backfill();
    await runtime.backfill();
    assert.deepEqual(writes, []);
});

test('backfill initializes the minimum watermark without rewinding newer progress', async () => {
    const fresh = completedBaseline(3);
    await fresh.runtime.backfill();
    await fresh.runtime.backfill();
    assert.deepEqual(fresh.writes, [3]);
    const advanced = completedBaseline(3, 0, 7);
    await advanced.runtime.backfill();
    assert.equal(advanced.state.cursor, 7);
});

'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');

async function fixture() {
    const { createVoiceDictation } = await import('../../apps/mobile/src/voiceDictation.js');
    let scope = 'one', recognizer, state;
    const settled = [], checkpoints = [];
    const controller = createVoiceDictation({
        getRecognition: () => class {
            constructor() { recognizer = this; }
            start() { this.onstart(); }
            stop() { this.stopped = true; }
            abort() { this.aborted = true; }
        },
        getScope: () => scope, update: value => { state = value; },
        checkpoint: (...args) => checkpoints.push(args),
        settle: value => { settled.push(value); }
    });
    controller.start();
    const result = (transcript, isFinal = false) => ({ results: [
        Object.assign([{ transcript }], { isFinal })
    ] });
    return { controller, recognizer, result, settled, checkpoints, state: () => state, change: () => { scope = 'two'; } };
}

test('network loss preserves the last visible text once and fences captured late callbacks', async () => {
    const f = await fixture();
    const late = f.recognizer.onresult, end = f.recognizer.onend;
    late(f.result('第一段'));
    late(f.result('最后可见'));
    late(f.result(''));
    f.recognizer.onerror({ error: 'network' });
    late(f.result('迟到的终稿', true));
    end();
    assert.deepEqual(f.checkpoints, [['one', '第一段', false], ['one', '最后可见', false]]);
    assert.deepEqual(f.settled, [{ scope: 'one', text: '最后可见', review: true }]);
    assert.match(f.state().message, /待校对/);
    assert.equal(f.recognizer.aborted, true);
});

test('stop without a final result preserves the preview and releases recognition', async () => {
    const f = await fixture();
    f.recognizer.onresult(f.result('等不到终稿'));
    f.controller.stop();
    assert.equal(f.recognizer.stopped, true);
    await delay(2600);
    assert.deepEqual(f.settled, [{ scope: 'one', text: '等不到终稿', review: true }]);
    assert.equal(f.recognizer.aborted, true);
});

test('normal end accepts only the final text and does not add a review flag', async () => {
    const f = await fixture();
    f.recognizer.onresult(f.result('临时'));
    f.recognizer.onresult(f.result('正常终稿', true));
    f.recognizer.onend();
    assert.deepEqual(f.checkpoints, [['one', '临时', false], ['one', '正常终稿', true]]);
    assert.deepEqual(f.settled, [{ scope: 'one', text: '正常终稿', review: false }]);
});

test('explicit cancel, identity change, and pairing rejection discard staged text', async () => {
    for (const exit of [
        f => f.controller.cancel(),
        f => { f.change(); f.controller.interrupt(); },
        f => f.recognizer.onerror({ error: 'pair-required' })
    ]) {
        const f = await fixture();
        f.recognizer.onresult(f.result('不要保存'));
        exit(f);
        assert.deepEqual(f.settled, [{ scope: 'one', text: '', review: false }]);
        assert.equal(f.recognizer.aborted, true);
    }
});

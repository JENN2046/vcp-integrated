'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { BOX } = require('./fixtures/paths.cjs');
const execution = require(BOX + '/modules/requestExecutionContext');

test('finishing one of two approvals keeps the native request waiting', async t => {
    const id = randomUUID();
    const controller = new AbortController();
    const events = [];
    const observe = event => { if (event.requestId === id) events.push(event.waiting); };
    execution.events.on('approval', observe);
    t.after(() => execution.events.off('approval', observe));
    await execution.run(id, controller.signal, async () => {
        const first = Promise.withResolvers(), second = Promise.withResolvers();
        const a = execution.waitForApproval(first.promise);
        const b = execution.waitForApproval(second.promise);
        first.resolve('approved');
        assert.equal(await a, 'approved');
        assert.deepEqual(events, [true]);
        controller.abort();
        await assert.rejects(b, { code: 'NATIVE_EXECUTION_CANCELLED' });
        assert.deepEqual(events, [true, false]);
    });
});

test('cancellation after recording intent fences the direct call before it runs', async t => {
    const id = randomUUID();
    const controller = new AbortController();
    const settlements = [];
    const hooks = {
        onToolDispatch() { controller.abort(); },
        onToolSettled(event) { settlements.push(event); },
        onTaskAccepted() {}, onTaskObserved() {},
    };
    t.after(execution.register(id, {}, hooks));
    await execution.run(id, controller.signal, async () => {
        await assert.rejects(execution.trackToolInvocation({ pluginName: 'Count' },
            dispatch => dispatch(() => assert.fail('cancelled tool executed'))), { code: 'NATIVE_EXECUTION_CANCELLED' });
        assert.equal(settlements.length, 1);
        assert.equal(settlements[0].outcome, 'error');
        assert.equal(settlements[0].errorCode, 'NATIVE_CANCELLED_BEFORE_EXECUTION');
    });
});

test('an unconfirmed settlement blocks subsequent tools and model turns in the same request', async t => {
    const id = randomUUID();
    let count = 0;
    const hooks = {
        onToolDispatch() {},
        onToolSettled() { throw Error('synthetic receipt unavailable'); },
        onTaskAccepted() {}, onTaskObserved() {},
    };
    t.after(execution.register(id, {}, hooks));
    await execution.run(id, new AbortController().signal, async () => {
        const call = () => execution.trackToolInvocation({ pluginName: 'Count' }, dispatch => dispatch(() => ++count));
        await assert.rejects(call(), { code: 'NATIVE_TOOL_SETTLEMENT_UNCONFIRMED' });
        await assert.rejects(call(), { code: 'NATIVE_TOOL_SETTLEMENT_UNCONFIRMED' });
        assert.throws(execution.assertDispatch, { code: 'NATIVE_TOOL_SETTLEMENT_UNCONFIRMED' });
        assert.equal(count, 1);
    });
    assert.doesNotThrow(execution.assertDispatch);
});

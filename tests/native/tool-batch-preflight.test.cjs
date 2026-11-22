'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const test = require('node:test');

const box = process.env.VCP_TEST_SERVER || path.resolve(__dirname, '../../apps/server');
const native = require(box + '/modules/requestExecutionContext');
const ToolExecutor = require(box + '/modules/vcpLoop/toolExecutor');
const first = { name: 'FirstCounter', args: {} };
const second = { name: 'SecondCounter', args: {} };

function fixture(t, { ineligible, unknown } = {}) {
    const events = [];
    const invocationEvent = kind => ({ batchOrdinal, batchSize, batchNames }) => {
        assert.equal(batchSize, 2);
        assert.deepEqual(batchNames, [first.name, second.name]);
        events.push([kind, batchOrdinal]);
    };
    const release = native.setSharedBoundary({
        enter: () => ({
            workId: 'test-work',
            safeTools: new Set([first.name, second.name]),
            fence() {},
            finish() {},
            checkpoint: { result: invocationEvent('receipt') },
            beginToolBatch(names) {
                assert.ok(Object.isFrozen(names));
                events.push(['batch', ...names]);
            },
            bridge: { onToolDispatch: invocationEvent('dispatch'), onToolSettled: invocationEvent('settled') },
        }),
    });
    t.after(release);
    const executor = new ToolExecutor({
        pluginManager: {
            assertControlledDirectTool(name) {
                if (name === ineligible) throw Object.assign(Error('Ineligible synthetic plugin'), { code: 'CONTROLLED_TOOL_FORBIDDEN' });
            },
        },
    });
    executor.execute = async ({ name }) => {
        try {
            return await native.trackToolInvocation({ pluginName: name }, dispatch => dispatch(() => {
                events.push(['effect', name]);
                if (name === unknown) throw Error('Synthetic receipt lost after action');
                return { content: name };
            }));
        } catch {
            // The regular ToolExecutor can turn plugin errors into displayable results.
            return { success: false };
        }
    };
    const run = async calls => {
        const req = Object.assign(new EventEmitter(), {
            path: '/v1/chat/completions',
            body: { requestId: 'test-request' },
        });
        const res = new EventEmitter();
        try {
            return await native.middleware(req, res, () => executor.executeAll(calls));
        } finally {
            res.emit('close');
        }
    };
    return { run, events };
}

const ordered = [
    ['batch', first.name, second.name],
    ['dispatch', 0], ['effect', first.name], ['receipt', 0], ['settled', 0],
    ['dispatch', 1], ['effect', second.name], ['receipt', 1], ['settled', 1],
];

test('the second controlled tool waits for the first native settlement', async t => {
    const { run, events } = fixture(t);
    assert.deepEqual(await run([first, second]), [{ content: first.name }, { content: second.name }]);
    assert.deepEqual(events, ordered);
});

for (const [tool, prefix] of [[first, 3], [second, 7]]) {
    test('an unknown ' + tool.name + ' receipt stops the native batch', async t => {
        const { run, events } = fixture(t, { unknown: tool.name });
        await assert.rejects(run([first, second]), { code: 'NATIVE_TOOL_RESULT_UNCONFIRMED' });
        assert.deepEqual(events, ordered.slice(0, prefix));
    });
}

test('the whole batch is rejected before either side effect if the second plugin is ineligible', async t => {
    const { run, events } = fixture(t, { ineligible: second.name });
    await assert.rejects(run([first, second]), { code: 'CONTROLLED_TOOL_FORBIDDEN' });
    assert.deepEqual(events, []);
});

test('duplicate, asynchronous and timed calls fail before controlled dispatch', async t => {
    const { run, events } = fixture(t);
    await assert.rejects(run([first, first]), { code: 'CONTROLLED_TOOL_CALL_LIMIT' });
    await assert.rejects(run([first, { ...second, archery: true }]), { code: 'CONTROLLED_TOOL_CALL_LIMIT' });
    await assert.rejects(run([first, { ...second, args: { timely_contact: 'synthetic' } }]), { code: 'CONTROLLED_TOOL_FORBIDDEN' });
    assert.deepEqual(events, []);
});

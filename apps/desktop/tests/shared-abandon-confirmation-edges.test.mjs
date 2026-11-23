import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { createNativeExecutionStatus } from '../modules/renderer/nativeExecutionStatus.js';

const topic = { ownerType: 'group', ownerId: 'test-group', topicId: 'test-topic' };
const work = {
    id: 'test-work',
    requestId: 'test-request',
    state: 'review_required',
    controlMode: 'group-member-handoff-v2',
    shared: true,
    canAbandon: true,
};

function fixture(t, abandonResponse = () => ({ success: true })) {
    const { window } = new JSDOM('<main><div id="chat"></div></main>', { pretendToBeVisual: true });
    const { document } = window;
    let selected = topic;
    let selectionChanged;
    let statusChanged;
    let value = {
        enabled: true,
        topic,
        connection: 'online',
        freshness: 'current',
        readOnly: false,
        observedAt: null,
        executions: [work],
    };
    const calls = [];
    const status = createNativeExecutionStatus({
        container: document.querySelector('#chat'),
        getSelection: () => ({ id: selected.ownerId, type: selected.ownerType }),
        getTopicId: () => selected.topicId,
        subscribeSelection: handler => { selectionChanged = handler; },
        ownerWindow: window,
        api: {
            getNativeExecutionStatus: async () => value,
            onNativeExecutionStatusChanged: handler => { statusChanged = handler; },
            abandonSharedSend: async payload => {
                calls.push(payload);
                return abandonResponse();
            },
        },
    });
    t.after(() => {
        status.dispose();
        window.close();
    });
    return {
        calls,
        ready: status.refresh,
        publish(update) {
            value = { ...value, ...update };
            statusChanged(value);
        },
        async select(newTopic) {
            selected = newTopic;
            value = { ...value, topic: newTopic };
            selectionChanged();
            await status.refresh();
        },
        controls() {
            const row = document.querySelector('[data-work-id]');
            return {
                checkbox: row?.querySelector('input[type="checkbox"]'),
                submit: Array.from(row?.querySelectorAll('button') || [])
                    .find(button => button.textContent === '确认放弃并解除暂停'),
            };
        },
        errorVisible(code) {
            const panel = document.querySelector('.native-sync-execution-status');
            return panel.textContent.includes(code);
        },
        async tick() {
            await new Promise(resolve => setImmediate(resolve));
        },
    };
}

function uncheckedControls(ui) {
    const { checkbox, submit } = ui.controls();
    assert.ok(checkbox && submit, 'eligible Work shows the checkbox and submit action');
    assert.equal(checkbox.disabled, false);
    assert.equal(checkbox.checked, false);
    assert.equal(submit.disabled, true);
    return { checkbox, submit };
}

function check(ui) {
    const { checkbox, submit } = uncheckedControls(ui);
    checkbox.click();
    assert.equal(checkbox.checked, true);
    assert.equal(submit.disabled, false);
    return submit;
}

const changes = [
    ['Work ID', ui => ui.publish({ executions: [{ ...work, id: 'replacement-work' }] })],
    ['request ID', ui => ui.publish({ executions: [{ ...work, requestId: 'replacement-request' }] })],
    ['topic', ui => ui.select({ ...topic, topicId: 'replacement-topic' })],
    ['read-only mode', ui => ui.publish({ readOnly: true }), ui => ui.publish({ readOnly: false })],
    ['permission revoked', ui => ui.publish({ executions: [{ ...work, canAbandon: false }] }),
        ui => ui.publish({ executions: [work] })],
    ['offline status', ui => ui.publish({ connection: 'offline', freshness: 'last-known' }),
        ui => ui.publish({ connection: 'online', freshness: 'current' })],
];

for (const [name, change, restore] of changes) {
    test(`abandon requires a fresh confirmation after ${name} changes`, async t => {
        const ui = fixture(t);
        await ui.ready();
        const previousSubmit = check(ui);

        await change(ui);
        previousSubmit.click();
        assert.deepEqual(ui.calls, [], 'an obsolete control cannot submit');

        if (restore) {
            const { checkbox, submit } = ui.controls();
            assert.ok(!checkbox || checkbox.disabled);
            assert.ok(!submit || submit.disabled);
            restore(ui);
        }
        uncheckedControls(ui);
        assert.deepEqual(ui.calls, [], 'eligibility never submits on its own');
    });
}

test('a same-Work refresh preserves the active confirmation controls', async t => {
    const ui = fixture(t);
    await ui.ready();
    const previousSubmit = check(ui);
    const previousCheckbox = ui.controls().checkbox;
    await ui.ready();

    const { checkbox, submit } = ui.controls();
    assert.equal(submit, previousSubmit);
    assert.equal(checkbox, previousCheckbox);
    assert.equal(submit.isConnected, true);
    assert.equal(checkbox.checked, true);
    assert.equal(submit.disabled, false);
    assert.deepEqual(ui.calls, []);
    submit.click();
    assert.equal(ui.calls.length, 1);
    await ui.tick();
});

const failures = [
    ['IPC failure result', ({ resolve }) => resolve({ success: false, error: 'TEST_ABANDON_FAILED' })],
    ['IPC rejection', ({ reject }) => reject(Error('TEST_ABANDON_FAILED'))],
];

for (const [name, fail] of failures) {
    test(`pending abandon blocks duplicates and retry requires rechecking after ${name}`, async t => {
        const responses = [];
        const ui = fixture(t, () => new Promise((resolve, reject) => responses.push({ resolve, reject })));
        await ui.ready();
        const submit = check(ui);

        submit.click();
        submit.click();
        ui.publish({ observedAt: 1, executions: [{ ...work }] });
        const pending = ui.controls();
        pending.checkbox?.click();
        assert.ok(!pending.submit || pending.submit.disabled);
        pending.submit?.click();
        submit.click();
        assert.deepEqual(ui.calls, [{
            descriptor: { itemType: topic.ownerType, itemId: topic.ownerId, topicId: topic.topicId },
            requestId: work.requestId,
            workId: work.id,
            confirmed: true,
        }]);

        fail(responses[0]);
        await ui.tick();
        assert.equal(ui.calls.length, 1, 'failure does not retry automatically');
        assert.ok(ui.errorVisible('TEST_ABANDON_FAILED'));
        check(ui).click();
        assert.equal(ui.calls.length, 2);
        assert.deepEqual(ui.calls[1], ui.calls[0]);
        responses[1].resolve({ success: true });
        await ui.tick();
    });
}

test('an eligible state transition cannot duplicate an in-flight abandon for the same Work', async t => {
    let respond;
    const ui = fixture(t, () => new Promise(resolve => { respond = resolve; }));
    await ui.ready();
    await ui.select({ ...topic, ownerType: 'agent', ownerId: 'test-agent' });
    const singleWork = { ...work, controlMode: undefined };
    ui.publish({ executions: [singleWork] });
    check(ui).click();

    ui.publish({ executions: [{ ...singleWork, state: 'queued' }] });
    const { checkbox, submit } = ui.controls();
    checkbox?.click();
    submit?.click();
    assert.equal(ui.calls.length, 1);
    assert.equal(ui.calls[0].requestId, work.requestId);
    assert.equal(Object.hasOwn(ui.calls[0], 'workId'), false);
    respond({ success: true });
    await ui.tick();
});

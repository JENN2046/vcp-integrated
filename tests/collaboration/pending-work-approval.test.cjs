'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { BOX } = require('./fixtures/paths.cjs');
const manager = require(BOX + '/Plugin');
test.after(() => manager.toolApprovalManager.shutdown());

// Simulate a deadline passing before Node has run its timer callback. Both
// reconnect and the answer path must consult the live item at decision time.
test('restoring approvals preserves their deadline and consumes each decision once', t => {
    t.mock.timers.enable({ apis: ['Date'], now: 1000 });
    const decisions = [];
    const add = (id, workId, isCurrent = () => true) => {
        const data = { requestId: id, workId, approvalTtlMs: 500 };
        manager.pendingApprovals.set(id, {
            expiresAt: 1500, owner: workId ? { workId, isCurrent } : null,
            request: workId ? { type: 'tool_approval_request', data } : undefined,
            resolve: decision => decisions.push({ id, decision }),
        });
        t.after(() => manager.pendingApprovals.delete(id));
    };
    add('pending', 'work-one');
    add('expired', 'work-two');
    add('fenced', 'work-three', () => false);
    add('local', null);
    t.mock.timers.setTime(1250);
    const restored = manager.pendingWorkApprovals().map(({ data }) => [data.requestId, data.workId, data.approvalTtlMs]);
    assert.deepEqual(restored, [['pending', 'work-one', 250], ['expired', 'work-two', 250]]);
    assert.equal(manager.handleApprovalResponse('fenced', true), false);
    assert.equal(manager.handleApprovalResponse('pending', true), true);
    assert.equal(manager.handleApprovalResponse('pending', true), false);
    t.mock.timers.setTime(1500);
    assert.deepEqual(manager.pendingWorkApprovals(), []);
    assert.equal(manager.handleApprovalResponse('expired', true), false);
    assert.deepEqual(decisions, [{ id: 'pending', decision: undefined }]);
});

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { setTimeout: delay } = require('node:timers/promises');
const fixture = require('../ordinary-tools/fixture.cjs');
const createOwnerPost = require('./owner.cjs');

const marker = 'ORDINARY_TOOL_APPROVE';
const waiting = '等待原生审批';
const approvalCard = '.notification-tool-approval';
const allowButton = 'button.vcp-btn-success';
const quoted = JSON.stringify;

module.exports = async ({ clients, out, result, service, cert, picture, click, evalJs, waitUntil, start, stop, profiles, sha }) => {
    assert.deepEqual(Object.keys(clients), ['A']);
    assert.deepEqual(Object.keys(profiles), ['A']);
    const db = new DatabaseSync(path.join(service.data, 'central.sqlite'), { readOnly: true });
    const audit = new DatabaseSync(path.join(out, 'runtime-box/config/tool-call-records.sqlite3'), { readOnly: true });
    const descriptor = service.descriptors.A.preSubmit;
    const { itemId, topicId } = descriptor;
    const historyPath = path.join(profiles.A, 'UserData', itemId, 'topics', topicId, 'history.json');
    const approval = client => evalJs(client, `[...document.querySelectorAll(${quoted(approvalCard)})].find(card =>
        card.innerText.includes(${quoted(fixture.name)}) && card.checkVisibility()
        && card.getBoundingClientRect().right <= innerWidth
        && Number(getComputedStyle(card).opacity) === 1
        && card.querySelector(${quoted(allowButton)})?.checkVisibility())?.dataset.toolApprovalRequestId ?? null`);
    const hasWorkLabel = (client, approvalId, workId) => evalJs(client, `[...document.querySelectorAll(${quoted(approvalCard)})].some(card =>
        card.dataset.toolApprovalRequestId === ${quoted(approvalId)} && card.checkVisibility()
        && card.innerText.includes(${quoted('共享 Work · ' + workId)}))`);
    const status = client => evalJs(client, '[...document.querySelectorAll(\'.native-sync-live-message [role="status"]\')].map(row => row.innerText)');
    const transcript = client => evalJs(client, 'document.querySelector("#chatMessages").innerText');
    const work = () => db.prepare('SELECT id,request_id,state,attempts FROM mobile_executions').all().map(row => ({ ...row }));
    const native = id => db.prepare('SELECT id,state FROM shared_native_requests WHERE admission_id=?').all(id);
    const invocations = id => db.prepare('SELECT invocation_id,native_request_id,plugin_name,record_id,state,error_code FROM mobile_native_invocations WHERE execution_id=?').all(id);
    const records = () => audit.prepare('SELECT id,tool_name,status,success FROM tool_call_records WHERE tool_name=?').all(fixture.name).map(row => ({ ...row }));
    const journal = () => db.prepare('SELECT msg_id,message_json FROM journal ORDER BY seq').all()
        .map(row => ({ id: row.msg_id, ...JSON.parse(row.message_json) }))
        .map(({ id, role, content }) => ({ id, role, content }));
    const history = () => fs.existsSync(historyPath) ? JSON.parse(fs.readFileSync(historyPath, 'utf8'))
        .map(({ id, role, content }) => ({ id, role, content })) : [];
    const sendPosts = () => service.requests.filter(row => row.route.endsWith('/session-send') && row.body?.message?.content === marker);
    const snapshot = (id) => ({
        work: work(), native: native(id), invocations: invocations(id), records: records(),
        counter: fixture.counts(out), provider: service.calls.filter(row => row.ordinaryCase === marker),
        sendPosts: sendPosts().length, journal: journal(), history: history(),
    });

    async function select(client) {
        if (!await evalJs(client, 'document.querySelector("#tabContentAgents").classList.contains("active")')) {
            await click(client, '.sidebar-tab-button[data-tab="agents"]');
        }
        await click(client, '#agentList > li .agent-name', 'Synthetic shared');
        await waitUntil(async () => (await evalJs(client, 'window.VCPStateChannels.get("conversation.current").get()')).topicId === topicId, 'shared conversation');
        await waitUntil(async () => (await evalJs(client, `window.chatAPI.getNativeDeletionContext(${quoted(descriptor)})`))?.kind === 'shared', 'shared ownership');
    }

    const receipt = result.approvalRestore = {};
    const notificationSource = 'apps/desktop/modules/notificationRenderer.js';
    async function loadedNotification(client) {
        const { renderer } = await client.command('loaded-sources', { main: [], renderer: [notificationSource] });
        assert.equal(renderer.length, 1);
        assert.equal(renderer[0].sha256, sha(path.join(result.candidate, notificationSource)));
        return renderer[0];
    }
    const ownerPost = createOwnerPost({ origin: service.origin, out, cert });
    const backendPid = service.backendPid;
    let originalWork;
    try {
        const A = clients.A;
        await select(A);
        receipt.desktopRenderer = await loadedNotification(A);
        await evalJs(A, `(() => {
            const input = document.querySelector('#messageInput');
            input.focus();
            input.value = ${quoted(marker)};
            input.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
        await click(A, '#sendMessageBtn');
        const originalApproval = await waitUntil(() => approval(A), 'original native approval card');
        originalWork = await waitUntil(() => work().find(row => row.state === 'waiting_approval'), 'Work waiting on native approval');
        const beforeStatus = await waitUntil(async () => (await status(A)).find(line => line.includes(waiting)), 'original desktop status');
        receipt.beforeExit = { approvalId: originalApproval, status: beforeStatus,
            approvalShowsWorkId: await hasWorkLabel(A, originalApproval, originalWork.id), ...snapshot(originalWork.id) };
        if (!result.serverRevision) assert.equal(receipt.beforeExit.approvalShowsWorkId, true);
        assert.equal(originalWork.attempts, 1);
        assert.equal(receipt.beforeExit.native.length, 1);
        assert.equal(sendPosts()[0]?.response?.workId, originalWork.id);
        assert.equal(sendPosts()[0]?.body?.requestId, originalWork.request_id);
        assert.equal(receipt.beforeExit.sendPosts, 1);
        assert.equal(receipt.beforeExit.provider.length, 1);
        assert.deepEqual(receipt.beforeExit.counter, []);
        assert.deepEqual(receipt.beforeExit.invocations, []);
        assert.equal(receipt.beforeExit.records.length, 1);
        assert.equal(receipt.beforeExit.records[0].status, 'running');
        assert.equal(receipt.beforeExit.records[0].success, 0);
        await picture(A, 'before-exit');

        await stop('A');
        assert.equal(service.backendPid, backendPid);
        receipt.afterExit = snapshot(originalWork.id);
        assert.deepEqual(receipt.afterExit.work, [originalWork]);
        assert.deepEqual(receipt.afterExit.counter, []);

        const reopened = await start('A-reopened', 'A');
        assert.equal(result.A.profileDigest, result['A-reopened'].profileDigest);
        assert.notEqual(A.proc.pid, reopened.proc.pid);
        await select(reopened);
        assert.deepEqual(await loadedNotification(reopened), receipt.desktopRenderer);
        const reopenedStatus = await waitUntil(async () => (await status(reopened)).find(line => line.includes(waiting)), 'reopened desktop still waiting on original Work');
        let restoredApproval;
        if (result.serverRevision) {
            // Take a bounded observation past the original log service's 3-second replay window.
            await delay(9000);
            restoredApproval = await approval(reopened);
        } else {
            restoredApproval = await waitUntil(() => approval(reopened), 'restored native approval card', 9000);
        }
        assert.equal(service.backendPid, backendPid);
        receipt.reopened = { approvalId: restoredApproval, status: reopenedStatus,
            approvalShowsWorkId: await hasWorkLabel(reopened, restoredApproval, originalWork.id), ...snapshot(originalWork.id) };
        await picture(reopened, 'reopened');
        assert.deepEqual(receipt.reopened.work, [originalWork]);
        assert.deepEqual(receipt.reopened.native, receipt.beforeExit.native);
        assert.deepEqual(receipt.reopened.counter, []);
        assert.deepEqual(receipt.reopened.invocations, []);
        assert.deepEqual(receipt.reopened.records, receipt.beforeExit.records);
        assert.equal(receipt.reopened.provider.length, 1);
        assert.equal(receipt.reopened.sendPosts, 1);
        if (result.serverRevision) {
            assert.equal(restoredApproval, null, 'baseline does not restore the approval action');
            return;
        }
        assert.equal(restoredApproval, originalApproval);
        assert.equal(receipt.reopened.approvalShowsWorkId, true);

        const selector = approvalCard + '[data-tool-approval-request-id=' + quoted(originalApproval) + '] ' + allowButton;
        const point = await waitUntil(() => evalJs(reopened, `(() => {
            const button = [...document.querySelectorAll(${quoted(selector)})].find(node =>
                node.checkVisibility() && !node.disabled && node.innerText.trim() === '允许');
            if (!button) return null;
            button.scrollIntoView({ block: 'center', behavior: 'instant' });
            const { left, top, width, height } = button.getBoundingClientRect();
            const x = Math.round(left + width / 2), y = Math.round(top + height / 2);
            return button.contains(document.elementFromPoint(x, y)) ? { x, y } : null;
        })()`), 'restored approval button receives pointer input');
        await reopened.command('mouse', point);
        await reopened.command('mouse', point);
        receipt.pointerAttempts = 2;

        await waitUntil(() => work()[0]?.state === 'completed', 'same Work completed after restored approval');
        await waitUntil(async () => (await transcript(reopened)).includes(fixture.finalText), 'native reply rendered');
        await waitUntil(() => journal().length === 2 && history().length === 2, 'native History projected');
        await waitUntil(async () => !await approval(reopened), 'resolved card has no approval action');
        await delay(400);
        receipt.completed = snapshot(originalWork.id);
        const after = receipt.completed;
        assert.deepEqual(after.work, [{ ...originalWork, state: 'completed' }]);
        assert.deepEqual(after.native.map(row => row.id), receipt.beforeExit.native.map(row => row.id));
        assert.deepEqual(after.counter.map(row => row.marker), [marker]);
        assert.deepEqual(after.provider.map(row => row.ordinaryPhase), ['tool-request', 'continuation']);
        assert.equal(after.provider[1].hasToolResult, true);
        assert.equal(after.sendPosts, 1);
        assert.equal(after.invocations.length, 1);
        assert.equal(after.invocations[0].native_request_id, after.native[0].id);
        assert.equal(after.invocations[0].plugin_name, fixture.name);
        assert.equal(after.invocations[0].state, 'returned');
        assert.equal(after.invocations[0].record_id, receipt.beforeExit.records[0].id);
        assert.deepEqual(after.records, [{ id: after.invocations[0].record_id, tool_name: fixture.name, status: 'success', success: 1 }]);
        assert.deepEqual(after.journal.map(row => row.role), ['user', 'assistant']);
        assert.equal(after.journal[0].content, marker);
        assert.ok(after.journal[1].content.includes(fixture.finalText));
        assert.deepEqual(after.history, after.journal);
        await picture(reopened, 'completed');
    } finally {
        try {
            if (originalWork && work().some(row => row.id === originalWork.id && row.state === 'waiting_approval')) {
                const cancellation = await ownerPost('/api/v1/sync/shared/session-cancel', {
                    sharedSpaceId: 'sharedAB', workId: originalWork.id, opId: randomUUID(),
                });
                assert.equal(cancellation.submitted, true);
                receipt.cleanup = await waitUntil(() => work().find(row => row.id === originalWork.id &&
                    ['cancelled', 'review_required', 'failed'].includes(row.state)), 'settle outstanding synthetic Work');
            }
        } finally {
            db.close();
            audit.close();
        }
    }
};

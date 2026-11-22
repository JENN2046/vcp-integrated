'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { nextInput, hasNextInput } = require('./fixture.cjs');

const oldInput = 'GROUP_HANDOFF_BASELINE_INPUT';
const oldReply = 'RELAY_A_FINAL';
const nextReplies = ['REVIEW_NEXT_A_FINAL', 'REVIEW_NEXT_B_FINAL'];
const groupPanel = '.native-sync-controlled-work';
const workPanel = '.native-sync-execution-status';

module.exports = async function reviewCloseout({
    clients, result, picture, click, evalJs, waitUntil, sha, service, start, stop, profiles, crash, groupRelay, cert, closeoutSource,
}) {
    const { groupTopic, workId, nativeRequestIds, sourceSha256 } = closeoutSource;
    const dbFile = path.join(service.data, 'central.sqlite');
    assert.notEqual(fs.realpathSync(dbFile), closeoutSource.sourcePath);
    const db = new DatabaseSync(dbFile, { readOnly: true });
    const evidence = result.groupReviewCloseout = { workId, nativeRequestIds, sourceSha256, desktop: {} };
    const historyFile = path.join(profiles.B, 'UserData', groupTopic.localGroupId, 'topics', groupTopic.localTopicId, 'history.json');
    const projectHistory = rows => rows.map(({ id, role, agentId, content }) => ({ id, role, agentId, content }));
    const history = () => projectHistory(JSON.parse(fs.readFileSync(historyFile, 'utf8')));
    const ownership = db.prepare('SELECT executor,executor_version,state,first_reply_seq FROM shared_group_handoffs WHERE work_id=?');
    const admission = db.prepare('SELECT id,request_id,principal,state,dispatched,user_seq,native_terminal FROM shared_admissions WHERE id=?');
    const native = db.prepare('SELECT id,ordinal,principal,member_id,state FROM shared_native_requests WHERE admission_id=? ORDER BY ordinal');
    const journal = db.prepare('SELECT seq,msg_id,device_id,action,message_json FROM journal WHERE topic_id=? ORDER BY seq');
    const topicAdmissions = db.prepare('SELECT id,request_id,principal,state FROM shared_admissions WHERE topic_id=? ORDER BY rowid');
    const closeoutOpId = 'desktop-abandon_' + workId;
    const receiptRows = () => db.prepare('SELECT principal,op_id,result_json FROM shared_receipts WHERE op_id=?').all(closeoutOpId)
        .map(({ result_json, ...row }) => ({ ...row, result: JSON.parse(result_json) }));
    const providerCalls = () => groupRelay.requests.map(({ member, packet }) => ({
        member, requestId: packet.requestId, nextInputPresent: hasNextInput(packet),
    }));
    const capture = () => ({
        admission: admission.get(workId),
        handoff: ownership.get(workId),
        native: native.all(workId),
        journal: journal.all(groupTopic.topicId).map(({ message_json, ...row }) => ({ ...row, message: JSON.parse(message_json) })),
        providerCalls: providerCalls(),
    });

    async function selectGroup(client) {
        await click(client, '#agentList > li[data-item-type="group"][data-item-id=' + JSON.stringify(groupTopic.localGroupId) + ']');
        await waitUntil(() => evalJs(client, `window.VCPStateChannels.get('conversation.current').get()?.topicId === ${JSON.stringify(groupTopic.localTopicId)}`),
            'B selects original topic in native group sidebar');
        await waitUntil(() => evalJs(client, `document.querySelector('${groupPanel}')?.checkVisibility()`), 'controlled group panel is visible');
        if (!await evalJs(client, `document.querySelector('${groupPanel}').open`)) await click(client, groupPanel + ' summary');
    }

    const groupStatus = client => evalJs(client, `document.querySelector('${groupPanel} [role=status]')?.innerText || ''`);
    const messages = client => evalJs(client, "document.querySelector('#chatMessages').innerText");
    const executionRow = workPanel + ' [data-work-id=' + JSON.stringify(workId) + ']';
    const literals = text => [...text.matchAll(/(?:RELAY_[AB]_(?:FINAL|PARTIAL)|REVIEW_NEXT_[AB]_FINAL)/g)].map(match => match[0]);
    async function readReopened(client) {
        const text = await waitUntil(async () => {
            const rendered = await messages(client);
            return rendered.includes(oldReply) && rendered;
        }, 'B renders the committed original A reply');
        assert.deepEqual(literals(text), [oldReply]);
        assert.deepEqual(history().map(row => row.content), [oldInput, oldReply]);
        const status = await groupStatus(client);
        assert.match(status, /第二位成员 B的回复已派发，结果未知/);
        return { groupStatus: status, messages: text, history: history() };
    }

    try {
        evidence.desktop.sourceOpen = { pid: clients.B.proc.pid };
        await stop('B');
        const review = await start('B');
        assert.notEqual(review.proc.pid, evidence.desktop.sourceOpen.pid);
        await selectGroup(review);
        await waitUntil(async () => (await groupStatus(review)).includes('原回复结果待核对'), 'B sees the original result still needs review');
        evidence.desktop.before = await readReopened(review);
        assert.deepEqual(receiptRows(), []);
        evidence.before = capture();
        const original = evidence.before.admission;
        const originalA = evidence.before.journal[1]?.message;
        assert.equal(original.state, 'review_required');
        assert.equal(evidence.before.handoff.executor, 'desktop:deviceB');
        assert.equal(evidence.before.handoff.executor_version, 1);
        assert.deepEqual(evidence.before.native.map(row => row.id), nativeRequestIds);
        assert.deepEqual(evidence.before.native.map(row => row.state), ['model_terminal', 'unknown']);
        assert.deepEqual(evidence.before.journal.map(row => row.message.content), [oldInput, oldReply]);
        assert.equal(originalA.id, 'reply_group_' + workId + '_0');
        assert.equal(originalA.agentId, evidence.before.native[0].member_id);
        assert.deepEqual(evidence.desktop.before.history, projectHistory(evidence.before.journal.map(row => row.message)));
        assert.deepEqual(service.calls, []);
        await waitUntil(() => evalJs(review, `document.querySelector('${workPanel}')?.checkVisibility()`), 'B sees native execution status panel');
        if (!await evalJs(review, `document.querySelector('${workPanel}').open`)) await click(review, workPanel + ' summary');
        evidence.desktop.before.executionStatus = await evalJs(review, `document.querySelector(${JSON.stringify(executionRow)})?.innerText`);
        await picture(review, 'B-reopened-original-needs-review');

        evidence.readOnly = await require('./review-readonly.cjs')({ service, capture, original, cert });

        const button = executionRow + ' button';
        const checkbox = executionRow + ' input[type=checkbox]';
        await click(review, checkbox);
        await click(review, button + ':not(:disabled)', '确认放弃并解除暂停');
        const receipt = await waitUntil(() => service.requests.find(row => row.route.endsWith('/shared/abandon') && row.dropped),
            'proxy drops the accepted abandon receipt');
        const accepted = receipt.response.request;
        assert.equal(receipt.device, 'deviceB');
        assert.equal(receipt.body.admissionId, workId);
        assert.equal(receipt.body.confirm, true);
        assert.equal(receipt.body.opId, closeoutOpId);
        assert.equal(accepted.id, workId);
        assert.equal(accepted.state, 'abandoned');
        evidence.lostReceipt = receipt;
        evidence.closeoutReceipt = { expectedOpId: closeoutOpId, actualOpId: receipt.body.opId, rows: receiptRows() };
        assert.deepEqual(evidence.closeoutReceipt.rows, [{ principal: 'desktop:deviceB', op_id: closeoutOpId, result: { request: accepted } }]);
        evidence.desktop.lostReceiptResult = await waitUntil(() => review.events.find(event => event.event === 'ipc-result' &&
            event.data.channel === 'native-sync:abandon-send' && event.data.success === false), 'desktop cannot read the accepted closeout receipt');
        evidence.settled = capture();
        assert.equal(evidence.settled.admission.state, 'abandoned');
        assert.deepEqual(evidence.settled.handoff, evidence.before.handoff);
        assert.deepEqual(evidence.settled.native, evidence.before.native);
        assert.deepEqual(evidence.settled.journal, evidence.before.journal);
        assert.deepEqual(service.calls, []);

        evidence.desktop.receiptRecipientExit = await crash('B');
        const reopened = await start('B');
        assert.notEqual(reopened.proc.pid, review.proc.pid);
        await selectGroup(reopened);
        await waitUntil(async () => (await groupStatus(reopened)).includes('接力已结束'), 'B reads centrally settled original Work after lost ACK and restart');
        evidence.desktop.after = await readReopened(reopened);
        const files = {
            main: ['apps/desktop/modules/services/nativeSync/sharedGroupHandoff.js', 'apps/desktop/modules/services/nativeSync/sharedExecution.js'],
            renderer: ['apps/desktop/modules/renderer/controlledWorkView.mjs', 'apps/desktop/modules/renderer/nativeExecutionStatus.js'],
        };
        evidence.desktop.loadedSources = await reopened.command('loaded-sources', files);
        for (const [context, names] of Object.entries(files)) {
            for (const file of names) assert.ok(evidence.desktop.loadedSources[context].some(row =>
                row.file === file && row.sha256 === sha(path.resolve(file))), file);
        }
        assert.deepEqual(capture(), evidence.settled);
        assert.equal(await evalJs(reopened, `[...document.querySelectorAll(${JSON.stringify(button)})].some(el => !el.disabled && el.checkVisibility())`), false);
        await waitUntil(() => evalJs(reopened, `![...document.querySelectorAll('button')].some(el =>
            el.textContent === '查看并核对原请求' && el.checkVisibility())`), 'no pending review prompt remains after closeout');
        await picture(reopened, 'B-reopened-after-lost-closeout-ack');

        await evalJs(reopened, `(() => {
            const input = document.querySelector('#messageInput');
            input.value = ${JSON.stringify(nextInput)};
            input.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
        await click(reopened, '#sendMessageBtn:not(:disabled)');
        await waitUntil(() => topicAdmissions.all(groupTopic.id).some(row => row.id !== workId && row.state === 'completed'),
            'new ordinary native group round completes in the same topic');
        await waitUntil(() => {
            try { return history().at(-1)?.content === nextReplies[1]; }
            catch (error) { if (!(error instanceof SyntaxError)) throw error; }
        }, 'new round reaches native History');
        await waitUntil(async () => (await messages(reopened)).includes(nextReplies[1]), 'B renders the new second member');
        evidence.next = { ...capture(), admissions: topicAdmissions.all(groupTopic.id), history: history(), renderer: await messages(reopened) };
        assert.deepEqual(evidence.next.admission, evidence.settled.admission);
        assert.deepEqual(evidence.next.handoff, evidence.settled.handoff);
        assert.deepEqual(evidence.next.native, evidence.settled.native);
        assert.deepEqual(evidence.next.journal.slice(0, 2), evidence.before.journal);
        assert.deepEqual(evidence.next.journal.map(row => row.message.content), [oldInput, oldReply, nextInput, ...nextReplies]);
        assert.deepEqual(evidence.next.history, projectHistory(evidence.next.journal.map(row => row.message)));
        assert.deepEqual(literals(evidence.next.renderer), [oldReply, ...nextReplies]);
        assert.deepEqual(evidence.next.providerCalls.map(row => row.member), ['A', 'B']);
        assert.ok(evidence.next.providerCalls.every(row => row.nextInputPresent));
        assert.equal(service.calls.length, 2);
        assert.deepEqual(receiptRows(), evidence.closeoutReceipt.rows);
        assert.equal(evidence.next.admissions.length, 2);
        const newId = evidence.next.admissions[1].id;
        assert.notEqual(newId, workId);
        evidence.next.nativeNew = native.all(newId);
        assert.deepEqual(evidence.next.nativeNew.map(row => row.id), ['group_' + newId + '_0', 'group_' + newId + '_1']);
        assert.deepEqual(evidence.next.providerCalls.map(row => row.requestId), evidence.next.nativeNew.map(row => row.id));
        await picture(reopened, 'B-native-next-round-completed');
    } finally {
        db.close();
        closeoutSource.assertOriginalUnchanged();
    }
};

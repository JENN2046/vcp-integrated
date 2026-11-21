'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const fixture = require('../ordinary-tools/fixture.cjs');

const quoted = JSON.stringify;
const approvalText = '等待原生审批';
const approvalButton = '.notification-tool-approval button.vcp-btn-success';
const readHistory = (profile, { itemId, topicId }) => {
    const file = path.join(profile, 'UserData', itemId, 'topics', topicId, 'history.json');
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
};

module.exports = async ({ clients: { A, B }, out, result, service, picture, click, evalJs, waitUntil, start, stop, profiles, sha }) => {
    const db = new DatabaseSync(path.join(service.data, 'central.sqlite'), { readOnly: true });
    const root = selector => `document.querySelector(${quoted(selector)})`;
    const transcript = client => evalJs(client, `${root('#chatMessages')}.innerText`);
    const current = client => evalJs(client, 'window.VCPStateChannels.get("conversation.current").get()');
    const local = result.mode === 'local-only';
    const marker = local ? 'ORDINARY_TOOL_LOCAL' : 'ORDINARY_TOOL_APPROVE';
    const localDescriptor = { itemId: 'local-agent', topicId: 'local-topic' };
    const topic = role => local ? localDescriptor : service.descriptors[role].preSubmit;
    const calls = () => service.calls.filter(call => call.ordinaryCase === marker);
    const work = () => db.prepare('SELECT id, request_id, state, attempts FROM mobile_executions ORDER BY rowid').all()
        .map(row => ({ ...row }));
    const native = id => db.prepare('SELECT id, state FROM shared_native_requests WHERE admission_id=?').all(id);
    const journal = () => db.prepare('SELECT msg_id, message_json FROM journal ORDER BY seq').all()
        .map(row => ({ id: row.msg_id, role: JSON.parse(row.message_json).role }));

    async function select(client, role) {
        const descriptor = topic(role);
        if (!await evalJs(client, `${root('#tabContentAgents')}.classList.contains('active')`)) {
            await click(client, '.sidebar-tab-button[data-tab="agents"]');
        }
        await click(client, '#agentList > li .agent-name', local ? 'Synthetic local' : 'Synthetic shared');
        await waitUntil(async () => (await current(client)).topicId === descriptor.topicId, 'expected conversation selected');
        if (!local) {
            await waitUntil(async () => (await evalJs(client,
                `window.chatAPI.getNativeDeletionContext(${quoted(descriptor)})`))?.kind === 'shared', 'shared ownership');
        }
    }

    async function send(client) {
        await evalJs(client, `(() => {
            const input = ${root('#messageInput')};
            input.focus();
            input.value = ${quoted(marker)};
            input.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
        await click(client, '#sendMessageBtn');
    }

    async function readApproval(client) {
        return evalJs(client, `(() => {
            const card = [...document.querySelectorAll('.notification-tool-approval')].find(element =>
                element.checkVisibility() && element.innerText.includes(${quoted(fixture.name)}));
            if (!card) return null;
            const rect = card.getBoundingClientRect();
            return rect.right <= innerWidth && Number(getComputedStyle(card).opacity) === 1
                ? card.dataset.toolApprovalRequestId : null;
        })()`);
    }

    const history = role => readHistory(profiles[role], topic(role));
    const approved = client => waitUntil(async () => (await transcript(client)).includes(fixture.finalText), 'native reply rendered');
    try {
        assert.deepEqual(work(), []);
        assert.deepEqual(journal(), []);
        await select(A, 'A');
        if (!local) await select(B, 'B');
        result.loaded = await A.command('loaded-sources', {
            main: ['apps/desktop/modules/ipc/chatHandlers.js'],
            renderer: ['apps/desktop/modules/renderer/mainChatSendOwner.js',
                'apps/desktop/modules/services/nativeSync/sharedSessionView.mjs'],
        });
        assert.equal(result.loaded.main.length, 1);
        assert.equal(result.loaded.renderer.length, 2);
        for (const source of [...result.loaded.main, ...result.loaded.renderer]) {
            assert.equal(source.sha256, sha(path.join(result.candidate, source.file)));
        }
        await picture(A, local ? 'local-tool-before-send' : 'shared-tool-before-send');
        await send(A);
        await waitUntil(() => calls().some(call => call.ordinaryPhase === 'tool-request'), 'fixture provider saw user input');
        if (local) {
            await approved(A);
            const saved = await waitUntil(() => history('A').some(row => row.role === 'assistant' && row.content.includes(fixture.finalText)) && history('A'), 'ordinary local History');
            assert.deepEqual(saved.map(row => row.role), ['user', 'assistant']);
            assert.equal(saved[0].content, marker);
            assert.deepEqual(fixture.counts(out).map(row => row.marker), [marker]);
            assert.deepEqual(work(), []);
            assert.deepEqual(journal(), []);
            assert.equal(service.requests.filter(row => row.route.endsWith('/session-send')).length, 0);
            assert.ok(service.requests.some(row => row.route === '/v1/local-chat/completions'));
            assert.equal(calls().some(call => call.ordinaryPhase === 'continuation' && call.hasToolResult), true);
            await picture(A, 'local-tool-complete');
            result.localTool = { roles: saved.map(row => row.role), provider: calls(), counter: fixture.counts(out), work: work(), journal: journal() };
            return;
        }

        const lostReceipt = process.env.NS_DROP_APPROVAL_RECEIPT === '1';
        let droppedSend;
        if (lostReceipt) {
            droppedSend = await waitUntil(() => service.requests.find(row => row.dropped
                && row.route.endsWith('/session-send') && row.body?.message?.content === marker),
            'proxy dropped an accepted send acknowledgement');
            await waitUntil(() => A.events.some(event => event.event === 'ipc-result'
                && event.data.channel === 'native-sync:prepare-send' && event.data.error === 'NETWORK_UNAVAILABLE'),
            'acknowledgement loss reached original desktop client');
        }
        const approvalId = await waitUntil(() => readApproval(A), 'native approval prompt on desktop A', 17000);
        const admitted = await waitUntil(() => work()[0], 'server admission');
        assert.equal(admitted.attempts, 1);
        const nativeBefore = native(admitted.id);
        assert.equal(nativeBefore.length, 1);
        assert.deepEqual(fixture.counts(out), []);
        assert.equal(calls().length, 1);
        const observerApproval = await waitUntil(() => readApproval(B), 'native approval prompt on desktop B');
        assert.equal(observerApproval, approvalId);
        const statusSelector = '.native-sync-live-message [role="status"]';
        const readStatus = client => evalJs(client, `[...document.querySelectorAll(${quoted(statusSelector)})].map(e => e.innerText)`);
        const waitingStatus = client => waitUntil(async () => {
            const lines = await readStatus(client);
            const present = result.serverRevision ? lines.length > 0 : lines.some(text => text.includes(approvalText));
            return present && lines;
        }, 'shared Work reports native execution status');
        const beforeReopen = await waitingStatus(lostReceipt ? B : A);
        if (droppedSend) {
            assert.equal(droppedSend.response.workId, admitted.id);
            assert.equal(droppedSend.body.requestId, admitted.request_id);
        }
        if (lostReceipt) await picture(A, 'shared-tool-lost-ack');
        else await picture(A, 'shared-tool-approval');
        await picture(B, 'shared-tool-observer-pending');
        await stop('A');
        if (lostReceipt) service.disarmDrop();
        const reopened = await start('A-reopened', 'A');
        await select(reopened, 'A');
        assert.equal(result.A.profileDigest, result['A-reopened'].profileDigest);
        assert.deepEqual(native(admitted.id), nativeBefore);
        assert.deepEqual(fixture.counts(out), []);
        assert.equal(calls().length, 1);
        const afterReopen = await waitingStatus(reopened);
        if (lostReceipt) {
            await waitUntil(() => service.requests.some(row => row.route.endsWith('/shared/request')
                && row.query?.requestId === admitted.request_id && row.status === 200 && !row.injected),
            'reopened client recovered the original admitted request');
        }
        const reopenedApproval = await readApproval(reopened);
        if (reopenedApproval) assert.equal(reopenedApproval, approvalId);
        assert.equal(await readApproval(B), approvalId);
        await picture(reopened, 'shared-tool-approval-reopened');
        await click(B, approvalButton, '允许');
        await waitUntil(() => work()[0]?.state === 'completed', 'same Work completed after approval');
        await approved(reopened);
        await approved(B);
        const saved = await waitUntil(() => {
            const rows = journal();
            return rows.length === 2 && ['A', 'B'].every(role =>
                JSON.stringify(history(role).map(row => row.id)) === JSON.stringify(rows.map(row => row.id))) && rows;
        }, 'identical desktop and journal message IDs');
        assert.deepEqual(saved.map(row => row.role), ['user', 'assistant']);
        assert.deepEqual(fixture.counts(out).map(row => row.marker), [marker]);
        assert.deepEqual(calls().map(row => row.ordinaryPhase), ['tool-request', 'continuation']);
        assert.equal(calls()[1].hasToolResult, true);
        assert.deepEqual(work(), [{ ...admitted, state: 'completed' }]);
        assert.equal(native(admitted.id)[0].id, nativeBefore[0].id);
        const sendPosts = service.requests.filter(row => row.route.endsWith('/session-send') && row.body?.message?.content === marker);
        assert.equal(sendPosts.length, 1);
        await picture(reopened, 'shared-tool-complete');
        await picture(B, 'shared-tool-observer-complete');
        result.sharedTool = { approvalId, observerApproval, reopenedApproval, beforeReopen, afterReopen, work: work(), native: native(admitted.id), provider: calls(),
            counter: fixture.counts(out), sendPosts: sendPosts.length, lostReceipt, journal: saved };
    } finally {
        db.close();
    }
};

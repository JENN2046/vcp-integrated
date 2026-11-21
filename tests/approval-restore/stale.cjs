'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createRequire } = require('node:module');
const { DatabaseSync } = require('node:sqlite');
const { setTimeout: delay } = require('node:timers/promises');
const fixture = require('../ordinary-tools/fixture.cjs');
const openReadOnlyPwa = require('../ordinary-tools/pwa.cjs');
const createOwnerPost = require('./owner.cjs');

const marker = 'ORDINARY_TOOL_APPROVE';
const sharedSpaceId = 'sharedAB';
const terminalStates = ['review_required', 'cancelled', 'failed', 'completed'];

module.exports = async ({ clients: { A, B }, out, result, service, cert, picture, click, evalJs, waitUntil, start, stop, profiles, sha }) => {
    assert.equal(B, undefined, 'there is no second approval-capable desktop');
    const expire = process.env.NS_EXPIRE_APPROVAL === '1';
    const rows = new DatabaseSync(path.join(service.data, 'central.sqlite'), { readOnly: true });
    const descriptor = service.descriptors.A.preSubmit;
    const desktopHistoryPath = path.join(profiles.A, 'UserData', descriptor.itemId, 'topics', descriptor.topicId, 'history.json');
    const work = () => rows.prepare('SELECT id, request_id, state, attempts, cancel_requested FROM mobile_executions').all()
        .map(row => ({ ...row }));
    const native = () => rows.prepare('SELECT id, admission_id, state FROM shared_native_requests').all()
        .map(row => ({ ...row }));
    const journal = () => rows.prepare('SELECT msg_id, message_json FROM journal ORDER BY seq').all()
        .map(row => ({ id: row.msg_id, role: JSON.parse(row.message_json).role }));
    const ownerPost = createOwnerPost({ origin: service.origin, out, cert });
    const approvalCards = client => evalJs(client, `[...document.querySelectorAll('.notification-tool-approval')]
        .filter(card => card.innerText.includes(${JSON.stringify(fixture.name)}))
        .map(card => ({
            id: card.dataset.toolApprovalRequestId,
            actionable: [...card.querySelectorAll('button')].some(button => !button.disabled && button.checkVisibility()
                && ['允许', '拒绝'].includes(button.innerText.trim())),
        }))`);
    async function select(client) {
        if (!await evalJs(client, "document.querySelector('#tabContentAgents').classList.contains('active')")) {
            await click(client, '.sidebar-tab-button[data-tab="agents"]');
        }
        await click(client, '#agentList > li .agent-name', 'Synthetic shared');
        await waitUntil(async () => (await evalJs(client,
            'window.VCPStateChannels.get("conversation.current").get()')).topicId === descriptor.topicId, 'shared topic selected');
    }
    function assertNoToolDispatch() {
        assert.deepEqual(fixture.counts(out), []);
        assert.deepEqual(rows.prepare('SELECT invocation_id FROM mobile_native_invocations').all(), []);
        assert.ok(service.calls.every(call => call.hasToolResult === false), 'no successful tool result reached the Provider');
        assert.equal(service.calls.filter(call => call.ordinaryPhase === 'tool-request').length, 1);
        assert.equal(service.requests.filter(row => row.route.endsWith('/session-send') && row.body?.message?.content === marker).length, 1);
    }

    let pwa, audit;
    try {
        const serverRequire = createRequire(path.join(result.candidate, 'apps/server/package.json'));
        audit = new DatabaseSync(path.join(out, 'runtime-box/config/tool-call-records.sqlite3'), { readOnly: true });
        pwa = await openReadOnlyPwa({ service, out, cert, request: ownerPost, puppet: serverRequire('puppeteer') });
        await select(A);
        await evalJs(A, `(() => {
            const input = document.querySelector('#messageInput');
            input.focus();
            input.value = ${JSON.stringify(marker)};
            input.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
        await click(A, '#sendMessageBtn');
        const original = await waitUntil(async () => (await approvalCards(A)).find(card => card.actionable), 'original actionable native approval');
        const waiting = await waitUntil(() => work()[0]?.state === 'waiting_approval' && work()[0], 'original Work awaiting approval');
        const initialNative = native();
        assert.equal(waiting.attempts, 1);
        assert.equal(initialNative.length, 1);
        assert.equal(initialNative[0].admission_id, waiting.id);
        assertNoToolDispatch();
        assert.deepEqual(service.calls.map(call => call.ordinaryPhase), ['tool-request']);
        assert.deepEqual(journal().map(row => row.role), ['user']);
        const loaded = await A.command('loaded-sources', {
            main: ['apps/desktop/main.js'], renderer: ['apps/desktop/modules/notificationRenderer.js'],
        });
        assert.equal(loaded.main.length, 1);
        assert.equal(loaded.renderer.length, 1);
        for (const source of [...loaded.main, ...loaded.renderer]) {
            assert.equal(source.sha256, sha(path.join(result.candidate, source.file)));
        }
        await picture(A, 'desktop-pending');
        const browser = await pwa.inspect();
        const observedWaiting = await browser.page.waitForFunction(() => /等待原生.*审批/.test(document.body.innerText),
            { timeout: 7000 });
        await observedWaiting.dispose();
        const pendingControls = await pwa.duringApproval();
        assert.deepEqual(browser.writes, []);
        assert.deepEqual(browser.errors, []);
        const readOnlyAuthority = await browser.page.evaluate(async ({ approvalId, toolName }) => {
            const headers = { 'X-NativeSync-Capabilities': 'shared-space-v1', 'Content-Type': 'application/json' };
            const session = await fetch('/mobile/api/session', { headers });
            const permissions = (await session.json()).sharedPermissions;
            return { permissions,
                rawApprovalIdVisible: document.body.innerText.includes(approvalId),
                toolNameVisible: document.body.innerText.includes(toolName) };
        }, { approvalId: original.id, toolName: fixture.name });
        assert.deepEqual(readOnlyAuthority, {
            permissions: ['shared:sharedAB:read'],
            rawApprovalIdVisible: false, toolNameVisible: false,
        });
        assert.deepEqual(work(), [waiting]);

        await stop('A');
        assert.deepEqual(result.exits.A, { code: 0, signal: null });
        assert.deepEqual(work(), [waiting], 'original Work is still pending while the only desktop is offline');
        assert.equal(await browser.page.evaluate(() => document.querySelector('textarea').disabled), true);
        const offlineAt = Date.now();
        if (!expire) {
            const cancelled = await ownerPost('/api/v1/sync/shared/session-cancel', {
                sharedSpaceId, workId: waiting.id, opId: randomUUID(),
            });
            assert.equal(cancelled.submitted, true);
        }
        const terminal = await waitUntil(() => terminalStates.includes(work()[0]?.state) && work()[0],
            'original Work settled while the desktop is offline', 26000);
        const offlineUntilTerminalMs = Date.now() - offlineAt;
        assert.equal(terminal.cancel_requested, expire ? 0 : 1);
        assert.equal(terminal.id, waiting.id);
        assert.equal(terminal.request_id, waiting.request_id);
        assert.equal(terminal.attempts, waiting.attempts);
        assertNoToolDispatch();
        const providerCallsAtTerminal = service.calls.length;
        const journalAtTerminal = journal();
        if (expire) {
            assert.ok(offlineUntilTerminalMs >= 1000, 'native approval expired after the sole desktop exited');
            assert.equal(service.requests.filter(row => row.route.endsWith('/session-cancel')).length, 0);
        } else {
            assert.notEqual(terminal.state, 'completed');
            assert.deepEqual(journalAtTerminal.map(row => row.role), ['user']);
        }

        const reopened = await start('A-reopened', 'A');
        await select(reopened);
        assert.equal(result.A.profileDigest, result['A-reopened'].profileDigest);
        await waitUntil(async () => (await evalJs(reopened, "document.querySelector('#chatMessages').innerText")).includes(marker),
            'original shared user message on reopened desktop');
        const lateResponse = await waitUntil(async () => {
            const response = await evalJs(reopened, `window.electronAPI.sendVCPLogMessageConfirmed(${JSON.stringify({
                type: 'tool_approval_response', data: { requestId: original.id, approved: true },
            })})`);
            return response?.queued === true && response;
        }, 'reopened desktop VCPLog queued a late response for the original approval', 12000);
        await delay(900);
        const reopenedCards = await approvalCards(reopened);
        assert.deepEqual(reopenedCards, [], 'terminal original approval never reappears');
        assertNoToolDispatch();
        assert.equal(service.calls.length, providerCallsAtTerminal);
        assert.deepEqual(journal(), journalAtTerminal);
        assert.deepEqual(work(), [terminal]);
        const finalNative = native();
        assert.equal(finalNative.length, 1);
        assert.equal(finalNative[0].id, initialNative[0].id);
        const toolRecords = audit.prepare(`SELECT status, success, duration_ms, error_text
            FROM tool_call_records WHERE tool_name = ?`).all(fixture.name);
        assert.ok(toolRecords.every(record => record.success === 0));
        if (expire) {
            assert.equal(toolRecords.length, 1);
            assert.match(toolRecords[0].error_text, /Manual approval.*timed out/);
        }
        const toolAudit = toolRecords.map(row => ({ status: row.status, success: row.success === 1,
            durationMs: row.duration_ms, nativeApprovalTimedOut: /Manual approval.*timed out/.test(row.error_text || '') }));
        const finalJournal = journal();
        const history = await waitUntil(() => {
            const saved = JSON.parse(fs.readFileSync(desktopHistoryPath, 'utf8'));
            return saved.some(row => row.id === finalJournal[0].id) && saved;
        }, 'reopened History projected original user row');
        assert.deepEqual(history.map(row => ({ id: row.id, role: row.role })), finalJournal);
        await picture(reopened, 'desktop-reopened-terminal');
        const observedTerminal = await browser.page.waitForFunction(() => [...document.querySelectorAll('.execution-row')]
            .some(element => /执行中断|已取消|执行失败|回复已保存/.test(element.innerText)), { timeout: 12000 });
        await observedTerminal.dispose();
        const mobile = await pwa.inspect();
        assert.deepEqual(await mobile.readOnlyControls(), { composerDisabled: true, executionButtons: [] });
        assert.deepEqual(mobile.writes, []);
        assert.deepEqual(mobile.errors, []);
        assert.equal(await browser.page.evaluate(approvalId => document.body.innerText.includes(approvalId), original.id),
            false, 'terminal PWA does not expose the approval ID');
        await browser.page.screenshot({ path: path.join(out, 'read-only-pwa-terminal.png') });
        result.staleApproval = {
            trigger: expire ? 'native-timeout' : 'owner-cancel', originalApprovalId: original.id, loaded, waiting, initialNative, terminal, finalNative, lateResponse,
            terminalCards: reopenedCards, finalJournal, providerCalls: service.calls.length, toolInvocations: fixture.counts(out).length, toolAudit,
            onlyOneApprovalCapableDesktop: true, offlineUntilTerminalMs, terminalReachedWhileDesktopOffline: true,
            readOnlyPwa: { browser: browser.browser, viewport: { width: 390, height: 844 },
                pendingControls, observedTerminal: true, normalUiExecutionWrites: 0, ...readOnlyAuthority },
        };
    } finally {
        try { await pwa?.close(); } finally { audit?.close(); rows.close(); }
    }
};

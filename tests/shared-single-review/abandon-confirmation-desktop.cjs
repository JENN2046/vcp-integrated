'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async function observeConfirmation({
    A, picture, click, evalJs, waitUntil, snapshot, service, evidence, panel, workRow, checkbox, abandon,
}) {
    const mode = process.env.NS_ABANDON_CONFIRMATION;
    assert.ok(['immediate', 'refresh-before', 'refresh-after'].includes(mode));
    const report = evidence.abandonConfirmation = { mode };
    const renderer = 'apps/desktop/modules/renderer/nativeExecutionStatus.js';
    const { renderer: loaded } = await A.command('loaded-sources', { main: [], renderer: [renderer] });
    const source = fs.readFileSync(path.resolve(__dirname, '../..', renderer));
    const expected = createHash('sha256').update(source).digest('hex');
    report.renderer = loaded.find(entry => entry.file === renderer);
    assert.equal(report.renderer?.sha256, expected);
    const ipc = (channel, kind = 'ipc') => A.events
        .filter(event => event.event === kind && event.data.channel === channel)
        .map(({t,data}) => ({t, ...data}));
    const http = () => service.requests.filter(row => row.route.endsWith('/shared/abandon'));
    const probe = script => evalJs(A, `(() => {
        const row = () => document.querySelector(${JSON.stringify(workRow)});
        const checkbox = document.querySelector(${JSON.stringify(checkbox)});
        const button = document.querySelector(${JSON.stringify(abandon)});
        const current = () => ({ workId: row()?.dataset.workId, checked: checkbox?.checked, disabled: button?.disabled,
            rowReplaced: Boolean(window.closeoutProbe.checkedRow && row() !== window.closeoutProbe.checkedRow),
            controlReplaced: Boolean(window.closeoutProbe.checkedInput && checkbox !== window.closeoutProbe.checkedInput),
            renders: window.closeoutProbe.renders, trusted: window.closeoutProbe.trusted.slice() });
        ${script}
    })()`);

    await probe(`
        window.closeoutProbe = { checkedRow: null, checkedInput: null, renders: 0, trusted: [] };
        const jobs = row().parentElement;
        new MutationObserver(records => {
            if (records.some(record => record.target === jobs || row()?.contains(record.target))) {
                window.closeoutProbe.renders++;
            }
        }).observe(jobs, { childList: true, subtree: true });
        document.addEventListener('pointerdown', event => {
            const target = event.target.closest(${JSON.stringify(workRow)});
            if (target) window.closeoutProbe.trusted.push({ type: event.type, tag: event.target.tagName, trusted: event.isTrusted });
        }, true);
        document.addEventListener('change', event => {
            if (event.target.matches(${JSON.stringify(checkbox)})) {
                window.closeoutProbe.checkedRow = row();
                window.closeoutProbe.checkedInput = event.target;
                window.closeoutProbe.trusted.push({ type: event.type, tag: event.target.tagName, trusted: event.isTrusted });
            }
        }, true);
    `);
    report.unchecked = await probe('return current();');
    assert.equal(report.unchecked.checked, false);
    assert.equal(report.unchecked.disabled, true);
    await click(A, checkbox);
    report.checked = await probe('return current();');
    assert.equal(report.checked.checked, true);
    assert.equal(report.checked.disabled, false);
    assert.ok(report.checked.trusted.some(event => event.type === 'change' && event.trusted === true));

    if (mode !== 'immediate') {
        const queries = ipc('native-sync:executions', 'ipc-result').length;
        const renders = (await probe('return current();')).renders;
        await click(A, panel + ' > button', '核对云端状态');
        report.refreshed = await waitUntil(async () => {
            const state = await probe('return current();');
            return state.workId === report.checked.workId && state.renders > renders &&
                ipc('native-sync:executions', 'ipc-result').length > queries && state;
        }, 'native execution status query and rendered DOM update for the same Work');
        report.refreshIpc = ipc('native-sync:executions', 'ipc-result').slice(queries);
        assert.equal(report.refreshed.checked, mode === 'refresh-after');
        assert.equal(report.refreshed.disabled, mode === 'refresh-before');
        assert.equal(report.refreshed.rowReplaced, mode === 'refresh-before');
        assert.equal(report.refreshed.controlReplaced, mode === 'refresh-before');
        await picture(A, 'A-confirmation-after-status-refresh');
    }

    // The normal runner dispatches trusted Chromium mouse events even for a
    // disabled element when the selector does not filter on :not(:disabled).
    await click(A, abandon, '确认放弃并解除暂停');
    report.buttonPointer = await probe(`return window.closeoutProbe.trusted.find(
        event => event.type === 'pointerdown' && event.tag === 'BUTTON');`);
    assert.equal(report.buttonPointer?.trusted, true);
    const channel = 'native-sync:abandon-send';
    if (mode === 'refresh-before') {
        // Observe a complete native status round-trip after the attempted click.
        const queries = ipc('native-sync:executions', 'ipc-result').length;
        await click(A, panel + ' > button', '核对云端状态');
        await waitUntil(() => ipc('native-sync:executions', 'ipc-result').length > queries, 'post-click execution status receipt');
        report.afterClick = await probe('return current();');
        report.ipc = ipc(channel);
        report.http = http();
        report.afterFailedClick = snapshot();
        assert.deepEqual(report.ipc, []);
        assert.deepEqual(report.http, []);
        assert.deepEqual(report.afterFailedClick, evidence.before);
        await picture(A, 'A-disabled-click-still-review-required');
        return false;
    }

    await waitUntil(() => ipc(channel, 'ipc-result').some(row => row.success === true), 'native abandon IPC success receipt');
    report.ipc = ipc(channel);
    report.ipcReceipt = ipc(channel, 'ipc-result');
    report.http = http();
    assert.equal(report.ipc.length, 1);
    assert.equal(report.ipcReceipt.length, 1);
    assert.equal(report.http.length, 1);
    assert.equal(report.http[0].status, 200);
    assert.equal(report.http[0].body.admissionId, report.checked.workId);
    assert.equal(report.http[0].body.confirm, true);
    assert.equal(report.http[0].response.request.state, 'abandoned');
    assert.equal(report.http[0].response.request.id, report.checked.workId);
    assert.equal(report.http[0].response.replayed, false);
    return true;
};

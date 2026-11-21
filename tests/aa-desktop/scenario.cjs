'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const openReadOnlyPwa = require('../ordinary-tools/pwa.cjs');
const createOwnerPost = require('../approval-restore/owner.cjs');

module.exports = async ({ clients: { A }, out, result, service, cert, click, evalJs, waitUntil, stop, start, picture, sha, aa }) => {
    const { calls, childReport, markers, parentText, release } = aa;
    const descriptor = service.descriptors.A.preSubmit;
    const panel = '.native-sync-execution-status';
    const task = '.native-sync-aa-task';
    const q = JSON.stringify;
    const ownerPost = createOwnerPost({ origin: service.origin, out, cert });
    const serverRequire = createRequire(path.join(result.candidate, 'apps/server/package.json'));
    const pwa = await openReadOnlyPwa({ service, out, cert, request: ownerPost, puppet: serverRequire('puppeteer') });
    const { page } = await pwa.inspect();
    const observerWrites = [];
    page.on('request', req => {
        if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method())) observerWrites.push(new URL(req.url()).pathname);
    });
    const observer = {
        async task(id, states, pictureName) {
            const selector = '.native-aa-task[data-task-id="' + id + '"]';
            await page.waitForFunction((selector, states) => states.includes(document.querySelector(selector)?.dataset.state), {}, selector, states);
            const {state, work} = await page.$eval(selector, element => ({state:element.dataset.state,work:element.closest('[data-exec-id]')?.dataset.execId}));
            const heading = await page.$eval(selector + ' > summary', element => element.innerText);
            await page.$eval(selector, element => element.scrollIntoView({ block: 'center' }));
            const controls = await page.evaluate(() => [...document.querySelectorAll('button:not([disabled])')]
                .map(button => button.innerText).filter(label => /请求停止|取消本次|批准|拒绝|发送|允许/.test(label)));
            assert.deepEqual(controls, []);
            assert.equal(await page.$eval('#message-text', input => input.disabled), true);
            if (pictureName) await page.screenshot({ path: path.join(out, pictureName + '.png') });
            return { id, state, work, heading, controls };
        },
        async report(id) {
            const selector = '.native-aa-task[data-task-id="' + id + '"]';
            await page.click(selector + ' > summary');
            await page.click(selector + ' .native-result-read');
            await page.waitForFunction(report => document.querySelector('#native-task-result pre')?.innerText.includes(report), {}, childReport);
            await page.screenshot({ path: path.join(out, 'pwa-aa-report.png') });
        },
    };
    async function select(client) {
        if (!await evalJs(client, "document.querySelector('#tabContentAgents').classList.contains('active')")) {
            await click(client, '.sidebar-tab-button[data-tab="agents"]');
        }
        await click(client, '#agentList > li .agent-name', 'Synthetic shared');
        await waitUntil(async () => (await evalJs(client,
            'window.VCPStateChannels.get("conversation.current").get()')).topicId === descriptor.topicId, 'shared topic selected');
        await waitUntil(async () => (await evalJs(client,
            'window.chatAPI.getNativeDeletionContext(' + q(descriptor) + ')'))?.kind === 'shared', 'desktop shared ownership');
    }
    async function send(client, marker) {
        await evalJs(client, `(() => {
            const input = document.querySelector('#messageInput');
            input.focus();
            input.value = ${q(marker)};
            input.dispatchEvent(new Event('input', {bubbles:true}));
        })()`);
        await click(client, '#sendMessageBtn');
    }
    async function desktopTask(client, id, states, stopAllowed) {
        return waitUntil(async () => {
            const tasks = await evalJs(client, `[...document.querySelectorAll(${q(task)})].map(element => ({
                id: element.dataset.taskId, state: element.dataset.state,
                heading: element.querySelector('summary').textContent,
                work: element.closest('[data-work-id]')?.dataset.workId,
                stop: [...element.querySelectorAll('button')].some(button => button.textContent === '请求停止 AA' && !button.disabled),
            }))`);
            return tasks.find(item => (!id || item.id === id) && states.includes(item.state) && (stopAllowed === undefined || item.stop === stopAllowed));
        }, 'desktop AA task ' + states.join('/'), 25000);
    }
    async function reveal(client, id) {
        const summary = panel + ' > summary';
        if (!await evalJs(client, `document.querySelector(${q(panel)}).open`)) await click(client, summary);
        const row = task + '[data-task-id="' + id + '"]';
        if (!await evalJs(client, `document.querySelector(${q(row)}).open`)) await click(client, row + ' > summary');
        return row;
    }
    const sends = marker => service.requests.filter(row => row.route.endsWith('/session-send') && row.body?.message?.content === marker);
    const firstChild = marker => calls(marker).filter(call => call.role === 'child' && call.round === 1);
    const continuation = marker => calls(marker).find(call => call.role === 'parent' && call.delegationId);
    const active = ['accepted', 'running', 'waiting'];
    const halted = ['cancelled', 'stopped'];
    try {
        await select(A);
        const loaded = await A.command('loaded-sources', {
            main: ['apps/desktop/modules/services/nativeSync/sharedRuntime.js', 'apps/desktop/modules/services/nativeSync/queries.js'],
            renderer: ['apps/desktop/modules/renderer/nativeExecutionStatus.js'],
        });
        assert.equal(loaded.main.length, 2);
        assert.equal(loaded.renderer.length, 1);
        for (const source of [...loaded.main, ...loaded.renderer]) {
            assert.equal(source.sha256, sha(path.join(result.candidate, source.file)));
        }
        assert.equal(await evalJs(A, 'typeof window.chatAPI.stopNativeTask'), 'function');
        const preload = 'apps/desktop/preloads/bundled/dist/chat.cjs';
        result.aaLoaded = {...loaded, preload: {file:preload, sha256:sha(path.join(result.candidate, preload))}};
        await send(A, markers.desktop);
        await waitUntil(() => firstChild(markers.desktop).length === 1, 'one native child launch');
        const before = await desktopTask(A, null, active, true);
        assert.ok(before.work);
        assert.equal(sends(markers.desktop)[0].response.workId, before.work);
        const during = await observer.task(before.id, active, 'pwa-aa-running');
        assert.equal(during.work, before.work);
        await reveal(A, before.id);
        await picture(A, 'desktop-aa-before-close');
        await stop('A');

        const reopened = await start('A-reopened', 'A');
        await select(reopened);
        assert.equal(result.A.profileDigest, result['A-reopened'].profileDigest);
        const after = await desktopTask(reopened, before.id, active, true);
        assert.equal(after.work, before.work);
        assert.equal(firstChild(markers.desktop).length, 1);
        assert.equal(sends(markers.desktop).length, 1);
        assert.ok(after.stop, 'the original submitting desktop can request AA stop');
        const row = await reveal(reopened, before.id);
        await picture(reopened, 'desktop-aa-reopened');
        await click(reopened, row + ' button', '请求停止 AA');
        const cancelling = await desktopTask(reopened, before.id, ['cancelling']);
        assert.equal(cancelling.stop, false);
        release(markers.desktop);
        const settled = await desktopTask(reopened, before.id, halted);
        assert.equal(settled.stop, false);
        const observedStop = await observer.task(before.id, halted, 'pwa-aa-stopped');
        assert.equal(observedStop.work, before.work);
        await picture(reopened, 'desktop-aa-stopped');
        await waitUntil(async () => (await evalJs(reopened, "document.querySelector('#chatMessages').innerText")).includes(parentText), 'original parent response saved');
        assert.equal(continuation(markers.desktop).delegationId, before.id);
        assert.equal(firstChild(markers.desktop).length, 1);
        assert.equal(sends(markers.desktop).length, 1);
        const stopRequests = service.requests.filter(row => row.route.endsWith('/task-stop'));
        assert.equal(stopRequests.length, 1);
        assert.equal(stopRequests[0].status, 200);
        assert.equal(stopRequests[0].body.nativeTaskId, before.id);
        assert.equal(stopRequests[0].body.workId, before.work);

        await send(reopened, markers.complete);
        await waitUntil(() => firstChild(markers.complete).length === 1, 'second native child launch');
        await waitUntil(() => continuation(markers.complete), 'parent returned a native placeholder');
        const childId = continuation(markers.complete).delegationId;
        const completeBefore = await desktopTask(reopened, childId, active);
        await observer.task(childId, active);
        release(markers.complete);
        const completeAfter = await desktopTask(reopened, childId, ['completed']);
        assert.equal(completeAfter.work, completeBefore.work);
        const completeRow = await reveal(reopened, childId);
        await click(reopened, completeRow + ' button', '查看已核对报告');
        await waitUntil(async () => (await evalJs(reopened, "document.querySelector('.native-sync-task-result pre').innerText")).includes(childReport), 'original desktop report');
        await picture(reopened, 'desktop-aa-report');
        const observedComplete = await observer.task(childId, ['completed']);
        assert.equal(observedComplete.work, completeAfter.work);
        await observer.report(childId);
        assert.equal(firstChild(markers.complete).length, 1);
        assert.equal(sends(markers.complete).length, 1);
        const pwaResult = await pwa.inspect();
        assert.deepEqual(pwaResult.errors, []);
        assert.deepEqual(pwaResult.writes, []);
        assert.deepEqual(observerWrites, []);
        result.aaDesktop = {
            stop: { before, after, cancelling, settled, desktopSends: sends(markers.desktop).length, childLaunches: firstChild(markers.desktop).length, parentPlaceholder: before.id, stopRequests: stopRequests.length },
            complete: { before: completeBefore, after: completeAfter, desktopSends: sends(markers.complete).length, childLaunches: firstChild(markers.complete).length, report: childReport },
            observer: { browser: pwaResult.browser, viewport: {width:390,height:844}, during, stopped: observedStop, completed: observedComplete, report: childReport, unauthorizedControls: 0, executionWrites: [] },
        };
    } finally {
        release(markers.desktop);
        release(markers.complete);
        await pwa.close();
    }
};

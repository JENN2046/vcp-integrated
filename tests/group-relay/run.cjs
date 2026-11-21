'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { setTimeout: delay } = require('node:timers/promises');
const { start } = require('../integration/service.cjs');
const { createFixture } = require('./fixture.cjs');
const { launch, mobileControl, openPwa } = require('./pwa.cjs');

const candidate = path.resolve(__dirname, '../..');
const requireServer = createRequire(path.join(candidate, 'apps/server/package.json'));
const baselineRevision = '2c88e4aad704ac3f089620ce4c481b572c841228';

async function waitUntil(check, label, timeout = 12000) {
    const until = Date.now() + timeout;
    do {
        const result = await check();
        if (result) return result;
        await delay(30);
    } while (Date.now() < until);
    throw Error('Timed out waiting for ' + label);
}

async function main() {
    const [scenario = 'finish', mobileBuild] = process.argv.slice(2);
    assert.ok(['baseline', 'legacy-host', 'finish', 'cut', 'crash'].includes(scenario));
    const baseline = scenario === 'baseline' || scenario === 'legacy-host';
    assert.ok(scenario !== 'baseline' || mobileBuild, 'Supply the PWA build from the pinned baseline archive');
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-group-relay-'));
    console.log(scenario + ' ' + out);
    const evidence = { scenario, baselineRevision: baseline ? baselineRevision : null };
    const cert = path.join(out, 'fixture-cert.pem');
    const key = path.join(out, 'fixture-key.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
        '-subj', '/CN=Synthetic group relay fixture', '-addext', 'subjectAltName=IP:127.0.0.1',
        '-keyout', key, '-out', cert], { stdio: 'ignore' });
    const groupRelay = createFixture();
    let service, browser, db, owner, observer;
    const exits = [];
    try {
        try {
            service = await start({ out, candidate, cert, key, waitUntil,
                trace: (event, data) => { if (event === 'backend-exit') exits.push(data); },
                serverRevision: baseline ? baselineRevision : undefined, mobileBuild, groupRelay });
        } finally {
            fs.rmSync(key, { force: true });
        }
        evidence.mobile = await service.checkMobile();
        browser = await launch(requireServer('puppeteer'), cert);
        evidence.browser = await browser.version();
        const request = mobileControl(service, cert, out);
        [owner, observer] = await Promise.all([
            openPwa({ browser, service, request, execute: true }), openPwa({ browser, service, request }),
        ]);
        evidence.servedBundle = await owner.page.$eval('script[src]', async script => {
            const response = await fetch(script.src);
            const digest = await crypto.subtle.digest('SHA-256', await response.arrayBuffer());
            return { name: new URL(script.src).pathname.split('/').at(-1),
                sha256: [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('') };
        });
        const stagedBundle = path.join(out, 'runtime-box/Plugin/NativeSync/mobile-dist/assets', evidence.servedBundle.name);
        assert.equal(evidence.servedBundle.sha256, createHash('sha256').update(fs.readFileSync(stagedBundle)).digest('hex'));
        assert.deepEqual(await observer.controls(), { composerDisabled: true, cancelButtons: 0 });
        const session = await owner.request('session');
        assert.equal(session.status, 200);
        const features = session.data.sharedFeatures;
        assert.equal(features.includes('group-cancel-remaining-v1'), !baseline);
        db = new DatabaseSync(path.join(service.data, 'central.sqlite'), { readOnly: true });
        const jobs = () => db.prepare('SELECT id,request_id,state,cancel_requested,error_code FROM mobile_executions WHERE topic_key=? ORDER BY rowid').all(owner.topic);
        const steps = id => db.prepare('SELECT id,state,attempts,reply_message_id,error_code FROM mobile_execution_steps WHERE job_id=? ORDER BY step_index').all(id);
        const counts = (offset = 0) => ['A', 'B', 'C'].map(member => service.calls.slice(offset).filter(call => call.member === member).length);
        const history = async () => {
            const response = await owner.request('conversations/' + owner.topic + '?after=0');
            assert.equal(response.status, 200);
            return response.data.messages.map(row => ({ id: row.id, role: row.message.role, content: row.message.content }));
        };
        const admission = id => ({ ...db.prepare('SELECT state,dispatched FROM shared_admissions WHERE id=?').get(id) });
        const native = id => db.prepare('SELECT id,ordinal,state FROM shared_native_requests WHERE admission_id=? ORDER BY ordinal').all(id);
        const snapshot = async (job, offset = 0) => {
            const records = await history();
            const journalCounts = db.prepare('SELECT msg_id, count(*) AS n FROM journal WHERE msg_id IN (SELECT value FROM json_each(?)) GROUP BY msg_id')
                .all(JSON.stringify(records.map(row => row.id)));
            assert.equal(journalCounts.length, records.length);
            assert.ok(journalCounts.every(row => row.n === 1));
            return { job, steps: steps(job.id), counts: counts(offset), history: records, admission: admission(job.id), native: native(job.id), journalCounts };
        };
        const take = (page, name) => page.screenshot({ path: path.join(out, name + '.png'), fullPage: true });
        await owner.message('RELAY_ROUND_ONE');
        const first = await waitUntil(() => {
            const [job] = jobs();
            if (job && steps(job.id).map(step => step.state).join(',') === 'completed,running,queued' && counts().join(',') === '1,1,0') return job;
        }, 'A committed / B streaming / C queued');
        for (const client of [owner, observer]) {
            await client.page.waitForFunction(() =>
                [...document.querySelectorAll('#history .bubble')].some(node => node.textContent === 'RELAY_A_FINAL') &&
                [...document.querySelectorAll('#shared-live-replies .bubble')].some(node => node.textContent === 'RELAY_B_PARTIAL'));
        }
        const selector = '[' + (baseline ? 'data-cancel-id' : 'data-cancel-remaining-id') + '="' + first.id + '"]';
        await owner.page.waitForSelector(selector, { visible: true });
        if (scenario === 'legacy-host') {
            evidence.legacyControl = await owner.page.$eval(selector, button => button.textContent.trim());
            assert.equal(evidence.legacyControl, '中止本轮群聊');
            assert.equal(await owner.page.$('[data-cancel-remaining-id]'), null);
        }
        assert.deepEqual(await observer.controls(), { composerDisabled: true, cancelButtons: 0 });
        evidence.before = await snapshot(first);
        evidence.before.providerBConnected = !groupRelay.closed;
        assert.equal(evidence.before.providerBConnected, true);
        assert.deepEqual(evidence.before.history.map(row => row.content), ['RELAY_ROUND_ONE', 'RELAY_A_FINAL']);
        await Promise.all([take(owner.page, 'owner-before'), take(observer.page, 'observer-before')]);
        if (!baseline) groupRelay.dropNextAck();
        await owner.page.click(selector);
        await waitUntil(() => service.requests.some(row => row.route.endsWith('/' + first.id + (baseline ? '/cancel' : '/cancel-remaining')) &&
            (baseline ? row.status === 202 : row.dropped)), 'actual cancellation click reached server');
        if (baseline) {
            await waitUntil(() => groupRelay.closed && jobs()[0].state !== 'cancelling', 'legacy stop aborted B');
            evidence.after = await snapshot(jobs()[0]);
            evidence.after.providerBConnected = !groupRelay.closed;
            assert.notEqual(evidence.after.steps[1].state, 'completed');
            assert.equal(evidence.after.steps[2].state, 'cancelled');
            assert.deepEqual(evidence.after.counts, [1, 1, 0]);
            await owner.text('RELAY_A_FINAL');
            await take(owner.page, 'owner-after');
            return;
        }
        await owner.text('请核对本轮接力状态');
        assert.equal(service.requests.filter(row => row.route === '/mobile/api/executions/' + first.id + '/cancel-remaining').length, 1);
        evidence.browserObservedLostAck = true;
        assert.deepEqual(observer.writes, [], 'read-only browser emitted no execution writes through its UI');
        evidence.observerUiWrites = [...observer.writes];
        const action = 'executions/' + first.id + '/cancel-remaining';
        const denied = await observer.request(action, {});
        assert.ok([403, 404].includes(denied.status));
        evidence.observerDenial = { status: denied.status, code: denied.data.error?.code };
        await owner.page.reload({ waitUntil: 'domcontentloaded' });
        await owner.page.waitForFunction(topic => document.querySelector('#topic-select')?.value === topic, {}, owner.topic);
        await owner.text('RELAY_B_PARTIAL');
        const requestStatus = () => owner.request('conversations/' + owner.topic + '/execution-request?' + new URLSearchParams({ requestId: first.request_id }));
        const reopened = await requestStatus();
        assert.equal(reopened.status, 200);
        assert.equal(reopened.data.executions.length, 1);
        assert.equal(reopened.data.executions[0].id, first.id);
        assert.equal(reopened.data.executions[0].remainingCancelled, true);
        const replay = await owner.request(action, {});
        assert.equal(replay.status, 202);
        assert.equal(replay.data.id, first.id);
        assert.equal(replay.data.remainingCancelled, true);
        assert.equal(groupRelay.closed, false);
        assert.deepEqual(steps(first.id).map(step => step.state), ['completed', 'running', 'cancelled']);
        evidence.retained = { ...await snapshot(jobs()[0]), reopened: true, replaySameWork: true, providerBConnected: !groupRelay.closed };
        assert.deepEqual(evidence.retained.history, evidence.before.history);
        for (const client of [owner, observer]) {
            await client.page.waitForFunction(id => {
                const job = document.querySelector('[data-exec-id="' + id + '"][data-state="running"]');
                const members = job?.querySelectorAll('.group-steps li');
                return members?.length === 3 && members[0].textContent.includes('A · 回复已保存') &&
                    members[1].textContent.includes('B · 服务端执行中') && members[2].textContent.includes('C · 已取消');
            }, {}, first.id);
        }
        assert.equal(groupRelay.closed, false, 'B must still be connected when the observer sees cancelled C');
        evidence.retained.observerSawCancelledSuffixWhileBWasRunning = true;
        await Promise.all([take(owner.page, 'owner-reopened'), take(observer.page, 'observer-reopened')]);

        if (scenario === 'finish') {
            groupRelay.completeB();
            await waitUntil(() => jobs()[0].state === 'cancelled', 'remaining-cancel round settled');
            for (const client of [owner, observer]) {
                await client.page.waitForFunction(id => {
                    const job = document.querySelector('[data-exec-id="' + id + '"][data-state="cancelled"]');
                    const recorded = [...document.querySelectorAll('#history [data-message-id]')];
                    return job?.textContent.includes('剩余接力已取消') && recorded.some(row => row.textContent.includes('RELAY_B_FINAL'));
                }, {}, first.id);
            }
        } else {
            if (scenario === 'cut') groupRelay.cutB();
            else evidence.crash = await service.restartAfterCrash();
            await waitUntil(() => jobs()[0].state === 'review_required', 'uncertain B held for review');
            if (scenario === 'crash') {
                for (const client of [owner, observer]) {
                    await client.page.reload({ waitUntil: 'domcontentloaded' });
                    await client.page.waitForFunction(topic => document.querySelector('#topic-select')?.value === topic, {}, client.topic);
                }
            }
            for (const client of [owner, observer]) {
                await client.page.waitForSelector('[data-exec-id="' + first.id + '"][data-state="review_required"]');
                await client.text('RELAY_B_PARTIAL');
            }
            if (scenario === 'crash') {
                await Promise.all([owner.text('仅显示目前可核对的临时片段'), observer.text('仅显示目前可核对的临时片段')]);
                const saved = db.prepare('SELECT group_stop_preview FROM mobile_executions WHERE id=?').get(first.id);
                evidence.crashPreview = JSON.parse(saved.group_stop_preview);
                assert.equal(evidence.crashPreview.nativeRequestId, evidence.before.steps[1].id);
                for (const client of [owner, observer]) {
                    const text = await client.page.$eval('[data-native-request="' + evidence.crashPreview.nativeRequestId + '"] .bubble', node => node.textContent);
                    assert.equal(text, 'RELAY_B_PARTIAL');
                }
                assert.equal(evidence.crashPreview.text, 'RELAY_B_PARTIAL');
                assert.equal(evidence.crashPreview.hash, createHash('sha256').update('RELAY_B_PARTIAL').digest('hex'));
            }
            evidence.recoveredPartial = await owner.page.evaluate(() =>
                [...document.querySelectorAll('article .bubble')].map(node => node.textContent.trim()).filter(text => text === 'RELAY_B_PARTIAL'));
            assert.deepEqual(evidence.recoveredPartial, ['RELAY_B_PARTIAL']);
            assert.equal(await owner.page.$$eval('#history .bubble', bubbles =>
                bubbles.some(node => node.textContent.includes('RELAY_B_PARTIAL'))), false);
        }
        evidence.after = await snapshot(jobs()[0]);
        assert.deepEqual(evidence.after.counts, [1, 1, 0]);
        assert.equal(evidence.after.steps[0].reply_message_id, evidence.before.steps[0].reply_message_id);
        assert.deepEqual(evidence.after.history.slice(0, 2), evidence.before.history);
        assert.equal(evidence.after.steps[2].state, 'cancelled');
        assert.equal(evidence.after.steps[2].attempts, 0);
        assert.equal(evidence.after.steps[2].reply_message_id, null);
        assert.ok(!evidence.after.native.some(row => row.ordinal === 2 && row.state !== 'prepared'));
        await Promise.all([take(owner.page, 'owner-after'), take(observer.page, 'observer-after')]);
        assert.deepEqual(evidence.after.admission, { state: scenario === 'finish' ? 'completed' : 'review_required', dispatched: 1 });
        assert.deepEqual(await observer.controls(), { composerDisabled: true, cancelButtons: 0 });
        assert.deepEqual(owner.errors, []);
        assert.deepEqual(observer.errors, []);
        assert.deepEqual(observer.writes, ['/mobile/api/' + action], 'only explicit negative-authority probe performs a POST');
        evidence.observerDenial.explicitTestProbe = true;

        if (scenario === 'finish') {
            assert.equal(evidence.after.steps[1].state, 'completed');
            assert.match(evidence.after.history[2].content, /^RELAY_B_PARTIAL RELAY_B_FINAL$/);
            assert.equal(evidence.after.history.length, 3);
            const offset = service.calls.length;
            groupRelay.finishFutureRounds();
            await owner.message('RELAY_ROUND_TWO');
            const next = await waitUntil(() => jobs().length === 2 && jobs()[1].state === 'completed' && jobs()[1], 'new Work completed in the same topic');
            evidence.next = await snapshot(next, offset);
            assert.deepEqual(evidence.next.counts, [1, 1, 1]);
            assert.deepEqual(evidence.next.history.map(row => row.content), [
                'RELAY_ROUND_ONE', 'RELAY_A_FINAL', 'RELAY_B_PARTIAL RELAY_B_FINAL', 'RELAY_ROUND_TWO',
                'RELAY_A_FINAL', 'RELAY_B_FINAL', 'RELAY_C_FINAL',
            ]);
            assert.equal(new Set(evidence.next.history.map(row => row.id)).size, 7);
            await observer.text('RELAY_C_FINAL');
        } else {
            assert.equal(evidence.after.steps[1].state, 'interrupted');
            assert.equal(evidence.after.steps[1].reply_message_id, null);
            assert.deepEqual(evidence.after.history, evidence.before.history);
            await delay(300);
            assert.deepEqual(counts(), [1, 1, 0]);
        }
    } catch (error) {
        if (owner) await owner.page.screenshot({ path: path.join(out, 'owner-failure.png'), fullPage: true }).catch(() => {});
        if (observer) await observer.page.screenshot({ path: path.join(out, 'observer-failure.png'), fullPage: true }).catch(() => {});
        evidence.failure = error.message;
        throw error;
    } finally {
        if (service) {
            evidence.cancelRequests = service.requests.filter(row => /\/mobile\/api\/executions\/[^/]+\/cancel(?:-remaining)?$/.test(row.route))
                .map(row => ({ route: row.route, status: row.status, dropped: Boolean(row.dropped) }));
            evidence.providerCalls = service.calls.filter(call => call.member).map(call => ({ member: call.member, id: call.id, stream: call.stream }));
            evidence.ownerWrites = owner?.writes;
            evidence.observerWrites = observer?.writes;
            evidence.browserErrors = [...owner?.errors || [], ...observer?.errors || []];
        }
        await browser?.close();
        db?.close();
        await service?.close();
        if (service) assert.deepEqual(exits.at(-1), { code: 0, signal: null });
        evidence.exits = exits;
        if (service) {
            evidence.backendSources = JSON.parse(fs.readFileSync(path.join(out, 'backend-loaded.json')));
            for (const source of evidence.backendSources) {
                const expected = baseline
                    ? execFileSync('git', ['show', baselineRevision + ':' + source.file], { cwd: candidate })
                    : fs.readFileSync(path.join(out, 'runtime-box', source.file.slice('apps/server/'.length)));
                assert.equal(source.sha256, createHash('sha256').update(expected).digest('hex'), source.file);
            }
            assert.ok(evidence.backendSources.some(source => source.file.endsWith('/groupTurn.js')));
            assert.ok(evidence.backendSources.some(source => source.file.endsWith('/portal.js')));
        }
        fs.writeFileSync(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });

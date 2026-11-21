'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { createRequire } = require('node:module');
const { DatabaseSync } = require('node:sqlite');
const { setTimeout: delay } = require('node:timers/promises');
const { startFixture, waitUntil } = require('../aa-delegation/fixture.cjs');
const { createFixture } = require('../group-relay/fixture.cjs');
const { launch, mobileControl, openPwa } = require('../group-relay/pwa.cjs');

const candidate = path.resolve(__dirname, '../..');
const serverRequire = createRequire(path.join(candidate, 'apps/server/package.json'));
const [scenario = 'late', receiptPath] = process.argv.slice(2);
const observationDelayMs = 4400;
const expectsSettlement = scenario.startsWith('settled-');
const finishesEarly = scenario.endsWith('early');
const followUp = 'SECOND_GROUP_SUBMISSION';
assert.ok(['late', 'early', 'owner-ack', 'settled-early', 'settled-late'].includes(scenario),
    'Usage: node tests/stage-review/uncut.cjs [late|early|owner-ack|settled-early|settled-late] [receipt.json]');

async function main() {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-stage-uncut-'));
    console.log('Isolated uncut group fixture ' + out);
    const groupRelay = createFixture();
    groupRelay.finishFutureRounds();
    let releaseParent;
    const parentFinalGate = new Promise(resolve => { releaseParent = resolve; });
    let fx, browser, db;
    try {
        fx = await startFixture({
            out, candidate, groupRelay, singleChildRound: true,
            selectParent: body => body.messages.some(message =>
                message.role === 'system' && JSON.stringify(message.content).includes('GROUP_RELAY_MEMBER_C')) &&
                (!expectsSettlement || !body.messages.some(message =>
                    message.role === 'user' && JSON.stringify(message.content).includes(followUp))),
            async beforeParentFinal({ waitForChildDispatch }) {
                await waitForChildDispatch();
                if (finishesEarly) await parentFinalGate;
            },
        });
        const { service, cert } = fx;
        browser = await launch(serverRequire('puppeteer'), cert);
        const owner = await openPwa({ browser, service, request: mobileControl(service, cert, out), execute: true });
        const route = 'conversations/' + owner.topic;
        const submission = { requestId: randomUUID(), text: fx.markers.complete };
        const accepted = await owner.request(route + '/messages', submission);
        assert.equal(accepted.status, 202);
        const workId = accepted.data.id;
        assert.ok(workId);
        db = new DatabaseSync(path.join(service.data, 'central.sqlite'), { readOnly: true });

        const job = () => db.prepare('SELECT state,error_code,group_stop_index,review_resolved FROM mobile_executions WHERE id=?').get(workId);
        const task = () => db.prepare('SELECT native_task_id,state,review_required,error_code FROM mobile_native_tasks WHERE execution_id=?').get(workId);
        const admission = () => db.prepare('SELECT state,native_terminal,reply_seq FROM shared_admissions WHERE id=?').get(workId);
        const childRequests = () => db.prepare('SELECT id,state FROM shared_native_child_requests WHERE work_id=?').all(workId);
        const calls = () => service.calls.map(({ member, role, round }) => ({ member, role, round }));
        const journal = () => db.prepare('SELECT seq,msg_id,action FROM journal WHERE topic_id=? ORDER BY seq').all(owner.topic);
        const submitNext = () => owner.request(route + '/messages', { requestId: randomUUID(), text: followUp });
        const workCard = '[data-exec-id="' + workId + '"]';
        const readWork = async () => {
            const response = await owner.request(route + '/execution-request?' + new URLSearchParams({ requestId: submission.requestId }));
            assert.equal(response.status, 200);
            const [work] = response.data.executions;
            assert.equal(work.id, workId);
            return work;
        };

        async function snapshot() {
            const history = await owner.request(route + '?after=0');
            assert.equal(history.status, 200);
            const work = await readWork();
            const messages = history.data.messages.map(row => ({ id: row.id, role: row.message.role }));
            assert.deepEqual(messages.map(row => row.role), ['user', 'assistant', 'assistant', 'assistant']);
            assert.deepEqual(messages.map(row => row.id), journal().map(row => row.msg_id));
            assert.deepEqual(work.steps.map(step => step.state), ['completed', 'completed', 'completed']);
            const speakerRequests = db.prepare('SELECT ordinal,state FROM shared_native_requests WHERE admission_id=? ORDER BY ordinal').all(workId);
            assert.deepEqual(speakerRequests.map(step => step.state), ['model_terminal', 'model_terminal', 'model_terminal']);
            return {
                job: job(), admission: admission(), task: task(), childRequests: childRequests(), speakerRequests,
                ledger: db.prepare('SELECT step_index,state,attempts,reply_message_id FROM mobile_execution_steps WHERE job_id=? ORDER BY step_index').all(workId),
                provider: calls(), pwa: { state: work.state, stepCount: work.stepCount },
                history: messages, journal: journal(),
            };
        }

        async function observeCard(state, taskState) {
            const selector = workCard + '[data-state="' + state + '"]';
            await owner.page.waitForSelector(selector + ' .native-aa-task[data-state="' + taskState + '"]', { visible: true });
            const evidence = await owner.page.$eval(selector, card => ({
                status: card.querySelector('.execution-row span').textContent.trim(),
                speakers: [...card.querySelectorAll('.group-steps li')].map(step => step.textContent.trim()),
                task: card.querySelector('.native-aa-task summary').textContent.trim(),
                reviewControls: card.querySelectorAll('.review-state button, .review-state input').length,
            }));
            assert.equal(evidence.speakers.length, 3);
            assert.equal(evidence.reviewControls, 0);
            return evidence;
        }

        async function verifySettled(receipt) {
            await waitUntil(() => job()?.state === 'completed', 'Work settles with the AA result');
            receipt.after = await snapshot();
            assert.deepEqual({ ...receipt.after.job }, { state: 'completed', error_code: null, group_stop_index: null, review_resolved: 0 });
            assert.deepEqual({ ...receipt.after.admission }, { state: 'completed', native_terminal: 1, reply_seq: 4 });
            assert.equal(receipt.after.task.state, 'completed');
            assert.equal(receipt.after.task.review_required, 0);
            assert.equal(receipt.after.childRequests.length, 1);
            assert.equal(receipt.after.childRequests[0].state, 'model_terminal');
            assert.deepEqual(receipt.after.ledger.map(row => [row.step_index, row.state, row.attempts]),
                [[-1, 'pending', 0], [0, 'completed', 1], [1, 'completed', 1], [2, 'completed', 1]]);
            assert.deepEqual(receipt.after.ledger.slice(1).map(row => row.reply_message_id),
                receipt.after.history.slice(1).map(row => row.id));
            assert.deepEqual(receipt.after.provider, [
                { member: 'A', role: undefined, round: undefined }, { member: 'B', role: undefined, round: undefined },
                { member: undefined, role: 'parent', round: 1 }, { member: undefined, role: 'parent', round: 2 },
                { member: undefined, role: 'child', round: 1 },
            ]);
            receipt.after.card = await observeCard('completed', 'completed');
            const work = await readWork();
            assert.equal(work.reviewResolved, false);
            assert.deepEqual(work.steps.map(step => step.name), ['A', 'B', 'C']);
            assert.equal(work.nativeTasks.length, 1);
            assert.equal(work.nativeTasks[0].nativeTaskId, receipt.after.task.native_task_id);
            assert.equal(work.nativeTasks[0].stepId, work.steps[2].id);
            assert.equal(work.toolInvocations.length, 1);
            const [tool] = work.toolInvocations;
            assert.equal(tool.pluginName, 'AgentAssistant');
            assert.equal(tool.state, 'returned');
            assert.equal(tool.invocationId, work.nativeTasks[0].invocationId);
            receipt.after.tool = { id: tool.invocationId, plugin: tool.pluginName, state: tool.state };
            await owner.page.click(workCard + ' .native-aa-task summary');
            await owner.page.click(workCard + ' .native-result-read');
            await owner.page.waitForFunction(report =>
                document.querySelector('#native-task-result pre')?.textContent.includes(report), {}, fx.childReport);
            receipt.after.reportVerified = true;
            await owner.page.click('#native-task-result button');

            const replay = await owner.request(route + '/messages', submission);
            receipt.replay = { http: replay.status, replayed: replay.data.replayed, sameWork: replay.data.id === workId };
            assert.deepEqual(receipt.replay, { http: 202, replayed: true, sameWork: true });
            await owner.message(followUp);
            const next = await waitUntil(() => db.prepare(`
                SELECT id,state FROM mobile_executions WHERE topic_key=? AND id<>? AND state='completed'
            `).get(owner.topic, workId), 'new Work finishes A, B, C in the same topic');
            await owner.page.waitForSelector('[data-exec-id="' + next.id + '"][data-state="completed"]', { visible: true });
            const after = await owner.request(route + '?after=0');
            assert.equal(after.status, 200);
            const rows = after.data.messages.map(row => ({ id: row.id, role: row.message.role, content: row.message.content }));
            assert.deepEqual(rows.map(row => row.id), journal().map(row => row.msg_id));
            assert.equal(new Set(rows.map(row => row.id)).size, 8);
            assert.deepEqual(rows.slice(0, 4).map(({ id, role }) => ({ id, role })), receipt.after.history);
            assert.ok(rows[3].content.includes(fx.parentText), 'C reply is in History');
            assert.deepEqual(rows.slice(4).map(row => row.content), [followUp, 'RELAY_A_FINAL', 'RELAY_B_FINAL', 'RELAY_C_FINAL']);
            const nextCalls = calls().slice(receipt.after.provider.length);
            assert.deepEqual(nextCalls.map(row => row.member), ['A', 'B', 'C']);
            assert.ok(nextCalls.every(row => row.role === undefined));
            assert.deepEqual((await readWork()).toolInvocations, work.toolInvocations);
            const nextAdmission = db.prepare('SELECT state,native_terminal,reply_seq FROM shared_admissions WHERE id=?').get(next.id);
            assert.deepEqual({ ...nextAdmission }, { state: 'completed', native_terminal: 1, reply_seq: 8 });
            assert.deepEqual(owner.errors, []);
            assert.equal(owner.writes.filter(url => url.endsWith('/resolve')).length, finishesEarly ? 0 : 1);
            receipt.followUp = { work: next, admission: nextAdmission, provider: nextCalls, history: rows };
        }

        const sourceFiles = ['mobile/groupTurn.js', 'sync/sharedTurns.js', 'sync/sharedNative.js', 'sync/sharedTaskRequests.js'];
        if (expectsSettlement) sourceFiles.push('mobile/nativeTasks.js', 'mobile/sharedGroups.js');
        const receipt = {
            scenario, node: process.version, browser: await browser.version(), workId, requestId: submission.requestId,
            revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: candidate, encoding: 'utf8' }).trim(),
            sourceHashes: Object.fromEntries(sourceFiles.map(name => [name, createHash('sha256').update(
                fs.readFileSync(path.join(out, 'runtime-box/Plugin/NativeSync', name))).digest('hex')])),
        };
        await waitUntil(() => task()?.state === 'running' && childRequests()[0]?.state === 'dispatched',
            'last speaker AA reaches the child Provider');

        if (expectsSettlement) {
            receipt.revisionIsCheckoutBase = true;
            const asset = await owner.page.$eval('script[type="module"][src]', node => new URL(node.src).pathname);
            assert.match(asset, /^\/mobile\/assets\/[^/]+\.js$/);
            receipt.pwaBundle = { asset, sha256: createHash('sha256')
                .update(fs.readFileSync(path.join(out, 'runtime-box/Plugin/NativeSync/mobile-dist', asset.slice('/mobile/'.length))))
                .digest('hex') };
            if (finishesEarly) {
                fx.release(fx.markers.complete);
                await waitUntil(() => task()?.state === 'completed', 'AA completes before C final');
                assert.equal(job().state, 'running');
                assert.equal(journal().length, 3);
                receipt.beforeC = { job: job(), admission: admission(), task: task(), journal: journal() };
                receipt.beforeC.card = await observeCard('running', 'completed');
                releaseParent();
            } else {
                await waitUntil(() => job()?.state === 'recovering' && journal().length === 4,
                    'three member replies persist while Work safely awaits live AA');
                receipt.whileChildRunning = await snapshot();
                assert.deepEqual({ ...receipt.whileChildRunning.job }, { state: 'recovering', error_code: null, group_stop_index: null, review_resolved: 0 });
                assert.equal(receipt.whileChildRunning.admission.state, 'dispatched');
                assert.equal(receipt.whileChildRunning.admission.native_terminal, 0);
                assert.equal(receipt.whileChildRunning.task.state, 'running');
                assert.equal(receipt.whileChildRunning.task.review_required, 0);
                assert.equal(receipt.whileChildRunning.childRequests[0].state, 'dispatched');
                assert.equal(receipt.whileChildRunning.pwa.state, 'recovering');
                receipt.whileChildRunning.card = await observeCard('recovering', 'running');
                assert.match(receipt.whileChildRunning.card.status, /^成员回复已保存，等待原生任务结束/);
                const next = await submitNext();
                receipt.whileChildRunning.followUpDenied = { http: next.status, code: next.data.error?.code };
                assert.deepEqual(receipt.whileChildRunning.followUpDenied, { http: 409, code: 'SHARED_TOPIC_BUSY' });
                const ack = await owner.request('executions/' + workId + '/resolve', { action: 'acknowledge_and_abandon_remaining' });
                receipt.whileChildRunning.reviewProbeDenied = { http: ack.status, code: ack.data.error?.code };
                assert.deepEqual(receipt.whileChildRunning.reviewProbeDenied, { http: 409, code: 'INVALID_REVIEW_RESOLUTION' });
                assert.deepEqual(job(), receipt.whileChildRunning.job);
                assert.deepEqual(admission(), receipt.whileChildRunning.admission);
                fx.release(fx.markers.complete);
            }
            await verifySettled(receipt);
            const observedTask = (receipt.beforeC || receipt.whileChildRunning).task;
            assert.equal(receipt.after.task.native_task_id, observedTask.native_task_id);
            if (finishesEarly) {
                assert.deepEqual(receipt.after.journal.slice(0, 3), receipt.beforeC.journal);
            } else {
                assert.deepEqual(receipt.after.provider, receipt.whileChildRunning.provider);
                assert.deepEqual(receipt.after.history, receipt.whileChildRunning.history);
                assert.deepEqual(receipt.after.journal, receipt.whileChildRunning.journal);
            }
        } else if (scenario === 'early') {
            fx.release(fx.markers.complete);
            await waitUntil(() => task()?.state === 'completed', 'AA completes before C final');
            assert.equal(job().state, 'running');
            releaseParent();
            await waitUntil(() => job()?.state === 'review_required', 'group completion mismatch');
            receipt.after = await snapshot();
            assert.equal(receipt.after.admission.state, 'completed');
            assert.equal(receipt.after.job.error_code, 'GROUP_PLAN_REVIEW_REQUIRED');
            assert.deepEqual(receipt.after.ledger.map(row => [row.step_index, row.state]),
                [[-1, 'pending'], [0, 'completed'], [1, 'completed'], [2, 'completed']]);
        } else {
            await waitUntil(() => job()?.state === 'blocked_config', 'group is held while AA remains live');
            receipt.whileChildRunning = await snapshot();
            assert.equal(receipt.whileChildRunning.task.state, 'running');
            assert.equal(receipt.whileChildRunning.job.error_code, 'SHARED_NATIVE_TERMINAL_REQUIRED');
            assert.equal(receipt.whileChildRunning.admission.state, 'review_required');

            if (scenario === 'owner-ack') {
                const ack = await owner.request('executions/' + workId + '/resolve', { action: 'acknowledge_and_abandon_remaining' });
                assert.equal(ack.status, 200);
                assert.equal(ack.data.state, 'cancelled');
                assert.equal(ack.data.reviewResolved, true);
                receipt.acknowledgement = { http: ack.status, state: ack.data.state, reviewResolved: ack.data.reviewResolved };
                const next = await submitNext();
                assert.equal(next.status, 202);
                assert.notEqual(next.data.id, workId);
                receipt.nextAdmission = { http: next.status, workId: next.data.id, originalAdmission: admission().state,
                    originalTask: task().state, originalChildRequest: childRequests()[0].state };
                assert.equal(receipt.nextAdmission.originalAdmission, 'abandoned');
                assert.equal(receipt.nextAdmission.originalTask, 'running');
                assert.equal(receipt.nextAdmission.originalChildRequest, 'dispatched');
            }

            fx.release(fx.markers.complete);
            await waitUntil(() => task()?.state === 'completed', 'same AA task completes');
            if (scenario === 'owner-ack') {
                receipt.finalTask = task();
            } else {
                await delay(observationDelayMs);
                receipt.observationDelayAfterChildTerminalMs = observationDelayMs;
                receipt.afterChildReturns = await snapshot();
                assert.equal(receipt.afterChildReturns.job.state, 'blocked_config');
                assert.equal(receipt.afterChildReturns.admission.state, 'review_required');
                assert.equal(receipt.afterChildReturns.childRequests[0].state, 'model_terminal');
                assert.deepEqual(receipt.afterChildReturns.provider, receipt.whileChildRunning.provider);
                const next = await submitNext();
                receipt.nextAdmission = { http: next.status, code: next.data.error?.code };
                assert.deepEqual(receipt.nextAdmission, { http: 409, code: 'DEPENDENCY_REVIEW_REQUIRED' });
                const replay = await owner.request(route + '/messages', submission);
                receipt.replay = { http: replay.status, replayed: replay.data.replayed, sameWork: replay.data.id === workId };
                assert.deepEqual(receipt.replay, { http: 202, replayed: true, sameWork: true });
                await assert.rejects(() => service.restartAfterCrash(), /failed to initialize NativeSync/);
                const logs = fs.readFileSync(path.join(out, 'backend.log'), 'utf8');
                assert.match(logs, /Error initializing module for NativeSync: SHARED_NATIVE_TERMINAL_REQUIRED/);
                assert.match(logs, /at Object\.recover .*groupTurn\.js:/);
                receipt.afterRestart = { nativeSyncReady: false, nativeSyncErrors: logs.split('\n')
                    .filter(line => line.includes('Error initializing module for NativeSync') || /at Object\.recover .*groupTurn\.js:/.test(line))
                    .map(line => line.trim().replaceAll(out, '<isolated-runtime>')) };
            }
        }

        const output = receiptPath || path.join(out, 'receipt.json');
        fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n');
        console.log((expectsSettlement ? 'Verified ' : 'Reproduced ') + scenario + ' in ' + output);
    } finally {
        releaseParent();
        db?.close();
        await browser?.close();
        await fx?.close();
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });

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
assert.ok(['late', 'early', 'owner-ack'].includes(scenario), 'Usage: node tests/stage-review/uncut.cjs [late|early|owner-ack] [receipt.json]');

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
                message.role === 'system' && JSON.stringify(message.content).includes('GROUP_RELAY_MEMBER_C')),
            async beforeParentFinal({ waitForChildDispatch }) {
                await waitForChildDispatch();
                if (scenario === 'early') await parentFinalGate;
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
        const submitNext = () => owner.request(route + '/messages', { requestId: randomUUID(), text: 'SECOND_GROUP_SUBMISSION' });

        async function snapshot() {
            const response = await owner.request(route + '/execution-request?' + new URLSearchParams({ requestId: submission.requestId }));
            const history = await owner.request(route + '?after=0');
            assert.equal(response.status, 200);
            assert.equal(history.status, 200);
            const [work] = response.data.executions;
            assert.equal(work.id, workId);
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

        const sourceFiles = ['mobile/groupTurn.js', 'sync/sharedTurns.js', 'sync/sharedNative.js', 'sync/sharedTaskRequests.js'];
        const receipt = {
            scenario, node: process.version, browser: await browser.version(), workId, requestId: submission.requestId,
            revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: candidate, encoding: 'utf8' }).trim(),
            sourceHashes: Object.fromEntries(sourceFiles.map(name => [name, createHash('sha256').update(
                fs.readFileSync(path.join(out, 'runtime-box/Plugin/NativeSync', name))).digest('hex')])),
        };
        await waitUntil(() => task()?.state === 'running' && childRequests()[0]?.state === 'dispatched',
            'last speaker AA reaches the child Provider');

        if (scenario === 'early') {
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
        console.log('Reproduced ' + scenario + ' in ' + output);
    } finally {
        releaseParent();
        db?.close();
        await browser?.close();
        await fx?.close();
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });

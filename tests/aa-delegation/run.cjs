'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { DatabaseSync } = require('node:sqlite');
const { canonicalSourceMessage } = require('../../apps/desktop/modules/services/nativeSync/sourceSnapshot');
const { startFixture, waitUntil } = require('./fixture.cjs');

const candidate = path.resolve(__dirname, '../..');
const [serverRevision, outputPath] = process.argv.slice(2);
const baseline = Boolean(serverRevision && serverRevision !== '--candidate');
assert.ok(!baseline || /^[a-f0-9]{40}$/.test(serverRevision),
    'Usage: node tests/aa-delegation/run.cjs [--candidate | complete baseline commit] [receipt path]');
const sharedSpaceId = 'sharedAB';
const adminRoute = '/admin_api/agent-assistant/delegations';

async function main() {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-aa-delegation-'));
    console.log('Synthetic AgentAssistant run ' + out);
    const evidence = { node: process.versions.node, serverRevision: baseline ? serverRevision : null, cases: {} };
    let fx;
    let db;
    try {
        fx = await startFixture({ out, candidate, ...(baseline ? { serverRevision } : {}) });
        const { service, markers, request, calls, childReport } = fx;
        db = new DatabaseSync(path.join(service.data, 'central.sqlite'), { readOnly: true });
        const checked = async (route, body, actor) => {
            const response = await request(route, body, actor);
            assert.equal(response.status, 200, route + ': ' + JSON.stringify(response.body));
            return response.body;
        };
        const query = (name, params) => name + '?' + new URLSearchParams({ sharedSpaceId, ...params });
        const work = async (workId, actor) => (await checked(query('work', { workId }), undefined, actor)).request;
        const admin = async () => (await checked(adminRoute)).data;
        const taskRoute = (name, { workId, nativeTaskId }) => query(name, { workId, nativeTaskId });
        async function submission(label, sharedId) {
            const context = await checked(query('context', { sharedId }));
            const requestId = randomUUID();
            return { sharedSpaceId, sharedId, requestId, expectedHead: context.head, configHash: context.hash,
                message: canonicalSourceMessage({ id: requestId, role: 'user', content: markers[label], timestamp: Date.now() }, sharedId) };
        }
        const receipts = (marker, workId) => {
            const observed = calls(marker);
            const parents = observed.filter(row => row.role === 'parent');
            const children = observed.filter(row => row.role === 'child');
            return {
                parentRounds: parents.map(row => ({ requestMatchesWork: row.id === workId, stream: row.stream })),
                launches: children.filter(row => row.launch).length,
                childRounds: children.map(row => ({ requestId: row.id ?? null, round: row.round })),
            };
        };
        const workView = row => ({
            state: row.state,
            replySeq: row.replySeq,
            tasks: row.nativeTasks.map(task => ({
                id: task.nativeTaskId,
                state: task.state,
                stopAllowed: task.stopAllowed ?? null,
                stopRequested: task.stopRequested ?? null,
                reviewRequired: task.reviewRequired ?? null,
                hasResult: Boolean(task.resultRef),
                errorCode: task.errorCode ?? null,
            })),
            toolInvocations: row.toolInvocations.map(tool => ({ pluginName: tool.pluginName, state: tool.state })),
        });
        async function admit(label, topic) {
            const marker = markers[label];
            const sharedId = topic.id;
            const body = await submission(label, sharedId);
            const accepted = await checked('session-send', body);
            assert.equal(accepted.replayed, false);
            const workId = accepted.workId;
            await waitUntil(() => calls(marker).some(row => row.role === 'child'), label + ' child provider in flight');
            const active = await waitUntil(async () => {
                const row = await work(workId);
                return baseline ? row.state === 'completed' && row
                    : row.nativeTasks[0]?.state === 'running' &&
                        row.nativeRequests.some(item => item.id === workId && item.state === 'model_terminal') && row;
            }, label + ' Shared Work status');
            const native = await waitUntil(async () => (await admin()).active.find(row => row.taskPromptPreview === marker),
                label + ' native AA active');
            const nativeTaskId = native.id;
            const result = evidence.cases[label] = {
                workId, nativeTaskId, active: workView(active), nativeActiveState: native.status,
                parentNativeState: active.nativeRequests.find(item => item.id === workId)?.state ?? null,
                initialProvider: receipts(marker, workId),
            };
            assert.equal(native.status, 'running');
            assert.equal(result.initialProvider.launches, 1);
            assert.equal(result.initialProvider.childRounds.length, 1);
            if (!baseline) {
                assert.equal(active.state, 'dispatched');
                assert.equal(active.nativeTasks.length, 1);
                assert.equal(active.nativeTasks[0].nativeTaskId, nativeTaskId);
                assert.equal(active.nativeTasks[0].stopAllowed, true);
                assert.equal(result.initialProvider.childRounds[0].requestId, nativeTaskId + '-round-1');
                assert.ok(active.nativeRequests.some(item => item.child === true && item.nativeTaskId === nativeTaskId &&
                    item.id === result.initialProvider.childRounds[0].requestId));
            } else {
                assert.equal(active.nativeTasks.length, 0);
            }
            const replay = async () => {
                const response = await checked('session-send', body);
                assert.equal(response.replayed, true);
                assert.equal(response.workId, workId);
                return { sameWork: true, replayed: true };
            };
            return { marker, workId, nativeTaskId, result, replay };
        }
        async function snapshot(run, state) {
            const row = await waitUntil(async () => {
                const item = await work(run.workId);
                return state(item) && item;
            }, run.marker + ' settles');
            const journal = db.prepare('SELECT msg_id,action FROM journal WHERE msg_id IN (?, ?) ORDER BY seq')
                .all(row.turn.userMessageId, 'reply_' + run.workId);
            const { attempts } = db.prepare('SELECT attempts FROM mobile_executions WHERE id=?').get(row.id);
            assert.equal(attempts, 1);
            return { work: workView(row), attempts, provider: receipts(run.marker, run.workId), journal: journal.map(entry => ({
                action: entry.action, message: entry.msg_id === row.turn.userMessageId ? 'user' : 'assistant',
            })) };
        }

        const completed = await admit('complete', service.topics.preSubmit);
        completed.result.replayWhileActive = await completed.replay();
        assert.deepEqual(receipts(completed.marker, completed.workId), completed.result.initialProvider);
        fx.release(completed.marker);
        const nativeComplete = await waitUntil(async () => (await admin()).recent.find(row => row.id === completed.nativeTaskId),
            'native AA completed');
        assert.equal(nativeComplete.status, 'completed');
        assert.ok(nativeComplete.finalReportPreview.includes(childReport));
        completed.result.after = await snapshot(completed, row => row.state === 'completed');
        const completeProvider = completed.result.after.provider;
        assert.equal(completeProvider.launches, 1);
        assert.equal(completeProvider.childRounds.length, 2);
        assert.equal(completed.result.after.journal.length, 2);
        assert.equal(completeProvider.parentRounds.length, 2);
        assert.ok(completeProvider.parentRounds.every(row => row.requestMatchesWork));
        completed.result.nativeFinalState = nativeComplete.status;
        if (!baseline) {
            assert.equal(completed.result.after.work.tasks[0].state, 'completed');
            assert.equal(completeProvider.childRounds[1].requestId, completed.nativeTaskId + '-round-2');
            const taskResult = await checked(taskRoute('task-result', completed));
            assert.ok(taskResult.content.includes(childReport), 'bound native result contains child report');
            assert.equal(taskResult.task.resultHash, createHash('sha256').update(taskResult.content).digest('hex'));
            assert.equal(taskResult.task.nativeTaskId, completed.nativeTaskId);
            completed.result.boundResult = { hasChildReport: true, resultHash: taskResult.task.resultHash };
        }

        const cancelled = await admit('cancel', service.topics.lostAck);
        const stopBody = { sharedSpaceId, workId: cancelled.workId, nativeTaskId: cancelled.nativeTaskId };
        const denied = await request('task-stop', stopBody, 'B');
        const ownerStop = await request('task-stop', stopBody);
        cancelled.result.stop = { observer: denied.status, observerCode: denied.body.error?.code ?? null, owner: ownerStop.status };
        if (baseline) {
            assert.equal(ownerStop.status, 404);
            const adminCancellation = await checked(adminRoute + '/' + cancelled.nativeTaskId + '/cancel', {});
            assert.equal(adminCancellation.success, true);
            cancelled.result.stop.baselineNativeAdminCleanup = true;
        } else {
            const observer = await work(cancelled.workId, 'B');
            assert.equal(observer.nativeTasks[0].stopAllowed, false);
            assert.equal(denied.status, 403);
            assert.equal(ownerStop.status, 200);
            const state = ownerStop.body.request.nativeTasks[0].state;
            assert.equal(state, 'cancelling');
            assert.equal(ownerStop.body.request.nativeTasks[0].stopRequested, true);
            const replayedStop = await checked('task-stop', stopBody);
            assert.equal(replayedStop.request.nativeTasks[0].state, state);
            cancelled.result.stop.ownerObservedState = state;
            cancelled.result.stop.repeatedOwnerStop = true;
        }
        fx.release(cancelled.marker);
        const nativeCancelled = await waitUntil(async () => (await admin()).recent.find(row => row.id === cancelled.nativeTaskId),
            'native AA cancelled');
        assert.equal(nativeCancelled.status, 'cancelled');
        cancelled.result.after = await snapshot(cancelled, row => row.state === 'completed' &&
            (baseline || row.nativeTasks[0]?.state === 'cancelled'));
        cancelled.result.nativeFinalState = nativeCancelled.status;
        assert.equal(cancelled.result.after.provider.launches, 1);
        assert.equal(cancelled.result.after.provider.childRounds.length, 1);

        const crashed = await admit('crash', service.topics.interrupted);
        const before = await snapshot(crashed, () => true);
        const originalPid = service.backendPid;
        crashed.result.exit = await service.restartAfterCrash();
        assert.notEqual(service.backendPid, originalPid);
        const recovered = await snapshot(crashed, row => baseline ||
            row.nativeTasks[0]?.state === 'unknown' && row.state === 'review_required');
        crashed.result.originalAdmissionReplay = await crashed.replay();
        await delay(2200);
        crashed.result.after = await snapshot(crashed, row => baseline || row.nativeTasks[0]?.state === 'unknown');
        assert.deepEqual(crashed.result.after, recovered);
        assert.deepEqual(crashed.result.after.provider, before.provider);
        assert.deepEqual(crashed.result.after.journal, before.journal);
        assert.equal(crashed.result.after.provider.launches, 1);
        if (!baseline) {
            assert.equal(crashed.result.after.work.state, 'review_required');
            assert.equal(crashed.result.after.work.tasks[0].id, crashed.nativeTaskId);
            assert.equal(crashed.result.after.work.tasks[0].stopAllowed, false);
            assert.equal(crashed.result.after.work.tasks[0].reviewRequired, true);
            assert.equal(crashed.result.after.work.tasks[0].hasResult, false);
            const unknownResult = await request(taskRoute('task-result', crashed));
            assert.equal(unknownResult.body.error?.code, 'NATIVE_TASK_RESULT_UNVERIFIED');
            const stoppedUnknown = await request('task-stop', { sharedSpaceId, workId: crashed.workId, nativeTaskId: crashed.nativeTaskId });
            assert.equal(stoppedUnknown.body.error?.code, 'NATIVE_TASK_STOP_UNAVAILABLE');
            const next = await request('session-send', await submission('crash', service.topics.interrupted.id));
            assert.ok(['DEPENDENCY_REVIEW_REQUIRED', 'SHARED_TOPIC_BUSY'].includes(next.body.error?.code));
            crashed.result.refusedActions = { report: unknownResult.body.error.code, stop: stoppedUnknown.body.error.code,
                newSameTopicSubmission: next.body.error.code };

            const previousCalls = receipts(completed.marker, completed.workId);
            const verified = await checked(taskRoute('task-result', completed));
            assert.equal(verified.executionId, completed.workId);
            assert.equal(verified.task.nativeTaskId, completed.nativeTaskId);
            assert.equal(verified.task.resultHash, completed.result.boundResult.resultHash);
            assert.equal(verified.task.resultHash, createHash('sha256').update(verified.content).digest('hex'));
            assert.ok(verified.content.includes(childReport));
            assert.deepEqual(receipts(completed.marker, completed.workId), previousCalls);
            completed.result.boundResult.coldReadSameWorkTaskAndHash = true;
        } else {
            assert.equal(recovered.work.state, 'completed');
            assert.equal(recovered.work.tasks.length, 0);
        }
        assert.equal((await admin()).active.length, 0, 'restart does not start a new native delegation');
        evidence.providerAccounting = {
            totalRequests: service.calls.length,
            parentRounds: service.calls.filter(call => call.role === 'parent').length,
            childRounds: service.calls.filter(call => call.role === 'child').length,
            launches: service.calls.filter(call => call.role === 'child' && call.launch).length,
        };
        assert.equal(evidence.providerAccounting.totalRequests,
            evidence.providerAccounting.parentRounds + evidence.providerAccounting.childRounds);
        assert.equal(evidence.providerAccounting.launches, 3);
    } finally {
        db?.close();
        if (fx) {
            evidence.finalToolBoxExit = await fx.close();
            if (evidence.providerAccounting) {
                assert.equal(fx.service.calls.length, evidence.providerAccounting.totalRequests);
                const loaded = JSON.parse(fs.readFileSync(path.join(out, 'backend-loaded.json')));
                assert.ok(loaded.some(row => row.file.endsWith('/Plugin/AgentAssistant/AgentAssistant.js')));
                for (const row of loaded) {
                    const origin = baseline
                        ? execFileSync('git', ['show', serverRevision + ':' + row.file], { cwd: candidate })
                        : fs.readFileSync(path.join(candidate, row.file));
                    assert.equal(row.sha256, createHash('sha256').update(origin).digest('hex'), row.file);
                }
                evidence.loadedSources = loaded;
                const payload = JSON.stringify(evidence, null, 2) + '\n';
                fs.writeFileSync(outputPath || path.join(out, 'receipt.json'), payload);
                for (const directory of ['runtime-box', 'seed', 'data', 'empty-diaries']) {
                    fs.rmSync(path.join(out, directory), { recursive: true, force: true });
                }
            }
        }
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });

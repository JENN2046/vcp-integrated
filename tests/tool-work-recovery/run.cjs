'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { execFileSync } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { setTimeout: delay } = require('node:timers/promises');
const { start } = require('../integration/service.cjs');
const counter = require('../ordinary-tools/fixture.cjs');
const { stable, sha256 } = require('../../apps/server/Plugin/NativeSync/sync/protocol');
const { createNativeContinuationStore } = require('../../apps/server/modules/nativeContinuationStore.cjs');

const root = path.resolve(__dirname, '../..');
const prefix = '/api/v1/sync/shared/';
const knownReceipt = process.argv[2] === '--known-receipt';
assert.ok(process.argv.length === 2 || knownReceipt && process.argv.length === 3, 'Usage: node tests/tool-work-recovery/run.cjs [--known-receipt]');
const marker = knownReceipt ? 'ORDINARY_TOOL_LOCAL' : 'ORDINARY_TOOL_CRASH';

async function waitUntil(check, name, timeout = 12000) {
    const end = Date.now() + timeout;
    do {
        const value = await check();
        if (value) return value;
        await delay(20);
    } while (Date.now() < end);
    throw Error('Timed out waiting for ' + name);
}

async function main() {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-tool-work-recovery-'));
    const cert = path.join(out, 'cert.pem');
    const key = path.join(out, 'key.pem');
    const report = { scenario: knownReceipt ? 'known-native-receipt' : 'unknown-native-result' };
    console.log('Isolated evidence directory ' + out);
    let service;
    let db;
    let dropped;
    try {
        execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
            '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', key, '-out', cert], { stdio: 'ignore' });
        const stage = box => {
            counter.stage(box);
            const configFile = path.join(box, 'toolApprovalConfig.json');
            const config = JSON.parse(fs.readFileSync(configFile));
            config.whitelist.push(counter.name + ':marker:[' + marker + ']');
            fs.writeFileSync(configFile, JSON.stringify(config));
        };
        const intakeId = randomUUID();
        service = await start({
            out, candidate: root, cert, key, waitUntil, trace() {},
            ordinaryTools: { ...counter, stage },
            toolHandoff: {
                env: { NativeSyncSharedSafeTools: JSON.stringify([counter.name]) },
                observeRequest: () => false,
                dropResponse(row) {
                    if (dropped || !row.route.endsWith('/admit') || row.body?.requestId !== intakeId || row.status !== 200) return false;
                    dropped = { status: row.status, id: row.response?.id };
                    return true;
                },
            },
        });
        fs.unlinkSync(key);
        db = new DatabaseSync(path.join(service.data, 'central.sqlite'), { readOnly: true });
        const { spaceId } = JSON.parse(fs.readFileSync(path.join(out, 'seed/desktopA/.native-sync/connection.json')));
        const sharedSpaceId = 'sharedAB';
        const sharedId = service.topics.preSubmit.id;
        const scope = { sharedSpaceId, sharedId };
        const topic = db.prepare('SELECT owner_type, owner_id, topic_id FROM shared_objects WHERE id=?').get(sharedId);
        function headers(device) {
            return {
                authorization: 'Bearer synthetic-only', 'content-type': 'application/json',
                'x-nativesync-space': spaceId, 'x-nativesync-device': 'device' + device,
                'x-nativesync-source': 'source' + device, 'x-nativesync-protocol': '2',
                'x-nativesync-capabilities': 'shared-space-v1,shared-context-v1,shared-controlled-tools-v1,shared-steering-v1',
            };
        }
        function send(route, body, device = 'A', extra) {
            return fetch(service.wsOrigin + route, {
                method: body ? 'POST' : 'GET', headers: { ...headers(device), ...extra },
                body: body && JSON.stringify(body), signal: AbortSignal.timeout(16000),
            });
        }
        async function api(route, body, device, expectedCodes) {
            const response = await send(prefix + route, body, device);
            const value = await response.json();
            if (expectedCodes) {
                assert.equal(response.status, 409, route + ' ' + JSON.stringify(value));
                assert.ok(expectedCodes.includes(value.error?.code), route + ' ' + JSON.stringify(value));
                return value.error.code;
            }
            assert.ok(response.ok, route + ' ' + JSON.stringify(value));
            return value;
        }
        const query = (route, values) => api(route + '?' + new URLSearchParams(values));
        const initial = await query('context', scope);
        const message = { id: intakeId, role: 'user', content: marker, timestamp: Date.now() };
        const admit = { ...scope, requestId: intakeId, expectedHead: initial.head, configHash: initial.hash, message, controlMode: 'safe-tools-v1' };
        const failedReceipt = await new Promise((resolve, reject) => {
            const req = https.request(service.origin + prefix + 'admit', {
                method: 'POST', ca: fs.readFileSync(cert), headers: headers('A'),
            }, response => {
                response.on('error', resolve);
                response.on('end', () => reject(Error('Admission receipt arrived with HTTP ' + response.statusCode)));
                response.resume();
            });
            req.once('error', resolve);
            req.setTimeout(5000, () => req.destroy(Error('Timed out waiting for lost admission')));
            req.end(JSON.stringify(admit));
        });
        assert.equal(failedReceipt.code, 'ECONNRESET');
        assert.ok(dropped?.id);
        report.lostAdmissionReceipt = dropped;
        const known = (await query('request', { sharedSpaceId, requestId: intakeId })).request;
        assert.equal(known.id, dropped.id);
        const workId = known.id;
        const requestId = 'reply_' + workId;
        const ids = { sharedSpaceId, workId };
        const descriptor = service.descriptors.A.preSubmit;
        const packet = { requestId, model: 'synthetic', stream: false, messages: [{ role: 'user', content: marker }],
            vcpchatExtensions: { requestContext: { ownerType: 'agent', agentId: descriptor.itemId, topicId: descriptor.topicId } } };
        const native = { sharedSpaceId, admissionId: workId, requestId, bodyHash: sha256(stable(packet)), generation: 0, consumedInputSeq: 0 };
        const generationHeaders = { 'x-nativesync-admission': workId, 'x-nativesync-generation': '0', 'x-nativesync-consumed-input-seq': '0' };
        await api('native-request', native);
        const pending = send('/v1/chat/completions', packet, 'A', generationHeaders)
            .then(response => ({ status: response.status }), error => ({ transport: error.cause?.code || error.name }));
        await waitUntil(() => counter.counts(out).length === 1, 'side effect fsync');
        const continuation = createNativeContinuationStore(path.join(out, 'runtime-box/.state/native-continuations'));
        const snapshot = async () => {
            const work = (await query('work', ids)).request;
            const state = await query('steering', ids);
            const archive = continuation.read(requestId);
            assert.equal(archive?.identity.workId, workId);
            return {
                work: work.state, native: work.nativeRequests.map(({ id, state }) => ({ id, state })),
                invocation: db.prepare('SELECT invocation_id AS invocationId, native_request_id AS nativeRequestId, state FROM mobile_native_invocations WHERE execution_id=?').all(workId),
                visibleInvocation: work.toolInvocations.map(({ invocationId, state }) => ({ invocationId, state })),
                application: state.applicationState, reason: state.blockedReason, executor: state.executor,
                generation: state.generation, admissions: db.prepare('SELECT id FROM shared_admissions WHERE topic_id=?').all(sharedId).map(row => row.id),
                nativeCheckpoint: db.prepare('SELECT proof_json FROM shared_native_checkpoints WHERE work_id=?').all(workId),
                journal: db.prepare('SELECT msg_id, action FROM journal WHERE owner_type=? AND owner_id=? AND topic_id=? ORDER BY seq')
                    .all(topic.owner_type, topic.owner_id, topic.topic_id),
                compaction: db.prepare('SELECT id FROM shared_compaction_intents WHERE topic_id=?').all(sharedId).map(row => row.id),
                archiveResultIds: Object.keys(archive.results),
                toolCalls: counter.counts(out).length, providerCalls: service.calls.length,
            };
        };
        async function denied(state) {
            const context = await query('context', scope);
            const input = { ...ids, expectedRevision: 0, expectedGeneration: state.generation };
            return {
                compact: await api('compact-prepare', { ...scope, opId: randomUUID(), expectedHead: context.head }, 'A', ['WORK_SAFE_BOUNDARY_PENDING']),
                handoff: await api('steer-handoff', { ...input, expectedExecutor: state.executor, opId: randomUUID() }, 'B', ['WORK_SAFE_BOUNDARY_PENDING']),
                prepare: await api('steer-prepare', { ...input, expectedHead: context.head, configHash: context.hash, opId: randomUUID() }, 'A',
                    ['WORK_SAFE_BOUNDARY_PENDING', 'NATIVE_RESULT_REQUIRES_REVIEW', 'SHARED_REQUEST_FENCED']),
            };
        }
        if (knownReceipt) {
            await pending;
            const before = report.beforeRestart = await snapshot();
            assert.equal(before.work, 'dispatched');
            assert.deepEqual(before.native, [{ id: requestId, state: 'model_terminal' }]);
            assert.equal(before.application, 'awaiting_compaction');
            assert.equal(before.toolCalls, 1);
            assert.equal(before.providerCalls, 1);
            assert.equal(before.nativeCheckpoint.length, 1);
            const proof = JSON.parse(before.nativeCheckpoint[0].proof_json);
            assert.equal(proof.requestId, requestId);
            assert.deepEqual(proof.settledInvocationIds, [before.invocation[0].invocationId]);
            assert.equal(before.invocation[0].state, 'returned');
            assert.deepEqual(before.archiveResultIds, proof.settledInvocationIds);
            assert.deepEqual(before.journal.map(row => row.msg_id), [intakeId, requestId]);
            const originalPid = service.backendPid;
            report.crash = await service.restartAfterCrash();
            assert.notEqual(service.backendPid, originalPid);
            const after = report.afterRestart = await snapshot();
            assert.deepEqual(after, before);
            const context = await query('context', scope);
            const intent = await api('compact-prepare', { ...scope, opId: randomUUID(), expectedHead: context.head });
            assert.equal(intent.workId, workId);
            const source = await query('compact-input', { sharedSpaceId, id: intent.id });
            assert.equal(source.sourceHash, intent.sourceHash);
            const pause = source.history.find(row => row.id === requestId);
            assert.equal(pause?.content, '', 'a tool-only model turn has an empty visible checkpoint');
            assert.equal(pause.finishReason, 'interrupted');
            const evidence = source.history.filter(row => row.id.startsWith('native_evidence_'));
            assert.equal(evidence.length, 1);
            assert.ok(evidence[0].content.includes('ordinary tool invocation recorded for ' + marker));
            report.reopenedCompaction = { workId, sourceHash: source.sourceHash, nativeEvidenceRows: evidence.length,
                visiblePause: { content: pause.content, finishReason: pause.finishReason } };
            assert.deepEqual(await snapshot(), { ...before,
                application: 'compacting', compaction: [intent.id] });
            await api('compact-cancel', { sharedSpaceId, id: intent.id, opId: randomUUID() });
        } else {
            const before = report.beforeRestart = await snapshot();
            assert.deepEqual(before.native, [{ id: requestId, state: 'dispatched' }]);
            assert.equal(before.invocation.length, 1);
            assert.equal(before.invocation[0].nativeRequestId, requestId);
            assert.equal(before.invocation[0].state, 'started');
            assert.deepEqual(before.visibleInvocation, [{ invocationId: before.invocation[0].invocationId, state: 'started' }]);
            assert.deepEqual(before.nativeCheckpoint, []);
            assert.deepEqual(before.archiveResultIds, []);
            assert.equal(before.toolCalls, 1);
            assert.equal(before.providerCalls, 1);
            assert.deepEqual(before.journal.map(row => row.msg_id), [intakeId]);
            report.deniedBeforeRestart = await denied(before);
            const oldPid = service.backendPid;
            report.crash = await service.restartAfterCrash();
            assert.notEqual(service.backendPid, oldPid);
            report.lostNativeResponse = await pending;
            assert.equal(typeof report.lostNativeResponse.transport, 'string');
            const replay = await api('admit', admit);
            assert.equal(replay.id, workId);
            assert.equal(replay.replayed, true);
            const reopened = await snapshot();
            assert.equal(reopened.work, 'review_required');
            assert.deepEqual(reopened.native, [{ id: requestId, state: 'unknown' }]);
            assert.equal(reopened.application, 'blocked');
            assert.equal(reopened.reason, 'NATIVE_RESULT_REQUIRES_REVIEW');
            report.deniedAfterRestart = await denied(reopened);
            const retry = await send('/v1/chat/completions', packet, 'A', generationHeaders);
            assert.equal(retry.status, 409);
            report.nativeReplayRejection = (await retry.json()).error?.code;
            assert.equal(report.nativeReplayRejection, 'SHARED_REQUEST_ALREADY_DISPATCHED');
            await delay(300);
            const after = report.afterRestartAndReplays = await snapshot();
            assert.deepEqual(after, reopened);
            assert.deepEqual(after, { ...before, native: reopened.native, work: reopened.work,
                application: reopened.application, reason: reopened.reason });
            assert.deepEqual(after.admissions, [workId]);
            assert.deepEqual(after.compaction, []);
        }
        report.backendExit = await service.close();
        assert.equal(service.calls.length, 1);
        service = null;
        report.revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
        report.loadedSources = JSON.parse(fs.readFileSync(path.join(out, 'backend-loaded.json'))).map(row => {
            assert.equal(createHash('sha256').update(fs.readFileSync(path.join(root, row.file))).digest('hex'), row.sha256);
            return row;
        });
    } catch (error) {
        report.failure = error.stack;
        throw error;
    } finally {
        db?.close();
        await service?.close();
        fs.rmSync(key, { force: true });
        fs.writeFileSync(path.join(out, 'evidence.json'), JSON.stringify(report, null, 2) + '\n');
        fs.rmSync(path.join(out, 'runtime-box'), { recursive: true, force: true });
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });

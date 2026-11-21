'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { createNativeContinuationStore } = require('../../apps/server/modules/nativeContinuationStore.cjs');

async function verifyFinalPublication({
    mode, finalCrash, crashAfterCheckpoint, out, service, counter, work, b, stream, send, prepared, finalText, prefix,
    settled, crashMarker, waitUntil, dispatchContinuation,
}) {
    const requestId = prepared.requestId;
    const topicId = service.topics.interrupted.topic.topicId;
    const db = new DatabaseSync(path.join(service.data, 'central.sqlite'), { readOnly: true });
    const archive = createNativeContinuationStore(path.join(out, 'runtime-box/.state/native-continuations'));
    const snapshot = () => ({
        admission: db.prepare('SELECT id,state,native_terminal,reply_seq FROM shared_admissions WHERE id=?').get(work.workId),
        request: db.prepare('SELECT id,principal,state FROM shared_native_requests WHERE id=?').get(requestId),
        generations: db.prepare('SELECT generation,executor,request_id,state FROM shared_work_generations WHERE work_id=? ORDER BY generation').all(work.workId),
        journal: db.prepare('SELECT seq,msg_id,device_id,action,hash FROM journal WHERE topic_id=? ORDER BY seq').all(topicId),
        replies: db.prepare('SELECT seq,device_id,message_json FROM journal WHERE topic_id=? AND msg_id=? ORDER BY seq')
            .all(topicId, requestId).map(row => ({ seq: row.seq, executor: row.device_id, message: JSON.parse(row.message_json) })),
        invocations: db.prepare('SELECT invocation_id,native_request_id,record_id,plugin_name,state FROM mobile_native_invocations WHERE execution_id=?').all(work.workId),
        completion: archive.read(requestId)?.completion ?? null,
        counts: { provider: service.calls.length, tool: counter.counts(out).length },
        providerCalls: service.calls.map(({ protocolStep, id, stream }) => ({ protocolStep, id, stream })),
        phases: db.prepare('SELECT stage FROM shared_request_phases WHERE request_id=? ORDER BY at').all(requestId).map(row => row.stage),
    });
    const submit = async (message, who = b, opId = randomUUID()) => {
        const response = await send(prefix + 'steer-turn-complete', { ...work, generation: prepared.generation, message, opId }, who);
        return { status: response.status, payload: await response.json() };
    };

    try {
        const crashedPid = service.backendPid;
        const original = dispatchContinuation().then(async response => ({ status: response.status, body: await response.text() }))
            .catch(error => ({ transportError: error.cause?.code || error.name }));
        await waitUntil(() => service.calls.length >= 3, 'B provider dispatch');
        let originalResult;
        let checkpointFile;
        if (crashAfterCheckpoint) {
            await waitUntil(() => fs.statSync(crashMarker, { throwIfNoEntry: false })?.size, 'native final archive fsync and SIGKILL');
            const marker = JSON.parse(fs.readFileSync(crashMarker, 'utf8'));
            assert.equal(marker.requestId, requestId);
            assert.equal(marker.pid, crashedPid);
            assert.equal(path.dirname(marker.file), path.join(out, 'runtime-box/.state/native-continuations'));
            assert.match(path.basename(marker.file), /^[a-f0-9]{64}\.json$/);
            checkpointFile = marker.file;
            originalResult = await original;
            assert.equal(originalResult.transportError, 'UND_ERR_SOCKET');
        } else if (mode !== '--dispatch-only') {
            originalResult = await original;
            assert.equal(originalResult.transportError, undefined);
            if (mode === '--truncated') {
                assert.equal(originalResult.status, 200);
                assert.ok(originalResult.body.includes(finalText), 'partial SSE reached B');
                assert.match(originalResult.body, /STREAM_INCOMPLETE/);
            } else {
                assert.equal(originalResult.status, 400);
                assert.match(originalResult.body, /UPSTREAM_INCOMPLETE/);
            }
            await waitUntil(async () => (await stream.readWork()).state === 'review_required', 'failed native response settlement');
        }

        const before = snapshot();
        assert.equal(before.invocations.length, 1);
        const [invocation] = before.invocations;
        assert.equal(invocation.invocation_id, settled.toolInvocations[0].invocationId);
        assert.equal(invocation.native_request_id, stream.requestId);
        assert.equal(invocation.state, 'returned');
        assert.equal(invocation.plugin_name, counter.name);
        assert.ok(invocation.record_id);
        assert.deepEqual(before.counts, { provider: 3, tool: 1 });
        assert.deepEqual(before.providerCalls.map(row => row.protocolStep), ['nonstream-two-tools', 'stream-one-tool', 'B-continuation']);
        assert.deepEqual(before.providerCalls.slice(1).map(row => row.id), [stream.requestId, requestId]);
        assert.deepEqual(before.generations.map(row => row.request_id), [stream.requestId, requestId]);
        assert.deepEqual(before.generations.map(row => row.executor), ['desktop:deviceA', 'desktop:deviceB']);
        assert.equal(before.admission.reply_seq, null);
        assert.deepEqual(before.replies, []);
        let premature;
        if (mode === '--dispatch-only') {
            premature = await submit({ id: requestId, role: 'assistant', content: finalText, finishReason: 'completed', timestamp: Date.now() });
            assert.equal(premature.status, 409);
            assert.equal(premature.payload.error.code, 'SHARED_NATIVE_TERMINAL_REQUIRED');
            assert.deepEqual(snapshot(), before);
        }
        if (crashAfterCheckpoint) {
            assert.equal(before.completion.content, finalText);
            assert.equal(before.completion.finishReason, 'stop');
            assert.equal(before.completion.workId, work.workId);
            assert.equal(before.completion.requestId, requestId);
            assert.equal(before.completion.generation, 1);
            assert.equal(before.completion.executor, 'desktop:deviceB');
            assert.equal(before.admission.state, 'dispatched');
            assert.equal(before.admission.native_terminal, 0);
            assert.equal(before.request.state, 'dispatched');
        } else {
            assert.equal(before.completion, null);
            assert.equal(before.admission.native_terminal, 0);
            assert.equal(before.request.state, mode === '--dispatch-only' ? 'dispatched' : 'unknown');
        }

        let expectedCompletion = before.completion;
        if (mode === '--tampered-final') {
            const record = JSON.parse(fs.readFileSync(checkpointFile, 'utf8'));
            assert.deepEqual(record.completion, before.completion);
            assert.match(record.completion.digest, /^[a-f0-9]{64}$/);
            record.completion.content += ' tampered on disk';
            fs.writeFileSync(checkpointFile, JSON.stringify(record), { flush: true });
            expectedCompletion = record.completion;
        }

        const crash = await service.restartAfterCrash();
        const restartedPid = service.backendPid;
        assert.notEqual(restartedPid, crashedPid);
        originalResult ??= await original;
        if (mode === '--dispatch-only') assert.equal(originalResult.transportError, 'UND_ERR_SOCKET');
        const expectedState = finalCrash ? 'completed' : 'review_required';
        const observed = await waitUntil(async () => {
            const row = await stream.readWork();
            return row.state === expectedState && row;
        }, 'recovered Work ' + expectedState);
        assert.equal(observed.id, work.workId);
        assert.deepEqual(observed.toolInvocations, settled.toolInvocations);

        const after = snapshot();
        assert.equal(after.admission.state, expectedState);
        assert.deepEqual(after.invocations, before.invocations);
        assert.deepEqual(after.counts, before.counts);
        assert.deepEqual(after.completion, expectedCompletion);
        const lateTimestamp = before.completion ? before.completion.timestamp + 1000 : Date.now();
        const message = { id: requestId, role: 'assistant', content: finalText, finishReason: 'completed', timestamp: lateTimestamp };
        const lateOp = randomUUID();
        const late = await submit(message, b, lateOp);
        const repeatMessage = finalCrash ? { ...message, timestamp: lateTimestamp + 1000, finishReason: 'stop' } : message;
        const repeat = await submit(repeatMessage, b, lateOp);
        assert.equal(repeat.status, late.status);
        const conflict = await submit({ ...message, content: finalText + ' conflicting desktop text' });
        let wrongExecutor;
        if (finalCrash) {
            wrongExecutor = await submit(message, {});
            assert.equal(wrongExecutor.status, 409);
            assert.equal(wrongExecutor.payload.error.code, 'INVALID_SHARED_REPLY');
            assert.equal(after.admission.native_terminal, 1);
            assert.equal(after.request.state, 'model_terminal');
            assert.equal(after.request.principal, 'desktop:deviceB');
            assert.deepEqual(after.generations.map(row => row.state), ['paused', 'completed']);
            assert.equal(after.replies.length, 1);
            const [reply] = after.replies;
            assert.equal(reply.seq, after.admission.reply_seq);
            assert.equal(reply.executor, 'desktop:deviceB');
            assert.equal(reply.message.id, requestId);
            assert.equal(reply.message.content, finalText);
            assert.equal(reply.message.finishReason, 'completed');
            assert.equal(reply.message.timestamp, before.completion.timestamp);
            assert.equal(reply.message.continuity.executionId, work.workId);
            assert.deepEqual(after.journal.slice(0, -1), before.journal);
            assert.equal(after.journal.at(-1).seq, reply.seq);
            assert.equal(late.status, 200);
            assert.equal(late.payload.receipt.seq, reply.seq);
            assert.deepEqual(repeat.payload.receipt, late.payload.receipt);
            assert.equal(repeat.payload.replayed, true);
            assert.equal(conflict.status, 409);
            assert.equal(conflict.payload.error.code, 'SHARED_REPLY_INTENT_CHANGED');
        } else {
            assert.equal(after.admission.reply_seq, null);
            assert.deepEqual(after.replies, []);
            assert.deepEqual(after.journal, before.journal);
            assert.equal(after.request.state, 'unknown');
            assert.equal(late.status, 409);
            assert.equal(late.payload.error.code, 'SHARED_REQUEST_FENCED');
            assert.deepEqual(repeat, late);
            assert.equal(conflict.status, 409);
            assert.equal(conflict.payload.error.code, 'SHARED_REQUEST_FENCED');
        }

        const replay = await dispatchContinuation();
        assert.equal(replay.status, 409);
        const replayCode = (await replay.json()).error.code;
        assert.equal(replayCode, finalCrash ? 'SHARED_GENERATION_FENCED' : 'SHARED_REQUEST_ALREADY_DISPATCHED');
        assert.deepEqual(snapshot(), after);

        const secondCrash = await service.restartAfterCrash();
        assert.deepEqual(snapshot(), after, 'repeat recovery must preserve the original Journal sequence and execution ledger');
        await service.close();
        if (process.env.VCP_PROTOCOL_EVIDENCE) {
            const loadedSources = JSON.parse(fs.readFileSync(path.join(out, 'backend-loaded.json'), 'utf8'))
                .filter(row => /(?:nativeContinuationStore|requestExecutionContext|chatCompletionHandler|nonStreamHandler|streamHandler|sharedNative|sharedSteering|sharedSpace)\.c?js$/.test(row.file));
            const submissionEvidence = submission => submission && ({
                status: submission.status, seq: submission.payload.receipt?.seq, code: submission.payload.error?.code,
                replayed: submission.payload.replayed,
            });
            const evidence = {
                baseRevision: execFileSync('git', ['rev-parse', 'HEAD'], {
                    cwd: path.resolve(__dirname, '../..'), encoding: 'utf8',
                }).trim(),
                node: process.version, mode, originalResult, before, crash: { ...crash, crashedPid, restartedPid },
                after, premature: submissionEvidence(premature), late: submissionEvidence(late), lateTimestamp,
                repeat: submissionEvidence(repeat), repeatTimestamp: repeatMessage.timestamp, conflict: submissionEvidence(conflict), wrongExecutor: submissionEvidence(wrongExecutor),
                replay: { status: replay.status, code: replayCode }, secondCrash, loadedSources,
            };
            fs.writeFileSync(process.env.VCP_PROTOCOL_EVIDENCE, JSON.stringify(evidence, null, 2) + '\n');
        }
        console.log(mode + ' PASS (ToolBox SIGKILL; Work ' + expectedState + '; provider and tool calls unchanged)');
    } finally {
        db.close();
    }
}

module.exports = { verifyFinalPublication };

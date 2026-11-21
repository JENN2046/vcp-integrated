'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const integration = require('../integration/service.cjs');
const start = integration.start;
const verifier = require('../tool-work-final/restart.cjs');
const legacyReceipt = process.argv.includes('--legacy-with-receipt');
const legacy = legacyReceipt || process.argv.includes('--legacy-without-proof');
const root = path.resolve(__dirname, '../..');
const receiptPath = process.env.FINAL_REVIEW_EVIDENCE;
const saveEvidence = evidence => {
    if (!receiptPath) return;
    const previous = fs.existsSync(receiptPath) ? JSON.parse(fs.readFileSync(receiptPath, 'utf8')) : {};
    fs.writeFileSync(receiptPath, JSON.stringify({ ...previous, ...evidence }, null, 2) + '\n');
};
const legacyRevision = '5ed51ba784bf';

// Reuse the normal loopback final response from the crash scenario, with
// its fault injector disabled so the live handler publishes before B retries.
integration.start = options => {
    const { NODE_OPTIONS, VCP_TEST_FINAL_CRASH_MARKER, ...env } = options.toolHandoff.env;
    assert.ok(NODE_OPTIONS && VCP_TEST_FINAL_CRASH_MARKER);
    return start({ ...options, toolHandoff: { ...options.toolHandoff, env }, ...(legacy && { serverRevision: legacyRevision }) });
};

verifier.verifyFinalPublication = async ({ out, service, counter, work, b, stream, send, prepared, finalText, prefix, waitUntil, dispatchContinuation }) => {
    const id = prepared.requestId;
    const topic = service.topics.interrupted;
    const db = new DatabaseSync(path.join(service.data, 'central.sqlite'), { readOnly: true });
    const query = (route, body, actor) => send(prefix + route, body, actor).then(async res => ({ status: res.status, payload: await res.json() }));
    const current = () => db.prepare('SELECT last_seq,hash,deleted,message_json FROM messages WHERE topic_id=? AND msg_id=?').get(topic.topic.topicId, id);
    const journal = () => db.prepare('SELECT seq,action,hash FROM journal WHERE topic_id=? AND msg_id=? ORDER BY seq').all(topic.topic.topicId, id);
    const submit = (message, opId = randomUUID(), actor = b) => query('steer-turn-complete', { ...work, generation: 1, message, opId }, actor);
    const log = ({ status, payload }) => ({ status, seq: payload.receipt?.seq, replayed: payload.replayed, code: payload.error?.code });
    const mutate = (action, message) => query('message', {
        sharedSpaceId: work.sharedSpaceId, sharedId: topic.id,
        operation: { opId: randomUUID(), deviceId: 'desktop:deviceA', msgId: id, action, baseHash: current().hash, ...(message && { message }) },
    });
    try {
        const response = await dispatchContinuation();
        assert.equal(response.status, 200);
        assert.equal((await response.json()).choices[0].message.content, finalText);
        if (legacy) {
            const archive = require('../../apps/server/modules/nativeContinuationStore.cjs')
                .createNativeContinuationStore(path.join(out, 'runtime-box/.state/native-continuations'));
            const state = () => ({
                work: db.prepare('SELECT state,reply_seq FROM shared_admissions WHERE id=?').get(work.workId),
                request: db.prepare('SELECT state FROM shared_native_requests WHERE id=?').get(id).state,
                assistantEvents: archive.read(id).assistant.length,
                completion: archive.read(id).completion ?? null,
                journal: journal(),
            });
            const terminal = await waitUntil(() => state().request === 'model_terminal' && state(), 'legacy native model terminal');
            assert.equal(terminal.work.state, 'dispatched');
            assert.equal(terminal.work.reply_seq, null);
            assert.equal(terminal.completion, null);
            assert.deepEqual(terminal.journal, []);
            const oldMessage = { id, role: 'assistant', content: finalText, timestamp: Date.now(), finishReason: 'completed' };
            const oldOp = randomUUID();
            const oldReceipt = legacyReceipt && log(await submit(oldMessage, oldOp));
            if (legacyReceipt) {
                assert.equal(oldReceipt.status, 200);
                assert.ok(oldReceipt.seq);
            }
            const before = state();
            const changedFiles = execFileSync('git', ['diff', '--name-only', legacyRevision, 'HEAD', '--', 'apps/server/'], { cwd: root, encoding: 'utf8' }).trim().split('\n');
            await service.restartWithUpgrade(() => {
                for (const name of changedFiles) {
                    fs.copyFileSync(path.join(root, name), path.join(out, 'runtime-box', path.relative('apps/server', name)));
                }
            });
            const after = state();
            const counts = { provider: service.calls.length, tool: counter.counts(out).length };
            assert.deepEqual(counts, { provider: 3, tool: 1 });
            if (legacyReceipt) {
                assert.equal(after.work.state, 'completed');
                assert.deepEqual(after, before);
                const exact = log(await submit(oldMessage, oldOp));
                const altered = log(await submit({ ...oldMessage, timestamp: oldMessage.timestamp + 1000 }, oldOp));
                const newOp = log(await submit({ ...oldMessage, timestamp: oldMessage.timestamp + 1000 }));
                assert.deepEqual(exact, { ...oldReceipt, replayed: true });
                assert.equal(altered.status, 409);
                assert.equal(altered.code, 'IDEMPOTENCY_KEY_REUSED');
                assert.equal(newOp.status, 200);
                assert.equal(newOp.seq, oldReceipt.seq);
                assert.deepEqual(state(), after);
                saveEvidence({ legacyWithReceipt: { revision: legacyRevision, before, after, oldReceipt, exact, altered, newOp, counts } });
                console.log('PASS already-published legacy Work and its exact receipt survive upgrade');
                return;
            }
            assert.equal(after.work.state, 'review_required');
            assert.equal(after.work.reply_seq, null);
            assert.equal(after.completion, null);
            assert.deepEqual(after.journal, []);
            const late = log(await submit({ id, role: 'assistant', content: finalText, timestamp: Date.now(), finishReason: 'completed' }));
            assert.equal(late.status, 409);
            assert.equal(late.code, 'SHARED_REQUEST_FENCED');
            assert.deepEqual(state(), after);
            saveEvidence({ legacyWithoutProof: { revision: legacyRevision, before, after, late, counts } });
            console.log('PASS old ToolBox terminal marker without native proof cannot publish on upgrade');
            return;
        }
        await waitUntil(async () => (await stream.readWork()).state === 'completed', 'normal ToolBox publication');
        const published = current();
        const original = JSON.parse(published.message_json);
        assert.equal(original.id, id);
        assert.equal(original.content, finalText);
        assert.equal(journal().length, 1);
        const message = { id, role: 'assistant', content: finalText, timestamp: original.timestamp + 1000, finishReason: 'stop' };
        const firstOp = randomUUID();
        assert.equal((await submit(message, firstOp)).payload.receipt.seq, published.last_seq);
        delete original._nativeSyncMetadata;
        delete original.continuity;
        delete original.isThinking;
        const edited = await mutate('upsert', { ...original, content: 'Later human edit' });
        assert.equal(edited.status, 200, JSON.stringify(edited.payload));
        const savedEdit = current();
        assert.equal(JSON.parse(savedEdit.message_json).content, 'Later human edit');
        const afterEdit = log(await submit(message));
        assert.equal(afterEdit.status, 200);
        assert.equal(afterEdit.seq, published.last_seq);
        assert.deepEqual(current(), savedEdit);
        const deleted = await mutate('delete');
        assert.equal(deleted.status, 200, JSON.stringify(deleted.payload));
        const tombstone = current();
        assert.equal(tombstone.deleted, 1);
        const afterDelete = log(await submit(message));
        const exactReplay = log(await submit(message, firstOp));
        for (const receipt of [afterDelete, exactReplay]) {
            assert.equal(receipt.status, 200);
            assert.equal(receipt.seq, published.last_seq);
        }
        assert.equal(exactReplay.replayed, true);

        const wrongExecutor = log(await submit(message, firstOp, {}));
        const wrongReply = log(await submit({ ...message, id: 'unexpected-reply' }, firstOp));
        for (const result of [wrongExecutor, wrongReply]) {
            assert.equal(result.status, 409);
            assert.equal(result.code, 'INVALID_SHARED_REPLY');
        }
        assert.deepEqual(current(), tombstone);
        const events = journal();
        assert.deepEqual(events.map(row => row.action), ['upsert', 'upsert', 'delete']);
        assert.deepEqual(events.map(row => row.seq), [published.last_seq, savedEdit.last_seq, tombstone.last_seq]);
        await service.restartAfterCrash();
        assert.equal((await stream.readWork()).state, 'completed');
        assert.deepEqual(current(), tombstone);
        assert.deepEqual(journal(), events);
        const counts = { provider: service.calls.length, tool: counter.counts(out).length };
        assert.deepEqual(counts, { provider: 3, tool: 1 });

        const evidence = {
            revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.resolve(__dirname, '../..'), encoding: 'utf8' }).trim(),
            node: process.version,
            mode: 'normal native publication; same reply ID edited then deleted through shared message API',
            id, events, afterEdit, afterDelete, exactReplay, wrongExecutor, wrongReply,
            finalProjection: { seq: tombstone.last_seq, deleted: Boolean(tombstone.deleted) },
            workAfterRestart: 'completed', counts,
        };
        saveEvidence(evidence);
        console.log('PASS normal publication and late B receipts preserve the human edit and tombstone');
    } finally {
        db.close();
    }
};

process.argv[2] = '--final-crash';
require('../tool-work-handoff/protocol.cjs');

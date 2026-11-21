'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const integration = require('../integration/service.cjs');
const start = integration.start;
const verifier = require('../tool-work-final/restart.cjs');
const desktopFile = require.resolve('../../apps/desktop/modules/services/nativeSync/sharedSteeringClient');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const desktopLoadedHash = sha256(fs.readFileSync(desktopFile));
const { SharedSteeringClient } = require(desktopFile);
const historyCapability = 'shared-controlled-tools-history-v1';
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
let pendingEvidence;
function loadedServer(out, revision) {
    const report = JSON.parse(fs.readFileSync(path.join(out, 'backend-loaded.json'), 'utf8'));
    return ['sharedHttp.js', 'sharedSteering.js', 'sharedSpace.js', 'sharedControlledText.js'].map(name => {
        const file = 'apps/server/Plugin/NativeSync/sync/' + name;
        const loaded = report.find(row => row.file === file);
        const bytes = revision ? execFileSync('git', ['show', revision + ':' + file], { cwd: root }) :
            fs.readFileSync(path.join(root, file));
        assert.equal(loaded?.sha256, sha256(bytes), file);
        return loaded;
    });
}
const build = () => ({
    baseRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    node: process.version,
    source: 'tested candidate working tree',
    watchFallback: process.env.FINAL_REVIEW_WATCH_FALLBACK === '1',
    desktopClient: { file: path.relative(root, desktopFile), sha256: desktopLoadedHash },
});

// Reuse the normal loopback final response from the crash scenario, with
// its fault injector disabled so the live handler publishes before B retries.
integration.start = async options => {
    const { NODE_OPTIONS, VCP_TEST_FINAL_CRASH_MARKER, ...env } = options.toolHandoff.env;
    assert.ok(NODE_OPTIONS && VCP_TEST_FINAL_CRASH_MARKER);
    if (process.env.FINAL_REVIEW_WATCH_FALLBACK === '1') {
        env.CHOKIDAR_USEPOLLING = 'true';
        env.NODE_OPTIONS = '--require=' + JSON.stringify(require.resolve('../mobile-physical/knowledge-watcher.cjs'));
    }
    const service = await start({ ...options, toolHandoff: { ...options.toolHandoff, env }, ...(legacy && { serverRevision: legacyRevision }) });
    return {
        ...service,
        async close() {
            const stopped = await service.close();
            if (pendingEvidence) {
                assert.deepEqual(stopped, { code: 0, signal: null });
                assert.equal(sha256(fs.readFileSync(desktopFile)), desktopLoadedHash);
                const serverSources = loadedServer(options.out);
                saveEvidence({ ...pendingEvidence, build: { ...build(), serverSources } });
            }
            return stopped;
        },
    };
};

verifier.verifyFinalPublication = async ({ out, service, counter, work, b, stream, send, prepared, finalText, prefix, waitUntil, dispatchContinuation }) => {
    const id = prepared.requestId;
    const topic = service.topics.interrupted;
    const db = new DatabaseSync(path.join(service.data, 'central.sqlite'), { readOnly: true });
    const query = (route, body, actor) => send(prefix + route, body, actor).then(async res => ({ status: res.status, payload: await res.json() }));
    const readState = () => ({
        work: db.prepare('SELECT state,reply_seq FROM shared_admissions WHERE id=?').get(work.workId),
        request: db.prepare('SELECT state FROM shared_native_requests WHERE id=?').get(id),
        receipts: db.prepare('SELECT COUNT(*) AS count FROM shared_receipts').get().count,
        operations: db.prepare('SELECT COUNT(*) AS count FROM applied_ops').get().count,
        current: current(),
        journal: journal(),
    });
    const readFinal = async (overrides = {}, actor = b) => {
        const before = readState();
        const response = await query('final-reply?' + new URLSearchParams({
            ...work, requestId: id, generation: prepared.generation, ...overrides,
        }), undefined, actor);
        assert.deepEqual(readState(), before, 'final readback leaves central state and receipts unchanged');
        return response;
    };
    const current = () => db.prepare('SELECT last_seq,hash,deleted,message_json FROM messages WHERE topic_id=? AND msg_id=?').get(topic.topic.topicId, id);
    const journal = () => db.prepare('SELECT seq,action,hash FROM journal WHERE topic_id=? AND msg_id=? ORDER BY seq').all(topic.topic.topicId, id);
    const submit = (message, opId = randomUUID(), actor = b) => query('steer-turn-complete', { ...work, generation: 1, message, opId }, actor);
    const log = ({ status, payload }) => ({ status, seq: payload.receipt?.seq, replayed: payload.replayed, code: payload.error?.code });
    const mutate = (action, message) => query('message', {
        sharedSpaceId: work.sharedSpaceId, sharedId: topic.id,
        operation: { opId: randomUUID(), deviceId: 'desktop:deviceA', msgId: id, action, baseHash: current().hash, ...(message && { message }) },
    });
    try {
        const info = await query('info', undefined, b);
        assert.equal(info.status, 200);
        assert.equal(info.payload.features.includes(historyCapability), !legacy);
        const beforeDispatch = await readFinal();
        if (legacy) assert.equal(beforeDispatch.status, 404);
        else {
            assert.equal(beforeDispatch.status, 200, JSON.stringify(beforeDispatch.payload));
            assert.equal(beforeDispatch.payload.state, 'pending');
            assert.equal(beforeDispatch.payload.seq, undefined);
            assert.equal(beforeDispatch.payload.message, undefined);
            assert.equal(current(), undefined);
            assert.deepEqual(journal(), []);
        }
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
            let oldOp, oldReceipt;
            let fallback;
            if (legacyReceipt) {
                const step = { generation: prepared.generation, requestId: id, replyIntent: oldMessage };
                const record = { accepted: { id: work.workId, turn: { controlMode: 'safe-tools-v1' } }, sharedId: topic.id, generations: [step] };
                const requests = [];
                const client = new SharedSteeringClient({
                    state: { requests: { [id]: record } },
                    save: async () => {},
                    runtime: {
                        capabilities: info.payload,
                        connection: { sharedSpaceId: work.sharedSpaceId, deviceId: 'deviceB' },
                        async send(route, options) {
                            const body = options?.body;
                            requests.push({ method: body ? 'POST' : 'GET', route: route.split('?')[0] });
                            const response = await send(route, body, b);
                            const payload = await response.json();
                            assert.ok(response.ok, JSON.stringify(payload));
                            if (route === prefix + 'steer-turn-complete') {
                                oldOp = body.opId;
                                assert.deepEqual(body.message, oldMessage);
                                oldReceipt = log({ status: response.status, payload });
                            }
                            return payload;
                        },
                    },
                });
                await client.finishStep(record, step);
                assert.equal(record.phase, 'completed');
                assert.equal(step.replyAccepted, true);
                assert.deepEqual(requests, [
                    { method: 'GET', route: prefix + 'steering' },
                    { method: 'POST', route: prefix + 'steer-turn-complete' },
                ]);
                fallback = { advertised: false, routeStatus: beforeDispatch.status, requests, phase: record.phase, accepted: step.replyAccepted };
            }
            if (legacyReceipt) {
                assert.equal(oldReceipt.status, 200);
                assert.ok(oldReceipt.seq);
            }
            const before = state();
            const changedFiles = execFileSync('git', ['diff', '--name-only', legacyRevision, '--', 'apps/server/'], { cwd: root, encoding: 'utf8' }).trim().split('\n');
            let serverSourcesBeforeUpgrade;
            await service.restartWithUpgrade(() => {
                serverSourcesBeforeUpgrade = loadedServer(out, legacyRevision);
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
                const readback = await readFinal();
                assert.equal(readback.status, 200, JSON.stringify(readback.payload));
                assert.equal(readback.payload.state, 'committed');
                assert.equal(readback.payload.seq, oldReceipt.seq);
                assert.equal(readback.payload.historyState, 'original');
                assert.equal(readback.payload.message.content, finalText);
                pendingEvidence = { legacyWithReceipt: {
                    revision: legacyRevision, serverSourcesBeforeUpgrade, before, after, oldReceipt, exact, altered, newOp, counts, fallback,
                    readback: readback.payload,
                } };
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
            const readback = await readFinal();
            assert.equal(readback.status, 200, JSON.stringify(readback.payload));
            assert.equal(readback.payload.state, 'review_required');
            assert.equal(readback.payload.seq, undefined);
            assert.equal(readback.payload.message, undefined);
            assert.deepEqual(state(), after);
            pendingEvidence = { legacyWithoutProof: {
                revision: legacyRevision, serverSourcesBeforeUpgrade, before, after, late, counts, readback: readback.payload,
            } };
            console.log('PASS old ToolBox terminal marker without native proof cannot publish on upgrade');
            return;
        }
        await waitUntil(async () => (await stream.readWork()).state === 'completed', 'normal ToolBox publication');
        const published = current();
        const original = JSON.parse(published.message_json);
        assert.equal(original.id, id);
        assert.equal(original.content, finalText);
        assert.equal(journal().length, 1);
        const expectReadback = async (historyState, latest) => {
            const { status, payload } = await readFinal();
            assert.equal(status, 200, JSON.stringify(payload));
            assert.equal(payload.state, 'committed');
            assert.equal(payload.workId, work.workId);
            assert.equal(payload.sharedId, topic.id);
            assert.equal(payload.generation, prepared.generation);
            assert.equal(payload.requestId, id);
            assert.equal(payload.seq, published.last_seq);
            assert.equal(payload.currentSeq, latest.last_seq);
            assert.equal(payload.historyState, historyState);
            assert.equal(payload.contentHash, createHash('sha256').update(finalText).digest('hex'));
            if (latest.deleted) assert.equal(payload.message, null);
            else {
                assert.equal(payload.message.id, id);
                assert.equal(payload.message.content, JSON.parse(latest.message_json).content);
            }
            return payload;
        };
        const originalReadback = await expectReadback('original', published);
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
        const editedReadback = await expectReadback('edited', savedEdit);
        const afterEdit = log(await submit(message));
        assert.equal(afterEdit.status, 200);
        assert.equal(afterEdit.seq, published.last_seq);
        assert.deepEqual(current(), savedEdit);
        const deleted = await mutate('delete');
        assert.equal(deleted.status, 200, JSON.stringify(deleted.payload));
        const tombstone = current();
        assert.equal(tombstone.deleted, 1);
        const deletedReadback = await expectReadback('deleted', tombstone);
        assert.equal(editedReadback.contentHash, originalReadback.contentHash);
        assert.equal(deletedReadback.contentHash, originalReadback.contentHash);
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
        const invalidReadbacks = {};
        for (const [name, overrides, actor, statusExpected, codeExpected] of [
            ['wrongExecutor', {}, {}, 403, 'SHARED_REQUEST_OWNER_REQUIRED'],
            ['wrongWork', { workId: randomUUID() }, b, 404, 'SHARED_REQUEST_NOT_FOUND'],
            ['wrongGeneration', { generation: 0 }, b, 400, 'INVALID_SHARED_REQUEST'],
            ['wrongReply', { requestId: randomUUID() }, b, 404, 'SHARED_REQUEST_NOT_FOUND'],
        ]) {
            const {status, payload} = await readFinal(overrides, actor);
            assert.equal(status, statusExpected, name + ' ' + JSON.stringify(payload));
            assert.equal(payload.error?.code, codeExpected);
            assert.equal(payload.state, undefined);
            assert.equal(payload.message, undefined);
            invalidReadbacks[name] = { status, code: payload.error?.code };
        }
        assert.deepEqual(current(), tombstone);
        const events = journal();
        assert.deepEqual(events.map(row => row.action), ['upsert', 'upsert', 'delete']);
        assert.deepEqual(events.map(row => row.seq), [published.last_seq, savedEdit.last_seq, tombstone.last_seq]);
        await service.restartAfterCrash();
        assert.equal((await stream.readWork()).state, 'completed');
        assert.deepEqual(current(), tombstone);
        assert.deepEqual(journal(), events);
        const restartedReadback = await expectReadback('deleted', tombstone);
        assert.deepEqual(restartedReadback, deletedReadback);
        const counts = { provider: service.calls.length, tool: counter.counts(out).length };
        assert.deepEqual(counts, { provider: 3, tool: 1 });

        pendingEvidence = {
            mode: 'normal native publication; same reply ID edited then deleted through shared message API',
            id, events, afterEdit, afterDelete, exactReplay, wrongExecutor, wrongReply,
            finalProjection: { seq: tombstone.last_seq, deleted: Boolean(tombstone.deleted) },
            workAfterRestart: 'completed', counts,
            readback: {
                capabilityAdvertised: true, beforeDispatch: beforeDispatch.payload, original: originalReadback,
                edited: editedReadback, deleted: deletedReadback, afterRestart: restartedReadback, invalid: invalidReadbacks,
            },
        };
        console.log('PASS normal publication and late B receipts preserve the human edit and tombstone');
    } finally {
        db.close();
    }
};

process.argv[2] = '--final-crash';
require('../tool-work-handoff/protocol.cjs');

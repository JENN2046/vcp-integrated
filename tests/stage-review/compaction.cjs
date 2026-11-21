'use strict';

// Reproduce the reviewed input bug against a pinned revision, or verify the
// current candidate. Only reads compaction input; no summary is published.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { start } = require('../integration/service.cjs');
const { stable, sha256 } = require('../../apps/server/Plugin/NativeSync/sync/protocol');
const { createNativeContinuationStore } = require('../../apps/server/modules/nativeContinuationStore.cjs');
const root = path.resolve(__dirname, '../..');
const baseline = '96b1114d47e2b651aaa2c77d46f0aac36304260e';
const timestamp = Date.UTC(2026, 0, 1);
const originalText = require('../integration/seed-contract.json').completeText;
const editedText = 'Updated synthetic reply for the compaction review.';
const prompts = ['Review synthetic compaction input.', 'First distinct reply.', 'Second distinct reply.'];

async function waitUntil(fn, label, timeout = 12000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const result = await fn();
        if (result) return result;
        await delay(30);
    }
    throw Error('Timed out on ' + label);
}

async function main(mode = 'baseline') {
    assert.ok(['baseline', 'candidate'].includes(mode), 'Usage: compaction.cjs [baseline|candidate]');
    const serverRevision = mode === 'baseline' ? baseline : undefined;
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-review-compact-'));
    const cert = path.join(out, 'cert.pem');
    const key = path.join(out, 'key.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=Synthetic review',
        '-addext', 'subjectAltName=IP:127.0.0.1', '-out', cert, '-keyout', key], { stdio: 'ignore' });
    let service, db;
    try {
        service = await start({ out, candidate: root, cert, key, waitUntil, trace() {}, serverRevision });
        fs.unlinkSync(key);
        db = new DatabaseSync(path.join(service.data, 'central.sqlite'), { readOnly: true });
        const headers = {
            'content-type': 'application/json', authorization: 'Bearer synthetic-only',
            'x-nativesync-space': JSON.parse(fs.readFileSync(path.join(out, 'seed/desktopA/.native-sync/connection.json'))).spaceId,
            'x-nativesync-source': 'sourceA', 'x-nativesync-device': 'deviceA',
            'x-nativesync-capabilities': 'shared-space-v1,shared-context-v1,shared-controlled-text-v1,shared-steering-v1',
        };
        const url = service.wsOrigin.replace(/^ws:/, 'http:');
        async function call(route, body, moreHeaders = {}) {
            const res = await fetch(url + route, {
                method: body ? 'POST' : 'GET', headers: { ...headers, ...moreHeaders }, body: body ? JSON.stringify(body) : undefined,
            });
            const value = await res.json();
            assert.ok(res.ok, route + ' ' + res.status + ' ' + JSON.stringify(value));
            return value;
        }
        const api = (route, body) => call('/api/v1/sync/shared/' + route, body);
        const sharedSpaceId = 'sharedAB', sharedId = service.topics.preSubmit.id;
        const scope = { sharedSpaceId, sharedId };
        const context = () => api('context?' + new URLSearchParams(scope));
        const { itemId, topicId } = service.descriptors.A.preSubmit;
        const runtimeBox = path.join(out, 'runtime-box');
        const continuations = createNativeContinuationStore(path.join(runtimeBox, '.state/native-continuations'));
        const turns = [];

        async function completeTurn(index) {
            const input = { id: 'compact-user-' + index, role: 'user', content: prompts[index], timestamp: timestamp + 2 * index };
            const initial = await context();
            const work = await api('admit', {
                ...scope, requestId: input.id, expectedHead: initial.head, configHash: initial.hash, message: input, controlMode: 'text-only-v1',
            });
            const requestId = 'reply_' + work.id;
            const packet = {
                requestId, model: 'synthetic', stream: false, messages: [{ role: 'user', content: input.content }],
                vcpchatExtensions: { requestContext: { ownerType: 'agent', agentId: itemId, topicId } },
            };
            await api('native-request', { sharedSpaceId, admissionId: work.id, requestId, bodyHash: sha256(stable(packet)), generation: 0, consumedInputSeq: 0 });
            const reply = await call('/v1/chat/completions', packet, {
                'x-nativesync-admission': work.id, 'x-nativesync-generation': '0', 'x-nativesync-consumed-input-seq': '0',
            });
            const content = reply.choices[0].message.content;
            assert.equal(content, originalText);
            const finished = await api('steer-turn-complete', {
                sharedSpaceId, workId: work.id, opId: 'compact-turn-' + index, generation: 0,
                message: { id: requestId, role: 'assistant', content, timestamp: input.timestamp + 1, finishReason: 'completed' },
            });
            assert.equal(finished.workState, 'completed');
            const data = continuations.read(requestId);
            assert.equal(data.identity.workId, work.id);
            const events = data.events.map(event => ({ kind: event.kind, contentSha256: sha256(event.content) }));
            assert.deepEqual(events, [{ kind: 'assistant', contentSha256: sha256(originalText) }]);
            const proofHash = continuations.proof(requestId, work.id).hash;
            const stored = db.prepare('SELECT proof_json FROM shared_native_checkpoints WHERE work_id=? AND generation=0').get(work.id);
            assert.equal(JSON.parse(stored.proof_json).hash, proofHash);
            turns.push({ workId: work.id, requestId, workState: finished.workState, events, proofHash });
            return requestId;
        }

        async function readInput(stage) {
            const prepared = await api('compact-prepare', { ...scope, opId: 'compact-prepare-' + stage, expectedHead: (await context()).head });
            const source = await api('compact-input?' + new URLSearchParams({ sharedSpaceId, id: prepared.id }));
            assert.equal(source.sourceHash, prepared.sourceHash);
            const cancelled = await api('compact-cancel', { sharedSpaceId, id: prepared.id, opId: 'compact-cancel-' + stage });
            assert.equal(cancelled.cancelled, true);
            return {
                head: prepared.head,
                sourceHash: source.sourceHash,
                history: source.history.map(row => ({ id: row.id, role: row.role, contentSha256: sha256(row.content) })),
            };
        }

        const requestId = await completeTurn(0);
        const beforeEdit = await readInput('before-edit');
        const readReply = db.prepare('SELECT hash, deleted, last_seq FROM messages WHERE topic_id=? AND msg_id=?');
        const originalRow = readReply.get(sharedId, requestId);
        await api('message', { ...scope, operation: {
            opId: 'compact-edit', msgId: requestId, action: 'upsert', baseHash: originalRow.hash, deviceId: 'desktop:deviceA',
            message: { id: requestId, role: 'assistant', content: editedText, timestamp: timestamp + 1 },
        } });
        const afterEdit = await readInput('after-edit');
        const editedRow = readReply.get(sharedId, requestId);
        assert.notEqual(editedRow.hash, originalRow.hash);
        await api('message', { ...scope, operation: {
            opId: 'compact-delete', msgId: requestId, action: 'delete', baseHash: editedRow.hash, deviceId: 'desktop:deviceA',
        } });
        const projection = readReply.get(sharedId, requestId);
        assert.equal(projection.deleted, 1);
        const journalTombstone = db.prepare('SELECT seq, msg_id, action FROM journal WHERE seq=?').get(projection.last_seq);
        assert.equal(journalTombstone.action, 'delete');
        assert.equal(journalTombstone.msg_id, requestId);
        const afterDelete = await readInput('after-delete');
        const sameTextIds = [await completeTurn(1), await completeTurn(2)];
        assert.notEqual(sameTextIds[0], sameTextIds[1]);
        for (const id of sameTextIds) assert.equal(readReply.get(sharedId, id).deleted, 0);
        const sameText = await readInput('same-text');
        const [changedId, survivingId] = sameTextIds;
        const changeBase = readReply.get(sharedId, changedId);
        await api('message', { ...scope, operation: {
            opId: 'compact-same-text-edit', msgId: changedId, action: 'upsert', baseHash: changeBase.hash, deviceId: 'desktop:deviceA',
            message: { id: changedId, role: 'assistant', content: editedText, timestamp: timestamp + 3 },
        } });
        const sameTextAfterEdit = await readInput('same-text-after-edit');
        const changeEdit = readReply.get(sharedId, changedId);
        await api('message', { ...scope, operation: {
            opId: 'compact-same-text-delete', msgId: changedId, action: 'delete', baseHash: changeEdit.hash, deviceId: 'desktop:deviceA',
        } });
        assert.equal(readReply.get(sharedId, changedId).deleted, 1);
        const sameTextAfterDelete = await readInput('same-text-after-delete');

        const originalHash = sha256(originalText), editedHash = sha256(editedText);
        const canonical = (id, contentSha256) => ({ id, role: 'assistant', contentSha256 });
        const assistantRows = source => source.history.filter(row => row.role === 'assistant');
        function assertNativeOriginal(row) {
            assert.match(row.id, /^native_evidence_[a-f0-9]+$/);
            assert.equal(row.contentSha256, originalHash);
        }
        assert.deepEqual(assistantRows(beforeEdit), [canonical(requestId, originalHash)]);
        if (mode === 'baseline') {
            assert.deepEqual(assistantRows(afterEdit).slice(0, 1), [canonical(requestId, editedHash)]);
            assert.equal(assistantRows(afterEdit).length, 2);
            assertNativeOriginal(assistantRows(afterEdit)[1]);
            assert.equal(assistantRows(afterDelete).length, 1);
            assertNativeOriginal(assistantRows(afterDelete)[0]);
        } else {
            assert.deepEqual(assistantRows(afterEdit), [canonical(requestId, editedHash)]);
            assert.deepEqual(assistantRows(afterDelete), []);
        }
        assert.deepEqual(assistantRows(sameText), sameTextIds.map(id => canonical(id, originalHash)));
        assert.deepEqual(assistantRows(sameTextAfterEdit), [canonical(changedId, editedHash), canonical(survivingId, originalHash)]);
        assert.deepEqual(assistantRows(sameTextAfterDelete), [canonical(survivingId, originalHash)]);
        const providerCalls = service.calls.length;
        assert.equal(providerCalls, 3);
        for (const turn of turns) {
            assert.equal(continuations.proof(turn.requestId, turn.workId).hash, turn.proofHash);
        }
        const sources = {};
        for (const file of [
            'Plugin/NativeSync/sync/sharedCompaction.js',
            'Plugin/NativeSync/sync/sharedSteering.js',
            'Plugin/NativeSync/sync/releasePolicy.cjs',
            'modules/nativeContinuationStore.cjs',
        ]) {
            sources[file] = sha256(fs.readFileSync(path.join(runtimeBox, file)));
            const expected = serverRevision
                ? execFileSync('git', ['show', serverRevision + ':apps/server/' + file], { cwd: root })
                : fs.readFileSync(path.join(root, 'apps/server', file));
            assert.equal(sources[file], sha256(expected));
        }
        const revision = serverRevision || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
        const stopped = await service.close();
        service = undefined;
        assert.equal(stopped.code, 0);
        const loadedSources = JSON.parse(fs.readFileSync(path.join(out, 'backend-loaded.json'), 'utf8'));
        const compactor = 'Plugin/NativeSync/sync/sharedCompaction.js';
        assert.equal(loadedSources.find(row => row.file === 'apps/server/' + compactor)?.sha256, sources[compactor]);
        const fixtureFiles = ['tests/stage-review/compaction.cjs', 'tests/integration/service.cjs', 'tests/integration/loopback.cjs'];
        const fixtures = Object.fromEntries(fixtureFiles.map(file => [file, sha256(fs.readFileSync(path.join(root, file)))]));
        console.log(JSON.stringify({
            mode, revision, sources, fixtures,
            loadedCompactorSha256: sources[compactor],
            inputs: { timestamp, prompts, originalSha256: originalHash, editedSha256: editedHash },
            providerCalls, turns,
            journalHashes: { original: originalRow.hash, edited: editedRow.hash }, journalTombstone,
            beforeEdit, afterEdit, afterDelete, sameText, sameTextAfterEdit, sameTextAfterDelete, sameTextIds,
        }, null, 2));
    } finally {
        db?.close();
        if (service) await service.close();
        fs.rmSync(out, { recursive: true, force: true });
    }
}

main(process.argv[2]).catch(err => {
    console.error(err.stack);
    process.exitCode = 1;
});

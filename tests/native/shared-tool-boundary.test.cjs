'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const test = require('node:test');

const box = process.env.VCP_TEST_SERVER || path.resolve(__dirname, '../../apps/server');
const { SharedNative } = require(box + '/Plugin/NativeSync/sync/sharedNative');
const { NativeTaskLinks } = require(box + '/Plugin/NativeSync/mobile/nativeTasks');
const { createNativeContinuationStore } = require(box + '/modules/nativeContinuationStore.cjs');

const workId = 'proof-work';
const requestId = 'proof-request';
const batchNames = ['FirstCounter', 'SecondCounter'];
const rejected = { code: 'NATIVE_CHECKPOINT_RESULTS_UNCONFIRMED' };

function fixture(t, { legacy = false, negotiated = !legacy, single = legacy, secondState = 'returned', resultCount = 2 } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-tool-boundary-'));
    const db = new DatabaseSync(':memory:');
    t.after(() => {
        db.close();
        fs.rmSync(root, { recursive: true, force: true });
    });
    new NativeTaskLinks({ db });
    db.exec('CREATE TABLE shared_admissions (id TEXT PRIMARY KEY, user_op TEXT NOT NULL)');
    db.prepare('INSERT INTO shared_admissions VALUES (?,?)').run(workId, JSON.stringify({
        sharedTurn: { controlMode: 'safe-tools-v1', ...(negotiated && { toolBatchLimit: 2 }) },
    }));
    const continuations = createNativeContinuationStore(root);
    const native = Object.assign(Object.create(SharedNative.prototype), {
        db, continuations, shared: { db, steering: { requestGeneration: () => null } },
    });
    continuations.begin({ workId, requestId, controlRevision: 0 }, []);
    continuations.assistant(requestId, 'Synthetic tool request');
    // Both starts can share a clock tick, and invocation IDs do not encode dispatch order.
    const names = batchNames.slice(0, single ? 1 : 2);
    const calls = names.map((pluginName, batchOrdinal) => ({
        invocationId: ['invocation-z', 'invocation-a'][batchOrdinal],
        nativeRequestId: requestId,
        pluginName,
        recordId: 'record-' + batchOrdinal,
        ...(!legacy && { batchOrdinal, batchSize: names.length, batchNames: names }),
    }));
    const addLedger = db.prepare(`INSERT INTO mobile_native_invocations
        (invocation_id,execution_id,native_request_id,plugin_name,record_id,state,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?)`);
    for (const [ordinal, call] of calls.entries()) {
        addLedger.run(call.invocationId, workId, requestId, call.pluginName, call.recordId,
            ordinal === 0 ? 'returned' : secondState, 1, 1);
    }
    for (const call of calls.slice(0, resultCount)) {
        continuations.result(requestId, call, { text: 'Synthetic result for ' + call.pluginName });
    }
    const ids = calls.map(call => call.invocationId);
    return {
        continuations, ids,
        verify: proof => native.verifiedToolBoundary(workId, requestId, proof),
        tamper: mutate => continuations.update(requestId, data => mutate(data, ids)),
    };
}

test('two settled tool receipts survive a new proof and saved proof verification', t => {
    const f = fixture(t);
    const proof = f.verify();
    assert.deepEqual(proof.settledInvocationIds, f.ids);
    assert.deepEqual(f.verify(JSON.parse(JSON.stringify(proof))), proof);
    const receipts = f.continuations.compactionToolResults(requestId, workId, proof);
    assert.deepEqual(receipts.map(({ result }) => [result.invocationId, result.recordId, result.batchOrdinal]),
        [[f.ids[0], 'record-0', 0], [f.ids[1], 'record-1', 1]]);
});

test('old single-call archives and saved proofs remain readable without batch fields', t => {
    const f = fixture(t, { legacy: true });
    const priorProof = f.continuations.proof(requestId, workId, f.ids);
    assert.deepEqual(f.verify(priorProof), priorProof);
    assert.deepEqual(f.verify(), priorProof);
    const [{ result }] = f.continuations.compactionToolResults(requestId, workId, priorProof);
    assert.equal(result.recordId, 'record-0');
    assert.equal(Object.hasOwn(result, 'batchOrdinal'), false);
});

test('a current single-call receipt can settle with either negotiated limit', t => {
    for (const negotiated of [false, true]) {
        const f = fixture(t, { single: true, negotiated });
        const proof = f.verify();
        const [{ result }] = f.continuations.compactionToolResults(requestId, workId, proof);
        assert.equal(result.batchOrdinal, 0);
        assert.equal(result.batchSize, 1);
        assert.deepEqual(result.batchNames, [batchNames[0]]);
    }
});

for (const state of ['started', 'unknown']) {
    test('first returned and second ' + state + ' cannot yield a safe boundary', t => {
        const f = fixture(t, { secondState: state, resultCount: 1 });
        const partial = f.continuations.proof(requestId, workId, f.ids.slice(0, 1));
        assert.throws(() => f.verify(), rejected);
        assert.throws(() => f.verify(partial), rejected);
    });
}

test('an unnegotiated Work cannot use a two-receipt boundary', t => {
    const f = fixture(t, { negotiated: false });
    const proof = f.continuations.proof(requestId, workId, f.ids);
    assert.throws(() => f.verify(proof), rejected);
});

test('two returned ledger rows without both archived receipts cannot yield a safe boundary', t => {
    const f = fixture(t, { resultCount: 1 });
    assert.throws(() => f.verify(), rejected);
});

const invalidArchives = {
    'duplicate result events': (data, [first]) => {
        data.events[2].invocationId = first;
    },
    'out-of-order result events': data => {
        [data.events[1], data.events[2]] = [data.events[2], data.events[1]];
    },
    'wrong recordId': (data, [, second]) => {
        data.results[second].recordId = 'unrelated-record';
    },
    'missing second result payload': (data, [, second]) => {
        delete data.results[second].result;
    },
    'missing batch metadata on both receipts': (data, ids) => {
        for (const id of ids) {
            delete data.results[id].batchOrdinal;
            delete data.results[id].batchSize;
            delete data.results[id].batchNames;
        }
    },
};

for (const [name, mutate] of Object.entries(invalidArchives)) {
    test('a fresh hash cannot authorize ' + name, t => {
        const f = fixture(t);
        f.tamper(mutate);
        const fresh = f.continuations.proof(requestId, workId, f.ids);
        assert.throws(() => f.verify(fresh), rejected);
    });
}

test('a saved proof must enumerate both distinct invocation IDs in order', t => {
    const f = fixture(t);
    const proof = f.verify();
    for (const ids of [[f.ids[0]], [f.ids[0], f.ids[0]], [...f.ids].reverse()]) {
        assert.throws(() => f.verify({ ...proof, settledInvocationIds: ids }), rejected);
    }
});

test('tool pair negotiation is frozen at admission and preserves execute permissions', async t => {
    const { fixture: sharedFixture } = require('./fixtures/sharedSingleHarness.cjs');
    const { root, shared, store, owner, topic } = await sharedFixture(t);
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    shared.safeTools = new Set(batchNames);
    shared.steering.enabled = true;
    const baseCapabilities = 'shared-space-v1,shared-controlled-tools-v1,shared-steering-v1';
    const pairCapability = ',shared-controlled-tool-pair-v1';
    const actor = (device, capabilities) => shared.desktop({
        sourceId: 'source' + device,
        deviceId: 'device' + device,
        spaceId: store.sourceCatalog.spaceId,
    }, capabilities);
    const legacyA = actor('A', baseCapabilities);
    const pairA = actor('A', baseCapabilities + pairCapability);
    const pairB = actor('B', baseCapabilities + pairCapability);
    const sharedSpaceId = 'sharedAB';
    const pairTopic = shared.create(legacyA, {
        sharedSpaceId, opId: 'create-tool-pair-topic', kind: 'topic', localId: 'tool-pair-topic',
        localParent: 'origin', parentId: owner.id, config: { name: 'Tool pair' },
    }).object;

    function admissionBody(sharedId, requestId) {
        const scope = { sharedSpaceId, sharedId };
        const { head, hash } = shared.executionConfig(legacyA, scope);
        return {
            ...scope, requestId, expectedHead: head, configHash: hash, controlMode: 'safe-tools-v1',
            message: { id: requestId, role: 'user', content: 'Synthetic tools', timestamp: 1 },
        };
    }
    const oldBody = admissionBody(topic.id, 'old-tool-turn');
    const legacy = shared.admit(legacyA, oldBody);
    assert.equal(legacy.turn.toolBatchLimit ?? 1, 1);
    const replayed = shared.admit(pairA, oldBody);
    assert.equal(replayed.id, legacy.id);
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.turn.toolBatchLimit ?? 1, 1);

    const pairBody = admissionBody(pairTopic.id, 'new-tool-pair-turn');
    const pair = shared.admit(pairA, pairBody);
    assert.equal(pair.turn.toolBatchLimit, 2);
    assert.equal(shared.admit(legacyA, pairBody).turn.toolBatchLimit, 2);
    const generation = shared.steering.generation(pair.id, 0);
    const nativeBody = {
        sharedSpaceId, admissionId: pair.id, requestId: generation.request_id,
        bodyHash: 'a'.repeat(64), generation: 0, consumedInputSeq: 0,
    };
    const observer = shared.mobile({ id: 'read-only-observer', scopes: ['shared:sharedAB:read'] }, sharedSpaceId, 'read');
    assert.throws(() => shared.native.prepare(observer, nativeBody), { code: 'SHARED_PERMISSION_REQUIRED', status: 403 });
    assert.throws(() => shared.native.prepare(pairB, nativeBody), { code: 'WORK_EXECUTOR_HANDOFF_REQUIRED' });
    shared.readOnly = true;
    assert.throws(() => shared.native.prepare(pairA, nativeBody), { code: 'SHARED_READ_ONLY' });
    shared.readOnly = false;
    assert.deepEqual(store.db.prepare('SELECT id FROM shared_native_requests WHERE admission_id=?').all(pair.id), []);
    assert.equal(shared.native.prepare(pairA, nativeBody).state, 'prepared');
});

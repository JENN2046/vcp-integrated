'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const box = process.env.VCP_TEST_SERVER || path.resolve(__dirname, '../../apps/server');
const { CentralStore } = require(box + '/Plugin/NativeSync/sync/centralStore');
const { SharedSpace } = require(box + '/Plugin/NativeSync/sync/sharedSpace');
const { SourceCatalog } = require(box + '/Plugin/NativeSync/sync/sourceCatalog');
const { stable, sha256 } = require(box + '/Plugin/NativeSync/sync/protocol');
const { createNativeContinuationStore } = require(box + '/modules/nativeContinuationStore.cjs');
const { SharedRuntime } = require('../../apps/desktop/modules/services/nativeSync/sharedRuntime');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-compaction-input-'));
    const store = new CentralStore(path.join(root, 'journal.sqlite'));
    t.after(() => {
        store.close();
        fs.rmSync(root, { recursive: true, force: true });
    });
    const config = {
        NativeSyncFullSources: JSON.stringify([{ sourceId: 'sourceA', deviceId: 'deviceA', executionMode: 'all-supported' }]),
        NativeSyncSharedSpaces: JSON.stringify([{ id: 'sharedA', sources: ['sourceA'] }]),
    };
    store.sourceCatalog = new SourceCatalog(store, config);
    const shared = store.shared = new SharedSpace(store, config);
    const actor = shared.desktop({ sourceId: 'sourceA', deviceId: 'deviceA', spaceId: store.sourceCatalog.spaceId }, 'shared-space-v1');
    const sharedSpaceId = 'sharedA';
    shared.join(actor, { sharedSpaceId, opId: 'join' });
    const owner = shared.create(actor, {
        sharedSpaceId, opId: 'owner', kind: 'agent', localId: 'agent', config: { name: 'Synthetic', model: 'synthetic', systemPrompt: 'Synthetic prompt', temperature: 0.5 },
    }).object;
    const created = shared.create(actor, {
        sharedSpaceId, opId: 'topic', kind: 'topic', localId: 'topic', localParent: 'agent', parentId: owner.id,
        config: { name: 'Compaction input' },
    }).object;
    const scope = { sharedSpaceId, sharedId: created.id };
    const topic = shared.topic(actor, sharedSpaceId, created.id, 'execute');
    const continuations = createNativeContinuationStore(path.join(root, 'continuations'));
    shared.native = { engine: {}, continuations };

    function append(id, role, content) {
        return store.apply({
            ownerType: topic.owner_type, ownerId: topic.owner_id, topicId: topic.topic_id, msgId: id,
            deviceId: actor.principal, opId: 'append:' + id, baseHash: null, action: 'upsert',
            message: { id, role, content, timestamp: 1 },
        }, { sharedSpace: sharedSpaceId });
    }
    function generation(requestId, { toolIds = [], settledIds = toolIds } = {}) {
        // Seed completed records directly. No tools or steering are dispatched.
        const workId = 'work-' + requestId;
        continuations.begin({ workId, requestId, controlRevision: 0 }, []);
        continuations.assistant(requestId, 'Archived assistant reply');
        for (const invocationId of toolIds) {
            continuations.result(requestId, { nativeRequestId: requestId, invocationId, pluginName: 'Synthetic', recordId: invocationId },
                { text: 'Same result text' });
        }
        const proof = continuations.proof(requestId, workId, settledIds);
        store.db.prepare(`INSERT INTO shared_admissions
            (id,space_id,topic_id,principal,request_id,request_hash,state,config_json,context_head)
            VALUES (?,?,?,?,?,?,'completed','{}',?)`).run(workId, sharedSpaceId, topic.id, actor.principal, requestId, 'fixture', shared.head(topic));
        store.db.prepare(`INSERT INTO shared_work_generations
            VALUES (?,0,0,0,?,?,'{}','completed',?)`).run(workId, actor.principal, requestId, JSON.stringify({ id: requestId, role: 'assistant' }));
        const saveProof = value => store.db.prepare('INSERT OR REPLACE INTO shared_native_checkpoints VALUES (?,0,?)')
            .run(workId, JSON.stringify(value));
        saveProof(proof);
        return { proof, saveProof };
    }
    const prepare = () => shared.compaction.prepare(actor, { ...scope, opId: 'prepare', expectedHead: shared.head(topic) });
    const get = ({ id }) => shared.compaction.get(actor, { ...scope, id });
    const commit = ({ id, messageId, sourceHash }) => shared.compaction.commit(actor, {
        ...scope, id, sourceHash, opId: 'commit',
        message: {
            id: messageId, role: 'user', content: 'Synthetic checkpoint', timestamp: 10,
            contextCompaction: { kind: 'vchat-context-checkpoint', version: 1, checkpoint: 'Synthetic checkpoint' },
        },
    });
    return { db: store.db, append, generation, prepare, get, commit, shared, actor, scope, head: () => shared.head(topic) };
}

test('live compaction owns its preparation while the receipt is being persisted', async t => {
    const f = fixture(t);
    f.append('first', 'user', 'Summarize this');
    const descriptor = { itemType: 'agent', itemId: 'agent', topicId: 'topic' };
    const receiptSaveStarted = Promise.withResolvers();
    const resumeReceiptSave = Promise.withResolvers();
    let receiptSavePaused = false;
    const state = {};
    const runtime = Object.assign(Object.create(SharedRuntime.prototype), {
        ready: true,
        activeCompactionPrepares: new Set(),
        activeCompactions: new Set(),
        capabilities: { features: ['shared-compaction-v1'] },
        connection: { sharedSpaceId: f.scope.sharedSpaceId },
        execution: {
            state,
            mapping: () => f.scope,
            async save() {
                if (!receiptSavePaused && Object.keys(state.compactionPreparations || {}).length) {
                    receiptSavePaused = true;
                    receiptSaveStarted.resolve();
                    await resumeReceiptSave.promise;
                }
            },
        },
        refreshForExecution: async () => ({ head: f.head() }),
        async send(route, options) {
            const url = new URL(route, 'http://localhost');
            const actions = { 'compact-prepare': 'prepare', 'compact-input': 'get', 'compact-cancel': 'cancel' };
            return f.shared.compaction[actions[url.pathname.split('/').at(-1)]](
                f.actor, options?.body || Object.fromEntries(url.searchParams));
        },
    });
    const preparing = runtime.prepareSharedCompaction({ descriptor });
    await receiptSaveStarted.promise;
    try {
        await runtime.recoverSharedCompactionPrepares();
    } finally {
        resumeReceiptSave.resolve();
    }
    const result = await preparing;
    assert.deepEqual(result.history.map(m => m.id), ['first']);
    const intentState = () => f.db.prepare('SELECT state FROM shared_compaction_intents WHERE id=?').get(result.id).state;
    assert.equal(intentState(), 'prepared');

    // Simulate a reopened runtime with the same persisted state and no live owner.
    const reopened = Object.assign(Object.create(SharedRuntime.prototype), runtime, {
        activeCompactionPrepares: new Set(),
        activeCompactions: new Set(),
    });
    await reopened.recoverSharedCompactionPrepares();
    assert.equal(intentState(), 'cancelled');
    assert.equal(reopened.execution.state.compactionPreparations[result.id].cancelled, true);
});

function rejectsPublication(f, prepared) {
    const head = f.head();
    assert.throws(() => f.get(prepared), { code: 'SHARED_COMPACTION_SOURCE_CHANGED' });
    assert.throws(() => f.commit(prepared), { code: 'SHARED_COMPACTION_SOURCE_CHANGED' });
    assert.equal(f.head(), head);
    assert.equal(f.db.prepare('SELECT seq FROM journal WHERE msg_id=?').get(prepared.messageId), undefined);
    assert.deepEqual({ ...f.db.prepare('SELECT state,committed_seq FROM shared_compaction_intents WHERE id=?').get(prepared.id) },
        { state: 'prepared', committed_seq: null });
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM shared_compaction_native_links').get().n, 0);
}

test('a Journal change after prepare rejects compaction get and commit', t => {
    const f = fixture(t);
    f.append('first', 'user', 'Summarize this');
    const prepared = f.prepare();
    assert.equal(f.get(prepared).sourceHash, prepared.sourceHash);
    f.append('second', 'user', 'New input');
    assert.ok(f.head() > prepared.head);
    rejectsPublication(f, prepared);
});

test('a prepared proof using the old native input contract cannot publish after upgrade', t => {
    const f = fixture(t);
    f.append('reply', 'assistant', 'Edited canonical assistant reply');
    const { proof } = f.generation('reply');
    const prepared = f.prepare();
    const saved = JSON.parse(f.db.prepare('SELECT proof_json FROM shared_compaction_intents WHERE id=?').get(prepared.id).proof_json);
    assert.deepEqual(saved.native.map(p => p.hash), [proof.hash]);
    assert.equal(saved.inputVersion, 2);

    // The old proof omitted inputVersion and used last_seq on Journal rows, where it was absent.
    delete saved.inputVersion;
    for (const row of saved.canonical) delete row.seq;
    f.db.prepare('UPDATE shared_compaction_intents SET proof_json=? WHERE id=?').run(JSON.stringify(saved), prepared.id);
    rejectsPublication(f, { ...prepared, sourceHash: sha256(stable(saved)) });
});

test('native results with equal text retain distinct invocation identities in compaction input', t => {
    const f = fixture(t);
    f.append('reply', 'assistant', 'Edited canonical assistant reply');
    f.generation('reply', { toolIds: ['tool-A', 'tool-B'] });
    const prepared = f.prepare();
    const [reply, ...evidence] = f.get(prepared).history;
    assert.equal(reply.content, 'Edited canonical assistant reply');
    assert.deepEqual(evidence.map(row => row.role), ['user', 'user']);
    assert.equal(new Set(evidence.map(row => row.id)).size, 2);
    const results = evidence.map(row => JSON.parse(row.content.slice(row.content.indexOf('{'))));
    assert.deepEqual(results.map(value => value.invocationId), ['tool-A', 'tool-B']);
    assert.deepEqual(results.map(value => value.result.text), ['Same result text', 'Same result text']);
    assert.equal(f.commit(prepared).messageId, prepared.messageId);
});

test('compaction rejects mismatched and incomplete native proofs', t => {
    const f = fixture(t);
    f.append('reply', 'assistant', 'Canonical assistant reply');
    const { proof, saveProof } = f.generation('reply', { toolIds: ['tool-A', 'tool-B'] });
    saveProof({ ...proof, requestId: 'other-reply' });
    assert.throws(f.prepare, { code: 'NATIVE_CHECKPOINT_CHANGED' });
    saveProof({ ...proof, hash: '0'.repeat(64) });
    assert.throws(f.prepare, { code: 'NATIVE_CHECKPOINT_CHANGED' });
    saveProof({ ...proof, settledInvocationIds: ['tool-A'] });
    assert.throws(f.prepare, { code: 'NATIVE_CHECKPOINT_RESULTS_UNCONFIRMED' });
    saveProof(proof);
    assert.equal(f.get(f.prepare()).history.length, 3);
});

test('a native generation without its original Journal ID cannot supply an archived reply', t => {
    const f = fixture(t);
    f.append('different-reply', 'assistant', 'Archived assistant reply');
    f.generation('original-reply');
    assert.throws(f.prepare, { code: 'NATIVE_COMPACTION_SOURCE_MISSING' });
});

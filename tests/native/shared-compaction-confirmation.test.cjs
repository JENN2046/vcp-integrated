'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { SharedRuntime } = require('../../apps/desktop/modules/services/nativeSync/sharedRuntime');
const { SharedExecution } = require('../../apps/desktop/modules/services/nativeSync/sharedExecution');
const { stable, sha256, messageHash } = require('../../apps/desktop/modules/services/nativeSync/protocol');
const { fieldsFrom } = require('../../apps/desktop/modules/services/nativeSync/metadata');

const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const writeJson = (file, value) => fs.writeFile(file, JSON.stringify(value));
const modelMarker = 'COMPACT_DESKTOP_CHECKPOINT';

function syntheticLegacy() {
    const id = 'compact_legacy';
    const descriptor = { itemType: 'agent', itemId: 'owner', topicId: 'topic' };
    const message = {
        id: 'checkpoint_' + id, role: 'user', timestamp: 2, content: 'Synthetic checkpoint',
        contextCompaction: { kind: 'vchat-context-checkpoint', version: 1, checkpoint: 'Synthetic checkpoint' },
    };
    const body = { sharedSpaceId: 'sharedAB', id, sourceHash: 'a'.repeat(64), opId: 'compact_commit_' + id, message };
    const receipt = { success: true, messageId: message.id, seq: 9, replayed: false };
    const preparation = { descriptor, sharedId: 'shared-topic', sourceHash: body.sourceHash, messageId: message.id, workId: null, cancelled: true };
    const intent = { body, descriptor, receipt, phase: 'completed' };
    return {
        id, descriptor, head: receipt.seq, history: [{ id: 'input', role: 'user', content: 'Synthetic user input', timestamp: 1 }, message],
        ledger: { compactionPreparations: { [id]: preparation }, compactions: { [id]: intent } },
    };
}

async function loadOriginalLegacy(root) {
    const profile = path.join(root, 'profile-A');
    const { compactionPreparations, compactions } = await readJson(path.join(profile, '.native-sync/shared/sharedAB/executions.json'));
    const [entry] = Object.entries(compactions);
    assert.equal(Object.keys(compactions).length, 1);
    const [id, intent] = entry;
    const { body, descriptor, receipt } = intent;
    const preparation = compactionPreparations[id];
    assert.equal(intent.phase, 'completed');
    assert.equal(preparation.cancelled, true);
    assert.equal(intent.awaitingConfirmation, undefined);
    assert.match(body.message.content, new RegExp(modelMarker));
    const history = await readJson(path.join(profile, 'UserData', descriptor.itemId, 'topics', descriptor.topicId, 'history.json'));
    const local = history.filter(row => row.id === body.message.id);
    assert.equal(local.length, 1);
    const db = new DatabaseSync(path.join(root, 'data/central.sqlite'), { readOnly: true });
    try {
        const originalIntent = db.prepare('SELECT topic_id, proof_json, message_id, committed_seq, state FROM shared_compaction_intents WHERE id=?').get(id);
        assert.equal(originalIntent.topic_id, preparation.sharedId);
        assert.equal(originalIntent.message_id, body.message.id);
        assert.equal(originalIntent.committed_seq, receipt.seq);
        assert.equal(originalIntent.state, 'committed');
        const proof = JSON.parse(originalIntent.proof_json);
        assert.equal(sha256(stable(proof)), body.sourceHash);
        const centralReceipt = opId => db.prepare('SELECT request_hash,result_json FROM shared_receipts WHERE op_id=?').get(opId);
        const savedCommit = centralReceipt(body.opId);
        const savedCancel = centralReceipt('compact_cancel_' + id);
        assert.equal(savedCommit.request_hash, sha256(stable({ action: 'compact-commit', body })));
        assert.deepEqual(JSON.parse(savedCommit.result_json), { success: true, messageId: body.message.id, seq: receipt.seq });
        assert.deepEqual(JSON.parse(savedCancel.result_json), { success: true, alreadyCommitted: true, messageId: body.message.id, seq: receipt.seq });
        const journal = db.prepare('SELECT owner_type,owner_id,topic_id,action,hash,metadata_hash FROM journal WHERE seq=? AND msg_id=?').get(receipt.seq, body.message.id);
        assert.equal(journal.action, 'upsert');
        assert.equal(journal.hash, messageHash(body.message));
        assert.equal(journal.hash, messageHash(local[0]));
        assert.equal(journal.metadata_hash, sha256(stable(fieldsFrom(body.message))));
        assert.equal(journal.metadata_hash, sha256(stable(fieldsFrom(local[0]))));
        const head = db.prepare('SELECT max(seq) AS head FROM journal WHERE owner_type=? AND owner_id=? AND topic_id=?')
            .get(journal.owner_type, journal.owner_id, journal.topic_id).head;
        assert.equal(head, receipt.seq);
        assert.equal(proof.head, 8);
        return {
            id, descriptor, head, history, ledger: { compactionPreparations, compactions },
            central: { head, intent: originalIntent, commit: savedCommit, cancel: savedCancel, journal },
        };
    } finally {
        db.close();
    }
}

async function fixture(t, data) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ns-compaction-confirmation-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const ledgerFile = path.join(dir, 'executions.json');
    const historyFile = path.join(dir, 'history.json');
    await writeJson(ledgerFile, { requests: {}, ...data.ledger });
    await writeJson(historyFile, data.history);
    if (data.central) await writeJson(path.join(dir, 'central-checkpoint.json'), data.central);
    const preparation = data.ledger.compactionPreparations[data.id];
    const other = { ...data.descriptor, topicId: 'isolated-other-topic' };
    const mappings = [
        { sharedId: preparation.sharedId, local: data.descriptor, shared: data.descriptor },
        { sharedId: 'other-shared-topic', local: other, shared: other },
    ];
    const context = { head: data.head };
    const routes = [];
    const runtime = Object.assign(Object.create(SharedRuntime.prototype), {
        dir, ready: true, root: dir,
        connection: { sharedSpaceId: 'sharedAB' },
        capabilities: { features: ['shared-compaction-v1'] },
        activeCompactionPrepares: new Set(), activeCompactions: new Set(),
        mappings: () => mappings,
        replica: { queue: { shared: descriptor => descriptor, read: () => readJson(historyFile) } },
        async refreshForExecution(_descriptor, options) {
            assert.equal(options?.forceFresh, true);
            return { ...context };
        },
        async send(route, opts) {
            const action = new URL(route, 'http://localhost').pathname.split('/').at(-1);
            routes.push(action);
            if (action === 'compact-prepare') {
                assert.equal(opts.body.expectedHead, context.head);
                const id = 'compact_fresh_' + routes.length;
                return { id, messageId: 'checkpoint_' + id, sourceHash: 'b'.repeat(64), workId: null };
            }
            if (action === 'compact-input') {
                const id = new URL(route, 'http://localhost').searchParams.get('id');
                return { id, messageId: 'checkpoint_' + id, sourceHash: 'b'.repeat(64), history: await readJson(historyFile) };
            }
            assert.fail('Unexpected route ' + action);
        },
    });
    const reopen = async () => {
        runtime.execution = new SharedExecution(runtime);
        runtime.execution.state = await readJson(ledgerFile);
    };
    await reopen();
    return {
        other, context, routes, reopen, prepare: (descriptor = data.descriptor, retryId) => runtime.prepareSharedCompaction({ descriptor, retryId }),
        writeHistory: rows => writeJson(historyFile, rows),
        loadIntent: async () => (await readJson(ledgerFile)).compactions[data.id],
    };
}

async function checkRecovery(t, data) {
    const f = await fixture(t, data);
    const expected = data.ledger.compactions[data.id];
    const { createContextCompactionService } = await import('../../apps/desktop/modules/chat/contextCompactionService.js');
    let projected;
    let modelCalls = 0;
    const service = createContextCompactionService({
        historyMutationAuthority: { mutate: () => assert.fail('Unexpected local History mutation') },
        getExecutionAuthority: () => ({ success: true, kind: 'shared' }),
        sharedCompaction: { prepareSharedCompaction: ({ descriptor }) => f.prepare(descriptor) },
        request() { modelCalls++; throw Error('Unexpected summary model call'); },
    });
    const result = await service.compact({
        scope: data.descriptor, history: data.history, settings: { enableContextCompaction: true },
        onCommitted: (history, message) => { projected = { history, message }; },
    });
    assert.equal(modelCalls, 0);
    assert.deepEqual(f.routes, []);
    assert.equal(result.message.id, expected.body.message.id);
    assert.deepEqual(result.history, data.history);
    assert.deepEqual(projected, { history: result.history, message: result.message });
    assert.deepEqual(await f.loadIntent(), { ...expected, awaitingConfirmation: false });
    await f.reopen();
    assert.match((await f.prepare()).id, /^compact_fresh_/);
    assert.deepEqual(f.routes, ['compact-prepare', 'compact-input']);
}

async function checkFresh(t, data, change) {
    const f = await fixture(t, data);
    if (change === 'new input') {
        f.context.head++;
        await f.writeHistory([...data.history, { id: 'later', role: 'user', timestamp: 3, content: 'Synthetic next input' }]);
    }
    const result = await f.prepare(change === 'other topic' ? f.other : data.descriptor);
    assert.match(result.id, /^compact_fresh_/);
    assert.deepEqual(f.routes, ['compact-prepare', 'compact-input']);
    assert.deepEqual(await f.loadIntent(), data.ledger.compactions[data.id]);
}

async function checkConflict(t, data, change) {
    const f = await fixture(t, data);
    const expected = data.ledger.compactions[data.id];
    const match = row => row.id === expected.body.message.id;
    const history = change === 'delete'
        ? data.history.filter(row => !match(row))
        : data.history.map(row => match(row) ? {
            ...row,
            ...(change === 'content' ? { content: 'Edited checkpoint content' }
                : { contextCompaction: { ...row.contextCompaction, warnings: ['Edited checkpoint metadata'] } }),
        } : row);
    await f.writeHistory(history);
    await assert.rejects(f.prepare(), { code: 'SHARED_CHECKPOINT_PROJECTION_CONFLICT' });
    assert.deepEqual(f.routes, []);
    assert.deepEqual(await f.loadIntent(), expected);
    await f.writeHistory(data.history);
    await f.reopen();
    assert.equal((await f.prepare()).recovered, true);
}

const originalRoot = process.env.NATIVESYNC_ORIGINAL_COMPACTION_ROOT;
for (const mode of ['synthetic', 'original A']) {
    const options = mode === 'original A' && !originalRoot ? { skip: 'NATIVESYNC_ORIGINAL_COMPACTION_ROOT not supplied' } : {};
    const data = () => mode === 'synthetic' ? syntheticLegacy() : loadOriginalLegacy(originalRoot);
    test(mode + ' legacy checkpoint reaches the renderer without rerunning the summary and is confirmed once', options,
        async t => checkRecovery(t, await data()));
    for (const change of ['new input', 'other topic']) {
        test(mode + ' does not claim its previous checkpoint after ' + change, options, async t => checkFresh(t, await data(), change));
    }
    for (const change of ['content', 'metadata', 'delete']) {
        test(mode + ' keeps recovery available after checkpoint ' + change + ' conflicts', options, async t => checkConflict(t, await data(), change));
    }
}

test('renderer retries the same confirmed intent after losing the commit response', async t => {
    const data = syntheticLegacy();
    const { body } = data.ledger.compactions[data.id];
    const f = await fixture(t, data);
    const { createContextCompactionService } = await import('../../apps/desktop/modules/chat/contextCompactionService.js');
    const retryIds = [];
    let modelCalls = 0;
    let commits = 0;
    const service = createContextCompactionService({
        historyMutationAuthority: { mutate: () => assert.fail('Unexpected local History mutation') },
        getExecutionAuthority: () => ({ success: true, kind: 'shared' }),
        sharedCompaction: {
            async prepareSharedCompaction({ descriptor, retryId }) {
                retryIds.push(retryId);
                if (retryId) return f.prepare(descriptor, retryId);
                return { handled: true, success: true, id: body.id, messageId: body.message.id,
                    sourceHash: body.sourceHash, history: data.history.slice(0, -1) };
            },
            async commitSharedCompaction({ descriptor, id }) {
                assert.equal(id, body.id);
                commits++;
                await f.prepare(descriptor, id);
                throw Error('Synthetic lost commit response');
            },
            async cancelSharedCompaction() {},
        },
        async request() {
            modelCalls++;
            return '<context_checkpoint>Synthetic valid initial summary</context_checkpoint>';
        },
    });
    const params = { scope: data.descriptor, history: data.history, settings: { enableContextCompaction: true } };
    await assert.rejects(service.compact(params), /Synthetic lost commit response/);
    assert.equal((await f.loadIntent()).awaitingConfirmation, false);
    await f.reopen();
    await assert.rejects(f.prepare(f.other, data.id), { code: 'SHARED_CHECKPOINT_SCOPE_CHANGED' });
    assert.equal((await f.loadIntent()).awaitingConfirmation, false);
    const result = await service.compact(params);
    assert.deepEqual(result.message, body.message);
    assert.deepEqual(retryIds, [undefined, body.id]);
    assert.equal(modelCalls, 1);
    assert.equal(commits, 1);
    assert.deepEqual(f.routes, []);
    await assert.rejects(f.prepare(data.descriptor, 'compact_unknown'), { code: 'SHARED_CHECKPOINT_SCOPE_CHANGED' });
    assert.deepEqual(f.routes, []);
    assert.equal((await f.loadIntent()).awaitingConfirmation, false);
});

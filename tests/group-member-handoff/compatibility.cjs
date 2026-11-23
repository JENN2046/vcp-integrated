'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');
const { backup } = require('node:sqlite');
const BOX = path.resolve(__dirname, '../../apps/server');
const rejects = code => error => error.code === code;
const { sha256, stable } = require(BOX + '/Plugin/NativeSync/sync/protocol');
const { sharedRequest } = require(BOX + '/Plugin/NativeSync/sync/sharedHttp');

const repo = path.resolve(__dirname, '../..');
const prior = 'af17c99e784fd1afd5b127fcf8a467f06ef8423d';
const space = 'sharedAB';
const v1 = 'group-member-handoff-v1';
const v2 = 'group-member-handoff-v2';

function capabilities(mode) {
    return 'shared-space-v1,shared-context-v1,' + mode;
}

function sourceHeaders(store, device, mode) {
    return {
        'x-nativesync-source': 'source' + device,
        'x-nativesync-device': 'device' + device,
        'x-nativesync-space': store.sourceCatalog.spaceId,
        'x-nativesync-capabilities': capabilities(mode),
    };
}

function actor(store, device, mode) {
    return store.shared.desktop({
        sourceId: 'source' + device, deviceId: 'device' + device, spaceId: store.sourceCatalog.spaceId,
    }, capabilities(mode));
}

function requestId(workId, ordinal) {
    return 'group_' + workId + '_' + ordinal;
}

function packet(topic, workId, plan, ordinal) {
    const previous = 'Synthetic reply ' + (ordinal - 1);
    return {
        requestId: requestId(workId, ordinal),
        model: 'synthetic',
        messages: [{ role: 'user', content: 'Synthetic compatibility input' },
            ...(ordinal ? [{ role: 'assistant', content: previous }] : [])],
        vcpchatExtensions: {
            requestContext: { ownerType: 'group', topicId: topic.topicId, agentId: plan[ordinal] },
            ...(ordinal ? { messageTimestampBindings: [{
                messageId: 'reply_' + requestId(workId, ordinal - 1),
                sentMessageIndex: 1, role: 'assistant', source: 'client_history', timestamp: ordinal + 1,
                timestampIso: new Date(ordinal + 1).toISOString(), sentMessageHash: 'sha256:' + sha256(previous),
            }] } : {}),
        },
    };
}

function publish(store, device, mode, topic, workId, plan, ordinal) {
    const owner = actor(store, device, mode);
    const body = packet(topic, workId, plan, ordinal);
    store.shared.prepareNative(owner, {
        sharedSpaceId: space, admissionId: workId, requestId: body.requestId, memberId: plan[ordinal],
        bodyHash: sha256(stable(body)),
    });
    store.shared.native.enter({
        method: 'POST', body,
        headers: { ...sourceHeaders(store, device, mode), 'x-nativesync-admission': workId },
    }).finish(true);
    return store.shared.complete(owner, {
        sharedSpaceId: space, admissionId: workId, opId: 'synthetic-publish-' + ordinal, nativeRequestId: body.requestId,
        message: { id: 'reply_' + body.requestId, role: 'assistant', agentId: plan[ordinal],
            content: 'Synthetic reply ' + ordinal, timestamp: ordinal + 2 },
    });
}

function loadHost(server) {
    const load = name => require(path.join(server, 'Plugin/NativeSync', name));
    return {
        ...load('sync/centralStore'), ...load('sync/sourceCatalog'), ...load('sync/sharedSpace'),
        ...load('sync/sharedNative'), ...load('sync/sharedHttp'), ...load('mobile/portal'),
    };
}

function openDatabase(host, file) {
    const config = {
        NativeSyncFullSources: JSON.stringify(['A', 'B'].map(device => ({
            sourceId: 'source' + device, deviceId: 'device' + device, executionMode: 'all-supported',
        }))),
        NativeSyncSharedSpaces: JSON.stringify([{ id: space, sources: ['sourceA', 'sourceB'] }]),
        NativeSyncDataDir: file + '-files',
        NativeMobileOrigin: 'https://synthetic-compat.invalid', NativeMobileConfigSync: true, NativeMobileTopics: '[]',
    };
    const store = new host.CentralStore(file);
    store.sourceCatalog = new host.SourceCatalog(store, config);
    return { store, config };
}

function startHost(host, store, config) {
    store.shared = new host.SharedSpace(store, config);
    const portal = new host.MobilePortal({ store, config, agentManager: { isAgent: () => false } });
    const native = new host.SharedNative(store.shared, portal.engine);
    store.onSharedChange = () => portal.refreshDirectoryTopics();
    return async () => {
        native.close();
        await portal.close();
    };
}

async function makeFixture(cleanup, mode, count, file) {
    const current = loadHost(BOX);
    const { store, config } = openDatabase(current, file + '.source');
    const close = startHost(current, store, config);
    cleanup.push(async () => {
        try { await close(); } finally { store.close(); }
    });
    const shared = store.shared;
    const a = actor(store, 'A', mode);
    for (const device of ['A', 'B']) {
        shared.join(actor(store, device, mode), { sharedSpaceId: space, opId: 'join-' + device });
    }
    const members = [];
    for (let n = 0; n < count; n++) {
        members.push(shared.create(a, {
            sharedSpaceId: space, opId: 'compat-member-' + n, kind: 'agent', localId: 'member' + n,
            config: { name: 'Member ' + n, model: 'synthetic', systemPrompt: 'Portable text' },
        }).object.id);
    }
    const group = shared.create(a, { sharedSpaceId: space, opId: 'compat-group', kind: 'group', localId: 'group',
        config: { name: 'Compatibility group', mode: 'sequential', members } }).object;
    const topic = shared.create(a, { sharedSpaceId: space, opId: 'compat-topic', kind: 'topic', parentId: group.id,
        localId: 'compatTopic', localParent: 'group', config: { name: 'Compatibility topic' } }).object;
    const context = shared.executionConfig(a, { sharedSpaceId: space, sharedId: topic.id });
    const work = shared.admit(a, { sharedSpaceId: space, sharedId: topic.id, requestId: 'compatibility-input',
        expectedHead: context.head, configHash: context.hash, controlMode: mode,
        message: { id: 'synthetic-input', role: 'user', content: 'Synthetic compatibility input', timestamp: 1 } });
    assert.deepEqual(work.turn.plan, members);
    const pause = publish(store, 'A', mode, topic.topic, work.id, members, 0);
    assert.equal(pause.request.groupHandoff.state, 'awaiting_handoff');
    await backup(store.db, file);
    return { store, workId: work.id, plan: members, topic: topic.topic };
}

function storedFacts(store, workId) {
    return {
        schema: store.db.prepare('SELECT version FROM shared_schema ORDER BY version').all().map(row => row.version),
        admission: store.db.prepare('SELECT state,reply_seq FROM shared_admissions WHERE id=?').get(workId),
        executor: store.db.prepare('SELECT executor,executor_version,state FROM shared_group_handoffs WHERE work_id=?').get(workId),
        native: store.db.prepare('SELECT ordinal,principal,state FROM shared_native_requests WHERE admission_id=? ORDER BY ordinal').all(workId),
        confirmed: store.db.prepare('SELECT ordinal,reply_seq FROM shared_group_handoff_replies WHERE work_id=? ORDER BY ordinal').all(workId),
        journal: store.db.prepare('SELECT seq,msg_id,device_id,hash FROM journal ORDER BY seq').all(),
        receiptCount: store.db.prepare('SELECT count(*) AS n FROM shared_receipts').get().n,
    };
}

test('old host opens and settles v1, refuses v2, and old client cannot take over v2', async t => {
    assert.equal(process.versions.node.split('.')[0], '24');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-handoff-compat-'));
    const cleanup = [];
    t.after(async () => {
        try { await Promise.all(cleanup.map(close => close())); }
        finally { fs.rmSync(root, { recursive: true, force: true }); }
    });
    const extracted = execFileSync('git', ['archive', prior, 'apps/server'], { cwd: repo, maxBuffer: 32 * 1024 * 1024 });
    execFileSync('tar', ['-xf', '-', '-C', root], { input: extracted });
    const previousServer = path.join(root, 'apps/server');
    fs.symlinkSync(path.join(BOX, 'node_modules'), path.join(previousServer, 'node_modules'), 'dir');
    const previous = loadHost(previousServer);

    const oldProtocolFile = path.join(root, 'v1.sqlite');
    const newProtocolFile = path.join(root, 'v2.sqlite');
    const oldProtocol = await makeFixture(cleanup, v1, 2, oldProtocolFile);
    const newProtocol = await makeFixture(cleanup, v2, 3, newProtocolFile);

    const currentBefore = storedFacts(newProtocol.store, newProtocol.workId);
    const oldClient = sourceHeaders(newProtocol.store, 'B', v1);
    await assert.rejects(sharedRequest(newProtocol.store, { method: 'POST', headers: oldClient, body: {
        sharedSpaceId: space, workId: newProtocol.workId, opId: 'legacy-client-handoff',
        expectedExecutor: 'desktop:deviceA', expectedExecutorVersion: 0,
    } }, new URL('http://loopback.invalid/shared/group-handoff')), rejects('SHARED_CLIENT_UPGRADE_REQUIRED'));
    assert.throws(() => newProtocol.store.shared.prepareNative(actor(newProtocol.store, 'B', v1), {
        sharedSpaceId: space, admissionId: newProtocol.workId, requestId: requestId(newProtocol.workId, 1),
        memberId: newProtocol.plan[1], bodyHash: 'a'.repeat(64),
    }), rejects('SHARED_CLIENT_UPGRADE_REQUIRED'));
    assert.deepEqual(storedFacts(newProtocol.store, newProtocol.workId), currentBefore);

    const rejected = openDatabase(previous, newProtocolFile);
    try {
        assert.deepEqual(currentBefore.schema, [1, 4]);
        assert.deepEqual(storedFacts(rejected.store, newProtocol.workId), currentBefore);
        assert.throws(() => new previous.SharedSpace(rejected.store, rejected.config), rejects('SHARED_SCHEMA_UPGRADE_REQUIRED'));
        assert.deepEqual(storedFacts(rejected.store, newProtocol.workId), currentBefore);
    } finally {
        rejected.store.close();
    }

    const { store, config } = openDatabase(previous, oldProtocolFile);
    const { workId, plan, topic } = oldProtocol;
    try {
        const before = storedFacts(store, workId);
        assert.deepEqual(before.schema, [1, 3]);
        const close = startHost(previous, store, config);
        try {
            assert.deepEqual(storedFacts(store, workId), before);
            const post = (route, body) => previous.sharedRequest(store, {
                method: 'POST', headers: sourceHeaders(store, 'B', v1), body,
            }, new URL('http://loopback.invalid/shared/' + route));
            const scope = { sharedSpaceId: space, workId };
            const take = await post('group-handoff', { ...scope, opId: 'legacy-takeover',
                expectedExecutor: 'desktop:deviceA', expectedExecutorVersion: 0 });
            assert.equal(take.request.groupHandoff.state, 'awaiting_continue');
            const resume = await post('group-continue', { ...scope, opId: 'legacy-continue',
                expectedExecutor: 'desktop:deviceB', expectedExecutorVersion: 1 });
            assert.equal(resume.request.groupHandoff.state, 'continuing');
            assert.equal(publish(store, 'B', v1, topic, workId, plan, 1).request.state, 'dispatched');
            const finish = { sharedSpaceId: space, admissionId: workId, opId: 'legacy-finish', finish: true };
            assert.equal((await post('complete', finish)).request.state, 'completed');
            assert.equal((await post('complete', finish)).replayed, true);
            const final = storedFacts(store, workId);
            assert.equal(final.admission.state, 'completed');
            assert.deepEqual(final.native.map(row => row.state), ['model_terminal', 'model_terminal']);
            assert.deepEqual(final.journal.map(row => row.device_id), ['desktop:deviceA', 'desktop:deviceA', 'desktop:deviceB']);
            assert.deepEqual(final.schema, before.schema);
            const evidence = {
                previousRevision: prior,
                previousSharedSpaceSha256: sha256(fs.readFileSync(path.join(previousServer, 'Plugin/NativeSync/sync/sharedSpace.js'))),
                v1Backup: { schema: final.schema, opened: true, resumed: true, completed: true, finishReplayed: true,
                    native: final.native, journalWriters: final.journal.map(row => row.device_id) },
                v2Backup: { schema: currentBefore.schema, oldHostError: 'SHARED_SCHEMA_UPGRADE_REQUIRED',
                    confirmedOrdinals: currentBefore.confirmed.map(row => row.ordinal), storedFactsUnchanged: true },
                v1ClientV2Work: { takeoverError: 'SHARED_CLIENT_UPGRADE_REQUIRED',
                    nativePrepareError: 'SHARED_CLIENT_UPGRADE_REQUIRED', storedFactsUnchanged: true },
            };
            if (process.env.NS_GROUP_COMPAT_EVIDENCE) {
                fs.writeFileSync(process.env.NS_GROUP_COMPAT_EVIDENCE, JSON.stringify(evidence, null, 2) + '\n');
            }
        } finally {
            await close();
        }
    } finally {
        store.close();
    }
});

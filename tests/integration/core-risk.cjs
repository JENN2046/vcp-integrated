'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { localTopicKey } = require('../../apps/server/core/localWorkspace');

module.exports = async ({ out, service, call, tokens, evalJs, start, stop, picture, click, waitUntil,
    descriptor, key, before, priorAttachment, imageHash, model, mobileCookie, browser }) => {
    const base = '/core/api/personal';
    const coreDir = path.join(out, 'core');
    const api = (route, opts) => call(base + route, { token: tokens.A, ...opts });
    const identity = (await api('/identity')).data.storageId;
    const headers = { 'X-VCP-Core-Storage-Id': identity };
    const config = { name: 'Disposable Pilot agent', model, systemPrompt: 'Before {{agent:PilotFixture}} after' };
    const putTopic = async (ownerType, ownerId, topicId, name, value) => {
        const id = localTopicKey(ownerType, ownerId, topicId);
        const result = await api('/' + id + '/definition', { method: 'PUT', body: { ownerType, ownerId, topicId, name, config: value } });
        assert.equal(result.status, 200, JSON.stringify(result.data));
        return id;
    };

    const disposable = 'disposable-agent';
    const topicId = 'disposable-topic';
    const disposableKey = await putTopic('agent', disposable, topicId, 'Disposable topic', config);
    const approved = await api('/agents/' + disposable, { method: 'PUT', body: { config } });
    assert.equal(approved.status, 200, JSON.stringify(approved.data));
    const group = await putTopic('group', 'fixture-group', 'fixture-group-topic', 'Fixture group topic', {
        group: { name: 'Fixture group', mode: 'sequential', members: [disposable] },
        agents: [{ id: disposable, ...config }]
    });
    const db = new DatabaseSync(path.join(coreDir, 'core.sqlite'), { readOnly: true });
    let beforeBackup;
    try {
        const topic = id => JSON.parse(db.prepare('SELECT configuration FROM core_topics WHERE id=?').get(id).configuration).config;
        const values = [topic(disposableKey), JSON.parse(db.prepare('SELECT configuration FROM core_owners WHERE id=?').get(disposable).configuration), topic(group).agents[0]];
        assert.ok(values.every(value => value.agentAlias === 'PilotFixture' &&
            value.systemPrompt === 'Frozen native prompt from the server fixture.' && value.promptTemplate === config.systemPrompt));

        const upload = await api('/' + disposableKey + '/attachments/uploads', { body: {
            name: 'red.png', size: priorAttachment.length, expectedHash: imageHash, type: 'image/png', requestId: randomUUID()
        } });
        assert.equal(upload.status, 201);
        const uploadId = upload.data.uploadId;
        const assetRoute = '/' + disposableKey + '/attachments/uploads/' + uploadId;
        if (upload.data.state !== 'ready') {
            assert.equal((await api(assetRoute + '/chunks', { body: { offset: 0, data: priorAttachment.toString('base64') } })).status, 200);
        }
        assert.equal((await api(assetRoute + '/finish', { body: {} })).status, 200);
        const send = await api('/' + disposableKey + '/send', { body: {
            requestId: randomUUID(), text: 'Before deleting this isolated topic.', attachments: [uploadId]
        } });
        assert.equal(send.status, 202, JSON.stringify(send.data));
        await waitUntil(() => db.prepare('SELECT status FROM works WHERE id=?').get(send.data.id)?.status === 'completed', 'disposable Work completed');
        const groupWork = await api('/' + group + '/send', { body: { requestId: randomUUID(), text: 'Check the frozen group member.' } });
        assert.equal(groupWork.status, 202, JSON.stringify(groupWork.data));
        await waitUntil(() => db.prepare('SELECT status FROM works WHERE id=?').get(groupWork.data.id)?.status === 'completed', 'Core group member completed');
        const freeze = db.prepare('SELECT frozen_config_json config FROM works WHERE id=?').get(send.data.id).config;
        assert.equal(JSON.parse(freeze).systemPrompt, values[0].systemPrompt);
        assert.equal((await api('/agents/' + disposable, { method: 'PUT', body: { version: approved.data.version,
            config: { ...config, systemPrompt: 'Updated literal prompt' } } })).status, 200);
        assert.equal(db.prepare('SELECT frozen_config_json config FROM works WHERE id=?').get(send.data.id).config, freeze);

        await stop('B');
        const A = await start('A');
        const remove = async topic => evalJs(A, `(async()=>{
            const scope=${JSON.stringify({ itemType:'agent', itemId:disposable, ...(topic && { topicId }) })};
            const context=await window.electronAPI.getNativeDeletionContext(scope);
            const {nativeDeletionOptions}=await import('./modules/chat/nativeDirectoryActions.mjs');
            const options=nativeDeletionOptions(context);
            return scope.topicId ? window.electronAPI.deleteTopic(scope.itemId,scope.topicId,options) :
                window.electronAPI.deleteAgent(scope.itemId,options);
        })()`);
        const deletedTopic = await remove(true);
        assert.equal(deletedTopic.success, true, JSON.stringify(deletedTopic));
        const memo = async () => (await api('/memo-agent?' + new URLSearchParams({ name:config.name }))).data.agent;
        assert.deepEqual((await memo()).topics, []);
        for (const route of ['messages','blob/' + imageHash]) {
            assert.equal((await api('/' + disposableKey + '/' + route, { binary: true })).status, 404);
        }
        const deletedAgent = await remove(false);
        assert.equal(deletedAgent.success, true, JSON.stringify(deletedAgent));
        assert.equal(await memo(), null);
        const directory = (await api('/desktop-directory')).data;
        assert.ok(!directory.agents.some(row => row.id === disposable) &&
            !directory.topics.some(row => row.key === disposableKey));
        assert.ok(!(await call('/mobile/api/session', { cookie:mobileCookie, headers })).data.topics.some(row => row.key === disposableKey));
        assert.deepEqual((await api('/' + key + '/messages')).data.messages, before);
        const ledger = file => {
            const db = new DatabaseSync(file, { readOnly: true });
            try {
                return {
                    works: db.prepare('SELECT id,status,frozen_config_json FROM works ORDER BY id').all(),
                    messages: db.prepare('SELECT * FROM messages ORDER BY id').all(),
                    topics: db.prepare('SELECT id,deleted FROM core_topics ORDER BY id').all(),
                    owners: db.prepare('SELECT id,deleted FROM core_owners ORDER BY id').all()
                };
            } finally { db.close(); }
        };
        beforeBackup = ledger(path.join(coreDir, 'core.sqlite'));
        assert.equal(beforeBackup.topics.find(row => row.id === disposableKey).deleted, 1);
        assert.equal(beforeBackup.owners.find(row => row.id === disposable).deleted, 1);
        await stop('A');
        // Both copies are made while ToolBox is stopped, including its blob store.
        const backup = path.join(out, 'core-backup');
        assert.deepEqual(await service.restartWithUpgrade(() => {
            fs.cpSync(coreDir, backup, { recursive: true, errorOnExist: true, force: false });
            fs.renameSync(coreDir, path.join(out, 'core-before-swap'));
        }), { code: 0, signal: null });
        const refused = await api('/identity', { headers });
        assert.equal(refused.data.error.code, 'CORE_DATABASE_IDENTITY_MISMATCH');
        assert.equal((await call('/mobile/api/session', { cookie:mobileCookie, headers })).data.error.code, 'CORE_DATABASE_IDENTITY_MISMATCH');
        const mismatch = await start('B');
        await waitUntil(() => fs.readFileSync(path.join(out,'B.log'),'utf8').includes('CORE_DATABASE_IDENTITY_MISMATCH'),
            'bound Electron refused replacement before adopting its directory');
        const authority = await evalJs(mismatch, 'window.electronAPI.getTopicExecutionAuthority(' + JSON.stringify(descriptor) + ')');
        assert.equal(authority.error, 'CORE_DATABASE_IDENTITY_MISMATCH');
        await stop('B');
        if (browser) await waitUntil(() => fs.existsSync(path.join(out, 'pwa-storage-rejected')), 'bound PWA refused replacement', 30000);
        assert.deepEqual(await service.restartWithUpgrade(() => {
            fs.renameSync(coreDir, path.join(out, 'core-rejected-empty'));
            fs.cpSync(backup, coreDir, { recursive: true, errorOnExist: true, force: false });
        }), { code: 0, signal: null });
        assert.deepEqual(ledger(path.join(coreDir,'core.sqlite')), beforeBackup);
        assert.equal((await api('/identity', { headers })).data.storageId, identity);
        const restored = await start('B');
        await click(restored, '#agentList > li .agent-name', 'Synthetic local');
        await waitUntil(async () => (await evalJs(restored, "document.querySelector('#chatMessages')?.innerText||''")).includes(before[2].content),
            'bound Electron cold reads copied backup');
        await picture(restored, 'core-backup-cold');
        const restoredBlob = await api('/' + key + '/blob/' + imageHash, { headers, binary: true });
        assert.equal(createHash('sha256').update(restoredBlob.data).digest('hex'), imageHash);
        assert.equal(await memo(), null);
        assert.equal((await api('/' + disposableKey + '/messages')).status, 404);
        if (browser) await waitUntil(() => fs.existsSync(path.join(out, 'pwa-storage-restored')), 'PWA reconnected to restored database', 30000);
        return { nativeDesktopDeletion: true, memoAndAttachmentsRespectTombstone: true, nativeAliasPaths: 3, acceptedPromptFrozen: true,
            refusedDifferentStorageAtSameOrigin: true, restoredSameIdentity: true, browserIdentityVerified: browser, coldDesktopReadback: true,
            durableMessages: beforeBackup.messages.length, durableWorks: beforeBackup.works.length, tombstones: 2, attachmentHash: imageHash };
    } finally { db.close(); }
};

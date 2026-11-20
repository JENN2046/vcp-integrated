'use strict';
// Materialize synthetic shared topics through the native coordination and History APIs.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const BOX = path.resolve(__dirname, '../../apps/server');
const CHAT = path.resolve(__dirname, '../../apps/desktop');
const sync = require('node:module').createRequire(BOX + '/Plugin/NativeSync/native-sync.js');
const desktop = require('node:module').createRequire(CHAT + '/main.js');
const express = sync('express');
const { CentralStore } = sync('./sync/centralStore');
const { SourceCatalog } = sync('./sync/sourceCatalog');
const { SharedSpace } = sync('./sync/sharedSpace');
const { SharedNative } = sync('./sync/sharedNative');
const { MobilePortal } = sync('./mobile/portal');
const { createSyncHttpService } = sync('./sync/httpService');
const { sha256 } = sync('./sync/protocol');
const { setSharedBoundary } = desktop('../server/modules/requestExecutionContext');
const { createNativeSyncRuntime, createSyncRequest } = desktop('./modules/services/nativeSync/runtime');
const { createSharedHost } = desktop('./modules/services/nativeSync/sharedHost');
const { HistoryMutationQueue } = desktop('./modules/services/historyMutationQueue');
const { HistoryAuthority } = desktop('./modules/services/historyAuthority');
const { prepareLocalHistoryAuthority, deriveHistoryProtection } = desktop('./modules/services/nativeSync/historyAuthority');
const AgentConfigManager = desktop('./modules/utils/agentConfigManager');

async function fixture(t, { syntheticRoot: root }) {
    const marker = await fs.readFile(path.join(root, 'L4-SYNTHETIC-ONLY'), 'utf8');
    assert.equal(marker, 'NativeSync L4 synthetic process fixture\n');
    const config = {
        NativeSyncFullSources: JSON.stringify(['A', 'B', 'C', 'D'].map(x => ({
            sourceId: 'source' + x, deviceId: 'device' + x, executionMode: 'all-supported',
        }))),
        NativeSyncSharedSpaces: '[{"id":"sharedAB","sources":["sourceA","sourceB","sourceC"]},{"id":"foreignSpace","sources":["sourceD"]}]',
        NativeMobileAttachments: false, NativeSyncDataDir: path.join(root, 'files'),
        NativeMobileOrigin: 'https://synthetic-shared.invalid', NativeMobileConfigSync: true,
        NativeMobileTopics: '[]', NativeMobileStartDelayMs: 10000,
    };
    const store = new CentralStore(path.join(root, 'central.sqlite'));
    const catalog = store.sourceCatalog = new SourceCatalog(store, config);
    const shared = store.shared = new SharedSpace(store, config);
    const actor = x => shared.desktop({ sourceId: 'source' + x, deviceId: 'device' + x, spaceId: catalog.spaceId }, 'shared-space-v1');
    for (const x of ['A', 'B', 'C', 'D']) {
        shared.join(actor(x), { sharedSpaceId: x === 'D' ? 'foreignSpace' : 'sharedAB', opId: 'join' + x });
    }
    const owner = shared.create(actor('C'), {
        sharedSpaceId: 'sharedAB', opId: 'owner', kind: 'agent', localId: 'origin',
        config: { name: 'Synthetic shared', model: 'synthetic', systemPrompt: 'FROZEN_SHARED_PROMPT',
            temperature: 0.5, contextTokenLimit: 32000, maxOutputTokens: 128,
            streamOutput: false, stripRegexes: [], tavernRules: [] },
    }).object;
    const topic = shared.create(actor('C'), {
        sharedSpaceId: 'sharedAB', opId: 'topic', kind: 'topic', parentId: owner.id,
        localId: 'topic', localParent: 'origin', config: { name: 'One history' },
    }).object;
    const portal = new MobilePortal({ store, config, agentManager: { isAgent: () => false } });
    const native = shared.native = new SharedNative(shared, portal.engine);
    const release = setSharedBoundary(native);
    store.onSharedChange = () => portal.refreshDirectoryTopics();
    const service = createSyncHttpService(store);
    const app = express();
    app.use(express.json());
    app.use('/api/v1/sync', (req, res) => service.handle(req, res));
    const server = http.createServer(app);
    t.after(async () => {
        release();
        native.close();
        await portal.close();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        await service.close();
    });
    await sync('./mobile/sharedConfiguration').prepareSharedConfiguration(portal.engine.configs, portal.topics.find(x => x.key === topic.id));
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
    const url = 'http://127.0.0.1:' + server.address().port;
    const baseSettings = { vcpServerUrl: config.NativeMobileOrigin + '/v1/chat/completions', vcpApiKey: 'synthetic-only', userName: '用户' };
    return {
        shared, actor, owner, topic,
        async desktop(id) {
            const data = path.join(root, 'desktop' + id);
            const syncData = path.join(data, '.native-sync');
            for (const directory of [syncData, ...['Agents', 'AgentGroups', 'UserData'].map(name => path.join(data, name))]) {
                await fs.mkdir(directory, { recursive: true });
            }
            const connection = {
                version: 1, enabled: true, scopeMode: 'source', fullSelectionApproved: true,
                sourceId: 'source' + id, deviceId: 'device' + id, spaceId: catalog.spaceId,
                sourceRoot: data, topics: [], executionTopics: [], executionMode: 'all-supported',
                sharedSpaceId: 'sharedAB', sharedJoinOpId: 'boot' + id, serverUrl: config.NativeMobileOrigin,
                credentialSource: 'existing-vcp-settings', publishExecutionConfigs: true, publishCatalog: true,
                syncAttachments: false,
            };
            const initialState = {
                version: 3, deviceId: connection.deviceId, format: 'native-message-intents-v2',
                topics: [], cursor: 0, acked: {}, outbox: [], inbox: [], pending: null, localCommits: {}, receipts: {}, drift: {},
                source: {
                    binding: { sourceId: connection.sourceId, deviceId: connection.deviceId,
                        spaceId: connection.spaceId, sourceRoot: data, rootHash: sha256(data) },
                    revision: 0, published: {}, plans: {}, deletions: {}, pendingCatalog: null,
                },
            };
            await fs.writeFile(path.join(syncData, 'connection.json'), JSON.stringify(connection));
            await fs.writeFile(path.join(syncData, 'state.json'), JSON.stringify(initialState));

            const agentDir = path.join(data, 'Agents');
            const groupDir = path.join(data, 'AgentGroups');
            const userDataDir = path.join(data, 'UserData');
            const queue = new HistoryMutationQueue({ userDataDir, agentDir, groupDir });
            let runtime;
            t.after(async () => {
                await runtime?.close();
                await queue.dispose();
            });
            const localHistoryAuthority = await prepareLocalHistoryAuthority({ queue, appDataRoot: data });
            const historyAuthority = new HistoryAuthority({
                queue, noChildConfirmed: true, deriveProtection: () => deriveHistoryProtection({ appDataRoot: data }),
            });
            await historyAuthority.refresh();
            const groupChat = require('./nativeGroupModule.cjs')(CHAT);
            groupChat.initializePaths({ APP_DATA_ROOT_IN_PROJECT: data, AGENT_DIR: agentDir, USER_DATA_DIR: userDataDir });
            groupChat.initializeRuntimeServices({ historyMutationQueue: queue });
            let settings = baseSettings;
            let rules = [];
            const sharedHost = createSharedHost({
                appDataRoot: data, agentConfigManager: new AgentConfigManager(agentDir), groupChat,
                readSettings: () => settings,
                settingsManager: { updateSettings: async edit => { settings = edit(settings); } },
                tavernHandlers: {
                    readSharedRules: () => rules,
                    writeStore: async store => { rules = store.rules; return { success: true }; },
                },
            });
            runtime = await createNativeSyncRuntime({
                queue, appDataRoot: data, historyAuthority, localHistoryAuthority, sharedHost,
                request: createSyncRequest({ ...connection, url, token: 'synthetic-only' }),
                readSettings: () => baseSettings, intervalMs: 0,
            });
            const descriptor = { itemType: 'agent', itemId: runtime.localFor(topic.parentId).localId,
                topicId: runtime.localFor(topic.id).localId };
            return { runtime, queue, descriptor };
        },
    };
}
module.exports = { fixture };

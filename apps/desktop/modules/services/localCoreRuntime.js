'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { filterChatModels } = require('./nativeSync/contracts.generated.cjs');
const { CoreSingleClient } = require('./nativeSync/coreSingleClient');
const { registerNativeSyncQueries } = require('./nativeSync/queries');
const { durableJson } = require('./nativeSync/durableJson');
const { ownedJson } = require('./nativeSync/sharedLocal');
const { fail } = require('./nativeSync/protocol');
const { DesktopAttachments } = require('./nativeSync/attachments');
const { extractAgentDTO } = require('../../VCPDistributedServer/Plugin/VCPMobileSync/dto/agent.dto');
const { extractGroupDTO } = require('../../VCPDistributedServer/Plugin/VCPMobileSync/dto/group.dto');
const { projectRules } = require('./nativeSync/executionConfigs');

function mapTopic(descriptor) {
    const { itemType = 'agent', itemId, topicId } = descriptor;
    if (!['agent','group'].includes(itemType) || [itemId, topicId].some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(id))) {
        throw fail('INVALID_CORE_TOPIC');
    }
    return { local: { itemType, itemId, topicId },
        sharedId: 'local_' + createHash('sha256').update(JSON.stringify([itemType,itemId,topicId])).digest('hex') };
}

const agentConfiguration = config => {
    const projected = extractAgentDTO(config);
    if (Array.isArray(config.stripRegexes)) projected.stripRegexes = config.stripRegexes;
    return projected;
};

class LocalCoreClient extends CoreSingleClient {
    owns(descriptor) {
        return this.runtime.enabled && ['agent','group'].includes(descriptor?.itemType || 'agent');
    }

    mapping(descriptor) { return mapTopic(descriptor); }
    route(mapping, resource) {
        return this.runtime.base + '/' + encodeURIComponent(this.runtime.workspace) + '/' + mapping.sharedId + '/' + resource;
    }

    async listModels() {
        this.runtime.assertSharedAccess();
        const data = await this.runtime.send(this.runtime.base + '/' + encodeURIComponent(this.runtime.workspace) + '/models');
        if (!Array.isArray(data?.data)) throw fail('CORE_MODEL_CATALOG_UNAVAILABLE');
        return data.purpose === 'chat' ? data.data : filterChatModels(data.data);
    }

    async announceResources() {
        const { nativeSyncRouteId } = require('./topicSponsorDelivery');
        await this.runtime.send(this.runtime.base + '/' + encodeURIComponent(this.runtime.workspace) + '/resource-node', {
            body: { routeHash: createHash('sha256').update(nativeSyncRouteId).digest('hex') }
        });
    }

    async history(descriptor) {
        try { await this.runtime.define(descriptor); }
        catch (error) {
            if (error.code !== 'NETWORK_UNAVAILABLE') throw error;
        }
        return super.history(descriptor);
    }

    async send(descriptor, message) {
        await this.runtime.define(descriptor);
        return super.send(descriptor, message);
    }

    async defineTopic(descriptor) { await this.runtime.define(descriptor); }
    assertCanConfigure() { this.runtime.assertCanConfigure(); }
    groupMode(descriptor) { return this.runtime.groupModes.get(this.mapping(descriptor).sharedId); }
    async invite(descriptor, member, redo) { await this.runtime.define(descriptor); return super.invite(descriptor, member, redo); }
    async jev(descriptor, action, member) { await this.runtime.define(descriptor); return super.jev(descriptor, action, member); }
    async gameEvent(descriptor, payload) { await this.runtime.define(descriptor); return super.gameEvent(descriptor, payload); }
    async gameTurn(descriptor, payload) { await this.runtime.define(descriptor); return super.gameTurn(descriptor, payload); }
}

async function openLocalCore({ queue, appDataRoot, workspace, readSettings, readAgent, readGroup, readRules,
    ipcMain, getMainWindow, notify, notifyExecutionStatus, notifyGroupEvent, storeAttachment, writeOwner, notifyDirectory,
    remoteOrigin, remoteToken, remotePairCode, expectedStorageId = process.env.VCPCHAT_CORE_EXPECTED_STORAGE_ID }) {
    const settings = await readSettings();
    const remote = Boolean(remoteOrigin);
    const endpoint = new URL(remoteOrigin || settings.vcpServerUrl);
    let credential = remote ? remoteToken : settings.vcpApiKey;
    if (endpoint.username || endpoint.password || (remote
        ? endpoint.protocol !== 'https:' || endpoint.origin !== remoteOrigin
        : !['http:', 'https:'].includes(endpoint.protocol) || !['127.0.0.1', '[::1]'].includes(endpoint.hostname) ||
            typeof credential !== 'string' || !credential.trim())) {
        throw fail(remote ? 'CORE_REMOTE_HTTPS_ORIGIN_REQUIRED' : 'CORE_LOCAL_REQUIRES_AUTHENTICATED_LOOPBACK');
    }
    const root = path.resolve(appDataRoot);
    const dir = path.join(root, '.vcp-core');
    const marker = path.join(dir, 'profile.json');
    const previous = await ownedJson(root, marker, { optional: true });
    if (previous && (previous.workspace !== workspace || previous.origin !== endpoint.origin || Boolean(previous.remote) !== remote)) {
        throw fail('CORE_LOCAL_PROFILE_CHANGED');
    }
    if (queue.syncPolicy?.isRecoveryFence || queue.syncPolicy?.sharedSpaceId ||
        await ownedJson(root, path.join(root, '.native-sync', 'connection.json'), { optional: true })) {
        throw fail('CORE_LOCAL_REQUIRES_SEPARATE_PROFILE');
    }
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const binding = { workspace, origin: endpoint.origin, ...(remote && { remote: true }) };
    if (!previous) await durableJson(marker, { ...binding, storageId: null });
    if (previous && !Object.hasOwn(previous, 'storageId') && !expectedStorageId) {
        throw fail('CORE_DATABASE_IDENTITY_REQUIRED');
    }
    let storageId = previous?.storageId || expectedStorageId;
    if (storageId && !/^[0-9a-f-]{36}$/.test(storageId)) throw fail('CORE_DATABASE_IDENTITY_REQUIRED');
    const request = async (route, options = {}) => {
        try {
            const response = await fetch(endpoint.origin + route, {
                method: options.method || (options.body ? 'POST' : 'GET'),
                headers: { ...(storageId && { 'X-VCP-Core-Storage-Id': storageId }), ...(credential && { Authorization: 'Bearer ' + credential }),
                    ...(options.body && { 'Content-Type': 'application/json' }) },
                ...(options.body && { body: JSON.stringify(options.body) }),
                redirect: 'error', cache: 'no-store', signal: options.signal || AbortSignal.timeout(15000)
            });
            if (!response.ok) {
                const data = await response.json().catch(() => null);
                throw Object.assign(fail(data?.error?.code || 'CORE_REQUEST_FAILED'), { status: response.status });
            }
            return response;
        } catch (error) {
            if (error.status) throw error;
            throw fail('NETWORK_UNAVAILABLE');
        }
    };
    const base = remote ? '/core/api' : '/api/core';
    const workspaceRoute = base + '/' + encodeURIComponent(workspace);
    let permissions;
    if (remote) {
        const storage = require('electron').safeStorage;
        const secretFile = path.join(dir, 'device.json');
        const stored = await ownedJson(root, secretFile, { optional: true });
        const safe = storage?.isEncryptionAvailable() && storage.getSelectedStorageBackend?.() !== 'basic_text';
        if (!credential && remotePairCode) {
            if (!safe) throw fail('CORE_REMOTE_KEYRING_REQUIRED');
            const enrollment = await (await request(base + '/pair', { body: { code: remotePairCode } })).json();
            if (enrollment.workspace !== workspace || !/^[A-Za-z0-9_-]{43}$/.test(enrollment.token)) throw fail('CORE_REMOTE_DEVICE_INVALID');
            credential = enrollment.token;
            await durableJson(secretFile, { encrypted: storage.encryptString(credential).toString('base64') });
        } else if (!credential && stored && safe) {
            credential = storage.decryptString(Buffer.from(stored.encrypted, 'base64'));
        }
        if (!/^[A-Za-z0-9_-]{43}$/.test(credential || '')) throw fail('CORE_REMOTE_PAIR_REQUIRED');
        const session = await (await request(base + '/session')).json();
        if (session.workspace !== workspace || !session.permissions?.includes('read')) throw fail('CORE_REMOTE_DEVICE_INVALID');
        permissions = new Set(session.permissions);
    }
    const identity = await request(workspaceRoute + '/identity').then(response => response.json()).catch(error => {
        if (!remote && previous?.storageId && error.code === 'NETWORK_UNAVAILABLE') return null;
        throw error;
    });
    if (identity) {
        if (identity.workspace !== workspace || !/^[0-9a-f-]{36}$/.test(identity.storageId || '') ||
            storageId && identity.storageId !== storageId) throw fail('CORE_DATABASE_IDENTITY_MISMATCH');
        storageId = identity.storageId;
        if (previous?.storageId !== storageId) await durableJson(marker, { ...binding, storageId });
    }
    const pending = new Map(), written = new Map(), commands = new Map();
    const versions = new Map(), ownerVersions = new Map();
    const nativeFile = (kind, id) => path.join(root, kind === 'agent' ? 'Agents' : 'AgentGroups', id, 'config.json');
    const coreProjection = (kind, config) => kind === 'agent'
        ? agentConfiguration(config)
        : { ...extractGroupDTO(config), ...(config.modeSettings && { modeSettings: config.modeSettings }),
            ...(config.sequentialSpeakerOrder && { sequentialSpeakerOrder: config.sequentialSpeakerOrder }) };
    const ownerFingerprint = (kind, owner, topic) => JSON.stringify([coreProjection(kind, owner), topic?.name]);
    const baseline = new Map();
    const remoteProjection = path.join(dir, 'catalog.json');
    async function loadRemoteDirectory() {
        const snapshot = await (await request(workspaceRoute + '/desktop-directory')).json();
        const owners = new Map();
        for (const item of snapshot.agents) {
            owners.set('agent:' + item.id, { kind: 'agent', id: item.id, config: item.config, topics: [] });
            ownerVersions.set(item.id, item.version);
        }
        for (const row of snapshot.topics) {
            const { local, sharedId } = mapTopic({ itemType: row.ownerType, itemId: row.ownerId, topicId: row.topicId });
            if (row.key !== sharedId) throw fail('CORE_DIRECTORY_INVALID');
            const identity = row.ownerType + ':' + row.ownerId;
            let owner = owners.get(identity);
            if (!owner) owners.set(identity, owner = { kind: row.ownerType, id: row.ownerId, topics: [], config: row.config.group || row.config });
            owner.topics.push({ id: row.topicId, name: row.name, createdAt: 1 });
            versions.set(sharedId, row.version);
            runtime.localTopics.set(sharedId, { local, sharedId });
            if (row.config.group) runtime.groupModes.set(sharedId, row.config.group.mode);
        }
        const last = await ownedJson(root, remoteProjection, { optional: true });
        for (const [identity, owner] of owners) {
            const { kind, id, config, topics } = owner;
            const current = await ownedJson(root, nativeFile(kind, id), { optional: true });
            const managedTopics = new Set(last?.[identity] || []);
            const kept = (current?.topics || []).filter(topic => !managedTopics.has(topic.id) && !topics.some(row => row.id === topic.id));
            const projected = {
                ...current, ...coreProjection(kind, kind === 'agent' && config.promptTemplate ? { ...config, systemPrompt: config.promptTemplate } : config), id, _historyDeleting: false, topics: [...topics, ...kept],
                current_topic_id: topics.some(row => row.id === current?.current_topic_id) ? current.current_topic_id : topics[0]?.id || kept[0]?.id
            };
            await writeOwner(kind, id, projected, Boolean(current));
            for (const topic of topics) baseline.set(mapTopic({ itemType: kind, itemId: id, topicId: topic.id }).sharedId, ownerFingerprint(kind, projected, topic));
        }
        for (const [identity, topics] of Object.entries(last || {})) {
            if (owners.has(identity)) continue;
            const [kind, id] = identity.split(':');
            if (!['agent', 'group'].includes(kind) || !/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw fail('CORE_DIRECTORY_INVALID');
            const current = await ownedJson(root, nativeFile(kind, id), { optional: true });
            if (!current) continue;
            const remaining = current.topics.filter(topic => !topics.includes(topic.id));
            await writeOwner(kind, id, { ...current, topics: remaining, _historyDeleting: !remaining.length }, true);
        }
        await durableJson(remoteProjection, Object.fromEntries([...owners].map(([key, row]) => [key, row.topics.map(topic => topic.id)])));
        notifyDirectory?.();
    }
    const runtime = {
        enabled: true, root, dir, workspace, base, queue, notify, notifyExecutionStatus, notifyGroupEvent, storeAttachment, readOnly: false,
        groupModes: new Map(), localTopics: new Map(),
        attachments: { localFile: DesktopAttachments.prototype.localFile.bind({ root }) },
        execution: { async run(key, fn) {
            const op = (commands.get(key) || Promise.resolve()).catch(() => {}).then(fn);
            commands.set(key, op);
            try { return await op; }
            finally { if (commands.get(key) === op) commands.delete(key); }
        } },
        close: null,
        assertSharedAccess() { if (runtime.closed) throw fail('HOST_DRAINING'); },
        assertCanConfigure() {
            runtime.assertSharedAccess();
            if (remote && !permissions.has('config')) throw fail('CORE_WORKSPACE_FORBIDDEN');
        },
        send: async (route, options) => (await request(route, options)).json(),
        download: async route => Buffer.from(await (await request(route)).arrayBuffer()),
        observeRequest: (route, signal) => request(route, { signal }),
        nativeObject: (_kind, id) => ({ id }),
        localFor: id => ({ localId: id }),
        async define(descriptor) {
            runtime.assertSharedAccess();
            const mapping = mapTopic(descriptor);
            const { local: { itemType, itemId, topicId }, sharedId } = mapping;
            const prior = pending.get(sharedId) || Promise.resolve();
            const operation = prior.catch(() => {}).then(async () => {
                const owner = await (itemType === 'group' ? readGroup(itemId) : readAgent(itemId));
                const topic = owner?.topics?.find(value => value.id === topicId);
                if (!topic || owner.error || owner._historyDeleting) throw fail('CORE_TOPIC_NOT_FOUND');
                if (remote && versions.has(sharedId) && (!permissions.has('config') ||
                    baseline.get(sharedId) === ownerFingerprint(itemType, owner, topic))) return;
                if (remote && !permissions.has('config')) throw fail('CORE_WORKSPACE_FORBIDDEN');
                const native = await queue.inspect(mapping.local);
                if (native.history?.length) throw fail('CORE_OFFLINE_HISTORY_IMPORT_REQUIRED');
                const ruleSet = await readRules(mapping.local);
                const tavernRules = projectRules(ruleSet);
                const s = await readSettings();
                const executionPolicy = {
                    userName: s.userName || '用户', enableThoughtChainInjection: s.enableThoughtChainInjection === true,
                    enableContextSanitizer: s.enableContextSanitizer === true,
                    contextSanitizerDepth: Number(s.contextSanitizerDepth ?? 2), enableVcpToolInjection: s.enableVcpToolInjection === true,
                    enableContextCompaction: s.enableContextCompaction === true,
                    ...(typeof s.contextCompactionModel === 'string' && { contextCompactionModel: s.contextCompactionModel }),
                    ...(typeof s.contextCompactionFallbackModel === 'string' && { contextCompactionFallbackModel: s.contextCompactionFallbackModel })
                };
                let config = { ...agentConfiguration(owner), tavernRules, executionPolicy };
                if (itemType === 'group') {
                    const group = { ...extractGroupDTO(owner), ...(owner.modeSettings && { modeSettings: owner.modeSettings }),
                        ...(owner.sequentialSpeakerOrder && { sequentialSpeakerOrder: owner.sequentialSpeakerOrder }) };
                    const agents = await Promise.all(group.members.map(async id => {
                        const member = await readAgent(id);
                        return member && !member.error && member.model ? { id, ...agentConfiguration(member) } : { id, unavailable: true };
                    }));
                    config = { group, agents, tavernRules, executionPolicy };
                    runtime.groupModes.set(sharedId, group.mode);
                }
                const body = { ownerType: itemType, ownerId: itemId, topicId, name: topic.name || topicId, config };
                const signature = JSON.stringify(body);
                if (written.get(sharedId) !== signature) {
                    const result = await runtime.send(runtime.coreSingle.route(mapping, 'definition'), { method: 'PUT',
                        body: { ...body, ...(remote && { version: versions.get(sharedId) ?? 0 }) } });
                    versions.set(sharedId, result.version);
                    baseline.set(sharedId, ownerFingerprint(itemType, owner, topic));
                    written.set(sharedId, signature);
                    runtime.localTopics.set(sharedId, mapping);
                }
            });
            pending.set(sharedId, operation);
            try { await operation; }
            finally { if (pending.get(sharedId) === operation) pending.delete(sharedId); }
        },
        async prepareSharedSend({ descriptor, message, localOnly }) {
            if (localOnly) return { handled: false };
            return runtime.coreSingle.send(descriptor, message);
        },
        async saveOwnerConfig(request) {
            runtime.assertSharedAccess();
            if (remote && !permissions.has('config')) throw fail('CORE_WORKSPACE_FORBIDDEN');
            if (request.kind !== 'agent') {
                const result = await request.saveLocal?.();
                if (result?.success !== false) {
                    const owner = await readGroup(request.localId);
                    for (const topic of owner?.topics || []) await runtime.define({ itemType: 'group', itemId: request.localId, topicId: topic.id });
                }
                return result;
            }
            const owner = await readAgent(request.localId);
            const result = await runtime.send(workspaceRoute + '/agents/' + encodeURIComponent(request.localId), {
                method: 'PUT', body: { config: agentConfiguration({ ...owner, ...request.config }), version: ownerVersions.get(request.localId) ?? 0 }
            });
            ownerVersions.set(request.localId, result.version);
            return request.saveLocal?.();
        },
        async removeDefinition({ itemType, itemId, topicId }) {
            runtime.assertSharedAccess();
            if (remote && !permissions.has('config')) throw fail('CORE_WORKSPACE_FORBIDDEN');
            const current = await ownedJson(root, nativeFile(itemType, itemId), { optional: true });
            if (!current) throw fail('CORE_TOPIC_NOT_FOUND');
            const requestId = 'remove_' + createHash('sha256').update(JSON.stringify([itemType,itemId,topicId])).digest('hex');
            if (topicId) await runtime.define({ itemType, itemId, topicId }).catch(error => {
                if (error.status !== 404) throw error;
            });
            await runtime.send(workspaceRoute + '/remove-definition', { body: { kind: itemType, id: itemId, topicId, requestId } });
            const remaining = topicId ? current.topics.filter(topic => topic.id !== topicId) : [];
            await writeOwner(itemType, itemId, { ...current, topics: remaining, ...(!topicId && { _historyDeleting: true }),
                current_topic_id: remaining.find(topic => topic.id === current.current_topic_id)?.id || remaining[0]?.id || null }, true);
            notifyDirectory?.();
            return { success: true, remainingTopics: remaining, newTopicId: remaining[0]?.id || null };
        },
        nativeDeletionContext(scope) { return { success: true, kind: 'shared', core: true, ...(scope?.topicId && { sharedId: mapTopic(scope).sharedId }) }; },
        async getExecutionStatus(descriptor) {
            if (!descriptor.itemId || !descriptor.topicId) return { enabled: true, core: true };
            await runtime.define(descriptor);
            return runtime.coreSingle.status(descriptor);
        },
        cancelNativeSession({ descriptor, executionId, operationId }) { return runtime.coreSingle.control(descriptor, executionId, 'cancel', operationId); },
        async submitSharedSteering({ descriptor, message, observedWorkId }) {
            const receipt = await runtime.coreSingle.steer(descriptor, observedWorkId, message.content, message.id);
            return { ...receipt, handled: true, inputAccepted: true, success: true };
        },
        stopNativeTask({ descriptor, workId, nativeTaskId }) { return runtime.coreSingle.stopTask(descriptor, workId, nativeTaskId); },
        getNativeTaskResult(...args) { return runtime.coreSingle.taskResult(...args); },
        abandonSharedSend({ descriptor, requestId, confirmed }) {
            if (confirmed !== true) throw fail('WORK_REVIEW_CONFIRMATION_REQUIRED');
            return runtime.coreSingle.control(descriptor, requestId, 'release');
        }
    };
    runtime.coreSingle = new LocalCoreClient(runtime);
    if (remote) await loadRemoteDirectory();
    const previousPolicy = queue.syncPolicy;
    const reject = () => { throw fail('CORE_ROUTE_REQUIRED'); };
    const beforeHistoryWrite = async d => {
        if (d.itemType === 'group' || !d.topicId) return reject();
        const { local } = mapTopic(d);
        const owner = await readAgent(local.itemId);
        if (owner?.topics?.some(topic => topic.id === local.topicId)) return reject();
        const file = path.join(path.dirname(queue.getHistoryPath(local.itemId, local.topicId)), 'sidechat-child.json');
        const side = await ownedJson(root, file, { optional: true });
        if (!/^sidechat_\d+_[0-9a-f]+$/.test(local.topicId) || side?.ephemeral !== true || side?.schemaVersion !== 1 ||
            side?.agentId !== local.itemId || side?.topicId !== local.topicId || side?.historyDeleting) return reject();
    };
    queue.coreClient = runtime.coreSingle;
    queue.configureSync({
        isEnabled: () => false,
        beforeMutation: beforeHistoryWrite,
        beforeWrite: beforeHistoryWrite,
        beforeInitialize: (_descriptor, { history }) => { if (history.length) reject(); },
        diagnostics: () => ({ enabled: true, core: true })
    });
    let queries;
    try {
        queries = ipcMain && registerNativeSyncQueries({ ipcMain, getRuntime: () => runtime, getMainWindow });
    } catch (error) {
        delete queue.coreClient;
        queue.configureSync(previousPolicy);
        throw error;
    }
    runtime.beginShutdown = () => { runtime.closed = true; };
    runtime.close = async () => {
        runtime.beginShutdown();
        await runtime.coreSingle.close();
        await queries?.close();
    };
    return runtime;
}

module.exports = { openLocalCore, mapTopic };

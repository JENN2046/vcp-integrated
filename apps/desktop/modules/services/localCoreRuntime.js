'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { CoreSingleClient } = require('./nativeSync/coreSingleClient');
const { registerNativeSyncQueries } = require('./nativeSync/queries');
const { durableJson } = require('./nativeSync/durableJson');
const { ownedJson } = require('./nativeSync/sharedLocal');
const { fail } = require('./nativeSync/protocol');
const { DesktopAttachments } = require('./nativeSync/attachments');
const { extractAgentDTO } = require('../../VCPDistributedServer/Plugin/VCPMobileSync/dto/agent.dto');
const { extractGroupDTO } = require('../../VCPDistributedServer/Plugin/VCPMobileSync/dto/group.dto');
const { projectRules } = require('./nativeSync/sharedHost');

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
        return '/api/core/' + encodeURIComponent(this.runtime.workspace) + '/' + mapping.sharedId + '/' + resource;
    }

    async announceResources() {
        const { nativeSyncRouteId } = require('./nativeSync/sharedTopicSponsor');
        await this.runtime.send('/api/core/' + encodeURIComponent(this.runtime.workspace) + '/resource-node', {
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

    groupMode(descriptor) { return this.runtime.groupModes.get(this.mapping(descriptor).sharedId); }
    async invite(descriptor, member, redo) { await this.runtime.define(descriptor); return super.invite(descriptor, member, redo); }
    async jev(descriptor, action, member) { await this.runtime.define(descriptor); return super.jev(descriptor, action, member); }
    async gameEvent(descriptor, payload) { await this.runtime.define(descriptor); return super.gameEvent(descriptor, payload); }
    async gameTurn(descriptor, payload) { await this.runtime.define(descriptor); return super.gameTurn(descriptor, payload); }
}

async function openLocalCore({ queue, appDataRoot, workspace, readSettings, readAgent, readGroup, readRules,
    ipcMain, getMainWindow, notify, notifyExecutionStatus, notifyGroupEvent, storeAttachment }) {
    const settings = await readSettings();
    const endpoint = new URL(settings.vcpServerUrl);
    if (!['http:', 'https:'].includes(endpoint.protocol) || !['127.0.0.1', '[::1]'].includes(endpoint.hostname) ||
        endpoint.username || endpoint.password || typeof settings.vcpApiKey !== 'string' || !settings.vcpApiKey.trim()) {
        throw fail('CORE_LOCAL_REQUIRES_AUTHENTICATED_LOOPBACK');
    }
    const root = path.resolve(appDataRoot);
    const dir = path.join(root, '.vcp-core');
    const marker = path.join(dir, 'profile.json');
    const previous = await ownedJson(root, marker, { optional: true });
    if (previous && (previous.workspace !== workspace || previous.origin !== endpoint.origin)) {
        throw fail('CORE_LOCAL_PROFILE_CHANGED');
    }
    if (queue.syncPolicy?.isRecoveryFence || queue.syncPolicy?.sharedSpaceId ||
        await ownedJson(root, path.join(root, '.native-sync', 'connection.json'), { optional: true })) {
        throw fail('CORE_LOCAL_REQUIRES_SEPARATE_PROFILE');
    }
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    if (!previous) await durableJson(marker, { workspace, origin: endpoint.origin });
    const request = async (route, options = {}) => {
        try {
            const response = await fetch(endpoint.origin + route, {
                method: options.method || (options.body ? 'POST' : 'GET'),
                headers: { Authorization: 'Bearer ' + settings.vcpApiKey, ...(options.body && { 'Content-Type': 'application/json' }) },
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
    const pending = new Map(), written = new Map(), commands = new Map();
    const runtime = {
        enabled: true, root, dir, workspace, queue, notify, notifyExecutionStatus, notifyGroupEvent, storeAttachment, readOnly: false,
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
                if (!topic || owner.error) throw fail('CORE_TOPIC_NOT_FOUND');
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
                    await runtime.send(runtime.coreSingle.route(mapping, 'definition'), { method: 'PUT', body });
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
        queries = ipcMain && registerNativeSyncQueries({ ipcMain, getRuntime: () => runtime, getMainWindow, queue });
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

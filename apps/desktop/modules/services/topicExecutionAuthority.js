'use strict';
// Host boundary only: inspect existing validated bindings, never accept work,
// create mappings, contact the server, or implement local chat scheduling.
const fs = require('node:fs/promises');
const path = require('node:path');
const { conversationKey } = require('./historyMutationQueue');
const failure = code => Object.assign(new Error(code), { code });
function createTopicExecutionAuthority({ appDataRoot, getQueue, getRuntime = () => require('./nativeSync/sharedHost').runtimeForRoot(appDataRoot) }) {
    const root = path.resolve(appDataRoot);
    async function nativeOwner(scope, topicRequired) {
        const kind = scope?.itemType || 'agent';
        conversationKey({ ...scope, itemType: kind, topicId: scope?.topicId || 'owner-validation' });
        const configFile = path.join(root, kind === 'group' ? 'AgentGroups' : 'Agents', scope.itemId, 'config.json');
        const config = JSON.parse(await fs.readFile(configFile, 'utf8'));
        if (topicRequired) {
            if (!config.topics?.some(topic => topic.id === scope.topicId)) throw failure('TOPIC_NOT_FOUND');
        }
        return config;
    }
    async function configured() {
        try { await fs.access(path.join(root, '.native-sync', 'connection.json')); return true; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        try { const directories = await fs.readdir(path.join(root, '.native-sync', 'shared')); return directories.length > 0; }
        catch (error) { if (error.code !== 'ENOENT') throw error; return false; }
    }
    async function classify(scope, { ownerOnly = false } = {}) {
        try {
            const kind = scope?.itemType || 'agent';
            const normalized = { ...scope, itemType: kind };
            const config = await nativeOwner(normalized, !ownerOnly);
            const localClassification = async () => {
                if (!ownerOnly) await fs.access(path.join(root, 'UserData', scope.itemId, 'topics', scope.topicId, 'history.json'));
                return { success: true, kind: 'local' };
            };
            const queue = getQueue();
            if (!queue || queue.disposed) throw failure('TOPIC_AUTHORITY_NOT_READY');
            const policy = queue.syncPolicy;
            if (policy?.isRecoveryFence) throw failure('SHARED_STARTUP_RECOVERY_REQUIRED');
            const runtime = getRuntime() || policy?.sharedExecution?.runtime;
            if (!runtime) {
                const sourceOnly = Boolean(policy?.source && policy?.state?.source && !policy.sharedSpaceId && !policy.startupError);
                if (policy?.sharedSpaceId || (!sourceOnly && await configured()) || config.__nativeSyncSharedBase) throw failure('SHARED_AUTHORITY_UNAVAILABLE');
                return await localClassification();
            }
            if (!runtime.ready || runtime.closed || runtime.directoryPaused || !runtime.state?.locals || !runtime.state?.objects) throw failure('SHARED_STARTUP_PENDING');
            const locals = Object.entries(runtime.state.locals);
            const ownerRows = locals.filter(([, local]) => local.kind === kind && local.localId === scope.itemId);
            if (runtime.state.retiredOwners?.[kind + ':' + scope.itemId]) throw failure('SHARED_OBJECT_MERGED');
            if (!ownerRows.length) {
                // A validated shared connection covers the full source. A newly
                // created owner may still be awaiting the existing directory scan;
                // absence from its registry is not permission for local execution.
                if (runtime.connection?.sharedSpaceId || config.__nativeSyncSharedBase || locals.some(([, local]) => local.localParent === scope.itemId)) throw failure('SHARED_LOCAL_MAPPING_PENDING');
                return await localClassification();
            }
            const active = ownerRows.filter(([id, local]) => !local.aliasOf && runtime.state.objects[id] && !runtime.state.objects[id].deleted);
            if (active.length !== 1) throw failure('SHARED_LOCAL_MAPPING_PENDING');
            const ownerId = active[0][0];
            runtime.matching.assert([ownerId]);
            if (!runtime.isLocalVisible(ownerId)) throw failure('SHARED_LOCAL_REMOVED');
            if (ownerOnly) return { success: true, kind: 'shared', sharedId: ownerId };
            const topicRows = locals.filter(([, local]) => local.kind === 'topic' && local.localParent === scope.itemId && local.localId === scope.topicId);
            if (topicRows.length !== 1 || topicRows[0][1].aliasOf) throw failure('SHARED_LOCAL_MAPPING_PENDING');
            const topicId = topicRows[0][0], topic = runtime.state.objects[topicId];
            if (!topic || topic.deleted || topic.parentId !== ownerId || !runtime.isLocalVisible(topicId)) throw failure('SHARED_LOCAL_MAPPING_PENDING');
            runtime.matching.assert([ownerId, topicId]);
            if (runtime.coreSingle?.owns(normalized)) {
                if (runtime.coreSingle.mapping(normalized).sharedId !== topicId) throw failure('SHARED_LOCAL_MAPPING_PENDING');
                return { success: true, kind: 'shared', core: true, sharedId: topicId };
            }
            const mapping = runtime.execution.mapping(normalized);
            if (mapping.sharedId !== topicId) throw failure('SHARED_LOCAL_MAPPING_PENDING');
            // Only a fully validated shared binding may use Queue's guarded
            // empty snapshot. Never create History or weaken local existence.
            await queue.readSnapshot(normalized);
            return { success: true, kind: 'shared', sharedId: topicId };
        } catch (error) {
            return { success: false, kind: 'unknown', code: error.code || 'TOPIC_AUTHORITY_UNAVAILABLE', error: error.code || 'TOPIC_AUTHORITY_UNAVAILABLE' };
        }
    }
    async function assertLocal(scope, options) {
        const result = await classify(scope, options);
        if (!result.success) throw failure(result.code);
        if (result.kind !== 'local') throw failure('SHARED_NATIVE_ROUTE_REQUIRED');
        return result;
    }
    async function classifyNativeRequest(context) {
        if(context?.agentId && context?.topicId) return classify({itemType:context.ownerType||'agent',itemId:context.agentId,topicId:context.topicId});
        if(context?.agentId && !context.topicId) return classify({itemType:context.ownerType||'agent',itemId:context.agentId},{ownerOnly:true});
        try {
            const queue=getQueue();
            if(!queue || queue.disposed || queue.syncPolicy?.isRecoveryFence || getRuntime() || queue.syncPolicy?.sharedSpaceId || await configured()) throw failure('TOPIC_AUTHORITY_REQUIRED');
            return {success:true,kind:'local',auxiliary:true};
        } catch(error) { return {success:false,kind:'unknown',code:error.code||'TOPIC_AUTHORITY_UNAVAILABLE',error:error.code||'TOPIC_AUTHORITY_UNAVAILABLE'}; }
    }
    return { classify, assertLocal, classifyNativeRequest };
}
async function prepareNativeRequest({authority,queue,context,body}) {
    if(!authority?.classifyNativeRequest) throw failure('TOPIC_AUTHORITY_UNAVAILABLE');
    const owner=await authority.classifyNativeRequest(context);
    if(!owner?.success || !['local','shared'].includes(owner.kind)) throw failure(owner?.code||'TOPIC_AUTHORITY_UNAVAILABLE');
    if(owner.kind==='local') return null;
    if(owner.core)throw failure('CORE_ROUTE_REQUIRED');
    if(!queue?.syncPolicy?.sharedExecution) throw failure('SHARED_AUTHORITY_UNAVAILABLE');
    return queue.syncPolicy.sharedExecution.prepareNative(context,body);
}
module.exports = { createTopicExecutionAuthority, prepareNativeRequest };

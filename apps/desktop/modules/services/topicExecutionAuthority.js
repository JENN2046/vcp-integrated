'use strict';
// Host boundary only: inspect existing validated bindings, never accept work,
// create mappings, contact the server, or implement local chat scheduling.
const fs = require('node:fs/promises');
const path = require('node:path');
const { conversationKey } = require('./historyMutationQueue');
const failure = code => Object.assign(new Error(code), { code });
function createTopicExecutionAuthority({ appDataRoot, getQueue }) {
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
            if (queue.coreClient) {
                if (ownerOnly) return { success: true, kind: 'shared', core: true };
                return { success: true, kind: 'shared', core: true, sharedId: queue.coreClient.mapping(normalized).sharedId };
            }
            if (queue.coreIdentityError) throw failure(queue.coreIdentityError);
            if (process.env.VCPCHAT_LOCAL_CORE_WORKSPACE || process.env.VCPCHAT_CORE_REMOTE_ORIGIN || await fs.access(path.join(root, '.vcp-core/profile.json')).then(
                () => true, error => { if (error.code === 'ENOENT') return false; throw error; }
            )) throw failure('CORE_LOCAL_AUTHORITY_UNAVAILABLE');
            if (await configured() || config.__nativeSyncSharedBase) throw failure('SHARED_AUTHORITY_UNAVAILABLE');
            return await localClassification();
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
            if(!queue || queue.disposed || queue.syncPolicy?.isRecoveryFence || queue.syncPolicy?.sharedSpaceId || await configured()) throw failure('TOPIC_AUTHORITY_REQUIRED');
            return {success:true,kind:'local',auxiliary:true};
        } catch(error) { return {success:false,kind:'unknown',code:error.code||'TOPIC_AUTHORITY_UNAVAILABLE',error:error.code||'TOPIC_AUTHORITY_UNAVAILABLE'}; }
    }
    return { classify, assertLocal, classifyNativeRequest };
}
async function prepareNativeRequest({authority,context}) {
    if(!authority?.classifyNativeRequest) throw failure('TOPIC_AUTHORITY_UNAVAILABLE');
    const owner=await authority.classifyNativeRequest(context);
    if(!owner?.success || !['local','shared'].includes(owner.kind)) throw failure(owner?.code||'TOPIC_AUTHORITY_UNAVAILABLE');
    if(owner.kind==='local') return null;
    throw failure('CORE_ROUTE_REQUIRED');
}
module.exports = { createTopicExecutionAuthority, prepareNativeRequest };

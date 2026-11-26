'use strict';
const { authorityForQueue } = require('../services/historyAuthority');
const { mergeTerminal } = require('../services/nativeSync/mergeTerminal');
function initialize({ ipcMain, historyMutationQueue: queue }) {
    const core = d => {
        const client = queue.coreClient || queue.syncPolicy?.sharedExecution?.runtime?.coreSingle;
        return client?.owns(d) ? client : null;
    };
    ipcMain.handle('native-history:status', () => queue.syncPolicy?.diagnostics() || { enabled: false });
    ipcMain.handle('native-history:messages', async (_event, itemId, itemType, topicId, intent) => {
        const d = {itemId,itemType,topicId};
        const client = core(d);
        if (!client && !queue.isSyncEnabled(d)) return {handled:false};
        try { if(client)return await client.mutate(d,intent);if(queue.syncPolicy?.sharedExecution)return await queue.syncPolicy.sharedExecution.commit(d,intent);return {...await queue.commitMessages(d,intent),handled:true}; }
        catch (error) { return {handled:true,success:false,error:error.code||'HISTORY_MESSAGE_COMMIT_FAILED',localState:error.code==='HISTORY_COMMIT_OUTCOME_UNKNOWN'?'unknown':'failed',...(error.commitId?{commitId:error.commitId}:{})}; }
    });
    ipcMain.handle('native-history:retry-local', async (_event,itemId,itemType,topicId,commitId) => {
        const d={itemId,itemType,topicId};
        if (!queue.isSyncEnabled(d)) return {handled:false};
        try { return {...await queue.syncPolicy.retryLocalCommit(d,commitId),handled:true}; }
        catch(error) { return {handled:true,success:false,error:error.code||'LOCAL_COMMIT_RECOVERY_FAILED'}; }
    });
    ipcMain.handle('native-history:snapshot', async (_event, itemId, itemType, topicId) => {
        try {
            const d = { itemId, itemType, topicId };
            const client = core(d);
            if (client) return await client.history(d);
            if (queue.syncPolicy?.isRecoveryFence) {
                const { CoreSingleClient } = require('../services/nativeSync/coreSingleClient');
                const cached = await CoreSingleClient.offlineHistory(queue, d);
                if (cached) return cached;
            }
            if (!queue.isSyncEnabled(d)) return { syncEnabled: false };
            const read = async () => {
                if (!queue.isSyncEnabled(d)) return { syncEnabled: false };
                await queue.syncPolicy?.sharedExecution?.waitProjection?.(d);
                return queue.readSnapshot(d);
            };
            const authority = authorityForQueue(queue);
            return await (authority ? authority.readAfterTransition(read) : read());
        }
        catch (error) { return { success: false, error: error.code || error.message }; }
    });
    ipcMain.handle('native-history:terminal', async (_event, projected) => {
        const context = projected?.context;
        const d = { itemId: context?.groupId || context?.agentId, itemType: context?.isGroupMessage ? 'group' : 'agent', topicId: context?.topicId };
        if (core(d)) return { handled: true, success: false, error: 'CORE_ROUTE_REQUIRED' };
        if (!queue.isSyncEnabled(d)) return { handled: false };
        try {
            if (!['completed','stop'].includes(projected?.finishReason) || projected?.error || projected?.nativeFailure) throw Object.assign(new Error('NATIVE_TERMINAL_REVIEW_REQUIRED'), {code:'NATIVE_TERMINAL_REVIEW_REQUIRED'});
            if(queue.syncPolicy?.sharedExecution)return await queue.syncPolicy.sharedExecution.terminal(d,projected);
            const causal=context.nativeCausalContext;
            if(causal&&(causal.version!==1||typeof causal.known!=='boolean'||!Array.isArray(causal.dependsOnMessageIds)||causal.dependsOnMessageIds.length>1000||causal.dependsOnMessageIds.some(id=>typeof id!=='string'||!id||id.length>512||id===projected.messageId)))throw Object.assign(Error('INVALID_TERMINAL_CAUSAL_CONTEXT'),{code:'INVALID_TERMINAL_CAUSAL_CONTEXT'});
            // Completion-time visible history can contain unrelated transient
            // peers. Only the request-time snapshot may claim known parents.
            const result = await queue.mutate(d, current => mergeTerminal(current, projected, queue.syncPolicy.deletedMessageIds?.(d) || []), {intent:{source:'native-terminal',known:causal?.known===true,causalContextIds:causal?.dependsOnMessageIds||[],requestId:projected.streamOperationId||context.requestId}});
            return { ...result, handled: true };
        } catch (error) { return { handled: true, success: false, error: error.code || error.message }; }
    });
}
module.exports = { initialize };

import { applyMessageOperations } from './historyMessageIntent.mjs';
/** 将 IPC 失败 DTO 和被抛出的结构化错误统一为 Error，保留冲突码。 */
export function normalizeChatRepositoryError(value, fallback = '聊天仓储操作失败') {
    if (value instanceof Error) return value;
    const detail = value?.error;
    const message = typeof detail === 'string' && detail
        || detail?.message || value?.message
        || (typeof value === 'string' && value) || fallback;
    const error = new Error(message, { cause: value });
    const code = value?.code ?? detail?.code ?? (typeof detail === 'string' ? detail : undefined);
    if (code !== undefined) error.code = code;
    for (const field of ['status', 'initializationStatus', 'commitId']) {
        if (value?.[field] !== undefined) error[field] = value[field];
    }
    return error;
}

/** 兼容既有无返回值保存；明确失败绝不能被解释成成功。 */
export function assertChatRepositorySuccess(value, fallback) {
    if (value instanceof Error || value?.success === false
        || (value?.error !== undefined && value.error !== null && value.error !== false)) {
        throw normalizeChatRepositoryError(value, fallback);
    }
    return value;
}

/**
 * Electron-free contract for chat history persistence. The adapter is the
 * only place where agent/group IPC naming is selected; callers depend on the
 * domain-shaped get/save methods instead of the transport API.
 */
export function createChatRepository(electronAPI) {
    if (!electronAPI) throw new TypeError('ChatRepository requires an IPC adapter');
    const method = (name) => {
        if (typeof electronAPI[name] !== 'function') throw new Error(`Missing chat repository capability: ${name}`);
        return electronAPI[name].bind(electronAPI);
    };
    const revisions = new Map();
    const key = (id, type, topic) => JSON.stringify([type, id, topic]);
    const tracked = new WeakMap();
    const shared = new Map();
    return Object.freeze({
        isSyncEnabled(itemId, itemType, topicId) { return shared.get(key(itemId, itemType, topicId)) === true; },
        revisionOf(history) { return tracked.get(history); },
        revisionFor(itemId, itemType, topicId) { return revisions.get(key(itemId, itemType, topicId)); },
        getHistory(itemId, itemType, topicId) {
            if (typeof electronAPI.getNativeHistorySnapshot === 'function') {
                return electronAPI.getNativeHistorySnapshot(itemId, itemType, topicId).then(snapshot => {
                    if (snapshot?.syncEnabled === false) { shared.set(key(itemId,itemType,topicId),false); return (itemType === 'group' ? method('getGroupChatHistory') : method('getChatHistory'))(itemId, topicId); }
                    if (!Array.isArray(snapshot?.history)) return { error: snapshot?.error || 'History read failed' };
                    if (snapshot.syncEnabled) {
                        shared.set(key(itemId,itemType,topicId),true);
                        revisions.set(key(itemId, itemType, topicId), snapshot.revision);
                        tracked.set(snapshot.history, snapshot.revision);
                    }
                    return snapshot.history;
                });
            }
            return itemType === 'group'
                ? method('getGroupChatHistory')(itemId, topicId)
                : method('getChatHistory')(itemId, topicId);
        },
        persistAssistant(scope, message) {
            return method('topicAdmissionPersistAssistant')(scope, message);
        },
        async saveHistory(itemId, itemType, topicId, history, options = tracked.get(history)) {
            const { expectedRevision = tracked.get(history), expectedHistory } = options && typeof options === 'object'
                ? options : { expectedRevision: options };
            if (!shared.has(key(itemId,itemType,topicId)) && electronAPI.getNativeHistorySnapshot) {
                const snapshot=await electronAPI.getNativeHistorySnapshot(itemId,itemType,topicId);
                if (snapshot?.success===false) throw Object.assign(new Error(snapshot.error),{code:snapshot.error});
                shared.set(key(itemId,itemType,topicId),snapshot?.syncEnabled!==false);
            }
            if (shared.get(key(itemId,itemType,topicId)) && !expectedRevision) throw Object.assign(new Error('Original history revision required'),{code:'HISTORY_REVISION_REQUIRED'});
            const save = itemType === 'group' ? method('saveGroupChatHistory') : method('saveChatHistory');
            const guard = expectedHistory === undefined ? expectedRevision : { expectedRevision, expectedHistory };
            const args = guard === undefined ? [itemId, topicId, history] : [itemId, topicId, history, guard];
            const result = save(...args);
            return Promise.resolve(result).then(value => {
                if (value?.success !== false && value?.revision) {
                    revisions.set(key(itemId,itemType,topicId),value.revision);
                    if(Array.isArray(value.history)){
                        tracked.set(value.history,value.revision);
                        if(JSON.stringify(value.history)===JSON.stringify(history))tracked.set(history,value.revision);
                    }
                }
                return value;
            });
        },
        async commitMessages(itemId,itemType,topicId,intent) {
            if (electronAPI.commitNativeHistoryMessages) {
                const result=await electronAPI.commitNativeHistoryMessages(itemId,itemType,topicId,intent);
                if (result?.handled!==false) {
                    if (result?.success!==false && result?.revision && Array.isArray(result.history)) { tracked.set(result.history,result.revision); revisions.set(key(itemId,itemType,topicId),result.revision); }
                    return result;
                }
            }
            const current=await this.getHistory(itemId,itemType,topicId);
            if (shared.get(key(itemId,itemType,topicId))) throw Object.assign(new Error('Native message IPC required'),{code:'HISTORY_MESSAGE_CAPABILITY_REQUIRED'});
            if (!Array.isArray(current)) throw new Error(current?.error||'History read failed');
            const history=applyMessageOperations(current,intent.operations);
            const result=await this.saveHistory(itemId,itemType,topicId,history,{expectedRevision:tracked.get(current),expectedHistory:structuredClone(current)});
            return {...result,history};
        },
        async commitTerminal(projected) {
            if (typeof electronAPI.commitNativeHistoryTerminal !== 'function') return { handled: false };
            const result = await electronAPI.commitNativeHistoryTerminal(projected);
            const context = projected.context;
            if(result?.success!==false&&result?.revision&&Array.isArray(result.history))tracked.set(result.history,result.revision);
            if (result?.revision && result?.success !== false) revisions.set(key(context.groupId || context.agentId, context.isGroupMessage ? 'group' : 'agent', context.topicId), result.revision);
            return result;
        },
    });
}

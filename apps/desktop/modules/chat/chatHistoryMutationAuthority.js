import { assertChatRepositorySuccess, normalizeChatRepositoryError } from './chatRepository.js';
import { deriveMessageOperations, applyMessageOperations } from './historyMessageIntent.mjs';
const conversationKey = ({ itemId, itemType = 'agent', topicId }) => {
    if (!itemId || !topicId) throw new TypeError('History mutation requires itemId and topicId');
    return `${itemType}:${itemId}/topic:${topicId}`;
};

const freezeData = (value, seen = new WeakSet()) => {
    if (!value || typeof value !== 'object' || seen.has(value)) return value;
    const prototype = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
        throw new TypeError('历史事务只接受普通数据对象和数组');
    }
    seen.add(value);
    for (const child of Object.values(value)) freezeData(child, seen);
    return Object.freeze(value);
};
const snapshotData = value => freezeData(structuredClone(value));
// Receipt processing cannot turn an already successful save into a failed write.
const safeOutcome = (descriptor, result, fallbackHistory) => {
    let history = fallbackHistory;
    try {
        // Keep the repository's WeakMap revision identity for this native snapshot.
        if (Array.isArray(result?.history)) history = freezeData(result.history);
    } catch { /* A malformed post-save receipt cannot revoke a durable save. */ }
    try {
        const receipt = snapshotData(result);
        return Object.freeze({ ...descriptor, history, result: Array.isArray(receipt?.history)
            ? Object.freeze({ ...receipt, history }) : receipt });
    } catch {
        return Object.freeze({ ...descriptor, history,
            result: Object.freeze({ success: true, receiptUnavailable: true }) });
    }
};

/**
 * Single durable write authority for non-stream chat-history mutations.
 * Callers still own domain intent; this provider owns serialization, repository
 * commit and the one observable operation Promise for each mutation.
 */
export function createChatHistoryMutationAuthority({ repository } = {}) {
    if (!repository || typeof repository.getHistory !== 'function' || typeof repository.saveHistory !== 'function') {
        throw new TypeError('ChatHistoryMutationAuthority requires a ChatRepository');
    }
    const queues = new Map();
    let disposed = false;
    let disposal;

    const run = (descriptor, operation) => {
        if (disposed) return Promise.reject(new Error('ChatHistoryMutationAuthority is disposed'));
        const key = conversationKey(descriptor);
        const previous = queues.get(key) || Promise.resolve();
        const current = previous.catch(() => {}).then(operation).catch(error => { throw normalizeChatRepositoryError(error); });
        queues.set(key, current);
        current.finally(() => {
            if (queues.get(key) === current) queues.delete(key);
        }).catch(() => {});
        return current;
    };

    const commit = async (descriptor, history, expectedHistory) => {
        if (!Array.isArray(history)) throw new TypeError('History mutation commit requires an array');
        const snapshot = snapshotData(history);
        const result = await repository.saveHistory(
            descriptor.itemId,
            descriptor.itemType || 'agent',
            descriptor.topicId,
            structuredClone(snapshot),
            { expectedRevision: descriptor.expectedRevision, ...(expectedHistory === undefined ? {} : { expectedHistory }) }
        );
        assertChatRepositorySuccess(result, 'History mutation commit failed');
        return safeOutcome({
            category: descriptor.category || 'replace', itemId: descriptor.itemId,
            itemType: descriptor.itemType || 'agent', topicId: descriptor.topicId,
        }, result, snapshot);
    };

    const messages = async (descriptor,operations,expectedRevision) => {
        const intent={version:1,source:descriptor.category||'native-message',operations,expectedRevision,known:descriptor.causalKnown,causalContextIds:descriptor.causalContextIds,requestId:descriptor.requestId,executionId:descriptor.executionId,localOnly:descriptor.localOnly};
        if (!repository.commitMessages) {
            const current=await repository.getHistory(descriptor.itemId,descriptor.itemType||'agent',descriptor.topicId);
            return commit({...descriptor,expectedRevision:repository.revisionOf?.(current)},applyMessageOperations(current,operations));
        }
        const result=await repository.commitMessages(descriptor.itemId,descriptor.itemType||'agent',descriptor.topicId,intent);
        assertChatRepositorySuccess(result, 'History message commit failed');
        return safeOutcome({category:descriptor.category||'message',...descriptor}, result);
    };
    return Object.freeze({
        messages(descriptor,operations) { return run({...descriptor},()=>messages(descriptor,operations,descriptor.expectedRevision)); },
        append(descriptor,message) { return run({...descriptor},()=>messages(descriptor,[{kind:'append',message}])); },
        edit(descriptor,original,updated) { return run({...descriptor},()=>messages(descriptor,deriveMessageOperations([original],[updated]))); },
        deleteMessages(descriptor,ids,expected=[]) { return run({...descriptor},()=>messages(descriptor,[{kind:'delete',ids:[...ids],expected}])); },
        replace(descriptor, history) {
            descriptor = { ...descriptor, expectedRevision: descriptor.expectedRevision ?? repository.revisionOf?.(history) };
            if (disposed) return Promise.reject(new Error('ChatHistoryMutationAuthority is disposed'));
            const snapshot = snapshotData(history);
            return run(descriptor, () => commit(descriptor, snapshot));
        },
        mutate(descriptor, transform) {
            if (typeof transform !== 'function') throw new TypeError('History mutation requires a transform');
            return run(descriptor, async () => {
                const current = await repository.getHistory(
                    descriptor.itemId,
                    descriptor.itemType || 'agent',
                    descriptor.topicId
                );
                assertChatRepositorySuccess(current, 'History mutation read failed');
                if (!Array.isArray(current)) throw new Error(current?.error || 'History mutation read failed');
                const expectedRevision=repository.revisionOf?.(current);
                const next = await transform(structuredClone(current));
                if (repository.isSyncEnabled?.(descriptor.itemId, descriptor.itemType || 'agent', descriptor.topicId) === false) {
                    return commit(descriptor, next, structuredClone(current));
                }
                return messages({...descriptor,causalContextIds:descriptor.useCurrentContext?current.map(m=>m.id):descriptor.causalContextIds},deriveMessageOperations(current,next,{deleteIds:descriptor.deleteIds||[]}),descriptor.requireUnchangedHistory?expectedRevision:undefined);
            });
        },
        diagnostics() {
            return Object.freeze({ disposed, pendingConversations: queues.size });
        },
        dispose() {
            if (disposal) return disposal;
            disposed = true;
            disposal = Promise.allSettled([...queues.values()]).then(() => queues.clear());
            return disposal;
        },
    });
}

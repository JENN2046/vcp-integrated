function attachmentIdentities(value) {
    if (value == null) return [];
    if (!Array.isArray(value) || value.some(attachment => !attachment || typeof attachment !== 'object'
        || typeof attachment.src !== 'string' || !attachment.src)) return null;
    return value.map(attachment => [
        attachment.type, attachment.src, attachment.name, attachment.size,
        attachment.hash ?? attachment._fileManagerData?.hash,
    ]);
}

function matchesMessage(candidate, expected, scope) {
    if (candidate?.id !== expected.id || candidate.role !== expected.role
        || candidate.timestamp !== expected.timestamp || candidate.content !== expected.content) return false;
    if (scope.itemType === 'group') {
        if (candidate.isGroupMessage !== true || candidate.groupId !== scope.itemId || candidate.topicId !== scope.topicId
            || candidate._metadata?.groupRequestText !== expected._metadata?.groupRequestText) return false;
    } else if (candidate.isGroupMessage === true) return false;
    const actualAttachments = attachmentIdentities(candidate.attachments);
    const expectedAttachments = attachmentIdentities(expected.attachments);
    return actualAttachments !== null && expectedAttachments !== null
        && JSON.stringify(actualAttachments) === JSON.stringify(expectedAttachments);
}

async function recoverAcceptedAdmission(api, { scope, requestId, message }) {
    if (typeof requestId !== 'string' || requestId !== message?.id || message.role !== 'user') return null;
    try {
        const pending = await api.topicAdmissionList?.(scope);
        if (pending?.success === true && Array.isArray(pending.entries)) {
            const original = pending.entries.find(entry => entry.requestId === requestId
                && entry.scope?.itemType === scope.itemType && entry.scope?.itemId === scope.itemId
                && entry.scope?.topicId === scope.topicId && matchesMessage(entry.message, message, scope)
                && (entry.committed === true || ['queued', 'recovered'].includes(entry.state)));
            if (original) {
                return { success: true, queued: true, entryId: original.entryId,
                    recovered: true, messageId: requestId };
            }
        }
    } catch {
        // A later History read may find the original after admission has drained.
    }
    try {
        const response = scope.itemType === 'group'
            ? await api.getGroupChatHistory(scope.itemId, scope.topicId)
            : await api.getChatHistory(scope.itemId, scope.topicId);
        const history = Array.isArray(response) ? response : response?.success !== false && response?.history;
        if (Array.isArray(history) && history.some(item => matchesMessage(item, message, scope))) {
            return { success: true, recovered: true, messageId: requestId };
        }
    } catch {
        // No authoritative evidence of the original outcome.
    }
    return null;
}

export async function submitTopicAdmissionWithRecovery(api, request) {
    try {
        return await api.topicAdmissionSubmit(request);
    } catch (cause) {
        const recovered = await recoverAcceptedAdmission(api, request);
        if (recovered) return recovered;
        throw Object.assign(new Error('原提交结果尚未确认，请先核对当前话题。', { cause }),
            { code: 'TOPIC_ADMISSION_NOT_CONFIRMED' });
    }
}

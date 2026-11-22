export const COMPACTION_KIND = 'vchat-context-checkpoint';

export function isContextCheckpoint(message) {
    return message?.role === 'user'
        && message.contextCompaction?.kind === COMPACTION_KIND
        && message.contextCompaction?.version === 1
        && typeof message.contextCompaction.checkpoint === 'string';
}

export function checkpointFailure(value) {
    if (typeof value !== 'string' || !value.trim()) return '压缩模型未返回有效文本，原历史未修改';
    const text = value.trimStart();
    if (/^(?:\[UPSTREAM_ERROR\]|upstream_stalled(?=$|[\s:：]))/i.test(text)
        || /^\{\s*"error"\s*:/.test(text)) {
        return '压缩模型返回上游错误信封，未保存快照';
    }
    return null;
}

/** UI history remains complete; outbound history starts at the newest usable checkpoint. */
export function effectiveContextHistory(history = []) {
    const retained = [];
    for (let index = history.length - 1; index >= 0; index--) {
        const message = history[index];
        if (!message || message.isThinking) continue;
        if (isContextCheckpoint(message)) {
            if (checkpointFailure(message.contextCompaction.checkpoint)) continue;
            retained.push(message);
            break;
        }
        retained.push(message);
    }
    return retained.reverse();
}

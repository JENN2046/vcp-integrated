export const COMPACTION_KIND = 'vchat-context-checkpoint';

export function isContextCheckpoint(message) {
    return message?.role === 'user'
        && message.contextCompaction?.kind === COMPACTION_KIND
        && message.contextCompaction?.version === 1
        && typeof message.contextCompaction.checkpoint === 'string';
}

/** UI history remains complete; only outbound history starts at the newest checkpoint. */
export function effectiveContextHistory(history = []) {
    let start = 0;
    for (let index = history.length - 1; index >= 0; index--) {
        if (isContextCheckpoint(history[index])) {
            start = index;
            break;
        }
    }
    return history.slice(start).filter(message => message && !message.isThinking);
}

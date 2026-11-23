const identity = value => JSON.stringify([value.itemType, value.itemId, value.topicId]);
export function createNativeHistoryRefresh({ getSelection, getTopicId, syncHistory, hasActiveStream = () => false, isEditing = () => false, isLoadingHistory = () => false, subscribeSelection, reportError = console.error, retryMs = 50 }) {
    const pending = new Map(), saving = new Map(), unsaved = new Map(), persistenceGenerations = new Map();
    let disposed = false, running = false, timer = null;
    const current = () => { const s = getSelection(); return { itemId: s?.id, itemType: s?.type, topicId: getTopicId() }; };
    const schedule = () => {
        if (disposed || timer || !pending.size) return;
        timer = setTimeout(() => { timer = null; void drain(); }, retryMs);
    };
    async function drain() {
        if (disposed || running) return;
        running = true;
        try {
            for (const [key, change] of pending) {
                if (key !== identity(current())) { pending.delete(key); continue; }
                if (saving.get(key) || unsaved.has(key) || hasActiveStream(change) || isEditing() || isLoadingHistory()) continue;
                pending.delete(key);
                const generation = persistenceGenerations.get(key) || 0;
                const allowed = () => !disposed && generation === (persistenceGenerations.get(key) || 0) && key === identity(current()) && !saving.get(key) && !unsaved.has(key) && !hasActiveStream(change) && !isEditing() && !isLoadingHistory();
                try {
                    await syncHistory(change.itemId, change.itemType, change.topicId, allowed);
                    if (!allowed() && !disposed && key === identity(current())) pending.set(key, change);
                }
                catch (error) { pending.set(key, change); reportError('[NativeSync] history refresh failed', error); }
            }
        } finally { running = false; schedule(); }
    }
    // Startup can finish reading before this listener exists. Re-read the
    // selected conversation once, and again after a native selection settles.
    // No history is written and no new polling loop is introduced.
    function queueSelected() {
        const change = current();
        if (!change.itemId || !change.topicId || !['agent', 'group'].includes(change.itemType)) return;
        pending.set(identity(change), change);
        queueMicrotask(() => { void drain(); });
    }
    const offSelection = subscribeSelection?.(event => {
        if (event?.settled !== false) queueSelected();
    });
    queueSelected();
    return Object.freeze({
        queueSelected,
        consume(event) {
            if (disposed) return;
            const selected = current();
            const change = { itemId: event.ownerId || event.agentId, itemType: event.ownerType || selected.itemType, topicId: event.topicId };
            if (identity(change) !== identity(selected)) return;
            pending.set(identity(change), change);
            void drain();
        },
        beginPersistence(context) {
            if (disposed) return () => {};
            const d = { itemId: context.groupId || context.agentId, itemType: context.isGroupMessage ? 'group' : 'agent', topicId: context.topicId };
            if (!d.itemId || !d.topicId) return () => {};
            const key = identity(d);
            const owner = context.streamOperationId || context.messageId || Symbol('persistence');
            // A read that began before this terminal cannot become current again
            // merely because its saving lease has already been released.
            persistenceGenerations.set(key, (persistenceGenerations.get(key) || 0) + 1);
            saving.set(key, (saving.get(key) || 0) + 1);
            let released = false;
            return success => {
                if (released) return; released = true;
                const count = (saving.get(key) || 1) - 1;
                if (count) saving.set(key, count); else saving.delete(key);
                if (disposed) return;
                const failed = unsaved.get(key) || new Set();
                if (success) failed.delete(owner); else failed.add(owner);
                if (failed.size) unsaved.set(key, failed); else unsaved.delete(key);
                void drain();
            };
        },
        drain,
        diagnostics: () => ({ pending: pending.size, saving: saving.size, unsaved: unsaved.size }),
        dispose() { disposed = true; offSelection?.(); clearTimeout(timer); timer = null; pending.clear(); saving.clear(); unsaved.clear(); persistenceGenerations.clear(); },
    });
}

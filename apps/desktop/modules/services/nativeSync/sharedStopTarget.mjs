// stop is offered only by the device that owns this server session. Native
// rendering and native stream interruption stay with the composer.
const terminal = new Set(['completed', 'abandoned', 'failed', 'cancelled', 'review_required']);

export function createSharedStopTarget(api, setTarget) {
    let topic = null, active = null;
    const retired = new Set(), inFlight = new Set();

    function replace(target) {
        if (active === target) return;
        active = target;
        setTarget?.(target);
    }

    function select(next) {
        topic = next;
        retired.clear();
        replace(null);
    }

    function update(change) {
        if (!topic || !setTarget || typeof api?.cancelSharedSession !== 'function') return;
        if (!change || (change.enabled === false && !change.topic)) { replace(null); return; }
        const selectedTopic = topic;
        const { ownerId, ownerType, topicId } = selectedTopic;
        if (change.topic?.ownerId !== ownerId || change.topic.ownerType !== ownerType ||
            change.topic.topicId !== topicId) return;
        if (change.enabled === false || change.readOnly) { replace(null); return; }

        for (const row of change.executions || []) {
            if (terminal.has(row.state) || terminal.has(row.phase)) retired.add(row.id);
        }
        const delta = change.serverSession;
        const sessions = delta ? [delta] : change.serverSessions;
        for (const row of sessions || []) {
            if (row.projectionSynced || terminal.has(row.native?.state) || terminal.has(row.request?.state)) {
                retired.add(row.executionId);
            }
        }
        if (active && retired.has(active.sharedExecution.executionId)) replace(null);
        if (!Array.isArray(sessions)) return;
        const work = sessions.find(row => row.executionId && row.canCancel === true && !retired.has(row.executionId));
        if (!work) {
            // A single update for an unrelated Work does not revoke our target.
            if (!delta || delta.executionId === active?.sharedExecution.executionId) replace(null);
            return;
        }
        const { executionId } = work;
        if (active?.sharedExecution.executionId === executionId) return;
        const descriptor = { itemId: ownerId, itemType: ownerType, topicId };
        const target = {
            ...descriptor, id: 'reply_' + executionId, role: 'assistant',
            isSharedSession: true, sharedExecution: { ...descriptor, executionId },
            async interrupt(notify) {
                if (active !== target) return false;
                if (target.submitted || inFlight.has(executionId)) return true;
                inFlight.add(executionId);
                try {
                    const result = await api.cancelSharedSession({ descriptor, executionId });
                    if (result?.success !== true) throw Error(result?.error || 'SHARED_CANCEL_UNCONFIRMED');
                    target.submitted = true;
                    if (active?.sharedExecution.executionId === executionId) active.submitted = true;
                    if (topic === selectedTopic) notify?.(result.submitted
                        ? '停止请求已提交，正在等待执行宿主确认。' : '原执行已进入终态，正在核对结果。', 'info');
                } catch (error) {
                    if (topic === selectedTopic) notify?.('停止尚未确认：' + error.message + '；后台任务状态保留。', 'warning');
                } finally {
                    inFlight.delete(executionId);
                }
                return true;
            },
        };
        replace(target);
    }
    return { select, update };
}

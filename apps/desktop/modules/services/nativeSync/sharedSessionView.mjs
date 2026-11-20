import { createSharedStopTarget } from './sharedStopTarget.mjs';
const scopeKey = value => JSON.stringify([value?.ownerType, value?.ownerId, value?.topicId]);
const labels = {accepted:'已受理，等待执行',queued:'已受理，等待执行',preparing:'正在准备原生请求',dispatched:'原生执行中',running:'原生执行中',waiting_approval:'等待原生审批',publishing:'结果提交中',completed:'已完成',review_required:'结果需要核对',failed:'执行失败',cancelled:'已取消',abandoned:'已结清'};
const activityLabels = {tool:{started:'原生工具执行中',accepted:'原生任务已接收',settled:'原生工具已返回',observed:'原生任务状态已更新'},approval:{waiting_approval:'等待原生审批',running:'原生审批等待已结束'}};

// Text-only observation, including verified previews retained by the existing
// session record. The normal History renderer alone owns committed messages.
export function createSharedSessionView(container, createObservedFrame, { api, setInterruptTarget } = {}) {
    const stopTarget = createSharedStopTarget(api, setInterruptTarget);
    const document = container.ownerDocument, views = new Map(), retiredScopes = new Map(); let scope = null, retired = new Set();
    const remove = id => {
        for (const [key, view] of views) {
            if (key !== id && view.executionId !== id) continue;
            view.release?.();
            view.stopObserving?.();
            view.element.remove();
            views.delete(key);
        }
    };
    const historyMessages = container.querySelector('#chatMessages');
    const messages = createObservedFrame && historyMessages;
    function showOrdinaryBody(session) {
        const id = session.executionId;
        const previous = views.get(id);
        if (!messages || scope.ownerType !== 'agent' || session.native?.kind !== 'shared_session'
            || session.nativeRequestId || session.partialResult || session.gap || !session.text) return false;
        if (previous?.setText) {
            previous.setText(session.text);
            return true;
        }
        const messageId = 'reply_' + id;
        const committed = () => [...messages.querySelectorAll('.message-item[data-message-id]')]
            .some(node => node.dataset.messageId === messageId);
        remove(id);
        if (committed()) { retired.add(id); return true; }
        const element = document.createElement('article'), content = document.createElement('div');
        element.className = 'message-item assistant native-sync-live-message';
        element.dataset.nativeSyncExecution = id;
        content.className = 'md-content';
        element.append(content);
        let paint = createObservedFrame(messageId, element, content);
        let latest = '', painted = '', frame = 0;
        const win = document.defaultView;
        const setText = text => {
            latest = text;
            if (frame || text === painted) return;
            frame = win.requestAnimationFrame(() => {
                frame = 0;
                if (committed()) { retired.add(id); remove(id); return; }
                if (!element.isConnected) messages.append(element);
                if (!latest.startsWith(painted)) {
                    content.replaceChildren();
                    paint = createObservedFrame(messageId, element, content);
                }
                paint(latest);
                painted = latest;
                win.uiHelperFunctions?.scrollToBottom?.();
            });
        };
        const observer = new win.MutationObserver(() => {
            if (committed()) { retired.add(id); remove(id); }
            else if (!element.isConnected && views.has(id)) messages.append(element);
        });
        messages.append(element);
        observer.observe(messages, {childList:true});
        views.set(id, {element, executionId:id, setText, release() {
            observer.disconnect();
            if (frame) win.cancelAnimationFrame(frame);
        }});
        setText(session.text);
        return true;
    }
    return {
        select(next) {
            if (scopeKey(next) === scopeKey(scope)) return;
            stopTarget.select(next);
            scope = next;const key=scopeKey(scope);retired=retiredScopes.get(key)||new Set();retiredScopes.set(key,retired);for (const id of views.keys()) remove(id);
        },
        update(change) {
            stopTarget.update(change);
            if (!scope || scopeKey(change?.topic) !== scopeKey(scope)) return;
            const win = document.defaultView;
            // serverSessions is an observation subset, so an absent remote
            // Work is not proof of deletion. Existing execution status does
            // explicitly identify closed local Works and can retire their UI.
            for (const execution of change.executions || []) {
                if (views.get(execution.id)?.setText && [execution.phase, execution.state].includes('completed')) continue;
                if (['completed','abandoned','failed','cancelled'].some(state=>execution.phase===state||execution.state===state)){retired.add(execution.id);remove(execution.id);}
            }
            const sessions = change.serverSession ? [change.serverSession] : change.serverSessions || [];
            const reviewed = new Map();
            if (scope.ownerType === 'group' && change.executions) {
                for (const execution of change.executions) for (const part of execution.interruptedGroupReplies || []) {
                    const viewId = execution.id+'/'+part.nativeRequestId;
                    const prior = [...(historyMessages?.querySelectorAll('.message-item[data-message-id]') || [])]
                        .find(node => node.dataset.messageId === part.messageId);
                    if (prior && !prior.classList.contains('streaming') && !prior.classList.contains('thinking')) continue;
                    prior?.remove();
                    reviewed.set(viewId, { ...part, viewId, executionId:execution.id, request:{state:'review_required'}, localGroupReview:true });
                }
                for (const [id, view] of views) if (view.localGroupReview && !reviewed.has(id)) remove(id);
            }
            for (const work of [...sessions, ...reviewed.values()]) {
                if(retired.has(work.executionId))continue;
                const parts=work.nativeBodies?.length?work.nativeBodies.map(body=>({...work,...body,text:body.text,gap:body.gap,viewId:work.executionId+'/'+body.nativeRequestId})): [work];
                if(parts.length>1||parts[0]?.nativeRequestId){const base=views.get(work.executionId);if(base){base.stopObserving?.();base.element.remove();views.delete(work.executionId);}}
                for (const session of parts) {
                if (!session.executionId) continue;
                if (session.projectionSynced && views.get(session.executionId)?.setText && session.request?.state !== 'abandoned') continue;
                if (session.projectionSynced || session.request?.state === 'abandoned') { retired.add(session.executionId);remove(session.executionId); continue; }
                if (showOrdinaryBody(session)) continue;
                if (views.get(session.executionId)?.setText) {
                    if (!session.partialResult && !session.gap && !['failed','cancelled','review_required'].includes(session.native?.state)) continue;
                    remove(session.executionId);
                }
                const viewId=session.viewId||session.executionId;
                if (!session.localGroupReview && (reviewed.has(viewId) || views.get(viewId)?.localGroupReview)) continue;
                let view = views.get(viewId);
                if (!view) {
                    const element = document.createElement('article'), status = document.createElement('p'), gap = document.createElement('p'), text = document.createElement('pre');
                    element.className = 'message-item assistant native-sync-live-message'; element.dataset.nativeSyncExecution = session.executionId;
                    status.setAttribute('role','status'); gap.setAttribute('role','status'); text.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;';
                    element.append(status,gap,text); if(session.nativeRequestId)element.dataset.nativeSyncRequest=session.nativeRequestId;
                    view={element,status,gap,text,executionId:session.executionId}; views.set(viewId,view);
                }
                if (!view.element.isConnected) {
                    container.append(view.element);
                    // Live previews are siblings of #chatMessages. Let the host's
                    // existing follow controller observe their layout as well.
                    view.stopObserving ??= win?.uiHelperFunctions?.observeChatScrollContent?.(view.element);
                }
                const state = session.native?.state || session.request?.state || 'accepted';
                const backend=['shared_session','group_message','group_invitation'].includes(session.native?.kind);
                const activity=activityLabels[session.activity?.type]?.[session.activity?.state];
                const partial=session.partialResult?.kind==='length'&&session.partialResult?.committed===false;
                view.localGroupReview = session.localGroupReview === true;
                view.element.dataset.nativeSyncPreview=partial||view.localGroupReview?'pending-review':'live';
                view.status.textContent = view.localGroupReview ? (session.memberName ? session.memberName+' · ' : '')+'待核对 · 部分结果未提交' : partial ? '待审部分结果：内容已截断，本次任务未完成' : `${backend?'共享后端 · ':''}${session.nativeRequestId?(session.memberName||'Agent')+(session.kind==='controlled-text'?' · 第 '+(session.nativeGeneration+1)+' 代':'')+' · ':''}${activity || labels[state] || '正在核对原任务'}${session.connection === 'offline' ? ' · 连接中断，保留最近输出' : ''}`;
                view.gap.textContent = session.gap ? '部分实时输出暂不可恢复，完整结果以最终历史为准。' : '';
                view.gap.hidden = !session.gap; view.text.textContent = session.text || '';
                }
            }
        },
        dispose() { stopTarget.select(null); for (const id of views.keys()) remove(id); retiredScopes.clear();retired.clear(); scope=null; },
    };
}

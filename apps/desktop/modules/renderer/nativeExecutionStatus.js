import {createSharedSessionView} from '../services/nativeSync/sharedSessionView.mjs';
const key = topic => JSON.stringify([topic?.ownerType, topic?.ownerId, topic?.topicId]);
const labels = {
    preparing: '正在提交，尚未确认接收', queued: '云端已受理，等待执行',
    running: '云端执行中', waiting_approval: '等待原生审批', publishing: '回复保存中',
    recovering: '结果恢复中', failed: '执行失败', cancelled: '已取消', cancelling: '正在取消',
    review_required: '需要核对', blocked_config: '等待配置确认',
};
const taskLabels = { accepted: 'AA 已登记，启动待核对', running: 'AA 运行中', waiting: 'AA 等待下一步', cancelling: 'AA 正在取消', completed: 'AA 已完成', failed: 'AA 失败', cancelled: 'AA 已取消', stopped: 'AA 已停止（未成功完成）', unknown: 'AA 状态未知，待核对' };
const toolLabels = { started: '工具已开始，结果待核对', returned: '工具调用已返回', error: '工具调用返回错误' };

function localDeliveryText(delivery) {
    const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
    const pending = count(delivery?.pendingOperations), blocked = count(delivery?.blockedOperations);
    const summary = [], detail = [];
    if (delivery?.pendingLocalCommit === true) {
        summary.push('本地提交待核对'); detail.push('本地提交待核对，云端尚未确认。');
    }
    if (pending > 0) {
        summary.push(`本地待同步操作 ${pending} 项`); detail.push(`本地待同步操作 ${pending} 项，云端尚未确认。`);
    }
    if (blocked > 0) {
        summary.push(`冲突待处理 ${blocked} 项`); detail.push(`${blocked} 项本地操作需要处理冲突。`);
    }
    if (!summary.length) {
        const known = pending !== null && blocked !== null && delivery?.pendingLocalCommit === false;
        const text = known ? '本地暂无待确认同步操作' : '本地同步状态待核对';
        summary.push(text); detail.push(`${text}。`);
    }
    return { summary: summary.join(' · '), detail: detail.join(' ') };
}

// Status stays outside the message list. Explicit local recovery retries only
// an already accepted projection through the existing snapshot capability.
export function createNativeExecutionStatus({ container, api, getSelection, getTopicId, subscribeSelection, subscribeHistory, ownerWindow, createObservedFrame, setInterruptTarget, onSharedProjectionSettled, onRetryInput }) {
    if (!container || typeof api?.getNativeExecutionStatus !== 'function') return { dispose() {} };
    const document = container.ownerDocument;
    const sharedSessionView = createSharedSessionView(container, createObservedFrame, { api, setInterruptTarget });
    const panel = document.createElement('details'); panel.className = 'native-sync-execution-status'; panel.hidden = true;
    const summary = document.createElement('summary'); summary.setAttribute('aria-live', 'polite');
    const local = document.createElement('p'), observed = document.createElement('p'), jobs = document.createElement('ul');
    const resultPanel = document.createElement('section'); resultPanel.hidden = true; resultPanel.className = 'native-sync-task-result';
    const resultStatus = document.createElement('p'), resultText = document.createElement('pre'), closeResult = document.createElement('button');
    resultStatus.setAttribute('role', 'status'); resultText.style.whiteSpace = 'pre-wrap'; resultText.style.overflowWrap = 'anywhere'; resultText.style.maxHeight = '40vh'; resultText.style.overflow = 'auto';
    closeResult.type = 'button'; closeResult.textContent = '关闭报告'; resultPanel.append(resultStatus, resultText, closeResult);
    const button = document.createElement('button'); button.type = 'button'; button.textContent = '核对云端状态';
    panel.append(summary, local, observed, jobs, resultPanel, button); container.before(panel);
    const recovery = document.createElement('section'); recovery.hidden = true;
    recovery.className = 'native-sync-local-recovery'; recovery.setAttribute('aria-live', 'polite');
    recovery.style.cssText='max-height:110px;overflow:auto;font-size:13px;padding:4px 12px;';
    const composer=container.parentElement?.querySelector('.chat-input-area');
    if(composer)composer.prepend(recovery);else container.after(recovery);
    let disposed = false, selection = null, generation = 0, resultGeneration = 0, view = null, historyTimer = null;
    const currentTopic = () => {
        const item = getSelection();
        return item?.id && getTopicId() && ['agent', 'group'].includes(item.type) ? { ownerType: item.type, ownerId: item.id, topicId: getTopicId() } : null;
    };
    function settleSharedFlowlock(value) {
        Promise.resolve(ownerWindow?.flowlockManager?.handleSharedSessionStatus?.(value)).catch(error=>console.error('[NativeExecutionStatus] shared Flowlock status failed',error?.code||error?.message));
    }
    function render(value) {
        settleSharedFlowlock(value);
        sharedSessionView.update(value);
        view = value;
        recovery.replaceChildren(); recovery.hidden = true;
        for (const saved of value?.localInputs || []) {
            const inputId=saved.inputId||saved.message?.id,content=saved.content??saved.message?.content??'';
            recovery.hidden = false;
            const row = document.createElement('p'), text = document.createElement('span');
            text.textContent = `${saved.projectionPending ? '消息已接收，正在恢复本机记录。' : saved.accepted ? '消息已接收，等待原请求恢复。' : saved.submissionUnconfirmed ? '消息已保存，提交结果尚未确认。' : '待发消息已保存在本机。'} ${content.slice(0,80)}${content.length>80?'…':''} `;
            row.append(text);
            if (saved.projectionPending && typeof api.getNativeHistorySnapshot === 'function') {
                const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = '重试恢复本机记录';
                retry.addEventListener('click', async () => {
                    const scope = value.topic;
                    if (disposed || key(scope) !== key(selection)) return;
                    retry.disabled = true;
                    let snapshot;
                    try { snapshot = await api.getNativeHistorySnapshot(scope.ownerId, scope.ownerType, scope.topicId); }
                    catch { snapshot = {success:false}; }
                    if (disposed) return;
                    const success = snapshot?.success !== false && Array.isArray(snapshot?.history)
                        && snapshot.history.some(message => message.id === inputId);
                    onSharedProjectionSettled?.({source:'native-sync-projection', requestId:inputId,
                        projectionState:success?'saved':'failed', ownerId:scope.ownerId, ownerType:scope.ownerType, topicId:scope.topicId});
                    if (key(scope) === key(selection)) await query(false, scope);
                    retry.disabled = false;
                });
                row.append(retry);
            } else if (!saved.accepted && inputId && typeof onRetryInput === 'function') {
                const retry=document.createElement('button');retry.type='button';retry.textContent='按原编号重试提交';
                retry.addEventListener('click',async()=>{if(disposed||key(value.topic)!==key(selection))return;retry.disabled=true;try{await onRetryInput({descriptor:{itemType:value.topic.ownerType,itemId:value.topic.ownerId,topicId:value.topic.topicId},inputId,modelSaveRef:saved.modelSaveRef});await query(true,value.topic);}catch(error){text.textContent='原消息仍保留：'+(error.code||error.message);retry.disabled=false;}});row.append(retry);
            } else if (!saved.accepted && saved.message) {
                const restore = document.createElement('button'); restore.type = 'button'; restore.textContent = '恢复到输入框';
                restore.addEventListener('click', () => { if (key(value.topic)!==key(selection)) return; ownerWindow?.dispatchEvent(new ownerWindow.CustomEvent('native-sync:restore-local-input',{detail:saved})); });
                row.append(restore);
            }
            recovery.append(row);
        }
        const reviewJob = value?.executions?.find(job => job.state === 'review_required');
        if (reviewJob) {
            recovery.hidden = false;
            const text=document.createElement('p'),open=document.createElement('button');
            text.textContent='连接中断，原请求的结果需要核对；消息和已有回复会保留。';
            open.type='button';open.textContent='查看并核对原请求';
            open.addEventListener('click',()=>{panel.open=true;panel.scrollIntoView?.({block:'nearest'});});
            recovery.append(text,open);
        }
        if (!value?.enabled) {
            jobs.replaceChildren(); clearResult();
            panel.hidden = !value?.degraded;
            if (value?.degraded) {
                summary.textContent = 'NativeSync 接入未完成';
                local.textContent = '同步尚未启动，请核对本机接入配置；此处不会重试提交消息。';
                observed.textContent = `原因：${value.degraded}`;
            }
            return;
        }
        const displayed = value.displayJobs ?? (value.executions || []).slice(0, 5);
        const hasReports = displayed.some(job => job.nativeTasks?.some(task => task.resultRef));
        panel.hidden = !hasReports && !(value.executions || []).some(job => !['completed','cancelled'].includes(job.state)) && !value.local?.pendingOperations && !value.local?.blockedOperations && !value.local?.pendingLocalCommit;
        const freshness = value.freshness === 'current' ? '本次已核对' : value.freshness === 'last-known' ? '最近已知' : '尚未取得状态';
        const delivery = localDeliveryText(value.local);
        summary.textContent = `任务状态${value.connection === 'offline' ? ' · 离线' : value.connection === 'error' ? ' · 暂未更新' : ''}`;
        local.textContent = delivery.detail;
        const last = value.observedAt === null ? '' : `上次云端记录时间：${new Date(value.observedAt).toLocaleString()}。`;
        observed.textContent = `${last}${value.freshness === 'current' ? '以下为这次查询到的云端执行状态。' : '以下为最近已知记录，需要联网核对最新状态。'}${value.error?.code ? `（${value.error.code}）` : ''}`;
        // Preserve only the currently rendered view; disappearing items and Topic
        // changes naturally discard this temporary UI state.
        const detailStates = new Map([...jobs.querySelectorAll('details[data-native-sync-key]')].map(item => [item.dataset.nativeSyncKey, item.open]));
        const focused = jobs.contains(document.activeElement) ? document.activeElement.dataset.nativeSyncFocusKey : null;
        function retainDetail(item, heading, identity) {
            const identityKey = JSON.stringify([key(value.topic), ...identity]);
            item.dataset.nativeSyncKey = identityKey; item.open = detailStates.get(identityKey) === true;
            heading.dataset.nativeSyncFocusKey = `${identityKey}:summary`;
        }
        jobs.replaceChildren();
        for (const job of displayed) {
            const row = document.createElement('li');
            const completed = job.replyMessageId ? '回复已保存' : '主请求已结束';
            const state = job.state === 'completed' ? completed : labels[job.state] || `状态：${job.state}`;
            row.textContent = `${state} · 请求 ${job.requestId}${job.errorCode ? `（${job.errorCode}）` : ''}`;
            row.title = `执行 ${job.id}；执行尝试 ${job.attempts} 次`;
            if (job.errorCode?.endsWith('REVIEW_REQUIRED')) {
                const review = document.createElement('p');
                review.textContent = job.reviewResolved ? '已记录人工核对；这不表示已撤回工具副作用或取消 AA。' : '工具是否已经生效仍需核对；取消请求不表示已撤回副作用。';
                row.append(review);
            }
            if (job.toolInvocations?.length) {
                const calls = document.createElement('details'), heading = document.createElement('summary');
                retainDetail(calls, heading, [job.id, 'tools']);
                heading.textContent = `原生工具调用 ${job.toolInvocations.length} 项（返回不等于 AA 完成）`; calls.append(heading);
                const list = document.createElement('ul');
                for (const call of job.toolInvocations) { const item = document.createElement('li'); item.textContent = `${call.pluginName} · ${toolLabels[call.state] || call.state} · 调用 ${call.invocationId}`; list.append(item); }
                calls.append(list); row.append(calls);
            }
            for (const task of job.nativeTasks || []) {
                const item = document.createElement('details'), heading = document.createElement('summary');
                retainDetail(item, heading, [job.id, 'task', task.nativeTaskId, task.invocationId, task.stepId || null]);
                item.className = 'native-sync-aa-task'; item.dataset.taskId = task.nativeTaskId; item.dataset.state = task.state;
                heading.textContent = `${taskLabels[task.state] || 'AA 状态待核对'} · ${task.agentBaseName}`; item.append(heading);
                const identity = document.createElement('p'); identity.textContent = `任务 ${task.nativeTaskId} · 调用 ${task.invocationId}${task.stepId ? ` · 群聊步骤 ${task.stepId}` : ''}`; item.append(identity);
                if (task.summary) { const preview = document.createElement('p'); preview.textContent = task.summary; item.append(preview); }
                if (task.reviewRequired) { const review = document.createElement('p'); review.textContent = task.reviewResolved ? '已人工核对；原生任务状态仍按上方记录显示。' : '需要在原生宿主核对任务与可能的工具副作用。'; item.append(review); }
                if (task.resultRef && typeof api.getNativeTaskResult === 'function') {
                    const read = document.createElement('button'); read.type = 'button'; read.textContent = '查看已核对报告';
                    read.dataset.nativeSyncFocusKey = `${item.dataset.nativeSyncKey}:report`;
                    read.addEventListener('click', () => { void showResult(job, task); }); item.append(read);
                }
                row.append(item);
            }
            if(job.shared&&job.canAbandon&&typeof api.abandonSharedSend==='function'){
                const confirm=document.createElement('label'),check=document.createElement('input'),abandon=document.createElement('button');check.type='checkbox';confirm.append(check,document.createTextNode('我已核对可能的工具副作用，放弃此请求剩余工作'));abandon.type='button';abandon.textContent='确认放弃并解除暂停';abandon.disabled=true;
                check.addEventListener('change',()=>{abandon.disabled=!check.checked;});
                abandon.addEventListener('click',async()=>{if(!check.checked||!selection)return;abandon.disabled=true;const scope={...selection};const result=await api.abandonSharedSend({descriptor:{itemType:scope.ownerType,itemId:scope.ownerId,topicId:scope.topicId},requestId:job.requestId,confirmed:true});if(result?.success===false)observed.textContent='放弃尚未确认：'+result.error;else await query(true,scope);});
                row.append(confirm,abandon);
            }
            jobs.append(row);
        }
        if (!displayed.length) {
            const row = document.createElement('li'); row.textContent = value.freshness === 'unavailable' ? '尚无可核对的云端执行记录。' : '这次记录中没有云端执行任务。'; jobs.append(row);
        } else if (value.total > 5) {
            const row = document.createElement('li'); row.textContent = `显示最近 5 项执行${displayed.length > 5 ? '及近期报告' : ''}；执行记录共 ${value.total} 项${value.truncated ? '，本地仅保留最近 128 项状态' : ''}。`; jobs.append(row);
        }
        if (focused && panel.open) [...jobs.querySelectorAll('[data-native-sync-focus-key]')].find(item => item.dataset.nativeSyncFocusKey === focused)?.focus({ preventScroll: true });
    }
    function clearResult() { resultGeneration += 1; resultPanel.hidden = true; resultStatus.textContent = ''; resultText.textContent = ''; }
    async function showResult(job, task) {
        const scope = selection, turn = ++resultGeneration;
        if (!scope) return;
        resultPanel.hidden = false; resultText.textContent = ''; resultStatus.textContent = '正在只读核对原生报告…';
        try {
            const result = await api.getNativeTaskResult(scope.ownerId, scope.ownerType, scope.topicId, job.id, task.nativeTaskId);
            if (disposed || turn !== resultGeneration || key(scope) !== key(selection)) return;
            if (result?.success === false) throw Error(result.error || 'NATIVE_TASK_RESULT_UNAVAILABLE');
            if (key(result?.topic) !== key(scope) || result.executionId !== job.id || result.task?.nativeTaskId !== task.nativeTaskId || typeof result.content !== 'string') throw Error('NATIVE_TASK_RESULT_MISMATCH');
            resultStatus.textContent = `原生报告已核对 · ${task.nativeTaskId} · 仅本次查看，不作为聊天消息。`;
            resultText.textContent = result.content;
        } catch (error) {
            if (!disposed && turn === resultGeneration && key(scope) === key(selection)) resultStatus.textContent = `报告暂不可核对，任务记录保留。（${error.message}）`;
        }
    }
    closeResult.addEventListener('click', clearResult);
    async function query(refresh, scope = selection) {
        if (disposed || !scope) return;
        const turn = ++generation;
        let result;
        try { result = await api.getNativeExecutionStatus(scope.ownerId, scope.ownerType, scope.topicId, refresh); }
        catch { result = { success: false, error: 'EXECUTION_STATUS_UNAVAILABLE' }; }
        if (disposed || turn !== generation || key(scope) !== key(selection)) return;
        if (result?.success === false) {
            if (result.error === 'TOPIC_NOT_ALLOWED' || result.error === 'INVALID_EXECUTION_TOPIC') render(null);
            else if (view) render({ ...view, freshness: view.observedAt === null ? 'unavailable' : 'last-known', connection: 'error', error: { code: result.error } });
        } else if (!result?.enabled || key(result.topic) === key(scope)) render(result);
    }
    async function refresh() {
        const scope = selection;
        await query(false, scope);
        if (!disposed && key(scope) === key(selection)) await query(true, scope);
    }
    function select() {
        const topic = currentTopic();
        if (key(topic) === key(selection)) return;
        sharedSessionView.select(topic);
        selection = topic; generation += 1; render(null);
        if (topic) void refresh();
    }
    const offSelection = subscribeSelection?.(select);
    const offHistory = subscribeHistory?.(() => {
        if (historyTimer || disposed) return;
        historyTimer = setTimeout(() => { historyTimer = null; void query(false); }, 100);
    });
    const offChange = api.onNativeExecutionStatusChanged?.(result => {
        if(result?.serverSession){if(!disposed){settleSharedFlowlock(result);sharedSessionView.update(result);}return;}
        if (disposed || !selection || key(result?.topic) !== key(selection)) return;
        // A topic notification without a status snapshot invalidates this view.
        if (result.enabled === undefined) { void query(false, selection); return; }
        generation += 1; render(result);
    });
    const recover = () => { void refresh(); };
    button.addEventListener('click', recover);
    ownerWindow?.addEventListener('focus', recover);
    ownerWindow?.addEventListener('online', recover);
    const localChanged=()=>{void query(false);};
    ownerWindow?.addEventListener('native-sync:local-input-changed',localChanged);
    select();
    return {
        refresh,
        dispose() {
            disposed = true; generation += 1; clearTimeout(historyTimer);
            offSelection?.(); offHistory?.(); offChange?.();
            button.removeEventListener('click', recover);
            ownerWindow?.removeEventListener('focus', recover);
            ownerWindow?.removeEventListener('online', recover);
            ownerWindow?.removeEventListener('native-sync:local-input-changed',localChanged);
            closeResult.removeEventListener('click', clearResult); clearResult();
            sharedSessionView.dispose();
            panel.remove(); recovery.remove();
        },
    };
}

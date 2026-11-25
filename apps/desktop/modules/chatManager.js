import { submitTopicAdmissionWithRecovery } from './chat/recoverTopicAdmission.mjs';
import {prepareNativeDeletion,nativeDeletionOptions} from './chat/nativeDirectoryActions.mjs';
import {orderSharedHistory} from './chat/sharedHistoryOrder.mjs';
import {createComposerDraftController} from './chat/composerDrafts.mjs';
import {messagePreconditionValue} from './chat/historyMessageIntent.mjs';
// modules/chatManager.js
import {
    buildDefaultMessageContent,
    createSingleChatRequestOrchestrator,
    updateFirstTextPart,
} from './chat/singleChatRequestOrchestrator.js';
import { publishConversationSelection } from './ui-system/sources/conversation-current.js';
import { createContextCompactionService, shouldCompactContext, estimateContextTokens } from './chat/contextCompactionService.js';
import { effectiveContextHistory, isContextCheckpoint, summarizeCompactionInput } from './chat/contextCompactionState.js';

// 上游接受中止后等它自己收尾的上限；过了仍没有终态就在本地停止，保留已收到的部分
const INTERRUPT_SETTLE_MS = 3000;
const settlesWithin = (promise, ms) => new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), ms);
    promise.then(() => { clearTimeout(timer); resolve(true); }, () => { clearTimeout(timer); resolve(true); });
});

export const chatManager = (() => {
    // --- Private Variables ---
    let electronAPI;
    let uiHelper;
    let messageRenderer;
    let chatDomRenderer;
    let itemListManager;
    let topicListManager;
    let groupRenderer;
    let streamProjection;
    let interruptCapability;

    // References to state in renderer.js
    let currentSelectedItemRef;
    let currentTopicIdRef;
    let currentChatHistoryRef;
    let attachedFilesRef;
    let globalSettingsRef;
    let chatContext;
    let chatRepository;
    let historyMutationAuthority;
    let streamConsumerRegistry;
    let singleChatRequestOrchestrator;
    let contextCompactionService;
    let compactionFlowlock;
    const streamCompactionRequests = new Map();
    const streamCompactionTerminalSignals = new Map();
    const streamBoundaryChecks = new Map();

    function signalRelayCancellation(intent) {
        if (!intent) return;
        intent.cancelled = true;
        if (!intent.relay || !intent.handoffStarted || intent.cancelSignal) return;
        const scope = { itemType: 'agent', itemId: intent.itemId, topicId: intent.topicId };
        try {
            if (typeof electronAPI.topicAdmissionCancelRelay !== 'function') {
                throw new Error('宿主缺少进行中中继取消能力');
            }
            intent.cancelSignal = Promise.resolve(
                electronAPI.topicAdmissionCancelRelay(scope, intent.admissionToken)
            ).then(receipt => {
                if (!receipt?.success) throw new Error(receipt?.error || receipt?.code || '中继取消未确认');
                // accepted is a signal receipt, not a durable-pause acknowledgement.
                return receipt;
            }).catch(error => {
                console.error('[AdmissionRelay] cancellation signal failed', error);
                uiHelper?.showToastNotification?.(`中继取消未确认：${error.message}，请核对话题状态。`, 'error');
            });
        } catch (error) {
            console.error('[AdmissionRelay] cancellation signal failed', error);
            uiHelper?.showToastNotification?.(`中继取消未确认：${error.message}，请核对话题状态。`, 'error');
        }
    }

    function cancelStreamAdmissionRelay(messageId) {
        const checking = streamBoundaryChecks.get(messageId);
        const intent = streamCompactionRequests.get(messageId);
        if (!messageId) return false;
        if (checking) checking.cancelled = true;
        else streamBoundaryChecks.set(messageId, { cancelled: true });
        signalRelayCancellation(intent);
        return true;
    }

    async function checkStreamContextBudget({ messageId, context, text, cancelStream, onInterruptRequested, isActive = () => true, isStreamActive = isActive }) {
        if (disposed || !isActive() || context?.isGroupMessage || context?.groupId
            || !context?.agentId || !context?.topicId
            || /^sidechat_[0-9]+_[0-9a-f]+$/.test(context.topicId)
            || streamCompactionRequests.has(messageId) || streamBoundaryChecks.has(messageId)) return;
        const boundaryCheck = { cancelled: false };
        streamBoundaryChecks.set(messageId, boundaryCheck);
        try {
            const scope = { itemId: context.agentId, itemType: 'agent', topicId: context.topicId };
            const boundaryAuthority = await executionAuthority(scope);
            const ownsBoundary = () => !disposed && !boundaryCheck.cancelled && isActive() && isStreamActive();
            if (boundaryAuthority.kind !== 'local' || !ownsBoundary()) return;
            const canRelay = Boolean(context.admissionToken
                && typeof electronAPI.topicAdmissionRelay === 'function'
                && typeof electronAPI.topicAdmissionList === 'function');
            const compressionEnabled = globalSettingsRef.get().enableContextCompaction === true;
            if (!canRelay && !compressionEnabled) return;
            let hasPending = false;
            if (canRelay) {
                const receipt = await electronAPI.topicAdmissionList(scope);
                if (!receipt?.success || !Array.isArray(receipt.entries)) {
                    throw new Error(receipt?.error || '无法核对工具返回处暂挂消息');
                }
                const entries = receipt.entries.filter(entry => entry.scope?.itemType === 'agent'
                    && entry.scope.itemId === scope.itemId && entry.scope.topicId === scope.topicId);
                hasPending = !entries.some(entry => ['recovered', 'failed', 'uncertain'].includes(entry.state))
                    && entries.some(entry => entry.state === 'queued' && !entry.kind && !entry.committed);
            }
            let needsCompression = false;
            if (compressionEnabled) {
                const selected = currentSelectedItemRef.get();
                const visible = selected?.id === scope.itemId && selected.type === 'agent'
                    && currentTopicIdRef.get() === scope.topicId;
                const config = visible ? (selected.config || selected) : await electronAPI.getAgentConfig(scope.itemId);
                const history = visible ? currentChatHistoryRef.get() : await getHistory(scope.itemId, 'agent', scope.topicId);
                if (Array.isArray(history)) {
                    const effective = effectiveContextHistory(history.filter(message => message.id !== messageId));
                    const limit = Number(config?.contextTokenLimit);
                    needsCompression = Number.isFinite(limit) && limit > 0
                        && estimateContextTokens([...effective, { role: 'assistant', content: text }], config.systemPrompt || '') >= limit;
                }
            }
            if (!ownsBoundary() || streamCompactionRequests.has(messageId)
                || (!hasPending && !needsCompression)) return;
            // The adapter installs the durable handover before exposing this capability.
            const relay = canRelay && typeof finishStreamAdmissionRelay === 'function';
            streamCompactionRequests.set(messageId, {
                ...scope, admissionToken: context.admissionToken,
                relay, needsCompression, hasPending,
            });
            const flowlockLease = compactionFlowlock?.suspendForContextCompaction?.(scope.itemId, scope.topicId);
            streamCompactionRequests.get(messageId).flowlockLease = flowlockLease || null;
            if (relay && flowlockLease) {
                compactionFlowlock?.markRelaySuspension?.(flowlockLease, context.admissionToken);
            }
            notifySendStateChanged();
            let stopTimer;
            const intent = streamCompactionRequests.get(messageId);
            // The stream can settle while Stop is pending or after its ACK.
            // A single deadline bounds both waits; only persistence releases the intent.
            let settled = false;
            const terminal = new Promise(resolve => {
                streamCompactionTerminalSignals.set(messageId, () => { settled = true; resolve(); });
            });
            const deadline = new Promise(resolve => {
                stopTimer = setTimeout(resolve, INTERRUPT_SETTLE_MS);
            });
            try {
                onInterruptRequested?.();
                let ack;
                try {
                    ack = await Promise.race([interruptCapability?.interrupt?.(messageId), terminal, deadline]);
                } catch {
                    // The active stream still owns local cancellation when Stop fails.
                }
                if (ack?.success && !settled) await Promise.race([terminal, deadline]);
                if (!settled && ownsBoundary() && streamCompactionRequests.get(messageId) === intent) {
                    await cancelStream?.(messageId, ack?.success ? 'tool-return-relay-settle-timeout' : 'tool-return-relay');
                }
            } finally {
                clearTimeout(stopTimer);
                streamCompactionTerminalSignals.delete(messageId);
            }
        } finally {
            if (!boundaryCheck.cancelled && streamBoundaryChecks.get(messageId) === boundaryCheck) {
                streamBoundaryChecks.delete(messageId);
            }
        }
    }

    function abandonStreamContextCompaction({ messageId, event }) {
        const checking = streamBoundaryChecks.get(messageId);
        if (checking) checking.cancelled = true;
        streamBoundaryChecks.delete(messageId);
        if (!event?.outcome?.persistence?.error || !streamCompactionRequests.has(messageId)) return;
        streamCompactionTerminalSignals.get(messageId)?.();
        streamCompactionRequests.delete(messageId);
        notifySendStateChanged();
        uiHelper?.showToastNotification?.('中止内容尚未保存，已取消自动压缩；心流保持挂起，请先处理保存失败。', 'error');
    }

    async function finishStreamAdmissionRelay({ messageId, context }) {
        const intent = streamCompactionRequests.get(messageId);
        if (!intent?.relay) return false;
        if (intent.admissionToken !== context?.admissionToken
            || intent.itemId !== context?.agentId || intent.topicId !== context?.topicId) {
            throw new Error('中继归属与已保存终稿不匹配');
        }
        streamCompactionTerminalSignals.get(messageId)?.();
        const scope = { itemType: 'agent', itemId: intent.itemId, topicId: intent.topicId };
        try {
            if (disposed || intent.cancelled) {
                // Do not regenerate after an explicit user cancellation.
                const receipt = await electronAPI.topicAdmissionRelay(scope, intent.admissionToken, { saved: true, cancelled: true });
                if (!receipt?.success) throw new Error(receipt?.error || receipt?.code || '取消中继失败');
                return true;
            }
            if (intent.needsCompression) {
                const history = await getHistory(scope.itemId, 'agent', scope.topicId);
                await contextCompactionService.compact({
                    scope, history, settings: globalSettingsRef.get(),
                    onCommitted: () => syncHistoryFromFile(scope.itemId, 'agent', scope.topicId),
                });
            }
            if (disposed || intent.cancelled) {
                const receipt = await electronAPI.topicAdmissionRelay(scope, intent.admissionToken, { saved: true, cancelled: true });
                if (!receipt?.success) throw new Error(receipt?.error || receipt?.code || '取消中继失败');
                return true;
            }
            intent.handoffStarted = true;
            const receipt = await electronAPI.topicAdmissionRelay(scope, intent.admissionToken, { saved: true });
            if (!receipt?.success) throw new Error(receipt?.error || receipt?.code || '工具返回中继交接失败');
            return true;
        } catch (error) {
            try {
                await electronAPI.topicAdmissionUncertain(scope, intent.admissionToken, error.message || String(error));
            } catch (diagnosticError) {
                console.error('[AdmissionRelay] diagnostic failed', diagnosticError);
            }
            throw error;
        } finally {
            streamCompactionRequests.delete(messageId);
            notifySendStateChanged();
        }
    }

    function hasStreamAdmissionRelay(messageId) {
        return streamCompactionRequests.get(messageId)?.relay === true;
    }

    async function finishStreamContextCompaction({ messageId }) {
        streamCompactionTerminalSignals.get(messageId)?.();
        const scope = streamCompactionRequests.get(messageId);
        if (!scope) return;
        if (scope.cancelled) {
            streamCompactionRequests.delete(messageId);
            notifySendStateChanged();
            return;
        }
        let result;
        try {
            const history = await getHistory(scope.itemId, 'agent', scope.topicId);
            if (scope.cancelled) return;
            result = await contextCompactionService.compact({
                scope, history, settings: globalSettingsRef.get(),
                onCommitted: async () => {
                    await syncHistoryFromFile(scope.itemId, 'agent', scope.topicId);
                },
            });
        } catch (error) {
            uiHelper?.showToastNotification?.(`流式中止内容已保留，压缩失败：${error.message}`, 'error');
        } finally {
            streamCompactionRequests.delete(messageId);
            notifySendStateChanged();
        }
        if (!result || scope.cancelled || compactionFlowlock?.isAgentLocked?.(scope.itemId)) return;
        const selected = currentSelectedItemRef.get();
        if (disposed || selected?.id !== scope.itemId || selected.type !== 'agent'
            || currentTopicIdRef.get() !== scope.topicId) return;
        try {
            await handleSendMessage({
                content: result.message.content,
                attachments: [],
                checkpointMessageId: result.message.id,
                propagateError: true,
            });
        } catch (error) {
            uiHelper?.showToastNotification?.(`压缩快照已保存，自动接续失败：${error.message}`, 'error');
        }
    }

    async function prepareFlowlockContext({ agentId, topicId, history, agentConfig, prompt = '' }) {
        const scope = { itemId: agentId, itemType: 'agent', topicId };
        if ((await executionAuthority(scope)).kind !== 'local') throw Object.assign(new Error('共享话题不支持本地心流推进'), {code:'SHARED_LOCAL_ADVANCE_UNSUPPORTED'});
        if (isContextCompacting(scope)) throw new Error('上下文正在压缩，心流心跳已挂起');
        if (globalSettingsRef.get().enableContextCompaction === true
            && shouldCompactContext(history, agentConfig, prompt)) {
            const result = await contextCompactionService.compact({
                scope, history, settings: globalSettingsRef.get(),
                onCommitted: async () => {
                    const item = currentSelectedItemRef.get();
                    if (item?.id === agentId && item.type === 'agent' && currentTopicIdRef.get() === topicId) {
                        await syncHistoryFromFile(agentId, 'agent', topicId);
                    }
                },
            });
            return effectiveContextHistory(result.history);
        }
        return effectiveContextHistory(history);
    }

    function currentCompactionScope() {
        const item = currentSelectedItemRef?.get?.();
        return { itemId: item?.id, itemType: item?.type, topicId: currentTopicIdRef?.get?.() };
    }

    function isContextCompacting(scope = currentCompactionScope()) {
        return contextCompactionService?.isBusy(scope) === true
            || [...streamCompactionRequests.values()].some(value => !value.cancelled && value.itemId === scope?.itemId
                && value.itemType === scope?.itemType && value.topicId === scope?.topicId);
    }

    function cancelContextCompaction(scope = currentCompactionScope()) {
        let cancelled = contextCompactionService?.cancel?.(scope) === true;
        for (const value of streamCompactionRequests.values()) {
            if (value.itemId === scope?.itemId && value.itemType === scope?.itemType
                && value.topicId === scope?.topicId && !value.cancelled) {
                signalRelayCancellation(value);
                cancelled = true;
            }
        }
        notifySendStateChanged();
        return cancelled;
    }

    async function compactContext(options = {}) {
        const scope = options.scope || currentCompactionScope();
        if (scope.itemType !== 'agent' || !scope.topicId) throw new Error('请先打开一个单聊话题');
        if (!options.allowPendingSend && pendingSendContexts.has(`${scope.itemId}:${scope.topicId}`)) {
            throw new Error('该话题正在发送消息，请稍后压缩');
        }
        const snapshots = streamProjection?.snapshotConversation?.(scope) || [];
        if (snapshots.length) throw new Error('请等待当前回复结束后再压缩');
        const historyRef = options.historyRef || currentChatHistoryRef;
        const selectedRef = options.selectedRef || currentSelectedItemRef;
        const topicRef = options.topicRef || currentTopicIdRef;
        const target = options.renderTarget || messageRenderer;
        const isCurrent = () => selectedRef.get()?.id === scope.itemId
            && selectedRef.get()?.type === scope.itemType && topicRef.get() === scope.topicId;
        const result = await contextCompactionService.compact({
            scope,
            history: historyRef.get(),
            settings: globalSettingsRef.get(),
            onCommitted: async (history, message) => {
                if (!isCurrent()) return;
                historyRef.set([...history]);
                await target?.renderMessage?.(message);
                if (isCurrent()) {
                    const fidelity = message?.contextCompaction?.fidelity;
                    const continuity = message?.contextCompaction?.continuity;
                    const missing = Number.isFinite(fidelity?.total) ? fidelity.total - fidelity.preserved : 0;
                    const openDropped = Boolean(continuity?.applicable && continuity.windows > 0 && continuity.openIssuesDropped);
                    if (missing > 0 || openDropped) {
                        const detail = [
                            missing > 0 ? `快照缺失 ${missing} 个历史标识符` : null,
                            openDropped ? `旧快照 ${continuity.windows} 个未决项未再出现` : null,
                        ].filter(Boolean).join('；');
                        uiHelper?.showToastNotification?.(`上下文压缩完成，${detail}，展开压缩卡片查看明细`, 'warning');
                    } else {
                        uiHelper?.showToastNotification?.('上下文压缩完成', 'success');
                    }
                }
            },
        });
        // 手动压缩只提交快照；发送前压缩由原发送流程继续。
        return result;
    }

    function requireHistoryRepository() {
        if (!chatRepository) throw new Error('ChatRepository is required for chat history operations');
        return chatRepository;
    }

    function getHistory(itemId, itemType, topicId) {
        const repository = requireHistoryRepository();
        return Promise.resolve(repository.getHistory(itemId, itemType, topicId)).then(orderSharedHistory);
    }

    function saveHistory(itemId, itemType, topicId, history) {
        if (historyMutationAuthority) {
            return historyMutationAuthority.replace({
                itemId,
                itemType,
                topicId,
                category: 'chat-manager',
            }, history).then(commit => commit.result || { success: true });
        }
        const repository = requireHistoryRepository();
        return repository.saveHistory(itemId, itemType, topicId, history);
    }

    async function mutateHistory(itemId, itemType, topicId, transform, options = {}) {
        if (historyMutationAuthority) {
            return historyMutationAuthority.mutate({ itemId, itemType, topicId, category: 'chat-manager', ...options }, transform);
        }
        const repository = requireHistoryRepository();
        const current = await repository.getHistory(itemId, itemType, topicId);
        if (!Array.isArray(current)) throw new Error(current?.error || '读取聊天记录失败');
        const next = await transform(structuredClone(current));
        const result = await repository.saveHistory(itemId, itemType, topicId, next, repository.revisionOf?.(current));
        if (result?.success === false || result?.error) throw new Error(result.error || '保存聊天记录失败');
        return { history: Array.isArray(result?.history) ? result.history : next, result };
    }

    // DOM Elements from renderer.js
    let elements = {};
    
    // Functions from main renderer
    let mainRendererFunctions = {};
    // Narrow capability supplied by the owning Surface. ChatManager must not
    // discover the main-window send button through the ambient window object.
    let notifySendStateChanged = () => {};
    let beginHistoryPersistence = () => () => {};
    let isCanvasWindowOpen = false; // State to track if the canvas window is open
    let lastAssistantSuspendAt = 0;
    let activeHistoryLoadToken = 0;
    let offlineHistoryNotice = null;
    let pendingHistoryLoadToken = null;
    let historySyncGeneration = 0;
    let itemSelectionGeneration = 0;
    let topicSelectionGeneration = 0;
    let topicCreationGeneration = 0;
    let pendingItemSelectionToken = null;
    let emptyStateObserver = null;
    let canvasContentDisposer = null;
    let canvasClosedDisposer = null;
    const forwardTimers = new Set();
    const outgoingPersistenceQueues = new Map();
    const selectionListeners = new Set();
    const selectionIntentListeners = new Set();

    function notifySelectionCommitted() {
        mainDrafts?.select();
        const item = currentSelectedItemRef?.get?.();
        const topicId = currentTopicIdRef?.get?.();
        publishConversationSelection({ itemId: item?.id, itemType: item?.type, topicId });
        selectionListeners.forEach(listener => {
            try { listener({ item, topicId }); }
            catch (e) { console.error('[ChatManager] selection listener failed:', e); }
        });
    }
    // 选中话题的那一刻就通知（历史还在分批渲染）。侧栏要立刻跟上：
    // 等 notifySelectionCommitted 的话，几百条消息的话题要好几秒，期间还停在上一个话题的辅助对话上
    function notifySelectionIntent() {
        mainDrafts?.select();
        const item = currentSelectedItemRef?.get?.();
        const topicId = currentTopicIdRef?.get?.();
        selectionIntentListeners.forEach(listener => {
            try { listener({ item, topicId }); }
            catch (e) { console.error('[ChatManager] selection intent listener failed:', e); }
        });
    }
    const pendingSendContexts = new Set();
    const pendingSendControls = new Map();
    let deferredHistorySync = null;
    let editEventRoot = null;
    function getPendingSendState() {
        const item=currentSelectedItemRef?.get(),topic=currentTopicIdRef?.get();
        const pending=item&&pendingSendControls.get(`${item.id}:${topic}`);
        return pending?.phase==='preparing' ? {cancelling:pending.cancelled} : null;
    }
    function cancelPendingSend() {
        const item=currentSelectedItemRef?.get(),topic=currentTopicIdRef?.get();
        const pending=item&&pendingSendControls.get(`${item.id}:${topic}`);
        if(!pending||pending.phase!=='preparing')return false;
        pending.cancelled=true;notifySendStateChanged();return true;
    }
    function flushDeferredHistorySync() {
        if(!deferredHistorySync||document.querySelector('.message-item-editing'))return;
        const pending=deferredHistorySync;deferredHistorySync=null;
        const item=currentSelectedItemRef?.get();
        if(disposed||item?.id!==pending.itemId||item.type!==pending.itemType||currentTopicIdRef.get()!==pending.topicId
            ||pending.itemGeneration!==itemSelectionGeneration||pending.topicGeneration!==topicSelectionGeneration)return;
        void syncHistoryFromFile(pending.itemId,pending.itemType,pending.topicId).catch(error=>console.warn('[Sync] Deferred refresh failed:',error));
    }

    let restoredLocalInput = null;
    // Restore editing only; never auto-resend a persisted/unknown request.
    window.addEventListener('native-sync:restore-local-input', event => {
        const saved = event.detail, item = currentSelectedItemRef.get();
        if (!saved || saved.accepted || item?.type !== 'agent' || saved.descriptor?.itemId !== item.id || saved.descriptor?.topicId !== currentTopicIdRef.get()) return;
        if (elements.messageInput.value.trim() || attachedFilesRef.get().length) {
            uiHelper.showToastNotification('输入框里还有新内容，请先保存；原待发消息仍保留。', 'warning'); return;
        }
        restoredLocalInput = saved;
        elements.messageInput.value = saved.message.content;
        elements.messageInput.dispatchEvent(new Event('input', {bubbles:true}));
        uiHelper.autoResizeTextarea(elements.messageInput); elements.messageInput.focus();
    });
    const pendingUserProjections = new Map();
    const sharedPendingUserIds = new Set();
    let mainDrafts = null;
    let lastOpenSaveQueue = Promise.resolve();
    let initialized = false;
    let disposed = false;

    const sharedProjectionLeases = new Map();
    const sharedProjectionKey = (agentId, topicId, requestId) => JSON.stringify([agentId, topicId, requestId]);
    function beginSharedProjection(agentId, topicId, requestId) {
        const key = sharedProjectionKey(agentId, topicId, requestId);
        if (sharedProjectionLeases.has(key)) return sharedProjectionLeases.get(key);
        const context = {agentId, topicId, messageId:requestId, streamOperationId:`admission:${requestId}`};
        const lease = {key, context, release:beginHistoryPersistence(context) || (() => {}), failed:false};
        sharedProjectionLeases.set(key, lease);
        return lease;
    }
    function settleSharedProjection(lease, success) {
        if (disposed || sharedProjectionLeases.get(lease.key) !== lease) return;
        if (success) {
            if (lease.failed) lease.release = beginHistoryPersistence(lease.context) || (() => {});
            lease.release(true);
            sharedProjectionLeases.delete(lease.key);
        } else if (!lease.failed) {
            lease.failed = true;
            lease.release(false);
            const selected = currentSelectedItemRef.get();
            if (selected?.type === 'agent' && selected.id === lease.context.agentId && currentTopicIdRef.get() === lease.context.topicId) {
                uiHelper.showToastNotification('消息已接收，正在恢复本机记录', 'info');
            }
        }
    }
    function onSharedProjectionSettled(event) {
        if (disposed || event?.source !== 'native-sync-projection' || event.ownerType !== 'agent'
            || !['saved','failed'].includes(event.projectionState)) return;
        const lease = sharedProjectionLeases.get(sharedProjectionKey(event.ownerId || event.agentId, event.topicId, event.requestId));
        if (lease) settleSharedProjection(lease, event.projectionState === 'saved');
    }
    function observeSharedProjection(lease) {
        // This reads/retries only the accepted local projection. It never submits
        // an admission or waits on the model request in the send path.
        Promise.resolve().then(() => {
            if (disposed || sharedProjectionLeases.get(lease.key) !== lease) return null;
            return electronAPI.getNativeHistorySnapshot(lease.context.agentId, 'agent', lease.context.topicId);
        }).then(snapshot => {
            if (disposed || sharedProjectionLeases.get(lease.key) !== lease) return;
            const saved = snapshot?.success !== false && Array.isArray(snapshot?.history)
                && snapshot.history.some(message => message.id === lease.context.messageId);
            settleSharedProjection(lease, saved);
        }).catch(() => settleSharedProjection(lease, false));
    }

    function insertAfterMessage(history, ownerMessageId, message) {
        const next = Array.isArray(history) ? [...history] : [];
        if (next.some(entry => entry?.id === message.id)) return next;
        const ownerIndex = ownerMessageId
            ? next.findIndex(entry => entry?.id === ownerMessageId)
            : -1;
        next.splice(ownerIndex >= 0 ? ownerIndex + 1 : next.length, 0, message);
        return next;
    }

    function persistOutgoingUserMessage(sendContext, userMessage) {
        const signature = `${sendContext.agentId}:${sendContext.topicId}`;
        const previous = outgoingPersistenceQueues.get(signature) || Promise.resolve();
        const operation = previous.catch(() => {}).then(async () => {
            const commit = await mutateHistory(
                sendContext.agentId,
                sendContext.itemType || 'agent',
                sendContext.topicId,
                current => current.some(message => message?.id === userMessage.id) ? current : [...current, userMessage],
                { category: 'outgoing-message' }
            );
            return [...commit.history];
        });
        outgoingPersistenceQueues.set(signature, operation);
        operation.finally(() => {
            if (outgoingPersistenceQueues.get(signature) === operation) {
                outgoingPersistenceQueues.delete(signature);
            }
        }).catch(() => {});
        return operation;
    }

    function setCurrentItemActionButtonText(button, text) {
        if (!button) return;
        const label = button.querySelector('.button-label');
        if (label) {
            label.textContent = text;
            return;
        }
        button.textContent = text;
    }

    async function beginHistoryWatcherOperation() {
        try {
            const result = electronAPI.watcherBegin
                ? await electronAPI.watcherBegin()
                : electronAPI.watcherStop
                    ? await electronAPI.watcherStop()
                    : { success: true, token: null };
            if (result?.stale) return result;
            if (result?.success === false) {
                console.warn('[ChatManager] History watcher unavailable; continuing without file watching:', result.error || result);
                return { success: true, degraded: true, token: null, error: result.error };
            }
            return result || { success: true, token: null };
        } catch (error) {
            console.warn('[ChatManager] History watcher unavailable; continuing without file watching:', error);
            return { success: true, degraded: true, token: null, error: error?.message };
        }
    }

    async function startOwnedHistoryWatcher(leaseToken, filePath, itemId, topicId) {
        if (!electronAPI.watcherStart) return { success: true };
        try {
            const result = await electronAPI.watcherStart(filePath, itemId, topicId, leaseToken);
            if (result?.stale) return result;
            if (result?.success === false) {
                console.warn('[ChatManager] Failed to start history watcher; continuing with loaded history:', result.error || result);
                return { success: true, degraded: true, error: result.error };
            }
            return result || { success: true };
        } catch (error) {
            console.warn('[ChatManager] Failed to start history watcher; continuing with loaded history:', error);
            return { success: true, degraded: true, error: error?.message };
        }
    }



    function buildTurnDepthMap(history = []) {
        const turns = [];
        for (let i = history.length - 1; i >= 0; i--) {
            if (history[i].role === 'assistant') {
                const turn = { assistant: history[i], user: null };
                if (i > 0 && history[i - 1].role === 'user') {
                    turn.user = history[i - 1];
                    i--;
                }
                turns.push(turn);
            } else if (history[i].role === 'user') {
                turns.push({ assistant: null, user: history[i] });
            }
        }
        turns.reverse();

        const depthMap = new Map();
        turns.forEach((turn, turnIndex) => {
            const depth = turns.length - 1 - turnIndex;
            if (turn.assistant?.id) {
                depthMap.set(turn.assistant.id, depth);
            }
            if (turn.user?.id) {
                depthMap.set(turn.user.id, depth);
            }
        });
        return depthMap;
    }

    function getCompiledRegex(rule) {
        if (!rule?.findPattern) {
            return null;
        }

        if (window.uiHelperFunctions?.getCompiledRegex) {
            const compiled = window.uiHelperFunctions.getCompiledRegex(rule.findPattern);
            return compiled?.regex || null;
        }

        if (window.uiHelperFunctions?.regexFromString) {
            return window.uiHelperFunctions.regexFromString(rule.findPattern);
        }

        const regexMatch = rule.findPattern.match(/^\/(.+?)\/([gimuy]*)$/);
        if (regexMatch) {
            return new RegExp(regexMatch[1], regexMatch[2]);
        }
        return new RegExp(rule.findPattern, 'g');
    }

    /**
     * 应用单个正则规则到文本
     * @param {string} text - 输入文本
     * @param {Object} rule - 正则规则对象
     * @returns {string} 处理后的文本
     */
    function applyRegexRule(text, rule) {
        if (!rule || !rule.findPattern || typeof text !== 'string') {
            return text;
        }

        try {
            const regex = getCompiledRegex(rule);
            
            if (!regex) {
                console.error('无法解析正则表达式', rule.findPattern);
                return text;
            }

            regex.lastIndex = 0;
            
            // 应用替换（如果没有替换内容，则默认替换为空字符串）
            return text.replace(regex, rule.replaceWith || '');
        } catch (error) {
            console.error('应用正则规则时出错', rule.findPattern, error);
            return text;
        }
    }

    function getActiveRegexRules(rules, scope, role, depth = 0) {
        if (!rules || !Array.isArray(rules)) {
            return [];
        }

        return rules.filter(rule => {
            if (!rule || rule.enabled === false || !rule.findPattern) return false;

            const shouldApplyToScope =
                (scope === 'context' && rule.applyToContext) ||
                (scope === 'frontend' && rule.applyToFrontend);
            if (!shouldApplyToScope) return false;

            const shouldApplyToRole = rule.applyToRoles && rule.applyToRoles.includes(role);
            if (!shouldApplyToRole) return false;

            const minDepthOk = rule.minDepth === undefined || rule.minDepth === -1 || depth >= rule.minDepth;
            const maxDepthOk = rule.maxDepth === undefined || rule.maxDepth === -1 || depth <= rule.maxDepth;
            return minDepthOk && maxDepthOk;
        });
    }

    /**
     * 应用所有匹配的正则规则到文本
     * @param {string} text - 输入文本
     * @param {Array} rules - 正则规则数组
     * @param {string} scope - 作用域 ('frontend' 或 'context')
     * @param {string} role - 消息角色 ('user' 或 'assistant')
     * @param {number} depth - 消息深度（0 = 最新消息）
     * @returns {string} 处理后的文本
     */
    function applyRegexRules(text, rules, scope, role, depth = 0) {
        if (!rules || !Array.isArray(rules) || typeof text !== 'string') {
            return text;
        }

        const activeRules = getActiveRegexRules(rules, scope, role, depth);
        if (activeRules.length === 0) {
            return text;
        }

        let processedText = text;
        
        activeRules.forEach(rule => {
            processedText = applyRegexRule(processedText, rule);
        });
        
        return processedText;
    }

    /**
     * Initializes the ChatManager module.
     * @param {object} config - The configuration object.
     */
    function init(config) {
        if (disposed) throw new Error('ChatManager has been disposed');
        initialized = false;
        chatContext = config.chatContext || null;
        chatRepository = config.chatRepository || null;
        historyMutationAuthority = config.historyMutationAuthority || null;
        streamConsumerRegistry = config.streamConsumerRegistry || null;
        if (!chatRepository) throw new Error('ChatManager requires ChatRepository');
        chatDomRenderer = config.chatDomRenderer || null;
        electronAPI = config.electronAPI;
        singleChatRequestOrchestrator = config.singleChatRequestOrchestrator
            || createSingleChatRequestOrchestrator({
                electronAPI,
                tavernEngine: window.TavernRulesEngine,
            });
        uiHelper = config.uiHelper;
        
        // Modules
        messageRenderer = config.modules.messageRenderer;
        itemListManager = config.modules.itemListManager;
        topicListManager = config.modules.topicListManager;
        groupRenderer = config.modules.groupRenderer;
        streamProjection = config.modules.streamManager || null;
        interruptCapability = config.modules.interruptHandler || null;

        // State References
        currentSelectedItemRef = config.refs.currentSelectedItemRef;
        if (!Object.getOwnPropertyDescriptor(window, '__nativeConversationContext')) {
            Object.defineProperty(window, '__nativeConversationContext', {get: () => {const id=currentSelectedItemRef?.get()?.id,topic=currentTopicIdRef?.get();return id&&topic?{conversationId:`${id}:${topic}`}:null;}});
        }
        currentTopicIdRef = config.refs.currentTopicIdRef;
        currentChatHistoryRef = config.refs.currentChatHistoryRef;
        attachedFilesRef = config.refs.attachedFilesRef;
        globalSettingsRef = config.refs.globalSettingsRef;

        // DOM Elements
        elements = config.elements;

        // The empty-state visual is a projection of the chat DOM.  History
        // loads and file-watcher updates can complete out of order, so keep a
        // final DOM-level guard against showing it over a real message.
        if (emptyStateObserver) {
            emptyStateObserver.disconnect();
            emptyStateObserver = null;
        }
        if (elements.chatMessagesDiv && typeof MutationObserver !== 'undefined') {
            emptyStateObserver = new MutationObserver(() => {
                syncNextUiEmptyStateWithMessages();
            });
            emptyStateObserver.observe(elements.chatMessagesDiv, { childList: true, subtree: true });
        }
        
        // Editing owns its lifecycle; unrelated streaming/highlighting classes
        // must not trigger history reads or empty-state work.
        editEventRoot?.removeEventListener('vcp:message-edit-ended', flushDeferredHistorySync);
        editEventRoot = elements.chatMessagesDiv || null;
        editEventRoot?.addEventListener('vcp:message-edit-ended', flushDeferredHistorySync);

        // Main Renderer Functions
        mainRendererFunctions = config.mainRendererFunctions;
        beginHistoryPersistence = config.beginHistoryPersistence || (() => () => {});
        notifySendStateChanged = typeof config.notifySendStateChanged === 'function'
            ? config.notifySendStateChanged
            : (typeof mainRendererFunctions?.updateSendButtonState === 'function'
                ? mainRendererFunctions.updateSendButtonState
                : () => {});

        contextCompactionService?.dispose();
        compactionFlowlock = config.flowlockManager || null;
        contextCompactionService = createContextCompactionService({
            historyMutationAuthority,
            getExecutionAuthority: executionAuthority,
            flowlock: {
                suspendForContextCompaction: (...args) => compactionFlowlock?.suspendForContextCompaction?.(...args),
                resumeAfterContextCompaction: lease => {
                    const relaying = [...streamCompactionRequests.values()].some(intent =>
                        intent.relay && intent.flowlockLease === lease);
                    if (!relaying) return compactionFlowlock?.resumeAfterContextCompaction?.(lease);
                    return false;
                },
            },
            interruptRequest: requestId => interruptCapability?.interrupt?.(requestId),
            onBusyChanged: () => notifySendStateChanged(),
        });

        // Listen for Canvas events
        if (electronAPI) {
            canvasContentDisposer?.();
            canvasClosedDisposer?.();
            canvasContentDisposer = null;
            canvasClosedDisposer = null;
            try {
                canvasContentDisposer = electronAPI.onCanvasContentUpdate?.(handleCanvasContentUpdate) || null;
                canvasClosedDisposer = electronAPI.onCanvasWindowClosed?.(handleCanvasWindowClosed) || null;
            } catch (error) {
                canvasContentDisposer?.();
                canvasClosedDisposer?.();
                canvasContentDisposer = null;
                canvasClosedDisposer = null;
                emptyStateObserver?.disconnect();
                emptyStateObserver = null;
                throw error;
            }
        }
        mainDrafts?.dispose(); mainDrafts = null;
        if (elements.messageInput?.addEventListener && window.localStorage) {
            const scope = electronAPI.getComposerScope?.() || 'profile';
            mainDrafts = createComposerDraftController({input:elements.messageInput,
                getAttachments:()=>attachedFilesRef.get(),setAttachments:value=>attachedFilesRef.set(value),
                getScope:()=>{const item=currentSelectedItemRef.get(),topicId=currentTopicIdRef.get();return item?.id&&topicId?{spaceId:scope,itemType:item.type,itemId:item.id,topicId,surface:'main'}:null;},
                getStorage:()=>window.localStorage,
                onRestored:()=>{mainRendererFunctions?.updateAttachmentPreview?.();uiHelper.autoResizeTextarea?.(elements.messageInput);notifySendStateChanged();},
                onError:()=>uiHelper.showToastNotification('草稿读取或保存失败，原话题内容保留，请先核对本机存储。','warning')});
        }
        window.VCPComposerDraftGuard=Object.freeze({flush:()=>mainDrafts?.flush().ok!==false});
        initialized = true;
        console.log('[ChatManager] Initialized successfully.');
    }

    /**
     * Saves the last opened item and topic IDs to the settings file.
     * This is a private helper function.
     */
    function _saveLastOpenState() {
        const currentSelectedItem = currentSelectedItemRef.get();
        const currentTopicId = currentTopicIdRef.get();
        const globalSettings = globalSettingsRef.get();

        if (currentSelectedItem && currentSelectedItem.id) {
            const settingsToSave = {
                ...globalSettings, // Preserve existing settings
                lastOpenItemId: currentSelectedItem.id,
                lastOpenItemType: currentSelectedItem.type,
                lastOpenTopicId: currentTopicId,
            };
            const operation = lastOpenSaveQueue
                .catch(() => {})
                .then(() => electronAPI.saveSettings({ __vcpSettingsOps: [
                    { op: 'set', path: ['lastOpenItemId'], value: currentSelectedItem.id },
                    { op: 'set', path: ['lastOpenItemType'], value: currentSelectedItem.type },
                    { op: 'set', path: ['lastOpenTopicId'], value: currentTopicId },
                ] }));
            lastOpenSaveQueue = operation;
            return operation.catch(err => {
                console.error('[ChatManager] Failed to save last open state:', err);
                return { success: false, error: err?.message || String(err) };
            });
        }
        return Promise.resolve({ success: false, skipped: true });
    }

    function suspendAssistantListenerForTopicLoad(topicId) {
        if (!topicId || !electronAPI || typeof electronAPI.suspendAssistantListener !== 'function') {
            return;
        }

        const now = Date.now();
        if (now - lastAssistantSuspendAt < 200) {
            return;
        }

        const globalSettings = globalSettingsRef && typeof globalSettingsRef.get === 'function'
            ? globalSettingsRef.get()
            : null;

        if (!globalSettings || globalSettings.assistantEnabled !== true) {
            return;
        }

        lastAssistantSuspendAt = now;
        const durationMs = 800 + Math.floor(Math.random() * 701);
        Promise.resolve(electronAPI.suspendAssistantListener(durationMs)).catch((error) => {
            console.warn('[ChatManager] Failed to suspend assistant listener before topic load:', error);
        });
    }

    function normalizeTopicTitle(topicTitle) {
        if (typeof topicTitle !== 'string') return topicTitle;

        const trimmedTitle = topicTitle.trim();
        if (!trimmedTitle) return trimmedTitle;
        if (trimmedTitle.includes('新话题')) return trimmedTitle;

        const timeMatch = trimmedTitle.match(/(\d{1,2}:\d{2}:\d{2})/);
        if (trimmedTitle.includes('新话') && timeMatch) {
            return `新话题 ${timeMatch[1]}`;
        }

        return trimmedTitle;
    }
 
    // --- Functions moved from renderer.js ---

    function setNextUiEmptyStateActive(isActive, reason = null) {
        if (isActive && hasRenderableChatMessages()) {
            isActive = false;
            reason = null;
        }

        const mainContent = document.querySelector('.main-content');
        const emptyState = document.getElementById('nextUiEmptyState');

        mainContent?.classList.toggle('next-ui-empty-state-active', isActive);
        if (mainContent) {
            mainContent.dataset.chatEmpty = String(isActive);
            if (isActive && reason) {
                mainContent.dataset.chatEmptyReason = reason;
            } else {
                delete mainContent.dataset.chatEmptyReason;
            }
        }
        emptyState?.setAttribute('aria-hidden', String(!isActive));
    }

    function hasRenderableChatMessages() {
        const chatMessagesDiv = elements.chatMessagesDiv;
        if (!chatMessagesDiv) return false;
        return Boolean(chatMessagesDiv.querySelector(
            '.message-item:not(.welcome-bubble):not(.topic-timestamp-bubble)'
        ));
    }

    function syncNextUiEmptyStateWithMessages() {
        if (hasRenderableChatMessages()) {
            setNextUiEmptyStateActive(false);
        }
    }

    function displayNoItemSelected() {
        const selectedItem = currentSelectedItemRef?.get?.();
        if (pendingItemSelectionToken !== null || selectedItem?.id) {
            setNextUiEmptyStateActive(false);
            return false;
        }

        ++itemSelectionGeneration;
        ++topicSelectionGeneration;
        ++activeHistoryLoadToken;
        void beginHistoryWatcherOperation().catch(error => {
            console.warn('[ChatManager] Failed to stop history watcher for empty selection:', error);
        });

        const { currentChatNameH3, chatMessagesDiv, currentItemActionBtn, messageInput, sendMessageBtn, attachFileBtn } = elements;
        const voiceChatBtn = document.getElementById('voiceChatBtn');
        if (window.vcpChatHeader) window.vcpChatHeader.clear('选择一个 Agent 或群组开始聊天');
        else currentChatNameH3.textContent = '选择一个 Agent 或群组开始聊天';
        messageRenderer?.clearChat();
        const chatAgentAvatar = document.getElementById('chatAgentAvatar');
        if (chatAgentAvatar) {
            chatAgentAvatar.src = 'assets/icon.png';
            chatAgentAvatar.alt = '';
        }
        chatMessagesDiv.innerHTML = `<div class="message-item system welcome-bubble"><p>欢迎，请从左侧选择 AI 助手或群组，或创建新的对话。</p></div>`;
        currentItemActionBtn.style.display = 'none';
        if (voiceChatBtn) voiceChatBtn.style.display = 'none';
        messageInput.disabled = true;
        sendMessageBtn.disabled = true;
        attachFileBtn.disabled = true;
        setNextUiEmptyStateActive(true, 'no-selection');
        if (mainRendererFunctions.displaySettingsForItem) {
            mainRendererFunctions.displaySettingsForItem(); 
        }
        if (topicListManager) topicListManager.loadTopicList();
        // 当前助手被删掉时走到这里：跟着主聊天的侧栏、状态面板、调用轨迹都要知道现在没有会话了
        notifySelectionCommitted();
        return true;
    }

    async function selectItem(itemId, itemType, itemName, itemAvatarUrl, itemFullConfig, options = {}) {
        if(mainDrafts&&!mainDrafts.flush().ok)return;
        const selectionToken = ++itemSelectionGeneration;
        ++topicSelectionGeneration;
        ++activeHistoryLoadToken;
        pendingItemSelectionToken = selectionToken;
        const isSelectionCurrent = () => selectionToken === itemSelectionGeneration;
        const finishSelection = () => {
            if (pendingItemSelectionToken === selectionToken) {
                pendingItemSelectionToken = null;
            }
        };
        let watcherLeaseToken = null;
        const loadOwnedHistory = (topicId) => loadChatHistory(
            itemId,
            itemType,
            topicId,
            isSelectionCurrent,
            watcherLeaseToken
        );
        setNextUiEmptyStateActive(false);

        const activeBeforeSelection = currentSelectedItemRef.get();
        if (
            activeBeforeSelection?.id === itemId
            && activeBeforeSelection?.type === itemType
            && currentTopicIdRef.get()
        ) {
            finishSelection();
            await _saveLastOpenState();
            return;
        }

        if(mainDrafts&&!mainDrafts.suspend()){finishSelection();return;}
        // Stop old media immediately, before asynchronous watcher/topic loading.
        messageRenderer?.clearChat();

        // Flowlock 只绑定目标 Agent 的 Topic，不再阻止用户切换到其他 Agent。
        // 当重新进入已锁 Agent 时，下面会优先恢复它的锁定 Topic。
        try {
            const lease = await beginHistoryWatcherOperation();
            if (lease?.stale || lease?.success === false) return;
            watcherLeaseToken = lease.token || null;
        } catch (error) {
            console.warn('[ChatManager] Failed to claim history watcher ownership:', error);
        }

        if (!isSelectionCurrent()) return;

        const { currentChatNameH3, currentItemActionBtn, messageInput, sendMessageBtn, attachFileBtn } = elements;
        let currentSelectedItem = currentSelectedItemRef.get();

        currentSelectedItem = { id: itemId, type: itemType, name: itemName, avatarUrl: itemAvatarUrl, config: itemFullConfig };
        currentSelectedItemRef.set(currentSelectedItem);
        chatContext?.setSelectedItem(currentSelectedItem);
        // From this point displayNoItemSelected can rely on the selected item
        // itself. Keep generation ownership for the async transaction, but do
        // not retain a separate pending marker that an unrelated renderer
        // exception could strand forever.
        finishSelection();
        currentTopicIdRef.set(null); // Reset topic
        currentChatHistoryRef.set([]);
        chatContext?.setHistory([]);
        notifySendStateChanged();
        notifySelectionCommitted();

        document.querySelectorAll('.topic-list .topic-item.active-topic-glowing').forEach(item => {
            item.classList.remove('active-topic-glowing');
        });

        if (messageRenderer) {
            messageRenderer.setCurrentSelectedItem(currentSelectedItem);
            messageRenderer.setCurrentTopicId(null);
            messageRenderer.setCurrentItemAvatar(itemAvatarUrl);
            messageRenderer.setCurrentItemAvatarColor(itemFullConfig?.avatarCalculatedColor || null);
        }

        if (itemType === 'group' && groupRenderer && typeof groupRenderer.handleSelectGroup === 'function') {
            await groupRenderer.handleSelectGroup(itemId, itemName, itemAvatarUrl, itemFullConfig);
            if (!isSelectionCurrent()) return;
        } else if (itemType === 'agent') {
            if (groupRenderer && typeof groupRenderer.clearInviteAgentButtons === 'function') {
                groupRenderer.clearInviteAgentButtons();
            }
        }
     
        const voiceChatBtn = document.getElementById('voiceChatBtn');

        const itemTypeLabel = itemType === 'group' ? ' (群组)' : '';
        const classicTitle = `与 ${itemName}${itemTypeLabel} 聊天中`;
        if (window.vcpChatHeader) window.vcpChatHeader.setTitle({ classic: classicTitle, capsule: `${itemName}${itemTypeLabel}` });
        else currentChatNameH3.textContent = classicTitle;
        const chatAgentAvatar = document.getElementById('chatAgentAvatar');
        if (chatAgentAvatar) {
            chatAgentAvatar.src = itemAvatarUrl || 'assets/icon.png';
            chatAgentAvatar.alt = itemName || '';
        }
        window.flowlockManager?.syncCurrentHeaderIndicator?.();
        setCurrentItemActionButtonText(currentItemActionBtn, itemType === 'group' ? '新建群聊话题' : '新建聊天话题');
        currentItemActionBtn.title = `为 ${itemName} 新建${itemType === 'group' ? '群聊话题' : '聊天话题'}`;
        currentItemActionBtn.style.display = 'inline-flex';
        
        if (voiceChatBtn) {
            voiceChatBtn.style.display = itemType === 'agent' ? 'inline-flex' : 'none';
        }

        itemListManager.highlightActiveItem(itemId, itemType);
        if(mainRendererFunctions.displaySettingsForItem) mainRendererFunctions.displaySettingsForItem();

        try {
            let topics;
            if (itemType === 'agent') {
                topics = await electronAPI.getAgentTopics(itemId);
            } else if (itemType === 'group') {
                topics = await electronAPI.getGroupTopics(itemId);
            }
            if (!isSelectionCurrent()) return;

            if (topics && !topics.error && topics.length > 0) {
                let topicToLoadId = topics[0].id;
                const lockedTopicId = itemType === 'agent'
                    ? window.flowlockManager?.getLockedTopicId?.(itemId)
                    : null;
                const preferredTopicId = typeof options.preferredTopicId === 'string'
                    ? options.preferredTopicId
                    : null;
                const rememberedTopicId = localStorage.getItem(`lastActiveTopic_${itemId}_${itemType}`);

                if (lockedTopicId && topics.some(t => t.id === lockedTopicId)) {
                    topicToLoadId = lockedTopicId;
                } else if (preferredTopicId && topics.some(t => t.id === preferredTopicId)) {
                    topicToLoadId = preferredTopicId;
                } else if (rememberedTopicId && topics.some(t => t.id === rememberedTopicId)) {
                    topicToLoadId = rememberedTopicId;
                }
                if (!isSelectionCurrent()) return;
                currentTopicIdRef.set(topicToLoadId);
                if (messageRenderer) messageRenderer.setCurrentTopicId(topicToLoadId);
                notifySelectionIntent();
                await loadOwnedHistory(topicToLoadId);
            } else if (topics && topics.error) {
                if (!isSelectionCurrent()) return;
                console.error(`加载 ${itemType} ${itemId} 的话题列表失败`, topics.error);
                if (messageRenderer) messageRenderer.renderMessage({ role: 'system', notice: 'error', content: `加载话题列表失败: ${topics.error}`, timestamp: Date.now() });
                await loadOwnedHistory(null);
            } else {
                if (itemType === 'agent') {
                    const agentConfig = await electronAPI.getAgentConfig(itemId);
                    if (!isSelectionCurrent()) return;
                    // ⚠️ 检查是否返回错误对象
                    if (agentConfig && agentConfig.error) {
                        console.error(`[ChatManager] Failed to get agent config for ${itemId}:`, agentConfig.error);
                        if (messageRenderer) messageRenderer.renderMessage({ role: 'system', notice: 'error', content: `加载助手配置失败: ${agentConfig.error}`, timestamp: Date.now() });
                        await loadOwnedHistory(null);
                    } else if (agentConfig && (!agentConfig.topics || agentConfig.topics.length === 0)) {
                        const defaultTopicResult = await electronAPI.createNewTopicForAgent(itemId, "主要对话");
                        if (!isSelectionCurrent()) return;
                        if (defaultTopicResult.success) {
                            currentTopicIdRef.set(defaultTopicResult.topicId);
                            if (messageRenderer) messageRenderer.setCurrentTopicId(defaultTopicResult.topicId);
                            notifySelectionIntent();
                            await loadOwnedHistory(defaultTopicResult.topicId);
                        } else {
                            if (messageRenderer) messageRenderer.renderMessage({ role: 'system', notice: 'error', content: `创建默认话题失败: ${defaultTopicResult.error}`, timestamp: Date.now() });
                            await loadOwnedHistory(null);
                        }
                    } else {
                         await loadOwnedHistory(null);
                    }
                } else if (itemType === 'group') {
                    const defaultTopicResult = await electronAPI.createNewTopicForGroup(itemId, "主要群聊");
                    if (!isSelectionCurrent()) return;
                    if (defaultTopicResult.success) {
                        currentTopicIdRef.set(defaultTopicResult.topicId);
                        if (messageRenderer) messageRenderer.setCurrentTopicId(defaultTopicResult.topicId);
                        notifySelectionIntent();
                        await loadOwnedHistory(defaultTopicResult.topicId);
                    } else {
                        if (messageRenderer) messageRenderer.renderMessage({ role: 'system', notice: 'error', content: `创建默认群聊话题失败: ${defaultTopicResult.error}`, timestamp: Date.now() });
                        await loadOwnedHistory(null);
                    }
                }
            }
        } catch (e) {
            if (!isSelectionCurrent()) return;
            console.error(`选择 ${itemType} ${itemId} 时发生错误: `, e);
            if (messageRenderer) messageRenderer.renderMessage({ role: 'system', notice: 'error', content: `选择${itemType === 'group' ? '群组' : '助手'}时出错: ${e.message}`, timestamp: Date.now() });
        }

        if (!isSelectionCurrent()) return;
        messageInput.disabled = false;
        sendMessageBtn.disabled = false;
        attachFileBtn.disabled = false;
        // messageInput.focus();
        if (topicListManager) await Promise.resolve(topicListManager.loadTopicList());
        if (!isSelectionCurrent()) return;
        await _saveLastOpenState(); // Commit before startup/reload can observe the selection.
        finishSelection();
        notifySelectionCommitted();
    }

    /**
     * Restores the last durable chat selection through the same transaction as
     * an explicit user selection. A concurrent click increments the shared
     * selection generation and therefore always supersedes this restoration.
     */
    async function restoreLastOpenState(settings = {}) {
        const itemId = typeof settings.lastOpenItemId === 'string'
            ? settings.lastOpenItemId
            : null;
        const itemType = settings.lastOpenItemType === 'agent' || settings.lastOpenItemType === 'group'
            ? settings.lastOpenItemType
            : null;
        if (!itemId || !itemType || !itemListManager?.findItemById) return false;

        const item = itemListManager.findItemById(itemId, itemType);
        if (!item) return false;

        await selectItem(
            item.id,
            item.type,
            item.name,
            item.avatarUrl,
            item.config || item,
            { preferredTopicId: settings.lastOpenTopicId }
        );

        const selectedItem = currentSelectedItemRef.get();
        return selectedItem?.id === item.id && selectedItem?.type === item.type;
    }
 
    async function selectTopic(topicId) {
        setNextUiEmptyStateActive(false);
        const selectedItemForLock = currentSelectedItemRef.get();
        const lockedTopicId = selectedItemForLock?.type === 'agent'
            ? window.flowlockManager?.getLockedTopicId?.(selectedItemForLock.id)
            : null;

        if (lockedTopicId && topicId !== lockedTopicId) {
            if (uiHelper?.showToastNotification) {
                uiHelper.showToastNotification('该 Agent 正在锁定话题中运行，请先停止心流锁再切换话题。', 'warning');
            }
            console.log(`[ChatManager] Blocked topic switch for locked Agent ${selectedItemForLock.id}: ${lockedTopicId} -> ${topicId}`);
            return;
        }

        let currentTopicId = currentTopicIdRef.get();
        if (currentTopicId === topicId) {
            await _saveLastOpenState();
            return;
        }

        const currentSelectedItem = currentSelectedItemRef.get();
        if (!currentSelectedItem || !currentSelectedItem.id || !currentSelectedItem.type) {
            console.warn('[ChatManager] Ignored selectTopic: no active item selected yet.');
            return;
        }

        const topicToken = ++topicSelectionGeneration;
        ++activeHistoryLoadToken;
        const selectedItemId = currentSelectedItem.id;
        const selectedItemType = currentSelectedItem.type;
        const isTopicOperationCurrent = () => {
            const activeItem = currentSelectedItemRef.get();
            return topicToken === topicSelectionGeneration
                && activeItem?.id === selectedItemId
                && activeItem?.type === selectedItemType;
        };
        const isTopicSelectionCurrent = () => {
            return isTopicOperationCurrent()
                && currentTopicIdRef.get() === topicId;
        };
        let watcherLeaseToken = null;

        try {
            if(mainDrafts&&!mainDrafts.suspend())return;
            currentTopicIdRef.set(topicId);
            if (messageRenderer) {
                messageRenderer.setCurrentTopicId(topicId);
                // Navigation intent ends the old media lease before any IPC await.
                messageRenderer.clearChat();
            }
            notifySelectionIntent();
            // Persist the selection intent before watcher/history work. A
            // renderer reload or crash during that work must restore the
            // topic the user actually selected, not the previous durable one.
            await _saveLastOpenState();
            const lease = await beginHistoryWatcherOperation();
            if (!isTopicSelectionCurrent() || lease?.stale || lease?.success === false) return;
            watcherLeaseToken = lease.token || null;
            // Persist the user's selection intent at the same point as the
            // visible state commit. History/watcher work is cancellable; if
            // the user immediately switches away, waiting until that work
            // finishes would silently forget the topic they just selected.
            localStorage.setItem(`lastActiveTopic_${currentSelectedItem.id}_${currentSelectedItem.type}`, topicId);

            document.querySelectorAll('#topicList .topic-item').forEach(item => {
                const isClickedItem = item.dataset.topicId === topicId && item.dataset.itemId === currentSelectedItem.id;
                item.classList.toggle('active', isClickedItem);
                item.classList.toggle('active-topic-glowing', isClickedItem);
            });

            await loadChatHistory(
                currentSelectedItem.id,
                currentSelectedItem.type,
                topicId,
                isTopicSelectionCurrent,
                watcherLeaseToken
            );
            if (!isTopicSelectionCurrent()) return;
            await _saveLastOpenState();
            notifySelectionCommitted();
        } catch (error) {
            if (!isTopicSelectionCurrent()) return;
            console.error('[ChatManager] Failed to select topic:', error);
            if (messageRenderer) {
                messageRenderer.renderMessage({
                    role: 'system',
                    content: `打开话题失败: ${error.message}`,
                    timestamp: Date.now()
                });
            }
        }
    }

    async function handleTopicDeletion(remainingTopics, deletionContext = null) {
        let currentSelectedItem = currentSelectedItemRef.get();
        if (
            deletionContext
            && (
                currentSelectedItem?.id !== deletionContext.id
                || currentSelectedItem?.type !== deletionContext.type
            )
        ) {
            console.debug('[ChatManager] Ignoring stale topic deletion completion', deletionContext);
            return false;
        }
        const deletedTopicIds = new Set([
            ...(Array.isArray(deletionContext?.deletedTopicIds) ? deletionContext.deletedTopicIds : []),
            ...(deletionContext?.topicId ? [deletionContext.topicId] : []),
        ].filter(Boolean).map(String));
        const sanitizedRemainingTopics = (Array.isArray(remainingTopics) ? remainingTopics : [])
            .filter(topic => !deletedTopicIds.has(String(topic?.id)));
        const currentConfig = currentSelectedItem.config || currentSelectedItem;
        const nextConfig = { ...currentConfig, topics: sanitizedRemainingTopics };
        currentSelectedItem = currentSelectedItem.config
            ? { ...currentSelectedItem, config: nextConfig }
            : { ...currentSelectedItem, ...nextConfig };
        currentSelectedItemRef.set(currentSelectedItem);

        if (sanitizedRemainingTopics.length > 0) {
            const fallbackTopic = deletionContext?.fallbackTopicId
                ? sanitizedRemainingTopics.find(topic => String(topic?.id) === String(deletionContext.fallbackTopicId))
                : null;
            const newSelectedTopic = fallbackTopic || [...sanitizedRemainingTopics]
                .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
            await selectTopic(newSelectedTopic.id);
        } else {
            ++topicSelectionGeneration;
            ++activeHistoryLoadToken;
            currentTopicIdRef.set(null);
            currentChatHistoryRef.set([]);
            notifySelectionCommitted();
            if (messageRenderer) {
                messageRenderer.setCurrentTopicId(null);
                messageRenderer.clearChat();
                messageRenderer.renderMessage({ role: 'system', content: '所有话题均已删除。请创建一个新话题。', timestamp: Date.now() });
            }
            await displayTopicTimestampBubble(currentSelectedItem.id, currentSelectedItem.type, null);
        }
        return true;
    }

    async function loadChatHistory(itemId, itemType, topicId, ownershipGuard = null, watcherLeaseToken = null) {
        const loadToken = ++activeHistoryLoadToken;
        offlineHistoryNotice = null;
        pendingHistoryLoadToken = loadToken;
        try {
        setNextUiEmptyStateActive(false);

        const isLoadStillActive = () => loadToken === activeHistoryLoadToken
            && (!ownershipGuard || ownershipGuard());
        const abortIfStale = () => {
            if (!isLoadStillActive()) {
                console.debug(`[ChatManager] Ignoring stale history load for ${itemType}:${itemId}:${topicId}`);
                return true;
            }
            return false;
        };

        suspendAssistantListenerForTopicLoad(topicId);

        if (messageRenderer) messageRenderer.clearChat();
        currentChatHistoryRef.set([]);
        notifySendStateChanged();
    
    
        document.querySelectorAll('.topic-list .topic-item').forEach(item => {
            const isCurrent = item.dataset.topicId === topicId && item.dataset.itemId === itemId && item.dataset.itemType === itemType;
            item.classList.toggle('active', isCurrent);
            item.classList.toggle('active-topic-glowing', isCurrent);
        });
    
        if (messageRenderer) messageRenderer.setCurrentTopicId(topicId);
        if (abortIfStale()) return;
    
        if (!itemId) {
            const errorMsg = `错误：无法加载聊天记录，${itemType === 'group' ? '群组' : '助手'}ID (${itemId}) 缺失。`;
            console.error(errorMsg);
            if (messageRenderer) messageRenderer.renderMessage({ role: 'system', notice: 'error', content: errorMsg, timestamp: Date.now() });
            await displayTopicTimestampBubble(null, null, null);
            return;
        }
    
        if (!topicId) {
            if (messageRenderer) messageRenderer.renderMessage({ role: 'system', content: '请选择或创建一个话题以开始聊天。', timestamp: Date.now() });
            await displayTopicTimestampBubble(itemId, itemType, null);
            return;
        }

        if (watcherLeaseToken === null && electronAPI.watcherBegin) {
            const lease = await beginHistoryWatcherOperation();
            if (abortIfStale() || lease?.stale || lease?.success === false) return;
            watcherLeaseToken = lease.token || null;
        }
    
        // 核心修改：使用 await 确保加载消息被渲染
        if (messageRenderer) {
            await messageRenderer.renderMessage({ role: 'system', name: '系统', content: '加载聊天记录中...', timestamp: Date.now(), isThinking: true, id: 'loading_history' });
        }
        if (abortIfStale()) {
            if (messageRenderer) messageRenderer.removeMessageById('loading_history');
            return;
        }
    
        const historyResult = await getHistory(itemId, itemType, topicId);

        if (abortIfStale()) {
            if (messageRenderer) messageRenderer.removeMessageById('loading_history');
            return;
        }
    
        const currentSelectedItem = currentSelectedItemRef.get();
        const agentConfigForHistory = currentSelectedItem.config || currentSelectedItem;
        if (electronAPI.watcherStart && agentConfigForHistory?.agentDataPath) {
            const historyFilePath = `${agentConfigForHistory.agentDataPath}\\topics\\${topicId}\\history.json`;
            const watcherResult = await startOwnedHistoryWatcher(watcherLeaseToken, historyFilePath, itemId, topicId);
            if (watcherResult?.stale || watcherResult?.success === false) return;
        }

        if (abortIfStale()) {
            if (messageRenderer) messageRenderer.removeMessageById('loading_history');
            return;
        }
    
        if (messageRenderer) messageRenderer.removeMessageById('loading_history');
    
        await displayTopicTimestampBubble(itemId, itemType, topicId);
        if (abortIfStale()) return;

        // 渐进历史渲染从“最新批次”开始，再把旧批次插到顶部。活动流如果等到
        // 全部旧批次结束后才 reconcile，长历史加载期间会暂时没有呼吸框；若由
        // 其他流式帧抢先补建 DOM，还可能与批次插入交错，视觉上像被排到旧楼层中。
        // 在批处理开始前把 renderer-local 活动流快照合并到投影历史尾部，使它从
        // 第一批起就拥有确定的最后楼层。这里只修改内存/DOM 投影，不写 durable history。
        const activeStreamSnapshots = streamProjection?.snapshotConversation?.({
            itemType,
            itemId,
            topicId,
        }) || [];
        const historyForProjection = Array.isArray(historyResult)
            ? [...historyResult]
            : historyResult;
        if (Array.isArray(historyForProjection)) {
            for (const snapshot of activeStreamSnapshots) {
                if (!snapshot?.messageId || historyForProjection.some(message => message?.id === snapshot.messageId)) {
                    continue;
                }
                const accumulatedText = typeof snapshot.accumulatedText === 'string'
                    ? snapshot.accumulatedText
                    : '';
                historyForProjection.push({
                    ...(snapshot.message || {}),
                    ...(snapshot.context || {}),
                    id: snapshot.messageId,
                    role: snapshot.message?.role || 'assistant',
                    content: accumulatedText || snapshot.message?.content || '',
                    isThinking: accumulatedText.trim() === '',
                    isPendingStream: true,
                    timestamp: snapshot.message?.timestamp || Date.now(),
                    streamOperationId: snapshot.streamOperationId || null,
                });
            }
        }
    
        if (historyResult && historyResult.error) {
            const notice = { role: 'system', notice: 'error', content: `加载话题 "${topicId}" 的聊天记录失败: ${historyResult.error}`, timestamp: Date.now() };
            if (historyResult.error === 'NETWORK_UNAVAILABLE') {
                notice.id = 'offline_history_' + crypto.randomUUID();
                offlineHistoryNotice = { loadToken, id: notice.id };
            }
            await messageRenderer?.renderMessage(notice);
        } else if (Array.isArray(historyForProjection) && historyForProjection.length > 0) {
            currentChatHistoryRef.set(historyForProjection);
            notifySendStateChanged();
            if (messageRenderer) {
                // 使用优化的分批渲染策略
                const renderOptions = {
                    initialBatch: 5,    // 首先显示最新的5条消息
                    batchSize: 10,      // 后续每批10条消息
                    batchDelay: 16      // 每批仍经 idle 调度；短暂让出一帧，避免长历史累积固定等待
                };
                
                console.log(`[ChatManager] 开始加载话题历史，共 ${historyForProjection.length} 条消息`);
                await (chatDomRenderer || messageRenderer).renderHistory(historyForProjection, renderOptions);
                if (abortIfStale()) return;
                console.log(`[ChatManager] 话题历史加载完成`);
            }
    
        } else if (historyResult) { // History is empty
            currentChatHistoryRef.set([]);
            notifySendStateChanged();
            const activeItem = currentSelectedItemRef.get();
            if (
                activeItem?.id === itemId
                && activeItem?.type === itemType
                && currentTopicIdRef.get() === topicId
            ) {
                setNextUiEmptyStateActive(true, 'empty-topic');
            }
        } else {
            if (messageRenderer) messageRenderer.renderMessage({ role: 'system', notice: 'error', content: `加载话题 "${topicId}" 的聊天记录时返回了无效数据。`, timestamp: Date.now() });
        }

        if (abortIfStale()) return;

        // Re-project renderer-local active streams after history/DOM replacement.
        // This never persists partial output; terminal persistence remains coordinator-owned.
        await streamProjection?.reconcileConversation?.({ itemType, itemId, topicId });
        if (abortIfStale()) return;

        if (itemId && topicId && !(historyResult && historyResult.error)) {
            localStorage.setItem(`lastActiveTopic_${itemId}_${itemType}`, topicId);
        }
        } finally {
            if (pendingHistoryLoadToken === loadToken) pendingHistoryLoadToken = null;
        }
    }

    async function removeAttachmentFromMessage(messageId, attachmentIndex) {
        const currentChatHistory = currentChatHistoryRef.get();
        const currentTopicId = currentTopicIdRef.get();
        const currentSelectedItem = currentSelectedItemRef.get();

        if (!currentChatHistory || !currentTopicId || !currentSelectedItem) {
            console.error('[ChatManager] Cannot remove attachment: missing state.');
            return;
        }

        const messageIndex = currentChatHistory.findIndex(m => m.id === messageId);
        if (messageIndex === -1) {
            console.error('[ChatManager] Message not found in history:', messageId);
            return;
        }

        const message = currentChatHistory[messageIndex];
        if (message.attachments && message.attachments[attachmentIndex]) {
            const attachmentToRemove = message.attachments[attachmentIndex];
            const fileName = attachmentToRemove.name;
            const updatedHistory = JSON.parse(JSON.stringify(currentChatHistory));
            const updatedMessage = updatedHistory[messageIndex];

            updatedMessage.attachments.splice(attachmentIndex, 1);

            if (updatedMessage.content && fileName) {
                const escapedFileName = fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const genericRegex = new RegExp(`\\n*\\s*\\[附加文件: [^\\]]*${escapedFileName}[^\\]]*\\]`, 'g');
                const imageRegex = new RegExp(`\\n*\\s*\\[附加图片: [^\\]]*${escapedFileName}[^\\]]*\\]`, 'g');
                const fullBlockRegex = new RegExp(`\\n*\\s*\\[附加文件: [^\\]]*${escapedFileName}[^\\]]*\\][\\s\\S]*?\\[/附加文件结束: [^\\]]*${escapedFileName}[^\\]]*\\]`, 'g');

                updatedMessage.content = updatedMessage.content
                    .replace(fullBlockRegex, '')
                    .replace(genericRegex, '')
                    .replace(imageRegex, '')
                    .trim();
            }

            try {
                await saveHistory(currentSelectedItem.id, currentSelectedItem.type, currentTopicId, updatedHistory);
                currentChatHistoryRef.set(updatedHistory);

                if (messageRenderer && typeof messageRenderer.updateMessageUI === 'function') {
                    await messageRenderer.updateMessageUI(messageId, updatedMessage);
                } else {
                    await loadChatHistory(currentSelectedItem.id, currentSelectedItem.type, currentTopicId);
                }

                if (uiHelper && uiHelper.showToastNotification) {
                    uiHelper.showToastNotification('附件已移除', 'success');
                }
            } catch (error) {
                console.error('[ChatManager] Failed to remove attachment:', error);
            }
        }
    }

    async function processFilesData(files) {
        if (!files || files.length === 0) return [];

        console.log(`[ChatManager] Processing ${files.length} files...`);
        const filesToProcess = [];

        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            filesToProcess.push(new Promise((resolve) => {
                const reader = new FileReader();
                reader.onload = (e) => {
                    const arrayBuffer = e.target.result;
                    if (!arrayBuffer) {
                        console.warn(`[ChatManager] FileReader received null ArrayBuffer for ${file.name}`);
                        resolve({ name: file.name, error: '无法读取文件内容' });
                        return;
                    }

                    const fileBuffer = new Uint8Array(arrayBuffer);
                    resolve({
                        name: file.name,
                        type: file.type || 'application/octet-stream',
                        data: fileBuffer,
                        size: file.size,
                        path: file.path,
                    });
                };
                reader.onerror = (err) => {
                    console.error(`[ChatManager] FileReader error for ${file.name}:`, err);
                    resolve({ name: file.name, error: `无法读取文件: ${err.message}` });
                };
                reader.readAsArrayBuffer(file);
            }));
        }

        return await Promise.all(filesToProcess);
    }

    async function addAttachmentsToMessage(messageId, droppedFilesData) {
        console.log(`[ChatManager] addAttachmentsToMessage triggered for messageId: ${messageId}`, droppedFilesData);

        const currentChatHistory = currentChatHistoryRef.get();
        const currentTopicId = currentTopicIdRef.get();
        const currentSelectedItem = currentSelectedItemRef.get();

        if (!currentChatHistory || !currentTopicId || !currentSelectedItem) {
            console.error('[ChatManager] Context missing:', {
                hasHistory: !!currentChatHistory,
                currentTopicId,
                selectedItem: currentSelectedItem?.id,
            });
            return;
        }

        const messageIndex = currentChatHistory.findIndex(m => m.id === messageId);
        if (messageIndex === -1) {
            console.error(`[ChatManager] Message with ID ${messageId} not found in current history.`);
            return;
        }

        try {
            const results = await electronAPI.handleFileDrop(currentSelectedItem.id, currentTopicId, droppedFilesData);

            const successfulAttachments = results
                .filter(r => r.success && r.attachment)
                .map(r => ({
                    ...r.attachment,
                    name: r.name,
                    src: r.attachment.internalPath,
                }));

            if (successfulAttachments.length === 0) {
                if (uiHelper && uiHelper.showToastNotification) {
                    uiHelper.showToastNotification('附件添加失败：无法处理文件', 'error');
                }
                return;
            }

            const updatedHistory = JSON.parse(JSON.stringify(currentChatHistory));
            const message = updatedHistory[messageIndex];
            if (!message.attachments) message.attachments = [];
            message.attachments.push(...successfulAttachments);

            await saveHistory(currentSelectedItem.id, currentSelectedItem.type, currentTopicId, updatedHistory);
            currentChatHistoryRef.set(updatedHistory);

            if (messageRenderer && typeof messageRenderer.updateMessageUI === 'function') {
                await messageRenderer.updateMessageUI(messageId, message);
            } else {
                await loadChatHistory(currentSelectedItem.id, currentSelectedItem.type, currentTopicId);
            }

            if (uiHelper && uiHelper.showToastNotification) {
                uiHelper.showToastNotification(`成功添加 ${successfulAttachments.length} 个附件`, 'success');
            }
        } catch (error) {
            console.error('[ChatManager] Failed to add attachments:', error);
            if (uiHelper && uiHelper.showToastNotification) {
                uiHelper.showToastNotification(`附件添加出错: ${error.message}`, 'error');
            }
        }
    }

    async function displayTopicTimestampBubble(itemId, itemType, topicId) {
        const { chatMessagesDiv } = elements;
        const chatMessagesContainer = document.querySelector('.chat-messages-container');

        if (!chatMessagesDiv || !chatMessagesContainer) {
            console.warn('[displayTopicTimestampBubble] Missing chatMessagesDiv or chatMessagesContainer.');
            const existingBubble = document.getElementById('topicTimestampBubble');
            if (existingBubble) existingBubble.style.display = 'none';
            return;
        }

        let timestampBubble = document.getElementById('topicTimestampBubble');
        if (!timestampBubble) {
            timestampBubble = document.createElement('div');
            timestampBubble.id = 'topicTimestampBubble';
            timestampBubble.className = 'topic-timestamp-bubble';
            if (chatMessagesDiv.firstChild) {
                chatMessagesDiv.insertBefore(timestampBubble, chatMessagesDiv.firstChild);
            } else {
                chatMessagesDiv.appendChild(timestampBubble);
            }
        } else {
            if (chatMessagesDiv.firstChild !== timestampBubble) {
                chatMessagesDiv.insertBefore(timestampBubble, chatMessagesDiv.firstChild);
            }
        }

        if (!itemId || !topicId) {
            timestampBubble.style.display = 'none';
            return;
        }

        try {
            let itemConfigFull;
            if (itemType === 'agent') {
                itemConfigFull = await electronAPI.getAgentConfig(itemId);
            } else if (itemType === 'group') {
                itemConfigFull = await electronAPI.getAgentGroupConfig(itemId);
            }

            if (itemConfigFull && !itemConfigFull.error && itemConfigFull.topics) {
                const currentTopicObj = itemConfigFull.topics.find(t => t.id === topicId);
                if (currentTopicObj && currentTopicObj.createdAt) {
                    const date = new Date(currentTopicObj.createdAt);
                    const formattedDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
                    timestampBubble.textContent = `话题创建于 ${formattedDate}`;
                    timestampBubble.style.display = 'block';
                } else {
                    console.warn(`[displayTopicTimestampBubble] Topic ${topicId} not found or has no createdAt for ${itemType} ${itemId}.`);
                    timestampBubble.style.display = 'none';
                }
            } else {
                console.error('[displayTopicTimestampBubble] Could not load config or topics for', itemType, itemId, 'Error:', itemConfigFull?.error);
                timestampBubble.style.display = 'none';
            }
        } catch (error) {
            console.error('[displayTopicTimestampBubble] Error fetching topic creation time for', itemType, itemId, 'topic', topicId, ':', error);
            timestampBubble.style.display = 'none';
        }
    }

    async function attemptTopicSummarizationIfNeeded() {
        const currentSelectedItem = currentSelectedItemRef.get();
        const currentChatHistory = currentChatHistoryRef.get();
        const currentTopicId = currentTopicIdRef.get();

        if (currentSelectedItem.type !== 'agent' || currentChatHistory.length < 4 || !currentTopicId) return;

        try {
            // 强制从文件系统重新加载最新的配置，确保标题检查的准确性
            const agentConfigForSummary = await electronAPI.getAgentConfig(currentSelectedItem.id);
            if (!agentConfigForSummary || agentConfigForSummary.error) {
                console.error('[TopicSummary] Failed to get fresh agent config for summarization:', agentConfigForSummary?.error);
                return;
            }
            // 使用最新的配置更新内存中的状态，以保持同步
            const refreshedSelectedItem = currentSelectedItem.config
                ? { ...currentSelectedItem, name: agentConfigForSummary.name || currentSelectedItem.name, config: agentConfigForSummary }
                : { ...currentSelectedItem, ...agentConfigForSummary };
            currentSelectedItemRef.set(refreshedSelectedItem);

            const topics = agentConfigForSummary.topics || [];
            const currentTopicObject = topics.find(t => t.id === currentTopicId);
            const existingTopicTitle = currentTopicObject ? currentTopicObject.name : "主要对话";
            const currentAgentName = agentConfigForSummary.name || 'AI';

            if (existingTopicTitle === "主要对话" || existingTopicTitle.startsWith("新话题")) {
                if (messageRenderer && typeof messageRenderer.summarizeTopicFromMessages === 'function') {
                    const titleContext=await prepareNativeDeletion(electronAPI,{itemType:'agent',itemId:currentSelectedItem.id,topicId:currentTopicId});
                    if(titleContext.pendingMode||titleContext.name&&titleContext.name!==existingTopicTitle)return;
                    const summarizedTitle = await messageRenderer.summarizeTopicFromMessages(currentChatHistory.filter(m => !m.isThinking), currentAgentName);
                    if (summarizedTitle) {
                        if(currentSelectedItemRef.get()?.id!==currentSelectedItem.id||currentTopicIdRef.get()!==currentTopicId)return;
                        const saveResult = await electronAPI.saveAgentTopicTitle(currentSelectedItem.id, currentTopicId, summarizedTitle,nativeDeletionOptions(titleContext));
                        if (saveResult.success) {
                            // 标题已保存到文件，现在更新内存中的对象以立即反映更改
                            if (currentTopicObject) {
                                currentTopicObject.name = summarizedTitle;
                            }
                            if (document.getElementById('tabContentTopics').classList.contains('active')) {
                                if (topicListManager) topicListManager.loadTopicList();
                            }
                        } else {
                            console.error(`[TopicSummary] Failed to save new topic title "${summarizedTitle}":`, saveResult.error);
                        }
                    }
                } else {
                    console.error('[TopicSummary] summarizeTopicFromMessages function is not defined or not accessible via messageRenderer.');
                }
            }
        } catch (error) {
            console.error('[TopicSummary] Error during attemptTopicSummarizationIfNeeded:', error);
        }
    }

    function createRequestTextOptions(agentConfig, history, currentUserMessageId) {
        const rules = Array.isArray(agentConfig?.stripRegexes) ? agentConfig.stripRegexes : [];
        const depths = buildTurnDepthMap(history);
        return {
            transformMessageText: ({ text, message }) => {
                if (message.id === currentUserMessageId || !depths.has(message.id)) return text;
                return applyRegexRules(text, rules, 'context', message.role, depths.get(message.id));
            },
            postProcessMessageContent: async ({ content: parts, message }) => {
                if (message.id !== currentUserMessageId
                    || !parts.some(part => part?.type === 'text' && part.text.includes(CANVAS_PLACEHOLDER))) return parts;
                let replacement;
                try {
                    const canvas = await electronAPI.getLatestCanvasContent();
                    replacement = canvas && !canvas.error
                        ? `\n[Canvas Content]\n${canvas.content || ''}\n[Canvas Path]\n${canvas.path || 'No file path'}\n[Canvas Errors]\n${canvas.errors || 'No errors'}\n`
                        : '\n[Canvas content could not be loaded]\n';
                } catch (error) {
                    console.error('Error fetching canvas content:', error);
                    replacement = '\n[Error loading canvas content]\n';
                }
                return updateFirstTextPart(parts, text => text.replaceAll(CANVAS_PLACEHOLDER, replacement));
            },
        };
    }
    async function executionAuthority(scope) {
        const result = await electronAPI.getTopicExecutionAuthority?.(scope);
        if (!result?.success || !['local', 'shared'].includes(result.kind)) {
            throw Object.assign(new Error(result?.error || '话题执行归属尚未确认，草稿已保留'), {
                code: result?.code || 'TOPIC_EXECUTION_AUTHORITY_UNKNOWN',
            });
        }
        return result;
    }

    const sharedRegenerations = new Map();
    const regenerationKey = ({ itemType, itemId, topicId }) => JSON.stringify([itemType, itemId, topicId]);
    function getSharedRegenerationInterruptTarget() {
        return sharedRegenerations.get(regenerationKey(currentCompactionScope()))?.interruptTarget || null;
    }

    async function regenerateSharedReply(descriptor, original) {
        const { itemId, itemType, topicId } = descriptor;
        const targetMessage = structuredClone(original);
        const itemGeneration = itemSelectionGeneration;
        const topicGeneration = topicSelectionGeneration;
        const selectedItem = currentSelectedItemRef.get();
        const isCurrent = () => !disposed && itemSelectionGeneration === itemGeneration
            && topicSelectionGeneration === topicGeneration
            && currentSelectedItemRef.get()?.id === itemId && currentSelectedItemRef.get()?.type === itemType
            && currentTopicIdRef.get() === topicId;
        const failure = code => Object.assign(new Error(code), { code });
        const key = regenerationKey(descriptor);
        if (sharedRegenerations.has(key)) throw failure('SHARED_REGENERATION_IN_PROGRESS');
        const operation = {};
        sharedRegenerations.set(key, operation);
        let replyId;
        let publicationStarted = false;
        try {
            const authority = await executionAuthority(descriptor);
            if (!isCurrent()) return { handled: true };
            const visibleTarget = currentChatHistoryRef.get().find(message => message.id === targetMessage.id);
            if (!visibleTarget || messagePreconditionValue(visibleTarget) !== messagePreconditionValue(targetMessage)) {
                throw failure('SHARED_REGENERATION_TARGET_CHANGED');
            }
            if (authority.kind === 'local') return { handled: false };
            if (visibleTarget.isThinking || visibleTarget.isPendingStream || visibleTarget.contextCompaction
                || !effectiveContextHistory(currentChatHistoryRef.get()).includes(visibleTarget)) {
                throw failure('SHARED_REGENERATION_TARGET_UNAVAILABLE');
            }
            if (isContextCompacting(descriptor)) throw failure('SHARED_REGENERATION_COMPACTING');
            const settings = globalSettingsRef.get();
            if (!settings.vcpServerUrl) throw failure('VCP_SERVER_URL_REQUIRED');
            if (typeof electronAPI.prepareSharedSend !== 'function') throw failure('SHARED_SEND_UNAVAILABLE');
            const modelSaveRef = window.ComposerModelSaveBarrier?.capture(itemId);
            if (modelSaveRef) await window.ComposerModelSaveBarrier.wait(modelSaveRef);
            if (!isCurrent()) return { handled: true };
            const prepared = await electronAPI.prepareSharedSend({
                descriptor, kind: 'regenerate', targetId: targetMessage.id, targetMessage,
                message: { id: `regenerate_${crypto.randomUUID()}`, role: 'user', content: '' },
                ...(modelSaveRef ? { modelSaveRef } : {}),
            });
            if (prepared?.success === false) throw failure(prepared.error || 'SHARED_SEND_UNAVAILABLE');
            if (!prepared?.handled || prepared.turn?.kind !== 'regenerate' || prepared.turn.targetId !== targetMessage.id
                || !prepared.replyId || !Array.isArray(prepared.history)) throw failure('SHARED_REGENERATION_RECEIPT_INVALID');
            replyId = prepared.replyId;
            if (isCurrent()) uiHelper.showToastNotification('共享回复正在重新生成', 'info');

            const orderedHistory = orderSharedHistory(prepared.history);
            const targetIndex = orderedHistory.findIndex(message => message.id === targetMessage.id);
            if (targetIndex < 0) throw failure('SHARED_REGENERATION_TARGET_CHANGED');
            const history = orderedHistory.slice(0, targetIndex);
            const user = prepared.userMessage;
            const agentConfig = { ...(selectedItem.config || selectedItem), ...prepared.config };
            const context = {
                agentId: itemId, itemType, topicId, isGroupMessage: false, sharedRegeneration: true,
                agentName: selectedItem.name, avatarUrl: selectedItem.avatarUrl,
                avatarColor: (selectedItem.config || selectedItem).avatarCalculatedColor,
            };
            const request = await singleChatRequestOrchestrator.buildRequest({
                sharedTopic: true,
                settings: { ...settings, ...prepared.executionPolicy },
                tavernRules: prepared.tavernRules, agentConfig, history, messageId: replyId, context,
                currentUserMessage: user,
                ...createRequestTextOptions(agentConfig, history, user?.id),
            });
            if (typeof interruptCapability?.interrupt === 'function') {
                operation.interruptTarget = {
                    ...descriptor, id: replyId, role: 'assistant',
                    interrupt(notify) {
                        if (operation.interruptPending || !operation.interruptTarget) return false;
                        operation.interruptPending = true;
                        return Promise.resolve(interruptCapability.interrupt(replyId)).then(result => {
                            notify?.(result?.success ? '已发送中止信号。' : '停止尚未确认，请查看任务状态。', result?.success ? 'info' : 'warning');
                            return result?.success === true;
                        }).finally(() => { operation.interruptPending = false; });
                    },
                };
                notifySendStateChanged();
            }
            const result = await singleChatRequestOrchestrator.sendPrepared(request, settings);
            operation.interruptTarget = null;
            notifySendStateChanged();
            const choice = result?.response?.choices?.[0];
            if (!choice?.message || typeof choice.message.content !== 'string' || !choice.message.content.trim()
                || result.response.nativeFailure || result.response.error
                || !['stop', 'length', 'tool_calls', 'function_call'].includes(choice.finish_reason)) {
                throw failure(result?.errorCode || result?.response?.nativeFailure?.code || 'SHARED_REGENERATION_NO_TERMINAL');
            }
            publicationStarted = true;
            await historyMutationAuthority.append({
                ...descriptor, category: 'regeneration-terminal', requestId: replyId,
            }, {
                role: 'assistant', id: replyId, content: choice.message.content,
                name: request.context.agentName, avatarUrl: context.avatarUrl, avatarColor: context.avatarColor,
                timestamp: Date.now(), finishReason: choice.finish_reason,
                ...(user?.id ? { replyToMessageId: user.id } : {}),
            });
            if (isCurrent()) {
                try { await syncHistoryFromFile(itemId, itemType, topicId, isCurrent); }
                catch (error) { console.warn('[NativeSync] Regeneration history refresh failed', error); }
            }
            return { handled: true };
        } catch (error) {
            if (publicationStarted) {
                throw Object.assign(new Error('SHARED_REGENERATION_PUBLICATION_UNCONFIRMED', { cause: error }), {
                    code: error?.code || error?.message,
                    publicationUnconfirmed: true,
                });
            }
            if (replyId) {
                await electronAPI.noteSharedSendFailure?.({ descriptor, requestId: replyId, code: error.code })
                    .catch(failureError => console.warn('[NativeSync] Regeneration status could not be confirmed', failureError));
            }
            throw error;
        } finally {
            sharedRegenerations.delete(key);
            notifySendStateChanged();
        }
    }

    async function handleSendMessage(request = null) {
        // 兼容渲染 Surface 的文本发送能力。AI 消息快捷按钮等调用方只提交
        // 一段独立文本；将其规范化为请求对象，避免错误回退到主输入框草稿，
        // 同时禁止把输入框中尚未发送的附件混入快捷消息。
        if (typeof request === 'string') {
            request = {
                content: request,
                attachments: [],
                propagateError: true,
            };
        }

        const { messageInput } = elements;
        const renderTarget = request?.domRenderer || messageRenderer;
        // The send gesture owns this generation. Its asynchronous projections
        // cannot re-enable following after the user scrolls in the meantime.
        const sendScrollGeneration = request?.conversation ? undefined : uiHelper.captureChatScrollFollow?.().generation;
        const input = request?.input || messageInput;
        const initialDraftToken = !request ? mainDrafts?.capture() : null;
        if(initialDraftToken&&!initialDraftToken.ok)return;
        let content = typeof request?.content === 'string' ? request.content : input.value; // Use let as it might be modified
        const attachedFiles = Array.isArray(request?.attachments) ? request.attachments : attachedFilesRef.get();
        const sendSelectedItemRef = request?.conversation?.selectedItemRef || currentSelectedItemRef;
        const sendTopicIdRef = request?.conversation?.topicIdRef || currentTopicIdRef;
        const sendHistoryRef = request?.conversation?.historyRef || currentChatHistoryRef;
        const currentSelectedItem = sendSelectedItemRef.get();
        const currentTopicId = sendTopicIdRef.get();
        const globalSettings = globalSettingsRef.get();
        const notifySendState = request?.conversation ? () => {} : notifySendStateChanged;
        const sendContext = {
            agentId: currentSelectedItem.id,
            itemType: currentSelectedItem.type || 'agent',
            agentName: currentSelectedItem.name || currentSelectedItem.id,
            topicId: currentTopicId,
            isGroupMessage: currentSelectedItem.type === 'group',
            avatarUrl: currentSelectedItem.avatarUrl,
            avatarColor: (currentSelectedItem.config || currentSelectedItem)?.avatarCalculatedColor
        };
        const isSendContextCurrent = () => {
            if (request?.conversation && request.conversation.isActive?.() === false) return false;
            const activeItem = sendSelectedItemRef.get();
            return activeItem?.id === sendContext.agentId
                && activeItem?.type === sendContext.itemType
                && sendTopicIdRef.get() === sendContext.topicId;
        };

        if (!content && attachedFiles.length === 0) return;
        if (!currentSelectedItem.id || !currentTopicId) {
            const error = new Error('请先选择一个项目和话题。');
            if (!request?.conversation) uiHelper.showToastNotification(error.message, 'error');
            if (request?.propagateError) throw error;
            return;
        }


        let sendAuthority;
        try {
            sendAuthority = await executionAuthority({ itemId: sendContext.agentId, itemType: sendContext.itemType, topicId: sendContext.topicId });
            if (sendAuthority.kind === 'shared' && typeof electronAPI.prepareSharedSend !== 'function') throw new Error('共享受理能力不可用');
            if (sendAuthority.kind === 'shared' && (request?.checkpointMessageId || (sendContext.itemType !== 'agent' && !(sendContext.itemType === 'group' && !request)))) {
                throw Object.assign(new Error('此共享话题暂不支持该本地推进入口'), { code: 'SHARED_LOCAL_ADVANCE_UNSUPPORTED' });
            }
        } catch (error) {
            uiHelper.showToastNotification(`尚未发送，草稿已保留：${error.message}`, 'warning');
            if (request?.propagateError) throw error;
            return;
        }
        if (!isSendContextCurrent()) return;

        if (currentSelectedItem.type === 'group' && !globalSettings.vcpServerUrl) {
            const error = new Error('请先在全局设置中配置 VCP 服务器 URL。');
            if (!request?.conversation) {
                uiHelper.showToastNotification(error.message, 'error');
                uiHelper.openModal('globalSettingsModal');
            }
            if (request?.propagateError) throw error;
            return;
        }

        if (currentSelectedItem.type === 'group') {
            if (request?.conversation) {
                const error = new Error('独立群聊尚未接入 Surface-owned 群组 operation');
                if (request.propagateError) throw error;
                return;
            }
            if (groupRenderer && typeof groupRenderer.handleSendGroupMessage === 'function') {
                setNextUiEmptyStateActive(false);
                await groupRenderer.handleSendGroupMessage(
                    currentSelectedItem.id,
                    currentTopicId,
                    { text: content, attachments: attachedFiles.map(af => ({ type: af.file.type, src: af.localPath, name: af.originalName, size: af.file.size })) },
                    globalSettings.userName || '用户'
                );
            } else {
                uiHelper.showToastNotification("群聊功能模块未加载，无法发送消息。", 'error');
            }
            // Group renderer owns draft clearing after its accepted submission.
            // messageInput.focus();
            return;
        }

        // --- Standard Agent Message Sending ---
        const sendSignature = `${sendContext.agentId}:${sendContext.topicId}`;
        if (isContextCompacting({ itemId: sendContext.agentId, itemType: sendContext.itemType, topicId: sendContext.topicId })) {
            uiHelper.showToastNotification('上下文正在压缩，请等待完成后再发送', 'warning');
            return;
        }
        if (pendingSendContexts.has(sendSignature)) {
            uiHelper.showToastNotification('该话题已有消息正在启动，请稍候。', 'warning');
            return;
        }
        pendingSendContexts.add(sendSignature);
        const pendingControl = !request ? {phase:'preparing',cancelled:false} : null;
        if(pendingControl)pendingSendControls.set(sendSignature,pendingControl);
        notifySendState();
        const isSideConversation = Boolean(request?.conversation);
        const markTopicRead = async () => {
            if (isSideConversation) return;
            try { await electronAPI.setTopicUnread(sendContext.agentId, sendContext.topicId, false); }
            catch (error) { console.warn('[ChatManager] Mark read failed:', error); }
            try {
                if (typeof itemListManager?.refreshUnreadCounts === 'function') await itemListManager.refreshUnreadCounts();
                else if (itemListManager) await itemListManager.loadItems();
            } catch (error) { console.warn('[ChatManager] Unread refresh failed:', error); }
        };
        if (sendAuthority.kind === 'shared') void markTopicRead();

        const stopPendingSend = async (submission = null) => {
            if(!pendingControl?.cancelled)return false;
            if(submission?.handled){
                try {
                    const result=await electronAPI.abandonSharedSend({descriptor:{itemType:sendContext.itemType||'agent',itemId:sendContext.agentId,topicId:sendContext.topicId},requestId:submission.userMessage.id,confirmed:true,undispatchedOnly:true});
                    if(result?.success===false)throw Error(result.error);
                    uiHelper.showToastNotification('已停止本次回复，已接收的消息保留。','info');
                }catch {
                    uiHelper.showToastNotification('已停止本机后续派发；原请求状态仍需核对，不会自动重发。','warning');
                }
            }else uiHelper.showToastNotification('已停止后续发送，输入或本机待发消息已保留。','info');
            window.dispatchEvent(new Event('native-sync:local-input-changed'));return true;
        };

        let stopNativeDraftObservation;
        let clearPendingUserProjection = () => {};
        let pendingProjectionMessageId = null;
        let pendingUserSeed = null;
        let promotePendingUserProjection = () => false;
        let promoteReadyUserProjection = () => false;
        let nativeDraftEdited = false;
        const nativeDraftItemGeneration = itemSelectionGeneration;
        const nativeDraftTopicGeneration = topicSelectionGeneration;
        const shouldPrepareNative = sendAuthority.kind === 'local' && !request && !attachedFiles.length
            && currentSelectedItem.type !== 'group' && typeof electronAPI.prepareNativeConversation === 'function';
        try {
        // Unread persistence and prepare can both outlive this draft.
        // Observe before either await, and detach in the send finalizer.
        if (shouldPrepareNative) {
            const markDraftEdited = () => { nativeDraftEdited = true; };
            input.addEventListener?.('input', markDraftEdited);
            stopNativeDraftObservation = () => input.removeEventListener?.('input', markDraftEdited);
        }
        if (Number.isFinite(request?.deadline) && Date.now() >= request.deadline) throw new Error('主窗口请求已过期，消息未发送');
        // Clearing unread can fence History writes while the config transaction runs.
        if (sendAuthority.kind === 'local') {
            await markTopicRead();
            if (await stopPendingSend()) return;
        }
        // Project the local send immediately. It is deliberately absent from
        // authoritative history until native/shared admission has succeeded.
        if (!request && renderTarget) {
            const reusableText = !attachedFiles.length;
            const restored = reusableText && restoredLocalInput?.descriptor?.itemId === sendContext.agentId
                && restoredLocalInput.descriptor.topicId === sendContext.topicId
                && restoredLocalInput.message.content === content ? restoredLocalInput.message : null;
            pendingUserSeed = reusableText ? (restored || { id: initialDraftToken?.inputId || `msg_${Date.now()}_user_${Math.random().toString(36).slice(2, 9)}`, timestamp: Date.now() }) : null;
            const pendingId = pendingUserSeed?.id || `pending_${Date.now()}_${Math.random().toString(36).slice(2)}`;
            const itemGeneration = itemSelectionGeneration, topicGeneration = topicSelectionGeneration;
            let retired = false, node = null, promoted = null, renderFinished = false, pendingRender = Promise.resolve();
            const releaseOwnership = () => {
                if (pendingUserProjections.get(pendingProjectionMessageId)?.clear === clearPendingUserProjection) pendingUserProjections.delete(pendingProjectionMessageId);
            };
            const applyPromotion = () => {
                if (!node) return;
                node.removeAttribute('inert'); node.removeAttribute('aria-busy');
                delete node.dataset.pendingSend;
                node.dataset.vcpInitialLoad = 'false';
                node.querySelector('[data-local-send-status]')?.remove();
                node._vcpMessageModel = promoted;
                const name = node.querySelector('.sender-name');
                if (name) name.textContent = promoted.name || globalSettings.userName || '用户';
            };
            promoteReadyUserProjection = message => {
                if (!renderFinished || !node?.isConnected || !pendingUserSeed || retired || !isSendContextCurrent()
                    || itemGeneration !== itemSelectionGeneration || topicGeneration !== topicSelectionGeneration
                    || message.id !== pendingId || message.role !== 'user' || message.content !== content
                    || message.timestamp !== pendingUserSeed.timestamp || message.attachments?.length) {
                    clearPendingUserProjection(); return false;
                }
                promoted = message;
                node ||= elements.chatMessagesDiv?.querySelector(`[data-message-id="${pendingId}"]`);
                applyPromotion(); releaseOwnership(); return true;
            };
            promotePendingUserProjection = async message => {
                await pendingRender;
                return promoteReadyUserProjection(message);
            };
            clearPendingUserProjection = () => {
                releaseOwnership();
                if (promoted) return;
                retired = true;
                node?.remove?.();
                elements.chatMessagesDiv?.querySelector(`[data-message-id="${pendingId}"]`)?.remove();
            };
            try {
                pendingRender = Promise.resolve(renderTarget.renderMessage({ id: pendingId, role: 'user', name: globalSettings.userName || '用户', content,
                    timestamp: pendingUserSeed?.timestamp || Date.now(), transient: true,
                    attachments: attachedFiles.map(af => ({ type: af.file.type, src: af.localPath, name: af.originalName, size: af.file.size, _fileManagerData: af._fileManagerData }))
                }, true)).then(element => {
                    renderFinished = true;
                    node = element;
                    if (retired || !isSendContextCurrent() || itemGeneration !== itemSelectionGeneration || topicGeneration !== topicSelectionGeneration) { node?.remove?.(); return; }
                    if (promoted) { applyPromotion(); return; }
                    node?.setAttribute?.('inert', '');
                    node?.setAttribute?.('aria-busy', 'true');
                    if (node) {
                        node.dataset.pendingSend = 'true';
                        const status = node.ownerDocument.createElement('span');
                        status.dataset.localSendStatus = 'true';
                        status.setAttribute('role', 'status'); status.textContent = ' · 正在准备发送…';
                        node.querySelector('.name-time-block')?.appendChild(status);
                        uiHelper.scrollToBottom?.({ force: true, expectedGeneration: sendScrollGeneration });
                    }
                }).catch(() => clearPendingUserProjection());
            } catch { clearPendingUserProjection(); }
        }
        let nativeResult = null;
        const modelSaveRef = !request ? window.ComposerModelSaveBarrier?.capture(sendContext.agentId) : null;
        if (shouldPrepareNative) {
            try { nativeResult = await electronAPI.prepareNativeConversation({text:content,conversationId:`${currentSelectedItem.id}:${currentTopicId}`}); }
            catch { nativeResult={handled:true,ok:false,code:'NATIVE_TRANSPORT_UNAVAILABLE'}; }
        }
        if(await stopPendingSend())return;
        // Prepare cannot dispatch the business operation. Stop before history/draft
        // consumption on rejection; leave the current input and attachments untouched.
        // Execute failures below keep their existing unknown-result/recovery semantics.
        if (nativeResult?.handled && nativeResult.ok === false) {
            uiHelper.showToastNotification(nativeResult.message || `尚未发送：${nativeResult.code || '预检失败'}。草稿已保留，请检查连接后手动重试。`, 'warning');
            return { handled: true, ok: false, code: nativeResult.code };
        }
        if (!nativeResult?.handled && !globalSettings.vcpServerUrl) {
            const error = new Error('请先在全局设置中配置 VCP 服务器 URL。');
            if (!request?.conversation) {
                uiHelper.showToastNotification(error.message, 'error');
                uiHelper.openModal('globalSettingsModal');
            }
            if (request?.propagateError) throw error;
            return;
        }
        if (!request?.conversation) setNextUiEmptyStateActive(false);
        if (sendAuthority.kind === 'local' && !nativeResult?.handled && !request?.checkpointMessageId && globalSettings.enableContextCompaction === true
            && shouldCompactContext(sendHistoryRef.get(), currentSelectedItem.config || currentSelectedItem, content)) {
            try {
                const preview = summarizeCompactionInput(sendHistoryRef.get());
                const previewDetail = `${preview.sourceCount} 条历史 · ${preview.anchors} 个标识符锚点`
                    + (preview.openWindows ? ` · ${preview.openWindows} 个未决窗口` : '');
                uiHelper.showToastNotification(`上下文接近容量，自动压缩中：${previewDetail}`, 'warning');
                await compactContext({
                    scope: { itemId: sendContext.agentId, itemType: sendContext.itemType, topicId: sendContext.topicId },
                    historyRef: sendHistoryRef, selectedRef: sendSelectedItemRef, topicRef: sendTopicIdRef,
                    renderTarget, allowPendingSend: true,
                });
                if (!isSendContextCurrent()) return;
            } catch (error) {
                uiHelper.showToastNotification(`自动压缩失败，草稿已保留：${error.message}`, 'error');
                if (request?.propagateError) throw error;
                return;
            }
        }
        if (Number.isFinite(request?.deadline) && Date.now() >= request.deadline) throw new Error('主窗口请求已过期，消息未发送');
        const uiAttachments = [];
        if (attachedFiles.length > 0) {
            for (const af of attachedFiles) {
                const fileManagerData = af._fileManagerData || {};
                uiAttachments.push({
                    type: fileManagerData.type || af.file.type,
                    src: af.localPath,
                    name: af.originalName,
                    size: af.file.size,
                    _fileManagerData: fileManagerData
                });
            }
        }

        const existingCheckpoint = request?.checkpointMessageId
            ? sendHistoryRef.get().find(message => message.id === request.checkpointMessageId && isContextCheckpoint(message))
            : null;
        if (request?.checkpointMessageId && (!existingCheckpoint
            || sendHistoryRef.get().at(-1)?.id !== existingCheckpoint.id)) {
            throw new Error('压缩快照后已有新消息，已取消重复接续');
        }
        let userMessage = existingCheckpoint || {
            role: 'user',
            name: globalSettings.userName || '用户',
            content: content, // Use raw content for UI
            timestamp: pendingUserSeed?.timestamp || Date.now(),
            id: nativeResult?.sourceId || pendingUserSeed?.id || `msg_${Date.now()}_user_${Math.random().toString(36).substring(2, 9)}`,
            attachments: uiAttachments
        };
        
        if (sendAuthority.kind === 'local' && !nativeResult?.handled && !request?.conversation && !request?.checkpointMessageId
            && typeof electronAPI.topicAdmissionSubmit === 'function') {
            try {
                const accepted = await submitTopicAdmissionWithRecovery(electronAPI, {
                    scope: {
                        itemId: sendContext.agentId,
                        itemType: 'agent',
                        topicId: sendContext.topicId,
                    },
                    message: userMessage,
                    requestId: userMessage.id,
                    triggerPolicy: 'reply',
                });
                if (!accepted?.success) {
                    throw new Error(accepted?.error || accepted?.code || '消息暂挂失败');
                }
                clearPendingUserProjection();
                if (isSendContextCurrent() && input.value === content
                    && !nativeDraftEdited && itemSelectionGeneration === nativeDraftItemGeneration
                    && topicSelectionGeneration === nativeDraftTopicGeneration
                    && (request || attachedFilesRef.get() === attachedFiles)) {
                    if (!request) {
                        input.value = '';
                        mainDrafts?.consumed(initialDraftToken);
                        attachedFilesRef.set([]);
                        mainRendererFunctions.updateAttachmentPreview?.();
                        uiHelper.autoResizeTextarea(input);
                    }
                }
                notifySendState();
                return accepted;
            } catch (error) {
                if (isSendContextCurrent()) {
                    if (error.code === 'TOPIC_ADMISSION_NOT_CONFIRMED') {
                        uiHelper.showToastNotification('原提交结果尚未确认，草稿已保留。请先核对当前话题。', 'warning');
                    } else {
                        uiHelper.showToastNotification(`发送失败，草稿已保留：${error.message}`, 'error');
                    }
                }
                if (request?.propagateError) throw error;
                return;
            }
        }


        if (!request && restoredLocalInput?.descriptor?.itemId === sendContext.agentId
            && restoredLocalInput.descriptor.topicId === sendContext.topicId
            && restoredLocalInput.message.content === content && !uiAttachments.length) {
            userMessage = {...restoredLocalInput.message};
        }
        if (!request) {
            pendingProjectionMessageId = userMessage.id;
            pendingUserProjections.set(userMessage.id, { ...sendContext, clear: clearPendingUserProjection, promote: promoteReadyUserProjection });
        }
        let locallySaved = false;
        // An immutable text intent is fsynced locally before releasing this input.
        // Attachments and native business operations retain their existing path.
        if (sendAuthority.kind === 'shared' && !sendAuthority.core && !request && !nativeResult?.handled && !uiAttachments.length && typeof electronAPI.prepareSharedSend === 'function') {
            try {
                const saved = await electronAPI.prepareSharedSend({localOnly:true,descriptor:{itemId:sendContext.agentId,itemType:sendContext.itemType||'agent',topicId:sendContext.topicId},message:userMessage,...(modelSaveRef?{modelSaveRef}:{})});
                if (saved?.success === false) throw new Error(saved.error || 'LOCAL_SAVE_FAILED');
                locallySaved = saved?.handled === true && saved.localState === 'saved';
                if (locallySaved) { mainDrafts?.consumed(initialDraftToken); window.dispatchEvent(new Event('native-sync:local-input-changed')); }
                if (locallySaved && isSendContextCurrent() && !nativeDraftEdited
                    && nativeDraftItemGeneration === itemSelectionGeneration && nativeDraftTopicGeneration === topicSelectionGeneration
                    && input.value === content && attachedFilesRef.get() === attachedFiles) {
                    messageInput.value = ''; restoredLocalInput = null;
                    uiHelper.autoResizeTextarea(messageInput); notifySendState();
                }
            } catch (error) {
                uiHelper.showToastNotification(`本机保存失败，输入仍保留：${error.message}`, 'error'); return;
            }
        }
        if(await stopPendingSend())return;
        if (!nativeResult?.handled && modelSaveRef) {
            try { await window.ComposerModelSaveBarrier.wait(modelSaveRef); }
            catch(error) { uiHelper.showToastNotification('模型保存未确认，消息保留在本机，尚未发送。','warning'); return; }
        }
        let sharedSubmission = request?.sharedSubmission || null;
        const sharedFlowlock = window.flowlockManager?.captureSharedSession?.(sendContext.agentId,sendContext.topicId);
        if (sendAuthority.kind === 'shared' && !sharedSubmission && typeof electronAPI.prepareSharedSend === 'function') {
            const projectionLease = !request && sendContext.itemType === 'agent' && !userMessage.attachments?.length
                ? beginSharedProjection(sendContext.agentId, sendContext.topicId, userMessage.id) : null;
            try {
                const result = await electronAPI.prepareSharedSend({serverSession:true,descriptor:{itemId:sendContext.agentId,itemType:sendContext.itemType||'agent',topicId:sendContext.topicId},message:userMessage,...(modelSaveRef?{modelSaveRef}:{})});
                if (result?.success === false) throw Object.assign(new Error(result.error),{code:result.error});
                if (!result?.handled) throw Object.assign(new Error('共享受理能力不可用'), {code:'SHARED_SEND_UNAVAILABLE'});
                if (result?.handled) { sharedSubmission={...result,history:result.core?result.history:orderSharedHistory(result.history)};userMessage=result.userMessage;if(result.projectionPending){sharedPendingUserIds.add(userMessage.id);historySyncGeneration++;} }
                if (projectionLease) {
                    if (result?.handled && result.projectionPending === true) observeSharedProjection(projectionLease);
                    else settleSharedProjection(projectionLease, true);
                }
            } catch(error) {
                if (projectionLease) settleSharedProjection(projectionLease, true);
                const attachmentFailure = ({
                    MODEL_IMAGE_UNSUPPORTED: '当前模型未在共享空间启用图片输入。',
                    ATTACHMENT_TYPE_REJECTED: '共享服务无法接收此附件格式。',
                    ATTACHMENT_TEXT_UNAVAILABLE: '附件中没有可供会话读取的文本。',
                    ATTACHMENT_TEXT_TOO_LARGE: '附件提取的文本超出长度限制。',
                })[error.code];
                if (locallySaved || attachmentFailure) window.dispatchEvent(new Event('native-sync:local-input-changed'));
                const reason = ({SHARED_CONFIG_CONFLICT:'当前模型或共享配置尚未确认。',SHARED_CONFIG_PENDING_CONFIRMATION:'模型保存回执尚未确认。',SHARED_RESULT_REQUIRES_REVIEW:'原请求的执行结果需要核对。',SHARED_TOPIC_BUSY:'上一条请求尚未结束。',NETWORK_UNAVAILABLE:'连接中断，提交结果尚未确认。'})[error.code] || '本次提交尚未完成。';
                uiHelper.showToastNotification(attachmentFailure ? `${attachmentFailure}草稿已保留。`
                    : locallySaved ? `消息已保存在本机。${reason} 可在下方恢复原消息；新草稿不会被覆盖。`
                        : `尚未发送，草稿已保留：${error.code||error.message}`, 'warning');
                if(request?.propagateError)throw error;return;
            }
        }
        if (sendAuthority.kind === 'shared' && !sharedSubmission) throw Object.assign(new Error('共享受理能力不可用'), {code:'SHARED_SEND_UNAVAILABLE'});
        if(sharedSubmission?.userMessage)userMessage=sharedSubmission.userMessage;
        if(await stopPendingSend(sharedSubmission))return;
        if (locallySaved) window.dispatchEvent(new Event('native-sync:local-input-changed'));
        await promotePendingUserProjection(userMessage);
        const optimisticHistory = sharedSubmission ? sharedSubmission.history : existingCheckpoint ? [...sendHistoryRef.get()] : [...sendHistoryRef.get(), userMessage];
        if (isSendContextCurrent()) {
            sendHistoryRef.set(optimisticHistory);
        }
        let userMessageItem = null;
        if (renderTarget && !existingCheckpoint) {
            userMessageItem = await renderTarget.renderMessage(userMessage, false, true, null, { scrollGeneration: sendScrollGeneration });
        }
        if (!isSendContextCurrent()) {
            // renderMessage targets the shared chat container. If selection
            // changed while it awaited, retract the stale DOM projection;
            // the message still belongs to and is saved in its source topic.
            userMessageItem?.remove?.();
        }

        // Save history with the user message before adding the thinking message or making API calls
        let sendHistory;
        try {
            if (Number.isFinite(request?.deadline) && Date.now() >= request.deadline) throw new Error('主窗口请求已过期，消息未发送');
            sendHistory = sharedSubmission ? sharedSubmission.history : existingCheckpoint
                ? [...sendHistoryRef.get()]
                : await persistOutgoingUserMessage(sendContext, userMessage);
        } catch (error) {
            // The draft is consumed only after the durable write succeeds. If
            // persistence fails, retract the optimistic projection and leave
            // the initiating input/attachments available for retry.
            if (isSendContextCurrent()) {
                sendHistoryRef.set(
                    sendHistoryRef.get().filter(message => message?.id !== userMessage.id)
                );
                userMessageItem?.remove?.();
                notifySendState();
                if (!request?.conversation) uiHelper.showToastNotification(`发送失败，草稿已保留: ${error.message}`, 'error');
            }
            console.error('[ChatManager] Failed to persist outgoing message:', error);
            if (request?.propagateError) throw error;
            return;
        }

        // Notify local send owners only after their outgoing message was saved.
        // Observer failures must not turn an accepted message into a retry.
        if (typeof request?.onAccepted === 'function') {
            try {
                request.onAccepted(Object.freeze({
                    messageId: userMessage.id,
                    context: Object.freeze({ agentId: sendContext.agentId, itemType: sendContext.itemType, topicId: sendContext.topicId }),
                }));
            } catch (error) {
                console.warn('[ChatManager] Send acceptance observer failed:', error?.message || error);
            }
        }

        // Consume only the exact draft transaction that was durably saved.
        // Both the text and attachment-array identity must still match, so an
        // attachment added while the save was pending cannot be discarded.
        const consumeDraft = () => {
        if (
            !request?.preserveComposer && isSendContextCurrent()
            && input.value === content
            && (request || attachedFilesRef.get() === attachedFiles)
        ) {
            if (!request) {
                messageInput.value = '';
                attachedFilesRef.set([]);
                if (mainRendererFunctions.updateAttachmentPreview) mainRendererFunctions.updateAttachmentPreview();
                if (isCanvasWindowOpen) messageInput.value = CANVAS_PLACEHOLDER;
                uiHelper.autoResizeTextarea(messageInput);
            }
        }

        };
        if (!locallySaved && (!nativeResult?.handled || !nativeResult.sourceId)) { consumeDraft(); if(!request)mainDrafts?.consumed(initialDraftToken); }


        if(await stopPendingSend(sharedSubmission))return;

        if (nativeResult?.handled) {
            const hadSource = !!nativeResult.sourceId;
            if(pendingControl){pendingControl.phase='dispatched';notifySendState();}
            try { if (hadSource) nativeResult = await electronAPI.executeNativeConversation({sourceId:nativeResult.sourceId}); }
            catch { nativeResult={code:'RESULT_UNKNOWN',message:'结果暂未确认，请查原操作回执，不要重复提交。'}; }
            if (hadSource && !nativeDraftEdited
                && nativeDraftItemGeneration === itemSelectionGeneration
                && nativeDraftTopicGeneration === topicSelectionGeneration
                && !(nativeResult.dispatched === false && nativeResult.preserveInput === true)) consumeDraft();
            const content = nativeResult.committed
                ? `已完成操作，并已读回确认。操作编号：${nativeResult.operationId || '请查询原回执'}。${nativeResult.chart?.ok ? '图表已更新。' : nativeResult.chart?.retryPending===true ? '图表刷新暂未完成，正在恢复。' : nativeResult.chart ? '图表刷新未完成。' : ''}`
                : (nativeResult.reconciliation?.length
                    ? `已进入派发的操作未取消，请勿重复提交；请核对原回执：${nativeResult.reconciliation.map(r => `${r.operationId || '原操作'}（${r.committed ? '已确认完成' : '待核对'}）`).join('、')}。`
                    : nativeResult.message || (nativeResult.cancelled ? '已取消待确认方案。' : `尚未完成：${nativeResult.code || '等待进一步说明'}`));
            const reply = {id:`native_${Date.now()}_${Math.random().toString(36).slice(2)}`,role:'assistant',content,timestamp:Date.now(),name:currentSelectedItem.name};
            let historySaved = true;
            try { await persistOutgoingUserMessage(sendContext, reply); }
            catch {
                historySaved = false;
                reply.content += '\n聊天记录保存失败；以上业务结果不变，请勿重复提交原操作。';
            }
            let displayed = false;
            if (isSendContextCurrent()) {
                try {
                    if (renderTarget?.renderMessage) {
                        const replyElement = await renderTarget.renderMessage(reply);
                        displayed = isSendContextCurrent();
                        if (!displayed) replyElement?.remove?.();
                    }
                }
                catch { /* Delivery failure must not turn a confirmed operation into a retry. */ }
            }
            if (!displayed || !historySaved) {
                uiHelper.showToastNotification(`话题 ${sendContext.topicId}：${reply.content}`, historySaved ? 'info' : 'warning');
            }
            return nativeResult;
        }
        if (sharedSubmission?.serverSession) {
            const bound=!sharedSubmission.core && window.flowlockManager?.bindSharedExecution?.(sharedFlowlock,{
                executionId:sharedSubmission.serverSession.executionId,requestId:userMessage.id,messageId:sharedSubmission.replyId,
            });
            if(bound&&typeof electronAPI.getNativeExecutionStatus==='function'){
                // A terminal may arrive before the acceptance receipt. Read the
                // original status after binding; this never dispatches a model.
                try{await window.flowlockManager.handleSharedSessionStatus(await electronAPI.getNativeExecutionStatus(sendContext.agentId,'agent',sendContext.topicId,false));}
                catch(error){console.error('[ChatManager] shared Flowlock status unavailable',error.code||error.message);}
            }
            notifySendState();
            return {handled:true,serverSession:sharedSubmission.serverSession,messageId:sharedSubmission.replyId};
        }
        const thinkingMessageId = sharedSubmission?.replyId || `msg_${Date.now()}_assistant_${Math.random().toString(36).substring(2, 9)}`;
        const thinkingMessage = {
            role: 'assistant',
            name: currentSelectedItem.name || currentSelectedItem.id || 'AI', // 修复：使用 ID 作为更可靠的回退
            content: '思考中',
            timestamp: Date.now(),
            id: thinkingMessageId,
            isThinking: true,
            replyToMessageId: userMessage.id,
            agentId: sendContext.agentId,
            topicId: sendContext.topicId,
            context: sendContext,
            avatarUrl: currentSelectedItem.avatarUrl,
            avatarColor: (currentSelectedItem.config || currentSelectedItem)?.avatarCalculatedColor
        };

        let thinkingMessageItem = null;
        let releaseStreamConsumerRoute = null;
        let settleOwnedStreamOperation = null;
        let ownedStreamSettled = false;
        const ownedStreamTerminal = request?.awaitTerminal
            ? new Promise(resolve => { settleOwnedStreamOperation = resolve; })
            : null;
        if (renderTarget && isSendContextCurrent()) {
            thinkingMessageItem = await renderTarget.renderMessage(thinkingMessage);
            if (!isSendContextCurrent()) {
                thinkingMessageItem?.remove?.();
                thinkingMessageItem = null;
            } else if (thinkingMessageItem && !request?.conversation) {
                uiHelper.scrollToBottom?.({ force: true, expectedGeneration: sendScrollGeneration });
            }
        }
        if (isSendContextCurrent()) {
            sendHistoryRef.set(insertAfterMessage(
                sendHistoryRef.get(),
                userMessage.id,
                thinkingMessage
            ));
            notifySendState();
        }
        const removeThinkingFromSource = async () => {
            releaseStreamConsumerRoute?.();
            releaseStreamConsumerRoute = null;
            renderTarget?.discardStreaming?.(thinkingMessage.id);
            try {
                const sourceHistory = await getHistory(sendContext.agentId, sendContext.itemType || 'agent', sendContext.topicId);
                if (!Array.isArray(sourceHistory)) return null;
                let cleanedHistory = sourceHistory.filter(message => message.id !== thinkingMessage.id);
                if (!sharedSubmission && cleanedHistory.length !== sourceHistory.length) {
                    const commit = await mutateHistory(
                        sendContext.agentId, sendContext.itemType || 'agent', sendContext.topicId,
                        current => current.filter(message => message.id !== thinkingMessage.id),
                        { category: 'remove-thinking-message', deleteIds: [thinkingMessage.id] }
                    );
                    cleanedHistory = [...commit.history];
                }
                if (isSendContextCurrent()) {
                    sendHistoryRef.set(
                        sendHistoryRef.get().filter(message => message?.id !== thinkingMessage.id)
                    );
                    if (typeof renderTarget?.removeMessage === 'function') await renderTarget.removeMessage(thinkingMessage.id);
                    else await renderTarget?.removeMessageById?.(thinkingMessage.id);
                    notifySendState();
                }
                return cleanedHistory;
            } catch (cleanupError) {
                console.error('[ChatManager] Failed to clean owned thinking message:', cleanupError);
                if (isSendContextCurrent()) {
                    sendHistoryRef.set(
                        sendHistoryRef.get().filter(message => message?.id !== thinkingMessage.id)
                    );
                    if (typeof renderTarget?.removeMessage === 'function') await renderTarget.removeMessage(thinkingMessage.id);
                    else await renderTarget?.removeMessageById?.(thinkingMessage.id);
                    notifySendState();
                }
                return null;
            }
        };
        const releaseDelegationPreview = async () => {
            await removeThinkingFromSource();
            // The verified child report can arrive while we retire the parent's
            // placeholder. Keep an already-published generation in the view.
            const saved = await getHistory(sendContext.agentId, sendContext.itemType, sendContext.topicId);
            if (!isSendContextCurrent() || !Array.isArray(saved)) return;
            const paused = saved.find(row => row.id === thinkingMessage.id && row.finishReason === 'interrupted');
            if (paused) {
                sendHistoryRef.set(saved);
                await renderTarget?.renderMessage?.(paused);
            }
        };

        const cancelPreparedSend = async () => {
            await removeThinkingFromSource();
            const terminal = { event: { type: 'cancelled', reason: request.signal.reason || 'surface-operation-cancelled' } };
            settleOwnedStreamOperation?.(terminal);
            return Object.freeze({ messageId: thinkingMessage.id, terminal });
        };

        try {
            // 独立 Surface 可在历史落盘或请求准备期间取消，尚未发出的请求不再交给上游。
            if (request?.signal?.aborted) return await cancelPreparedSend();
            if(await stopPendingSend(sharedSubmission)) { await removeThinkingFromSource(); return; }
            const agentConfig = sharedSubmission ? {...(currentSelectedItem.config||currentSelectedItem),...sharedSubmission.config} : (currentSelectedItem.config || currentSelectedItem);
            const extraContextHistory = typeof request?.conversation?.getContextHistory === 'function'
                ? (request.conversation.getContextHistory() || [])
                : (Array.isArray(request?.contextHistory) ? request.contextHistory : []);
            const historySnapshotForVCP = [
                ...extraContextHistory,
                ...sendHistory.filter(msg => !msg.isThinking)
            ];
            const requestTextOptions = createRequestTextOptions(agentConfig, historySnapshotForVCP, userMessage.id);
            const orchestrated = await singleChatRequestOrchestrator.buildRequest({
                sharedTopic: sendAuthority.kind === 'shared',
                settings: sharedSubmission ? {...globalSettings,...sharedSubmission.executionPolicy} : globalSettings,
                ...(sharedSubmission ? {tavernRules:sharedSubmission.tavernRules} : {}),
                agentConfig,
                history: historySnapshotForVCP,
                messageId: thinkingMessage.id,
                context: sendContext,
                currentUserMessageId: userMessage.id,
                ...requestTextOptions,
                buildMessageContent: buildDefaultMessageContent,
            });
            const useStreaming = orchestrated.modelConfig.stream === true;
            if (request?.signal?.aborted) return await cancelPreparedSend();
            if(await stopPendingSend(sharedSubmission)) { await removeThinkingFromSource(); return; }

            if (useStreaming) {
                if (messageRenderer) {
                    const startOwnedStreamProjection = message => (
                        renderTarget.startStreaming || messageRenderer.startStreamingMessage
                    ).call(renderTarget, message, thinkingMessageItem);
                    releaseStreamConsumerRoute = streamConsumerRegistry?.register?.(thinkingMessage.id, {
                        kind: request?.domRenderer ? 'independent-surface' : 'main-chat',
                        discardPending: releaseDelegationPreview,
                        start: startOwnedStreamProjection,
                        ...(request?.domRenderer ? {
                            append: (messageId, chunk, streamContext) => request.domRenderer.appendStreaming(messageId, chunk, streamContext),
                            projectTerminal: (messageId, finishReason, streamContext, payload) => request.domRenderer.projectStreamTerminal(messageId, finishReason, streamContext, payload),
                        } : {}),
                        settle: result => {
                            ownedStreamSettled = true;
                            settleOwnedStreamOperation?.(result);
                        },
                        release: () => {
                            releaseStreamConsumerRoute?.();
                            releaseStreamConsumerRoute = null;
                        },
                    });
                    if (request?.domRenderer?.own && releaseStreamConsumerRoute?.retract) {
                        request.domRenderer.own(() => releaseStreamConsumerRoute?.retract?.());
                    }
                    request?.onOperation?.(Object.freeze({
                        messageId: thinkingMessage.id,
                        done: ownedStreamTerminal,
                        async cancel(reason) {
                            // 上游接受中止时由流自己收尾；失败时也先等待本地流
                            // 保存已接收内容，不能把正在收尾的回答当占位消息删掉。
                            let interrupted = null;
                            try { interrupted = await interruptCapability?.interrupt?.(thinkingMessage.id); }
                            catch (error) { console.warn('[ChatManager] Surface interrupt request failed; cancelling locally:', error); }
                            // 上游接受了中止却一直不发终态时，不能让侧聊一直忙着：等一会儿仍没收尾就在本地停
                            if (interrupted?.success === true && (!ownedStreamTerminal || await settlesWithin(ownedStreamTerminal, INTERRUPT_SETTLE_MS))) return true;
                            // 中止请求可能要等好几秒，期间回答已经自己收尾（路由随之释放）；
                            // 这时它是一条完整或已停止的回答，不能再当占位删掉
                            if (ownedStreamSettled) return true;
                            const res = await releaseStreamConsumerRoute?.cancel?.(reason || 'surface-operation-cancelled');
                            if (res?.kind || ownedStreamSettled) return true;
                            settleOwnedStreamOperation?.({ event: { type: 'cancelled', reason: reason || 'surface-operation-cancelled' } });
                            await removeThinkingFromSource();
                            return res !== false;
                        },
                    }));

                    // 在请求交给上游之前发布本地流所有权。过去这里一直等首个
                    // agent_thinking/start IPC 才初始化 StreamProjection；在这段空窗内切换
                    // 话题时，渐进历史渲染只能读到已落盘的 user 消息，尚未持久化的 assistant
                    // 占位既不在活动流快照中，也无法由 reconcileConversation 恢复。
                    // 提前初始化后，呼吸框、返回会话恢复和发送/中止按钮共享同一运行态真源。
                    await startOwnedStreamProjection({
                        ...thinkingMessage,
                        ...orchestrated.context,
                        context: orchestrated.context,
                        content: '',
                        isThinking: true,
                    });
                    notifySendState();
                }
            } else {
                request?.onOperation?.(Object.freeze({
                    messageId: thinkingMessage.id,
                    done: ownedStreamTerminal,
                    async cancel(reason) {
                        // 非流式请求在主进程里没有本地中止，上游卡住时中止请求本身也会卡住：
                        // 先在本地收尾、放开输入框，再尽力通知上游，不等它
                        await removeThinkingFromSource();
                        settleOwnedStreamOperation?.({ event: { type: 'cancelled', reason: reason || 'surface-operation-cancelled' } });
                        Promise.resolve()
                            .then(() => interruptCapability?.interrupt?.(thinkingMessage.id))
                            .catch(error => console.warn('[ChatManager] Non-streaming interrupt failed; cancelled locally:', error));
                        return true;
                    },
                }));
            }

            const context = orchestrated.context;
            if (request?.signal?.aborted) return await cancelPreparedSend();
            if(await stopPendingSend(sharedSubmission)) { await removeThinkingFromSource(); return; }
            if(pendingControl){pendingControl.phase='dispatched';notifySendState();}
            const sending = singleChatRequestOrchestrator.sendPrepared(
                orchestrated,
                globalSettings
            );
            // 非流式回答停止后就不再等：服务卡住时主进程的请求可能几分钟都不返回，输入框不能一直锁着；
            // 迟到的回答直接丢掉，不再写进已经停止的这一轮
            const settledFirst = !useStreaming && ownedStreamTerminal
                ? await Promise.race([sending.then(() => false, () => false), ownedStreamTerminal.then(() => true)])
                : false;
            if (settledFirst) {
                sending.catch(() => {});
                return Object.freeze({ messageId: thinkingMessage.id, terminal: await ownedStreamTerminal });
            }
            const vcpResponse = await sending;

            // 主动停止可使尚未收到首字的 IPC 请求以错误返回；已有取消操作负责
            // 收尾，不把这次本地 Abort 再渲染成服务端失败。
            if (vcpResponse?.streamError && request?.signal?.aborted && ownedStreamTerminal) {
                return Object.freeze({ messageId: thinkingMessage.id, terminal: await ownedStreamTerminal });
            }

            if (!useStreaming) {
                const response = vcpResponse?.response ?? vcpResponse;
                const responseContext = vcpResponse?.context ?? context;
                const activeSelectedItem = sendSelectedItemRef.get();
                const activeTopicId = sendTopicIdRef.get();

                // Determine if the response is for the currently active chat
                const isForActiveChat = responseContext && responseContext.agentId === activeSelectedItem.id && responseContext.topicId === activeTopicId;

                 if (isForActiveChat) {
                     // Remove the placeholder through the initiating Surface;
                     // an internal Surface must never mutate the main root.
                     if (typeof renderTarget?.removeMessage === 'function') await renderTarget.removeMessage(thinkingMessage.id);
                     else renderTarget?.removeMessageById?.(thinkingMessage.id);
                 }

                if (vcpResponse?.awaitingNativeTask) {
                    await releaseDelegationPreview();
                    settleOwnedStreamOperation?.({ event: { type:'cancelled', reason:'awaiting_native_task' } });
                    return { handled:true, awaitingNativeTask:true, messageId:thinkingMessage.id };
                }
                if (vcpResponse?.pausedWorkMessage?.id === thinkingMessage.id) {
                    const saved = await getHistory(sendContext.agentId, sendContext.itemType, sendContext.topicId);
                    if (isSendContextCurrent() && Array.isArray(saved)) {
                        sendHistoryRef.set(saved);
                        await renderTarget?.renderMessage?.(vcpResponse.pausedWorkMessage);
                    }
                    settleOwnedStreamOperation?.({ event: { type: 'cancelled', reason: 'WORK_SAFE_TOOL_BOUNDARY' } });
                    return { handled: true, paused: true, messageId: thinkingMessage.id };
                }
                if (!response) {
                    throw new Error('VCP returned an empty response.');
                }

                if (response.error) {
                    await removeThinkingFromSource();
                    settleOwnedStreamOperation?.({ event: { type: 'failed', outcome: { transport: { error: response.error } } } });
                    if (isForActiveChat && renderTarget) {
                        renderTarget.renderMessage({ role: 'system', notice: 'error', content: `VCP错误: ${response.error}`, timestamp: Date.now() });
                    }
                    console.error(`[ChatManager] VCP Error for background message:`, response.error);
                    if (request?.propagateError) throw Object.assign(new Error(String(response.error)), { shownInChat: true });
                } else if (response.choices && response.choices.length > 0) {
                    const assistantMessageContent = response.choices[0].message.content;
                    const assistantMessage = {
                        role: 'assistant',
                        name: responseContext?.agentName || responseContext?.agentId || 'AI', // 修复：使用 context 中的 agentName 或 agentId 作为回退
                        avatarUrl: responseContext?.avatarUrl || sendContext.avatarUrl,
                        avatarColor: responseContext?.avatarColor || sendContext.avatarColor,
                        content: assistantMessageContent,
                        timestamp: Date.now(),
                        id: sharedSubmission?.replyId || `msg_${Date.now()}_assistant_${Math.random().toString(36).substring(2, 9)}`, ...(sharedSubmission ? {replyToMessageId:userMessage.id} : {})
                    };

                    // Fetch the correct history from the file, update it, and save it back.
                    const historyForSave = await getHistory(responseContext.agentId, responseContext.itemType || 'agent', responseContext.topicId);
                    let persistenceError = null;
                    if (historyForSave && !historyForSave.error) {
                        if (sharedSubmission?.nativeFinalReadback) {
                            // The response is an observation. The main process reads the
                            // published operation and projects its current Journal version.
                            const commit = await historyMutationAuthority.append({
                                itemId: responseContext.agentId, itemType: sendContext.itemType,
                                topicId: responseContext.topicId, category: 'non-stream-reply', requestId: thinkingMessage.id,
                            }, assistantMessage);
                            const receipt = commit.result?.authoritativeReply;
                            if (!receipt) throw new Error('共享终稿仍待核对');
                            await projectSharedFinal(responseContext, thinkingMessage.id);
                            settleOwnedStreamOperation?.({ event: { type: 'completed' } });
                            return { handled: true, messageId: thinkingMessage.id, seq: receipt.seq };
                        }
                        // Remove any lingering 'thinking' message and add the new one
                        let finalHistory = historyForSave.filter(msg => msg.id !== thinkingMessage.id);
                        finalHistory.push(assistantMessage);
                        
                        // Save the final, complete history to the correct file
                        try {
                            const commit = await mutateHistory(
                                responseContext.agentId, responseContext.itemType || 'agent', responseContext.topicId,
                                current => [...current.filter(msg => msg.id !== thinkingMessage.id), assistantMessage],
                                { category: 'non-stream-reply', ...(sharedSubmission ? {requestId:thinkingMessage.id,causalKnown:context.nativeCausalContext?.known===true,causalContextIds:context.nativeCausalContext?.dependsOnMessageIds||[],deleteIds:historyForSave.filter(m=>m.id===thinkingMessage.id&&(m.isThinking||m.isPendingStream)).map(m=>m.id)} : {deleteIds:[thinkingMessage.id]}) }
                            );
                            finalHistory = [...commit.history];
                            const finalSave = commit.result;
                            if (finalSave?.success === false || finalSave?.error) persistenceError = finalSave.error || '保存聊天记录失败';
                        } catch (error) {
                            // Keep the visible reply available for retry when durable storage rejects.
                            persistenceError = error?.message || '保存聊天记录失败';
                        }

                        if (isForActiveChat) {
                            // If it's the active chat, also update the UI and in-memory state
                            sendHistoryRef.set(finalHistory);
                            notifySendState();
                            if (renderTarget) renderTarget.renderMessage(assistantMessage);
                            if (!request?.conversation) await attemptTopicSummarizationIfNeeded();
                        } else {
                            console.log(`[ChatManager] Saved non-streaming response for background chat: Agent ${responseContext.agentId}, Topic ${responseContext.topicId}`);
                        }
                    } else {
                         console.error(`[ChatManager] Failed to get history for background save:`, historyForSave?.error);
                         persistenceError = historyForSave?.error || '读取聊天记录失败';
                    }
                    settleOwnedStreamOperation?.({ event: persistenceError
                        ? { type: 'failed', outcome: { persistence: { error: persistenceError } } }
                        : { type: 'completed' } });
                } else {
                    await removeThinkingFromSource();
                    settleOwnedStreamOperation?.({ event: { type: 'failed', outcome: { transport: { error: 'Unknown response format' } } } });
                    if (isForActiveChat && renderTarget) {
                        renderTarget.renderMessage({ role: 'system', notice: 'error', content: 'VCP 返回了未知格式的响应。', timestamp: Date.now() });
                    }
                }
            } else {
                if (vcpResponse && vcpResponse.streamError) {
                    console.error("Streaming setup failed in main process:", vcpResponse.errorDetail || vcpResponse.error);
                    await removeThinkingFromSource();
                    settleOwnedStreamOperation?.({ event: { type: 'failed', outcome: { transport: { error: vcpResponse.error } } } });
                    if (isSendContextCurrent() && renderTarget) {
                        renderTarget.renderMessage({ role: 'system', notice: 'error', content: `请求流式回复失败: ${vcpResponse.error || '未知错误'}`, timestamp: Date.now() });
                    }
                    if (request?.propagateError) throw Object.assign(new Error(String(vcpResponse.error || '流式回复失败')), { shownInChat: true });
                } else if (vcpResponse && !vcpResponse.streamingStarted && !vcpResponse.streamError) {
                    console.warn("Expected streaming to start, but main process returned non-streaming or error:", vcpResponse);
                    await removeThinkingFromSource();
                    settleOwnedStreamOperation?.({ event: { type: 'failed', outcome: { transport: { error: 'Expected streaming to start' } } } });
                    if (isSendContextCurrent() && renderTarget) {
                        renderTarget.renderMessage({ role: 'system', notice: 'error', content: '请求流式回复失败，收到非流式响应或错误。', timestamp: Date.now() });
                    }
                    if (request?.propagateError) throw Object.assign(new Error('请求流式回复失败，收到非流式响应或错误'), { shownInChat: true });
                }
            }

            if (request?.awaitTerminal && ownedStreamTerminal) {
                const terminal = await ownedStreamTerminal;
                return Object.freeze({ messageId: thinkingMessage.id, terminal });
            }
        } catch (error) {
            console.error('发送消息或处理VCP响应时出错', error);
            settleOwnedStreamOperation?.({ event: { type: 'failed', outcome: { transport: { error } } } });
            await removeThinkingFromSource();
            // 上面已经在对话里报过的错误（shownInChat）只是继续往调用方抛，不再补一条“错误: …”
            if (isSendContextCurrent() && renderTarget && !error?.shownInChat) {
                renderTarget.renderMessage({ role: 'system', notice: 'error', content: `错误: ${error.message}`, timestamp: Date.now() });
            }
            if (request?.propagateError) throw error;
        }
        } finally {
            clearPendingUserProjection();
            stopNativeDraftObservation?.();
            pendingSendContexts.delete(sendSignature);
            if(pendingSendControls.get(sendSignature)===pendingControl)pendingSendControls.delete(sendSignature);
            notifySendState();
        }
    }

    async function createNewTopicForItem(itemId, itemType) {
        if (!itemId) {
            uiHelper.showToastNotification("请先选择一个项目。", 'error');
            return;
        }

        if (itemType === 'agent' && window.flowlockManager?.isAgentLocked?.(itemId)) {
            uiHelper.showToastNotification('该 Agent 正在心流锁中，无法新建或切换话题。', 'warning');
            return;
        }
        
        const currentSelectedItem = currentSelectedItemRef.get();
        const creationToken = ++topicCreationGeneration;
        const creationItemGeneration = itemSelectionGeneration;
        const creationTopicGeneration = topicSelectionGeneration;
        const isCreationCurrent = () => {
            const activeItem = currentSelectedItemRef.get();
            return creationToken === topicCreationGeneration
                && creationItemGeneration === itemSelectionGeneration
                && creationTopicGeneration === topicSelectionGeneration
                && activeItem?.id === itemId
                && activeItem?.type === itemType;
        };
        const itemName = currentSelectedItem.name || (itemType === 'group' ? "当前群组" : "当前助手");
        const newTopicName = `新话题 ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
        
        try {
            let result;
            if (itemType === 'agent') {
                result = await electronAPI.createNewTopicForAgent(itemId, newTopicName);
            } else if (itemType === 'group') {
                result = await electronAPI.createNewTopicForGroup(itemId, newTopicName);
            }

            if (result && result.success && result.topicId) {
                // Topic creation is durable for its source item even if the
                // user navigates away, but a late completion must not seize
                // the newly selected conversation's UI or watcher.
                if (!isCreationCurrent()) return;
                const watcherLease = await beginHistoryWatcherOperation();
                if (!isCreationCurrent() || watcherLease?.stale || watcherLease?.success === false) return;
                currentTopicIdRef.set(result.topicId);
                currentChatHistoryRef.set([]);
                notifySelectionCommitted();
                notifySendStateChanged();

                if (messageRenderer) {
                    messageRenderer.setCurrentTopicId(result.topicId);
                    messageRenderer.clearChat();
                    // messageRenderer.renderMessage({ role: 'system', content: `新话题 "${result.topicName}" 已开始。`, timestamp: Date.now() });
                }
                localStorage.setItem(`lastActiveTopic_${itemId}_${itemType}`, result.topicId);
                
                // 🔧 关键修复：为新建的话题启动文件监听器
                const agentConfigForWatcher = currentSelectedItem.config || currentSelectedItem;
                if (electronAPI.watcherStart && agentConfigForWatcher?.agentDataPath) {
                    const historyFilePath = `${agentConfigForWatcher.agentDataPath}\\topics\\${result.topicId}\\history.json`;
                    const watcherResult = await startOwnedHistoryWatcher(
                        watcherLease.token || null,
                        historyFilePath,
                        itemId,
                        result.topicId
                    );
                    if (watcherResult?.stale || watcherResult?.success === false) return;
                    if (!isCreationCurrent() || currentTopicIdRef.get() !== result.topicId) return;
                    console.log(`[ChatManager] Started file watcher for new topic: ${result.topicId}`);
                }
                
                // Keep the list projection authoritative even when the topics
                // tab is currently hidden. Otherwise currentTopicId changes
                // while the old row remains highlighted until a later visit.
                if (topicListManager) await topicListManager.loadTopicList();
                
                await displayTopicTimestampBubble(itemId, itemType, result.topicId);
                // elements.messageInput.focus();
            } else {
                uiHelper.showToastNotification(`创建新话题失败: ${result ? result.error : '未知错误'}`, 'error');
            }
        } catch (error) {
            console.error(`创建新话题时出错:`, error);
            uiHelper.showToastNotification(`创建新话题时出错: ${error.message}`, 'error');
        }
    }


    async function handleCreateBranch(selectedMessage) {
        const currentSelectedItem = currentSelectedItemRef.get();
        const currentTopicId = currentTopicIdRef.get();

        if (currentSelectedItem?.type === 'agent' && window.flowlockManager?.isAgentLocked?.(currentSelectedItem.id)) {
            uiHelper.showToastNotification('该 Agent 正在心流锁中，无法创建并切换到分支话题。', 'warning');
            return;
        }
        const currentChatHistory = currentChatHistoryRef.get();
        const itemType = currentSelectedItem.type;

        if ((itemType !== 'agent' && itemType !== 'group') || !currentSelectedItem.id || !currentTopicId || !selectedMessage) {
            uiHelper.showToastNotification("无法创建分支：当前非 Agent/群组聊天或缺少必要信息。", 'error');
            return;
        }

        const messageId = selectedMessage.id;
        const messageIndex = currentChatHistory.findIndex(msg => msg.id === messageId);

        if (messageIndex === -1) {
            uiHelper.showToastNotification("无法创建分支：在当前聊天记录中未找到选定消息。", 'error');
            return;
        }

        const historyForNewBranch = currentChatHistory.slice(0, messageIndex + 1);
        if (historyForNewBranch.length === 0) {
            uiHelper.showToastNotification("无法创建分支：没有可用于创建分支的消息。", 'error');
            return;
        }

        try {
            let itemConfig, originalTopic, createResult, saveResult;
            const itemId = currentSelectedItem.id;

            if (itemType === 'agent') {
                itemConfig = await electronAPI.getAgentConfig(itemId);
            } else { // group
                itemConfig = await electronAPI.getAgentGroupConfig(itemId);
            }

            if (!itemConfig || itemConfig.error) {
                uiHelper.showToastNotification(`创建分支失败：无法获取${itemType === 'agent' ? '助手' : '群组'}配置。${itemConfig?.error || ''}`, 'error');
                return;
            }

            originalTopic = itemConfig.topics.find(t => t.id === currentTopicId);
            const originalTopicName = normalizeTopicTitle(originalTopic ? originalTopic.name : "未命名话题");
            const newBranchTopicName = `${originalTopicName} (分支)`;

            if (itemType === 'agent') {
                createResult = await electronAPI.createNewTopicForAgent(itemId, newBranchTopicName, true);
            } else { // group
                createResult = await electronAPI.createNewTopicForGroup(itemId, newBranchTopicName, true);
            }

            if (!createResult || !createResult.success || !createResult.topicId) {
                uiHelper.showToastNotification(`创建分支话题失败: ${createResult ? createResult.error : '未知错误'}`, 'error');
                return;
            }

            const newTopicId = createResult.topicId;

            saveResult = await saveHistory(itemId, itemType, newTopicId, historyForNewBranch);

            if (!saveResult || !saveResult.success) {
                uiHelper.showToastNotification(`无法将历史记录保存到新的分支话题: ${saveResult ? saveResult.error : '未知错误'}`, 'error');
                // Clean up empty branch topic
                if (itemType === 'agent') {
                    await electronAPI.deleteTopic(itemId, newTopicId);
                } else { // group
                    await electronAPI.deleteGroupTopic(itemId, newTopicId);
                }
                return;
            }

            currentTopicIdRef.set(newTopicId);
            if (messageRenderer) messageRenderer.setCurrentTopicId(newTopicId);
            
            if (document.getElementById('tabContentTopics').classList.contains('active')) {
                if (topicListManager) await topicListManager.loadTopicList();
            }
            await loadChatHistory(itemId, itemType, newTopicId);
            localStorage.setItem(`lastActiveTopic_${itemId}_${itemType}`, newTopicId);

            uiHelper.showToastNotification(`已成功创建分支话题 "${newBranchTopicName}" 并切换。`);

        } catch (error) {
            console.error("创建分支时发生错误:", error);
            uiHelper.showToastNotification(`创建分支时发生内部错误: ${error.message}`, 'error');
        }
    }

    async function handleForwardMessage(target, content, attachments) {
        const { messageInput } = elements;
        
        // 1. Find the target item's full config to select it
        let targetItemFullConfig;
        if (target.type === 'agent') {
            targetItemFullConfig = await electronAPI.getAgentConfig(target.id);
        } else {
            targetItemFullConfig = await electronAPI.getAgentGroupConfig(target.id);
        }

        if (!targetItemFullConfig || targetItemFullConfig.error) {
            uiHelper.showToastNotification(`转发失败: 无法获取目标配置。`, 'error');
            return;
        }

        // 2. Select the item. This will automatically handle finding the last active topic or creating a new one.
        await selectItem(target.id, target.type, target.name, targetItemFullConfig.avatarUrl, targetItemFullConfig);

        // 3. After a brief delay to allow the UI to update from selectItem, populate and send.
        const timer = setTimeout(async () => {
            forwardTimers.delete(timer);
            if (disposed) return;
            // 4. Populate the message input and attachments ref
            messageInput.value = content;
            
            const uiAttachments = attachments.map(att => ({
                file: { name: att.name, type: att.type, size: att.size },
                localPath: att.src,
                originalName: att.name,
                _fileManagerData: att._fileManagerData || {}
            }));
            attachedFilesRef.set(uiAttachments);
            
            // Manually trigger attachment preview update
            if (mainRendererFunctions.updateAttachmentPreview) {
                mainRendererFunctions.updateAttachmentPreview();
            }
            
            // Manually trigger textarea resize
            uiHelper.autoResizeTextarea(messageInput);

            // 5. Call the standard send message handler to trigger the full AI response flow
            await handleSendMessage();

        }, 200); // 200ms delay seems reasonable for UI transition
        forwardTimers.add(timer);
    }

    // --- Canvas Integration ---
    const CANVAS_PLACEHOLDER = '{{VCPChatCanvas}}';

    function handleCanvasContentUpdate(data) {
        if (disposed) return;
        isCanvasWindowOpen = true;
        const { messageInput } = elements;
        // If the canvas is open and there's content, ensure the placeholder is in the input
        if (!messageInput.value.includes(CANVAS_PLACEHOLDER)) {
            // Add a space for better formatting if the input is not empty
            const prefix = messageInput.value.length > 0 ? ' ' : '';
            messageInput.value += prefix + CANVAS_PLACEHOLDER;
            uiHelper.autoResizeTextarea(messageInput);
        }
    }

    function handleCanvasWindowClosed() {
        if (disposed) return;
        isCanvasWindowOpen = false;
        const { messageInput } = elements;
        // Remove the placeholder when the window is closed
        if (messageInput.value.includes(CANVAS_PLACEHOLDER)) {
            // Also remove any surrounding whitespace for cleanliness
            messageInput.value = messageInput.value.replace(new RegExp(`\\s*${CANVAS_PLACEHOLDER}\\s*`, 'g'), '').trim();
            uiHelper.autoResizeTextarea(messageInput);
        }
    }


    async function syncHistoryFromFile(itemId, itemType, topicId, ownershipGuard = () => true) {
        const syncGeneration = ++historySyncGeneration;
        const loadGeneration = activeHistoryLoadToken;
        const itemGeneration = itemSelectionGeneration;
        const topicGeneration = topicSelectionGeneration;
        const isSyncCurrent = () => {
            const selectedItem = currentSelectedItemRef.get();
            return !disposed
                && Boolean(messageRenderer)
                && ownershipGuard()
                && loadGeneration === activeHistoryLoadToken
                && syncGeneration === historySyncGeneration
                && itemGeneration === itemSelectionGeneration
                && topicGeneration === topicSelectionGeneration
                && selectedItem?.id === itemId
                && selectedItem?.type === itemType
                && currentTopicIdRef.get() === topicId;
        };
        if (!isSyncCurrent()) return;

        const deferWhileEditing = () => {
            if(!document.querySelector('.message-item-editing'))return false;
            deferredHistorySync={itemId,itemType,topicId,itemGeneration,topicGeneration};return true;
        };
        if(deferWhileEditing())return;

        // Capture active stream ownership before the async read. A stream may
        // reach terminal while the read is in flight; that terminal must not
        // be mistaken for a file-side deletion when the active id disappears.
        const activeStreamingIdAtRead = streamProjection?.getActiveStreamingMessageId?.() || null;

        // 1. Fetch the latest history from the file
        let newHistory;
        if (itemType === 'agent') {
            newHistory = await getHistory(itemId, itemType, topicId);
        } else if (itemType === 'group') {
            newHistory = await getHistory(itemId, itemType, topicId);
        }

        // A file notification may resolve after navigation, a newer sync, or
        // teardown. Only the still-selected conversation may update its view.
        if (!isSyncCurrent()) return;
        if(deferWhileEditing())return;

        if (!newHistory || newHistory.error) {
            console.error("Sync failed: Could not fetch new history.", newHistory?.error);
            return;
        }

        if (offlineHistoryNotice?.loadToken === loadGeneration) {
            messageRenderer.removeMessageById(offlineHistoryNotice.id, false);
            offlineHistoryNotice = null;
            if (newHistory.length === 0) setNextUiEmptyStateActive(true, 'empty-topic');
        }

        const oldHistory = currentChatHistoryRef.get();
        let historyInMem = [...oldHistory]; // Create a mutable copy to work with

        const oldHistoryMap = new Map(oldHistory.map(msg => [msg.id, msg]));
        const newHistoryMap = new Map(newHistory.map(msg => [msg.id, msg]));
        const activeStreamingId = streamProjection?.getActiveStreamingMessageId?.() || null;
        const protectedStreamingIds = new Set(
            [activeStreamingIdAtRead, activeStreamingId].filter(Boolean),
        );

        // --- Perform UI and Memory updates ---

        // 2. Handle DELETED and MODIFIED messages
        for (const oldMsg of oldHistory) {
            if (protectedStreamingIds.has(oldMsg.id)
                || (oldMsg.isThinking && oldMsg.admissionToken && !newHistoryMap.has(oldMsg.id))) {
                continue; // Active local placeholders are not file-side deletions.
            }
            
            const newMsgData = newHistoryMap.get(oldMsg.id);
            const isPendingGroupUserMessage = itemType === 'group'
                && oldMsg?.role === 'user'
                && groupRenderer?.isPendingUserMessage?.(oldMsg.id) === true;

            if (!newMsgData && isPendingGroupUserMessage) {
                // JEV 在用户消息首次写盘后会立即产生多轮编排写入。文件监听可能
                // 先读到写盘前的旧快照；这个快照无权删除仍由发送事务持有的用户气泡。
                continue;
            }

            if (sharedPendingUserIds.has(oldMsg.id)) {
                if (!newMsgData) continue;
                sharedPendingUserIds.delete(oldMsg.id);
            }
            if (!newMsgData) {
                // Message was DELETED from the file
                messageRenderer.removeMessageById(oldMsg.id, false); // Update UI
                const indexToRemove = historyInMem.findIndex(m => m.id === oldMsg.id);
                if (indexToRemove > -1) {
                    historyInMem.splice(indexToRemove, 1); // Update Memory
                }
            } else {
                if (isPendingGroupUserMessage) {
                    groupRenderer?.acknowledgePendingUserMessage?.(oldMsg.id);
                }
                // Message exists, check for MODIFICATION
                if (JSON.stringify(oldMsg.content) !== JSON.stringify(newMsgData.content)) {
                    if (typeof messageRenderer.updateMessageContent === 'function') {
                        messageRenderer.updateMessageContent(oldMsg.id, newMsgData.content); // Update UI
                    }
                    }
                if (oldMsg.attachments?.length || newMsgData.attachments?.length) {
                    const refreshed = messageRenderer.refreshMessageAttachments?.(newMsgData);
                    if (refreshed) {
                        await refreshed;
                        if (!isSyncCurrent()) return;
                    }
                }
                // Durable metadata can change without changing rendered text.
                const indexToUpdate = historyInMem.findIndex(m => m.id === oldMsg.id);
                if (indexToUpdate > -1) historyInMem[indexToUpdate] = newMsgData;
            }
        }

        // 3. Handle ADDED messages
        let messagesWereAdded = false;
        for (const newMsg of newHistory) {
            if (!oldHistoryMap.has(newMsg.id)) {
                // Hand over the owned temporary bubble before rendering the
                // same accepted identity delivered by the history watcher.
                const pending = pendingUserProjections.get(newMsg.id);
                if (pending?.agentId === itemId && pending.itemType === itemType && pending.topicId === topicId) pending.promote(newMsg);
                if (itemType === 'group') groupRenderer?.acknowledgePendingProjection?.(newMsg.id, itemId, topicId);
                // Message was ADDED
                messageRenderer.renderMessage(newMsg, true); // Update UI (true = don't modify history ref inside)
                historyInMem.push(newMsg); // Update Memory
                messagesWereAdded = true;
            }
        }

        // 4. If messages were added or removed, the order might be wrong. Re-sort.
        // Also ensures the streaming message (if any) is at the very end.
        historyInMem.sort((a, b) => {
            if (protectedStreamingIds.has(a.id)) return 1;
            if (protectedStreamingIds.has(b.id)) return -1;
            return a.timestamp - b.timestamp;
        });

        // 5. Commit the fully merged and sorted history back to the ref. This is the new source of truth.
        currentChatHistoryRef.set(historyInMem);

        // If messages were added, the DOM order might be incorrect. A full re-render is safest
        // but can cause flicker. For now, we accept this as the individual DOM operations
        // are faster. A subsequent topic load will fix any visual misordering.
        if (messagesWereAdded) {
             console.log('[Sync] New messages were added. DOM might require a refresh to be perfectly ordered.');
        }
    }



    async function dispose() {
        if (disposed) return;
        disposed = true;
        for (const lease of sharedProjectionLeases.values()) {
            if (lease.failed) lease.release = beginHistoryPersistence(lease.context) || (() => {});
            lease.release(true);
        }
        sharedProjectionLeases.clear();
        initialized = false;
        contextCompactionService?.dispose();
        for (const resolve of streamCompactionTerminalSignals.values()) resolve();
        streamCompactionTerminalSignals.clear();
        streamCompactionRequests.clear();
        for (const checking of streamBoundaryChecks.values()) checking.cancelled = true;
        streamBoundaryChecks.clear();
        itemSelectionGeneration += 1;
        topicSelectionGeneration += 1;
        topicCreationGeneration += 1;
        activeHistoryLoadToken += 1;
        historySyncGeneration += 1;
        pendingItemSelectionToken = null;
        emptyStateObserver?.disconnect();
        emptyStateObserver = null;
        editEventRoot?.removeEventListener('vcp:message-edit-ended', flushDeferredHistorySync);
        editEventRoot = null;
        canvasContentDisposer?.();
        canvasClosedDisposer?.();
        canvasContentDisposer = null;
        canvasClosedDisposer = null;
        for (const timer of forwardTimers) clearTimeout(timer);
        forwardTimers.clear();
        selectionListeners.clear();
        selectionIntentListeners.clear();
        await Promise.allSettled([
            lastOpenSaveQueue,
            ...outgoingPersistenceQueues.values(),
        ]);
        outgoingPersistenceQueues.clear();
        for (const pending of pendingUserProjections.values()) pending.clear();
        pendingUserProjections.clear();
        sharedPendingUserIds.clear(); mainDrafts?.dispose(); mainDrafts=null;
        pendingSendContexts.clear();
        for(const pending of pendingSendControls.values())pending.cancelled=true;
        pendingSendControls.clear();deferredHistorySync=null;
    }

    async function projectSharedFinal(context, messageId) {
        if (currentSelectedItemRef.get()?.type !== 'agent' || currentSelectedItemRef.get()?.id !== context.agentId ||
            currentTopicIdRef.get() !== context.topicId) return;
        // Retract the transient model bubble; the native History queue supplies
        // the current row (possibly edited or deleted) and its conversation order.
        if (!document.querySelector('.message-item-editing')) messageRenderer.removeMessageById(messageId, false);
        await syncHistoryFromFile(context.agentId, 'agent', context.topicId);
    }

    async function retryLocalInput({descriptor,inputId,modelSaveRef,errorCode}) {
        if (!modelSaveRef && errorCode === 'MODEL_IMAGE_UNSUPPORTED') {
            const currentModelSaveRef = window.ComposerModelSaveBarrier?.capture(descriptor.itemId);
            if (currentModelSaveRef) await window.ComposerModelSaveBarrier.wait(currentModelSaveRef);
        }
        let modelSaveResolutionRef;
        if(modelSaveRef){const saved=await electronAPI.confirmSharedModelSave({itemId:descriptor.itemId,reference:modelSaveRef});if(saved?.success===false)throw Object.assign(Error(saved.error),{code:saved.error});modelSaveResolutionRef=saved.reference;}
        const prepared=await electronAPI.retrySharedInput({descriptor,inputId,modelSaveResolutionRef});
        if(prepared?.success===false)throw Object.assign(Error(prepared.error),{code:prepared.error});
        return executePreparedShared({descriptor,prepared});
    }

    async function executePreparedShared({descriptor,prepared}) {
        if(!prepared?.handled||prepared.serverSession||prepared.inputAccepted)return prepared;
        const d=descriptor,item={id:d.itemId,type:d.itemType||'agent',name:prepared.config?.name||d.itemId,config:prepared.config};
        let history=orderSharedHistory(prepared.history);
        const isActive=()=>currentSelectedItemRef.get()?.id===d.itemId&&currentTopicIdRef.get()===d.topicId;
        const historyRef={get:()=>isActive()?currentChatHistoryRef.get():history,set:value=>{history=value;if(isActive())currentChatHistoryRef.set(value);}};
        const dom = {
            renderMessage: (...args) => isActive() ? messageRenderer.renderMessage(...args) : Promise.resolve(null),
            startStreamingMessage: (...args) => streamProjection.startStreamingMessage(...args),
            appendStreaming: (...args) => streamProjection.appendStreamChunk(...args),
            projectStreamTerminal: (...args) => streamProjection.projectStreamTerminal(...args),
            discardStreaming: id => streamProjection.discardStreamingMessage(id),
            removeMessageById: (...args) => isActive() ? messageRenderer.removeMessageById?.(...args) : undefined,
        };
        return handleSendMessage({content:prepared.userMessage.content,attachments:[],preserveComposer:true,sharedSubmission:{...prepared,history},domRenderer:dom,
            conversation:{selectedItemRef:{get:()=>item,set(){}},topicIdRef:{get:()=>d.topicId,set(){}},historyRef,isActive},propagateError:true});
    }

    // --- Public API ---
    return {
        init,
        dispose,
        isReady: () => initialized,
        isHistoryLoading: () => pendingHistoryLoadToken !== null && pendingHistoryLoadToken === activeHistoryLoadToken,
        selectItem,
        restoreLastOpenState,
        selectTopic,
        handleTopicDeletion,
        loadChatHistory,
        displayTopicTimestampBubble,
        handleSendMessage,
        regenerateSharedReply,
        getSharedRegenerationInterruptTarget,
        onSharedProjectionSettled,
        retryLocalInput,
        executePreparedShared,
        projectSharedFinal,
        getPendingSendState,
        cancelPendingSend,
        compactContext,
        isContextCompacting,
        cancelContextCompaction,
        prepareFlowlockContext,
        createRequestTextOptions,
        checkStreamContextBudget,
        hasStreamAdmissionRelay,
        cancelStreamAdmissionRelay,
        finishStreamAdmissionRelay,
        finishStreamContextCompaction,
        abandonStreamContextCompaction,
        sendMessage: handleSendMessage,
        createNewTopicForItem,
        displayNoItemSelected,
        syncNextUiEmptyStateWithMessages,
        attemptTopicSummarizationIfNeeded,
        handleCreateBranch,
        handleForwardMessage,
        removeAttachmentFromMessage,
        addAttachmentsToMessage,
        processFilesData,
        syncHistoryFromFile, // Expose the new function
        onSelectionChange(callback) {
            if (typeof callback === 'function') {
                selectionListeners.add(callback);
                return () => selectionListeners.delete(callback);
            }
            return () => {};
        },
        /** 选中话题时立刻回调（不等历史渲染完）；回调参数同 onSelectionChange */
        onSelectionIntent(callback) {
            if (typeof callback === 'function') {
                selectionIntentListeners.add(callback);
                return () => selectionIntentListeners.delete(callback);
            }
            return () => {};
        },
    };
})();

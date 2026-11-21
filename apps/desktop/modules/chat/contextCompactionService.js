import { effectiveContextHistory, prepareCompactionState } from './contextCompactionState.js';
import { readCompactionResponse } from './contextCompactionStream.js';
import { compactionSettings, buildCompactionMessages, createCheckpointMessage } from './contextCompactionPrompts.js';

const scopeKey = scope => `${scope.itemType || 'agent'}:${scope.itemId}:${scope.topicId}`;

/** Conservative local estimate, not a tokenizer count. Includes attachment text and metadata. */
export function estimateContextTokens(history, systemPrompt = '') {
    const text = systemPrompt + JSON.stringify(effectiveContextHistory(history));
    let cost = 0;
    for (const character of text) cost += character.codePointAt(0) > 127 ? 1 : 0.3;
    return Math.ceil(cost);
}

export function shouldCompactContext(history, agentConfig, pendingText = '') {
    const limit = Number(agentConfig?.contextTokenLimit);
    if (!Number.isFinite(limit) || limit <= 0) return false;
    const effective = effectiveContextHistory(history);
    if (!effective.length) return false;
    // A checkpoint alone cannot be compressed endlessly when diary retention exceeds the budget.
    if (effective.length === 1 && effective[0].contextCompaction) return false;
    return estimateContextTokens([...effective, { role: 'user', content: pendingText }], agentConfig.systemPrompt || '') >= limit * 0.85;
}

// Collect transport frames only. Heartbeats are not summary text, reasoning and
// tool metadata never become the checkpoint, and failure cannot commit a partial.
async function readCompactionStream(response, signal, fallbackModel) {
    const reader = response.body?.getReader?.();
    if (!reader) throw new Error('压缩流没有可读取的响应正文');
    const decoder = new TextDecoder();
    let buffer = '', content = '', refusal = '', finishReason = null, model = fallbackModel;
    let done = false, eof = false;
    const frame = text => {
        const data = text.split(/\r?\n/).filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).trimStart()).join('\n').trim();
        if (!data) return;
        if (data === '[DONE]') { done = true; return; }
        let value;
        try { value = JSON.parse(data); }
        catch { throw new Error('压缩流包含无效数据，未生成快照'); }
        if (value?.error) {
            const status = Number(value.error.status || value.error.code);
            throw new Error(Number.isInteger(status) && status >= 400 && status <= 599
                ? `上下文压缩请求失败（HTTP ${status}）`
                : '压缩服务器返回错误，未生成快照，请检查模型配置或服务端日志');
        }
        const choice = value?.choices?.[0];
        if (!choice) return;
        if (typeof value.model === 'string') model = value.model;
        const delta = choice.delta || {};
        if (typeof delta.content === 'string') content += delta.content;
        else if (Array.isArray(delta.content)) content += delta.content.filter(p => p?.type === 'text').map(p => p.text || '').join('');
        if (typeof delta.refusal === 'string') refusal += delta.refusal;
        if (choice.finish_reason) finishReason = choice.finish_reason;
    };
    const abort = () => { void reader.cancel().catch(() => {}); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
        signal?.throwIfAborted();
        while (!done) {
            const part = await reader.read();
            signal?.throwIfAborted();
            if (part.done) { eof = true; buffer += decoder.decode(); break; }
            buffer += decoder.decode(part.value, { stream: true });
            let separator;
            while (!done && (separator = /\r?\n\r?\n/.exec(buffer))) {
                frame(buffer.slice(0, separator.index));
                buffer = buffer.slice(separator.index + separator[0].length);
            }
        }
        if (!done && buffer.trim()) frame(buffer);
        signal?.throwIfAborted();
        if (!done && !finishReason) throw new Error('压缩流意外中断，未生成快照');
        return { model, choices: [{ message: { content, refusal }, finish_reason: finishReason }] };
    } finally {
        signal?.removeEventListener('abort', abort);
        if (!eof) void reader.cancel().catch(() => {});
        reader.releaseLock();
    }
}

export async function requestContextCompaction({ settings, state, signal, requestId, fetchImpl = globalThis.fetch, onResponse = () => {} }) {
    const config = compactionSettings(settings);
    if (!config.model) throw new Error('请先配置上下文压缩模型');
    const url = new URL(settings.vcpServerUrl);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('压缩服务器地址必须使用 HTTP 或 HTTPS');
    // Never use chatvcp endpoint: compression must not execute historical tool requests.
    url.pathname = url.pathname.replace(/\/chatvcp\/completions\/?$/, '/chat/completions');
    const response = await fetchImpl(url.href, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(settings.vcpApiKey ? { Authorization: `Bearer ${settings.vcpApiKey}` } : {}),
        },
        body: JSON.stringify({
            model: config.model,
            messages: buildCompactionMessages(state, settings),
            stream: true,
            ...(requestId ? { requestId } : {}),
        }),
        signal,
    });
    if (!response.ok) throw new Error(`上下文压缩请求失败（HTTP ${response.status}）`);
    return readCompactionResponse(response, { signal, model: config.model, onResponse });
}

/** Topic-owned busy state; commit and UI projection remain explicit injected capabilities. */
export function createContextCompactionService({
    historyMutationAuthority,
    request = requestContextCompaction,
    onBusyChanged = () => {},
    timeoutMs = 600000,
    flowlock = null,
    interruptRequest = null,
    sharedCompaction = globalThis.electronAPI,
    getExecutionAuthority = scope => globalThis.electronAPI?.getTopicExecutionAuthority?.(scope),
} = {}) {
    const pending = new Map();
    const retryPublications = new Map();
    let disposed = false;

    function isBusy(scope) {
        return Boolean(scope?.itemId && scope?.topicId && pending.has(scopeKey(scope)));
    }

    function cancel(scope) {
        if (!scope?.itemId || !scope?.topicId) return false;
        const controller = pending.get(scopeKey(scope));
        if (!controller || controller.signal.aborted || controller.committing) return false;
        // Same upstream Stop reply gateway; never wait for an unresponsive server
        // before revoking the local request and rejecting late model results.
        try {
            Promise.resolve(interruptRequest?.(controller.requestId)).catch(error =>
                console.warn('[ContextCompaction] Upstream interrupt failed:', error));
        } catch (error) {
            console.warn('[ContextCompaction] Upstream interrupt failed:', error);
        }
        controller.abort();
        return true;
    }

    async function compact({ scope, history, settings, onCommitted = () => {} }) {
        if (disposed) throw new Error('压缩服务已关闭');
        if (scope?.itemType !== 'agent') throw new Error('上下文压缩仅支持单聊');
        if (!historyMutationAuthority?.mutate) throw new Error('上下文压缩缺少历史写入权限');
        if (!compactionSettings(settings).enabled) throw new Error('请先开启上下文智能压缩');
        if (isBusy(scope)) throw new Error('当前话题正在压缩上下文');
        if (history.some(message => message?.isThinking)) throw new Error('请等待当前回复结束后再压缩');
        let authority;
        let snapshot = structuredClone(history);
        let state = prepareCompactionState(snapshot);
        if (!state.sourceCount) throw new Error('当前没有可压缩的上下文');
        const controller = new AbortController();
        controller.requestId = `compaction_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
        const key = scopeKey(scope);
        pending.set(key, controller);
        const notifyBusy = busy => {
            try { onBusyChanged(scope, busy); }
            catch (error) { console.error('[ContextCompaction] Busy projection failed:', error); }
        };
        let timer;
        let flowlockLease = null;
        let responseDiagnostic = null;
        let returnedContent;
        let shared;
        let committed = false;
        let recovered;
        try {
            const decision = getExecutionAuthority(scope);
            authority = typeof decision?.then === 'function' ? await decision : decision;
            if (!authority?.success || !['local', 'shared'].includes(authority.kind)) throw Object.assign(new Error(authority?.error || '话题执行归属尚未确认'), {code: authority?.code || 'TOPIC_EXECUTION_AUTHORITY_UNKNOWN'});
            if (disposed || controller.signal.aborted) throw new Error('上下文压缩已取消');
            flowlockLease = flowlock?.suspendForContextCompaction?.(scope.itemId, scope.topicId) || null;
            notifyBusy(true);
            const deadline = new Promise((_, reject) => {
                timer = setTimeout(() => {
                    controller.abort();
                    reject(new Error('上下文压缩超时，请重试'));
                }, timeoutMs);
                controller.signal.addEventListener('abort', () => reject(new Error('上下文压缩已取消')), { once: true });
            });
            const runRequest = async () => {
                const preparation = authority.kind === 'shared' && typeof sharedCompaction?.prepareSharedCompaction === 'function'
                    ? await sharedCompaction.prepareSharedCompaction({descriptor:scope, ...(retryPublications.has(key) && {retryId:retryPublications.get(key)})}) : null;
                if (authority.kind === 'shared' && !preparation?.handled) throw Object.assign(new Error(preparation?.error || '共享压缩协议不可用'), {code: preparation?.error || 'SHARED_COMPACTION_UNAVAILABLE'});
                if (preparation?.success === false) throw Object.assign(new Error(preparation.error), {code:preparation.error});
                if (preparation?.handled) {
                    if (preparation.recovered) {
                        if (!Array.isArray(preparation.history) || !preparation.message || preparation.message.id !== preparation.messageId)
                            throw new Error('共享压缩检查点回执不完整');
                        recovered = preparation;
                        return;
                    }
                    shared = preparation;
                    if (disposed || controller.signal.aborted) {
                        await sharedCompaction.cancelSharedCompaction({descriptor:scope,id:shared.id});
                        throw new Error('上下文压缩已取消');
                    }
                    snapshot = structuredClone(shared.history);
                    state = prepareCompactionState(snapshot);
                }
                return request({
                    settings, state, signal: controller.signal, requestId: controller.requestId,
                    onResponse: diagnostic => { responseDiagnostic = diagnostic; },
                });
            };
            const response = await Promise.race([
                runRequest(),
                deadline,
            ]);
            clearTimeout(timer); // The request deadline must not abort durable history persistence.
            if (disposed || controller.signal.aborted) throw new Error('上下文压缩已取消');
            returnedContent = response;
            const message = recovered?.message ?? createCheckpointMessage(state, response, settings, shared ? {id:shared.messageId} : {});
            const original = JSON.stringify(snapshot);
            const outcome = recovered ?? (shared ? await (async () => {
                controller.committing = true;
                retryPublications.set(key,shared.id);
                const value = await sharedCompaction.commitSharedCompaction({descriptor:scope,id:shared.id,sourceHash:shared.sourceHash,message});
                if(value?.success === false)throw Object.assign(new Error(value.error),{code:value.error});
                return value;
            })() : await historyMutationAuthority.mutate({
                ...scope, category: 'context-compaction', requireUnchangedHistory:true,
            }, current => {
                if (disposed || controller.signal.aborted) throw new Error('上下文压缩已取消');
                if (JSON.stringify(current) !== original) throw new Error('压缩期间历史已变化，请重新压缩');
                // Once the mutation has handed off to durable storage it cannot
                // safely be rolled back by aborting the network request.
                controller.committing = true;
                return [...current, message];
            }));
            committed = true;
            retryPublications.delete(key);
            // Durable success, not UI rendering, determines whether the heartbeat can resume.
            flowlock?.resumeAfterContextCompaction?.(flowlockLease);
            try { await onCommitted(outcome.history, message); }
            catch (error) { console.error('[ContextCompaction] Committed checkpoint projection failed:', error); }
            return { message, history: outcome.history, warnings: state.warnings };
        } catch (error) {
            if (responseDiagnostic || returnedContent !== undefined) {
                const content = responseDiagnostic?.content ?? returnedContent;
                const raw = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
                error.compactionDiagnostic = [
                    shared && controller.committing ? '共享检查点提交结果待核对，请重试「压缩前文」' : '上下文压缩失败诊断（原历史未修改）',
                    `模型：${responseDiagnostic?.model || compactionSettings(settings).model}`,
                    `服务端结束原因：${responseDiagnostic?.finishReason ?? '未提供'}`,
                    `失败原因：${error.message}`,
                    '',
                    '以下为模型返回正文原文，不是待压缩历史；不包含请求密钥：',
                    raw ?? '（无正文）',
                ].join('\n');
            }
            throw error;
        } finally {
            if (shared && !committed) {
                try { await sharedCompaction.cancelSharedCompaction({descriptor:scope,id:shared.id}); }
                catch { /* Preserve the durable preparation/publication for recovery. */ }
            }
            clearTimeout(timer);
            pending.delete(key);
            notifyBusy(false);
        }
    }

    return Object.freeze({
        isBusy,
        cancel,
        compact,
        dispose() {
            disposed = true;
            retryPublications.clear();
            for (const controller of pending.values()) controller.abort();
        },
    });
}

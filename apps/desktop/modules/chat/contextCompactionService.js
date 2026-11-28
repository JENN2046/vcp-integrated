import { effectiveContextHistory, isContextCheckpoint, prepareCompactionState } from './contextCompactionState.js';
import { assembleRequestMessages, buildDefaultMessageContent, normalizeAgentContextWindowSize } from './chatContextPipeline.js';
import { readCompactionResponse } from './contextCompactionStream.js';
import { compactionSettings, buildCompactionMessages, createCheckpointMessage } from './contextCompactionPrompts.js';

const scopeKey = scope => `${scope.itemType || 'agent'}:${scope.itemId}:${scope.topicId}`;

// 计数方式：以最近一条带上游用量的 assistant 为基准（上游实际计费的输入），
// 只对它及之后新增的内容做本地估算；没有用量时整段估算。
// 估算公式：汉字按 2 个字符、其余按 1 个字符计，再除以 3。
const ESTIMATED_TOKEN_CHAR_DIVISOR = 3;
const IMAGE_TOKEN_ESTIMATE = 765;
const IMAGE_ATTACHMENT = /^image\//i;

/** Local heuristic for text the provider has not counted yet. */
export function estimateTextTokens(text) {
    const source = String(text ?? '');
    if (!source) return 0;
    // Counted in a loop: a global regex match over megabytes of history allocates one string per character.
    let chineseChars = 0;
    for (let index = 0; index < source.length; index++) {
        const code = source.charCodeAt(index);
        if (code >= 0x4e00 && code <= 0x9fff) chineseChars++;
    }
    return Math.ceil((chineseChars + source.length) / ESTIMATED_TOKEN_CHAR_DIVISOR);
}

function estimateMessageTokens(message) {
    const content = message?.content;
    let text = '';
    let images = 0;
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) {
        for (const part of content) {
            if (typeof part === 'string') text += part;
            else if (part?.type === 'text') text += String(part.text ?? '');
            else if (part?.type === 'image_url') images += 1;
        }
    } else if (content != null) text = JSON.stringify(content);
    if (message?.contextCompaction?.checkpoint) text += message.contextCompaction.checkpoint;
    for (const attachment of Array.isArray(message?.attachments) ? message.attachments : []) {
        const data = attachment?._fileManagerData || attachment;
        text += `${attachment?.name || ''}${data?.extractedText || attachment?.extractedText || ''}`;
        const frames = data?.imageFrames || attachment?.imageFrames;
        if (Array.isArray(frames) && frames.length) images += frames.length;
        else if (IMAGE_ATTACHMENT.test(String(attachment?.type || data?.type || ''))) images += 1;
    }
    return estimateTextTokens(text) + images * IMAGE_TOKEN_ESTIMATE;
}

function latestUsageAnchor(messages) {
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        const usage = message?.role === 'assistant' ? message.contextUsage : undefined;
        if (Number.isFinite(usage?.inputTokens) && usage.inputTokens > 0) {
            const prefixEstimate = Number.isFinite(usage.prefixEstimate) && usage.prefixEstimate >= 0
                ? usage.prefixEstimate : undefined;
            return { index, inputTokens: usage.inputTokens, prefixEstimate };
        }
    }
    return null;
}

/**
 * Local estimate of the effective messages before `index`, recorded beside a
 * provider usage so later edits or deletions of those messages can be applied
 * to the provider count.
 */
export function estimateHistoryPrefixTokens(history, index) {
    if (!Array.isArray(history) || index <= 0) return 0;
    return effectiveContextHistory(history.slice(0, index))
        .reduce((total, message) => total + estimateMessageTokens(message), 0);
}

/**
 * The usage anchor stored on an assistant reply that arrived whole (streaming off):
 * provider input tokens plus the local estimate of the messages they covered.
 */
export function providerUsageAnchor(usage, history, index) {
    if (!usage || typeof usage !== 'object' || usage.estimated === true) return undefined;
    const inputTokens = Number(usage.inputTokens ?? usage.prompt_tokens);
    if (!Number.isFinite(inputTokens) || inputTokens <= 0) return undefined;
    const outputTokens = Number(usage.outputTokens ?? usage.completion_tokens);
    return {
        inputTokens: Math.round(inputTokens),
        ...(Number.isFinite(outputTokens) && outputTokens >= 0 ? { outputTokens: Math.round(outputTokens) } : {}),
        prefixEstimate: estimateHistoryPrefixTokens(history, index),
    };
}

/**
 * Context size in provider tokens. With a provider-reported anchor `total` is
 * the anchor's input tokens plus a local estimate of the anchor reply and every
 * later message; without one the system prompt and all messages are estimated.
 * `fixed` is the part compaction cannot shrink (expanded system prompt, tool
 * definitions, server-side injections): anchor input minus the estimated
 * messages it covered, or the estimated system prompt without an anchor.
 * When the anchor recorded the estimate of the messages it covered, messages
 * edited or deleted since then are re-estimated instead of trusting the stale
 * provider count.
 */
export function measureContextTokens(history, systemPrompt = '') {
    const messages = effectiveContextHistory(history);
    const anchor = latestUsageAnchor(messages);
    const estimates = messages.map(estimateMessageTokens);
    const sum = list => list.reduce((total, value) => total + value, 0);
    if (!anchor) {
        const fixed = estimateTextTokens(systemPrompt);
        return { total: fixed + sum(estimates), fixed, source: 'estimate' };
    }
    const coveredNow = sum(estimates.slice(0, anchor.index));
    const covered = anchor.prefixEstimate ?? coveredNow;
    if (covered > 0 && anchor.inputTokens < covered) {
        // The provider received less than the local estimate of these messages: the server
        // shortened old tool results before sending, or the estimate runs high for this text.
        // Either way the provider count is what the next request will weigh, so the covered
        // messages are scaled to it instead of being counted at full local size.
        return {
            total: Math.round(coveredNow * (anchor.inputTokens / covered)) + sum(estimates.slice(anchor.index)),
            fixed: 0,
            source: 'provider_usage',
        };
    }
    const fixed = Math.max(0, anchor.inputTokens - covered);
    return {
        total: fixed + coveredNow + sum(estimates.slice(anchor.index)),
        fixed,
        source: 'provider_usage',
    };
}

export function estimateContextTokens(history, systemPrompt = '') {
    return measureContextTokens(history, systemPrompt).total;
}

/** True when compaction is both needed and able to bring the context under `limit`. */
export function contextExceedsCompactableBudget(history, systemPrompt, limit) {
    const { total, fixed } = measureContextTokens(history, systemPrompt);
    return fixed < limit && total >= limit;
}

export function shouldCompactContext(history, agentConfig, pendingText = '') {
    const limit = Number(agentConfig?.contextTokenLimit);
    if (!Number.isFinite(limit) || limit <= 0) return false;
    const effective = effectiveContextHistory(history);
    if (!effective.length) return false;
    // A checkpoint alone cannot be compressed endlessly when diary retention exceeds the budget.
    if (effective.length === 1 && effective[0].contextCompaction) return false;
    // 不可压缩的部分已超过阈值时压缩无济于事，否则每轮都会重新压缩；交给服务端裁剪兜底。
    return contextExceedsCompactableBudget([...effective, { role: 'user', content: pendingText }], agentConfig.systemPrompt || '', limit * 0.85);
}

/**
 * Hard check for sends that do not go through the full preflight (continue,
 * regenerate, heartbeat): refuse instead of sending a request the limit cannot hold.
 * Uses the same measurement as the compaction trigger.
 */
export function assertContextWithinLimit(history, agentConfig, pendingText = '') {
    const limit = Number(agentConfig?.contextTokenLimit);
    if (!Number.isFinite(limit) || limit <= 0) return;
    const effective = effectiveContextHistory(history);
    let messages = pendingText ? [...effective, { role: 'user', content: pendingText }] : effective;
    // A message window sends only the newest messages, so neither the older ones nor a
    // provider count taken over the whole topic say anything about the request size.
    const windowSize = normalizeAgentContextWindowSize(agentConfig.contextMessageWindowSize);
    if (windowSize !== null) {
        messages = messages.slice(-windowSize).map(({ contextUsage, ...message }) => message);
    }
    const { total } = measureContextTokens(messages, agentConfig.systemPrompt || '');
    if (total > limit) {
        throw new Error(`当前上下文估算 ${total} token，超过上限 ${limit}；请先压缩上下文、缩短内容或调整上限。`);
    }
}

/**
 * Estimate assembled text only; encoded media bytes are not text tokens.
 * The assembled request only contains what this client expands. Whatever the
 * server adds (expanded prompt variables, memory, tool definitions) is known
 * from the latest provider usage, so the larger of the two counts is used.
 */
export async function preflightContextSend({
    electronAPI, agentConfig, context, history, pendingMessage,
    extraContextHistory = [], createRequestTextOptions, afterCompaction = false,
}) {
    const limit = Number(agentConfig?.contextTokenLimit);
    if (!Number.isFinite(limit) || limit <= 0) return { shouldCompact: false };

    const assemble = (messages, conversationSnapshot) => assembleRequestMessages({
        ...createRequestTextOptions?.(agentConfig, messages, pendingMessage.id),
        electronAPI, agentConfig, context, history: messages, conversationSnapshot,
        currentUserMessageId: pendingMessage.id,
        buildMessageContent: args => buildDefaultMessageContent({ ...args, includeAttachmentFrames: false }),
    });
    const estimate = ({ messagesForVCP }) => estimateContextTokens(messagesForVCP.map(message => ({
        ...message,
        content: Array.isArray(message.content)
            ? message.content.filter(part => part?.type === 'text')
            : message.content,
    })));
    const full = await assemble([...extraContextHistory, ...history, pendingMessage]);
    // A message window sends only part of the history, so the usage-anchored count of the whole topic does not apply.
    const measured = normalizeAgentContextWindowSize(agentConfig.contextMessageWindowSize) === null
        ? measureContextTokens([...extraContextHistory, ...history, pendingMessage], agentConfig.systemPrompt || '')
        : { source: 'estimate', total: 0, fixed: 0 };
    const anchored = measured.source === 'provider_usage';
    const tokens = Math.max(estimate(full), anchored ? measured.total : 0);
    if (tokens < limit * 0.85) return { shouldCompact: false, tokens };

    const oldHistory = new Set(history);
    const canCompact = !afterCompaction && full.retainedHistory.some(message =>
        oldHistory.has(message) && !isContextCheckpoint(message));
    if (canCompact) {
        // Do not spend a compaction request if the new turn cannot fit even on its own.
        const minimum = Math.max(
            estimate(await assemble([pendingMessage], full.conversationSnapshot)),
            anchored ? measured.fixed + estimateMessageTokens(pendingMessage) : 0);
        if (minimum <= limit) return { shouldCompact: true, tokens };
        throw new Error(`本轮内容（含展开附件）与提示词估算 ${minimum} token，超过上限 ${limit}；请缩短内容、移除附件或调整上限。`);
    }
    if (tokens > limit) {
        const subject = afterCompaction ? '压缩后的请求' : '当前请求（含展开附件）';
        throw new Error(`${subject}估算 ${tokens} token，超过上限 ${limit}；请缩短内容、移除附件或调整上限。`);
    }
    return { shouldCompact: false, tokens };
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
    const status = response.ok ? Number(response.headers?.get('x-vcp-upstream-status')) : response.status;
    if (status >= 400 && status <= 599) {
        await response.body?.cancel?.().catch(() => {});
        throw Object.assign(new Error(`上下文压缩请求失败（HTTP ${status}）`), { rejectionStatus: status });
    }
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
            Promise.resolve(controller.core
                ? sharedCompaction.coreCompact({ descriptor: scope, action: 'cancel' })
                : interruptRequest?.(controller.requestId)).catch(error=>
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
        let attemptSettings = settings;
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
                if (authority.core) {
                    controller.core = true;
                    const configuration = Object.fromEntries(['contextCompactionModel', 'contextCompactionFallbackModel',
                        'contextCompactionPrompt', 'contextCompactionSendPrompt', 'contextCompactionMainPrompt']
                        .filter(key => typeof settings[key] === 'string').map(key => [key, settings[key]]));
                    const result = await sharedCompaction?.coreCompact?.({
                        descriptor: scope, action: 'execute', settings: configuration, requestId: controller.requestId
                    });
                    if (!result?.success || !result.message?.contextCompaction || !Array.isArray(result.history)) {
                        throw Object.assign(Error(result?.error || 'CORE_COMPACTION_UNAVAILABLE'),
                            { code: result?.error || 'CORE_COMPACTION_UNAVAILABLE' });
                    }
                    recovered = result;
                    return;
                }
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
                const attempt = () => request({
                    settings: attemptSettings, state, signal: controller.signal, requestId: controller.requestId,
                    onResponse: diagnostic => { responseDiagnostic = diagnostic; },
                });
                try {
                    return await attempt();
                } catch (error) {
                    const { model, fallbackModel } = compactionSettings(settings);
                    if (controller.signal.aborted || !fallbackModel || fallbackModel === model ||
                        ![400, 404, 422, 429].includes(error.rejectionStatus)) throw error;
                    attemptSettings = { ...settings, contextCompactionModel: fallbackModel };
                    controller.requestId += '_fallback';
                    responseDiagnostic = null;
                    return attempt();
                }
            };
            const response = await Promise.race([
                runRequest(),
                deadline,
            ]);
            clearTimeout(timer); // The request deadline must not abort durable history persistence.
            if (disposed || controller.signal.aborted) throw new Error('上下文压缩已取消');
            returnedContent = response;
            const message = recovered?.message ?? createCheckpointMessage(state, response, attemptSettings, shared ? {id:shared.messageId} : {});
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
                    `模型：${responseDiagnostic?.model || compactionSettings(attemptSettings).model}`,
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

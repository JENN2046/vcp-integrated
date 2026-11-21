import { normalizeStreamChunk } from '../chat/contentRuntime.js';
import { collectToolBatchRanges } from './toolBatchRegions.js';

const terminalTypes = new Set(['completed', 'failed', 'cancelled', 'discarded']);

const buildMessage = event => {
    const context = event.context || {};
    return {
        id: event.messageId,
        role: 'assistant',
        name: context.agentName,
        agentId: context.agentId,
        admissionToken: context.admissionToken,
        avatarUrl: context.avatarUrl,
        avatarColor: context.avatarColor,
        content: event.type === 'agent_thinking' ? '思考中...' : '',
        timestamp: Date.now(),
        isThinking: event.type === 'agent_thinking',
        isGroupMessage: context.isGroupMessage || false,
        groupId: context.groupId,
        topicId: context.topicId,
        context,
        streamOperationId: event.streamOperationId || event.operationId || null,
    };
};

/** Main-window projection of stream facts. All powers are explicit capabilities. */
export function createMainChatStreamConsumer(initialEvent, capabilities) {
    const { messageId } = initialEvent;
    const operationId = initialEvent.streamOperationId || initialEvent.operationId || messageId;
    let context = initialEvent.context || {};
    let preparedType = null;
    const projection = capabilities.resolveProjection?.(messageId) || null;
    let accumulatedText = '';
    let checkedBoundaryCount = 0;
    let budgetInterruptRequested = false;
    const reportError = (...args) => { try { capabilities.reportError?.(...args); } catch { /* diagnostics cannot own persistence */ } };
    const setPersistenceState = (...args) => {
        try { capabilities.setPersistenceState?.(...args); }
        catch (error) { reportError('[MainChatStreamConsumer] persistence indicator failed', error); }
    };

    return Object.freeze({
        surfaceGeneration: capabilities.getSurfaceGeneration?.(),
        normalizeChunk(chunk) {
            const text = normalizeStreamChunk(chunk);
            // Without role dividers ToolBox sends its entire result batch in
            // one native SSE packet. Ordinary assistant text is not a receipt.
            if (!/^chatcmpl-vcp-batch-\d+$/.test(chunk?.id || '')) return text;
            const [batch] = collectToolBatchRanges(text);
            if (!batch?.closed || text.slice(0, batch.start).trim() || text.slice(batch.end).trim()) return text;
            return { text, toolReturnBoundary: true };
        },
        async prepare(event) {
            context = { ...context, ...(event.context || {}) };
            if (preparedType === null) {
                preparedType = event.type;
                await (projection?.start || capabilities.start)(buildMessage({ ...event, context, streamOperationId: operationId }));
            }
        },
        consume(event) {
            const terminal = terminalTypes.has(event.type);
            if (projection?.suppressed) {
                if (terminal) projection.settle?.({ event, finalized: event.outcome?.persistence?.value, context, messageId });
                return;
            }
            if (event.type === 'chunk') {
                (projection?.append || capabilities.append)(messageId, event.text, context, operationId);
                accumulatedText += event.text;
                if (!context.isGroupMessage && !context.groupId) {
                    const boundaries = accumulatedText.match(/^[ \t]*<<<\[END_ROLE_DIVIDE_USER\]>>>[ \t]*(?=\r?$)/gm) || [];
                    if (event.toolReturnBoundary || boundaries.length > checkedBoundaryCount) {
                        checkedBoundaryCount = boundaries.length;
                        Promise.resolve(capabilities.onToolReturnBoundary?.({
                            messageId, streamOperationId: operationId, context, text: accumulatedText,
                            onInterruptRequested: () => { budgetInterruptRequested = true; },
                        })).catch(error => capabilities.reportError?.('[ContextCompaction] Boundary check failed', error));
                    }
                }
            }
            if (!terminal) return;
            const finalized = event.outcome?.persistence?.value;
            capabilities.dispatchTerminal?.({
                type: event.outcome?.transport?.kind === 'failed' ? 'error' : event.type,
                messageId,
                context,
                error: event.outcome?.transport?.error || event.outcome?.persistence?.error || null,
            });
            if (event.type === 'failed') capabilities.renderError?.({ event, finalized, context, messageId });
            projection?.settle?.({ event, finalized, context, messageId, streamOperationId: operationId });
            const settledEvent = event.type === 'end'
                ? { ...event, type: event.finish_reason === 'cancelled' ? 'cancelled' : 'completed' }
                : event;
            capabilities.onSettled?.({ event: settledEvent, finalized, context, messageId });
        },
        async persist(value) {
            if (projection?.suppressed) return null;
            const terminal = value.terminal || {};
            if (terminal.phase === 'projection') {
                throw terminal.error || new Error(`Stream projection failed: ${messageId}`);
            }
            const pausedMessage = terminal.pausedWorkMessage;
            const receivedText = pausedMessage ? pausedMessage.content : terminal.fullResponse || value.snapshot?.text || '';
            let fullResponse = receivedText;
            const error = terminal.error?.message || terminal.error || '';
            if (terminal.finishReason === 'length') {
                fullResponse += '\n\n> [!WARNING]\n> 回复达到输出上限，内容已截断；已保留部分回复，本次任务未完成。';
            }
            if (terminal.kind === 'failed' && fullResponse.trim()) {
                fullResponse += `\n\n> [!WARNING]\n> **流式响应中断**: ${error || '未知连接错误'}。已保留收到的部分内容，本轮仍待核实。`;
            }
            const releasePersistence = capabilities.beginHistoryPersistence?.({ ...(terminal.context || context), messageId, streamOperationId: operationId });
            const projectTerminal = projection?.projectTerminal || capabilities.projectTerminal;
            const interruptedForBudget = budgetInterruptRequested && terminal.kind === 'cancelled' &&
                (terminal.finishReason === 'interrupted' || terminal.reason === 'tool-return-relay' ||
                    terminal.reason === 'tool-return-relay-settle-timeout');
            const finishReason = terminal.kind === 'completed' ? (terminal.finishReason || 'completed')
                : interruptedForBudget || pausedMessage ? 'interrupted' : terminal.kind;
            let projected;
            try { projected = await projectTerminal(
                messageId,
                finishReason,
                terminal.context || context,
                { fullResponse, error, streamOperationId: operationId, ...(pausedMessage && { authoritativeContent: true }) },
            );
            if (!projected) throw new Error(`Stream terminal projection failed: ${messageId}`);
            } catch (error) { releasePersistence?.(true); throw error; }

            // projectTerminal 已经同步撤销活动流所有权及 DOM 的 streaming/thinking
            // 状态。发送按钮只依赖这份运行态，不应继续等待随后可能较慢的历史落盘、
            // Flowlock 或话题摘要副作用；否则终稿已显示时按钮仍会偶发保持方形。
            try { capabilities.onProjectionSettled?.({ terminal, projected, context, messageId }); }
            catch (error) { reportError('[MainChatStreamConsumer] projection notification failed', error); }

            if (pausedMessage) {
                releasePersistence?.(true);
                setPersistenceState(messageId, 'saved');
                return pausedMessage;
            }
            setPersistenceState(messageId, 'saving');
            let finalized;
            try {
                finalized = await capabilities.persistTerminal(projected, receivedText);
                releasePersistence?.(true);
                setPersistenceState(messageId, 'saved');
            } catch (persistenceError) {
                releasePersistence?.(false);
                // 最终 DOM 已按乐观策略完成投影；持久化失败必须留下明确、可诊断的未保存状态，
                // 不能让用户把当前可见消息误认为已经写入 durable history。
                setPersistenceState(
                    messageId,
                    'unsaved',
                    persistenceError?.message || String(persistenceError)
                );
                throw persistenceError;
            }

            try {
                await capabilities.afterPersist?.({ terminal, finalized, context, messageId });
            } catch (sideEffectError) {
                capabilities.reportError?.('[MainChatStreamConsumer] post-commit side effect failed', sideEffectError);
            }
            return finalized;
        },
        dispose() { projection?.release?.(); },
    });
}

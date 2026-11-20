import { createSingleChatRequestOrchestrator } from './singleChatRequestOrchestrator.js';

export const DEFAULT_TOPIC_REPLY_INVITE = '[系统提示:] 话题中有新的伙伴留言，现在请结合上下文回应。需要回信时可自行调用 TopicSponsor；无需回信时正常回复即可。';

/** Prepare before acknowledging acceptance. No GUI selection or Flowlock session mutation. */
export async function prepareTopicAdmissionSingleChat({
    request, api, settings, persistAssistant, onCommitted, onFinalized, onStarting, createRequestTextOptions,
}) {
    if (request.scope.itemType !== 'agent') throw new TypeError('Single chat requires agent target');
    const { itemId: agentId, topicId } = request.scope;
    const [agentConfig, history] = await Promise.all([
        api.getAgentConfig(agentId), api.getChatHistory(agentId, topicId),
    ]);
    if (!agentConfig || agentConfig.error || !Array.isArray(history)) {
        throw new Error(agentConfig?.error || '无法读取目标话题');
    }
    const orchestrator = createSingleChatRequestOrchestrator({ electronAPI: api });
    const messageId = `admission_${request.token}`;
    const context = {
        agentId, topicId, itemType: 'agent', agentName: agentConfig.name,
        avatarUrl: agentConfig.avatarUrl,
        avatarColor: agentConfig.avatarCalculatedColor || agentConfig.avatarColor,
        admissionToken: request.token,
    };
    const currentUserMessageId = request.automatic ? undefined : request.messageId;
    const requestHistory = history.filter(message => !message.isThinking);
    const prepared = await orchestrator.buildRequest({
        ...createRequestTextOptions?.(agentConfig, requestHistory, currentUserMessageId),
        settings, agentConfig,
        history: history.filter(message => !message.isThinking),
        messageId, context,
        currentUserMessageId: request.automatic ? undefined : request.messageId,
        temporaryPrompt: request.automatic ? request.invitePrompt || DEFAULT_TOPIC_REPLY_INVITE : undefined,
    });
    if (!settings.vcpServerUrl) throw new Error('VCP 服务器 URL 未配置');
    return {
        messageId,
        async start() {
            await onStarting?.({
                scope: request.scope, streaming: prepared.modelConfig.stream === true,
                message: {
                    id: messageId, role: 'assistant', name: agentConfig.name, agentId, topicId,
                    admissionToken: request.token, context,
                    avatarUrl: context.avatarUrl, avatarColor: context.avatarColor,
                    content: '', isThinking: true, timestamp: Date.now(),
                },
            });
            const result = await orchestrator.sendPrepared(prepared, settings);
            if (prepared.modelConfig.stream === true) {
                if (!result?.streamingStarted || result.streamError) {
                    throw new Error(result?.errorDetail || result?.error || '流式启动失败');
                }
                // StreamCoordinator persists the response and releases admissionToken.
                return;
            }
            const response = result?.response ?? result;
            if (!response?.choices?.[0]?.message || (response?.error && !response.choices[0].message.content)) {
                throw new Error(response?.error || '未知响应格式');
            }
            const modelFinishReason = response.choices[0].finish_reason;
            const nativeFailure = response.nativeFailure || response.error
                || (!['stop', 'length'].includes(modelFinishReason)
                    ? { code: 'MODEL_RESPONSE_INCOMPLETE', kind: 'interrupted' } : null);
            if (modelFinishReason !== 'stop' || nativeFailure) {
                const code = modelFinishReason === 'length' && !nativeFailure
                    ? 'MODEL_RESPONSE_TRUNCATED' : nativeFailure?.code || 'MODEL_RESPONSE_INCOMPLETE_REVIEW_REQUIRED';
                try {
                    await onFinalized?.({
                        type: modelFinishReason === 'length' ? 'end' : 'error', messageId, context,
                        content: response.choices[0].message.content || '',
                        finishReason: modelFinishReason === 'length' ? 'length' : 'failed', error: code,
                    });
                } catch (effectError) { console.error('[AdmissionSingleChat] review notification failed', effectError); }
                // The existing renderer admission owner reports this dispatch
                // uncertain; no assistant terminal or saved release is issued.
                throw Object.assign(new Error(code), { code, reviewRequired: true });
            }
            const finishReason = 'completed';
            const warning = nativeFailure
                ? '\n\n> [!WARNING]\n> 回复中断，已保留收到的部分内容，本次任务未完成。'
                : finishReason === 'length'
                    ? '\n\n> [!WARNING]\n> 回复达到输出上限，内容已截断；已保留部分回复，本次任务未完成。' : '';
            const message = {
                id: messageId, role: 'assistant', name: agentConfig.name, agentId,
                admissionToken: request.token, admissionTerminal: true,
                avatarUrl: context.avatarUrl, avatarColor: context.avatarColor,
                content: (response.choices[0].message.content || '') + warning,
                ...(nativeFailure ? { nativeFailure } : {}),
                timestamp: Date.now(), finishReason, isThinking: false,
            };
            await persistAssistant(request.scope, message);
            const released = await api.topicAdmissionRelease(request.scope, request.token, { saved: true });
            if (!released?.success) throw new Error(released?.error || released?.code || '入场租约释放失败');
            try { await onCommitted?.(request.scope); }
            catch (error) { console.error('[AdmissionSingleChat] post-commit projection failed', error); }
            try {
                await onFinalized?.({
                    type: nativeFailure ? 'error' : 'end', messageId, context, content: message.content,
                    finishReason: message.finishReason, error: nativeFailure ? nativeFailure.code || 'VCP_UPSTREAM_ERROR' : null,
                });
            } catch (error) {
                console.error('[AdmissionSingleChat] post-commit finalization failed', error);
            }
        },
    };
}
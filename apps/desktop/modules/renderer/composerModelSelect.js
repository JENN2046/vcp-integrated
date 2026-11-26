/**
 * 输入框内的 AI 模型选择器。
 * 位于语音按钮左侧，读写当前 Agent 的 model 配置，与设置页的 Agent 模型保持一致。
 * 浮层视图与常用候选配置委托至公共的 ModelPickerPopup 引擎。
 */
(function () {
    const STYLE_ID = 'vcp-composer-model-select-style';
    const CSS = `
.vcp-model-select { position: relative; display: inline-flex; margin-left: auto !important; margin-right: 2px; flex: 0 0 auto; min-width: max-content; }
.vcp-model-select:not([hidden]) ~ #mainVoiceInputBtn { margin-left: 0 !important; }
.vcp-model-select:not([hidden]) ~ :is(#sendMessageBtn, .chat-send-button) { margin-left: 0 !important; }
.vcp-model-select[hidden] { display: none !important; }
.vcp-model-select-trigger {
    display: inline-flex; align-items: center; gap: 4px; min-height: 28px; height: auto; padding: 4px 4px 4px 8px; max-width: none;
    border: 0; border-radius: 8px; background: transparent; cursor: pointer;
    color: var(--vcp-ui-text-2, #a7afb1); font: inherit; font-size: 13px; line-height: 20px;
    transition: background-color .15s, color .15s;
}
.vcp-model-select-trigger:hover, .vcp-model-select-trigger[aria-expanded="true"] {
    background: var(--vcp-ui-interactive-hover, rgba(127,127,127,.16)); color: var(--vcp-ui-text-0, currentColor);
}
.vcp-model-select-label { overflow: visible; text-overflow: clip; white-space: normal; overflow-wrap: anywhere; text-align: left; }
.vcp-model-select-trigger svg { width: 12px; height: 12px; opacity: .7; flex: none; }
`;

    function init({ electronAPI, selectedItemRef, nameObserveTarget, sendMessageBtn }) {
        const actions = document.querySelector('.chat-input-actions');
        if (!actions || !electronAPI || !selectedItemRef) return { dispose() {} };

        if (!document.getElementById(STYLE_ID)) {
            const style = document.createElement('style');
            style.id = STYLE_ID;
            style.textContent = CSS;
            document.head.appendChild(style);
        }

        const wrap = document.createElement('div');
        wrap.className = 'vcp-model-select';
        wrap.hidden = true;
        const trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.className = 'vcp-model-select-trigger';
        trigger.setAttribute('aria-haspopup', 'listbox');
        trigger.setAttribute('aria-expanded', 'false');
        const labelEl = document.createElement('span');
        labelEl.className = 'vcp-model-select-label';
        const chevron = document.createElement('span');
        chevron.className = 'vcp-ui-icon';
        chevron.setAttribute('aria-hidden', 'true');
        chevron.textContent = 'chevron-down';
        trigger.append(labelEl, chevron);
        wrap.appendChild(trigger);

        const anchor = document.getElementById('mainVoiceInputBtn')
            || sendMessageBtn
            || document.getElementById('sendMessageBtn');
        if (anchor && anchor.parentNode === actions) actions.insertBefore(wrap, anchor);
        else actions.appendChild(wrap);

        const saves = new Map();
        let disposed = false;

        const currentItem = () => selectedItemRef.get?.() || null;
        const isAgent = item => !!item && item.type === 'agent' && !!item.id;
        const readModel = item => (item?.config?.model ?? item?.model ?? '') || '';

        const refresh = () => {
            const item = currentItem();
            const show = isAgent(item);
            wrap.hidden = !show;
            if (!show) { popup?.close?.(); return; }
            const model = readModel(item);
            labelEl.textContent = model || '选择模型';
            trigger.title = model
                ? `当前模型：${model}（左键切换 / 右键勾选候选列表）`
                : '左键选择模型 / 右键勾选候选模型';
        };

        async function drainSaves(agentId, state) {
            try {
                while (state.pending !== null) {
                    const modelId = state.pending;
                    state.pending = null;
                    let result;
                    try {
                        // Shared saves require the current complete configuration and
                        // its version token; a model-only patch is not a shared DTO.
                        let currentConfig = null;
                        if (typeof electronAPI.getAgentConfig === 'function') {
                            currentConfig = await electronAPI.getAgentConfig(agentId);
                            if (!currentConfig || currentConfig.error) throw new Error(currentConfig?.error || 'agent-config-unavailable');
                            if (disposed) continue;
                        }
                        const base = currentConfig?.__nativeSyncSharedBase;
                        const payload = base ? { ...currentConfig, model: modelId } : { model: modelId };
                        result = await electronAPI.saveAgentConfig(agentId, payload);
                        if (!result?.success) throw new Error(result?.error || 'save-failed');
                        if (disposed) continue;
                        if (result.refreshError) window.uiHelperFunctions?.showToastNotification?.('模型已保存，配置刷新尚未完成。', 'warning');
                        // 只发布已经保存成功的配置；保留当前项的其它最新字段。
                        const latest = currentItem();
                        if (isAgent(latest) && latest.id === agentId) {
                            const next = { ...latest, model: modelId };
                            const savedBase = base ? { ...base, version: result.sharedVersion ?? base.version } : null;
                            if (latest.config) next.config = { ...latest.config, model: modelId, ...(savedBase ? { __nativeSyncSharedBase: savedBase } : {}) };
                            else if (savedBase) next.__nativeSyncSharedBase = savedBase;
                            selectedItemRef.set(next);
                        }
                        const settingsInput = document.getElementById('agentModel');
                        if (settingsInput && document.getElementById('editingAgentId')?.value === agentId) {
                            settingsInput.value = modelId;
                        }
                    } catch (error) {
                        console.error('[ComposerModelSelect] 切换模型失败:', error);
                        if (!disposed) {
                            const pending = error.message === 'SHARED_CONFIG_PENDING_CONFIRMATION';
                            const message = result?.success ? '模型已保存，界面刷新尚未完成。'
                                : pending ? '模型保存结果待确认。请再次选择该模型以核对。'
                                : `切换模型失败: ${error.message || error}`;
                            window.uiHelperFunctions?.showToastNotification?.(message, result?.success || pending ? 'warning' : 'error');
                        }
                    }
                }
            } finally {
                saves.delete(agentId);
                if (!disposed) refresh();
            }
        }

        function choose(modelId) {
            const item = currentItem();
            if (disposed || !isAgent(item)) return;
            const existing = saves.get(item.id);
            if (existing) {
                // 保存中的再次选择不能丢弃，包括切回尚未被替换的原模型。
                existing.pending = modelId;
                return;
            }
            if (modelId === readModel(item)) return;
            const state = { pending: modelId };
            saves.set(item.id, state);
            void drainSaves(item.id, state);
        }

        function normalize(models) {
            const list = Array.isArray(models) ? models
                : Array.isArray(models?.data) ? models.data
                    : Array.isArray(models?.models) ? models.models : [];
            return list.map(m => (typeof m === 'string' ? m : m?.id)).filter(Boolean);
        }

        async function readCatalog() {
            const [models, favorites] = await Promise.all([
                electronAPI.getCachedModels?.() ?? [],
                Promise.resolve().then(() => electronAPI.getFavoriteModels?.() ?? []).catch(() => []),
            ]);
            return { ids: normalize(models), favorites };
        }

        async function refreshCatalog(cached) {
            const result = await electronAPI.refreshModels();
            if (!result?.success || !Array.isArray(result.models)) throw new Error('model-refresh-failed');
            return { ids: normalize(result.models), favorites: cached.favorites };
        }

        let popup = null;
        const bindPopup = () => {
            if (popup || !wrap.isConnected) return;
            const factory = window.ModelPickerPopup?.createModelPickerPopup;
            if (typeof factory === 'function') {
                popup = factory({
                    wrap,
                    trigger,
                    getCatalog: readCatalog,
                    refreshCatalog: typeof electronAPI.refreshModels === 'function' ? refreshCatalog : undefined,
                    getActiveModel: () => readModel(currentItem()),
                    onSelect: choose,
                    enableCheckMenu: true
                });
            }
        };

        bindPopup();
        if (!popup) {
            if (typeof queueMicrotask === 'function') queueMicrotask(bindPopup);
            else setTimeout(bindPopup, 0);
        }

        // 切换 Agent / 保存设置后会刷新标题，借此同步显示
        let observer = null;
        if (nameObserveTarget && typeof MutationObserver !== 'undefined') {
            observer = new MutationObserver(() => { refresh(); setTimeout(refresh, 200); });
            observer.observe(nameObserveTarget, { childList: true, characterData: true, subtree: true });
        }
        window.addEventListener('focus', refresh);
        refresh();

        return {
            refresh,
            dispose() {
                if (disposed) return;
                disposed = true;
                for (const state of saves.values()) state.pending = null;
                popup?.dispose();
                popup = null;
                window.removeEventListener('focus', refresh);
                observer?.disconnect();
                wrap.remove();
                document.getElementById(STYLE_ID)?.remove();
            },
        };
    }

    window.ComposerModelSelect = { init };
})();

import { offerNativeConfigurationRebase } from '../../chat/nativeConfigurationActions.mjs';

// Each native edit keeps the revision the user saw, even if the panel changes
// while a receipt or a conflict dialog is outstanding.
export function ruleSaveApi(api, store, context) {
    const globalBase = store?.__nativeSyncSharedBase;
    const ownerBase = context?.__nativeSyncSharedBase;
    if (!globalBase && !ownerBase) return api;

    function advance(view, next) {
        const current = view?.__nativeSyncSharedBase;
        if (current && next?.sharedId === current.sharedId && next.version >= current.version) {
            view.__nativeSyncSharedBase = next;
        }
    }

    return {
        async tavernSaveRules(draft) {
            const base = draft.__nativeSyncSharedBase;
            const result = await api.tavernSaveRules(draft);
            if (!base || result?.success) return result;
            if (result?.error === 'SHARED_CONFIG_CONFLICT') {
                await offerNativeConfigurationRebase({
                    api, base, uiHelper: window.uiHelperFunctions,
                    onVersion: next => advance(draft, next),
                });
            }
            window.uiHelperFunctions?.showToastNotification?.('共享规则保存尚未确认，当前编辑保留：' + (result?.error || '未知错误'), 'warning');
            return result;
        },
        async tavernToggleRuleEnabled(key) {
            if (!globalBase) return api.tavernToggleRuleEnabled(key);
            const result = await api.tavernToggleRuleEnabled(key, { __nativeSyncSharedBase: globalBase });
            if (result?.success) advance(store, result.store?.__nativeSyncSharedBase);
            return result;
        },
        async updateConversationOverride(owner, patch) {
            if (!ownerBase) return api.updateConversationOverride(owner, patch);
            const result = await api.updateConversationOverride(owner, { ...patch, __nativeSyncSharedBase: ownerBase });
            if (result?.success) advance(context, result.__nativeSyncSharedBase);
            return result;
        },
    };
}

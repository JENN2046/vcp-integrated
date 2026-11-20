import { createTopicManagement } from '../services/nativeSync/topicManagement.mjs';
import { createAttachmentInteraction } from '../services/nativeSync/attachmentPresentation.mjs';
import { ruleSaveApi } from '../services/nativeSync/tavernRuleSave.mjs';
import './mergeFence.js';

function notifyAgentRulesChanged(change) {
    if (change.deleted || change.kind !== 'agent') return;
    const panel = window.TavernManager;
    const matches = owner => owner?.type === 'agent' && owner.id === change.id;
    if (!matches(panel?.getConversationOwner?.())) return;

    panel.notifyRulesChanged?.(async (owner, displayed) => {
        const base = displayed?.__nativeSyncSharedBase;
        if (!matches(owner) || base?.sharedId !== change.sharedId) return;
        try {
            const api = window.chatAPI || window.electronAPI;
            const context = await api.resolveConversationContext(owner);
            const next = context?.__nativeSyncSharedBase;
            if (context?.success && matches(panel.getConversationOwner()) &&
                next?.sharedId === change.sharedId && next.version >= Math.max(base.version, change.version)) {
                return context;
            }
        } catch {
            console.warn('[NativeSync] Rule override display refresh pending');
        }
    });
}

let installed = false;
export function install() {
    if (installed) return;
    installed = true;
    if (window.TavernManager) window.TavernManager.ruleSaveApi = ruleSaveApi;
    if (window.chatAPI?.getNativeDeletionContext) {
        window.topicListManager?.setManagementExtension?.(createTopicManagement(window.chatAPI));
    }
    const attachmentInteraction = createAttachmentInteraction(window);
    if (attachmentInteraction) {
        void import('../messageRenderer.js').then(host => {
            host.setAttachmentInteraction?.(document, attachmentInteraction);
        }).catch(() => {});
    }
    window.electronAPI?.onSharedDirectoryChanged?.(change => {
        void window.itemListManager?.loadItems?.();
        notifyAgentRulesChanged(change);
        if (change.deleted || !document.getElementById('tabContentSettings')?.classList.contains('active')) return;
        if (change.kind === 'agent') {
            void window.settingsManager?.reloadAgentSettings?.(change.id, {discardDraft:change.discardDraft === true, passive:true})
                .catch(() => console.warn('[NativeSync] Native settings refresh pending'));
        } else if (change.kind === 'group') {
            void window.GroupRenderer?.refreshSavedGroupIdentity?.(change.id)
                .catch(() => console.warn('[NativeSync] Group settings identity refresh pending'));
        }
    });
}

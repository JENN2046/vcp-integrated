// Registered by the existing NativeSync app feature in the main document.
export function createAttachmentInteraction(win) {
    const api = win.chatAPI;
    if (typeof api?.checkOpenedAttachment !== 'function') return;
    return function handle({ reason, wrapper, messageId, attachment }) {
        if (reason !== 'open' && !(reason === 'resource-error' && /^(audio|video)\//.test(attachment.type))) return;
        const scope = win.VCPStateChannels?.get('conversation.current')?.get();
        const data = attachment._fileManagerData || attachment;
        const hash = attachment.blobHash || data.blobHash || attachment.hash || data.hash;
        if (!wrapper.isConnected || !scope?.topicId || !messageId || !/^[a-f0-9]{64}$/.test(hash)) return;
        return check();

        async function check() {
            try {
                const result = await api.checkOpenedAttachment({
                    itemType: scope.itemType, itemId: scope.itemId, topicId: scope.topicId,
                    messageId, attachmentId: attachment.id || data.id || 'attachment_' + hash, hash
                });
                if (result?.missing !== true) return false;
                if (reason === 'open') win.uiHelperFunctions?.showToastNotification?.('附件正在恢复，请稍后打开。', 'info');
                return true;
            } catch {
                return false;
            }
        }
    };
}

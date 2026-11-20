'use strict';

const { createDesktopRuntimeLifecycle } = require('./lifecycle');

function registerIntegrated({ historyQueue, appDataRoot, readSettings, mainWindow }, dependencies) {
    const {
        ipcMain, getMainWindow = () => mainWindow, BrowserWindow, nativeImage, agentConfigManager,
        groupChat, tavernHandlers, fileManager, settingsManager, waitForHistory, historyAuthority, localHistoryAuthority,
        isolated, invalidateAgentCaches,
    } = dependencies;
    function broadcast(channel, change) {
        let sent = false;
        for (const window of BrowserWindow.getAllWindows()) {
            if (window.isDestroyed()) continue;
            window.webContents.send(channel, change);
            sent = true;
        }
        return sent;
    }
    function thumbnail(file) {
        const image = Buffer.isBuffer(file) ? nativeImage.createFromBuffer(file) : nativeImage.createFromPath(file);
        if (image.isEmpty()) return null;
        const bytes = image.resize({ width: 64, height: 64 }).toPNG();
        return bytes.length <= 16000 ? 'data:image/png;base64,' + bytes.toString('base64') : '';
    }

    return createDesktopRuntimeLifecycle({
        waitForHistory,
        onStartupError: error => console.error('[NativeSync] Desktop runtime startup failed:', error.code || 'SYNC_STARTUP_FAILED'),
        start: async startup => {
            const { createSharedHost } = require('../services/nativeSync/sharedHost');
            const { createNativeSyncRuntime } = require('../services/nativeSync/runtime');
            const sharedHost = createSharedHost({
                appDataRoot, agentConfigManager, groupChat, tavernHandlers,
                settingsManager, readSettings,
                prepareViews: scope => require('../services/nativeSync/sharedViewPreparation').prepareViews(BrowserWindow, scope),
                thumbnail: async file => {
                    const value = thumbnail(file);
                    if (value === null) throw Error('INVALID_AVATAR');
                    if (value === '') throw Error('AVATAR_TOO_LARGE');
                    return value;
                },
                notify: change => {
                    invalidateAgentCaches();
                    broadcast('native-sync:directory-changed', change);
                },
            });
            return createNativeSyncRuntime({
                ...startup,
                queue: historyQueue(), appDataRoot, ipcMain, getMainWindow, historyAuthority, localHistoryAuthority,
                args: process.argv, isolated, readSettings, sharedHost, agentConfigEvents: agentConfigManager,
                readAgentConfig: id => agentConfigManager.readAgentConfig(id),
                readGroupConfig: id => groupChat.getAgentGroupConfig(id),
                readTavernRules: () => tavernHandlers.getActiveRules(),
                readEffectiveTavernRules: async descriptor => (await require('../services/conversationContext')
                    .resolve({ type: descriptor.itemType || 'agent', id: descriptor.itemId })).rules,
                readExecutionPolicy: async () => {
                    const settings = await readSettings();
                    return {
                        userName: settings.userName || '用户',
                        enableThoughtChainInjection: settings.enableThoughtChainInjection === true,
                        enableContextSanitizer: settings.enableContextSanitizer === true,
                        contextSanitizerDepth: settings.contextSanitizerDepth === undefined ? 2 : Number(settings.contextSanitizerDepth),
                        enableVcpToolInjection: settings.enableVcpToolInjection === true,
                    };
                },
                storeAttachment: (...args) => fileManager.storeFile(...args),
                thumbnail: async file => thumbnail(file) || null,
                notifyExecutionStatus: change => {
                    broadcast('native-sync:executions-changed', change);
                    const { ownerId, topicId } = change.topic || {};
                    const window = getMainWindow();
                    if (change.serverSession && ownerId && topicId && window && !window.isDestroyed()) {
                        window.webContents.send('model-trajectory:changed', { sessionKey: ownerId + '__' + topicId });
                    }
                },
                notify: change => broadcast('history-file-updated', change),
            });
        },
    });
}
function register(host, dependencies) {
    const ipc = dependencies?.ipcMain || require('electron').ipcMain;
    const removeStatus = require('./profileStatus').registerDesktopStatus(host, ipc, {
        integrated: Boolean(dependencies), getWindow: dependencies?.getMainWindow,
    });
    if (!dependencies) {
        try {
            const unregister = host.agentSettingsSaveOwner?.register(
                require('./agentNameOwner.cjs').createAgentNameOwner(host));
            return { dispose() { unregister?.(); removeStatus(); } };
        } catch (error) {
            removeStatus();
            throw error;
        }
    }
    try {
        const lifecycle = registerIntegrated(host, dependencies);
        let closed;
        return { ...lifecycle, close() {
            if (!closed) {
                removeStatus();
                closed = lifecycle.close();
            }
            return closed;
        } };
    } catch (error) {
        removeStatus();
        throw error;
    }
}
module.exports = { register };

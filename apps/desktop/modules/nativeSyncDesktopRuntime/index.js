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
        onStartupError: error => {
            if (['CORE_DATABASE_IDENTITY_REQUIRED','CORE_DATABASE_IDENTITY_MISMATCH'].includes(error.code)) {
                historyQueue().coreIdentityError = error.code;
            }
            console.error('[NativeSync] Desktop runtime startup failed:', error.code || 'SYNC_STARTUP_FAILED');
        },
        onRuntimeRecovered: () => broadcast('native-sync:executions-changed', { sharedRuntimeRecovered: true }),
        start: async startup => {
            const { ownedJson } = require('../services/nativeSync/sharedLocal');
            const marker = await ownedJson(appDataRoot, require('node:path').join(appDataRoot, '.vcp-core/profile.json'), { optional: true });
            const remoteOrigin = process.env.VCPCHAT_CORE_REMOTE_ORIGIN || (marker?.remote && marker.origin) || undefined;
            const localWorkspace = process.env.VCPCHAT_LOCAL_CORE_WORKSPACE || marker?.workspace || (remoteOrigin && 'personal');
            if (localWorkspace) {
                if (!isolated) throw Object.assign(new Error('CORE_LOCAL_REQUIRES_SEPARATE_PROFILE'), { code: 'CORE_LOCAL_REQUIRES_SEPARATE_PROFILE' });
                // Remote directory projection writes through native History authority.
                await startup.waitForHistoryAuthority();
                return require('../services/localCoreRuntime').openLocalCore({
                    queue: historyQueue(), appDataRoot, workspace: localWorkspace, readSettings, ipcMain, getMainWindow,
                    remoteOrigin, remoteToken: process.env.VCPCHAT_CORE_DEVICE_TOKEN, remotePairCode: process.env.VCPCHAT_CORE_PAIR_CODE,
                    writeOwner: (kind, id, value, exists) => kind === 'agent'
                        ? exists ? agentConfigManager.updateAgentConfig(id, () => value) : agentConfigManager.writeAgentConfig(id, value)
                        : exists ? groupChat.mutateGroupConfig(id, () => value) : groupChat.initializeAgentGroupConfig(id, value),
                    notifyDirectory: () => {
                        invalidateAgentCaches();
                        broadcast('native-sync:directory-changed', { core: true });
                    },
                    readAgent: id => agentConfigManager.readAgentConfig(id),
                    readGroup: id => groupChat.getAgentGroupConfig(id),
                    readRules: async ({ itemType, itemId }) => (await require('../services/conversationContext')
                        .resolve({ type: itemType, id: itemId })).rules,
                    storeAttachment: (...args) => fileManager.storeFile(...args),
                    notify: change => broadcast('history-file-updated', change),
                    notifyExecutionStatus: change => broadcast('native-sync:executions-changed', change),
                    notifyGroupEvent: event => broadcast('vcp-stream-event', event)
                });
            }
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
                notifyGroupEvent: event => broadcast('vcp-stream-event', event),
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

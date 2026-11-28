'use strict';

const { createDesktopRuntimeLifecycle } = require('./lifecycle');

function registerIntegrated({ historyQueue, appDataRoot, readSettings, mainWindow }, dependencies) {
    const {
        ipcMain, getMainWindow = () => mainWindow, BrowserWindow, agentConfigManager,
        groupChat, fileManager, waitForHistory,
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
            return null;
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

'use strict';

const path = require('node:path');
const AgentConfigManager = require('../../utils/agentConfigManager');
const { belongsToSharedRoot, ownedJson } = require('./sharedLocal');
const { fail } = require('./protocol');

const ownerFolder = { agent: 'Agents', group: 'AgentGroups' };

async function saveNativeOwnerConfig({ root, kind, localId, config, saveLocal, avatarOnly = false }) {
    try {
        AgentConfigManager.validateId(localId);
        if (!Object.hasOwn(ownerFolder, kind) || !config || typeof config !== 'object' || Array.isArray(config)) {
            throw fail('INVALID_CONFIG');
        }
        const native = await ownedJson(root, path.join(root, ownerFolder[kind], localId, 'config.json'), { optional: true });
        if (Object.hasOwn(config, '__nativeSyncSharedBase') || Object.hasOwn(config, '__nativeSyncSharedOpId') ||
            (!avatarOnly && Object.hasOwn(config, '__nativeSyncAvatar')) ||
            native?.__nativeSyncSharedBase || native?.nativeSyncOriginSource || await belongsToSharedRoot(root)) {
            throw fail('SHARED_STARTUP_PENDING');
        }
        if (!native || native._historyDeleting) {
            throw fail(kind === 'agent' ? 'AGENT_DELETED' : 'NATIVE_CONFIG_NOT_AVAILABLE');
        }
        return await saveLocal?.() ?? null;
    } catch (error) {
        return { success: false, error: error.code || error.message || 'NATIVE_CONFIG_SAVE_FAILED' };
    }
}

function saveNativeOwnerAvatar({ root, kind, localId, data, saveLocal }) {
    const config = data && Object.hasOwn(data, '__nativeSyncSharedBase')
        ? { __nativeSyncSharedBase: data.__nativeSyncSharedBase } : {};
    return saveNativeOwnerConfig({ root, kind, localId, config, avatarOnly: true, saveLocal });
}

module.exports = { saveNativeOwnerConfig, saveNativeOwnerAvatar };

'use strict';
const path = require('node:path');
const AgentConfigManager = require('../../utils/agentConfigManager');
const { belongsToSharedRoot, runtimeForRoot } = require('./sharedHost');
const { ownedJson } = require('./sharedLocal');
const { fail } = require('./protocol');

// This adapter is installed with the native IPCs, including when no Feature
// runtime has attached. Only an established local target may fall through.
function createOwnerDeletion({ root, getRuntime = () => runtimeForRoot(root) }) {
    return async function beforeOwnerDelete(scope, options, createDefaultTopic) {
        try {
            const { itemType, itemId } = scope;
            AgentConfigManager.validateId(itemId);
            if (itemType !== 'agent' && itemType !== 'group') throw fail('INVALID_NATIVE_SCOPE');
            if (Object.hasOwn(scope, 'topicId')) AgentConfigManager.validateId(scope.topicId);
            const runtime = getRuntime();
            if (runtime) {
                if (runtime.closed || !runtime.ready || runtime.isStopping?.()) throw fail('SHARED_STARTUP_PENDING');
                if (!runtime.nativeObject(itemType, itemId)) {
                    throw fail(options != null ? 'SHARED_NATIVE_BINDING_CHANGED' : 'SHARED_LOCAL_MAPPING_REQUIRED');
                }
                const result = await runtime.removeNativeObject(scope, options ?? undefined, { createDefaultTopic, isCurrent: () => getRuntime() === runtime });
                if (!result) throw fail('SHARED_NATIVE_BINDING_CHANGED');
                return result;
            }
            if (options != null) throw fail('SHARED_NATIVE_BINDING_CHANGED');
            // A joined Source covers existing and newly discovered owners. Its
            // durable join must not become local deletion when the runtime stops.
            if (await belongsToSharedRoot(root)) throw fail('SHARED_STARTUP_PENDING');
            const folder = itemType === 'agent' ? 'Agents' : 'AgentGroups';
            const config = await ownedJson(root, path.join(root, folder, itemId, 'config.json'));
            if (!config || typeof config !== 'object' || Array.isArray(config) ||
                (config.topics !== undefined && !Array.isArray(config.topics))) throw fail('HISTORY_OWNER_UNVERIFIED');
            if (config.__nativeSyncSharedBase || config.nativeSyncOriginSource || config.topics?.some(t => t.nativeSyncOriginSource)) {
                throw fail('SHARED_LOCAL_MAPPING_REQUIRED');
            }
            if (getRuntime() !== runtime) throw fail('SHARED_NATIVE_BINDING_CHANGED');
            return null;
        } catch (error) {
            return { success: false, error: error?.code || 'SHARED_DELETE_FAILED' };
        }
    };
}
module.exports = { createOwnerDeletion };

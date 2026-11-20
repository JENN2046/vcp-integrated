'use strict';

const { durableJson } = require('./durableJson');
const { fail } = require('./protocol');
const conversation = require('../conversationContext');

function createTavernRuleProvider(runtime, isCurrent) {
    function baseFor(owner) {
        const object = owner && runtime.nativeObject(owner.type, owner.id);
        if (!object) return null;
        const known = runtime.configs?.state.objects[object.id];
        if (!known) throw fail('SHARED_CONFIG_BASE_REQUIRED');
        return { sharedId: object.id, version: known.version };
    }

    async function resolve(owner) {
        const base = baseFor(owner);
        const result = await conversation.resolve(owner);
        return base ? { ...result, __nativeSyncSharedBase: base } : result;
    }

    return {
        writeJson: durableJson,
        readRules(readStore) {
            if (!runtime.configs) throw fail('SHARED_CONFIG_BASE_REQUIRED');
            // Pair file contents with their materialized version under the replica queue.
            return runtime.configs.serial(async () => ({
                ...await readStore(), __nativeSyncSharedBase: runtime.nativeRulesContext(),
            }));
        },
        saveRules(store, options) {
            // The replica can now enqueue an accepted file write on the native queue
            // without waiting on the IPC operation that is awaiting that same receipt.
            return runtime.serialCore(async () => {
                try {
                    if (!isCurrent() || runtime.closed || runtime.isStopping?.()) throw fail('SHARED_STARTUP_PENDING');
                    return await runtime.saveNativeRules(options
                        ? { ...store, __nativeSyncSharedBase: options.__nativeSyncSharedBase }
                        : store);
                } catch (error) {
                    return { success: false, error: error.code || 'SHARED_CONFIG_CONFLICT' };
                }
            });
        },
        resolve,
        async update(owner, patch) {
            if (patch?.kind !== 'rule' || !baseFor(owner)) return conversation.update(owner, patch);
            try {
                await runtime.saveNativeRuleOverride(owner, patch);
                return await resolve(owner);
            } catch (error) {
                return { success: false, error: error.code || 'SHARED_CONFIG_CONFLICT' };
            }
        },
    };
}

module.exports = { createTavernRuleProvider };

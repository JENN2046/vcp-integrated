'use strict';

const path = require('node:path');
const { belongsToSharedRoot, projectNativeConfig, runtimeForRoot } = require('./sharedHost');
const { sharedConfig } = require('./contracts.generated.cjs');
const { fail, sha256, stable } = require('./protocol');
const AgentConfigManager = require('../../utils/agentConfigManager');
const { ownedJson } = require('./sharedLocal');

const configRoute = '/api/v1/sync/shared/config';
const ownerFolder = { agent: 'Agents', group: 'AgentGroups' };

async function saveNativeOwnerConfig({ root, kind, localId, config, saveLocal, readSaved, invalidate, avatarOnly = false, runtime: attachedRuntime }) {
    try {
        AgentConfigManager.validateId(localId);
        if (!Object.hasOwn(ownerFolder, kind)) throw fail('INVALID_CONFIG');
        if (!config || typeof config !== 'object' || Array.isArray(config)) throw fail('INVALID_CONFIG');
        const runtime = attachedRuntime || runtimeForRoot(root);
        const save = async () => {
            if (runtime && (!runtime.ready || runtime.closed || runtime.isStopping())) throw fail('SHARED_STARTUP_PENDING');
            const file = path.join(root, ownerFolder[kind], localId, 'config.json');
            const native = await ownedJson(root, file, { optional: true });
            const state = runtime?.state;
            if (state && (!state.locals || !state.objects)) throw fail('SHARED_LOCAL_MAPPING_REQUIRED');
            const mapping = state && Object.entries(state.locals).filter(([, local]) => local.kind === kind && local.localId === localId);
            const retired = state?.retiredOwners?.[kind + ':' + localId];
            if (retired) throw fail('SHARED_OBJECT_MERGED');
            if (mapping?.length) {
                const active = mapping.filter(([, local]) => !local.aliasOf);
                if (active.length !== 1) throw fail('SHARED_LOCAL_MAPPING_REQUIRED');
                const [sharedId] = active[0];
                const object = state.objects[sharedId];
                if (!object || object.kind !== kind) throw fail('SHARED_LOCAL_MAPPING_REQUIRED');
                if (object.deleted) throw fail('SHARED_OBJECT_DELETED');
                if (!runtime.isLocalVisible(sharedId)) throw fail('SHARED_LOCAL_REMOVED');
                if (!native || native._historyDeleting) throw fail('SHARED_LOCAL_MAPPING_REQUIRED');
                const { __nativeSyncAvatar: avatar, ...raw } = config;
                const result = await saveShared(runtime, object, localId, raw, avatar, avatarOnly);
                try {
                    invalidate?.();
                    if (readSaved && result.success && !result.refreshError) {
                        const saved = await readSaved();
                        if (!saved || saved.error) throw fail('SHARED_CONFIG_REFRESH_FAILED');
                        result.agentGroup = runtime.decorateNativeConfig(kind, localId, saved);
                    }
                } catch {
                    result.refreshError = 'SHARED_CONFIG_REFRESH_FAILED';
                }
                return result;
            }
            // A joined directory covers every native owner. Discovery must establish
            // the binding before a save can choose an authority.
            if (runtime) throw fail('SHARED_LOCAL_MAPPING_REQUIRED');
            if (Object.hasOwn(config, '__nativeSyncSharedBase') || Object.hasOwn(config, '__nativeSyncSharedOpId') ||
                (!avatarOnly && Object.hasOwn(config, '__nativeSyncAvatar')) ||
                native?.__nativeSyncSharedBase || native?.nativeSyncOriginSource) {
                throw fail('SHARED_STARTUP_PENDING');
            }
            if (!runtime && await belongsToSharedRoot(root)) throw fail('SHARED_STARTUP_PENDING');
            // A shared runtime may have attached while the disk reads were pending.
            if (runtimeForRoot(root) !== runtime) throw fail('SHARED_STARTUP_PENDING');
            if (!native || native._historyDeleting) {
                throw fail(kind === 'agent' ? 'AGENT_DELETED' : 'NATIVE_CONFIG_NOT_AVAILABLE');
            }
            return saveLocal?.() ?? null;
        };
        return await (runtime ? runtime.serialCore(save) : save());
    } catch (error) {
        return { success: false, error: error.code || error.message || 'NATIVE_CONFIG_SAVE_FAILED' };
    }
}

async function saveShared(runtime, object, localId, raw, avatar, avatarOnly) {
    if (runtime.readOnly) throw fail('SHARED_READ_ONLY');
    if (runtime.directoryPaused) throw fail('SHARED_DIRECTORY_PENDING');
    const { id, kind } = object;
    runtime.matching.assert([id]);
    const marker = raw.__nativeSyncSharedBase;
    const accepted = runtime.configs.state.objects[id];
    const draft = runtime.configs.state.drafts[id];
    if (!accepted || !marker || marker.sharedId !== id || !Number.isSafeInteger(marker.version) || marker.version < 1) {
        throw fail('SHARED_CONFIG_BASE_REQUIRED');
    }
    const base = draft?.submitted && draft.nativeSave ? draft.nativeSave.base : accepted.config;
    let avatarIntent;
    if (avatar !== undefined || avatarOnly) {
        const input = avatar?.buffer;
        const bytes = ArrayBuffer.isView(input) ? Buffer.from(input.buffer, input.byteOffset, input.byteLength)
            : input instanceof ArrayBuffer ? Buffer.from(input) : Buffer.alloc(0);
        const key = sha256(stable({ type: String(avatar?.type || ''), bytes: sha256(bytes) }));
        const frozen = draft?.submitted && draft.nativeSave?.avatarIntent;
        if (draft?.submitted && (!frozen || frozen.key !== key || frozen.only !== avatarOnly)) {
            throw fail('SHARED_CONFIG_PENDING_CONFIRMATION');
        }
        if (frozen) {
            avatarIntent = frozen;
        } else {
            try {
                const value = await runtime.host.normalizeAvatar({ type: avatar?.type, buffer: bytes });
                avatarIntent = { key, only: avatarOnly, value: sharedConfig(kind, { ...base, avatar: value }).avatar };
            } catch (error) {
                const avatarResult = { success: false, error: error.code || 'SHARED_AVATAR_FAILED' };
                if (kind === 'agent' || avatarOnly) return { ...avatarResult, avatarResult };
                avatarIntent = { key, only: avatarOnly, error: avatarResult.error };
            }
        }
    } else if (draft?.submitted && draft.nativeSave?.avatarIntent) {
        throw fail('SHARED_CONFIG_PENDING_CONFIRMATION');
    }
    const projected = avatarOnly ? base : projectNativeConfig(runtime, kind, raw, base);
    const value = sharedConfig(kind, avatarIntent?.value ? { ...projected, avatar: avatarIntent.value } : projected);

    let confirmed, refreshError, extrasError;
    let sharedCommitted = false;
    const remember = object => { confirmed = object; sharedCommitted = true; };
    if (draft?.submitted) {
        if (draft.expectedVersion !== marker.version || stable(draft.config) !== stable(value) ||
            (raw.__nativeSyncSharedOpId && raw.__nativeSyncSharedOpId !== draft.opId)) {
            throw fail('SHARED_CONFIG_PENDING_CONFIRMATION');
        }
        // Repeat the frozen submission, including fields omitted by the native form.
        try {
            await runtime.configs.publish(id, { onAccepted: remember });
        } catch (error) {
            if (!confirmed) {
                if (error.code !== 'SHARED_CONFIG_CONFLICT' && (!error.status || error.status >= 500)) {
                    throw fail('SHARED_CONFIG_PENDING_CONFIRMATION');
                }
                throw error;
            }
            refreshError = 'SHARED_CONFIG_REFRESH_FAILED';
        }
    } else {
        const { object: latest } = await runtime.send(configRoute + '?' + new URLSearchParams({
            sharedSpaceId: runtime.connection.sharedSpaceId, sharedId: id,
        }));
        if (latest?.id !== id || latest.kind !== kind) throw fail('SHARED_CONFIG_RESPONSE_INVALID');
        if (latest.deleted) throw fail('SHARED_OBJECT_DELETED');
        runtime.configs.validate(latest);
        if (avatarOnly && marker.version !== latest.version) throw fail('SHARED_CONFIG_CONFLICT');
        const sameConfig = marker.version === accepted.version &&
            (!avatarIntent || marker.version === latest.version) &&
            stable(value) === stable(sharedConfig(kind, accepted.materialized || accepted.config));
        if (sameConfig && !draft && !raw.__nativeSyncSharedOpId) {
            confirmed = accepted;
        } else {
            const opId = raw.__nativeSyncSharedOpId ||
                'native_' + sha256(stable({ id, version: marker.version, value })).slice(0, 40);
            try {
                await runtime.configs.submit(id, kind, value, {
                    expectedVersion: marker.version, opId, nativeSave: { base, ...(avatarIntent ? { avatarIntent } : {}) }, onAccepted: remember,
                });
            } catch (error) {
                if (!confirmed) {
                    const pending = runtime.configs.state.drafts[id];
                    if (pending?.opId === opId && pending.submitted && (!error.status || error.status >= 500)) {
                        throw fail('SHARED_CONFIG_PENDING_CONFIRMATION');
                    }
                    throw error;
                }
                refreshError = 'SHARED_CONFIG_REFRESH_FAILED';
            }
        }
    }
    if (runtime.configs.state.objects[id]?.version < confirmed.version) refreshError = 'SHARED_CONFIG_REFRESH_FAILED';
    try {
        if (runtime.directoryPaused || !runtime.isLocalVisible(id)) throw fail('SHARED_LOCAL_REMOVED');
        if (!avatarOnly) await runtime.configs.serial(() => runtime.host.writeNativeExtras(kind, localId, raw));
    } catch {
        extrasError = 'SHARED_CONFIG_EXTRAS_FAILED';
    }
    if (extrasError && !sharedCommitted) throw fail(extrasError);
    if (sharedCommitted) {
        try {
            runtime.notifyDirectory(runtime.state.objects[id]);
        } catch {
            refreshError = 'SHARED_CONFIG_REFRESH_FAILED';
        }
    }
    let avatarResult;
    if (avatarIntent?.error) {
        avatarResult = { success: false, error: avatarIntent.error };
    } else if (avatarIntent) {
        const subtype = avatarIntent.value.slice('data:image/'.length).split(';', 1)[0];
        avatarResult = { success: true, avatarFileName: 'avatar.' + (subtype === 'jpeg' ? 'jpg' : subtype) };
        if (!refreshError && runtime.configs.state.objects[id]?.version === confirmed.version) {
            try {
                const url = await runtime.host.nativeAvatarUrl(kind, localId);
                if (!url) throw fail('SHARED_CONFIG_REFRESH_FAILED');
                avatarResult.avatarUrl = url + '?v=' + confirmed.version;
            } catch {
                refreshError = 'SHARED_CONFIG_REFRESH_FAILED';
            }
        }
    }
    return {
        success: true, ...(avatarResult ? { avatarResult } : {}), sharedVersion: confirmed.version, model: confirmed.config.model,
        ...(refreshError ? { refreshError } : {}),
        ...(extrasError ? { extrasError } : {}),
    };
}

async function saveNativeOwnerAvatar({ root, kind, localId, data, saveLocal, runtime }) {
    const config = { __nativeSyncAvatar: data };
    if (data && Object.hasOwn(data, '__nativeSyncSharedBase')) {
        config.__nativeSyncSharedBase = data.__nativeSyncSharedBase;
    }
    const result = await saveNativeOwnerConfig({
        root, kind, localId, config, avatarOnly: true, runtime, saveLocal,
    });
    if (!result?.avatarResult) return result;
    const { avatarResult, ...metadata } = result;
    return { ...metadata, ...avatarResult };
}

module.exports = { saveNativeOwnerConfig, saveNativeOwnerAvatar };

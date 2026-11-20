'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { identity, sha256, fail } = require('./protocol');
const { normalizeScope } = require('./sourceScope');
const { attachLocalRecovery } = require('./localAttachment');

const authorities = new WeakMap();
function bindAuthority(owner, authority) { if (authority) authorities.set(owner, authority); }
function authorityFor(owner) { return authorities.get(owner) || null; }
function authorityForQueue(queue) {
    let host;
    try { host = require('../historyAuthority'); }
    catch (error) { if (error.code === 'MODULE_NOT_FOUND' && error.message.includes("'../historyAuthority'")) return null; throw error; }
    return host.authorityForQueue?.(queue) || null;
}

const empty = () => ({ protectAll:false, protectedTopics:[], protectedOwners:[], protectedScopes:[] });
const closed = () => ({ ...empty(), protectAll:true });

// These are the existing non-secret selection and recovery facts. Never read
// desktop authentication settings, create a runtime, or contact a server here.
async function readOwnedJson(root, file) {
    await require('./sourceDirectory').assertHistoryPath(root, file);
    try {
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw fail('SYNC_STATE_ALIAS');
        return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function topic(value) {
    const result = {ownerType:value.ownerType || value.itemType || 'agent', ownerId:value.ownerId || value.itemId, topicId:value.topicId};
    identity({...result,msgId:'_authority'});
    return result;
}
function scopeInto(result, scope) {
    const normalized = normalizeScope(scope);
    if (!normalized) { result.protectAll = true; return; }
    // Include the whole approved predicate, including topics not yet attached.
    for (const t of normalized.topics) result.protectedScopes.push({ownerType:t.ownerType, ownerIds:[t.ownerId], topicIds:[t.topicId]});
}
function stateInto(result, state, root) {
    if (!state) return;
    if (![1,2,3].includes(state.version) || typeof state.deviceId !== 'string' || !state.deviceId || !Array.isArray(state.topics) || !Array.isArray(state.outbox) || !Number.isSafeInteger(state.cursor) || state.cursor < 0 || !state.acked || typeof state.acked !== 'object') throw fail('INVALID_SYNC_STATE');
    if (state.version >= 2 && (state.format !== (state.version === 3 ? 'native-message-intents-v2' : 'native-message-intents-v1') || !state.localCommits || !state.receipts || !Array.isArray(state.inbox) || !state.drift)) throw fail('INVALID_SYNC_STATE');
    result.protectedTopics.push(...state.topics.map(topic));
    if (state.sharedSpaceId) result.protectAll = true;
    if (state.source) {
        const b = state.source.binding;
        const rootHash = sha256(process.platform === 'win32' ? root.toLowerCase() : root);
        if (!b || !['sourceId','spaceId','rootHash'].every(k => typeof b[k] === 'string' && b[k]) || b.deviceId !== state.deviceId || b.rootHash !== rootHash) throw fail('INVALID_SOURCE_BINDING');
        scopeInto(result, b.scope);
        // Unknown and published deletion tickets remain protected even if the
        // attachment list changes; no CDS acknowledgement modifies these facts.
        for (const deletion of Object.values(state.source.deletions || {})) for (const t of deletion.targets || []) {
            if (t.topicId) result.protectedTopics.push(topic(t));
            else { const owner = topic({...t,topicId:'_authority'}); result.protectedOwners.push({ownerType:owner.ownerType,ownerId:owner.ownerId}); }
        }
    }
}
function selectionInto(result, config, root) {
    if (!config) return;
    // A disabled shared connection still contains the durable join intent.
    // The runtime or its local replicas can be removed independently.
    if (config.sharedSpaceId || config.sharedJoinOpId) result.protectAll = true;
    if (config.enabled === false) return;
    if (config.enabled !== true || config.version !== 1 || !Array.isArray(config.topics)) throw fail('INVALID_SYNC_CONNECTION');
    if (config.scopeMode === 'source') {
        if (config.fullSelectionApproved !== true || typeof config.sourceRoot !== 'string' || path.resolve(config.sourceRoot) !== root || !['sourceId','spaceId','deviceId'].every(k => typeof config[k] === 'string' && config[k]) || config.topics.length) throw fail('FULL_SOURCE_BINDING_REQUIRED');
        scopeInto(result, config.sourceScope);
    } else {
        if (config.scopeMode !== undefined && config.scopeMode !== 'selected' || config.historySelectionApproved !== true || !config.topics.length) throw fail('INVALID_SYNC_CONNECTION');
        result.protectedTopics.push(...config.topics.map(topic));
    }
}
async function deriveHistoryProtection({appDataRoot, state} = {}) {
    const result = empty();
    try {
        if (!appDataRoot) return closed();
        const root = path.resolve(appDataRoot);
        const rootStat = await fs.lstat(root);
        if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw fail('SOURCE_PATH_ALIAS');
        const config = await readOwnedJson(root, path.join(root,'.native-sync','connection.json'));
        const local = state === undefined ? await readOwnedJson(root,path.join(root,'.native-sync','state.json')) : state;
        stateInto(result, local, root);
        selectionInto(result, config, root);
        // A disconnected/disabled Shared connection does not authorize an exit.
        // Existing recovery directories retain the full-root recovery fence.
        const shared = path.join(root,'.native-sync','shared');
        await require('./sourceDirectory').assertHistoryPath(root,path.join(shared,'_authority'));
        try { if ((await fs.readdir(shared)).length) result.protectAll = true; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        for (const key of ['protectedTopics','protectedScopes']) result[key] = [...new Map(result[key].map(t => [JSON.stringify(t),t])).values()];
        return result;
    } catch { return closed(); }
}
async function prepareLocalHistoryAuthority({queue, appDataRoot}) {
    // Install the existing recovery policy before any possible CDS spawn.
    let localRecovery, error;
    try { localRecovery = await attachLocalRecovery({queue,statePath:path.join(appDataRoot,'.native-sync','state.json')}); }
    catch (failure) { error = failure; }
    const protection = error ? closed() : await deriveHistoryProtection({appDataRoot,state:localRecovery.state});
    if (protection.protectAll || protection.protectedTopics.length || protection.protectedOwners.length || protection.protectedScopes.length) {
        // Queue owns native History writes even when the optional runtime never
        // loads. Cover connection and Shared recovery facts as well as state.json.
        const previous = queue.syncPolicy;
        const protects = d => {
            const kind = d.itemType || 'agent';
            const owner = d.itemId;
            const topic = d.topicId;
            return protection.protectAll ||
                protection.protectedOwners.some(t => t.ownerType === kind && t.ownerId === owner) ||
                protection.protectedTopics.some(t => t.ownerType === kind && t.ownerId === owner && (!topic || t.topicId === topic)) ||
                protection.protectedScopes.some(scope => (!scope.ownerType || scope.ownerType === kind) &&
                    (!scope.ownerIds || scope.ownerIds.includes(owner)) && (!topic || !scope.topicIds || scope.topicIds.includes(topic)));
        };
        const deny = async d => {
            if (protects(d)) throw fail(error?.code || 'SYNC_STARTUP_RECOVERY_REQUIRED');
        };
        queue.configureSync(Object.assign(Object.create(previous || null), {
            isRecoveryFence: true,
            isEnabled: d => protects(d) || previous?.isEnabled?.(d) === true,
            async beforeMutation(d) { await deny(d); return previous?.beforeMutation?.(d); },
            async beforeWrite(d, options) { await deny(d); return previous?.beforeWrite?.(d, options); },
            async beginDelete(d) { await deny(d); return previous?.beginDelete?.(d); },
            diagnostics: () => previous?.diagnostics?.() || { enabled: false, readOnly: true, degraded: 'SYNC_STARTUP_RECOVERY_REQUIRED' },
        }));
    }
    return {localRecovery, protection, ...(error ? {error} : {})};
}
function assertCovered(authority, d) {
    if (!authority || typeof authority.assertCovered !== 'function') throw fail('HISTORY_SCOPE_TRANSITION_PENDING');
    // Deliberately synchronous: Queue hooks may refuse but must never wait for
    // their own queue to drain via the scope coordinator.
    const result = authority.assertCovered(d);
    if (result && typeof result.then === 'function') throw fail('HISTORY_SCOPE_TRANSITION_PENDING');
}
function withAuthority(authority, reason, operation) {
    if (!authority || typeof authority.withChange !== 'function') throw fail('HISTORY_SCOPE_TRANSITION_PENDING');
    return authority.withChange(operation, {reason});
}
module.exports = {deriveHistoryProtection, prepareLocalHistoryAuthority, assertCovered, withAuthority, bindAuthority, authorityFor, authorityForQueue};

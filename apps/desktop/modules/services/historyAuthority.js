'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const authorities = new Map();
const queues = new WeakMap();
const pending = code => Object.assign(new Error(code), { code, status: 'pending', retryable: false });
const empty = () => ({ protectAll: false, protectedTopics: [], protectedOwners: [], protectedScopes: [], nativeTopics: [], mirrorDeletedTopics: [], mirrorDeletedOwners: [] });
function authorityForConfig(file) {
    const absolute = path.resolve(file);
    for (const [root, authority] of authorities) if (absolute.startsWith(root + path.sep)) return authority;
    return null;
}
function lifecycleIdentity(config) {
    return JSON.stringify({ id: config?.id, deleting: !!config?._historyDeleting,
        topics: (config?.topics || []).map(t => t?.id).sort(), deleted: [...(config?._historyDeletedTopics || [])].sort() });
}
async function assertConfigurationAdmission(file, next) {
    const authority = authorityForConfig(file);
    if (!authority) return;
    let previous;
    try { previous = JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (previous && lifecycleIdentity(previous) !== lifecycleIdentity(next) && !authority.inChange) {
        throw pending('HISTORY_SCOPE_TRANSITION_PENDING');
    }
    if (authority.inChange) authority.assertProof();
}
class HistoryAuthority {
    #context = new AsyncLocalStorage();
    #tail = Promise.resolve();
    #closePromise = null;
    constructor({ queue, deriveProtection = async () => ({ protectAll: true }), lifecycle = null, singleInstance = true, noChildConfirmed = false }) {
        this.queue = queue; this.deriveProtection = deriveProtection; this.lifecycle = lifecycle;
        this.singleInstance = singleInstance; this.noChildConfirmed = noChildConfirmed; this.blocked = true; this.closing = false; this.descriptor = { ...empty(), protectAll: true };
        this.proofSerial = 0; queues.set(queue, this);
        for (const root of Object.values(queue.ownerDirectories)) {
            if (authorities.has(root)) throw pending('HISTORY_AUTHORITY_ALREADY_OWNED');
            authorities.set(root, this);
        }
    }
    get inChange() { return this.#context.getStore()?.active === true; }
    assertProof() { if (!this.inChange || !this.singleInstance) throw pending('HISTORY_SCOPE_TRANSITION_PENDING'); }
    assertNativeAdmission() {
        if (!this.singleInstance || ((this.blocked || this.closing) && !this.inChange)) throw pending('HISTORY_AUTHORITY_PENDING');
    }
    async derive() {
        const descriptor = { ...empty(), ...structuredClone(await this.deriveProtection()) };
        const nativeSyncProtection = structuredClone(descriptor);
        const protectedBySync = (type, id, topic = null) => nativeSyncProtection.protectAll ||
            nativeSyncProtection.protectedOwners.some(t => t.ownerType === type && t.ownerId === id) ||
            nativeSyncProtection.protectedTopics.some(t => t.ownerType === type && t.ownerId === id && (topic === null || t.topicId === topic)) ||
            nativeSyncProtection.protectedScopes.some(s => (!s.ownerType || s.ownerType === type) && (!s.ownerIds || s.ownerIds.includes(id)) && (topic === null || !s.topicIds || s.topicIds.includes(topic)));
        const owners = new Map(), nativeTopics = [];
        for (const [ownerType, root] of Object.entries(this.queue.ownerDirectories)) {
            const stat = await fs.lstat(root);
            if (stat.isSymbolicLink() || !stat.isDirectory() || await fs.realpath(root) !== root) throw pending('HISTORY_ROOT_UNVERIFIED');
            for (const entry of await fs.readdir(root, { withFileTypes: true })) {
                if (!entry.isDirectory()) continue;
                const ownerId = entry.name, configFile = path.join(root, ownerId, 'config.json');
                let config, s;
                try { s = await fs.lstat(configFile); }
                catch (e) { if (e.code === 'ENOENT') continue; throw e; }
                if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1) throw pending('HISTORY_CONFIG_UNVERIFIED');
                config = JSON.parse(await fs.readFile(configFile, 'utf8'));
                if ((config.id !== undefined && config.id !== ownerId) || !Array.isArray(config.topics)) throw pending('HISTORY_CONFIG_UNVERIFIED');
                if (owners.has(ownerId)) throw pending('HISTORY_OWNER_AMBIGUOUS');
                owners.set(ownerId, ownerType);
                if (config._historyDeleting) { descriptor.protectedOwners.push({ ownerType, ownerId }); continue; }
                const deleted = config._historyDeletedTopics || [];
                for (const topicId of deleted) {
                    descriptor.protectedTopics.push({ ownerType, ownerId, topicId });
                    if (!protectedBySync(ownerType, ownerId, topicId)) descriptor.mirrorDeletedTopics.push({ ownerType, ownerId, topicId });
                }
                const ids = new Set();
                for (const t of config.topics) {
                    this.queue.getHistoryPath(ownerId, t.id);
                    if (ids.has(t.id) || deleted.includes(t.id)) throw pending('HISTORY_CONFIG_UNVERIFIED');
                    ids.add(t.id); nativeTopics.push({ ownerType, ownerId, topicId: t.id });
                }
                // Side-child eligibility comes only from its primary marker and current parent.
                const topicsRoot = path.join(this.queue.userDataDir, ownerId, 'topics');
                let children;
                try { children = await fs.readdir(topicsRoot, { withFileTypes: true }); }
                catch (e) { if (e.code === 'ENOENT') continue; throw e; }
                for (const child of children) {
                    if (ownerType !== 'agent' || !child.isDirectory() || !/^sidechat_\d+_[0-9a-f]+$/.test(child.name)) continue;
                    const file = path.join(topicsRoot, child.name, 'sidechat-child.json');
                    try {
                        const markerStat = await fs.lstat(file);
                        if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.nlink !== 1) throw pending('SIDE_CHAT_CHILD_UNVERIFIED');
                        const marker = JSON.parse(await fs.readFile(file, 'utf8'));
                        if (marker.historyDeleting) { descriptor.protectedTopics.push({ ownerType, ownerId, topicId: child.name }); continue; }
                        if (marker.schemaVersion === 1 && marker.ephemeral === true && marker.agentId === ownerId && marker.topicId === child.name &&
                            (marker.parentTopicId === null || ids.has(marker.parentTopicId))) nativeTopics.push({ ownerType, ownerId, topicId: child.name });
                    } catch (e) { if (e.code !== 'ENOENT') throw e; }
                }
            }
        }
        for (const fact of this.queue.settledNativeDeletions()) {
            const {itemType: ownerType, itemId: ownerId, topicId} = fact.descriptor;
            if (topicId || protectedBySync(ownerType, ownerId)) continue;
            const absent = async file => { try { await fs.lstat(file); return false; } catch (e) { if (e.code === 'ENOENT') return true; throw e; } };
            if (!await absent(path.join(this.queue.userDataDir, ownerId)) ||
                !await absent(path.join(this.queue.ownerDirectories.agent, ownerId, 'config.json')) ||
                !await absent(path.join(this.queue.ownerDirectories.group, ownerId, 'config.json'))) continue;
            descriptor.mirrorDeletedOwners.push({ownerType,ownerId});
            descriptor.protectedOwners.push({ownerType,ownerId});
            for (const topicId of fact.topics) {
                descriptor.mirrorDeletedTopics.push({ownerType,ownerId,topicId});
                descriptor.protectedTopics.push({ownerType,ownerId,topicId});
            }
        }
        descriptor.nativeTopics = nativeTopics;
        return descriptor;
    }
    assertCovered(d) {
        if (this.inChange) return;
        const p = this.descriptor, type = d.itemType || d.ownerType || 'agent', id = d.itemId || d.ownerId;
        if (p.protectAll || p.protectedOwners.some(t => t.ownerType === type && t.ownerId === id) ||
            p.protectedTopics.some(t => t.ownerType === type && t.ownerId === id && t.topicId === d.topicId) ||
            p.protectedScopes.some(s => (!s.ownerType || s.ownerType === type) && (!s.ownerIds || s.ownerIds.includes(id)) && (!s.topicIds || s.topicIds.includes(d.topicId)))) return;
        throw pending('HISTORY_SCOPE_TRANSITION_PENDING');
    }
    fault() { this.blocked = true; }
    withChange(operation, options = {}) {
        if (typeof operation !== 'function') throw new TypeError('Authority operation required');
        if (this.inChange) return operation();
        if (this.closing) return Promise.reject(pending('HISTORY_AUTHORITY_PENDING'));
        if (this.queue.isOperationActive()) return Promise.reject(pending('HISTORY_AUTHORITY_LOCK_ORDER'));
        this.blocked = true; // Admission closes synchronously when a transition is requested.
        const task = this.#tail.catch(() => {}).then(async () => {
            if (this.closing) throw pending('HISTORY_AUTHORITY_PENDING');
            if (!this.singleInstance) throw pending('HISTORY_SINGLE_INSTANCE_REQUIRED');
            this.blocked = true;
            await this.queue.drainForAuthority();
            const live = this.lifecycle?.isReady;
            if (!live && (this.lifecycle || !this.noChildConfirmed)) throw pending('HISTORY_AUTHORITY_PENDING');
            // prepare deliberately blocks all Rust writers during publication. This
            // is a temporary derived fence, never a persistent permission fact.
            if (live) await this.lifecycle.prepareHistoryAdmission({ ...empty(), protectAll: true });
            const scope = { active: true, serial: ++this.proofSerial };
            try {
                return await this.#context.run(scope, async () => {
                    const result = await operation();
                    scope.active = false; // Revoke inherited admission before any async drain/derive/activate.
                    await this.queue.drainForAuthority();
                    const descriptor = await this.derive();
                    if (live) await this.lifecycle.activateHistoryAdmission(descriptor);
                    this.descriptor = descriptor; this.blocked = false;
                    return result;
                });
            } finally { scope.active = false; }
        });
        this.#tail = task; return task;
    }
    withHistoryAuthorityChange(change, publish) { return this.withChange(publish, change); }
    refresh() { return this.withChange(async () => {}); }
    releaseAfterQueueDispose() {
        if (!this.queue.disposed || this.lifecycle?.process) throw pending('HISTORY_AUTHORITY_OLD_CHILD_PENDING');
        for (const [root, owner] of authorities) if (owner === this) authorities.delete(root);
        queues.delete(this.queue);
    }
    close() {
        this.closing = true;
        this.blocked = true;
        if (this.#closePromise) return this.#closePromise;
        // Finish accepted scope work before the final all-writer fence; an
        // in-flight refresh must never reactivate a narrower grant after close.
        const task = this.#tail.catch(() => {}).then(async () => {
            this.blocked = true;
            await this.queue.drainForAuthority();
            if (this.lifecycle?.isReady) await this.lifecycle.prepareHistoryAdmission({ ...empty(), protectAll: true });
            // Ownership remains registered until the app and queues are disposed.
        });
        this.#tail = task;
        this.#closePromise = task.catch(error => { this.#closePromise = null; throw error; });
        return this.#closePromise;
    }
}
module.exports = { HistoryAuthority, assertConfigurationAdmission, authorityForConfig, authorityForQueue: queue => queues.get(queue) };

const { authorityForQueue } = require('./historyAuthority');
const fs = require('fs-extra');
const fsp = require('fs/promises');
const path = require('path');
const { randomUUID, createHash } = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

const SIDE_CHAT_CHILD_ID = /^sidechat_\d+_[0-9a-f]+$/;
function failure(code, status = 'denied', cause) {
    return Object.assign(new Error(code, cause ? { cause } : undefined), { code, status, initializationStatus: status });
}
function validateSegment(value) {
    if (typeof value !== 'string' || !value || /[<>:"/\\|?*\x00-\x1f]/.test(value) ||
        value === '.' || value === '..' || /[. ]$/.test(value) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) {
        throw failure('INVALID_HISTORY_ID');
    }
    return value;
}
function conversationKey({ itemId, itemType = 'agent', topicId }) {
    validateSegment(itemId); validateSegment(topicId);
    if (!['agent', 'group'].includes(itemType)) throw failure('INVALID_HISTORY_TYPE');
    return `${itemType}:${itemId}/topic:${topicId}`;
}
const clone = value => structuredClone(value);
const canonical = value => process.platform === 'win32' ? value.toLowerCase() : value;

/** One in-process authority for native History. No cross-process/CDS lock is claimed. */
class HistoryMutationQueue {
    #context = new AsyncLocalStorage();
    #fences = new Map();
    constructor({ userDataDir, agentDir, groupDir, fileWatcher = null, logger = console,
        commitObserver = null, commitFault = () => {}, deletionDrainTimeoutMs = 5000 } = {}) {
        if (!userDataDir) throw new TypeError('HistoryMutationQueue requires userDataDir');
        this.userDataDir = path.resolve(userDataDir);
        this.ownerDirectories = { agent: path.resolve(agentDir || path.join(path.dirname(this.userDataDir), 'Agents')),
            group: path.resolve(groupDir || path.join(path.dirname(this.userDataDir), 'AgentGroups')) };
        this.fileWatcher = fileWatcher; this.logger = logger;
        this.queues = new Map(); this.disposed = false;
        // Optional host integration hooks. NativeSync owns their implementation.
        this.syncPolicy = null; this.commitObserver = commitObserver; this.commitFault = commitFault;
        if (!Number.isFinite(deletionDrainTimeoutMs) || deletionDrainTimeoutMs <= 0 || deletionDrainTimeoutMs > 60000) throw new TypeError('Invalid deletion drain timeout');
        this.deletionDrainTimeoutMs = deletionDrainTimeoutMs;
    }
    configureSync(policy = null, observer = null) { this.syncPolicy = policy; this.commitObserver = observer; }
    isOperationActive() { return this.#context.getStore()?.active === true; }
    async drainForAuthority() {
        if (this.isOperationActive()) throw failure('HISTORY_AUTHORITY_LOCK_ORDER', 'pending');
        await Promise.allSettled([...this.queues.values()]);
    }
    isSyncEnabled(d) { return this.syncPolicy?.isEnabled(d) === true; }
    revision(history) { return createHash('sha256').update(JSON.stringify(history)).digest('hex'); }
    getHistoryPath(itemId, topicId) {
        return path.resolve(this.userDataDir, validateSegment(itemId), 'topics', validateSegment(topicId), 'history.json');
    }
    #key(d) { conversationKey(d); return canonical(this.getHistoryPath(d.itemId, d.topicId)); }
    #ownerKey(d) { return canonical(path.resolve(this.userDataDir, validateSegment(d.itemId))) + path.sep; }
    #assertFence(d) {
        if (this.#fences.has(this.#ownerKey(d)) || this.#fences.has(this.#key(d))) throw failure('HISTORY_DELETION_FENCED');
    }
    run(descriptor, operation) {
        if (this.disposed) return Promise.reject(failure('HISTORY_QUEUE_DISPOSED'));
        try { authorityForQueue(this)?.assertNativeAdmission(); } catch (error) { return Promise.reject(error); }
        const d = { ...descriptor }, key = this.#key(d), parent = this.#context.getStore();
        if (parent?.active && parent.key === key) return Promise.reject(failure('HISTORY_REENTRANT_QUEUE'));
        const previous = this.queues.get(key) || Promise.resolve();
        const current = previous.catch(() => {}).then(async () => {
            const scope = { key, active: true, writes: Promise.resolve() };
            return this.#context.run(scope, async () => {
                let result, originalError, failed = false;
                try { result = await operation(); } catch (error) { failed = true; originalError = error; }
                try {
                    let pending;
                    do { pending = scope.writes; await pending; } while (pending !== scope.writes);
                } catch (error) { if (!failed) { failed = true; originalError = error; } }
                finally { scope.active = false; }
                if (failed) throw originalError;
                return result;
            });
        });
        this.queues.set(key, current);
        current.finally(() => { if (this.queues.get(key) === current) this.queues.delete(key); }).catch(() => {});
        return current;
    }
    async #safeAncestors(root, relativeParts, create = false) {
        // Check the root and every traversed component. A lexical path is not physical identity.
        let current = path.parse(path.resolve(root)).root;
        const parts = path.resolve(root).slice(current.length).split(path.sep).filter(Boolean).concat(relativeParts);
        for (const part of parts) {
            current = path.join(current, part);
            let stat;
            try { stat = await fs.lstat(current); }
            catch (error) {
                if (error.code !== 'ENOENT') throw error;
                if (!create) return false;
                try { await fs.mkdir(current); } catch (e) { if (e.code !== 'EEXIST') throw e; }
                stat = await fs.lstat(current);
            }
            if (stat.isSymbolicLink() || !stat.isDirectory()) throw failure('UNSAFE_HISTORY_ANCESTOR');
        }
        return true;
    }
    async #strictJson(file) {
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw failure('UNSAFE_HISTORY_FILE');
        const handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        try {
            const actual = await handle.stat();
            if (actual.dev !== stat.dev || actual.ino !== stat.ino || actual.nlink !== 1) throw failure('HISTORY_IDENTITY_CHANGED');
            return JSON.parse(await handle.readFile('utf8'));
        } finally { await handle.close(); }
    }
    async #ownerConfiguration(d) {
        validateSegment(d.itemId);
        const type = d.itemType || 'agent';
        if (!['agent', 'group'].includes(type)) throw failure('INVALID_HISTORY_TYPE');
        const root = this.ownerDirectories[type];
        if (!await this.#safeAncestors(root, [d.itemId])) throw failure('HISTORY_OWNER_MISSING');
        const other = this.ownerDirectories[type === 'agent' ? 'group' : 'agent'];
        // Both owner types share UserData. Ambiguous ownership must never authorize a second writer.
        try { await fs.lstat(path.join(other, d.itemId, 'config.json')); throw failure('HISTORY_OWNER_AMBIGUOUS'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        let config;
        try {
            for (let attempt = 0; ; attempt++) {
                try { config = await this.#strictJson(path.join(root, d.itemId, 'config.json')); break; }
                catch (error) {
                    if (attempt >= 7 || !['ENOENT', 'HISTORY_IDENTITY_CHANGED'].includes(error.code)) throw error;
                    // A legitimate config publisher may replace the inode while this strict
                    // reader opens it. Retry only the current primary, never a backup/cache.
                    await new Promise(resolve => setTimeout(resolve, 2));
                }
            }
        }
        catch (error) { throw failure('HISTORY_OWNER_UNVERIFIED', 'denied', error); }
        if (!config || typeof config !== 'object' || Array.isArray(config) || !Array.isArray(config.topics)) throw failure('HISTORY_OWNER_UNVERIFIED');
        if (config.id !== undefined && config.id !== d.itemId) throw failure('HISTORY_OWNER_ID_MISMATCH');
        if (config._historyDeletedTopics !== undefined && (!Array.isArray(config._historyDeletedTopics) || config._historyDeletedTopics.some(id => typeof id !== 'string'))) throw failure('HISTORY_OWNER_UNVERIFIED');
        const ids = config.topics.map(t => validateSegment(t?.id));
        if (new Set(ids.map(canonical)).size !== ids.length) throw failure('HISTORY_DUPLICATE_TOPIC');
        return config;
    }
    async readOwnerConfiguration(d) {
        const config = await this.#ownerConfiguration(d);
        if (config._historyDeleting) throw failure('HISTORY_OWNER_UNVERIFIED');
        return config;
    }
    async readAgentTopicBackup(agentId) {
        validateSegment(agentId);
        const root = this.ownerDirectories.agent;
        if (!await this.#safeAncestors(root, [agentId])) throw failure('HISTORY_OWNER_MISSING');
        try { return await this.#strictJson(path.join(root, agentId, 'config.topic.backup.json')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
    }
    async removeDeletedHistory(d) {
        const topic = d.topicId !== undefined;
        const key = topic ? this.#key(d) : this.#ownerKey(d);
        if (this.#fences.get(key) !== 'pending') throw failure('HISTORY_DELETE_FENCE_REQUIRED');
        const config = await this.#ownerConfiguration(d);
        const marked = topic
            ? config._historyDeletedTopics?.includes(d.topicId) && !config.topics.some(t => t.id === d.topicId)
            : config._historyDeleting === true && config.topics.length === 0;
        if (!marked) throw failure('HISTORY_DELETE_MARKER_REQUIRED');
        const parts = topic ? [d.itemId, 'topics', d.topicId] : [d.itemId];
        if (await this.#safeAncestors(this.userDataDir, parts)) await fs.remove(path.join(this.userDataDir, ...parts));
    }
    async #authorize(d) {
        conversationKey(d); this.#assertFence(d);
        const type = d.itemType || 'agent';
        const config = await this.readOwnerConfiguration(d);
        if ((config._historyDeletedTopics || []).some(id => canonical(id) === canonical(d.topicId))) throw failure('HISTORY_TOPIC_DELETED');
        const ids = config.topics.map(t => t.id);
        if (SIDE_CHAT_CHILD_ID.test(d.topicId) && type === 'agent') {
            if (!await this.#safeAncestors(this.userDataDir, [d.itemId, 'topics', d.topicId])) throw failure('SIDE_CHAT_CHILD_DELETED');
            const marker = await this.#strictJson(path.join(path.dirname(this.getHistoryPath(d.itemId, d.topicId)), 'sidechat-child.json'));
            if (marker?.historyDeleting || marker?.schemaVersion !== 1 || marker.ephemeral !== true || marker.agentId !== d.itemId || marker.topicId !== d.topicId ||
                (marker.parentTopicId !== null && !ids.includes(marker.parentTopicId))) throw failure('SIDE_CHAT_CHILD_UNVERIFIED');
        } else if (ids.filter(id => canonical(id) === canonical(d.topicId)).length !== 1) throw failure('HISTORY_TOPIC_DELETED');
        this.#assertFence(d);
    }
    async assertWritable(descriptor) { await this.#authorize({ ...descriptor }); }
    async inspect(descriptor) {
        const d = { ...descriptor }; conversationKey(d);
        if (!await this.#safeAncestors(this.userDataDir, [d.itemId, 'topics', d.topicId])) return { exists: false };
        let history;
        try { history = await this.#strictJson(this.getHistoryPath(d.itemId, d.topicId)); }
        catch (error) { if (error.code === 'ENOENT') return { exists: false }; throw error; }
        if (!Array.isArray(history)) throw failure('INVALID_HISTORY', 'failure');
        return { exists: true, history, revision: this.revision(history) };
    }
    async read(d) {
        await this.syncPolicy?.beforeRead?.(d);
        const state = await this.inspect(d); return state.exists ? state.history : [];
    }
    readSerialized(descriptor) {
        const d = { ...descriptor }, scope = this.#context.getStore();
        // Shared projections publish by renaming under this queue. Hold the
        // same topic slot across the strict path/open identity check.
        if (scope?.active && scope.key === this.#key(d)) return this.read(d);
        const read = () => this.run(d, () => this.read(d));
        const authority = authorityForQueue(this);
        return authority ? authority.readAfterTransition(read) : read();
    }
    readSnapshot(d) {
        return this.run(d, async () => { const history = await this.read(d); return { history, revision: this.revision(history), syncEnabled: this.isSyncEnabled(d) }; });
    }
    async #publish(d, history, createOnly) {
        await this.#safeAncestors(this.userDataDir, [d.itemId, 'topics', d.topicId], true);
        const file = this.getHistoryPath(d.itemId, d.topicId), temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
        let published = false;
        try {
            const handle = await fsp.open(temp, 'wx', 0o600);
            try {
                await this.commitFault('temporary-opened', { descriptor: clone(d) });
                await handle.writeFile(JSON.stringify(history, null, 2), 'utf8');
                await handle.sync();
                await this.commitFault('temporary-synced', { descriptor: clone(d) });
            } finally { await handle.close(); }
            this.fileWatcher?.signalInternalSave?.();
            await this.commitFault('before-publish', { descriptor: clone(d) });
            if (createOnly) await fs.link(temp, file); else await fs.rename(temp, file);
            published = true;
            await this.commitFault('after-publish', { descriptor: clone(d) });
            if (createOnly) await fs.unlink(temp);
            if (process.platform !== 'win32') {
                const directory = await fsp.open(path.dirname(file), 'r');
                try { await directory.sync(); } finally { await directory.close(); }
            }
            await this.commitFault('directory-synced', { descriptor: clone(d) });
        } catch (error) {
            if (published) throw Object.assign(failure('HISTORY_PUBLISH_OUTCOME_UNKNOWN', 'unknown', error), { published: true });
            throw error;
        } finally { await fs.unlink(temp).catch(() => {}); }
    }
    initializeIfMissing(descriptor, initialHistory = []) {
        if (authorityForQueue(this) && !authorityForQueue(this).inChange) {
            return authorityForQueue(this).withChange(() => this.initializeIfMissing(descriptor, initialHistory));
        }
        const d = { ...descriptor }, snapshot = clone(initialHistory);
        if (!Array.isArray(snapshot)) throw new TypeError('History must be an array');
        return this.run(d, async () => {
            try {
                await this.#authorize(d);
                if (this.syncPolicy?.beforeInitialize) await this.syncPolicy.beforeInitialize(d, {history:snapshot});
                else { await this.syncPolicy?.beforeMutation?.(d); await this.syncPolicy?.beforeWrite?.(d,{initialize:true}); }
                await this.commitFault('initialize-authorized',{descriptor:clone(d)});
                const state = await this.inspect(d);
                if (state.exists) return {success:true,status:'existing',initializationStatus:'existing',created:false,...state};
                let localCommit = null;
                if (snapshot.length && this.isSyncEnabled(d)) {
                    if(!this.syncPolicy.prepareLocalCommit)throw failure('HISTORY_INTENT_PROTOCOL_REQUIRED');
                    const {deriveMessageOperations}=await import('../chat/historyMessageIntent.mjs');
                    localCommit=await this.syncPolicy.prepareLocalCommit(d,{id:randomUUID(),source:'native-history-initialize',nativeOperations:deriveMessageOperations([],snapshot),beforeRevision:this.revision([]),afterRevision:this.revision(snapshot),beforeHistory:[],history:snapshot});
                    await this.commitFault('intent-prepared',{descriptor:clone(d),commitId:localCommit.id});
                }
                try { await this.#publish(d,snapshot,true); }
                catch(error) {
                    if(error.code!=='EEXIST')throw error;
                    if(localCommit)throw Object.assign(failure('HISTORY_INITIALIZATION_CONFLICT','pending'),{commitId:localCommit.id});
                    const winner=await this.inspect(d);
                    if(!winner.exists)throw failure('HISTORY_PUBLISH_OUTCOME_UNKNOWN','unknown');
                    return {success:true,status:'existing',initializationStatus:'existing',created:false,...winner};
                }
                const result={success:true,status:'created',initializationStatus:'created',created:true,history:snapshot,revision:this.revision(snapshot)};
                // Empty initialization creates no message fact, event, ACK or Cursor.
                if(snapshot.length && this.commitObserver && (!this.syncPolicy || this.isSyncEnabled(d))) {
                    try {
                        if(localCommit)await this.commitFault('history-written',{descriptor:clone(d),commitId:localCommit.id});
                        await this.commitObserver({descriptor:clone(d),history:clone(snapshot),revision:this.revision(snapshot),localCommitId:localCommit?.id});
                        result.sync={state:'captured',delivery:localCommit?'pending':'materialized',recoverable:Boolean(localCommit),...(localCommit?{commitId:localCommit.id}:{})};
                    } catch(error) {
                        result.success=false;result.status='pending';result.initializationStatus='pending';
                        result.sync={state:'degraded',delivery:'pending',code:error.code||'SYNC_CAPTURE_FAILED',recoverable:true,...(localCommit?{commitId:localCommit.id}:{})};
                    }
                }
                return result;
            } catch (error) {
                // An exited publisher may leave its temporary hard link. Keep both full
                // files as outcome evidence; never normalize this unknown commit to success.
                if (['UNSAFE_HISTORY_FILE','OWNER_PATH_ALIAS'].includes(error.code)) {
                    const file = this.getHistoryPath(d.itemId, d.topicId), stat = await fs.lstat(file).catch(() => null);
                    if (stat?.isFile() && stat.nlink > 1) {
                        const names = await fs.readdir(path.dirname(file));
                        for (const name of names.filter(n => /^history\.json\.\d+\.[0-9a-f-]{36}\.tmp$/.test(n))) {
                            const temp = await fs.lstat(path.join(path.dirname(file), name));
                            if (temp.dev === stat.dev && temp.ino === stat.ino) throw failure('HISTORY_PUBLISH_OUTCOME_UNKNOWN', 'unknown', error);
                        }
                    }
                }
                const resultStates = ['denied', 'pending', 'unknown', 'failure'];
                error.initializationStatus = resultStates.includes(error.status) ? error.status
                    : /PENDING|RECOVERY|NOT_READY|NOT_REGISTERED|MAPPING_REQUIRED|MATCH_PREPARING/.test(error.code || '') ? 'pending'
                    : /DENIED|READ_ONLY|READONLY|EXCLUDED|FENCED|STARTUP|DELETED|REMOVED/.test(error.code || '') ? 'denied' : 'failure';
                if (!error.status) error.status = error.initializationStatus;
                throw error;
            }
        });
    }
    write(descriptor, history, options = {}) {
        const d = { ...descriptor }, snapshot = clone(history), key = this.#key(d);
        if (!Array.isArray(snapshot)) throw new TypeError('History must be an array');
        const scope = this.#context.getStore();
        if (!scope) return this.run(d, () => this.write(d, snapshot, options));
        if (!scope.active || scope.key !== key) return Promise.reject(failure('HISTORY_WRITER_SCOPE_EXPIRED'));
        const next = scope.writes.then(() => this.#write(d, snapshot, options));
        scope.writes = next; return next;
    }
    async #write(d, history, options) {
        await this.#authorize(d);
        await this.syncPolicy?.beforeMutation?.(d);
        await this.syncPolicy?.beforeWrite?.(d, options);
        await this.inspect(d);
        let localCommit = null;
        if (this.isSyncEnabled(d) && d.syncSource !== 'remote') {
            if (!this.syncPolicy.prepareLocalCommit) throw failure('HISTORY_INTENT_PROTOCOL_REQUIRED');
            const before = options.beforeHistory ?? await this.read(d);
            const { deriveMessageOperations } = await import('../chat/historyMessageIntent.mjs');
            const intent = options.intent || {};
            const operations = intent.operations || deriveMessageOperations(before, history, {deleteIds:intent.deleteIds||[]});
            localCommit = await this.syncPolicy.prepareLocalCommit(d, {
                ...intent, id:intent.id || randomUUID(), nativeOperations:operations,
                source:intent.source || d.category || 'native-queue',
                beforeRevision:this.revision(before),afterRevision:this.revision(history),beforeHistory:before,history,
            });
            await this.commitFault('intent-prepared', {descriptor:clone(d),commitId:localCommit.id});
        }
        let writeWarning = null;
        try {
            if (this.isSyncEnabled(d)) {
                await this.#safeAncestors(this.userDataDir, [d.itemId, 'topics', d.topicId], true);
                this.fileWatcher?.signalInternalSave?.();
                await require('../utils/durableJson').durableJson(this.getHistoryPath(d.itemId,d.topicId), clone(history));
            } else await this.#publish(d, history, false);
        } catch (error) {
            let committed = false;
            if (localCommit) {
                try { const state = await this.inspect(d); committed = state.exists && state.revision === localCommit.afterRevision; }
                catch (readError) { throw Object.assign(failure('HISTORY_COMMIT_OUTCOME_UNKNOWN','unknown',readError),{commitId:localCommit.id}); }
            }
            if (!committed) throw error;
            writeWarning = error.code || 'HISTORY_DURABILITY_UNCERTAIN';
        }
        const result = {success:true,localState:'saved',history,revision:this.revision(history),...(writeWarning?{writeWarning}:{})};
        if (this.commitObserver && (!this.syncPolicy || this.isSyncEnabled(d))) {
            try {
                if(localCommit)await this.commitFault('history-written',{descriptor:clone(d),commitId:localCommit.id});
                await this.commitObserver({descriptor:clone(d),history:clone(history),revision:this.revision(history),localCommitId:localCommit?.id});
                result.sync={state:'captured',delivery:localCommit?(localCommit.operations.length?'pending':'local_only'):'materialized',recoverable:Boolean(localCommit),...(localCommit?{commitId:localCommit.id}:{})};
            } catch(error) {
                result.sync={state:'degraded',delivery:'pending',code:error.code||'SYNC_CAPTURE_FAILED',recoverable:true,...(localCommit?{commitId:localCommit.id}:{})};
                this.logger?.warn?.('[HistoryMutationQueue] sync capture degraded:',result.sync.code);
            }
        }
        return result;
    }
    commitMessages(descriptor, intent) {
        if (!intent || intent.version !== 1 || typeof intent.source !== 'string' || !intent.source || intent.source.length > 128) return Promise.reject(failure('INVALID_MESSAGE_INTENT'));
        return this.mutate(descriptor, async current => {
            const { applyMessageOperations } = await import('../chat/historyMessageIntent.mjs');
            return applyMessageOperations(current,intent.operations);
        }, {expectedRevision:intent.expectedRevision,intent:{...intent}});
    }
    replace(descriptor, history, options = {}) {
        if (!Array.isArray(history)) throw new TypeError('History must be an array');
        const d = { ...descriptor }, snapshot = clone(history);
        if (options.expectedHistory !== undefined && !Array.isArray(options.expectedHistory)) {
            throw new TypeError('Expected history must be an array');
        }
        const baseline = options.expectedHistory === undefined ? undefined : clone(options.expectedHistory);
        return this.run(d, async () => {
            await this.#authorize(d);
            if (this.isSyncEnabled(d)) {
                const current = await this.read(d);
                if (options.expectedRevision !== this.revision(current)) throw failure('HISTORY_REVISION_CONFLICT');
            } else if (baseline !== undefined) {
                const current = await this.read(d);
                if (JSON.stringify(current) !== JSON.stringify(baseline)) throw failure('HISTORY_CONFLICT');
            }
            return this.write(d, snapshot, options);
        });
    }
    mutate(descriptor, transform, options = {}) {
        const d = { ...descriptor };
        if (typeof transform !== 'function') throw new TypeError('History mutation requires a transform');
        return this.run(d, async () => {
            await this.#authorize(d);
            await this.syncPolicy?.beforeMutation?.(d);
            const current = await this.read(d);
            if (options.expectedRevision !== undefined && options.expectedRevision !== this.revision(current)) throw failure('HISTORY_REVISION_CONFLICT');
            return this.write(d, clone(await transform(clone(current))), { ...options, beforeHistory: current });
        });
    }
    async #boundedDrain(promise) {
        let timer;
        try {
            return await Promise.race([promise, new Promise((_, reject) => {
                timer = setTimeout(() => reject(failure('HISTORY_DELETE_DRAIN_PENDING', 'pending')), this.deletionDrainTimeoutMs);
            })]);
        } finally { clearTimeout(timer); }
    }
    settledNativeDeletions() { return [...this.#fences.values()].filter(v => v?.status === 'deleted').map(v => clone(v)); }
    async deleteHistory(target, operation) {
        if (authorityForQueue(this) && !authorityForQueue(this).inChange) {
            return authorityForQueue(this).withChange(() => this.deleteHistory(target, operation));
        }
        const d = { itemType: 'agent', ...target }; validateSegment(d.itemId);
        if (!['agent', 'group'].includes(d.itemType)) throw failure('INVALID_HISTORY_TYPE');
        const key = d.topicId ? this.#key(d) : this.#ownerKey(d);
        if (this.#context.getStore()?.active) throw failure('HISTORY_DELETE_LOCK_ORDER');
        if (this.#fences.get(key) === 'pending') throw failure('HISTORY_DELETION_PENDING', 'pending');
        this.#fences.set(key, 'pending');
        let ticket, deletedTopics = [];
        try {
            if (!d.topicId) {
                try { const config = await this.#strictJson(path.join(this.ownerDirectories[d.itemType], d.itemId, 'config.json')); deletedTopics = (config.topics || []).map(t => validateSegment(t.id)); }
                catch (error) { if (error.code !== 'ENOENT') throw error; }
            }
            await this.#safeAncestors(this.userDataDir, [d.itemId, ...(d.topicId ? ['topics', d.topicId] : [])]);
            await this.#safeAncestors(this.ownerDirectories[d.itemType], [d.itemId]);
            await this.commitFault('deletion-fenced', { descriptor: clone(d) });
            ticket = await this.#boundedDrain(Promise.resolve(this.syncPolicy?.beginDelete?.(d)));
            const pending = [...this.queues].filter(([k]) => d.topicId ? k === key : k.startsWith(key)).map(([,p]) => p);
            await this.#boundedDrain(Promise.allSettled(pending));
            const noop = async () => {};
            const lifecycle = ticket || { beforeConfigUpdate: noop, changed: noop, destructive: noop };
            const result = await operation(lifecycle);
            await ticket?.commit?.(); this.#fences.set(key, {status: 'deleted', descriptor: d, topics: deletedTopics}); return result;
        } catch (error) {
            this.#fences.set(key, 'unknown');
            try { await ticket?.failed?.(error); } catch (e) { throw failure('HISTORY_DELETE_OUTCOME_UNKNOWN', 'unknown', e); }
            if (!error.status) error.status = 'unknown'; throw error;
        }
    }
    diagnostics() { return { disposed: this.disposed, pendingConversations: this.queues.size, fencedTargets: this.#fences.size }; }
    async dispose() { this.disposed = true; await Promise.allSettled([...this.queues.values()]); this.queues.clear(); authorityForQueue(this)?.releaseAfterQueueDispose(); }
}
module.exports = { HistoryMutationQueue, conversationKey };

'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { fail, stable } = require('./protocol');
const { syncHeaders } = require('./syncRequest');
const { sourceRoute } = require('./connection');
const { ownedJson } = require('./sharedLocal');
const { fieldsFrom, projectDesktopReferences } = require('./metadata');
const { durableJson } = require('./durableJson');

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const projectionFile = (directory, sharedId) => path.join(directory, 'core-single', digest(sharedId) + '-projection.json');
const active = new Set(['queued', 'running', 'waiting_approval', 'cancelling']);

class CoreSingleClient {
    static async offlineHistory(queue, descriptor) {
        const policy = queue.syncPolicy;
        if (!['group','agent'].includes(descriptor.itemType) || !policy?.isRecoveryFence ||
            policy.diagnostics?.().degraded !== 'NETWORK_UNAVAILABLE' ||
            !/^[a-zA-Z0-9_-]{1,96}$/.test(policy.sharedSpaceId || '')) return null;
        const root = path.dirname(queue.userDataDir);
        const directory = path.join(root, '.native-sync', 'shared', policy.sharedSpaceId);
        const state = await ownedJson(root, path.join(directory, 'registry.json'), { optional: true });
        if (!state?.coreSingle) return null;
        const owner = Object.entries(state.locals).find(([id, binding]) =>
            binding.kind === descriptor.itemType && binding.localId === descriptor.itemId && !binding.hidden &&
            !binding.aliasOf && state.objects[id] && !state.objects[id].deleted);
        const topic = owner && Object.entries(state.locals).find(([id, binding]) =>
            binding.kind === 'topic' && binding.localParent === descriptor.itemId && binding.localId === descriptor.topicId &&
            !binding.hidden && !binding.aliasOf && !state.objects[id]?.deleted && state.objects[id]?.parentId === owner[0]);
        if (!topic || descriptor.itemType === 'group' && !state.objects[topic[0]].coreGroup) return null;
        const cached = await ownedJson(root, projectionFile(directory, topic[0]), { optional: true });
        if (!cached && descriptor.itemType === 'group') throw fail('CORE_HISTORY_OFFLINE_UNAVAILABLE');
        return cached && { ...cached, syncEnabled: true, core: true, offline: true, revision: queue.revision(cached.history) };
    }

    constructor(runtime) {
        this.runtime = runtime;
        this.previews = new Map();
        this.histories = new Map();
    }

    owns(descriptor) {
        const r = this.runtime;
        if (!r.capabilities?.spaces?.some(workspace => workspace.id === r.connection.sharedSpaceId && workspace.coreSingle === true)) return false;
        if ((descriptor?.itemType || 'agent') === 'agent') return true;
        if (descriptor.itemType !== 'group') return false;
        const mapping = r.mappings().find(({ local, shared }) => [local, shared].some(scope =>
            scope.itemType === 'group' && scope.itemId === descriptor.itemId && scope.topicId === descriptor.topicId));
        return Boolean(mapping && r.state.objects[mapping.sharedId]?.coreGroup);
    }

    mapping(descriptor) {
        const r = this.runtime;
        r.assertSharedAccess();
        const mapping = r.mappings().find(({ local }) => local.itemType === (descriptor.itemType || 'agent') &&
            local.itemId === descriptor.itemId && local.topicId === descriptor.topicId);
        if (!mapping) throw fail('SHARED_LOCAL_MAPPING_REQUIRED');
        if (!r.isLocalVisible(mapping.sharedId)) throw fail('SHARED_LOCAL_REMOVED');
        r.matching.assert([mapping.sharedId, r.state.objects[mapping.sharedId].parentId]);
        return mapping;
    }

    route(mapping, resource) {
        const ids = [this.runtime.connection.sharedSpaceId, mapping.sharedId].map(encodeURIComponent);
        return '/api/plugins/NativeSync/core/' + ids.join('/') + '/' + resource;
    }

    file(mapping, name) {
        return path.join(this.runtime.dir, 'core-single', digest(mapping.sharedId) + '-' + name + '.json');
    }

    async history(descriptor) {
        const mapping = this.mapping(descriptor);
        const existing = this.histories.get(mapping.sharedId);
        if (existing) return existing;
        const task = this.readHistory(mapping);
        this.histories.set(mapping.sharedId, task);
        try { return await task; }
        finally { this.histories.delete(mapping.sharedId); }
    }

    async readHistory(mapping) {
        const r = this.runtime;
        const file = projectionFile(r.dir, mapping.sharedId);
        const cached = await ownedJson(r.root, file, { optional: true });
        const decorate = result => ({ syncEnabled: true, core: true, ...result, revision: r.queue.revision(result.history) });
        try {
            let rows;
            let seq;
            if (cached) {
                const current = new Map(cached.history.map(message => [message.id, message]));
                seq = cached.seq;
                for (;;) {
                    const changes = await r.send(this.route(mapping, 'changes?' + new URLSearchParams({ after: String(seq) })));
                    for (const event of changes.changes) {
                        if (event.message === null) current.delete(event.messageId);
                        else if (event.message) current.set(event.messageId, event.message);
                    }
                    seq = changes.next;
                    if (seq >= changes.head) break;
                }
                rows = [...current.values()].sort((a, b) => a.ordinal - b.ordinal);
            } else {
                rows = [];
                let before;
                for (;;) {
                    const query = new URLSearchParams({ limit: '500', ...(before && { before: String(before) }) });
                    const page = await r.send(this.route(mapping, 'messages?' + query));
                    if (seq !== undefined && seq !== page.seq) throw fail('CORE_SNAPSHOT_CHANGED');
                    seq = page.seq;
                    rows.unshift(...page.messages);
                    if (!page.hasMore || !page.nextBefore) break;
                    before = page.nextBefore;
                }
            }
            const previous = new Map((cached?.history || []).flatMap(m => m.attachments || []).map(item => [item.hash, item]));
            for (const message of rows) {
                message.attachments = await Promise.all(message.attachments.map(async item => {
                    const old = previous.get(item.hash);
                    if (old?.src) return { ...item, src: old.src, _fileManagerData: old._fileManagerData };
                    if (!r.download || !r.storeAttachment) return item;
                    const bytes = await r.download(this.route(mapping, 'blob/' + item.hash));
                    if (digest(bytes) !== item.hash) throw fail('ATTACHMENT_HASH_MISMATCH');
                    const local = await r.storeAttachment(bytes, item.name, mapping.local.itemId, mapping.local.topicId, item.type);
                    return { ...item, src: local.internalPath, _fileManagerData: local };
                }));
            }
            const result = { history: rows, seq };
            r.assertSharedAccess();
            if (cached?.seq !== seq || cached?.history?.length !== rows.length) await durableJson(file, result);
            return decorate(result);
        } catch (error) {
            if (error.code !== 'NETWORK_UNAVAILABLE' || error.status || !cached) throw error;
            return decorate({ ...cached, offline: true });
        }
    }

    async upload(mapping, messageId, item) {
        const r = this.runtime;
        if (!r.attachments) throw fail('ATTACHMENTS_NOT_ENABLED');
        const { file } = await r.attachments.localFile(item);
        const bytes = await fs.readFile(file);
        const hash = digest(bytes);
        const name = path.win32.basename(path.basename(item.name || item._fileManagerData?.name || 'image.png'));
        const prefix = this.route(mapping, 'attachments/uploads');
        const response = await r.send(prefix, { body: {
            requestId: 'file_' + digest(JSON.stringify([messageId, hash, name])),
            name, size: bytes.length, expectedHash: hash,
            ...(item.type && item.type !== 'application/octet-stream' && { type: item.type })
        } });
        const upload = prefix + '/' + response.uploadId;
        for (let offset = response.offset; response.state !== 'ready' && offset < bytes.length; offset += response.chunkSize) {
            await r.send(upload + '/chunks', { body: { offset, data: bytes.subarray(offset, offset + response.chunkSize).toString('base64') } });
        }
        const finished = await r.send(upload + '/finish', { body: {} });
        if (finished.hash !== hash) throw fail('ATTACHMENT_HASH_MISMATCH');
        if (finished.parseError) throw fail(finished.parseError);
        return response.uploadId;
    }

    async announceResources() {
        const r = this.runtime;
        const space = r.capabilities?.spaces?.find(item => item.id === r.connection.sharedSpaceId);
        if (!space?.coreResources) return;
        const { nativeSyncRouteId } = require('./sharedTopicSponsor');
        await r.send('/api/plugins/NativeSync/core/' + encodeURIComponent(space.id) + '/resource-node', {
            body: { routeHash: digest(nativeSyncRouteId) }
        });
    }

    async send(descriptor, message) {
        if (this.runtime.readOnly) throw fail('SHARED_READ_ONLY');
        const projected = projectDesktopReferences(message);
        const references = projected.desktopReferences || [];
        if (references.some(ref => ref.kind !== 'workspace')) throw fail('CORE_RESOURCE_REFERENCE_NOT_SUPPORTED');
        const mapping = this.mapping(descriptor);
        const r = this.runtime;
        return r.execution.run(mapping.sharedId, async () => {
            await this.announceResources();
            const file = this.file(mapping, 'draft');
            let draft = await ownedJson(r.root, file, { optional: true });
            const signature = stable({ text: message.content, attachments: projected.attachments?.map(item => [
                item.name, item.hash || item._fileManagerData?.hash, item.size
            ]) || [], ...(references.length && { desktopReferences: references }) });
            if (draft?.signature && draft.signature !== signature) throw fail('CORE_PREVIOUS_SUBMISSION_UNCONFIRMED');
            if (!draft?.requestId) {
                const requestId = randomUUID();
                const attachments = [];
                for (const item of projected.attachments || []) attachments.push(await this.upload(mapping, requestId, item));
                draft = { requestId, signature, text: message.content, attachments, ...(references.length && { desktopReferences: references }) };
                await durableJson(file, draft);
            }
            let accepted;
            try {
                accepted = await r.send(this.route(mapping, 'send'), { body: {
                    requestId: draft.requestId, text: draft.text, attachments: draft.attachments,
                    ...(draft.desktopReferences?.length && { desktopReferences: draft.desktopReferences })
                } });
            } catch (error) {
                if (error.status >= 400 && error.status < 500 && error.code !== 'REQUEST_ID_REUSED') await durableJson(file, {});
                throw error;
            }
            // Once received, the server identity is authoritative even if the
            // next fetch fails. Keep it available for a retry of this draft.
            const snapshot = await this.history(descriptor).catch(() => ({ history: [] }));
            const userMessage = snapshot.history.find(row => row.id === accepted.messageId) || accepted.message;
            const history = snapshot.history.some(row => row.id === userMessage.id) ? snapshot.history : [...snapshot.history, userMessage];
            await durableJson(file, {});
            this.observe(mapping);
            return { handled: true, success: true, history, userMessage, replyId: 'reply_' + accepted.id,
                serverSession: { executionId: accepted.id }, core: true };
        });
    }

    async invite(descriptor, localAgentId, redo) {
        if (this.runtime.readOnly) throw fail('SHARED_READ_ONLY');
        const mapping = this.mapping(descriptor);
        const member = this.runtime.nativeObject('agent', localAgentId);
        if (!member) throw fail('GROUP_MEMBER_UNAVAILABLE');
        const r = this.runtime;
        return r.execution.run(mapping.sharedId, async () => {
            const file = this.file(mapping, 'draft');
            const signature = stable({ inviteAgentId: member.id, ...(redo && { redo: redo.id }) });
            let draft = await ownedJson(r.root, file, { optional: true });
            if (draft?.signature && draft.signature !== signature) throw fail('CORE_PREVIOUS_SUBMISSION_UNCONFIRMED');
            if (!draft?.requestId) {
                const target = redo && (await this.history(descriptor)).history.find(message => message.id === redo.id);
                if (redo && !target) throw fail('MESSAGE_NOT_FOUND');
                draft = { requestId: randomUUID(), signature, ...(target && { revision: target.revision }) };
                await durableJson(file, draft);
            }
            let accepted;
            try {
                accepted = await r.send(this.route(mapping, redo ? 'messages/' + encodeURIComponent(redo.id) + '/redo' : 'invitations'), {
                    body: { agentId: member.id, requestId: draft.requestId, ...(redo && { revision: draft.revision }) }
                });
            } catch (error) {
                if (error.status >= 400 && error.status < 500 && error.code !== 'REQUEST_ID_REUSED') await durableJson(file, {});
                throw error;
            }
            await durableJson(file, {});
            this.observe(mapping);
            return { ...accepted, success: true, core: true };
        });
    }

    async gameEvent(descriptor, { messageId, event, seats }) {
        const mapping = this.mapping(descriptor);
        return this.runtime.send(this.route(mapping, 'game-event'), { body: { id: messageId, event,
            seats: seats.map(({ name }) => ({ name })) } });
    }

    async gameTurn(descriptor, { agentId, observation, attempt = 0, reminder, model }) {
        if (this.runtime.readOnly) throw fail('SHARED_READ_ONLY');
        const mapping = this.mapping(descriptor);
        const r = this.runtime;
        const member = r.nativeObject('agent', agentId);
        if (!member) throw fail('GROUP_MEMBER_UNAVAILABLE');
        await this.announceResources();
        const requestId = 'game_' + digest(JSON.stringify([mapping.sharedId, observation.decisionId, attempt]));
        const accepted = await r.send(this.route(mapping, 'game-turn'), {
            body: { agentId: member.id, requestId, observation, reminder, ...(model && { model }) }
        });
        this.observe(mapping);
        const { setTimeout } = require('node:timers/promises');
        while (!r.closed) {
            const { works } = await r.send(this.route(mapping, 'works'));
            const work = works.find(item => item.id === accepted.id);
            if (!work) throw fail('GAME_WORK_UNAVAILABLE');
            if (work.status === 'completed') return work;
            if (!active.has(work.status)) throw fail(work.errorCode || 'GAME_WORK_UNSETTLED');
            await setTimeout(250);
        }
        throw fail('HOST_DRAINING');
    }

    groupMode(descriptor) {
        const mapping = this.mapping(descriptor);
        const parentId = this.runtime.state.objects[mapping.sharedId].parentId;
        return this.runtime.configs.state.objects[parentId]?.config?.mode;
    }

    presentJev(mapping, state) {
        if (!state) return state;
        const local = id => id ? this.runtime.localFor(id)?.localId || id : null;
        return { ...state, groupId: mapping.local.itemId, topicId: mapping.local.topicId,
            currentAgentId: local(state.currentAgentId), queue: state.queue.map(local), manualQueue: state.manualQueue.map(local) };
    }

    async jev(descriptor, action, localAgentId) {
        const mapping = this.mapping(descriptor);
        const r = this.runtime;
        const agentId = localAgentId && r.nativeObject('agent', localAgentId)?.id;
        if (localAgentId && !agentId) throw fail('GROUP_MEMBER_UNAVAILABLE');
        this.observe(mapping);
        const result = await r.send(this.route(mapping, 'jev'),
            action ? { body: { action, ...(agentId && { agentId }) } } : undefined);
        return action ? { ...result, state: this.presentJev(mapping, result.state) } : this.presentJev(mapping, result);
    }

    async mutate(descriptor, intent) {
        const edit = intent?.source === 'message-edit';
        const op = intent?.operations?.[0];
        const expected = edit ? op?.expected : op?.expected?.[0];
        if (intent?.operations?.length !== 1 || !expected?.id ||
            !(edit && op.kind === 'edit' || intent.source === 'message-remove' && op.kind === 'delete' && op.ids?.length === 1)) {
            throw fail('CORE_COMMAND_NOT_MIGRATED');
        }
        const mapping = this.mapping(descriptor);
        const current = await this.history(descriptor);
        const target = current.history.find(message => message.id === expected.id);
        const { messagePreconditionValue } = await import('../../chat/historyMessageIntent.mjs');
        if (!target || messagePreconditionValue(target) !== messagePreconditionValue(expected)) throw fail('HISTORY_MESSAGE_CONFLICT');
        await this.runtime.send(this.route(mapping, 'messages/' + encodeURIComponent(target.id)), { body: {
            requestId: 'edit_' + digest(stable([target.id, target.revision, edit ? op.set.content : null])),
            revision: target.revision, remove: !edit, ...(edit && { text: op.set.content })
        } });
        return { ...await this.history(descriptor), handled: true, success: true };
    }

    async compact(descriptor, settings, requestId) {
        const mapping = this.mapping(descriptor);
        if (this.runtime.readOnly) throw fail('SHARED_READ_ONLY');
        const r = this.runtime, file = this.file(mapping, 'compaction-command');
        return r.execution.run('compact:' + mapping.sharedId, async () => {
            const legacy = await ownedJson(r.root, this.file(mapping, 'compaction'), { optional: true });
            if (legacy?.id) {
                const snapshot = await this.history(descriptor);
                const message = snapshot.history.find(item => item.id === legacy.message?.id);
                if (!message || message.content !== legacy.message?.content ||
                    stable(message.contextCompaction) !== stable(fieldsFrom(legacy.message).contextCompaction)) {
                    throw fail('CORE_COMPACTION_LEGACY_PUBLICATION_PENDING');
                }
                await durableJson(this.file(mapping, 'compaction'), {});
                return { success: true, message, history: snapshot.history };
            }
            let body = await ownedJson(r.root, file, { optional: true });
            if (!body?.requestId) {
                const templates = ['contextCompactionPrompt', 'contextCompactionSendPrompt', 'contextCompactionMainPrompt'];
                body = { requestId, model: settings.contextCompactionModel, fallbackModel: settings.contextCompactionFallbackModel || '',
                    ...Object.fromEntries(templates.filter(field => typeof settings[field] === 'string').map(field => [field, settings[field]])) };
                await durableJson(file, body);
            }
            let result;
            try {
                result = await r.send(this.route(mapping, 'compact'), { body });
            } catch (error) {
                if (error.status && !['NETWORK_UNAVAILABLE', 'CORE_COMPACTION_OUTCOME_UNKNOWN', 'CORE_PROVIDER_OUTCOME_UNKNOWN'].includes(error.code)) {
                    await durableJson(file, {});
                }
                throw error;
            }
            const snapshot = await this.history(descriptor);
            const message = snapshot.history.find(item => item.id === result.messageId);
            if (!result?.success || snapshot.seq < result.seq || !message?.contextCompaction) throw fail('SHARED_CHECKPOINT_PROJECTION_CONFLICT');
            await durableJson(file, {});
            return { success: true, message, history: snapshot.history };
        });
    }

    async cancelCompact(descriptor) {
        if (this.runtime.readOnly) throw fail('SHARED_READ_ONLY');
        const mapping = this.mapping(descriptor);
        const file = this.file(mapping, 'compaction-command');
        const pending = await ownedJson(this.runtime.root, file, { optional: true });
        if (!pending?.requestId) return { success: true, cancelRequested: false };
        return this.runtime.send(this.route(mapping, 'compact/cancel'), { body: { requestId: pending.requestId } });
    }

    async control(descriptor, executionId, action, requestId = randomUUID()) {
        const mapping = this.mapping(descriptor);
        const result = await this.runtime.send(this.route(mapping, 'works/' + encodeURIComponent(executionId) + '/' + action),
            { body: { requestId, ...(action === 'release' && { confirmed: true }) } });
        return { ...result, success: true, submitted: result.status === 'cancelling' || result.status === 'cancelled' };
    }

    steer(descriptor, workId, text, requestId) {
        const mapping = this.mapping(descriptor);
        return this.runtime.send(this.route(mapping, 'works/' + encodeURIComponent(workId) + '/steer'),
            { body: { requestId, text } });
    }

    async taskResult(descriptor, workId, taskId) {
        const mapping = this.mapping(descriptor);
        const result = await this.runtime.send(this.route(mapping,
            'works/' + encodeURIComponent(workId) + '/tasks/' + encodeURIComponent(taskId)));
        return { ...result, executionId: workId, task: { nativeTaskId: result.id }, topic: this.topic(mapping) };
    }

    async stopTask(descriptor, workId, taskId) {
        if (this.runtime.readOnly) throw fail('SHARED_READ_ONLY');
        const mapping = this.mapping(descriptor);
        const result = await this.runtime.send(this.route(mapping,
            'works/' + encodeURIComponent(workId) + '/tasks/' + encodeURIComponent(taskId) + '/stop'), { body: {} });
        return { ...result, success: true };
    }

    async setFlowlock(descriptor, action, options = {}) {
        if (this.runtime.readOnly) throw fail('SHARED_READ_ONLY');
        const mapping = this.mapping(descriptor);
        const response = await this.runtime.send(this.route(mapping, 'flowlock'), {
            body: { ...options, action, requestId: randomUUID() }
        });
        this.observe(mapping);
        return { ...response, success: true };
    }

    async status(descriptor) {
        const mapping = this.mapping(descriptor);
        this.observe(mapping);
        const { works, flowlock } = await this.runtime.send(this.route(mapping, 'works'));
        const topic = this.topic(mapping);
        for (const work of works.filter(work => active.has(work.status))) {
            const known = this.previews.get(work.id) || { executionId: work.id, sharedId: mapping.sharedId, text: '',
                connection: 'online', native: { kind: 'shared_session', state: work.status } };
            known.canCancel = work.owner && ['queued', 'running', 'waiting_approval'].includes(work.status);
            this.previews.set(work.id, known);
        }
        return { enabled: true, connection: 'online', topic, coreFlowlock: flowlock,
            executions: works.map(work => ({ ...work, shared: true,
                nativeTasks: (work.tasks || []).map(task => ({ ...task, nativeTaskId: task.id, agentBaseName: task.agent,
                    stopAllowed: work.owner && ['accepted', 'waiting', 'running'].includes(task.state), resultRef: task.revision === 1 ? task.id : null })), state: work.status, requestId: work.id, canCancel: work.owner && active.has(work.status),
                canAbandon: work.owner && work.status === 'review_required' })),
            serverSessions: [...this.previews.values()].filter(item => item.sharedId === mapping.sharedId) };
    }

    topic(mapping) {
        const local = mapping.local;
        return { ownerType: local.itemType, ownerId: local.itemId, topicId: local.topicId };
    }

    observe(mapping) {
        if (this.observer?.key === mapping.sharedId) return;
        this.observer?.controller.abort();
        const controller = new AbortController();
        const observer = { key: mapping.sharedId, controller };
        this.observer = observer;
        this.previews.clear();
        const r = this.runtime;
        const run = async () => {
            const { consumeSharedEvents } = await import('./sharedEventClient.mjs');
            const c = r.connection;
            const url = c.url + sourceRoute(c, this.route(mapping, 'observe'));
            const signal = r.accessController ? AbortSignal.any([controller.signal, r.accessController.signal]) : controller.signal;
            while (!signal.aborted && !r.closed) {
                try {
                    const response = await fetch(url, { headers: {
                        ...syncHeaders(c), Authorization: 'Bearer ' + c.token,
                        'X-NativeSync-Capabilities': 'shared-space-v1'
                    }, signal, redirect: 'error', cache: 'no-store' });
                    await consumeSharedEvents(response, (data, type) => this.onEvent(mapping, data, type), { signal, envelope: true });
                } catch (error) {
                    if (error.code === 'SHARED_EVENT_PERMISSION_REQUIRED' || signal.aborted) break;
                    await require('node:timers/promises').setTimeout(1000, null, { signal }).catch(() => {});
                }
            }
        };
        observer.task = run().catch(() => {}).finally(() => { if (this.observer === observer) this.observer = null; });
    }

    onEvent(mapping, data, type) {
        const r = this.runtime;
        const topic = this.topic(mapping);
        if (type === 'jev_session') {
            r.notifyGroupEvent?.({ ...data, session: this.presentJev(mapping, data.session),
                context: { ...data.context, groupId: topic.ownerId, topicId: topic.topicId } });
            return;
        }
        if (type === 'native_task' || type === 'flowlock_state') { r.notifyExecutionStatus({ topic }); return; }
        if (type === 'change_seq') {
            const local = mapping.local;
            if (data.seq !== this.lastSeq || this.lastKey !== mapping.sharedId) {
                this.lastKey = mapping.sharedId;
                this.lastSeq = data.seq;
                r.notify({ ...topic, ...(local.itemType === 'group' ? { groupId: local.itemId } : { agentId: local.itemId }), revision: 'core:' + data.seq, source: 'native-sync' });
            }
            return;
        }
        if (!data.workId) return;
        const id = data.workId;
        const preview = this.previews.get(id) || { executionId: id, sharedId: mapping.sharedId, text: '',
            connection: 'online', native: { kind: 'shared_session', state: 'running' } };
        if (type === 'work_preview') {
            preview.text = data.text;
            if (data.speaker) preview.speaker = data.speaker;
        }
        if (type === 'delta') preview.text = (preview.text + data.text).slice(-256 * 1024);
        if (type === 'work_state') {
            preview.native.state = data.status;
            if (!active.has(data.status)) this.previews.delete(id);
            else this.previews.set(id, preview);
        } else {
            if (type === 'approval_requested') preview.activity = { type: 'approval', state: 'waiting_approval' };
            if (type === 'approval_settled') preview.activity = { type: 'approval', state: 'running' };
            if (type === 'tool') preview.activity = { type: 'tool', state: data.status === 'dispatched' ? 'started' : 'settled' };
            if (type === 'resident_presentation') { const { workId, ...presentation } = data; preview.presentation = presentation; }
            this.previews.set(id, preview);
        }
        if (type === 'work_state') r.notifyExecutionStatus({ topic });
        if (active.has(preview.native.state)) r.notifyExecutionStatus({ topic, serverSession: structuredClone(preview) });
    }

    async close() {
        this.observer?.controller.abort();
        await this.observer?.task;
    }
}

module.exports = { CoreSingleClient };

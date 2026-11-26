'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const express = require('express');
const { CoreStore, failure } = require('./store');
const { CoreRunner } = require('./runner');
const { DesktopContext } = require('./desktopContext');
const { effectiveContextHistory, isContextCheckpoint, checkpointFailure } = require('@vcp/native-history-window');
const { fieldsFrom } = require('../Plugin/NativeSync/sync/metadata');
const { AttachmentStore } = require('../Plugin/NativeSync/mobile/attachments');
const { attachmentRoutes } = require('../Plugin/NativeSync/mobile/attachmentRoutes');
const { prepareSharedConfiguration } = require('../Plugin/NativeSync/mobile/sharedConfiguration');
const { effectiveRequest } = require('../Plugin/NativeSync/mobile/effectiveContext');
const { sanitize, assertPortableContext } = require('../Plugin/NativeSync/mobile/groupRequest');
const { payloadHash, sessionMarker } = require('../Plugin/NativeSync/mobile/submissionRecovery');
const { nativePacket } = require('../Plugin/NativeSync/mobile/nativePacket');

const capability = 'core-single-v1';
const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
const requireText = value => {
    if (typeof value !== 'string' || value.length > 12000) throw failure('INVALID_MESSAGE_TEXT', 400);
    return value;
};
const integer = (value, defaultValue, min, max) => {
    const result = value === undefined ? defaultValue : Number(value);
    if (!Number.isSafeInteger(result) || result < min || result > max) throw failure('INVALID_CORE_CURSOR', 400);
    return result;
};

class CoreService {
    constructor({ directory, legacyDirectory, workspace, shared, mobile, chat }) {
        if (!shared?.grants.has(workspace) || shared.readOnly || !mobile || shared.coreWorkspace && shared.coreWorkspace !== workspace) throw failure('CORE_WORKSPACE_UNAVAILABLE');
        if (!path.isAbsolute(directory) || directory === path.parse(directory).root) throw failure('CORE_DATA_DIRECTORY_REQUIRED');
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        directory = fs.realpathSync(directory);
        legacyDirectory = fs.realpathSync(legacyDirectory);
        if (directory === legacyDirectory || directory.startsWith(legacyDirectory + path.sep) ||
            legacyDirectory.startsWith(directory + path.sep)) throw failure('CORE_DATA_DIRECTORY_OVERLAP');
        const filename = path.join(directory, 'core.sqlite');
        if (shared.coreStorageId && !fs.existsSync(filename)) throw failure('CORE_DATABASE_IDENTITY_REQUIRED');
        if (fs.existsSync(filename) && (fs.lstatSync(filename).isSymbolicLink() || fs.statSync(filename).nlink !== 1)) {
            throw failure('CORE_DATA_FILE_ALIAS');
        }
        // Activation is for an empty development conversation domain. There is
        // no migration of existing message or execution authority in M1.
        if (shared.db.prepare(`SELECT 1 FROM shared_objects t WHERE t.space_id=? AND t.owner_type='agent' AND (
            EXISTS (SELECT 1 FROM journal j WHERE j.owner_type=t.owner_type AND j.owner_id=t.owner_id AND j.topic_id=t.topic_id)
            OR EXISTS (SELECT 1 FROM shared_admissions a WHERE a.topic_id=t.id)) LIMIT 1`).get(workspace)) {
            throw failure('CORE_DEVELOPMENT_WORKSPACE_NOT_EMPTY');
        }
        this.workspace = workspace;
        this.shared = shared;
        this.mobile = mobile;
        this.desktopContext = new DesktopContext(shared, workspace, chat.config?.webSocketServer);
        this.store = new CoreStore(filename);
        const { db } = this.store;
        if (shared.coreStorageId && shared.coreStorageId !== this.store.storageId) {
            db.close();
            throw failure('CORE_DATABASE_IDENTITY_MISMATCH');
        }
        const attachmentsStore = {
            db,
            findMessage: db.prepare(`SELECT m.* FROM messages m JOIN conversations c ON c.id=m.conversation_id
                WHERE ?='agent' AND c.owner_id=? AND c.id=? AND m.id=?`),
            readSnapshot: fn => fn(),
            readProjected: fn => fn(db).map(row => ({ row, message: this.store.message(row) })),
            projectMessage: row => this.store.message(row)
        };
        this.attachments = new AttachmentStore({ store: attachmentsStore, root: directory, topics: [] });
        this.runner = new CoreRunner({
            store: this.store, chat, allowedAgents: shared.delegationAgents,
            resolveAcceptedTopic: work => this.resolveAcceptedTopic(work),
            buildPacket: (...args) => this.buildPacket(...args),
            sponsor: (...args) => this.deliverSponsoredMessage(...args)
        });
        for (const row of db.prepare('SELECT * FROM conversations').all()) {
            if (row.workspace !== workspace) throw failure('CORE_DATABASE_WORKSPACE_MISMATCH');
        }
        this.runner.recover();
    }

    manages(row) { return row?.owner_type === 'agent' && row.space_id === this.workspace; }

    topic(actor, workspace, key, permission) {
        if (workspace !== this.workspace) throw failure('CORE_WORKSPACE_NOT_ENABLED', 404);
        const row = this.shared.topic(actor, workspace, key, permission);
        if (!this.manages(row)) throw failure('CORE_CONVERSATION_NOT_MIGRATED', 409);
        if (row.id !== key) throw failure('CORE_CONVERSATION_MOVED');
        const topic = { key, workspace, sharedSpaceId: workspace, ownerType: 'agent', ownerId: row.owner_id, topicId: row.topic_id, originSource: row.origin_source };
        this.attachments.topics.set(key, topic);
        return topic;
    }

    resolveAcceptedTopic(work) {
        try {
            const [kind, id] = work.principal.split(':');
            let actor;
            if (kind === 'desktop') {
                const member = this.shared.db.prepare('SELECT source_id FROM shared_members WHERE space_id=? AND device_id=?')
                    .get(this.workspace, id);
                if (!member) return null;
                actor = { kind, principal: work.principal, deviceId: id, sourceId: member.source_id };
            } else if (kind === 'mobile') {
                const session = this.shared.db.prepare('SELECT * FROM mobile_sessions WHERE id=? AND expires>?').get(id, Date.now());
                if (!session) return null;
                actor = this.shared.mobile({ id, scopes: JSON.parse(session.scopes) }, this.workspace, 'execute');
            } else return null;
            return { ...this.topic(actor, this.workspace, work.conversation_id, 'execute'), actor };
        } catch (error) {
            if (error.status >= 400 && error.status < 500) return null;
            throw error;
        }
    }

    async buildPacket(topic, work, config, previousTurn) {
        const history = this.store.history(work);
        if (previousTurn) {
            const indices = history.flatMap((message, index) => message.sourceWorkId === work.id ? [index] : []);
            const insertAt = indices[previousTurn.includedCount];
            if (insertAt !== undefined) {
                history.splice(insertAt, 0, { id: 'draft_' + work.id, role: 'assistant',
                    content: previousTurn.content, timestamp: Date.now() });
            }
        }
        const latest = history.filter(message => message.sourceWorkId === work.id).at(-1)?.id || work.user_message_id;
        const budget = { bytes: 0 };
        const messages = await effectiveRequest(history, config, latest, async message => {
            const parts = message.attachments?.length
                ? await this.attachments.content(topic.key, message, config.imageSupported, budget, { nativeImages: true })
                : [{ type: 'text', text: message.content }];
            return this.desktopContext.appendReferences(message, parts);
        });
        if (config.sponsoredByWorkId) messages.push({ role: 'user', content: '[系统提示:] 本话题收到伙伴留言。请结合上下文回应。' });
        await this.desktopContext.prompt(topic, messages);
        this.runner.agentAssistant.expandResults(topic.key, messages);
        const prepared = sanitize(messages, config.executionPolicy, true);
        assertPortableContext(prepared);
        return nativePacket(prepared, { agentId: topic.ownerId, agentName: config.name, topicId: topic.key }, work.id, {
            model: config.model, stream: config.streamOutput,
            contextTokenLimit: config.contextTokenLimit ?? 32000,
            ...(config.temperature !== undefined && { temperature: config.temperature }),
            ...(config.maxOutputTokens !== undefined && { max_tokens: config.maxOutputTokens })
        });
    }

    async send(topic, principal, body, reauthorize, actor) {
        if (this.runner.draining) throw failure('HOST_DRAINING', 503);
        const { requestId, attachments = [], desktopReferences = [] } = body;
        const text = requireText(body.text);
        if (!Array.isArray(attachments) ||
            (!text.trim() && !attachments.length && !desktopReferences?.length) || Object.keys(body).some(k => !['requestId','text','attachments','desktopReferences'].includes(k))) {
            throw failure('INVALID_CORE_SUBMISSION', 400);
        }
        if (!Array.isArray(desktopReferences) || desktopReferences.length > 8 ||
            desktopReferences.some(ref => ref?.kind !== 'workspace') || desktopReferences.length && actor?.kind !== 'desktop') {
            throw failure('INVALID_DESKTOP_REFERENCE', 400);
        }
        const refs = desktopReferences.length ? fieldsFrom({ desktopReferences }).desktopReferences : [];
        const input = { text, attachments, ...(refs.length && { desktopReferences: refs }) };
        const prior = this.store.replay(principal, requestId, { key: topic.key, op: 'send', input });
        if (prior) return prior;
        const config = await prepareSharedConfiguration(this.mobile.engine.configs, topic, { persist: false, desktopContext: true });
        if (!config) throw failure('CORE_CONFIG_PENDING', 503);
        reauthorize();
        const result = this.store.admit(topic, principal, requestId, input, () => {
            const files = this.attachments.claim(principal, topic.key, attachments);
            for (const file of files) {
                if (file.type.startsWith('image/')) {
                    if (!config.imageSupported) throw failure('MODEL_IMAGE_UNSUPPORTED');
                } else if (!file.extractedText?.trim()) {
                    throw failure('ATTACHMENT_TEXT_UNAVAILABLE', 422);
                }
            }
            return {
                config, attachments: files, desktopReferences: refs.map(ref => ({ ...ref, sourceId: actor.sourceId })),
                ...(principal.startsWith('mobile:') && { recovery: {
                    version: 1, kind: 'message', sessionMarker: sessionMarker(principal.slice(7)),
                    payloadHash: payloadHash({ topicKey: topic.key, kind: 'message', payload: { requestId, ...input } })
                } }),
                link: id => this.attachments.associate({ ...topic, msgId: id }, { attachments: files }, principal)
            };
        });
        this.runner.publish(topic.key, 'change_seq', { seq: result.seq });
        this.runner.wake();
        return result;
    }

    async deliverSponsoredMessage(work, invocation, args) {
        const { resolveDelivery } = require('../Plugin/NativeSync/sync/sharedTopicSponsor');
        const { formatTopicRiverQuote } = require('../Plugin/NativeSync/sync/topicRiverQuote');
        const liveSource = () => {
            const topic = this.resolveAcceptedTopic(work);
            const invocationRow = this.store.db.prepare("SELECT 1 FROM work_invocations WHERE id=? AND work_id=? AND plugin_name='TopicSponsor' AND status='dispatched'")
                .get(invocation?.invocationId, work.id);
            if (!topic || !invocationRow || this.store.work(work.id)?.status !== 'running' || this.runner.draining) {
                throw failure('TOPIC_SPONSOR_SOURCE_REQUIRED', 403);
            }
            return topic;
        };
        const source = liveSource(), senderName = JSON.parse(work.frozen_config_json).name;
        const resolve = topic => resolveDelivery(this.shared, topic.actor,
            this.shared.row(this.workspace, topic.key), senderName, args);
        const initial = resolve(source);
        const target = this.topic(source.actor, this.workspace, initial.target.id, 'execute');
        const config = await prepareSharedConfiguration(this.mobile.engine.configs, target, { persist: false, desktopContext: true });
        const verified = resolve(liveSource());
        if (!config || target.key !== verified.target.id) throw failure('TOPIC_SPONSOR_TARGET_CHANGED');
        const quote = formatTopicRiverQuote(args.river_context);
        const prefix = '[' + senderName + '的发言]';
        const message = quote ? args.message.trimEnd() : args.message;
        const text = [message.startsWith(prefix) ? message : prefix + ':\n' + message, quote,
            args.source_topic_id && '[该发言发送自' + args.source_topic_id + '话题]'].filter(Boolean).join('\n\n');
        const operationId = 'sponsor_' + invocation.invocationId.replaceAll('-', '');
        const result = this.store.admit(target, work.principal, operationId, { text, source: work.id }, () => ({
            config: { ...config, sponsoredByWorkId: work.id }, attachments: [], senderName
        }));
        this.runner.publish(target.key, 'change_seq', { seq: result.seq });
        this.runner.wake();
        return { status: 'success', result: { ...result, operationId, targetSharedId: target.key, sourceSharedId: source.key } };
    }

    receipt(topic, principal, requestId) {
        const work = this.store.db.prepare('SELECT * FROM works WHERE conversation_id=? AND principal=? AND request_id=?')
            .get(topic.key, principal, requestId);
        if (!work) return null;
        const { result_json } = this.store.db.prepare('SELECT result_json FROM idempotency_receipts WHERE principal=? AND op_id=?')
            .get(principal, requestId);
        const { recovery, ...result } = JSON.parse(result_json);
        const message = this.store.message(this.store.db.prepare('SELECT * FROM messages WHERE id=?').get(work.user_message_id));
        return { ...result, id: work.id, topicKey: topic.key, requestId, state: work.status, message, ...(recovery && { recovery }) };
    }

    compactionSource(topic, principal, id) {
        const head = this.store.head(topic.key);
        const { hash } = this.shared.freeze(this.shared.row(topic.workspace, topic.key));
        return createHash('sha256').update(JSON.stringify([principal, topic.workspace, topic.key, id, head, hash])).digest('hex');
    }

    router(resolveActor) {
        const router = express.Router({ mergeParams: true });
        const scope = (req, permission) => {
            const actor = resolveActor(req, req.params.workspace, permission);
            return { actor, topic: this.topic(actor, req.params.workspace, req.params.key, permission) };
        };
        router.post('/:workspace/resource-node', route((req, res) => {
            if (req.params.workspace !== this.workspace) throw failure('CORE_WORKSPACE_NOT_ENABLED', 404);
            const actor = resolveActor(req, this.workspace, 'execute');
            this.desktopContext.announce(actor, req.body?.routeHash);
            res.json({ success: true });
        }));
        router.get('/:workspace/directory', route((req, res) => {
            const { workspace } = req.params;
            if (workspace !== this.workspace) throw failure('CORE_WORKSPACE_NOT_ENABLED', 404);
            const actor = resolveActor(req, workspace, 'read');
            const directory = this.shared.directory(actor, { sharedSpaceId: workspace, after: req.query.after, limit: 128 });
            res.json({ ...directory, objects: directory.objects.filter(object => object.kind === 'agent' || object.topic?.ownerType === 'agent')
                .map(({ id, kind, parentId, deleted, config, name }) => ({ id, kind, parentId, deleted, name: name ?? config?.name })) });
        }));
        const compactionScope = req => {
            const value = scope(req, 'execute');
            if (value.actor.kind !== 'desktop') throw failure('CORE_COMPACTION_DESKTOP_REQUIRED', 403);
            this.shared.authorize(value.actor, value.topic.workspace, 'config');
            return value;
        };
        router.get('/:workspace/:key/compact', route((req, res) => {
            const { actor, topic } = compactionScope(req);
            this.store.requireIdleCompaction(topic.key);
            const history = effectiveContextHistory(this.store.compactionHistory(topic.key));
            if (!history.length) throw failure('CORE_COMPACTION_EMPTY');
            if (history.some(message => message.desktopReferences?.length)) throw failure('CORE_COMPACTION_LIVE_REFERENCES');
            const id = randomUUID();
            res.json({ id, messageId: 'checkpoint_' + id, sourceHash: this.compactionSource(topic, actor.principal, id), history });
        }));
        router.post('/:workspace/:key/compact', route((req, res) => {
            const { actor, topic } = compactionScope(req);
            const { id, sourceHash, message } = req.body || {};
            if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id) || typeof sourceHash !== 'string' ||
                !/^[0-9a-f]{64}$/.test(sourceHash) || message?.id !== 'checkpoint_' + id ||
                !isContextCheckpoint(message) || message.isThinking || message.attachments?.length ||
                typeof message.content !== 'string' || !message.content.trim() ||
                Buffer.byteLength(message.content) > 512000 || checkpointFailure(message.contextCompaction.checkpoint)) {
                throw failure('INVALID_CHECKPOINT_METADATA', 400);
            }
            let metadata;
            try { metadata = fieldsFrom(message).contextCompaction; }
            catch { throw failure('INVALID_CHECKPOINT_METADATA', 400); }
            if (!metadata) throw failure('INVALID_CHECKPOINT_METADATA', 400);
            const result = this.store.command(actor.principal, 'compact_' + id, {
                key: topic.key, sourceHash, content: message.content, metadata
            }, () => {
                this.store.requireIdleCompaction(topic.key);
                if (this.compactionSource(topic, actor.principal, id) !== sourceHash) {
                    throw failure('SHARED_COMPACTION_SOURCE_CHANGED');
                }
                const seq = this.store.insertMessage({
                    id: message.id, key: topic.key, role: 'user', content: message.content, checkpoint: metadata
                });
                return { success: true, messageId: message.id, seq };
            });
            this.runner.publish(topic.key, 'change_seq', { seq: result.seq });
            res.json(result);
        }));
        router.get('/:workspace/:key/messages', route((req, res) => {
            const { topic } = scope(req, 'read');
            const limit = integer(req.query.limit, 100, 1, 500);
            const before = integer(req.query.before, Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER);
            const messages = this.store.snapshot(topic.key, before, limit);
            res.json({ messages, seq: this.store.head(topic.key), nextBefore: messages[0]?.ordinal, hasMore: messages.length === limit });
        }));
        router.get('/:workspace/:key/changes', route((req, res) => {
            const { topic } = scope(req, 'read');
            const after = integer(req.query.after, 0, 0, Number.MAX_SAFE_INTEGER);
            const limit = integer(req.query.limit, 100, 1, 500);
            const changes = this.store.changes(topic.key, after, limit);
            res.json({ changes, next: changes.at(-1)?.seq ?? after, head: this.store.head(topic.key) });
        }));
        router.get('/:workspace/:key/works/:id/tasks', route(async (req, res) => {
            const { topic } = scope(req, 'read');
            const work = this.store.work(req.params.id);
            if (!work || work.conversation_id !== topic.key) throw failure('WORK_NOT_FOUND', 404);
            const tasks = await this.runner.agentAssistant.list(work);
            scope(req, 'read');
            res.json({ tasks });
        }));
        router.get('/:workspace/:key/works/:id/tasks/:taskId', route((req, res) => {
            const { topic } = scope(req, 'read');
            const work = this.store.work(req.params.id);
            if (!work || work.conversation_id !== topic.key) throw failure('WORK_NOT_FOUND', 404);
            res.json(this.runner.agentAssistant.result(work, req.params.taskId));
        }));
        router.post('/:workspace/:key/works/:id/tasks/:taskId/stop', route(async (req, res) => {
            const { actor, topic } = scope(req, 'execute');
            const work = this.store.work(req.params.id);
            if (!work || work.conversation_id !== topic.key) throw failure('WORK_NOT_FOUND', 404);
            if (work.principal !== actor.principal) throw failure('WORK_CONTROL_FORBIDDEN', 403);
            res.json(await this.runner.agentAssistant.stop(work, req.params.taskId));
        }));
        router.get('/:workspace/:key/works', route(async (req, res) => {
            const { actor, topic } = scope(req, 'read');
            const works = this.store.db.prepare(`SELECT id, principal, status, user_message_id AS messageId,
                reply_message_id AS replyId, error_code AS errorCode, created_at AS createdAt
                FROM works WHERE conversation_id=? ORDER BY admitted_seq DESC LIMIT 100`).all(topic.key)
                .map(({ principal, ...work }) => ({ ...work, owner: principal === actor.principal,
                    tools: this.store.db.prepare('SELECT id, plugin_name AS name, status, error_code AS errorCode FROM work_invocations WHERE work_id=?').all(work.id),
 }));
            const tasks = await Promise.all(works.map(work => this.runner.agentAssistant.list(this.store.work(work.id))));
            scope(req, 'read');
            res.json({ works: works.map((work, index) => ({ ...work, tasks: tasks[index] })) });
        }));
        router.get('/:workspace/:key/observe', route((req, res) => {
            const { topic } = scope(req, 'read');
            res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
            res.flushHeaders();
            const write = (name, value) => {
                scope(req, 'read');
                if (!res.writableEnded && !res.write(`event: ${name}\ndata: ${JSON.stringify(value)}\n\n`)) res.end();
            };
            const stop = this.runner.observe(topic.key, (name, value) => {
                try { write(name, value); } catch { res.end(); }
            });
            const timer = setInterval(() => {
                try { write('change_seq', { seq: this.store.head(topic.key) }); } catch { res.end(); }
            }, 10000);
            res.once('close', () => { stop(); clearInterval(timer); });
            write('change_seq', { seq: this.store.head(topic.key) });
        }));
        router.get('/:workspace/:key/receipt', route((req, res) => {
            const { actor, topic } = scope(req, 'read');
            if (typeof req.query.requestId !== 'string') throw failure('INVALID_REQUEST_ID', 400);
            const receipt = this.receipt(topic, actor.principal, req.query.requestId);
            res.json({ executions: receipt ? [receipt] : [] });
        }));
        router.post('/:workspace/:key/send', route(async (req, res) => {
            const { actor, topic } = scope(req, 'execute');
            // Configuration resolution may await native prompt templates. Recheck
            // before admitting if the session or its binding changed meanwhile.
            if (actor.kind === 'mobile') this.mobile.requireSubmissionContext(req);
            await this.send(topic, actor.principal, req.body || {}, () => scope(req, 'execute'), actor);
            res.status(202).json(this.receipt(topic, actor.principal, req.body.requestId));
        }));
        router.post('/:workspace/:key/messages/:id', route((req, res) => {
            const { actor, topic } = scope(req, 'execute');
            const { requestId, revision, text, remove = false } = req.body || {};
            if (!Number.isSafeInteger(revision) || revision < 1 || typeof remove !== 'boolean') throw failure('INVALID_CORE_MUTATION', 400);
            const result = this.store.mutateMessage(topic.key, actor.principal, requestId, req.params.id, {
                revision, delete: remove, ...(!remove && { text: requireText(text) })
            });
            this.runner.publish(topic.key, 'change_seq', { seq: result.seq });
            res.json(result);
        }));
        router.post('/:workspace/:key/works/:id/:action', route((req, res) => {
            const { actor, topic } = scope(req, 'execute');
            const { id, action } = req.params;
            if (action === 'steer') {
                if (this.runner.draining) throw failure('HOST_DRAINING', 503);
                const text = requireText(req.body?.text);
                if (!text.trim()) throw failure('INVALID_MESSAGE_TEXT', 400);
                const result = this.store.steer(topic.key, actor.principal, req.body?.requestId, id, text);
                this.runner.publish(topic.key, 'change_seq', { seq: result.seq });
                return res.status(202).json(result);
            }
            if (!['cancel', 'release'].includes(action)) throw failure('CORE_COMMAND_NOT_MIGRATED', 409);
            if (action === 'release' && req.body?.confirmed !== true) throw failure('WORK_REVIEW_CONFIRMATION_REQUIRED', 400);
            const result = this.store.control(topic.key, actor.principal, req.body?.requestId, id, action);
            if (result.status === 'cancelling') this.runner.cancel(topic.key, id);
            this.runner.publish(topic.key, 'work_state', result);
            this.runner.wake();
            res.json(result);
        }));
        router.use('/:workspace/:key/attachments', attachmentRoutes({
            storage: () => this.attachments,
            authorize: req => {
                if (req.method !== 'GET' && !/^\/uploads(?:\/[^/]+\/(?:chunks|finish))?$/.test(req.path)) {
                    throw failure('CORE_ATTACHMENT_COMMAND_NOT_MIGRATED', 409);
                }
                if (req.path === '/uploads' && ['messageId','attachmentId','frameIndex'].some(key => Object.hasOwn(req.body || {}, key))) {
                    throw failure('INVALID_ATTACHMENT_UPLOAD', 400);
                }
                req.coreActor = scope(req, req.method === 'GET' && !req.path.startsWith('/uploads') ? 'read' : 'execute').actor;
            },
            principal: req => req.coreActor.principal
        }));
        router.get('/:workspace/:key/blob/:hash', route((req, res) => {
            const { actor, topic } = scope(req, 'read');
            const { hash } = req.params;
            const item = this.store.db.prepare(`SELECT b.* FROM attachment_blobs b WHERE b.hash=? AND b.state='ready' AND EXISTS (
                SELECT 1 FROM messages m JOIN json_each(m.attachments_json) a
                WHERE m.conversation_id=? AND m.deleted=0 AND json_extract(a.value,'$.hash')=b.hash)`).get(hash, topic.key);
            if (!item) throw failure('ATTACHMENT_NOT_FOUND', 404);
            this.attachments.spend(actor.principal, item.size);
            res.set({
                'Content-Type': item.type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store',
                ...(!item.type.startsWith('image/') && { 'Content-Disposition': 'attachment' })
            }).end(this.attachments.readBlob(hash));
        }));
        router.use((error, _req, res, next) => {
            if (res.headersSent) return next(error);
            const known = Number.isInteger(error.status);
            if (!known) console.error('[Core] request failed', error.code || error.name);
            res.status(known ? error.status : 503).json({ error: { code: known ? error.code : 'CORE_UNAVAILABLE' } });
        });
        return router;
    }

    beginDrain() { this.runner.beginDrain(); }
    async close() {
        await this.runner.close();
        await this.attachments.close();
        this.store.db.close();
    }
}

module.exports = { CoreService, capability };

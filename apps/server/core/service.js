'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const express = require('express');
const { CoreStore, failure } = require('./store');
const { nativeGamePrompts, isCoreGame, gameDecision } = require('./game');
const { CoreJev, configuredJev } = require('./jev');
const { CoreCdsIndex } = require('./cdsIndex');
const { CoreRunner } = require('./runner');
const { isCoreGroupMode } = require('./group');
const { DesktopContext } = require('./desktopContext');
const { CoreCompaction } = require('./compaction');
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
    constructor({ directory, legacyDirectory, workspace, shared, mobile, chat, agentManager, remoteConfig, cdsBinary = process.env.VCP_CORE_CDS_BINARY, jevService = configuredJev(), gameEnabled = process.env.VCP_CORE_ENABLE_GAME === '1' }) {
        if (shared && (!shared.grants.has(workspace) || shared.readOnly || !mobile || shared.coreWorkspace && shared.coreWorkspace !== workspace)) throw failure('CORE_WORKSPACE_UNAVAILABLE');
        if (!path.isAbsolute(directory) || directory === path.parse(directory).root) throw failure('CORE_DATA_DIRECTORY_REQUIRED');
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        directory = fs.realpathSync(directory);
        if (legacyDirectory) {
            legacyDirectory = fs.realpathSync(legacyDirectory);
            if (directory === legacyDirectory || directory.startsWith(legacyDirectory + path.sep) ||
                legacyDirectory.startsWith(directory + path.sep)) throw failure('CORE_DATA_DIRECTORY_OVERLAP');
        }
        const filename = path.join(directory, 'core.sqlite');
        if (shared?.coreStorageId && !fs.existsSync(filename)) throw failure('CORE_DATABASE_IDENTITY_REQUIRED');
        if (fs.existsSync(filename) && (fs.lstatSync(filename).isSymbolicLink() || fs.statSync(filename).nlink !== 1)) {
            throw failure('CORE_DATA_FILE_ALIAS');
        }
        this.workspace = workspace;
        this.gameEnabled = gameEnabled;
        this.observers = new Set();
        this.mobile = mobile;
        this.store = new CoreStore(filename);
        try {
            this.local = shared ? null : new (require('./localWorkspace').LocalWorkspace)(this.store, workspace, agentManager);
            if (remoteConfig) {
                const bound = this.store.db.prepare("SELECT value FROM core_metadata WHERE key='remote_origin'").get();
                if (bound && bound.value !== remoteConfig.origin) throw failure('CORE_REMOTE_ORIGIN_CHANGED');
                this.remote = new (require('./remoteAccess').RemoteAccess)(this, remoteConfig);
                this.local.remote = this.remote;
                this.store.db.prepare("INSERT OR IGNORE INTO core_metadata VALUES('remote_origin',?)").run(remoteConfig.origin);
            }
        } catch (error) {
            this.store.db.close();
            throw error;
        }
        this.shared = shared || this.local;
        this.desktopContext = new DesktopContext(this.shared, workspace, chat.config?.webSocketServer);
        this.cds = new CoreCdsIndex(directory, cdsBinary);
        const { db } = this.store;
        if (shared?.coreStorageId && shared.coreStorageId !== this.store.storageId) {
            db.close();
            throw failure('CORE_DATABASE_IDENTITY_MISMATCH');
        }
        const attachmentsStore = {
            db,
            findMessage: db.prepare(`SELECT m.* FROM messages m JOIN conversations c ON c.id=m.conversation_id
                WHERE ? IN ('agent','group') AND c.owner_id=? AND c.id=? AND m.id=?`),
            readSnapshot: fn => fn(),
            readProjected: fn => fn(db).map(row => ({ row, message: this.store.message(row) })),
            projectMessage: row => this.store.message(row)
        };
        this.attachments = new AttachmentStore({ store: attachmentsStore, root: directory, topics: [] });
        this.runner = new CoreRunner({
            store: this.store, chat, memoryTool: (...args) => this.memoryTool(...args), attachments: this.attachments, desktopContext: this.desktopContext, allowedAgents: this.shared.delegationAgents,
            resolveAcceptedTopic: work => this.resolveAcceptedTopic(work),
            buildPacket: (...args) => this.buildPacket(...args),
            sponsor: (...args) => this.deliverSponsoredMessage(...args),
            send: (...args) => this.send(...args),
            automaticCompaction: (...args) => this.compaction.automatic(...args),
            isCompacting: key => this.compaction.running.has(key)
        });
        for (const row of db.prepare('SELECT * FROM conversations').all()) {
            if (row.workspace !== workspace) throw failure('CORE_DATABASE_WORKSPACE_MISMATCH');
        }
        this.jev = jevService && new CoreJev(this, jevService, topic => this.configuration(topic));
        if (shared) this.activateHistory();
        else if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='history_import_deletions'").get()) {
            this.historyDeleted = db.prepare(`SELECT 1 FROM history_import_deletions
                WHERE conversation_id=? AND kind IN ('owner','topic') LIMIT 1`);
        }
        this.compaction = new CoreCompaction({ store: this.store, chat,
            sourceHash: (...args) => this.compactionSource(...args),
            publish: (key, type, event) => this.runner.publish(key, type, event),
            onBusy: () => this.runner.flowlock.schedule() });
        this.runner.recover();
    }

    activateHistory() {
        const { db } = this.store;
        const { shared } = this;
        const imported = db.prepare("SELECT 1 FROM sqlite_master WHERE name='history_import_topics' AND type='table'").get();
        const proofs = imported ? db.prepare('SELECT * FROM history_import_topics').all() : [];
        const byId = new Map(proofs.map(proof => [proof.conversation_id, proof]));
        const topics = shared.db.prepare("SELECT * FROM shared_objects WHERE space_id=? AND kind='topic' AND deleted=0").all(this.workspace);
        const newGroups = [];
        for (const row of topics) {
            const proof = byId.get(row.id);
            if (!this.manages(row) && !proof) continue;
            const head = shared.head(row);
            if (proof && (proof.owner_type !== row.owner_type || proof.owner_id !== row.owner_id ||
                proof.topic_id !== row.topic_id || proof.central_head !== head)) {
                throw failure('CORE_HISTORY_SOURCE_CHANGED');
            }
            if (!proof && (head || shared.active(row.id))) throw failure('CORE_DEVELOPMENT_WORKSPACE_NOT_EMPTY');
            if (!proof) continue;
            const legacyJob = shared.db.prepare(`SELECT 1 FROM mobile_executions WHERE topic_key=?
                AND state NOT IN ('completed','failed','cancelled','review_released') LIMIT 1`).get(row.id);
            if (shared.active(row.id) || legacyJob) throw failure('CORE_HISTORY_LEGACY_WORK_UNSETTLED');
            shared.assertNotPrepared([row.id, row.parent_id]);
            if (row.owner_type === 'group' && !this.manages(row)) {
                if (!this.supportsGroup(shared.object(shared.row(this.workspace, row.parent_id)).config)) {
                    throw failure('CORE_GROUP_MODE_NOT_MIGRATED');
                }
                newGroups.push(row);
            }
        }
        if (newGroups.length) shared.atomic(() => {
            for (const row of newGroups) {
                shared.db.prepare('INSERT OR IGNORE INTO shared_core_group_topics VALUES(?)').run(row.id);
                shared.changed(row, 'config');
            }
        });
        if (imported) this.historyDeleted = db.prepare(`SELECT 1 FROM history_import_deletions
            WHERE conversation_id=? AND kind IN ('owner','topic') LIMIT 1`);
    }

    configuration(topic) {
        if (this.local) return this.local.configuration(topic);
        return prepareSharedConfiguration(this.mobile.engine.configs, topic, { persist: false, desktopContext: true });
    }

    groupMode(row) {
        if (row.owner_type !== 'group') return undefined;
        return this.local ? this.local.groupMode(row) : this.shared.object(this.shared.row(this.workspace, row.parent_id)).config.mode;
    }

    supportsGroup(config) {
        const mode = config?.mode;
        return isCoreGroupMode(mode) || mode === 'jev' && Boolean(this.jev) || this.gameEnabled && isCoreGame(config);
    }

    manages(row) { return row?.space_id === this.workspace && (row.owner_type === 'agent' || this.shared.requiresCore(row)); }

    topic(actor, workspace, key, permission) {
        if (workspace !== this.workspace) throw failure('CORE_WORKSPACE_NOT_ENABLED', 404);
        const row = this.shared.topic(actor, workspace, key, permission);
        if (!this.manages(row)) throw failure('CORE_CONVERSATION_NOT_MIGRATED', 409);
        if (row.id !== key) throw failure('CORE_CONVERSATION_MOVED');
        const topicGame = this.groupMode(row) === 'game';
        if (topicGame && (actor.kind !== 'desktop' || actor.sourceId !== row.origin_source)) {
            throw failure('CORE_GAME_ORIGIN_REQUIRED', 403);
        }
        if (this.historyDeleted?.get(key)) throw failure('CORE_CONVERSATION_DELETED', 404);
        const topic = { key, workspace, sharedSpaceId: workspace, ownerType: row.owner_type, ownerId: row.owner_id, topicId: row.topic_id, originSource: row.origin_source, ...(topicGame && { game: true }) };
        this.attachments.topics.set(key, topic);
        return topic;
    }

    liveActor(principal) {
        if (this.local) {
            if (principal === this.local.actor.principal) return this.local.actor;
            if (this.remote) return this.remote.live(principal, 'execute');
            throw failure('WORK_AUTHORITY_REVOKED', 403);
        }
        const [kind, id] = principal.split(':');
        if (kind === 'desktop') {
            const member = this.shared.db.prepare('SELECT source_id FROM shared_members WHERE space_id=? AND device_id=?')
                .get(this.workspace, id);
            if (member) return { kind, principal, deviceId: id, sourceId: member.source_id };
        } else if (kind === 'mobile') {
            const session = this.shared.db.prepare('SELECT * FROM mobile_sessions WHERE id=? AND expires>?').get(id, Date.now());
            if (session) return this.shared.mobile({ id, scopes: JSON.parse(session.scopes) }, this.workspace, 'execute');
        }
        throw failure('WORK_AUTHORITY_REVOKED', 403);
    }

    resolveAcceptedTopic(work) {
        try {
            const actor = this.liveActor(work.principal);
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
        const latest = history.filter(message => message.sourceWorkId === work.id && !message.contextCompaction).at(-1)?.id || work.user_message_id;
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

    async send(topic, principal, body, reauthorize, actor, options = {}) {
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
        const input = { text, attachments, ...(options.flowlock && { flowlock: true }), ...(refs.length && { desktopReferences: refs }) };
        const prior = this.store.replay(principal, requestId, { key: topic.key, op: 'send', input });
        if (prior) return prior;
        const config = await this.configuration(topic);
        if (!config) throw failure('CORE_CONFIG_PENDING', 503);
        if (topic.ownerType === 'group') {
            if (!this.supportsGroup(config.group) || topic.game) throw failure('CORE_GROUP_MODE_NOT_MIGRATED');
            Object.assign(config, { groupId: topic.ownerId, topicId: topic.topicId });
        }
        reauthorize();
        let admitted = false;
        const result = this.store.admit(topic, principal, requestId, input, () => {
            admitted = true;
            const files = this.attachments.claim(principal, topic.key, attachments);
            for (const file of files) {
                if (file.type.startsWith('image/')) {
                    if (!(config.group ? config.imageModels?.length : config.imageSupported)) throw failure('MODEL_IMAGE_UNSUPPORTED');
                } else if (!file.extractedText?.trim()) {
                    throw failure('ATTACHMENT_TEXT_UNAVAILABLE', 422);
                }
            }
            return {
                config, attachments: files, ...(config.group && { senderName: config.executionPolicy?.userName || '用户' }), ...(options.flowlock && { senderName: 'Flowlock' }), desktopReferences: refs.map(ref => ({ ...ref, sourceId: actor.sourceId })),
                ...(principal.startsWith('mobile:') && { recovery: {
                    version: 1, kind: 'message', sessionMarker: sessionMarker(principal.slice(7)),
                    payloadHash: payloadHash({ topicKey: topic.key, kind: 'message', payload: { requestId, text, attachments } })
                } }),
                link: id => this.attachments.associate({ ...topic, msgId: id }, { attachments: files }, principal)
            };
        });
        this.runner.publish(topic.key, 'change_seq', { seq: result.seq });
        if (admitted && config.group?.mode === 'jev') this.jev.input(topic, actor, config, { id: result.messageId, content: text });
        this.runner.wake();
        return result;
    }

    async invite(topic, actor, body, reauthorize, redo, { internal = false, game } = {}) {
        if (this.runner.draining) throw failure('HOST_DRAINING', 503);
        if (topic.ownerType !== 'group' || typeof body.agentId !== 'string' ||
            Object.keys(body).some(key => !['requestId', 'agentId'].includes(key))) throw failure('INVALID_GROUP_INVITATION', 400);
        const input = { inviteAgentId: body.agentId, ...(redo && { redo }), ...(game && { game }) };
        const prior = this.store.replay(actor.principal, body.requestId, { key: topic.key, op: 'send', input });
        if (prior) return prior;
        const config = await this.configuration(topic);
        if (!this.supportsGroup(config?.group) || topic.game && !game) throw failure('CORE_GROUP_MODE_NOT_MIGRATED');
        if (config.group.mode === 'jev' && !internal) throw failure('CORE_JEV_USE_SESSION_COMMAND');
        if (!config.group.members.includes(body.agentId) || !config.agents.some(agent => agent.id === body.agentId && !agent.unavailable)) {
            throw failure('GROUP_MEMBER_UNAVAILABLE', 403);
        }
        reauthorize();
        const result = this.store.admit(topic, actor.principal, body.requestId, input, () => ({
            config: { ...config, inviteAgentId: body.agentId, groupId: topic.ownerId, topicId: topic.topicId,
                ...(game && { game }) },
            ...(actor.kind === 'mobile' && !internal && { recovery: {
                version: 1, kind: 'invitation', sessionMarker: sessionMarker(actor.principal.slice(7)),
                payloadHash: payloadHash({ topicKey: topic.key, kind: 'invitation', payload: body })
            } })
        }));
        if (redo) this.runner.publish(topic.key, 'change_seq', { seq: result.seq });
        this.runner.wake();
        return result;
    }

    gameEvent(topic, actor, body) {
        if (!this.gameEnabled || !topic.game) throw failure('CORE_GAME_TOPIC_REQUIRED');
        if (this.runner.draining) throw failure('HOST_DRAINING', 503);
        const { id, event, seats } = body;
        if (typeof id !== 'string' || !id || id.length > 240 || !event || !Array.isArray(seats) || seats.length !== 3 ||
            typeof event.id !== 'string' && !Number.isSafeInteger(event.id) || Buffer.byteLength(JSON.stringify(body)) > 24 * 1024) {
            throw failure('INVALID_CORE_GAME_EVENT', 400);
        }
        const digest = createHash('sha256').update(id).digest('hex');
        const msgId = 'game_' + digest;
        const result = this.store.command(actor.principal, msgId, { key: topic.key, op: 'gameEvent', id, event, seats }, () => {
            this.store.ensureConversation(topic);
            const seq = this.store.insertMessage({ id: msgId, key: topic.key, role: 'user',
                content: nativeGamePrompts().formatPublicEvent({ event, seats }), senderName: '游戏事件', after: this.store.nextGroupOrdinal(topic.key),
                historyMetadata: { gameEvent: event, gameEventId: id, groupId: topic.ownerId, topicId: topic.key, isGroupMessage: true } });
            return { messageId: msgId, seq };
        });
        this.runner.publish(topic.key, 'change_seq', { seq: result.seq });
        return result;
    }

    async gameTurn(topic, actor, body, authorize) {
        if (!this.gameEnabled || !topic.game) throw failure('CORE_GAME_TOPIC_REQUIRED');
        const { requestId, agentId, observation, reminder = false, model } = body;
        if (typeof reminder !== 'boolean' || model !== undefined && (typeof model !== 'string' || !model.trim() || model.length > 200) ||
            Buffer.byteLength(JSON.stringify(body)) > 64 * 1024) throw failure('INVALID_CORE_GAME_DECISION', 400);
        const game = { ...gameDecision(observation), reminder, ...(model && { model }),
            invitePrompt: nativeGamePrompts().formatInvite({ observation, reminder }) };
        return this.invite(topic, actor, { requestId, agentId }, authorize, null, { internal: true, game });
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
        const resolve = topic => this.local ? this.local.resolveSponsor(topic, senderName, args) : resolveDelivery(this.shared, topic.actor,
            this.shared.row(this.workspace, topic.key), senderName, args);
        const initial = resolve(source);
        const target = this.topic(source.actor, this.workspace, initial.target.id, 'execute');
        const config = await this.configuration(target);
        const verified = resolve(liveSource());
        if (!config || target.key !== verified.target.id) throw failure('TOPIC_SPONSOR_TARGET_CHANGED');
        const quote = formatTopicRiverQuote(args.river_context);
        const prefix = '[' + senderName + '的发言]';
        const message = quote ? args.message.trimEnd() : args.message;
        const text = [message.startsWith(prefix) ? message : prefix + ':\n' + message, quote,
            args.source_topic_id && '[该发言发送自' + args.source_topic_id + '话题]'].filter(Boolean).join('\n\n');
        const operationId = 'sponsor_' + invocation.invocationId.replaceAll('-', '');
        const result = this.store.admit(target, work.principal, operationId, { text, source: work.id }, () => ({
            config: { ...config, sponsoredByWorkId: work.id }, attachments: [], senderName, senderRole: 'assistant'
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
        const message = JSON.parse(work.frozen_config_json).inviteAgentId ? undefined : this.store.message(this.store.db.prepare('SELECT * FROM messages WHERE id=?').get(work.user_message_id));
        return { ...result, id: work.id, topicKey: topic.key, requestId, state: work.status, ...(message && { message }), ...(recovery && { recovery }) };
    }

    compactionSource(topic, principal, id) {
        const head = this.store.head(topic.key);
        const { hash } = this.shared.freeze(this.shared.row(topic.workspace, topic.key));
        return createHash('sha256').update(JSON.stringify([principal, topic.workspace, topic.key, id, head, hash])).digest('hex');
    }

    async memoryTool(topic, name, args, config) {
        const actor = this.liveActor(topic.actor.principal);
        const authorized = this.topic(actor, topic.workspace, topic.key, 'read');
        const desktop = path.resolve(path.dirname(require.resolve('@vcp/native-history-window')), '../../..');
        const plugins = path.join(desktop, 'VCPDistributedServer', 'Plugin');
        if (name === 'DeepMemo') {
            const { processToolCall } = require(path.join(plugins, 'DeepMemo/DeepMemoService'));
            const result = await processToolCall(args, { vcpContext: {
                agentId: topic.ownerId, ownerType: topic.ownerType, topicId: topic.key
            } }, { config, search: request => this.searchMemories(authorized, actor, request) });
            this.topic(this.liveActor(topic.actor.principal), topic.workspace, topic.key, 'read');
            return result;
        }
        const { processToolCall } = require(path.join(plugins, 'TopicMemo/TopicMemo'));
        return processToolCall(args, null, {
            userName: '用户',
            findAgent: query => {
                if (typeof query !== 'string') throw failure('INVALID_MEMORY_QUERY', 400);
                if (this.local) return this.local.findAgent(query, this.historyDeleted);
                const row = this.shared.db.prepare(`SELECT * FROM shared_objects
                    WHERE space_id=? AND kind='agent' AND deleted=0 ORDER BY id`).all(topic.workspace)
                    .find(item => this.shared.object(item).config.name.includes(query));
                if (!row) return null;
                const topics = this.shared.db.prepare(`SELECT * FROM shared_objects
                    WHERE parent_id=? AND space_id=? AND kind='topic' AND deleted=0 ORDER BY id`).all(row.id, topic.workspace)
                    .filter(value => this.manages(value) && !this.historyDeleted?.get(value.id))
                    .map(value => {
                        this.topic(actor, topic.workspace, value.id, 'read');
                        const config = this.shared.object(value).config;
                        return { id: value.id, name: config.name, createdAt: config.createdAt };
                    });
                return { name: this.shared.object(row).config.name, uuid: row.id, topics };
            },
            history: ({ agentId, topicId }) => {
                const owner = this.topic(actor, topic.workspace, topicId, 'read');
                if (owner.ownerId !== agentId) throw failure('CORE_TOPIC_OWNER_MISMATCH', 403);
                return this.store.compactionHistory(topicId);
            }
        });
    }

    searchMemories(topic, actor, request) {
        const query = request?.query;
        if (typeof query !== 'string' || !query.trim() || query.length > 4096) throw failure('INVALID_MEMORY_QUERY', 400);
        const objectRows = this.local ? this.local.topicRows(topic.ownerType, topic.ownerId) : this.shared.db.prepare(`SELECT * FROM shared_objects
            WHERE space_id=? AND owner_type=? AND owner_id=? AND kind='topic' AND deleted=0 ORDER BY id`)
            .all(topic.workspace, topic.ownerType, topic.ownerId);
        const rows = objectRows.filter(row => this.manages(row) && !this.historyDeleted?.get(row.id)).map(row => {
            this.shared.topic(actor, topic.workspace, row.id, 'read');
            const messages = this.store.compactionHistory(row.id).map(({ id, role, content, timestamp, name, agentId }) =>
                ({ id, role, content, timestamp, ...(name && { name }), ...(agentId && { agentId }) }));
            return { id: row.id, name: this.local ? this.local.definition(row).name : this.shared.object(row).config.name, messages };
        });
        const params = {
            query,
            excludeCurrentTopic: request.excludeCurrentTopic === true,
            windowBefore: integer(request.windowBefore, 2, 0, 50),
            windowAfter: integer(request.windowAfter, 2, 0, 50),
            candidateLimit: integer(request.candidateLimit, 50, 1, 500),
            resultLimit: integer(request.resultLimit, 8, 1, 100),
            maxChars: integer(request.maxChars, 60000, 1, 1000000)
        };
        return this.cds.search(topic, rows, params);
    }

    checkStorage(req) {
        const expected = req.get('x-vcp-core-storage-id');
        if (expected !== undefined && expected !== this.store.storageId) throw failure('CORE_DATABASE_IDENTITY_MISMATCH');
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
        if (this.local) {
            router.get('/:workspace/identity', route((req, res) => {
                const actor = resolveActor(req, req.params.workspace, 'read');
                this.local.authorize(actor, req.params.workspace);
                res.set('Cache-Control', 'no-store').json({ workspace: this.workspace, storageId: this.store.storageId });
            }));
            router.get('/:workspace/memo-agent', route((req, res) => {
                const actor = resolveActor(req, req.params.workspace, 'read');
                this.local.authorize(actor, req.params.workspace);
                if (typeof req.query.name !== 'string' || !req.query.name.trim() || req.query.name.length > 200) throw failure('INVALID_MEMORY_QUERY', 400);
                res.json({ agent: this.local.findAgent(req.query.name, this.historyDeleted) });
            }));
            const mutationActor = req => {
                if (this.runner.draining) throw failure('HOST_DRAINING', 503);
                const actor = resolveActor(req, req.params.workspace, 'config');
                this.local.authorize(actor, req.params.workspace, 'config');
                return actor;
            };
            router.put('/:workspace/:key/definition', route(async (req, res) => {
                const actor = mutationActor(req);
                res.json(await this.local.define(req.params.key, req.body, config => this.supportsGroup(config), actor, () => mutationActor(req)));
            }));
            router.put('/:workspace/agents/:id', route(async (req, res) => {
                mutationActor(req);
                res.json(await this.local.defineAgent(req.params.id, req.body, () => mutationActor(req)));
            }));
            router.post('/:workspace/remove-definition', route((req, res) => {
                const actor = mutationActor(req);
                const { kind, id, topicId, requestId } = req.body || {};
                if (topicId !== undefined && (typeof topicId !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(topicId))) throw failure('INVALID_CORE_TOPIC', 400);
                const key = topicId === undefined ? null : require('./localWorkspace').localTopicKey(kind, id, topicId);
                const result = this.local.remove(kind, id, key, actor, requestId, topicKey => {
                    const work = this.store.db.prepare(`SELECT 1 FROM works WHERE conversation_id=? AND
                        status IN ('queued','running','waiting_approval','cancelling','review_required') LIMIT 1`).get(topicKey);
                    if (work || this.compaction.running.has(topicKey)) throw failure('CORE_TOPIC_BUSY');
                });
                for (const topic of result.removed) {
                    this.runner.publish(topic.id, 'change_seq', { seq: this.store.head(topic.id) });
                    this.attachments.topics.delete(topic.id);
                }
                this.runner.flowlock.schedule();
                res.json(result);
            }));
            router.get('/:workspace/desktop-directory', route((req, res) => {
                const actor = resolveActor(req, req.params.workspace, 'read');
                this.local.authorize(actor, req.params.workspace, 'read');
                if (actor.kind !== 'desktop') throw failure('CORE_DESKTOP_REQUIRED', 403);
                let canConfigure = true;
                try { this.local.authorize(actor, req.params.workspace, 'config'); }
                catch (error) {
                    if (error.status !== 403) throw error;
                    canConfigure = false;
                }
                res.json(this.local.desktopDirectory(this.historyDeleted, canConfigure));
            }));
        }
        router.get('/:workspace/directory', route((req, res) => {
            const { workspace } = req.params;
            if (workspace !== this.workspace) throw failure('CORE_WORKSPACE_NOT_ENABLED', 404);
            const actor = resolveActor(req, workspace, 'read');
            const directory = this.shared.directory(actor, { sharedSpaceId: workspace, after: req.query.after, limit: 128 });
            res.json({ ...directory, objects: directory.objects.filter(object => !this.historyDeleted?.get(object.id) &&
                (object.kind === 'agent' || object.topic?.ownerType === 'agent' || object.coreGroup))
                .map(({ id, kind, parentId, deleted, config, name }) => ({ id, kind, parentId, deleted, name: name ?? config?.name })) });
        }));
        const compactionScope = req => {
            const value = scope(req, 'execute');
            if (value.topic.ownerType !== 'agent') throw failure('CORE_GROUP_COMPACTION_NOT_MIGRATED');
            if (value.actor.kind !== 'desktop') throw failure('CORE_COMPACTION_DESKTOP_REQUIRED', 403);
            this.shared.authorize(value.actor, value.topic.workspace, 'config');
            return value;
        };
        router.get('/:workspace/:key/compact', route((req, _res) => {
            compactionScope(req);
            throw failure('CORE_COMPACTION_EXECUTION_MOVED');
        }));
        router.post('/:workspace/:key/compact', route(async (req, res) => {
            const { actor, topic } = compactionScope(req);
            if (this.runner.draining) throw failure('HOST_DRAINING', 503);
            res.json(await this.compaction.manual(topic, actor, req.body || {}, () => compactionScope(req)));
        }));
        router.post('/:workspace/:key/compact/cancel', route((req, res) => {
            const { actor, topic } = compactionScope(req);
            res.json(this.compaction.cancel(topic, actor, req.body?.requestId));
        }));
        router.post('/:workspace/:key/game-event', route((req, res) => {
            const { topic, actor } = scope(req, 'execute');
            res.json(this.gameEvent(topic, actor, req.body || {}));
        }));
        router.post('/:workspace/:key/game-turn', route(async (req, res) => {
            const { topic, actor } = scope(req, 'execute');
            await this.gameTurn(topic, actor, req.body || {}, () => scope(req, 'execute'));
            res.status(202).json(this.receipt(topic, actor.principal, req.body.requestId));
        }));
        router.post('/:workspace/:key/memories', route(async (req, res) => {
            const { actor, topic } = scope(req, 'read');
            const result = await this.searchMemories(topic, actor, req.body);
            scope(req, 'read');
            res.json(result);
        }));
        router.get('/:workspace/:key/messages', route((req, res) => {
            const { topic } = scope(req, 'read');
            const limit = integer(req.query.limit, 100, 1, 500);
            const before = req.query.before === undefined ? Number.MAX_SAFE_INTEGER : Number(req.query.before);
            if (!Number.isFinite(before) || before < 1 || before > Number.MAX_SAFE_INTEGER ||
                !Number.isInteger(before) && before % 1 !== 0.5) throw failure('INVALID_CORE_CURSOR', 400);
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
                FROM works WHERE conversation_id=? ORDER BY admitted_seq DESC,rowid DESC LIMIT 100`).all(topic.key)
                .map(({ principal, ...work }) => ({ ...work, owner: principal === actor.principal,
                    tools: this.store.db.prepare('SELECT id, plugin_name AS name, status, error_code AS errorCode FROM work_invocations WHERE work_id=?').all(work.id),
 }));
            const tasks = await Promise.all(works.map(work => this.runner.agentAssistant.list(this.store.work(work.id))));
            scope(req, 'read');
            res.json({ works: works.map((work, index) => ({ ...work, tasks: tasks[index] })),
                flowlock: this.runner.flowlock.state(topic.key, actor.principal) });
        }));
        router.post('/:workspace/:key/flowlock', route((req, res) => {
            const { topic, actor } = scope(req, 'execute');
            if (topic.ownerType !== 'agent') throw failure('CORE_GROUP_FLOWLOCK_NOT_MIGRATED');
            if (this.runner.draining) throw failure('HOST_DRAINING', 503);
            res.json(this.runner.flowlock.control(topic, actor.principal, req.body || {}));
        }));
        router.get('/:workspace/:key/observe', route((req, res) => {
            const { topic } = scope(req, 'read');
            if (this.runner.draining) throw failure('HOST_DRAINING', 503);
            this.observers.add(res);
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
            res.once('close', () => { this.observers.delete(res); stop(); clearInterval(timer); });
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
            if (actor.kind === 'mobile') (this.mobile || this.remote).requireSubmissionContext(req);
            await this.send(topic, actor.principal, req.body || {}, () => scope(req, 'execute'), actor);
            res.status(202).json(this.receipt(topic, actor.principal, req.body.requestId));
        }));
        const jevScope = (req, permission) => {
            const { actor, topic } = scope(req, permission);
            if (!this.jev || topic.ownerType !== 'group' ||
                this.groupMode(this.shared.row(topic.workspace, topic.key)) !== 'jev') {
                throw failure('CORE_JEV_TOPIC_REQUIRED');
            }
            return { actor, topic };
        };
        router.get('/:workspace/:key/jev', route((req, res) => {
            const { topic } = jevScope(req, 'read');
            res.json(this.jev.native.getState(topic.ownerId, topic.key));
        }));
        router.post('/:workspace/:key/jev', route(async (req, res) => {
            const { actor, topic } = jevScope(req, 'execute');
            if (!['start','continue','invite','stop'].includes(req.body?.action)) throw failure('INVALID_JEV_COMMAND', 400);
            res.json(await this.jev.command(topic, actor, req.body.action, req.body.agentId));
        }));
        router.post('/:workspace/:key/invitations', route(async (req, res) => {
            const { actor, topic } = scope(req, 'execute');
            if (actor.kind === 'mobile') (this.mobile || this.remote).requireSubmissionContext(req);
            await this.invite(topic, actor, req.body || {}, () => scope(req, 'execute'));
            res.status(202).json(this.receipt(topic, actor.principal, req.body.requestId));
        }));
        router.post('/:workspace/:key/messages/:id/redo', route(async (req, res) => {
            const { actor, topic } = scope(req, 'execute');
            if (actor.kind !== 'desktop') throw failure('CORE_GROUP_REDO_DESKTOP_REQUIRED', 403);
            const { revision, ...body } = req.body || {};
            if (!Number.isSafeInteger(revision) || revision < 1) throw failure('MESSAGE_REVISION_CONFLICT', 400);
            await this.invite(topic, actor, body, () => scope(req, 'execute'), { id: req.params.id, revision });
            res.status(202).json(this.receipt(topic, actor.principal, body.requestId));
        }));
        router.post('/:workspace/:key/messages/:id', route((req, res) => {
            const { actor, topic } = scope(req, 'execute');
            if (topic.game) throw failure('CORE_GAME_HISTORY_IMMUTABLE');
            const { requestId, revision, text, remove = false } = req.body || {};
            if (!Number.isSafeInteger(revision) || revision < 1 || typeof remove !== 'boolean') throw failure('INVALID_CORE_MUTATION', 400);
            const result = this.store.mutateMessage(topic.key, actor.principal, requestId, req.params.id, {
                revision, delete: remove, ...(!remove && { text: requireText(text) })
            });
            this.runner.publish(topic.key, 'change_seq', { seq: result.seq });
            res.json(result);
        }));
        router.get('/:workspace/:key/works/:id/steering-receipt', route((req, res) => {
            const { actor, topic } = scope(req, 'read');
            res.json({ receipt: this.store.steeringReceipt(topic.key, actor.principal, req.query.requestId, req.params.id) });
        }));
        router.post('/:workspace/:key/works/:id/:action', route((req, res) => {
            const { actor, topic } = scope(req, 'execute');
            const { id, action } = req.params;
            if (action === 'steer') {
                if (topic.ownerType !== 'agent') throw failure('CORE_GROUP_STEERING_NOT_MIGRATED');
                if (this.runner.draining) throw failure('HOST_DRAINING', 503);
                const text = requireText(req.body?.text);
                if (!text.trim()) throw failure('INVALID_MESSAGE_TEXT', 400);
                if (actor.kind === 'mobile' && (req.get('x-nativesync-entry-id') || req.get('x-nativesync-session-marker'))) {
                    (this.mobile || this.remote).requireSubmissionContext(req);
                }
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

    beginDrain() {
        this.compaction.beginDrain();
        this.runner.beginDrain();
        for (const observer of this.observers) observer.end();
        this.observers.clear();
    }
    async close() {
        this.beginDrain();
        await this.compaction.close();
        const jev = this.jev?.close();
        await this.runner.close();
        await jev;
        await this.cds.close();
        await this.attachments.close();
        this.store.db.close();
    }
}

module.exports = { CoreService, capability };

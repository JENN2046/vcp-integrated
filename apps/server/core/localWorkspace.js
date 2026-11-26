'use strict';

const { createHash } = require('node:crypto');
const { failure } = require('./store');
const { stable } = require('../Plugin/NativeSync/sync/protocol');
const { ExecutionConfiguration } = require('./executionConfiguration');
const actor = Object.freeze({ kind: 'desktop', principal: 'desktop:personal', sourceId: 'personal', deviceId: 'personal' });
const localId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value);
const localTopicKey = (ownerType, ownerId, topicId) => 'local_' +
    createHash('sha256').update(JSON.stringify([ownerType, ownerId, topicId])).digest('hex');
const signature = value => createHash('sha256').update(stable(value)).digest('hex');

class LocalWorkspace {
    constructor(store, workspace, agentManager) {
        const { db } = store;
        const authority = db.prepare("SELECT value FROM core_metadata WHERE key='authority'").get();
        if (authority && authority.value !== 'local' ||
            !authority && db.prepare('SELECT 1 FROM conversations LIMIT 1').get()) throw failure('CORE_EXISTING_AUTHORITY_REQUIRED');
        const bound = db.prepare("SELECT value FROM core_metadata WHERE key='local_workspace'").get();
        if (bound && bound.value !== workspace) throw failure('CORE_DATABASE_WORKSPACE_MISMATCH');
        this.db = db;
        this.workspace = workspace;
        this.actor = actor;
        this.grants = new Set([workspace]);
        this.delegationAgents = require('../Plugin/NativeSync/sync/sharedControlledText').allowedAgents(process.env.VCP_CORE_DELEGATION_AGENTS);
        const imageModels = JSON.parse(process.env.VCP_CORE_IMAGE_MODELS || '[]');
        if (!Array.isArray(imageModels) || imageModels.some(model => typeof model !== 'string')) throw failure('INVALID_CORE_IMAGE_MODELS');
        this.imageModels = imageModels;
        this.configValidator = new ExecutionConfiguration(agentManager || require('../modules/agentManager'));
        db.exec(`CREATE TABLE IF NOT EXISTS core_topics (
            id TEXT PRIMARY KEY, owner_type TEXT NOT NULL, owner_id TEXT NOT NULL, native_topic TEXT NOT NULL,
            configuration TEXT NOT NULL, hash TEXT NOT NULL, version INTEGER NOT NULL,
            UNIQUE(owner_type, owner_id, native_topic)
        )`);
        db.prepare("INSERT OR IGNORE INTO core_metadata VALUES('authority','local')").run();
        db.prepare("INSERT OR IGNORE INTO core_metadata VALUES('local_workspace',?)").run(workspace);
    }

    authorize(subject, workspace) {
        if (workspace !== this.workspace || subject !== actor) throw failure('CORE_WORKSPACE_FORBIDDEN', 403);
    }

    async define(key, body, supportsGroup) {
        const { ownerType, ownerId, topicId, name, config } = body || {};
        if (!['agent', 'group'].includes(ownerType) || !localId(ownerId) || !localId(topicId) ||
            key !== localTopicKey(ownerType, ownerId, topicId) ||
            typeof name !== 'string' || !name.trim() || name.length > 200) throw failure('INVALID_CORE_TOPIC', 400);
        if (ownerType === 'group' && !supportsGroup(config?.group)) throw failure('CORE_GROUP_MODE_NOT_MIGRATED');
        const value = await this.configValidator.normalize({ ownerType, imageModels: this.imageModels }, config,
            { desktopContext: true, localOwner: true });
        const def = { name, config: value };
        const hash = signature(def);
        this.db.prepare(`INSERT INTO core_topics VALUES(?,?,?,?,?,?,1)
            ON CONFLICT(id) DO UPDATE SET configuration=excluded.configuration, hash=excluded.hash, version=version+1
            WHERE core_topics.hash<>excluded.hash`).run(key, ownerType, ownerId, topicId, JSON.stringify(def), hash);
        return { id: key };
    }

    row(workspace, key) {
        if (workspace !== this.workspace) throw failure('CORE_WORKSPACE_FORBIDDEN', 403);
        const result = this.db.prepare('SELECT * FROM core_topics WHERE id=?').get(key);
        if (!result) throw failure('CORE_TOPIC_NOT_FOUND', 404);
        return { ...result, space_id: workspace, kind: 'topic', parent_id: result.owner_id, topic_id: key, origin_source: actor.sourceId };
    }

    topic(subject, workspace, key) {
        this.authorize(subject, workspace);
        return this.row(workspace, key);
    }

    requiresCore(row) { return row?.space_id === this.workspace && row.kind === 'topic'; }

    definition(row) { return JSON.parse(row.configuration); }
    configuration(topic) { return this.definition(this.row(topic.workspace, topic.key)).config; }
    freeze(row) { return { hash: row.hash }; }
    groupMode(row) { return this.definition(row).config.group?.mode; }
    resourceBinding(topic) {
        const row = this.row(topic.workspace, topic.key);
        return [{ itemId: row.owner_id, topicId: row.native_topic }];
    }

    topicRows(ownerType, ownerId) {
        return this.db.prepare('SELECT id FROM core_topics WHERE owner_type=? AND owner_id=? ORDER BY id')
            .all(ownerType, ownerId).map(({ id }) => this.row(this.workspace, id));
    }

    describe(row) {
        return { id: row.id, kind: 'topic', parentId: row.owner_id,
            coreGroup: row.owner_type === 'group', topic: { ownerType: row.owner_type }, config: { name: this.definition(row).name } };
    }

    findAgent(query, historyDeleted) {
        for (const { owner_id, id } of this.db.prepare(`SELECT owner_id, min(id) id FROM core_topics
            WHERE owner_type='agent' GROUP BY owner_id ORDER BY owner_id`).all()) {
            const name = this.definition(this.row(this.workspace, id)).config.name;
            if (!name.includes(query)) continue;
            const topics = this.topicRows('agent', owner_id).filter(row => !historyDeleted?.get(row.id))
                .map(row => ({ id: row.id, name: this.definition(row).name }));
            return { name, uuid: owner_id, topics };
        }
        return null;
    }

    resolveSponsor(source, sourceName, args) {
        if (typeof args.topic_id !== 'string' || !args.topic_id.trim() ||
            typeof args.message !== 'string' || !args.message.trim() || args.message.length > 12000 ||
            Buffer.byteLength(stable(args)) > 500 * 1024) throw failure('INVALID_TOPIC_SPONSOR_MESSAGE', 400);
        if (args.mode !== undefined || ![undefined,false,'false'].includes(args.flowlock)) throw failure('INVALID_TOPIC_SPONSOR_OPERATION', 400);
        const origin = this.row(this.workspace, source.key);
        if (args.source_topic_id !== undefined && ![origin.id, origin.native_topic].includes(args.source_topic_id) ||
            args.sender_id !== undefined && args.sender_id !== origin.owner_id ||
            args.sender_name !== undefined && args.sender_name !== sourceName) throw failure('TOPIC_SPONSOR_SOURCE_CHANGED', 403);
        const matches = this.db.prepare(`SELECT id FROM core_topics WHERE owner_type='agent' AND
            (id=? OR native_topic=?) ORDER BY id`).all(args.topic_id, args.topic_id).map(({ id }) => this.row(this.workspace, id));
        const filtered = matches.filter(row => [args.target_agent, args.maid].every(name =>
            name === undefined || [row.owner_id, this.definition(row).config.name].includes(name)));
        if (!filtered.length) throw failure('TOPIC_SPONSOR_TARGET_NOT_BOUND', 404);
        if (filtered.length !== 1) throw failure('TOPIC_SPONSOR_TARGET_AMBIGUOUS');
        if (filtered[0].id === origin.id) throw failure('TOPIC_SPONSOR_SELF_TARGET');
        return { target: filtered[0] };
    }

    directory(subject, { sharedSpaceId, after = '', limit }) {
        this.authorize(subject, sharedSpaceId);
        const rows = this.db.prepare('SELECT id FROM core_topics WHERE id>? ORDER BY id LIMIT ?').all(String(after), limit + 1);
        const page = rows.slice(0, limit);
        return { objects: page.map(({ id }) => this.describe(this.row(sharedSpaceId, id))),
            next: page.at(-1)?.id || after, hasMore: rows.length > limit };
    }
}

module.exports = { LocalWorkspace, localTopicKey };

'use strict';

const { DatabaseSync } = require('node:sqlite');
const { randomUUID, createHash } = require('node:crypto');
const { stable } = require('../Plugin/NativeSync/sync/protocol');

const failure = (code, status = 409) => Object.assign(new Error(code), { code, status });
const active = new Set(['queued', 'running', 'waiting_approval', 'cancelling']);
const json = JSON.stringify;
const parse = JSON.parse;
const digest = value => createHash('sha256').update(stable(value)).digest('hex');

class CoreStore {
    constructor(filename) {
        this.db = new DatabaseSync(filename);
        this.db.exec(`
            PRAGMA busy_timeout = 5000;
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = FULL;
            PRAGMA foreign_keys = ON;
            CREATE TABLE IF NOT EXISTS core_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS conversations (
                id TEXT PRIMARY KEY, workspace TEXT NOT NULL, owner_id TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
                created_seq INTEGER NOT NULL UNIQUE, ordinal INTEGER NOT NULL,
                role TEXT NOT NULL CHECK (role IN ('user','assistant')),
                content TEXT NOT NULL, attachments_json TEXT NOT NULL DEFAULT '[]',
                rev INTEGER NOT NULL DEFAULT 1, deleted INTEGER NOT NULL DEFAULT 0, source_work_id TEXT, checkpoint_json TEXT, desktop_refs_json TEXT, sender_name TEXT,
                last_change_seq INTEGER NOT NULL, created_at INTEGER NOT NULL,
                UNIQUE(conversation_id, ordinal)
            );
            CREATE TABLE IF NOT EXISTS change_log (
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id TEXT NOT NULL REFERENCES conversations(id),
                message_id TEXT NOT NULL, action TEXT NOT NULL CHECK (action IN ('upsert','delete')),
                rev INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS core_changes_conversation ON change_log(conversation_id, seq);
            CREATE TABLE IF NOT EXISTS works (
                id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
                principal TEXT NOT NULL, request_id TEXT NOT NULL, status TEXT NOT NULL,
                admitted_seq INTEGER NOT NULL, user_message_id TEXT REFERENCES messages(id),
                reply_message_id TEXT REFERENCES messages(id), frozen_config_json TEXT NOT NULL,
                dispatched INTEGER NOT NULL DEFAULT 0, steering_count INTEGER NOT NULL DEFAULT 0, pending_final_json TEXT, error_code TEXT,
                created_at INTEGER NOT NULL, UNIQUE(principal, request_id)
            );
            CREATE INDEX IF NOT EXISTS core_works_conversation ON works(conversation_id, admitted_seq);
            CREATE TABLE IF NOT EXISTS work_invocations (
                id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES works(id),
                plugin_name TEXT NOT NULL, record_id TEXT, status TEXT NOT NULL,
                result_json TEXT, error_code TEXT
            );
            CREATE INDEX IF NOT EXISTS core_invocations_work ON work_invocations(work_id);
            CREATE TABLE IF NOT EXISTS idempotency_receipts (
                principal TEXT NOT NULL, op_id TEXT NOT NULL, request_hash TEXT NOT NULL,
                result_json TEXT NOT NULL, PRIMARY KEY(principal, op_id)
            );
        `);
        if (!this.db.prepare('PRAGMA table_info(messages)').all().some(column => column.name === 'checkpoint_json')) {
            this.db.exec('ALTER TABLE messages ADD COLUMN checkpoint_json TEXT');
        }
        if (!this.db.prepare('PRAGMA table_info(messages)').all().some(column => column.name === 'desktop_refs_json')) {
            this.db.exec('ALTER TABLE messages ADD COLUMN desktop_refs_json TEXT');
        }
        if (!this.db.prepare('PRAGMA table_info(messages)').all().some(column => column.name === 'sender_name')) {
            this.db.exec('ALTER TABLE messages ADD COLUMN sender_name TEXT');
        }
        if (!this.db.prepare('PRAGMA table_info(messages)').all().some(column => column.name === 'history_metadata_json')) {
            this.db.exec('ALTER TABLE messages ADD COLUMN history_metadata_json TEXT');
        }
        const workColumns = this.db.prepare('PRAGMA table_info(works)').all();
        if (!workColumns.some(column => column.name === 'group_step')) {
            this.db.exec('ALTER TABLE works ADD COLUMN group_step INTEGER NOT NULL DEFAULT 0');
        }
        if (!workColumns.some(column => column.name === 'group_plan_json')) {
            this.db.exec('ALTER TABLE works ADD COLUMN group_plan_json TEXT');
        }
        if (!workColumns.some(column => column.name === 'group_ordinal')) {
            this.db.exec('ALTER TABLE works ADD COLUMN group_ordinal INTEGER');
        }
        if (workColumns.find(column => column.name === 'user_message_id').notnull) this.allowWorkWithoutUserMessage();
        this.db.prepare("INSERT OR IGNORE INTO core_metadata VALUES('storage_id',?)").run(randomUUID());
        this.storageId = this.db.prepare("SELECT value FROM core_metadata WHERE key='storage_id'").get().value;
    }

    allowWorkWithoutUserMessage() {
        const { sql } = this.db.prepare("SELECT sql FROM sqlite_master WHERE name='works' AND type='table'").get();
        const definition = sql.replace('CREATE TABLE works', 'CREATE TABLE works_next')
            .replace(/user_message_id TEXT NOT NULL(\s+REFERENCES messages\(id\))/, 'user_message_id TEXT$1');
        if (!definition.startsWith('CREATE TABLE works_next') || !definition.includes('user_message_id TEXT REFERENCES messages(id)')) {
            throw failure('CORE_WORK_SCHEMA_MISMATCH');
        }
        this.db.exec('PRAGMA foreign_keys=OFF');
        try {
            this.transaction(() => {
                this.db.exec(`${definition};
                    INSERT INTO works_next(rowid, id, conversation_id, principal, request_id, status, admitted_seq, user_message_id,
                        reply_message_id, frozen_config_json, dispatched, steering_count, pending_final_json, error_code, created_at,
                        group_step, group_plan_json, group_ordinal)
                    SELECT rowid, id, conversation_id, principal, request_id, status, admitted_seq, user_message_id, reply_message_id,
                        frozen_config_json, dispatched, steering_count, pending_final_json, error_code, created_at,
                        group_step, group_plan_json, group_ordinal FROM works;
                    DROP TABLE works;
                    ALTER TABLE works_next RENAME TO works;
                    CREATE INDEX core_works_conversation ON works(conversation_id, admitted_seq)`);
                if (this.db.prepare('PRAGMA foreign_key_check').get()) throw failure('CORE_WORK_SCHEMA_MISMATCH');
            });
        } finally {
            this.db.exec('PRAGMA foreign_keys=ON');
        }
    }

    transaction(fn) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const result = fn();
            this.db.exec('COMMIT');
            return result;
        } catch (error) {
            if (this.db.isTransaction) this.db.exec('ROLLBACK');
            throw error;
        }
    }

    commandReceipt(principal, requestId) {
        if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(requestId)) {
            throw failure('INVALID_REQUEST_ID', 400);
        }
        return this.db.prepare('SELECT * FROM idempotency_receipts WHERE principal=? AND op_id=?').get(principal, requestId);
    }

    replay(principal, requestId, data) {
        const prior = this.commandReceipt(principal, requestId);
        if (!prior) return null;
        if (prior.request_hash !== digest(data)) throw failure('REQUEST_ID_REUSED');
        return parse(prior.result_json);
    }

    command(principal, requestId, data, apply) {
        return this.transaction(() => {
            const prior = this.replay(principal, requestId, data);
            if (prior) return prior;
            const result = apply();
            this.db.prepare('INSERT INTO idempotency_receipts VALUES(?,?,?,?)').run(principal, requestId, digest(data), json(result));
            return result;
        });
    }

    ensureConversation({ workspace, key, ownerId }) {
        this.db.prepare('INSERT INTO conversations VALUES(?,?,?) ON CONFLICT(id) DO NOTHING').run(key, workspace, ownerId);
        const row = this.db.prepare('SELECT * FROM conversations WHERE id=?').get(key);
        if (row.workspace !== workspace || row.owner_id !== ownerId) throw failure('CORE_CONVERSATION_IDENTITY_CONFLICT');
    }

    appendChange(key, id, action, rev) {
        return this.db.prepare('INSERT INTO change_log(conversation_id,message_id,action,rev) VALUES(?,?,?,?)')
            .run(key, id, action, rev).lastInsertRowid;
    }

    insertMessage({ id, key, role, content, attachments = [], after, sourceWorkId = null, checkpoint = null,
        desktopReferences = null, senderName = null, createdAt = Date.now(), deleted = false, historyMetadata = null }) {
        const seq = this.appendChange(key, id, deleted ? 'delete' : 'upsert', 1);
        this.db.prepare(`INSERT INTO messages
            (id,conversation_id,created_seq,ordinal,role,content,attachments_json,last_change_seq,created_at,source_work_id,
                checkpoint_json,desktop_refs_json,sender_name,deleted,history_metadata_json)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, key, seq, after ?? seq * 1024, role, content, json(attachments), seq, createdAt,
            sourceWorkId, checkpoint ? json(checkpoint) : null, desktopReferences?.length ? json(desktopReferences) : null, senderName,
            Number(deleted), historyMetadata ? json(historyMetadata) : null);
        return seq;
    }

    nextGroupOrdinal(key) {
        return this.db.prepare(`SELECT max(
            coalesce((SELECT max(ordinal) FROM messages WHERE conversation_id=?),0),
            coalesce((SELECT max(group_ordinal)+1023 FROM works WHERE conversation_id=?),0)
        ) AS value`).get(key, key).value + 1024;
    }

    admit(topic, principal, requestId, input, prepare) {
        return this.command(principal, requestId, { key: topic.key, op: 'send', input }, () => {
            this.ensureConversation(topic);
            if (this.db.prepare("SELECT 1 FROM works WHERE conversation_id=? AND status='review_required'").get(topic.key)) {
                throw failure('WORK_REVIEW_REQUIRED');
            }
            if (this.db.prepare('SELECT count(*) AS n FROM works WHERE principal=? AND created_at>?').get(principal, Date.now() - 60000).n >= 20) {
                throw failure('SUBMISSION_RATE_LIMIT', 429);
            }
            const { attachments, config, link, recovery, desktopReferences, senderName, senderRole } = prepare();
            const group = topic.ownerType === 'group';
            const ordinal = group ? this.nextGroupOrdinal(topic.key) : null;
            if (input.redo) {
                const { id, revision } = input.redo;
                const target = this.db.prepare('SELECT * FROM messages WHERE id=? AND conversation_id=? AND deleted=0').get(id, topic.key);
                if (!target) throw failure('MESSAGE_NOT_FOUND', 404);
                if (target.role !== 'assistant' || this.message(target).agentId !== input.inviteAgentId) throw failure('GROUP_REDO_SPEAKER_MISMATCH');
                this.applyMessageMutation(topic.key, id, { revision, delete: true });
            }
            const invitation = Boolean(input.inviteAgentId);
            const anchor = invitation && this.db.prepare(`SELECT id FROM messages
                WHERE conversation_id=? AND deleted=0 ORDER BY role='user' DESC,ordinal DESC LIMIT 1`).get(topic.key);
            const userId = invitation ? anchor?.id ?? null : randomUUID();
            const workId = randomUUID();
            const seq = invitation ? this.head(topic.key) : this.insertMessage({
                id: userId, key: topic.key, role: senderRole || 'user', content: input.text,
                attachments, desktopReferences, senderName, after: ordinal,
                historyMetadata: group ? { groupId: topic.ownerId, topicId: topic.topicId, isGroupMessage: true } : null
            });
            if (!invitation) link?.(userId);
            this.db.prepare(`INSERT INTO works
                (id,conversation_id,principal,request_id,status,admitted_seq,user_message_id,frozen_config_json,created_at,group_ordinal)
                VALUES(?,?,?,?,'queued',?,?,?,?,?)`).run(workId, topic.key, principal, requestId, seq, userId, json(config), Date.now(), ordinal);
            return { workId, messageId: userId, seq, ...(recovery && { recovery }) };
        });
    }

    work(id) { return this.db.prepare('SELECT * FROM works WHERE id=?').get(id); }

    message(row, includeAttachmentText = false) {
        const attachments = parse(row.attachments_json);
        if (!includeAttachmentText) {
            for (const attachment of attachments) delete attachment.extractedText;
        }
        const refs = row.desktop_refs_json && parse(row.desktop_refs_json);
        const metadata = row.history_metadata_json && parse(row.history_metadata_json);
        const { agentId, groupId, topicId, isGroupMessage, finishReason, gameEvent, gameEventId } = metadata || {};
        const desktopReferences = includeAttachmentText ? refs : refs?.map(({ sourceId, ...reference }) => reference);
        return { agentId, groupId, topicId, isGroupMessage, finishReason, ...(gameEvent && { gameEvent, gameEventId }), id: row.id, role: row.role, content: row.content, timestamp: row.created_at,
            ordinal: row.ordinal, ...(row.sender_name && { name: row.sender_name }), ...(desktopReferences && { desktopReferences }), ...(row.checkpoint_json && { contextCompaction: parse(row.checkpoint_json) }), ...(row.source_work_id && { sourceWorkId: row.source_work_id }), revision: row.rev, attachments };
    }

    history(work) {
        return this.db.prepare(`SELECT m.* FROM messages m WHERE conversation_id=? AND deleted=0 AND (
            created_seq<=? OR source_work_id IN (
                SELECT id FROM works WHERE conversation_id=? AND admitted_seq<=?
            )) ORDER BY ordinal`).all(work.conversation_id, work.admitted_seq, work.conversation_id, work.admitted_seq)
            .map(row => this.message(row, true));
    }

    requireIdleCompaction(key) {
        if (this.db.prepare(`SELECT 1 FROM works WHERE conversation_id=?
            AND status IN ('queued','running','waiting_approval','cancelling','review_required')`).get(key)) {
            throw failure('WORK_SAFE_BOUNDARY_PENDING');
        }
    }

    compactionHistory(key) {
        return this.db.prepare('SELECT * FROM messages WHERE conversation_id=? AND deleted=0 ORDER BY ordinal')
            .all(key).map(row => this.message(row, true));
    }

    snapshot(key, before, limit) {
        return this.db.prepare('SELECT * FROM messages WHERE conversation_id=? AND deleted=0 AND ordinal<? ORDER BY ordinal DESC LIMIT ?')
            .all(key, before, limit).map(row => this.message(row)).reverse();
    }

    changes(key, after, limit) {
        const events = this.db.prepare(`SELECT c.seq, c.message_id AS messageId, c.action, c.rev AS change_rev, m.*
            FROM change_log c JOIN messages m ON m.id=c.message_id
            WHERE c.conversation_id=? AND c.seq>? ORDER BY c.seq LIMIT ?`).all(key, after, limit);
        return events.map(row => ({
            seq: row.seq, messageId: row.messageId, action: row.action, revision: row.change_rev,
            ...(row.last_change_seq === row.seq && { message: row.deleted ? null : this.message(row) })
        }));
    }

    head(key) {
        return this.db.prepare('SELECT coalesce(max(seq),0) AS seq FROM change_log WHERE conversation_id=?').get(key).seq;
    }

    mutateMessage(key, principal, requestId, id, input) {
        return this.command(principal, requestId, { key, id, op: 'message', input },
            () => this.applyMessageMutation(key, id, input));
    }

    applyMessageMutation(key, id, input) {
        const row = this.db.prepare('SELECT * FROM messages WHERE id=? AND conversation_id=? AND deleted=0').get(id, key);
        if (!row) throw failure('MESSAGE_NOT_FOUND', 404);
        if (row.rev !== input.revision) throw failure('MESSAGE_REVISION_CONFLICT');
        if (row.checkpoint_json) throw failure('CORE_CHECKPOINT_IMMUTABLE');
        if (this.db.prepare(`SELECT 1 FROM works
            WHERE (user_message_id=? OR id=?) AND status IN ('queued','running','waiting_approval','cancelling')`).get(id, row.source_work_id || '')) {
            throw failure('MESSAGE_IN_ACTIVE_WORK');
        }
        const rev = row.rev + 1;
        const seq = this.appendChange(key, id, input.delete ? 'delete' : 'upsert', rev);
        this.db.prepare('UPDATE messages SET content=?, deleted=?, rev=?, last_change_seq=? WHERE id=?')
            .run(input.delete ? row.content : input.text, Number(input.delete), rev, seq, id);
        return { id, revision: rev, seq };
    }

    control(key, principal, requestId, id, action) {
        return this.command(principal, requestId, { key, id, action }, () => {
            const work = this.work(id);
            if (!work || work.conversation_id !== key) throw failure('WORK_NOT_FOUND', 404);
            if (work.principal !== principal) throw failure('WORK_CONTROL_FORBIDDEN', 403);
            if (action === 'cancel' && active.has(work.status)) {
                return this.setState(id, work.status === 'queued' ? 'cancelled' : 'cancelling');
            }
            if (action === 'release' && work.status === 'review_required') return this.setState(id, 'review_released');
            return { workId: id, status: work.status };
        });
    }

    steer(key, principal, requestId, id, text) {
        return this.command(principal, requestId, { key, id, action: 'steer', text }, () => {
            const work = this.work(id);
            if (!work || work.conversation_id !== key) throw failure('WORK_NOT_FOUND', 404);
            if (!['queued', 'running', 'waiting_approval'].includes(work.status) || work.pending_final_json) {
                throw failure('WORK_STEERING_WINDOW_CLOSED');
            }
            if (work.steering_count >= 8) throw failure('WORK_STEERING_LIMIT', 429);
            const { ordinal } = this.db.prepare('SELECT ordinal FROM messages WHERE id=?').get(work.user_message_id);
            const messageId = randomUUID();
            const seq = this.insertMessage({ id: messageId, key, content: text, role: 'user',
                after: ordinal + work.steering_count + 1, sourceWorkId: id });
            this.db.prepare('UPDATE works SET steering_count=steering_count+1 WHERE id=?').run(id);
            return { workId: id, messageId, seq };
        });
    }

    steeringReceipt(key, principal, requestId, workId) {
        const record = this.commandReceipt(principal, requestId);
        if (!record) return null;
        const result = parse(record.result_json);
        if (result.workId !== workId || typeof result.messageId !== 'string' || !Number.isSafeInteger(result.seq)) return null;
        // Steering creates a user message sourced from this Work in the same
        // transaction. Ordinary admission and other commands don't have that link.
        const message = this.db.prepare(`SELECT 1 FROM messages
            WHERE id=? AND conversation_id=? AND source_work_id=? AND created_seq=? AND role='user'`)
            .get(result.messageId, key, workId, result.seq);
        return message ? { requestId, workId, messageId: result.messageId, seq: result.seq } : null;
    }

    setState(id, status, errorCode = null) {
        this.db.prepare('UPDATE works SET status=?, error_code=? WHERE id=?').run(status, errorCode, id);
        return { workId: id, status, errorCode };
    }

    unresolved(id) {
        return this.db.prepare("SELECT 1 FROM work_invocations WHERE work_id=? AND status IN ('dispatched','unknown')").get(id);
    }

    review(id, code) {
        this.db.prepare("UPDATE work_invocations SET status='unknown' WHERE work_id=? AND status='dispatched'").run(id);
        return this.setState(id, 'review_required', code);
    }

    saveFinal(work, content) {
        const result = this.db.prepare(`UPDATE works SET pending_final_json=? WHERE id=? AND status='running' AND dispatched=1
            AND pending_final_json IS NULL AND group_step=?`).run(json({
                id: work.id, principal: work.principal, key: work.conversation_id, requestId: work.request_id,
                userId: work.user_message_id, content, ...(work.group_ordinal !== null && { step: work.group_step })
            }), work.id, work.group_step ?? 0);
        if (result.changes !== 1) throw failure('WORK_FINAL_FENCED');
    }

    finish(id) {
        const work = this.work(id);
        const final = work?.pending_final_json && parse(work.pending_final_json);
        const config = work && parse(work.frozen_config_json);
        if (!final || work.status !== 'running' || !work.dispatched || this.unresolved(id) ||
            final.id !== id || final.principal !== work.principal || final.key !== work.conversation_id ||
            final.requestId !== work.request_id || final.userId !== work.user_message_id ||
            (config.game ? final.content !== null : typeof final.content !== 'string' || !final.content.trim())) {
            throw failure('WORK_FINAL_UNSETTLED');
        }
        const user = this.db.prepare("SELECT ordinal FROM messages WHERE id=? AND conversation_id=? AND deleted=0")
            .get(work.user_message_id, work.conversation_id);
        if (!user && !(work.user_message_id === null && work.group_ordinal !== null && config.inviteAgentId)) {
            throw failure('WORK_FINAL_UNSETTLED');
        }
        if (work.group_ordinal !== null) {
            const plan = work.group_plan_json && parse(work.group_plan_json);
            const member = config.agents?.find(agent => agent.id === plan?.[work.group_step]);
            if (!member || final.step !== work.group_step) throw failure('WORK_FINAL_UNSETTLED');
            if (config.game) {
                const { game, ...settledConfig } = config;
                this.db.prepare(`UPDATE works SET status='completed',pending_final_json=NULL,
                    frozen_config_json=?,group_step=group_step+1,dispatched=0 WHERE id=?`)
                    .run(json({ ...settledConfig, game: { matchId: game.matchId, decisionId: game.decisionId, revision: game.revision } }), id);
                return { workId: id, seq: this.head(work.conversation_id), status: 'completed' };
            }
            const replyId = 'reply_' + id + '_' + work.group_step;
            const seq = this.insertMessage({ id: replyId, key: work.conversation_id, role: 'assistant',
                content: final.content, after: work.group_ordinal + work.group_step + 1, sourceWorkId: id,
                senderName: member.name || member.id, historyMetadata: {
                    agentId: member.id, groupId: config.groupId, topicId: config.topicId, isGroupMessage: true
                }
            });
            const status = work.group_step + 1 === plan.length ? 'completed' : 'running';
            this.db.prepare(`UPDATE works SET status=?,reply_message_id=?,pending_final_json=NULL,error_code=NULL,
                group_step=group_step+1,dispatched=0 WHERE id=?`).run(status, replyId, id);
            return { workId: id, replyId, seq, status, step: work.group_step, speaker: member.id };
        }
        const replyId = 'reply_' + id;
        const seq = this.insertMessage({ id: replyId, key: work.conversation_id, role: 'assistant',
            content: final.content, after: user.ordinal + 1023, sourceWorkId: id });
        this.db.prepare("UPDATE works SET status='completed', reply_message_id=?, pending_final_json=NULL, error_code=NULL WHERE id=?")
            .run(replyId, id);
        return { workId: id, replyId, seq, status: 'completed' };
    }

    recover(isValid, onFinal) {
        this.transaction(() => {
            for (const work of this.db.prepare("SELECT * FROM works WHERE status IN ('queued','running','waiting_approval','cancelling') ORDER BY admitted_seq,rowid").all()) {
                const valid = isValid(work);
                if (valid && work.status === 'running' && work.pending_final_json) {
                    try {
                        const result = this.finish(work.id);
                        if (result.status === 'running') this.setState(work.id, 'queued');
                        else if (work.group_ordinal === null) onFinal?.(work, parse(work.pending_final_json).content);
                        continue;
                    }
                    catch (error) { if (error.code !== 'WORK_FINAL_UNSETTLED') throw error; }
                }
                if (this.unresolved(work.id) || work.dispatched) {
                    this.review(work.id, 'EXECUTION_UNCONFIRMED');
                } else if (work.status === 'cancelling' || !valid) {
                    this.setState(work.id, 'cancelled');
                } else {
                    this.setState(work.id, 'queued');
                }
            }
        });
    }
}

module.exports = { CoreStore, failure };

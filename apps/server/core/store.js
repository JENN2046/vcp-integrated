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
                admitted_seq INTEGER NOT NULL, user_message_id TEXT NOT NULL REFERENCES messages(id),
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
        this.db.prepare("INSERT OR IGNORE INTO core_metadata VALUES('storage_id',?)").run(randomUUID());
        this.storageId = this.db.prepare("SELECT value FROM core_metadata WHERE key='storage_id'").get().value;
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

    replay(principal, requestId, data) {
        if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(requestId)) {
            throw failure('INVALID_REQUEST_ID', 400);
        }
        const prior = this.db.prepare('SELECT * FROM idempotency_receipts WHERE principal=? AND op_id=?').get(principal, requestId);
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

    insertMessage({ id, key, role, content, attachments = [], after, sourceWorkId = null, checkpoint = null, desktopReferences = null, senderName = null }) {
        const seq = this.appendChange(key, id, 'upsert', 1);
        this.db.prepare(`INSERT INTO messages
            (id,conversation_id,created_seq,ordinal,role,content,attachments_json,last_change_seq,created_at,source_work_id,checkpoint_json,desktop_refs_json,sender_name)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, key, seq, after ?? seq * 1024, role, content, json(attachments), seq, Date.now(),
            sourceWorkId, checkpoint ? json(checkpoint) : null, desktopReferences?.length ? json(desktopReferences) : null, senderName);
        return seq;
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
            const { attachments, config, link, recovery, desktopReferences, senderName } = prepare();
            const userId = randomUUID();
            const workId = randomUUID();
            const seq = this.insertMessage({ id: userId, key: topic.key, role: senderName ? 'assistant' : 'user', content: input.text, attachments, desktopReferences, senderName });
            link?.(userId);
            this.db.prepare(`INSERT INTO works
                (id,conversation_id,principal,request_id,status,admitted_seq,user_message_id,frozen_config_json,created_at)
                VALUES(?,?,?,?,'queued',?,?,?,?)`).run(workId, topic.key, principal, requestId, seq, userId, json(config), Date.now());
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
        const desktopReferences = includeAttachmentText ? refs : refs?.map(({ sourceId, ...reference }) => reference);
        return { id: row.id, role: row.role, content: row.content, timestamp: row.created_at,
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
        return this.command(principal, requestId, { key, id, op: 'message', input }, () => {
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
        });
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
            AND pending_final_json IS NULL`).run(json({
                id: work.id, principal: work.principal, key: work.conversation_id, requestId: work.request_id,
                userId: work.user_message_id, content
            }), work.id);
        if (result.changes !== 1) throw failure('WORK_FINAL_FENCED');
    }

    finish(id) {
        const work = this.work(id);
        const final = work?.pending_final_json && parse(work.pending_final_json);
        if (!final || work.status !== 'running' || !work.dispatched || this.unresolved(id) ||
            final.id !== id || final.principal !== work.principal || final.key !== work.conversation_id ||
            final.requestId !== work.request_id || final.userId !== work.user_message_id ||
            typeof final.content !== 'string' || !final.content.trim()) {
            throw failure('WORK_FINAL_UNSETTLED');
        }
        const user = this.db.prepare("SELECT ordinal FROM messages WHERE id=? AND conversation_id=? AND deleted=0")
            .get(work.user_message_id, work.conversation_id);
        if (!user) throw failure('WORK_FINAL_UNSETTLED');
        const replyId = 'reply_' + id;
        const seq = this.insertMessage({ id: replyId, key: work.conversation_id, role: 'assistant',
            content: final.content, after: user.ordinal + 1023, sourceWorkId: id });
        this.db.prepare("UPDATE works SET status='completed', reply_message_id=?, pending_final_json=NULL, error_code=NULL WHERE id=?")
            .run(replyId, id);
        return { workId: id, replyId, seq, status: 'completed' };
    }

    recover(isValid) {
        this.transaction(() => {
            for (const work of this.db.prepare("SELECT * FROM works WHERE status IN ('queued','running','waiting_approval','cancelling') ORDER BY admitted_seq").all()) {
                const valid = isValid(work);
                if (valid && work.status === 'running' && work.pending_final_json) {
                    try { this.finish(work.id); continue; }
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

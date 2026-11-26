'use strict';

const { randomUUID } = require('node:crypto');
const { parse } = require('@vcp/native-history-window/flowlock-protocol');
const { failure } = require('./store');

const defaultPrompt = '请继续。若当前已无值得继续推进的任务或话题，请输出 [[Flowlock::Stop]]。';
const boundedDelay = seconds => Number.isSafeInteger(seconds) && seconds >= 1 && seconds <= 3600 ? seconds : 5;

class CoreFlowlock {
    constructor({ store, resolveTopic, send, publish, isCompacting }) {
        Object.assign(this, { store, resolveTopic, send, publish, isCompacting });
        store.db.exec(`
            CREATE TABLE IF NOT EXISTS core_flowlock (
                owner_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
                principal TEXT NOT NULL, epoch TEXT NOT NULL, round INTEGER NOT NULL DEFAULT 0,
                due_at INTEGER, delay_seconds INTEGER NOT NULL, default_prompt TEXT, next_prompt TEXT
            );
        `);
    }

    state(key, principal) {
        const row = this.store.db.prepare('SELECT * FROM core_flowlock WHERE conversation_id=?').get(key);
        return row ? { active: true, owner: principal === row.principal, nextAt: row.due_at, round: row.round } : { active: false };
    }

    control(topic, principal, body) {
        const result = this.store.command(principal, body.requestId, { key: topic.key, command: body }, () => {
            const row = this.store.db.prepare('SELECT * FROM core_flowlock WHERE owner_id=?').get(topic.ownerId);
            if (row && row.principal !== principal) throw failure('FLOWLOCK_CONTROL_FORBIDDEN', 403);
            if (body.action === 'stop') {
                this.store.db.prepare('DELETE FROM core_flowlock WHERE conversation_id=? AND principal=?').run(topic.key, principal);
                return { active: false };
            }
            if (body.action !== 'start' || body.prompt !== undefined &&
                (typeof body.prompt !== 'string' || body.prompt.length > 12000)) throw failure('INVALID_FLOWLOCK_CONTROL', 400);
            this.store.ensureConversation(topic);
            const seconds = boundedDelay(body.delaySeconds);
            const oldKey = row?.conversation_id;
            this.store.db.prepare(`INSERT INTO core_flowlock(owner_id,conversation_id,principal,epoch,due_at,delay_seconds,default_prompt)
                VALUES(?,?,?,?,?,?,?) ON CONFLICT(owner_id) DO UPDATE SET conversation_id=excluded.conversation_id,
                epoch=excluded.epoch,round=0,due_at=excluded.due_at,delay_seconds=excluded.delay_seconds,default_prompt=excluded.default_prompt,next_prompt=NULL`)
                .run(topic.ownerId, topic.key, principal, randomUUID(), body.immediate === true ? Date.now() : null,
                    seconds, body.prompt || null);
            return { active: true, ...(oldKey && oldKey !== topic.key && { previousTopic: oldKey }) };
        });
        this.publish(topic.key, 'flowlock_state', {});
        if (result.previousTopic) this.publish(result.previousTopic, 'flowlock_state', {});
        this.schedule();
        return result;
    }

    afterFinal(work, content) {
        const { shouldStart, terminalType, nextHeartbeatSeconds, nextPrompt } = parse(content);
        const { owner_id: ownerId } = this.store.db.prepare('SELECT owner_id FROM conversations WHERE id=?').get(work.conversation_id);
        const row = this.store.db.prepare('SELECT * FROM core_flowlock WHERE owner_id=?').get(ownerId);
        if (row && (row.conversation_id !== work.conversation_id || row.principal !== work.principal)) return false;
        if (terminalType || row?.round >= 64) return this.endWork(work);
        if (!row && !shouldStart) return false;
        const delay = nextHeartbeatSeconds == null ? row?.delay_seconds || 5 : boundedDelay(nextHeartbeatSeconds);
        this.store.db.prepare(`INSERT INTO core_flowlock(owner_id,conversation_id,principal,epoch,due_at,delay_seconds,next_prompt)
            VALUES(?,?,?,?,?,?,?) ON CONFLICT(owner_id) DO UPDATE SET due_at=excluded.due_at,next_prompt=excluded.next_prompt`)
            .run(ownerId, work.conversation_id, work.principal, randomUUID(), Date.now() + delay * 1000, row?.delay_seconds || 5,
                typeof nextPrompt === 'string' ? nextPrompt.slice(0, 12000) : null);
        return true;
    }

    endWork(work) {
        const result = this.store.db.prepare('DELETE FROM core_flowlock WHERE conversation_id=? AND principal=?').run(work.conversation_id, work.principal);
        return Boolean(result.changes);
    }

    schedule() {
        clearTimeout(this.timer);
        if (this.draining || this.promoting) return;
        const row = this.store.db.prepare(`SELECT s.* FROM core_flowlock s WHERE s.due_at IS NOT NULL AND NOT EXISTS(
            SELECT 1 FROM works WHERE conversation_id=s.conversation_id
            AND status IN ('queued','running','waiting_approval','cancelling','review_required')
        ) ORDER BY s.due_at`).all().find(value => !this.isCompacting(value.conversation_id));
        if (!row) return;
        this.timer = setTimeout(() => {
            this.promoting = this.promote(row).catch(error => console.warn('[Core] Flowlock:', error.code || error.name))
                .finally(() => { this.promoting = null; this.schedule(); });
        }, Math.max(0, row.due_at - Date.now()));
        this.timer.unref?.();
    }

    async promote(row) {
        if (this.draining) return;
        const current = () => this.store.db.prepare('SELECT * FROM core_flowlock WHERE owner_id=?').get(row.owner_id);
        const principal = row.principal;
        const authority = { principal, conversation_id: row.conversation_id };
        const recheck = () => {
            if (this.isCompacting(row.conversation_id)) throw failure('CORE_COMPACTION_BUSY');
            const value = current();
            if (this.draining || value?.epoch !== row.epoch || value.due_at !== row.due_at || value.round !== row.round ||
                !this.resolveTopic(authority)) throw failure('FLOWLOCK_SOURCE_CHANGED');
        };
        try {
            recheck();
            const topic = this.resolveTopic(authority);
            await this.send(topic, principal, {
                requestId: 'flowlock_' + row.epoch + '_' + row.round,
                text: '[系统提示:] ' + (row.next_prompt || row.default_prompt || defaultPrompt)
            }, recheck, topic.actor, { flowlock: true });
            this.store.db.prepare('UPDATE core_flowlock SET due_at=NULL,round=round+1 WHERE owner_id=? AND epoch=? AND round=? AND due_at=?')
                .run(row.owner_id, row.epoch, row.round, row.due_at);
        } catch (error) {
            if (!this.draining && error.code !== 'CORE_COMPACTION_BUSY' && current()?.epoch === row.epoch) {
                this.store.db.prepare('DELETE FROM core_flowlock WHERE owner_id=? AND epoch=? AND due_at=?')
                    .run(row.owner_id, row.epoch, row.due_at);
            }
            throw error;
        } finally { if (!this.draining) this.publish(row.conversation_id, 'flowlock_state', {}); }
    }

    beginDrain() { this.draining = true; clearTimeout(this.timer); }
    async close() { this.beginDrain(); await this.promoting; }
}

module.exports = { CoreFlowlock };

'use strict';

const {MODE, PLAN_MODE} = require('../sync/sharedGroupHandoff');
const {intent} = require('../sync/sharedTurns');

const MAX_WORKS = 16;
const MAX_MEMBERS = 128;

function desktopRelays(shared, session, topic, mode) {
    if (!topic.sharedSpaceId || topic.ownerType !== 'group') return [];
    return shared.store.readSnapshot(() => {
        const actor = shared.mobile(session, topic.sharedSpaceId, 'read');
        const canonical = shared.topic(actor, topic.sharedSpaceId, topic.key);
        const attention = mode === 'attention' ? "AND a.state NOT IN ('completed', 'abandoned')" : '';
        const works = shared.db.prepare(`
            SELECT a.id, a.state, a.user_op, a.user_seq, a.reply_seq, a.config_json,
                h.state AS handoff_state, h.first_reply_seq, h.executor
            FROM shared_admissions a JOIN shared_group_handoffs h ON h.work_id = a.id
            WHERE a.space_id = ? AND a.topic_id = ? AND a.principal GLOB 'desktop:*'
                AND json_extract(a.user_op, '$.sharedTurn.controlMode') IN (?, ?)
                ${attention}
            ORDER BY a.rowid DESC LIMIT ?
        `).all(canonical.space_id, canonical.id, MODE, PLAN_MODE, MAX_WORKS);
        if (!works.length) return [];
        const replyCount = shared.db.prepare(`
            SELECT count(*) AS count FROM shared_group_handoff_replies
            WHERE work_id = ? AND ordinal >= 0 AND ordinal < ?
        `);
        const replies = shared.db.prepare(`
            SELECT ordinal, reply_seq FROM shared_group_handoff_replies
            WHERE work_id = ? AND (ordinal < ? OR ordinal = ? OR ordinal = ?)
        `);
        const device = shared.db.prepare('SELECT source_id FROM shared_members WHERE space_id = ? AND device_id = ?');
        const unknown = shared.native && shared.db.prepare(`
            SELECT ordinal FROM shared_native_requests WHERE admission_id = ? AND state = 'unknown'
            ORDER BY ordinal LIMIT 1
        `);

        return works.map(work => {
            const {plan, controlMode} = intent(work);
            const memberCount = plan.length;
            const state = ['completed', 'abandoned', 'review_required'].includes(work.state)
                ? work.state : work.handoff_state;
            const confirmed = new Map();
            let confirmedCount;
            if (controlMode === MODE) {
                // v1 persists the first boundary separately. The admission's last reply
                // advances only in the transaction that publishes the second member.
                if (work.first_reply_seq !== null) {
                    confirmed.set(0, work.first_reply_seq);
                    if (work.reply_seq > work.first_reply_seq) confirmed.set(1, work.reply_seq);
                }
                confirmedCount = confirmed.size;
            } else {
                confirmedCount = replyCount.get(work.id, memberCount).count;
            }
            const nextOrdinal = ['first_member', 'awaiting_handoff', 'awaiting_continue', 'continuing'].includes(state)
                && confirmedCount < memberCount ? confirmedCount : null;
            const unknownOrdinal = unknown?.get(work.id)?.ordinal ?? null;
            const ordinals = plan.slice(0, MAX_MEMBERS).map((_, ordinal) => ordinal);
            for (const ordinal of new Set([nextOrdinal, unknownOrdinal])) {
                if (ordinal !== null && ordinal >= MAX_MEMBERS && ordinal < memberCount) ordinals.push(ordinal);
            }
            if (controlMode === PLAN_MODE) {
                for (const {ordinal, reply_seq} of replies.all(work.id, Math.min(MAX_MEMBERS, memberCount), nextOrdinal, unknownOrdinal)) {
                    confirmed.set(ordinal, reply_seq);
                }
            }
            const frozenNames = new Map(JSON.parse(work.config_json).members.map(m => [m.id, m.config.name]));
            const members = ordinals.map(ordinal => {
                const memberId = plan[ordinal];
                return {ordinal, memberId, name: frozenNames.get(memberId) || memberId, replySeq: confirmed.get(ordinal) ?? null};
            });
            let executor = null;
            if (['awaiting_continue', 'continuing'].includes(state) && work.executor.startsWith('desktop:')) {
                const deviceId = work.executor.slice('desktop:'.length);
                const member = device.get(canonical.space_id, deviceId);
                const grant = member && shared.catalog.grants.get(member.source_id);
                executor = (grant?.deviceId === deviceId && grant.label) || deviceId;
            }
            return {id: work.id, state, members, memberCount, confirmedCount, nextOrdinal, unknownOrdinal, executor, userSeq: work.user_seq};
        });
    });
}

module.exports = {desktopRelays};

'use strict';
function seedScale(f, initial) {
    const missing=process.env.NS_IDLE_MISSING==='yes';
    const { envelopeFor } = require('../../apps/desktop/modules/services/nativeSync/metadata');
    const { attachment } = require('./idle-attachment.cjs');
    const actor = f.actor('C');
    const topics = [...initial];
    for (let i = 0; i < 120; i++) {
        topics.push(f.shared.create(actor, {
            sharedSpaceId:'sharedAB', opId:'idle-scale-topic-' + i, kind:'topic',
            parentId:f.owner.id, localId:'idle-scale-topic-' + i, localParent:'origin',
            config:{name:'Synthetic idle scale topic ' + i},
        }).object);
    }
    const hashes = new Map();
    f.store.db.exec('BEGIN IMMEDIATE');
    try {
        for (let i = 0; i < 1564; i++) {
            const t = i % topics.length;
            const id = 'idle-scale-message-' + t;
            const message={
                id, role:'user', content:'Synthetic idle revision ' + i + ' ' + 'fixture '.repeat(80),
                timestamp:1700000000000 + t,
                ...(missing && i===1563 && {attachments:[attachment]}),
            };
            const row = f.store.apply({
                ...topics[t].topic, msgId:id, deviceId:actor.principal,
                opId:'idle-scale-operation-' + i, baseHash:hashes.get(id) ?? null,
                action:'upsert', message,
                ...(message.attachments && {metadata:envelopeFor(message,1)}),
            },{sharedSpace:'sharedAB',metadataPublisher:true});
            hashes.set(id, row.hash);
        }
        f.store.db.exec('COMMIT');
    } catch (error) {
        f.store.db.exec('ROLLBACK');
        throw error;
    }
}
module.exports = { seedScale };

'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createHash } = require('node:crypto');
function audit(out, scale) {
    const sizes = scale ? {topics:123, journal:1564} : {topics:3, journal:0};
    const db = new DatabaseSync(path.join(out,'data/central.sqlite'),{readOnly:true});
    let central;
    try {
        central = {
            ...db.prepare('SELECT COALESCE(MAX(seq),0) AS journalHead, COUNT(*) AS journalRows FROM journal').get(),
            ...db.prepare("SELECT COALESCE(MAX(seq),0) AS directoryRevision FROM shared_changes WHERE space_id='sharedAB'").get(),
            liveRows:db.prepare('SELECT COUNT(*) AS n FROM messages WHERE deleted=0').get().n,
        };
    } finally {
        db.close();
    }
    assert.equal(central.journalRows,sizes.journal);
    const devices = {};
    for (const role of ['A','B']) {
        const profile = path.join(out,'profile-' + role);
        const state = path.join(profile,'.native-sync/shared/sharedAB');
        const read = name => JSON.parse(fs.readFileSync(path.join(state,name),'utf8'));
        const messages = read('messages.json');
        const registry = read('registry.json');
        const histories = fs.readdirSync(path.join(profile,'UserData'),{recursive:true})
            .filter(name => path.basename(name) === 'history.json').sort();
        const historyDigest = createHash('sha256');
        let historyMessages = 0;
        for (const relative of histories) {
            const content = fs.readFileSync(path.join(profile,'UserData',relative));
            historyDigest.update(relative).update(content);
            historyMessages += JSON.parse(content).length;
        }
        devices[role] = {
            cursor: messages.cursor, directoryRevision: registry.revision,
            topics:messages.topics.length, historyFiles:histories.length,historyMessages,
            historyDigest:historyDigest.digest('hex'), outbox:messages.outbox.length,
            inbox:messages.inbox.length, messagePending:Boolean(messages.pending),
            registryPending:Boolean(registry.pending),
        };
        const d = devices[role];
        assert.equal(d.cursor,central.journalHead);
        assert.equal(d.directoryRevision,central.directoryRevision);
        assert.equal(d.topics,sizes.topics);
        assert.equal(d.historyFiles,sizes.topics);
        assert.equal(d.historyMessages,central.liveRows);
        assert.equal(d.outbox + d.inbox + Number(d.messagePending) + Number(d.registryPending),0);
    }
    return {central,devices};
}
module.exports = { audit };

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const {fixture, wait, BOX} = require('../native/fixtures/sharedSingleHarness.cjs');

const space = 'sharedAB';
const canvas = '{{VCPChatCanvas}}';
const reference = {id:'synthetic-ref', name:'synthetic.txt', kind:'file', index:0, availability:'desktop-only', target:'/synthetic/reference.txt'};
const user = (id, content, timestamp, fields = {}) => ({id, role:'user', content, timestamp, ...fields});

function topicArgs(f) {
    return {sharedSpaceId:space, sharedId:f.topic.id};
}

function seedHistory(f, message) {
    const actor = f.actor('A'), topic = topicArgs(f);
    const {head, hash} = f.shared.executionConfig(actor, topic);
    const admission = f.shared.admit(actor, {...topic, requestId:'seed_'+message.id, expectedHead:head, configHash:hash, message});
    f.shared.abandon(actor, {sharedSpaceId:space, admissionId:admission.id, opId:'stop_'+message.id, confirm:true});
}

function compact(f) {
    const actor = f.actor('A'), topic = topicArgs(f);
    const expectedHead = f.shared.head(f.shared.row(space, f.topic.id));
    const {id, messageId, sourceHash} = f.shared.compactPrepare(actor, {...topic, expectedHead, opId:'window-prepare'});
    const content = 'PORTABLE_CHECKPOINT';
    f.shared.compactCommit(actor, {sharedSpaceId:space, id, sourceHash, opId:'window-commit', message:user(messageId, content, 20, {
        contextCompaction:{kind:'vchat-context-checkpoint', version:1, checkpoint:content, diaries:[], warnings:[], sourceCount:1}
    })});
    return messageId;
}

function editArchive(f, message) {
    const actor = f.actor('A'), topic = f.topic.topic;
    const before = f.store.findMessage.get(topic.ownerType, topic.ownerId, topic.topicId, message.id);
    const metadata = require(BOX+'/Plugin/NativeSync/sync/metadata');
    f.shared.editMessage(actor, {...topicArgs(f), operation:{
        msgId:message.id, opId:'window-archive-edit', action:'upsert', deviceId:actor.principal,
        baseHash:before.hash, message, metadata:metadata.envelopeFor(message, 1)
    }});
}

function durableCounts(f) {
    const count = table => f.shared.db.prepare('SELECT count(*) AS n FROM '+table).get().n;
    return {journal:f.store.metrics().journalRows, admissions:count('shared_admissions'), jobs:count('mobile_executions'), native:count('shared_native_requests'), calls:f.calls()};
}

async function runProvider(f, id, packets) {
    const engine = f.portal.engine;
    f.control.modelResponse = packet => { packets.push(packet); };
    engine.db.prepare('UPDATE mobile_executions SET not_before=0 WHERE id=?').run(id);
    engine.setEndpoint({url:f.url+'/v1/chat/completions', key:'synthetic-only'});
    await wait(()=>{
        const row = engine.get(id);
        if (['failed','review_required'].includes(row.state)) throw Error(row.error_code);
        return row.state==='completed';
    }, 'portable work completed');
}

function packetTexts(packet) {
    return packet.messages.map(message=>{
        if (typeof message.content==='string') return message.content;
        assert.deepEqual(message.content.map(part=>part.type),['text']);
        return message.content[0].text;
    });
}

const markers = [
    ['Canvas', {content:'ARCHIVE_MARK '+canvas}, {content:'ACTIVE_MARK '+canvas}],
    ['reference', {content:'ARCHIVE_MARK', desktopReferences:[reference]}, {content:'ACTIVE_MARK', desktopReferences:[reference]}]
];

for (const [label, archived, active] of markers) {
    for (const client of ['desktop', 'PWA']) {
        test('portable context '+client+' sends with archived '+label+' and preserves full History', async t=>{
            const f = await fixture(t);
            t.after(()=>fs.rm(f.root,{recursive:true,force:true}));
            seedHistory(f, user('window-archive', archived.content, 10, archived));
            const checkpointId = compact(f);
            // Updating an archived row after the checkpoint changes last_seq and timestamp,
            // but leaves its original position in the conversation intact.
            editArchive(f, user('window-archive', archived.content, 30, archived));
            seedHistory(f, user('window-active', 'PORTABLE_ACTIVE', 40));
            const row = ()=>f.store.findMessage.get(f.topic.topic.ownerType, f.topic.topic.ownerId, f.topic.topic.topicId, 'window-archive');
            const before = row(), counts = durableCounts(f);
            let id;
            if (client==='desktop') {
                const desktop = await f.desktop('A');
                const result = await desktop.runtime.prepareSharedSend({serverSession:true, descriptor:desktop.descriptor, message:user('window-desktop','PORTABLE_CURRENT',50)});
                assert.ok(result.admissionId);
                assert.equal(result.serverSession?.executionId,result.admissionId);
                id = result.admissionId;
            } else {
                const phone = await f.phone();
                id = (await phone.call('/conversations/'+f.topic.id+'/messages',{requestId:'window-pwa-request', text:'PORTABLE_CURRENT'},202)).id;
            }
            const packets = [];
            await runProvider(f,id,packets);
            assert.equal(packets.length,1);
            assert.deepEqual(durableCounts(f),{journal:counts.journal+2,admissions:counts.admissions+1,jobs:counts.jobs+1,native:counts.native+1,calls:counts.calls+1});
            assert.deepEqual(packetTexts(packets[0]),['FROZEN_SHARED_PROMPT','PORTABLE_CHECKPOINT','PORTABLE_ACTIVE','PORTABLE_CURRENT']);
            const serialized = JSON.stringify(packets[0]);
            for (const value of ['ARCHIVE_MARK',canvas,reference.id,reference.target]) assert.ok(!serialized.includes(value),value);
            assert.deepEqual(row(),before);
            assert.ok(f.store.findMessage.get(f.topic.topic.ownerType, f.topic.topic.ownerId, f.topic.topic.topicId, checkpointId));
        });

        test('portable context '+client+' keeps active '+label+' desktop-owned', async t=>{
            const f = await fixture(t);
            t.after(()=>fs.rm(f.root,{recursive:true,force:true}));
            seedHistory(f, user('window-archive','archive',10));
            compact(f);
            seedHistory(f, user('window-active',active.content,30,active));
            const before = durableCounts(f);
            if (client==='desktop') {
                const desktop = await f.desktop('A');
                const accepted = await desktop.runtime.prepareSharedSend({serverSession:true, descriptor:desktop.descriptor, message:user('fallback-desktop','NEXT INPUT',50)});
                assert.equal(accepted.serverSession,undefined);
                const saved = f.shared.db.prepare('SELECT principal,state FROM shared_admissions WHERE id=?').get(accepted.admissionId);
                assert.deepEqual({...saved},{principal:'desktop:deviceA',state:'accepted'});
                const after = durableCounts(f);
                assert.deepEqual(after,{...before,journal:before.journal+1,admissions:before.admissions+1});
                const response = await f.dispatch(desktop,accepted);
                await f.reply(desktop,accepted,response);
                assert.deepEqual(durableCounts(f),{...after,journal:after.journal+1,native:after.native+1,calls:after.calls+1});
                assert.equal(f.shared.db.prepare('SELECT state FROM shared_admissions WHERE id=?').get(accepted.admissionId).state,'completed');
            } else {
                const phone = await f.phone();
                const value = await phone.call('/conversations/'+f.topic.id+'/messages',{requestId:'portable-pwa-fail',text:'NEXT INPUT'},409);
                assert.equal(value.error.code,'DESKTOP_CONTEXT_REQUIRED');
                assert.deepEqual(durableCounts(f),before);
            }
        });
    }
}

for (const [label, config, input] of [
    ['system config', 'SYSTEM '+canvas, 'NEXT INPUT'],
    ['new input', 'PORTABLE_SYSTEM', 'NEXT '+canvas]
]) {
    test('portable context preserves '+label+' desktop dependency and denies PWA before Work', async t=>{
        const f = await fixture(t);
        t.after(()=>fs.rm(f.root,{recursive:true,force:true}));
        seedHistory(f, user('config-archive','ARCHIVE',10));
        compact(f);
        const current = f.shared.get(f.actor('A'),space,f.owner.id);
        f.shared.saveConfig(f.actor('A'),{sharedSpaceId:space,sharedId:f.owner.id,opId:'portable-config',expectedVersion:current.version,config:{...current.config,systemPrompt:config}});
        const phone = await f.phone();
        const before = durableCounts(f);
        const value = await phone.call('/conversations/'+f.topic.id+'/messages',{requestId:'portable-negative',text:input},409);
        assert.equal(value.error.code,'DESKTOP_CONTEXT_REQUIRED');
        assert.deepEqual(durableCounts(f),before);
        const desktop = await f.desktop('A');
        const accepted = await desktop.runtime.prepareSharedSend({serverSession:true,descriptor:desktop.descriptor,message:user('config-desktop',input,50)});
        assert.equal(accepted.serverSession,undefined);
        assert.equal(f.shared.db.prepare('SELECT principal FROM shared_admissions WHERE id=?').get(accepted.admissionId).principal,'desktop:deviceA');
        assert.deepEqual(durableCounts(f),{...before,journal:before.journal+1,admissions:before.admissions+1});
        await desktop.runtime.abandonSharedSend({descriptor:desktop.descriptor,requestId:'config-desktop',confirmed:true});
    });
}

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {createHash} = require('node:crypto');
const {fixture} = require('../native/fixtures/sharedSingleHarness.cjs');

const name = 'synthetic-continuity.txt';
const bytes = Buffer.from('合成附件基线：北桥样本 73。\nSYNTHETIC_FILE_SENTINEL_73\n');
const hash = createHash('sha256').update(bytes).digest('hex');
const marker = 'SYNTHETIC ATTACHMENT CONTINUITY';
const space = 'sharedAB';
const message = (id, attachments = []) => ({id, role:'user', content:marker, timestamp:Date.now(), attachments});

function counts(f) {
    const tables = ['shared_admissions', 'mobile_executions', 'shared_native_requests',
        'attachment_uploads', 'attachment_blobs', 'attachment_links'];
    return {
        journal:f.store.metrics().journalRows,
        provider:f.calls(),
        ...Object.fromEntries(tables.map(table=>[table,f.shared.db.prepare('SELECT count(*) AS n FROM '+table).get().n]))
    };
}

function desktopHeaders(f, device) {
    return {
        'x-nativesync-source':'source'+device,
        'x-nativesync-device':'device'+device,
        'x-nativesync-space':f.store.sourceCatalog.spaceId,
        'x-nativesync-capabilities':'shared-space-v1,shared-attachments-v1,shared-session-v1,desktop-references-v1',
        'content-type':'application/json'
    };
}

async function expectError(pending, status, code) {
    const response = await pending;
    assert.equal(response.headers.get('content-disposition'),null);
    const value = await response.json();
    assert.equal(response.status,status,JSON.stringify(value));
    assert.equal(value.error.code,code);
    assert.ok(!JSON.stringify(value).includes(name));
    assert.ok(!JSON.stringify(value).includes(hash));
    assert.ok(!JSON.stringify(value).includes('SYNTHETIC_FILE_SENTINEL_73'));
}

test('A-only live reference stays desktop-owned and cannot become an attachment or server turn',async t=>{
    const f = await fixture(t,{attachments:true});
    t.after(()=>fs.rm(f.root,{recursive:true,force:true}));
    const a = await f.desktop('A');
    const source = path.join(a.data,'private',name);
    await fs.mkdir(path.dirname(source),{recursive:true});
    await fs.writeFile(source,bytes);
    const privateAttachment = {id:'private-live-file', name, type:'text/plain', isLiveReference:true, sourcePath:source};
    const initial = counts(f);
    const accepted = await a.runtime.prepareSharedSend({serverSession:true,descriptor:a.descriptor,
        message:message('private-file',[privateAttachment])});
    assert.equal(accepted.serverSession,undefined);
    assert.deepEqual(counts(f),{...initial,journal:initial.journal+1,shared_admissions:initial.shared_admissions+1});
    const row = f.shared.db.prepare('SELECT principal FROM shared_admissions WHERE id=?').get(accepted.admissionId);
    assert.equal(row.principal,'desktop:deviceA');
    await a.runtime.abandonSharedSend({descriptor:a.descriptor,requestId:'private-file',confirmed:true});

    const b = await f.desktop('B');
    await b.runtime.tick();
    const onB = (await b.queue.read(b.descriptor)).find(m=>m.id==='private-file');
    assert.equal(onB.desktopReferences[0].availability,'desktop-only');
    assert.ok(!onB.attachments?.length);
    assert.equal(onB.desktopReferences[0].target,source);
    assert.ok(!JSON.stringify(onB).includes('SYNTHETIC_FILE_SENTINEL_73'));

    const before = counts(f);
    const phone = await f.phone();
    const key = '/conversations/'+f.topic.id;
    const mobile = await phone.call(key+'/messages',{requestId:'private-pwa-followup',text:marker},409);
    assert.equal(mobile.error.code,'DESKTOP_CONTEXT_REQUIRED');
    for (const device of ['A','B']) {
        const requestId = 'private-server-followup-'+device;
        await expectError(fetch(f.url+'/api/v1/sync/shared/session-send',{
            method:'POST',headers:desktopHeaders(f,device),
            body:JSON.stringify({sharedSpaceId:space,sharedId:f.topic.id,requestId,message:message(requestId)})
        }),409,'DESKTOP_CONTEXT_REQUIRED');
    }
    await expectError(fetch(f.url+'/api/plugins/NativeSync/shared-attachments/'+f.topic.id+'/messages/private-file/'+privateAttachment.id,{
        headers:desktopHeaders(f,'B')
    }),403,'ATTACHMENT_NOT_ALLOWED');
    assert.deepEqual(counts(f),before);
    assert.deepEqual(await fs.readFile(source),bytes);
});

test('C desktop and C mobile pairing cannot read shared attachment bytes or status',async t=>{
    const f = await fixture(t,{attachments:true});
    t.after(()=>fs.rm(f.root,{recursive:true,force:true}));
    const a = await f.desktop('A');
    const file = path.join(a.data,'UserData','attachments',hash,name);
    await fs.mkdir(path.dirname(file),{recursive:true});
    await fs.writeFile(file,bytes);
    const id = 'attachment_'+hash;
    const accepted = await a.runtime.prepareSharedSend({descriptor:a.descriptor,
        message:message('shared-file',[{id,name,hash,type:'text/plain',size:bytes.length,src:pathToFileURL(file).href}])});
    await f.reply(a,accepted,await f.dispatch(a,accepted));
    const attachmentPath = '/messages/shared-file/'+id;
    const desktopPath = '/api/plugins/NativeSync/shared-attachments/'+f.topic.id;
    const mobilePath = '/mobile/api/conversations/'+f.topic.id+'/attachments';
    const authorized = await f.phone();
    const authorizedPath = mobilePath.slice('/mobile/api'.length);
    assert.deepEqual(await authorized.download(authorizedPath+attachmentPath),bytes);
    const status = await authorized.call(authorizedPath+'/status',{messageIds:['shared-file']});
    assert.deepEqual(status,{attachments:[{messageId:'shared-file',attachmentId:id,state:'available',type:'text/plain'}]});
    const before = counts(f);
    assert.equal(before.attachment_links,1);

    const {pairingCode} = f.portal.createPairing({scopeMode:'shared',sharedSpaceId:'foreignSpace',permissions:['read']});
    const mobileHeaders = {
        origin:'https://synthetic-shared.invalid',
        'x-forwarded-proto':'https',
        'content-type':'application/json',
        'x-nativesync-capabilities':'shared-space-v1'
    };
    const paired = await fetch(f.url+'/mobile/api/pair',{
        method:'POST',headers:mobileHeaders,body:JSON.stringify({code:pairingCode})
    });
    assert.equal(paired.status,200);
    mobileHeaders.cookie = paired.headers.get('set-cookie').split(';')[0];
    for (const [base,headers,code] of [
        [desktopPath,desktopHeaders(f,'C'),'SHARED_SPACE_NOT_APPROVED'],
        [desktopPath.replace('/shared-attachments/','/source/shared-attachments/'),desktopHeaders(f,'C'),'SHARED_SPACE_NOT_APPROVED'],
        [mobilePath,mobileHeaders,'SHARED_PERMISSION_REQUIRED']
    ]) {
        await expectError(fetch(f.url+base+attachmentPath,{headers}),403,code);
        await expectError(fetch(f.url+base+'/status',{
            method:'POST',headers,body:JSON.stringify({messageIds:['shared-file']})
        }),403,code);
    }
    const topicQuery = new URLSearchParams({sharedSpaceId:space,sharedId:f.topic.id});
    await expectError(fetch(f.url+'/api/v1/sync/shared/topic-history?'+topicQuery,{
        headers:desktopHeaders(f,'C')
    }),403,'SHARED_SPACE_NOT_APPROVED');
    await expectError(fetch(f.url+'/mobile/api/conversations/'+f.topic.id,{
        headers:mobileHeaders
    }),403,'SHARED_PERMISSION_REQUIRED');
    assert.deepEqual(counts(f),before);
});

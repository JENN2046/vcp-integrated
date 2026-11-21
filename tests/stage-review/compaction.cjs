'use strict';

// Compare the actual compactor input before and after an authorized synthetic
// message deletion. No compaction result is generated, committed or sent on.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { start } = require('../integration/service.cjs');
const { stable, sha256 } = require('../../apps/server/Plugin/NativeSync/sync/protocol');
const root = path.resolve(__dirname, '../..');
async function waitUntil(fn, label, timeout=12000) {
    const deadline=Date.now()+timeout;
    while(Date.now()<deadline){const result=await fn();if(result)return result;await delay(30);}
    throw Error('Timed out on '+label);
}

async function main() {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-review-compact-'));
    const cert = path.join(out,'cert.pem'), key=path.join(out,'key.pem');
    execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=Synthetic review',
        '-addext','subjectAltName=IP:127.0.0.1','-out',cert,'-keyout',key],{stdio:'ignore'});
    let service, db;
    try {
        service = await start({out,candidate:root,cert,key,waitUntil,trace(){}});
        fs.unlinkSync(key);
        db = new DatabaseSync(path.join(service.data,'central.sqlite'),{readOnly:true});
        const headers={'content-type':'application/json',authorization:'Bearer synthetic-only',
            'x-nativesync-space':JSON.parse(fs.readFileSync(path.join(out,'seed/desktopA/.native-sync/connection.json'))).spaceId,
            'x-nativesync-source':'sourceA','x-nativesync-device':'deviceA',
            'x-nativesync-capabilities':'shared-space-v1,shared-context-v1,shared-controlled-text-v1,shared-steering-v1'};
        const url=service.wsOrigin.replace(/^ws:/,'http:');
        async function call(route,body,moreHeaders={}) {
            const res=await fetch(url+route,{method:body?'POST':'GET',headers:{...headers,...moreHeaders},body:body?JSON.stringify(body):undefined});
            const value=await res.json();
            assert.ok(res.ok,route+' '+res.status+' '+JSON.stringify(value));
            return value;
        }
        const api=(route,body)=>call('/api/v1/sync/shared/'+route,body);
        const sharedSpaceId='sharedAB',sharedId=service.topics.preSubmit.id;
        const scope={sharedSpaceId,sharedId}, context=()=>api('context?'+new URLSearchParams(scope));
        const initial=await context();
        const input={id:randomUUID(),role:'user',content:'Compaction review: synthetic text only.',timestamp:Date.now()};
        const work=await api('admit',{...scope,requestId:input.id,expectedHead:initial.head,configHash:initial.hash,message:input,controlMode:'text-only-v1'});
        const requestId='reply_'+work.id;
        const {itemId,topicId}=service.descriptors.A.preSubmit;
        const packet={requestId,model:'synthetic',stream:false,messages:[{role:'user',content:input.content}],
            vcpchatExtensions:{requestContext:{ownerType:'agent',agentId:itemId,topicId}}};
        await api('native-request',{sharedSpaceId,admissionId:work.id,requestId,bodyHash:sha256(stable(packet)),generation:0,consumedInputSeq:0});
        const reply=await call('/v1/chat/completions',packet,{
            'x-nativesync-admission':work.id,'x-nativesync-generation':'0','x-nativesync-consumed-input-seq':'0'});
        const content=reply.choices[0].message.content;
        assert.ok(content);
        const finished=await api('steer-turn-complete',{sharedSpaceId,workId:work.id,opId:randomUUID(),generation:0,
            message:{id:requestId,role:'assistant',content,timestamp:Date.now(),finishReason:'completed'}});
        assert.equal(finished.workState,'completed');
        const editedText = 'Updated synthetic reply for the compaction review.';
        async function readInput() {
            const prepared=await api('compact-prepare',{...scope,opId:randomUUID(),expectedHead:(await context()).head});
            const source=await api('compact-input?'+new URLSearchParams({sharedSpaceId,id:prepared.id}));
            await api('compact-cancel',{sharedSpaceId,id:prepared.id,opId:randomUUID()});
            return source.history.filter(row=>row.content===content||row.content===editedText)
                .map(row=>({id:row.id,role:row.role,textVersion:row.content===content?'original':'edited'}));
        }
        const original=await readInput();
        const readReply=db.prepare('SELECT hash,deleted FROM messages WHERE topic_id=? AND msg_id=?');
        const originalRow=readReply.get(sharedId,requestId);
        await api('message',{...scope,operation:{opId:randomUUID(),msgId:requestId,action:'upsert',
            baseHash:originalRow.hash,deviceId:'desktop:deviceA',message:{id:requestId,role:'assistant',content:editedText,timestamp:Date.now()}}});
        const afterEdit=await readInput(),editedRow=readReply.get(sharedId,requestId);
        assert.notEqual(editedRow.hash,originalRow.hash);
        await api('message',{...scope,operation:{opId:randomUUID(),msgId:requestId,action:'delete',baseHash:editedRow.hash,deviceId:'desktop:deviceA'}});
        const projection=db.prepare('SELECT deleted,last_seq FROM messages WHERE topic_id=? AND msg_id=?').get(sharedId,requestId);
        assert.equal(projection.deleted,1);
        const tombstone=db.prepare('SELECT seq, msg_id, action FROM journal WHERE seq=?').get(projection.last_seq);
        assert.equal(tombstone.action,'delete');
        assert.equal(tombstone.msg_id,requestId);
        const actual=await readInput();
        assert.equal(service.calls.length,1);
        const sources={};
        for (const file of ['Plugin/NativeSync/sync/sharedCompaction.js','modules/nativeContinuationStore.cjs']) {
            sources[file]=sha256(fs.readFileSync(path.join(out,'runtime-box',file)));
            assert.equal(sources[file],sha256(fs.readFileSync(path.join(root,'apps/server',file))));
        }
        const receipt={workId:work.id,requestId,workState:finished.workState,contentSha256:sha256(content),sources,journalTombstone:tombstone,
            beforeEdit:original,afterEdit,afterDelete:actual,
            deletedContentOfferedToCompactor:actual.some(row=>row.textVersion==='original'),
            revision:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),
            providerCalls:service.calls.length};
        console.log(JSON.stringify(receipt,null,2));
    } finally {
        db?.close();
        if(service)await service.close();
        fs.rmSync(out,{recursive:true,force:true});
    }
}
main().catch(err=>{console.error(err.message);process.exitCode=1;});

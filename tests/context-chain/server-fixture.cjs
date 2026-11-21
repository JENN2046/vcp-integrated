'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { start: startService } = require('../integration/service.cjs');
const { setTimeout: delay } = require('node:timers/promises');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const root = path.resolve(__dirname, '../..');
const evidenceRoot = path.join(root, '.runs/context-chain/server');
const preload = path.join(__dirname, 'server-capture.cjs');
const contract = require(path.join(root,'tests/context-chain/input.json'));
const prior = contract.history;
const sharedInput = contract.input;
const nativeInput = contract.input;
const sha = bytes => require('node:crypto').createHash('sha256').update(bytes).digest('hex');
async function seedContext(f, source, out, history, contract) {
    assert.ok(contract.agent && Number.isFinite(contract.agent.temperature));
    const { AttachmentStore } = require(path.join(root,'apps/server/Plugin/NativeSync/mobile/attachments'));
    const { envelopeFor } = require(path.join(root,'apps/server/Plugin/NativeSync/sync/metadata'));
    const actor=f.actor('C'), topic={...source.topic,key:source.id};
    f.shared.saveConfig(actor,{sharedSpaceId:'sharedAB',sharedId:f.owner.id,opId:'context-config',
        expectedVersion:f.owner.version,config:{...f.owner.config,name:contract.agentName,model:contract.model,
            ...contract.agent,systemPrompt:contract.systemPrompt,tavernRules:contract.rules}});
    const rootData=path.join(out,'data');fs.mkdirSync(rootData);
    const storage=new AttachmentStore({store:f.store,root:rootData,topics:[topic]});
    const bytes=Buffer.from(contract.attachment.text),digest=sha(bytes),attachmentId='attachment_'+digest;
    const messageId='ctx-retained-user';
    const created=storage.begin(actor.principal,topic.key,{requestId:'ctx-retained-upload',name:contract.attachment.name,
        type:contract.attachment.type,size:bytes.length,expectedHash:digest,messageId,attachmentId});
    const chunked=storage.chunk(actor.principal,topic.key,created.uploadId,{offset:0,data:bytes.toString('base64')});
    const finished=await storage.finish(actor.principal,topic.key,created.uploadId);
    const claimed=storage.claim(actor.principal,topic.key,[created.uploadId]);
    assert.equal(claimed[0].id,attachmentId);
    for (const row of history) {
        const message=row.id===messageId?{...row,attachments:claimed}:row;
        const metadata=envelopeFor(message,1);
        f.store.apply({...source.topic,msgId:row.id,deviceId:actor.principal,opId:row.id,baseHash:null,
            action:'upsert',message,...(metadata?{metadata}:{})}, {sharedSpace:'sharedAB',metadataPublisher:true,attachmentPrincipal:actor.principal});
    }
    const linked=storage.locate(topic.key,messageId,attachmentId);
    assert.equal(sha(linked.bytes),digest);
    fs.writeFileSync(path.join(out,'attachment-proof.json'),JSON.stringify({messageId,attachmentId,digest,bytes:bytes.length,
        uploadState:created.state,chunkOffset:chunked.offset,finishState:finished.state,claimHash:claimed[0].hash,boundBlobHash:linked.blob.hash
    },null,2)+'\n',{mode:0o600});
}
const waitUntil = async (fn, label, timeout = 12000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
        const result = await fn();
        if (result) return result;
        await delay(45);
    }
    throw Error('Timed out: ' + label);
};
const parseRows = file => fs.existsSync(file) ? fs.readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];

async function start(options = {}) {
    assert.equal(process.versions.node.split('.')[0], '24');
    fs.mkdirSync(evidenceRoot,{recursive:true});
    const out = fs.mkdtempSync(path.join(evidenceRoot,'run-'));
    fs.chmodSync(out, 0o700);
    const { contract: spec = contract, prior: seed = spec.history } = options;
    const cert = path.join(out,'cert.pem'), key = path.join(out,'key.pem');
    execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=VCP context fixture',
        '-addext','subjectAltName=IP:127.0.0.1','-out',cert,'-keyout',key], {stdio:'ignore'});
    const handlerLog = path.join(out,'handler.jsonl');
    const providerLog = path.join(out,'provider.jsonl');
    let service;
    try {
        service = await startService({out,candidate:root,cert,key,trace(){},waitUntil,mode:'context-chain',
            observedContext:{
                seedCount:seed.length,preload,handlerLog,reply:spec.reply,input:spec.input,
                seed:(f,topic,out)=>seedContext(f,topic,out,seed,spec),
                recordProvider(route,body) {
                    const current=Array.isArray(body.messages)?body.messages.findLast(row=>row.role==='user')?.content:null;
                    const text=typeof current==='string'?current:Array.isArray(current)?current.map(part=>part?.text||'').join(''):null;
                    if(!text?.startsWith(spec.input))return;
                    const { requestId, messages, model, stream, temperature, max_tokens, tools, tool_choice }=body;
                    fs.appendFileSync(providerLog,JSON.stringify({ route,requestId,messages,model,stream,temperature,max_tokens,tools,tool_choice,body })+'\n',
                        {mode:0o600});
                },
            },
        });
    } finally {
        fs.unlinkSync(key);
    }
    service.disarmDrop();
    const db = new DatabaseSync(path.join(service.data,'central.sqlite'),{readOnly:true});
    const topic = service.topics.preSubmit;
    const ready = { out, origin:service.origin, completionUrl:service.origin+'/v1/chat/completions', cert,
        plainLoopbackOrigin:service.wsOrigin, handlerLog, providerLog, profileSeed:path.join(out,'seed','desktopA'),
        stageHost:path.join(out,'runtime-box'), sharedInput:spec.input, nativeInput:spec.input, prior:seed, topic,
        agent:spec.agentName, descriptor:service.descriptors.A.preSubmit, backendPid:service.backendPid };
    const snapshot = () => ({
        handler:parseRows(handlerLog), provider:parseRows(providerLog),
        attachment:JSON.parse(fs.readFileSync(path.join(out,'attachment-proof.json'),'utf8')),
        work:db.prepare('SELECT id,request_id,state,attempts,request_dispatched,user_message_id,user_seq,reply_message_id FROM mobile_executions WHERE topic_key=? ORDER BY rowid').all(topic.id),
        journal:db.prepare('SELECT seq,msg_id,action,message_json FROM journal WHERE topic_id=? ORDER BY seq').all(topic.id)
            .map(({message_json,...row})=>({...row,message:JSON.parse(message_json)})),
        submissions:service.requests.filter(row=>row.route.endsWith('/shared/session-send')).map(({route,status,body,response})=>({
            route,status,requestId:body?.requestId,userMessageId:body?.message?.id,workId:response?.workId,
        })),
    });
    fs.writeFileSync(path.join(out,'ready.json'),JSON.stringify(ready,null,2)+'\n',{mode:0o600});
    return { ...ready, snapshot, waitUntil, async close(){
        db.close();
        return service.close();
    } };
}
module.exports = { start, prior, sharedInput, nativeInput, waitUntil };

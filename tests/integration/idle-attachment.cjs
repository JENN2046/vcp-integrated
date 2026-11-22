'use strict';
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { fileURLToPath } = require('node:url');
const { DatabaseSync } = require('node:sqlite');
const { envelopeFor } = require('../../apps/desktop/modules/services/nativeSync/metadata');
const { syncHeaders } = require('../../apps/desktop/modules/services/nativeSync/syncRequest');
const bytes = Buffer.from('NativeSync isolated missing attachment fixture\n');
const hash = createHash('sha256').update(bytes).digest('hex');
const attachment = { id:'attachment_' + hash, name:'synthetic-missing.txt', type:'text/plain',
    hash, blobHash:hash, size:bytes.length };
const message = { id:'synthetic-missing-attachment', role:'user', content:'SYNTHETIC ATTACHMENT REPAIR',
    attachments:[attachment], timestamp:1700000000000 };
function seed(f, topic) {
    f.store.apply({...topic.topic, msgId:message.id, message, deviceId:f.actor('C').principal,
        opId:'synth-missing-attachment-op', action:'upsert', baseHash:null, metadata:envelopeFor(message,1)},
        {sharedSpace:'sharedAB',metadataPublisher:true});
}
async function scenario({B,out,service,cert,click,evalJs,waitUntil}) {
    const hits = status => service.requests.filter(row => row.route.endsWith('/messages/'+message.id+'/'+attachment.id)
        && row.method==='GET' && row.status===status);
    await waitUntil(() => hits(404).length >= 2, 'both caught-up desktops confirm real CAS miss', 15000);
    const miss = hits(404);
    assert.equal(miss.length,2);
    assert.deepEqual(miss.map(row=>row.device).sort(),['deviceA','deviceB']);
    const target = service.descriptors.B.preSubmit;
    const selection = () => evalJs(B,'window.VCPStateChannels.get("conversation.current").get()');
    if (!await evalJs(B,"document.querySelector('#tabContentAgents').classList.contains('active')")) {
        await click(B,'.sidebar-tab-button[data-tab="agents"]');
    }
    await click(B,'#agentList > li .agent-name','Synthetic shared');
    await waitUntil(async()=> (await selection()).topicId===target.topicId,'selected original attachment topic');
    await waitUntil(async()=> (await evalJs(B,'document.querySelector("#chatMessages")?.innerText||""')).includes(message.content),
        'selected topic rendered from durable native History');

    const connection = JSON.parse(fs.readFileSync(path.join(out,'profile-A/.native-sync/connection.json')));
    const base = '/api/plugins/NativeSync/shared-attachments/' + service.topics.preSubmit.id;
    const headers = {...syncHeaders(connection), Authorization:'Bearer synthetic-only',
        'X-NativeSync-Protocol':'2','X-NativeSync-Capabilities':'shared-space-v1,shared-attachments-v1',
        'content-type':'application/json'};
    async function post(route, body, status) {
        return new Promise((resolve,reject) => {
            const req = https.request(service.origin + route, { method:'POST', headers, ca:fs.readFileSync(cert) }, res => {
                const chunks=[];
                res.on('data',c=>chunks.push(c));
                res.on('end',()=>{
                    const value=Buffer.concat(chunks).toString();
                    try { assert.equal(res.statusCode,status,value); resolve(JSON.parse(value)); } catch(error) { reject(error); }
                });
                res.on('error',reject);
            });
            req.on('error',reject);
            req.end(JSON.stringify(body));
        });
    }
    const uploaded = await post(base+'/uploads',{requestId:'synthetic-attachment-cas-repair',name:attachment.name,
        size:bytes.length,expectedHash:hash,type:attachment.type,messageId:message.id,attachmentId:attachment.id},201);
    await post(base+'/uploads/'+uploaded.uploadId+'/chunks',{offset:0,data:bytes.toString('base64')},200);
    const repairedAt=Date.now();
    const finalized=await post(base+'/uploads/'+uploaded.uploadId+'/finish',{},200);
    assert.equal(finalized.hash,hash);
    const materialized = await waitUntil(() => {
        const result = {};
        for (const role of ['A','B']) {
            const d=service.descriptors[role].preSubmit;
            const f=path.join(out,'profile-'+role,'UserData',d.itemId,'topics',d.topicId,'history.json');
            const ref=JSON.parse(fs.readFileSync(f)).find(m=>m.id===message.id)?.attachments?.[0];
            if (!ref?.internalPath) return false;
            const local=fileURLToPath(ref.internalPath);
            if (!local.startsWith(path.join(out,'profile-'+role,'UserData','attachments')+path.sep)) return false;
            const localHash=createHash('sha256').update(fs.readFileSync(local)).digest('hex');
            if (localHash!==hash) return false;
            result[role]={localHash,bytes:fs.statSync(local).size};
        }
        return result;
    },'both desktops retry and restore the exact CAS bytes',85000);
    const db=new DatabaseSync(path.join(service.data,'central.sqlite'),{readOnly:true});
    let journalRows;
    try { journalRows=db.prepare('SELECT COUNT(*) AS n FROM journal').get().n; } finally { db.close(); }
    assert.equal(journalRows,1);
    assert.equal(hits(404).length,2);
    assert.equal(hits(200).length,2);
    assert.equal(service.calls.length,0);
    return { miss, recovered:hits(200), sinceUploadMs:Date.now()-repairedAt, materialized, journalRows, providerCalls:0 };
}
module.exports = { seed, scenario, attachment };

'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process'),{pathToFileURL,fileURLToPath}=require('node:url');
const {fixture, CHAT, BOX}=require('./fixtures/sharedSingleHarness.cjs');
const {HistoryMutationQueue}=require(CHAT+'/modules/services/historyMutationQueue');
const {NativeSyncAdapter}=require(CHAT+'/modules/services/nativeSync/adapter');
const {DesktopAttachments}=require(CHAT+'/modules/services/nativeSync/attachments');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const topic={itemType:'agent',itemId:'owner',topicId:'one'};
async function local(root,initialize=true) {
    if(initialize) {
        await fs.mkdir(path.join(root,'Agents/owner'),{recursive:true});
        await fs.writeFile(path.join(root,'Agents/owner/config.json'),JSON.stringify({name:'test',topics:[{id:'one'}]}));
    }
    const queue=new HistoryMutationQueue({userDataDir:path.join(root,'UserData')});
    const adapter=await NativeSyncAdapter.open({queue,statePath:path.join(root,'state.json'),deviceId:'commit-test',url:'http://127.0.0.1:1',token:'synthetic',topics:[topic]});
    let reads=0;const original=queue.readSnapshot.bind(queue);
    queue.readSnapshot=(...args)=>{reads++;return original(...args)};
    const uploads=[];let active;
    const a=new DesktopAttachments({queue,appDataRoot:root,connection:{topics:[topic]},getMapping:()=>[{key:'local',ownerType:'agent',ownerId:'owner',topicId:'one'}],
        send:async(route,{body})=>{if(route.endsWith('/uploads')){active=body.expectedHash;uploads.push([body.messageId,body.attachmentId,active]);return{state:'ready',uploadId:'test'};}return{hash:active};}});
    adapter.attachmentRecovery=a;
    return {queue,adapter,a,uploads,reads:()=>reads,close:async()=>{await adapter.close();await queue.dispose()}};
}
async function file(root,id,text) {
    const bytes=Buffer.from(text),value=hash(bytes),name=id+'.txt',f=path.join(root,'UserData/attachments',value,name);
    await fs.mkdir(path.dirname(f),{recursive:true});await fs.writeFile(f,bytes);
    return {id,name,hash:value,size:bytes.length,type:'text/plain',src:pathToFileURL(f).href};
}
test('local commits process only changed references, with no History scan for ordinary edits or idle ticks', async t=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'ns-attach-local-'));const l=await local(root);
    t.after(async()=>{await l.close();await fs.rm(root,{recursive:true,force:true})});
    await l.a.work.run([topic]);const firstReads=l.reads();
    const one=await file(root,'one','initial'),two=await file(root,'two','unchanged');
    await l.queue.mutate(topic,()=>[{id:'m',role:'user',content:'input',timestamp:1,attachments:[one,two]},{id:'neighbor',role:'user',content:'another message',timestamp:2}]);
    await l.a.work.run([topic]);assert.deepEqual(l.uploads.map(x=>x[1]),['one','two']);
    await l.queue.mutate(topic,h=>h.map(m=>({...m,content:m.content+' edit'})));
    await l.a.work.run([topic]);assert.equal(l.uploads.length,2);
    const newOne=await file(root,'one','replacement');
    await l.queue.mutate(topic,h=>h.map(m=>m.id==='m'?{...m,attachments:[newOne,two]}:m));
    await l.a.work.run([topic]);assert.deepEqual(l.uploads.slice(2),[['m','one',newOne.hash]]);
    for(let i=0;i<8;i++)await l.a.work.run([topic]);assert.equal(l.reads(),firstReads);
});
test('abrupt exit after native History write but before its observer recovers the attachment once', async t=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'ns-attach-crash-'));
    t.after(()=>fs.rm(root,{recursive:true,force:true}));
    const l=await local(root);await l.a.work.run([topic]);const ref=await file(root,'proof','after restart');await l.close();
    const script=`(async()=>{const q=new (require(process.env.CHAT+'/modules/services/historyMutationQueue').HistoryMutationQueue)({
        userDataDir:process.env.ROOT+'/UserData',commitFault:stage=>{if(stage==='history-written')process.exit(77)}});const d=JSON.parse(process.env.TOPIC);
        const adapter=await require(process.env.CHAT+'/modules/services/nativeSync/adapter').NativeSyncAdapter.open({queue:q,statePath:process.env.ROOT+'/state.json',deviceId:'commit-test',url:'http://127.0.0.1:1',token:'synthetic',topics:[d]});
        adapter.attachmentRecovery=new (require(process.env.CHAT+'/modules/services/nativeSync/attachments').DesktopAttachments)({queue:q,appDataRoot:process.env.ROOT,connection:{topics:[d]}});
        await q.mutate(d,()=>[{id:'crash',role:'user',content:'recover',timestamp:1,attachments:[JSON.parse(process.env.REF)]}]);})().catch(e=>{console.error(e);process.exit(1)})`;
    const child=spawnSync(process.execPath,['-e',script],{env:{...process.env,CHAT,ROOT:root,REF:JSON.stringify(ref),TOPIC:JSON.stringify(topic)},encoding:'utf8'});
    assert.equal(child.status,77,child.stderr);
    const recovered=await local(root,false);t.after(()=>recovered.close());
    await recovered.a.work.run([topic]);await recovered.a.work.run([topic]);assert.deepEqual(recovered.uploads,[['crash','proof',ref.hash]]);
    assert.equal(recovered.reads(),1);assert.equal((await recovered.queue.read(topic)).length,1);
    assert.equal(recovered.adapter.state.outbox.length,1);
});
test('remote attachment edit restores just the replacement, without reading an unrelated History or executing again',async t=>{
    const f=await fixture(t,{attachments:true}),a=await f.desktop('A'),b=await f.desktop('B');
    const first=await file(a.data,'first','before');
    const second=await file(a.data,'second','unchanged');
    const message={id:'proof-message',role:'user',content:'fixture',timestamp:1,attachments:[first,second]};
    const accepted=await a.runtime.prepareSharedSend({descriptor:a.descriptor,message});
    await f.reply(a,accepted,await f.dispatch(a,accepted));await b.runtime.tick();const calls=f.calls();
    const receiver=b.runtime.attachments;let reads=0;const original=receiver.queue.readSnapshot;
    receiver.queue.readSnapshot=(...args)=>{reads++;return original(...args)};
    const routes=[],download=receiver.download;receiver.download=route=>{routes.push(route);return download(route)};
    const bytes=Buffer.from('after'),newHash=hash(bytes),id='replacement',ref={id,name:'replacement.txt',hash:newHash,type:'text/plain',size:bytes.length};
    await a.runtime.attachments.uploadBytes({key:f.topic.id},message,ref,bytes,ref.name,newHash,ref.type);
    const row=f.store.findMessage.get(f.topic.topic.ownerType,f.topic.topic.ownerId,f.topic.topic.topicId,message.id);
    const old=f.store.projectMessage(row);
    const edited={...old,attachments:[ref,old.attachments[1]]};delete edited._nativeSyncMetadata;
    const envelope=require(BOX+'/Plugin/NativeSync/sync/metadata').envelopeFor(edited,row.metadata_version+1);
    f.shared.editMessage(f.actor('A'),{sharedSpaceId:'sharedAB',sharedId:f.topic.id,operation:{deviceId:f.actor('A').principal,opId:'replace-one',msgId:message.id,baseHash:row.hash,action:'upsert',message:edited,metadata:envelope}});
    await b.runtime.tick();await b.runtime.tick();
    assert.equal(reads,0);assert.equal(routes.length,1);assert(routes[0].endsWith('/proof-message/replacement'));
    const current=(await b.queue.read(b.descriptor)).find(m=>m.id===message.id);assert.deepEqual(await fs.readFile(fileURLToPath(current.attachments[0]._fileManagerData.internalPath)),bytes);
    assert.equal(current.attachments[1].hash,second.hash);assert.equal(f.calls(),calls);
    // A file removed outside the app is repaired on access. Idle maintenance
    // never has to inventory successful refs just to detect a missing local file.
    await fs.unlink(fileURLToPath(current.attachments[0]._fileManagerData.internalPath));
    assert.equal(await receiver.checkOpenedFile(b.descriptor,message.id,id,newHash),true);
    await b.runtime.tick();
    assert.equal(routes.length,2);assert.equal(reads,1);
    assert.deepEqual(await fs.readFile(fileURLToPath(current.attachments[0]._fileManagerData.internalPath)),bytes);
    assert.equal(await receiver.checkOpenedFile(b.descriptor,message.id,id,newHash),false);
    assert.equal(f.calls(),calls);
});

test('a late download cannot reintroduce a superseded attachment into History',async()=>{
    const before=Buffer.from('before'),after=Buffer.from('after');
    const ref=bytes=>({id:'fixed',name:'proof.txt',hash:hash(bytes),size:bytes.length,type:'text/plain'});
    let release,started,reads=0,mutations=0,history=[];
    const gate=new Promise(ok=>release=ok),requestStarted=new Promise(ok=>started=ok);
    const a=new DesktopAttachments({appDataRoot:os.tmpdir(),connection:{topics:[topic]},getMapping:()=>[{key:'T',ownerType:'agent',ownerId:'owner',topicId:'one'}],
        queue:{readSnapshot:async()=>{reads++;return{history}},mutate:async(_d,fn)=>{history=fn(history);mutations++;return {}}},
        download:async()=>{if(!started)return after;started();started=null;await gate;return before},
        storeAttachment:async bytes=>({hash:hash(bytes),internalPath:'file:///fixture/'+hash(bytes)})});
    await a.work.run([topic]);history=[{id:'M',attachments:[ref(before)]}];
    a.work.offer(topic,'M',['fixed'],history[0],false);
    const pending=a.work.run([topic]);await requestStarted;
    history=[{id:'M',attachments:[ref(after)]}];a.work.offer(topic,'M',['fixed'],history[0],false);
    release();await pending;assert.equal(mutations,0);
    await a.work.run([topic]);assert.equal(mutations,1);assert.equal(reads,1);
    assert.equal(history[0].attachments[0]._fileManagerData.hash,hash(after));
});

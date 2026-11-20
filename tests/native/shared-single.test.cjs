'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,wait,BOX,CHAT,ctx,rejects}=require('./fixtures/sharedSingleHarness.cjs');

const msg=(id,content=id)=>({id,role:'user',content,timestamp:1,attachments:[]});
test('desktop A/B and mobile share admission and one history; frozen configuration, busy rejection and native tool route are enforced',async t=>{
 const f=await fixture(t),a=await f.desktop('A'),b=await f.desktop('B'),phone=await f.phone();
 const accepted=await a.runtime.prepareSharedSend({descriptor:a.descriptor,message:msg('desktop-A-message')});
 await assert.rejects(b.runtime.prepareSharedSend({descriptor:b.descriptor,message:msg('desktop-B-busy')}),rejects('SHARED_TOPIC_BUSY'));
 await phone.call('/conversations/'+f.topic.id+'/messages',{requestId:'phone-busy-request',text:'busy'},409);assert.equal(f.store.db.prepare('SELECT count(*) n FROM mobile_executions').get().n,0);
 const old=f.shared.get(f.actor('A'),'sharedAB',f.owner.id);f.shared.saveConfig(f.actor('A'),{sharedSpaceId:'sharedAB',sharedId:f.owner.id,opId:'change-after-accept',expectedVersion:old.version,config:{...old.config,model:'changed-only-for-later'}});
 for(const route of ['/v1/chatvcp/completions','/V1/CHATVCP/COMPLETIONS/']){const rejected=await fetch(f.url+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(f.packet(a,accepted))});assert.equal(rejected.status,409);assert.equal(f.calls(),0);}
 const spoofed=await fetch(f.url+'/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json','x-nativesync-source':'unapproved-source'},body:JSON.stringify(f.packet(a,accepted))});assert.equal(spoofed.status,409);assert.equal(f.calls(),0);
 const result=await f.dispatch(a,accepted,'/v1/chatvcp/completions');assert.equal(f.calls(),1);await f.reply(a,accepted,result);await b.runtime.tick();assert.equal((await b.queue.read(b.descriptor)).length,2);
 // Restore a supported synthetic provider for a later explicit mobile request.
 const current=f.shared.get(f.actor('A'),'sharedAB',f.owner.id);f.shared.saveConfig(f.actor('A'),{sharedSpaceId:'sharedAB',sharedId:f.owner.id,opId:'next-model',expectedVersion:current.version,config:{...current.config,model:'synthetic'}});
 await require(BOX+'/Plugin/NativeSync/mobile/sharedConfiguration').prepareSharedConfiguration(f.portal.engine.configs,f.portal.topics.find(x=>x.key===f.topic.id));
 const job=await phone.call('/conversations/'+f.topic.id+'/messages',{requestId:'phone-explicit-request',text:'phone accepted'},202);const replay=await phone.call('/conversations/'+f.topic.id+'/messages',{requestId:'phone-explicit-request',text:'phone accepted'},202);assert.equal(replay.id,job.id);assert.equal(replay.replayed,true);
 f.portal.engine.db.prepare('UPDATE mobile_executions SET not_before=0 WHERE id=?').run(job.id);f.portal.engine.setEndpoint({url:f.url+'/v1/chat/completions',key:'synthetic-only'});await wait(()=>{const row=f.portal.engine.get(job.id);if(row.state==='review_required')throw Error(row.error_code);return row.state==='completed';},'mobile completion');
 await a.runtime.tick();await b.runtime.tick();assert.equal(f.calls(),2);assert.equal((await a.queue.read(a.descriptor)).length,4);assert.deepEqual(await a.queue.read(a.descriptor),await b.queue.read(b.descriptor));assert.equal(f.shared.active(f.topic.id),undefined);
});
test('lost admission and pre-dispatch restart keep original IDs and config; reopening never calls the model',async t=>{
 const f=await fixture(t);let a=await f.desktop('A');f.control.dropAccept=1;
 await assert.rejects(a.runtime.prepareSharedSend({descriptor:a.descriptor,message:msg('original-identity','retained draft')}),rejects('NETWORK_UNAVAILABLE'));assert.equal(f.calls(),0);await a.close();a=await f.desktop('A');assert.equal(f.calls(),0);
 const accepted=await a.runtime.prepareSharedSend({descriptor:a.descriptor,message:msg('new-click-identity','retained draft')});assert.equal(accepted.userMessage.id,'original-identity');
 const body=f.packet(a,accepted);await a.runtime.execution.prepareNative(body.vcpchatExtensions.requestContext,body);await a.close();a=await f.desktop('A');assert.equal(f.calls(),0);
 const result=await f.dispatch(a,accepted);await f.reply(a,accepted,result);assert.equal(f.calls(),1);assert.equal(f.store.metrics().journalRows,2);
});
test('reply acceptance response lost only retries the durable receipt after reopen',async t=>{
 const f=await fixture(t);let a=await f.desktop('A'),accepted=await a.runtime.prepareSharedSend({descriptor:a.descriptor,message:msg('reply-loss-user')}),result=await f.dispatch(a,accepted);f.control.dropComplete=1;
 await assert.rejects(f.reply(a,accepted,result),rejects('NETWORK_UNAVAILABLE'));assert.equal(f.store.metrics().journalRows,2);await a.close();a=await f.desktop('A');assert.equal(f.calls(),1);assert.equal((await a.queue.read(a.descriptor)).length,2);assert.equal(Object.values(a.runtime.execution.state.requests)[0].phase,'completed');
});
test('a dispatched request remains held across backend reopen; abandon fences a late reply without a second call',async t=>{
 const f=await fixture(t),a=await f.desktop('A'),accepted=await a.runtime.prepareSharedSend({descriptor:a.descriptor,message:msg('unknown-user')}),packet=f.packet(a,accepted),prepared=await a.runtime.execution.prepareNative(packet.vcpchatExtensions.requestContext,packet);
 f.control.holdHttp=true;const pending=fetch(f.url+'/v1/chat/completions',{method:'POST',headers:{...prepared.headers,'content-type':'application/json'},body:JSON.stringify(prepared.body)}).catch(()=>null);await wait(()=>f.calls()===1,'native in flight');
 assert.throws(()=>f.shared.abandon(f.actor('A'),{sharedSpaceId:'sharedAB',admissionId:accepted.admissionId,opId:'cannot-abandon-running',confirm:true}),rejects('SHARED_REVIEW_CONFIRMATION_REQUIRED'));
 f.heldResponse.destroy();await pending;await wait(()=>f.shared.db.prepare('SELECT state FROM shared_admissions WHERE id=?').get(accepted.admissionId).state==='review_required','unknown held');
 // The response vanished after the synthetic model handler was entered.
 await f.reopenBackend();await a.runtime.execution.reconcile();await assert.rejects(a.runtime.prepareSharedSend({descriptor:a.descriptor,message:msg('another-click','unknown-user')}),rejects('SHARED_RESULT_REQUIRES_REVIEW'));
 f.shared.abandon(f.actor('A'),{sharedSpaceId:'sharedAB',admissionId:accepted.admissionId,opId:'human-abandon',confirm:true});
 await assert.rejects(f.reply(a,accepted,{choices:[{message:{content:'late result'}}]}),rejects('SHARED_REQUEST_FENCED'));assert.equal(f.calls(),1);assert.equal(f.store.metrics().journalRows,1);
});
test('internal mobile native context needs its private dispatch proof; queued cancellation releases only the original admission',async t=>{
 const f=await fixture(t),phone=await f.phone();
 const group=f.shared.create(f.actor('A'),{sharedSpaceId:'sharedAB',opId:'guarded-group',kind:'group',localId:'localGroup',config:{name:'Synthetic group',mode:'sequential',members:[f.owner.id]}}).object;
 f.shared.create(f.actor('A'),{sharedSpaceId:'sharedAB',opId:'guarded-group-topic',kind:'topic',parentId:group.id,localId:'group-topic',localParent:'localGroup',config:{name:'Group history'}});
 const unadmitted=await fetch(f.url+'/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'synthetic',requestId:'old-group-request',messages:[],vcpchatExtensions:{requestContext:{agentId:'origin',topicId:'group-topic',ownerType:'group',isGroupMessage:true}}})});assert.equal(unadmitted.status,409);assert.equal(f.calls(),0);
 const cancelled=await phone.call('/conversations/'+f.topic.id+'/messages',{requestId:'cancel-before-dispatch',text:'cancel this queued request'},202);
 await phone.call('/executions/'+cancelled.id+'/cancel',{},202);assert.equal(f.shared.active(f.topic.id),undefined);assert.equal(f.calls(),0);
 const accepted=await phone.call('/conversations/'+f.topic.id+'/messages',{requestId:'internal-proof-request',text:'one internal request'},202),row=f.portal.engine.get(accepted.id),published=JSON.parse(row.config_snapshot);
 const body={model:'synthetic',stream:false,requestId:row.id,messages:[{role:'user',content:'one internal request'}],vcpchatExtensions:{requestContext:{ownerType:'agent',agentId:f.topic.topic.ownerId,topicId:f.topic.topic.topicId}}};
 const registration=require(BOX+'/Plugin/NativeSync/mobile/sharedSingle').register(f.portal.engine,row,body,published);
 try{
  for(const proof of [undefined,'not-the-private-proof']){const response=await fetch(f.url+'/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json','x-nativesync-admission':row.id,...(proof?{'x-nativesync-native-proof':proof}:{})},body:JSON.stringify(body)});assert.equal(response.status,409);assert.equal((await response.json()).error.code,'SHARED_NATIVE_ADMISSION_REQUIRED');}
  assert.equal(f.calls(),0);const response=await fetch(f.url+'/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json',...registration.headers},body:JSON.stringify(body)});assert.equal(response.status,200);await response.json();assert.equal(f.calls(),1);
 }finally{registration();}
});
test('mobile accepted response loss and backend restart dispatch the original frozen request once',async t=>{
 const f=await fixture(t),phone=await f.phone(),payload={requestId:'lost-phone-response',text:'preserved phone input'};f.control.dropMobileResponse=1;
 await assert.rejects(phone.call('/conversations/'+f.topic.id+'/messages',payload,202));
 const before=f.store.db.prepare('SELECT * FROM mobile_executions').get();assert.equal(before.state,'queued');assert.equal(f.calls(),0);
 const current=f.shared.get(f.actor('A'),'sharedAB',f.owner.id);f.shared.saveConfig(f.actor('A'),{sharedSpaceId:'sharedAB',sharedId:f.owner.id,opId:'phone-config-after-accept',expectedVersion:current.version,config:{...current.config,model:'later-model'}});
 await f.reopenBackend();assert.equal(f.calls(),0);const replay=await phone.call('/conversations/'+f.topic.id+'/messages',payload,202);assert.equal(replay.id,before.id);
 f.portal.engine.db.prepare('UPDATE mobile_executions SET not_before=0 WHERE id=?').run(before.id);f.portal.engine.setEndpoint({url:f.url+'/v1/chat/completions',key:'synthetic-only'});
 await wait(()=>{const row=f.portal.engine.get(before.id);if(row.state==='review_required')throw Error(row.error_code);return row.state==='completed';},'recovered mobile request');
 assert.equal(f.calls(),1);assert.equal(f.store.metrics().journalRows,2);assert.equal(JSON.parse(f.portal.engine.get(before.id).config_snapshot).model,'synthetic');
});

test('shared group keeps one admission across frozen member steps and recovers an accepted member receipt without replay',async t=>{
 const f=await fixture(t),second=f.shared.create(f.actor('A'),{sharedSpaceId:'sharedAB',opId:'second-member',kind:'agent',localId:'second',config:{name:'Second',model:'synthetic',systemPrompt:'SECOND_FROZEN',temperature:0.4,streamOutput:false}}).object;
 const group=f.shared.create(f.actor('A'),{sharedSpaceId:'sharedAB',opId:'group-for-turn',kind:'group',localId:'local-group',config:{name:'Shared turn',mode:'sequential',members:[f.owner.id,second.id],sequentialSpeakerOrder:[second.id,f.owner.id]}}).object;
 const topic=f.shared.create(f.actor('A'),{sharedSpaceId:'sharedAB',opId:'group-topic-for-turn',kind:'topic',parentId:group.id,localId:'group-topic',localParent:'local-group',config:{name:'Group turn'}}).object;
 let a=await f.desktop('A');const b=await f.desktop('B'),descriptor={itemType:'group',itemId:a.runtime.localFor(group.id).localId,topicId:a.runtime.localFor(topic.id).localId};
 const prepared=await a.runtime.prepareSharedSend({descriptor,message:msg('group-user','one whole turn')});let record=prepared.record;
 assert.deepEqual(prepared.turn.plan,[second.id,f.owner.id]);
 const old=f.shared.get(f.actor('A'),'sharedAB',second.id);f.shared.saveConfig(f.actor('A'),{sharedSpaceId:'sharedAB',sharedId:second.id,opId:'later-member-model',expectedVersion:old.version,config:{...old.config,model:'later-only'}});
 for(const [index,memberId]of prepared.turn.plan.entries()){
  const slot=a.runtime.execution.groupStep(record,memberId),body={model:'synthetic',stream:false,requestId:slot.id,messages:[{role:'user',content:'one whole turn'}],vcpchatExtensions:{requestContext:{ownerType:'group',agentId:a.runtime.localFor(memberId).localId,groupId:descriptor.itemId,topicId:descriptor.topicId}}};
  const native=await a.runtime.execution.prepareGroupNative(record,memberId,body);if(index===1)assert.equal(f.shared.native.canReview(record.accepted.id),true);
  const response=await fetch(f.url+'/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json',...native.headers},body:JSON.stringify(native.body)});assert.equal(response.status,200);const result=await response.json();
  const reply={id:'reply_'+slot.id,role:'assistant',agentId:a.runtime.localFor(memberId).localId,content:result.choices[0].message.content,timestamp:index===0?10:0};
  if(index===0){f.control.dropComplete=1;await assert.rejects(a.runtime.execution.groupReply(record,reply),rejects('NETWORK_UNAVAILABLE'));await a.close();a=await f.desktop('A');assert.equal(f.calls(),1);record=a.runtime.execution.state.requests['group-user'];}
  else await a.runtime.execution.groupReply(record,reply);
  assert.ok(f.shared.active(topic.id));
  if(index===0){assert.throws(()=>f.shared.complete(f.actor('A'),{sharedSpaceId:'sharedAB',admissionId:record.accepted.id,opId:'premature-flow-finish',finish:true}),rejects('SHARED_NATIVE_TERMINAL_REQUIRED'));assert.equal(f.shared.active(topic.id).native_terminal,0);const d={itemType:'group',itemId:b.runtime.localFor(group.id).localId,topicId:b.runtime.localFor(topic.id).localId};await assert.rejects(b.runtime.prepareSharedSend({descriptor:d,message:msg('other-device','should keep draft')}),rejects('SHARED_TOPIC_BUSY'));}
 }
 await a.runtime.execution.groupDone(record);assert.equal(f.shared.active(topic.id),undefined);assert.equal(f.calls(),2);await b.runtime.tick();assert.equal((await a.queue.read(descriptor)).length,3);
 const ordered=require(BOX+'/Plugin/NativeSync/mobile/groupTurn').history(f.portal.engine,{id:'read-only-order-probe',topic_key:topic.id,ordinal:Number.MAX_SAFE_INTEGER,user_seq:f.store.metrics().headSeq});assert.deepEqual(ordered.map(m=>m.id),['group-user',...(record.steps||[]).map(s=>'reply_'+s.id)]);
});

test('regeneration preserves the target until new acceptance, replaces only that reply and recovers a lost final response',async t=>{
 const f=await fixture(t);let a=await f.desktop('A');
 const original=await a.runtime.prepareSharedSend({descriptor:a.descriptor,message:msg('original-user','original prompt')}),result=await f.dispatch(a,original);await f.reply(a,original,result);
 const context=f.shared.executionConfig(f.actor('A'),{sharedSpaceId:'sharedAB',sharedId:f.topic.id});
 const following=f.shared.admit(f.actor('A'),{sharedSpaceId:'sharedAB',sharedId:f.topic.id,requestId:'later-user-request',expectedHead:context.head,configHash:context.hash,message:msg('later-user','keep this later message')});
 f.shared.abandon(f.actor('A'),{sharedSpaceId:'sharedAB',admissionId:following.id,opId:'explicitly-stop-later',confirm:true});await a.runtime.tick();
 const regenerated=await a.runtime.prepareSharedSend({descriptor:a.descriptor,kind:'regenerate',targetId:original.replyId,message:msg('explicit-regeneration','')});
 assert.equal(regenerated.turn.targetId,original.replyId);assert.ok((await a.queue.read(a.descriptor)).some(m=>m.id===original.replyId));
 const packet=f.packet(a,regenerated);packet.omitted=undefined;packet.messages[0].name=undefined;
 const wire=await a.runtime.execution.prepareNative(packet.vcpchatExtensions.requestContext,packet);assert.equal(Object.hasOwn(wire.body,'omitted'),false);
 const sent=await fetch(f.url+'/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json',...wire.headers},body:JSON.stringify(wire.body)});assert.equal(sent.status,200,JSON.stringify(await sent.clone().json()));const next=await sent.json();f.control.dropComplete=1;await assert.rejects(f.reply(a,regenerated,next),rejects('NETWORK_UNAVAILABLE'));
 await a.close();a=await f.desktop('A');const history=await a.queue.read(a.descriptor);
 assert.ok(history.some(m=>m.id==='later-user'));assert.ok(!history.some(m=>m.id===original.replyId));assert.ok(history.some(m=>m.id===regenerated.replyId));assert.equal(f.calls(),2);assert.equal(f.shared.active(f.topic.id),undefined);
 assert.equal(f.store.db.prepare("SELECT count(*) n FROM journal WHERE msg_id=? AND action='upsert'").get(original.replyId).n,1);
 assert.equal(f.store.db.prepare("SELECT count(*) n FROM journal WHERE msg_id=? AND action='delete'").get(original.replyId).n,1);
});

test('shared mobile invitation on an empty group reuses the native group runner and one frozen plan',async t=>{
 const f=await fixture(t),group=f.shared.create(f.actor('A'),{sharedSpaceId:'sharedAB',opId:'mobile-group-owner',kind:'group',localId:'mg',config:{name:'Mobile shared',mode:'invite_only',members:[f.owner.id]}}).object;
 const topic=f.shared.create(f.actor('A'),{sharedSpaceId:'sharedAB',opId:'mobile-group-topic',kind:'topic',parentId:group.id,localId:'mgt',localParent:'mg',config:{name:'Mobile shared topic'}}).object;
 await require(BOX+'/Plugin/NativeSync/mobile/sharedConfiguration').prepareSharedConfiguration(f.portal.engine.configs,f.portal.topics.find(x=>x.key===topic.id));
 const phone=await f.phone(),job=await phone.call('/conversations/'+topic.id+'/invitations',{requestId:'shared-group-phone-send',agentId:f.owner.id},202);
 f.portal.engine.db.prepare('UPDATE mobile_executions SET not_before=0 WHERE id=?').run(job.id);f.portal.engine.setEndpoint({url:f.url+'/v1/chat/completions',key:'synthetic-only'});
 await wait(()=>{const row=f.portal.engine.get(job.id);if(['review_required','blocked_config'].includes(row.state))throw Error(row.error_code);return row.state==='completed';},'shared mobile group completed');
 assert.equal(f.calls(),1);assert.equal(f.shared.active(topic.id),undefined);assert.equal(f.portal.engine.db.prepare('SELECT count(*) n FROM mobile_execution_steps WHERE job_id=? AND attempts=1').get(job.id).n,1);
});

test('shared attachments reuse checked blobs, native local handles and mobile reads without echoes or cross-space grants',async t=>{
 const f=await fixture(t,{attachments:true}),a=await f.desktop('A'),b=await f.desktop('B'),fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2S8AAAAASUVORK5CYII=','base64'),text=Buffer.from('SHARED_ATTACHMENT_TEXT');
 const files=[];for(const [name,bytes,type]of [['pixel.png',png,'image/png'],['sample.txt',text,'text/plain']]){const hash=crypto.createHash('sha256').update(bytes).digest('hex'),file=path.join(f.root,'desktopA/UserData/attachments',hash,name);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,bytes);files.push({id:'attachment_'+hash,hash,name,size:bytes.length,type,src:require('node:url').pathToFileURL(file).href});}
 const accepted=await a.runtime.prepareSharedSend({descriptor:a.descriptor,message:{...msg('attachment-user','shared files'),attachments:files}});const answer=await f.dispatch(a,accepted);await f.reply(a,accepted,answer);assert.equal(f.calls(),1);
 await b.runtime.tick();const native=(await b.queue.read(b.descriptor)).find(m=>m.id==='attachment-user');assert.equal(native.attachments.length,2);for(const [i,file]of native.attachments.entries()){const source=file._fileManagerData?.internalPath||file.internalPath||file.src;assert(source.includes('desktopB'));assert.deepEqual(await fs.readFile(require('node:url').fileURLToPath(source)),i===0?png:text);}
 const phone=await f.phone();assert.deepEqual(await phone.download('/conversations/'+f.topic.id+'/attachments/messages/attachment-user/'+files[1].id),text);
 const response=await fetch(f.url+'/api/plugins/NativeSync/shared-attachments/'+f.topic.id+'/messages/attachment-user/'+files[0].id,{headers:{'x-nativesync-source':'sourceC','x-nativesync-device':'deviceC','x-nativesync-space':f.store.sourceCatalog.spaceId,'x-nativesync-capabilities':'shared-space-v1'}});assert.equal(response.status,403);
 assert.equal(f.store.metrics().journalRows,2);assert.equal(a.runtime.adapter.state.outbox.length,0);assert.equal(b.runtime.adapter.state.outbox.length,0);
 const data=Buffer.from('file only'),upload=await phone.call('/conversations/'+f.topic.id+'/attachments/uploads',{requestId:'phone-file-only-upload',name:'only.txt',type:'text/plain',size:data.length},201);await phone.call('/conversations/'+f.topic.id+'/attachments/uploads/'+upload.uploadId+'/chunks',{offset:0,data:data.toString('base64')});await phone.call('/conversations/'+f.topic.id+'/attachments/uploads/'+upload.uploadId+'/finish',{});
 await require(BOX+'/Plugin/NativeSync/mobile/sharedConfiguration').prepareSharedConfiguration(f.portal.engine.configs,f.portal.topics.find(x=>x.key===f.topic.id));
 const pending=await phone.call('/conversations/'+f.topic.id+'/messages',{requestId:'phone-file-only-send',text:'',attachments:[upload.uploadId]},202);await phone.call('/executions/'+pending.id+'/cancel',{},202);assert.equal(f.calls(),1);
});

test('native merge fences both clients, preserves private origin folders and receipts, then converges a prefix topic without model calls',async t=>{
 const f=await fixture(t),a=await f.desktop('A'),b=await f.desktop('B');
 await b.runtime.host.writeOwner('agent','native-right',{name:'Synthetic shared',model:'synthetic',systemPrompt:'OTHER_SHARED_PROMPT',temperature:0.7,streamOutput:false});await b.runtime.host.ensureTopic('agent','native-right',{id:'right-topic',name:'Shared history'});await b.runtime.discover();await b.runtime.tick();await a.runtime.tick();
 const right=b.runtime.nativeObject('agent','native-right'),rightTopic=Object.values(b.runtime.state.objects).find(o=>o.kind==='topic'&&o.parentId===right.id);
 const seed=(topic,id,content,timestamp)=>{const ctx=f.shared.executionConfig(f.actor('A'),{sharedSpaceId:'sharedAB',sharedId:topic.id}),job=f.shared.admit(f.actor('A'),{sharedSpaceId:'sharedAB',sharedId:topic.id,requestId:'seed_'+topic.id+'_'+id,expectedHead:ctx.head,configHash:ctx.hash,message:{id,role:'user',content,timestamp}});f.shared.abandon(f.actor('A'),{sharedSpaceId:'sharedAB',admissionId:job.id,opId:'seed-stop_'+job.id,confirm:true});};
 seed(f.topic,'old-1','same history',1);seed(rightTopic,'old-1','same history',1);seed(rightTopic,'old-2','longer history',2);await a.runtime.tick();await b.runtime.tick();
 const before=f.store.metrics(),preview=await a.runtime.matching.preview({leftId:f.owner.id,rightId:right.id});
 const old=await fetch(f.url+'/api/v1/sync/shared/match-prepare',{method:'POST',headers:{'content-type':'application/json','x-nativesync-source':'sourceA','x-nativesync-device':'deviceA','x-nativesync-space':f.store.sourceCatalog.spaceId,'x-nativesync-capabilities':'shared-space-v1'},body:JSON.stringify({sharedSpaceId:'sharedAB',leftId:f.owner.id,rightId:right.id,planHash:preview.planHash,proof:{pendingOperations:0,pendingCommits:0,activeRequests:0,stateHash:'a'.repeat(64)}})});assert.equal(old.status,409);assert.equal((await old.json()).error.code,'SHARED_MERGE_CLIENT_UPGRADE_REQUIRED');
 const started=await a.runtime.matching.prepare({...preview.plan,planHash:preview.planHash});await b.runtime.tick();
 await assert.rejects(a.runtime.prepareSharedSend({descriptor:a.descriptor,message:msg('must-not-send','held by merge')}),rejects('SHARED_MATCH_PREPARING'));
 await a.runtime.matching.confirm({preparationId:started.preparationId,keepId:f.owner.id,configChoice:'left'});await a.runtime.tick();await b.runtime.tick();await a.runtime.tick();await b.runtime.tick();
 assert.deepEqual(f.store.metrics(),before);assert.equal(b.runtime.localFor(f.owner.id).localId,'native-right');assert.equal(f.calls(),0);
 const topicPreview=await a.runtime.matching.preview({leftId:f.topic.id,rightId:rightTopic.id});assert.equal(topicPreview.plan.history.relation,'prefix');
 const second=await a.runtime.matching.prepare({...topicPreview.plan,planHash:topicPreview.planHash});await b.runtime.tick();await a.runtime.matching.confirm({preparationId:second.preparationId,keepId:rightTopic.id});await a.runtime.tick();await b.runtime.tick();await a.runtime.tick();await b.runtime.tick();
 assert.deepEqual(f.store.metrics(),before);assert.equal(f.calls(),0);assert.equal(a.runtime.localFor(f.topic.id).aliasOf,rightTopic.id);assert.throws(()=>f.shared.history(f.actor('A'),{sharedSpaceId:'sharedAB',sharedId:f.topic.id,after:1}),rejects('SHARED_TOPIC_MERGED'));
 const mapping=a.runtime.mappings().find(m=>m.sharedId===rightTopic.id);assert.deepEqual((await a.queue.read(mapping.local)).map(m=>m.id),['old-1','old-2']);
 await a.close();const reopened=await f.desktop('A');await reopened.runtime.tick();assert.equal(f.calls(),0);assert.equal(reopened.runtime.localFor(f.topic.id).aliasOf,rightTopic.id);
 const current=reopened.runtime.mappings().find(m=>m.sharedId===rightTopic.id),next=await reopened.runtime.prepareSharedSend({descriptor:current.local,message:msg('after-merge','shared visibility remains active')});await reopened.runtime.abandonSharedSend({descriptor:current.local,requestId:'after-merge',confirmed:true});await b.runtime.tick();assert.ok((await b.queue.read(b.runtime.mappings().find(m=>m.sharedId===rightTopic.id).local)).some(m=>m.id==='after-merge'));assert.equal(f.calls(),0);
});

test('shared context regex follows native depth, role and parser semantics without mutating history',async t=>{
 const f=await fixture(t),vm=require('node:vm'),fs=require('node:fs/promises');
 const source=await fs.readFile(CHAT+'/modules/chatManager.js','utf8').then(s=>s.replaceAll('\r\n','\n')),start=source.indexOf('    function buildTurnDepthMap('),end=source.indexOf('    /**\n     * Initializes',start);
 assert.ok(start>0&&end>start);const scope={window:{uiHelperFunctions:{getCompiledRegex:input=>{const n=input.lastIndexOf('/');if(!input.startsWith('/')||n<=0)return null;try{return {regex:new RegExp(input.slice(1,n),input.slice(n+1))};}catch{return {regex:null};}}}},console:{error(){}}};
 vm.createContext(scope);vm.runInContext(source.slice(start,end)+';globalThis.native={buildTurnDepthMap,applyRegexRules}',scope);
 const rules=[{findPattern:'/secret/gi',replaceWith:'MASK',enabled:true,applyToContext:true,applyToRoles:['user','assistant'],minDepth:1,maxDepth:2},{findPattern:'MASK',replaceWith:'wrong',enabled:true,applyToContext:true,applyToRoles:['assistant']},{findPattern:'/[/g',replaceWith:'wrong',enabled:true,applyToContext:true,applyToRoles:['assistant']},{findPattern:'/MASK/g',replaceWith:'ROLE',enabled:true,applyToContext:true,applyToRoles:['assistant'],minDepth:1,maxDepth:1}];
 const history=[{id:'u1',role:'user',content:'secret'},{id:'a1',role:'assistant',content:'SECRET secret'},{id:'u2',role:'user',content:'secret'},{id:'a2',role:'assistant',content:'secret'},{id:'u3',role:'user',content:'secret'}],before=structuredClone(history);
 const {sharedContextTransform}=require(BOX+'/Plugin/NativeSync/sync/contracts.generated.cjs'),transform=sharedContextTransform(history,rules,'u3'),depths=scope.native.buildTurnDepthMap(history);
 for(const m of history)assert.equal(transform(m.content,m),m.id==='u3'?m.content:scope.native.applyRegexRules(m.content,rules,'context',m.role,depths.get(m.id)));
 const config={systemPrompt:'SYSTEM secret',authority:{sharedSpaceId:'sharedAB'},stripRegexes:rules,tavernRules:[{id:'suffix',type:'user_suffix',scope:'agent',enabled:true,content:'secret SUFFIX'}]};
 const parts=await require(BOX+'/Plugin/NativeSync/mobile/effectiveContext').effectiveRequest(history,config,'u3',async m=>[{type:'text',text:m.content+' attachment secret'},{type:'image_url',image_url:{url:'data:image/png;base64,unchanged'}}]);
 assert.equal(parts[1].content[0].text,'MASK attachment MASK');assert.equal(parts[2].content[0].text,'MASK MASK attachment MASK');assert.match(parts.at(-1).content[0].text,/secret attachment secret/);assert.match(parts.at(-1).content[0].text,/secret SUFFIX/);assert.equal(parts[0].content,'SYSTEM secret');assert.deepEqual(history,before);const checkpoint={id:'checkpoint',role:'user',content:'secret',contextCompaction:{kind:'vchat-context-checkpoint',version:1,checkpoint:'secret'}};assert.equal(sharedContextTransform([checkpoint],rules)(checkpoint.content,checkpoint),'secret');
 const group={group:{name:'Shared group',mode:'sequential',members:['m']},agents:[{id:'m',name:'Member'}],authority:{sharedSpaceId:'sharedAB'},tavernRules:[],executionPolicy:{enableThoughtChainInjection:true}};
 const prepared=await require(BOX+'/Plugin/NativeSync/mobile/groupRequest').groupRequest({topic:{key:'unused',topicId:'t'},config:group,member:{id:'m',name:'Member',systemPrompt:'GROUP SYSTEM',model:'synthetic',stripRegexes:rules},history,currentUserId:'u3',requestId:'group-regex-probe'});
 assert.match(prepared.body.messages[1].content[0].text,/MASK/);assert.match(prepared.body.messages.at(-2).content[0].text,/secret/);assert.equal(f.calls(),0);
});

test('shared native reference uses only server origin alias and freezes before desktop or mobile dispatch',async t=>{
 const f=await fixture(t),prepare=require(BOX+'/Plugin/NativeSync/mobile/sharedConfiguration').prepareSharedConfiguration;
 let nativePrompt='NATIVE_FROZEN $&',reads=0;const manager=f.portal.engine.agentManager;manager.isAgent=alias=>alias==='NativeAllowed'||alias==='Foreign';manager.getAgentPrompt=async alias=>{reads++;assert.equal(alias,'NativeAllowed');return nativePrompt;};
 const topic=f.portal.topics.find(t=>t.key===f.topic.id),edit=(patch,op)=>{const old=f.shared.get(f.actor('A'),'sharedAB',f.owner.id);f.shared.saveConfig(f.actor('A'),{sharedSpaceId:'sharedAB',sharedId:f.owner.id,opId:op,expectedVersion:old.version,config:{...old.config,...patch}});};
 edit({systemPrompt:'PREFIX {{agent:NativeAllowed}} SUFFIX',stripRegexes:[{id:'rule',findPattern:'/secret/g',replaceWith:'MASK',enabled:true,applyToContext:true,applyToRoles:['assistant']}]},'native-reference-template');
 await assert.rejects(prepare(f.portal.engine.configs,topic),rejects('CONFIG_PROMPT_SNAPSHOT_UNAVAILABLE'));assert.equal(reads,0);
 f.store.sourceCatalog.staticTopics=[{sourceId:'sourceB',ownerType:'agent',ownerId:'origin',agentAlias:'NativeAllowed'}];await assert.rejects(prepare(f.portal.engine.configs,topic),rejects('CONFIG_PROMPT_SNAPSHOT_UNAVAILABLE'));assert.equal(reads,0);
 f.store.sourceCatalog.staticTopics=[{sourceId:'sourceA',ownerType:'agent',ownerId:'origin',agentAlias:'NativeAllowed'}];
 const oldClient=await fetch(f.url+'/api/v1/sync/shared/context?'+new URLSearchParams({sharedSpaceId:'sharedAB',sharedId:f.topic.id}),{headers:{'x-nativesync-source':'sourceA','x-nativesync-device':'deviceA','x-nativesync-space':f.store.sourceCatalog.spaceId,'x-nativesync-capabilities':'shared-space-v1'}});assert.equal(oldClient.status,409);assert.equal((await oldClient.json()).error.code,'SHARED_CONTEXT_CLIENT_UPGRADE_REQUIRED');assert.equal(reads,0);
 const snapshot=await prepare(f.portal.engine.configs,topic);assert.equal(snapshot.promptPolicy,'native-alias-snapshot');assert.equal(snapshot.stripRegexes[0].replaceWith,'MASK');
 const a=await f.desktop('A'),accepted=await a.runtime.prepareSharedSend({descriptor:a.descriptor,message:msg('native-frozen-desktop','secret current input')});assert.equal(accepted.config.systemPrompt,'PREFIX NATIVE_FROZEN $& SUFFIX');
 nativePrompt='LATER_NATIVE';await prepare(f.portal.engine.configs,topic);
 const frozen=await a.runtime.send('/api/v1/sync/shared/request-config?'+new URLSearchParams({sharedSpaceId:'sharedAB',admissionId:accepted.admissionId}));assert.equal(frozen.config.execution.systemPrompt,'NATIVE_FROZEN $&');
 const result=await f.dispatch(a,accepted);await f.reply(a,accepted,result);assert.equal(f.calls(),1);
 const phone=await f.phone(),job=await phone.call('/conversations/'+f.topic.id+'/messages',{requestId:'frozen-phone-reference',text:'phone with native prompt'},202);
 assert.equal(JSON.parse(f.portal.engine.get(job.id).config_snapshot).systemPrompt,'LATER_NATIVE');nativePrompt='{{agent:Foreign}}';const replay=await phone.call('/conversations/'+f.topic.id+'/messages',{requestId:'frozen-phone-reference',text:'phone with native prompt'},202);assert.equal(replay.id,job.id);assert.equal(JSON.parse(f.portal.engine.get(job.id).config_snapshot).systemPrompt,'LATER_NATIVE');await phone.call('/executions/'+job.id+'/cancel',{},202);
 edit({systemPrompt:'{{agent:Foreign}}'},'foreign-alias-template');const n=reads;await assert.rejects(prepare(f.portal.engine.configs,topic),rejects('CONFIG_PROMPT_AUTHORITY_CONFLICT'));assert.equal(reads,n);
 edit({systemPrompt:'{{agent:NativeAllowed}}'},'desktop-dependency-template');nativePrompt='NATIVE {{VCPChatWorkSpace}}';await assert.rejects(prepare(f.portal.engine.configs,topic),rejects('DESKTOP_CONTEXT_REQUIRED'));
 const desktop=await a.runtime.prepareSharedSend({descriptor:a.descriptor,message:msg('native-local-desktop','local environment only')});assert.equal(desktop.config.systemPrompt,nativePrompt);await a.runtime.abandonSharedSend({descriptor:a.descriptor,requestId:'native-local-desktop',confirmed:true});assert.equal(f.calls(),1);
 nativePrompt='GROUP_FROZEN';const group=f.shared.create(f.actor('A'),{sharedSpaceId:'sharedAB',opId:'native-reference-group',kind:'group',localId:'native-group',config:{name:'Native ref group',mode:'sequential',members:[f.owner.id],ruleOverrides:{}}}).object,groupTopic=f.shared.create(f.actor('A'),{sharedSpaceId:'sharedAB',opId:'native-reference-group-topic',kind:'topic',parentId:group.id,localId:'native-group-topic',localParent:'native-group',config:{name:'Native ref turn'}}).object;
 await a.runtime.tick();const gd={itemType:'group',itemId:a.runtime.localFor(group.id).localId,topicId:a.runtime.localFor(groupTopic.id).localId},gp=await a.runtime.prepareSharedSend({descriptor:gd,message:msg('native-reference-group-input','one turn')});assert.equal(gp.members[0].systemPrompt,'GROUP_FROZEN');assert.equal(gp.members[0].stripRegexes[0].replaceWith,'MASK');nativePrompt='LATER_GROUP';await a.runtime.abandonSharedSend({descriptor:gd,requestId:'native-reference-group-input',confirmed:true});
 assert.equal(f.calls(),1);

});

test('accepted reply sync can finish during a live space pull and reopens only completed group metadata',async t=>{
 const f=await fixture(t);let a=await f.desktop('A');const group=f.shared.create(f.actor('A'),{sharedSpaceId:'sharedAB',opId:'queued-sync-group',kind:'group',localId:'queued-group',config:{name:'Queued group',mode:'invite_only',members:[f.owner.id]}}).object,topic=f.shared.create(f.actor('A'),{sharedSpaceId:'sharedAB',opId:'queued-sync-topic',kind:'topic',localId:'queued-topic',localParent:'queued-group',parentId:group.id,config:{name:'Queued pull'}}).object;
 await a.runtime.tick();const d={itemType:'group',itemId:a.runtime.localFor(group.id).localId,topicId:a.runtime.localFor(topic.id).localId},prepared=await a.runtime.prepareSharedSend({descriptor:d,kind:'invite',memberId:f.owner.id,message:msg('queued-invite','')}),record=prepared.record,slot=a.runtime.execution.groupStep(record,f.owner.id),body={model:'synthetic',stream:false,requestId:slot.id,messages:[],vcpchatExtensions:{requestContext:{ownerType:'group',agentId:a.runtime.localFor(f.owner.id).localId,groupId:d.itemId,topicId:d.topicId}}},packet=await a.runtime.execution.prepareGroupNative(record,f.owner.id,body);
 const response=await fetch(f.url+'/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json',...packet.headers},body:JSON.stringify(packet.body)});assert.equal(response.status,200);await response.json();
 let release,entered=false,pulls=0;const gate=new Promise(r=>{release=r;}),adapter=a.runtime.adapter,request=adapter.request;
 adapter.request=async(route,...args)=>{if(route.startsWith('/api/v1/sync/pull?')){pulls++;if(!entered){entered=true;await gate;}}return request.call(adapter,route,...args);};
 const background=a.runtime.replica.sync();await wait(()=>entered,'active pull');const reply=a.runtime.execution.groupReply(record,{id:'reply_'+slot.id,role:'assistant',content:'accepted once',timestamp:2});await wait(()=>record.steps[0].accepted,'reply accepted before local sync');await reply;assert.equal(pulls,1,'accepted reply should use its topic cursor instead of another full pull');release();await background;assert.equal(f.calls(),1);
 await a.close();a=await f.desktop('A');assert.equal(f.shared.active(topic.id),undefined);assert.equal(f.calls(),1);assert.equal(f.store.metrics().journalRows,1);assert.equal(a.runtime.execution.state.requests['queued-invite'].phase,'completed');
});

test('settled shared replicas reopen readonly without join, writes or replay and retain drafts and attachments',async t=>{
 const f=await fixture(t,{attachments:true}),fs=require('node:fs/promises'),path=require('node:path');let a=await f.desktop('A'),b=await f.desktop('B');
 const bytes=Buffer.from('READONLY_SHARED_TEXT'),{sha256}=require(BOX+'/Plugin/NativeSync/sync/protocol'),hash=sha256(bytes),file=path.join(f.root,'desktopA/UserData/attachments',hash,'readonly.txt');await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,bytes);
 const accepted=await a.runtime.prepareSharedSend({descriptor:a.descriptor,message:{...msg('readonly-original','accepted before rollback'),attachments:[{id:'attachment_'+hash,hash,name:'readonly.txt',type:'text/plain',size:bytes.length,src:require('node:url').pathToFileURL(file).href}]}});await f.reply(a,accepted,await f.dispatch(a,accepted));await a.runtime.tick();await b.runtime.tick();
 await a.runtime.configs.edit(f.owner.id,'agent',{...f.owner.config,name:'Unsent local draft'});
 const source=await fs.readFile(path.join(f.root,'desktopA/.native-sync/state.json')),draft=structuredClone(a.runtime.configs.state.drafts),metrics=f.store.metrics(),receipts=f.shared.db.prepare('SELECT count(*) n FROM shared_receipts').get().n;
 await a.close();await b.close();f.shared.readOnly=true;a=await f.desktop('A');b=await f.desktop('B');assert.equal(a.runtime.readOnly,true);assert.equal(a.runtime.adapter.diagnostics().readOnly,true);assert.deepEqual(a.runtime.configs.state.drafts,draft);assert.deepEqual(await fs.readFile(path.join(f.root,'desktopA/.native-sync/state.json')),source);
 const view=await a.runtime.sharedConfigRequest({route:'shared/config?'+new URLSearchParams({sharedSpaceId:'sharedAB',sharedId:f.owner.id})});assert.equal(view.readOnly,true);assert.equal(view.object.id,f.owner.id);
 await assert.rejects(a.runtime.prepareSharedSend({descriptor:a.descriptor,message:msg('readonly-must-not-run')}),rejects('SHARED_READ_ONLY'));await assert.rejects(a.runtime.saveNativeConfig('agent',a.descriptor.itemId,{}),rejects('SHARED_READ_ONLY'));await assert.rejects(a.runtime.send('/api/v1/sync/shared/join',{body:{sharedSpaceId:'sharedAB',opId:'bad-readonly-join'}}),rejects('SHARED_READ_ONLY'));
 const phone=await f.phone(),session=await phone.call('/session');assert.equal(session.topics.find(t=>t.key===f.topic.id).unavailableReason,'SHARED_READ_ONLY');assert.deepEqual(await phone.download('/conversations/'+f.topic.id+'/attachments/messages/readonly-original/attachment_'+hash),bytes);
 assert.equal(f.shared.db.prepare('SELECT count(*) n FROM shared_receipts').get().n,receipts);assert.deepEqual(f.store.metrics(),metrics);assert.equal(f.calls(),1);assert.equal((await b.queue.read(b.descriptor)).length,2);
 await a.close();const registry=path.join(f.root,'desktopA/.native-sync/shared/sharedAB/registry.json'),state=JSON.parse(await fs.readFile(registry));state.pending={action:'bind',body:{opId:'unsettled-readonly-proof'}};await fs.writeFile(registry,JSON.stringify(state));const unchanged=await fs.readFile(registry);await assert.rejects(f.desktop('A'),rejects('SHARED_READ_ONLY_NOT_SETTLED'));assert.deepEqual(await fs.readFile(registry),unchanged);assert.deepEqual(f.store.metrics(),metrics);assert.equal(f.calls(),1);
});

test('new topics select the retained owner and a rejected old-parent intent recovers once after response loss and reopen',async t=>{
 const f=await fixture(t),a=await f.desktop('A');let b=await f.desktop('B');
 await b.runtime.host.writeOwner('agent','native-right',{name:'Other',model:'synthetic',systemPrompt:'OTHER',temperature:0.7,streamOutput:false});await b.runtime.host.ensureTopic('agent','native-right',{id:'right-topic',name:'Right'});await b.runtime.discover();await b.runtime.tick();await a.runtime.tick();
 const other=b.runtime.nativeObject('agent','native-right'),preview=await a.runtime.matching.preview({leftId:f.owner.id,rightId:other.id}),prepared=await a.runtime.matching.prepare({...preview.plan,planHash:preview.planHash});await b.runtime.tick();await a.runtime.matching.confirm({preparationId:prepared.preparationId,keepId:f.owner.id,configChoice:'left'});await a.runtime.tick();await b.runtime.tick();await a.runtime.tick();await b.runtime.tick();
 assert.equal(b.runtime.matching.state.plans[prepared.preparationId].status,'complete');const before=f.store.metrics(),sourceBefore=JSON.parse(await require('node:fs/promises').readFile(f.root+'/desktopB/.native-sync/state.json','utf8'));
 b.runtime.state.locals=Object.fromEntries([[other.id,b.runtime.state.locals[other.id]],...Object.entries(b.runtime.state.locals).filter(([id])=>id!==other.id)]);await b.runtime.save();
 await b.runtime.host.ensureTopic('agent','native-right',{id:'new-topic',name:'After merge'});await b.runtime.discover();const fresh=Object.values(b.runtime.state.objects).find(o=>o.kind==='topic'&&b.runtime.state.locals[o.id]?.localId==='new-topic');assert.equal(fresh.parentId,f.owner.id);
 await b.runtime.host.ensureTopic('agent','native-right',{id:'interrupted-topic',name:'Retained pending intent'});const originalBody={sharedSpaceId:'sharedAB',opId:'old-parent-create',kind:'topic',localId:'interrupted-topic',localParent:'native-right',parentId:other.id,config:{name:'Retained pending intent',archived:false}},send=b.runtime.send;let drop=true;
 b.runtime.send=async(route,options)=>{const result=await send(route,options);if(drop&&route.endsWith('/objects')&&options.body.parentId===f.owner.id&&options.body.localId==='interrupted-topic'){drop=false;throw Object.assign(Error('synthetic response lost'),{code:'NETWORK_UNAVAILABLE'})}return result};
 await assert.rejects(b.runtime.register('objects',originalBody),rejects('NETWORK_UNAVAILABLE'));assert.deepEqual(b.runtime.state.pending.recovery.originalBody,originalBody);assert.equal(b.runtime.state.pending.body.parentId,f.owner.id);const recoveredOp=b.runtime.state.pending.body.opId;assert.notEqual(recoveredOp,originalBody.opId);
 await b.close();b=await f.desktop('B');await b.runtime.tick();assert.equal(b.runtime.state.pending,null);const recovered=Object.values(b.runtime.state.objects).filter(o=>o.kind==='topic'&&b.runtime.state.locals[o.id]?.localId==='interrupted-topic');assert.equal(recovered.length,1);assert.equal(recovered[0].parentId,f.owner.id);assert.equal(f.store.db.prepare('SELECT count(*) n FROM shared_receipts WHERE op_id=?').get(recoveredOp).n,1);assert.deepEqual(f.store.metrics(),before);assert.equal(f.calls(),0);assert.deepEqual(JSON.parse(await require('node:fs/promises').readFile(f.root+'/desktopB/.native-sync/state.json','utf8')),sourceBefore);
});

test('shared text admission skips unrelated history attachment transfer but preserves background and outgoing attachment failures',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()});
 const f=await fixture(t),a=await f.desktop('A');
 let uploads=0;
 const timeout=()=>Object.assign(new Error('synthetic old attachment transfer timed out'),{name:'TimeoutError',code:23});
 a.runtime.attachments={connection:{},work:{shouldRun:()=>true,run:async()=>{uploads++;throw timeout();}},uploadMessage:async()=>{throw Object.assign(Error('synthetic required outgoing attachment failure'),{code:'ATTACHMENT_BLOB_MISSING'});}};
 await assert.rejects(a.runtime.tick(),e=>e.code===23);
 const priorUploads=uploads;
 const accepted=await a.runtime.prepareSharedSend({descriptor:a.descriptor,message:msg('text-with-old-attachment-outage')});
 assert.equal(uploads,priorUploads,'send preparation must not retry the unrelated transfer');
 assert.equal(accepted.userMessage.id,'text-with-old-attachment-outage');assert.equal(f.calls(),0);
 const response=await f.dispatch(a,accepted);await f.reply(a,accepted,response);assert.equal(f.calls(),1);
 await assert.rejects(a.runtime.prepareSharedSend({descriptor:a.descriptor,message:{...msg('required-new-attachment'),attachments:[{id:'attachment_'+'a'.repeat(64),hash:'a'.repeat(64),size:1,type:'text/plain',name:'synthetic.txt'}]}}),rejects('ATTACHMENT_BLOB_MISSING'));
 assert.equal(f.calls(),1,'required outgoing attachment failure must never dispatch a model');
 t.mock.timers.tick(5001);
 await assert.rejects(a.runtime.tick(),e=>e.code===23,'background transfer remains visible and retryable');
});

test('a held historical download cannot delay text admission, and fresh config plus required outgoing attachments remain enforced',async t=>{
 const f=await fixture(t),a=await f.desktop('A'),r=a.runtime;
 let releaseDownload,downloadStarted=false,admitted,prepareError;
 const downloadGate=new Promise(resolve=>{releaseDownload=resolve;});
 r.attachments={connection:{},work:{shouldRun:()=>true,run:async()=>{downloadStarted=true;await downloadGate;}},uploadMessage:async()=>{throw Object.assign(Error('required current attachment unavailable'),{code:'ATTACHMENT_BLOB_MISSING'});}};
 const background=r.tick();r.running=background.catch(()=>{}).finally(()=>{r.running=null;});
 await wait(()=>downloadStarted,'historical download started');
 const old=f.shared.get(f.actor('A'),'sharedAB',f.owner.id);f.shared.saveConfig(f.actor('A'),{sharedSpaceId:'sharedAB',sharedId:f.owner.id,opId:'fresh-config-during-old-download',expectedVersion:old.version,config:{...old.config,maxOutputTokens:77}});
 const preparing=r.prepareSharedSend({descriptor:a.descriptor,message:msg('latency-text-with-stalled-history-download')}).then(v=>{admitted=v;},e=>{prepareError=e;});
 try{
  const limit=Date.now()+500;while(!admitted&&!prepareError&&Date.now()<limit)await new Promise(resolve=>setTimeout(resolve,5));
  if(prepareError)throw prepareError;
  assert.ok(admitted,'text admission still waits for the unrelated historical attachment download');
  assert.equal(admitted.config.maxOutputTokens,77,'latest shared configuration is still required');
  assert.equal(f.calls(),0);
  await f.reply(a,admitted,await f.dispatch(a,admitted));assert.equal(f.calls(),1);
  await assert.rejects(r.prepareSharedSend({descriptor:a.descriptor,message:{...msg('latency-required-new-file'),attachments:[{id:'attachment_'+'a'.repeat(64),hash:'a'.repeat(64),size:1,type:'text/plain',name:'current.txt'}]}}),rejects('ATTACHMENT_BLOB_MISSING'));
  assert.equal(f.calls(),1);
 }finally{releaseDownload();await background;await preparing;}
});

test('an unrelated maintenance scan does not own foreground admission',async t=>{
 const f=await fixture(t),a=await f.desktop('A'),r=a.runtime,readLocal=r.readLocal.bind(r);let first=true,entered=false,release,admitted,error;
 const gate=new Promise(resolve=>{release=resolve;});r.readLocal=async o=>{if(first){first=false;entered=true;await gate;}return readLocal(o);};
 const background=r.tick({forceLocal:true,skipAttachments:true});r.running=background.catch(()=>{}).finally(()=>{r.running=null;});await wait(()=>entered,'core local scan held');
 const preparing=r.prepareSharedSend({descriptor:a.descriptor,message:msg('wait-for-config-owner')}).then(v=>{admitted=v;},e=>{error=e;});
 try{await wait(()=>admitted||error,'foreground current-topic admission');assert.equal(error,undefined);assert.ok(admitted,'a paused maintenance scan must not block an already-ready topic');release();await background;await preparing;if(error)throw error;assert.ok(admitted);assert.equal(f.calls(),0);}finally{release();await background;await preparing;}
});

test('late attachment materialization obeys local visibility, merge fencing and shutdown without changing history',async t=>{
 const f=await fixture(t),a=await f.desktop('A'),r=a.runtime,before=await a.queue.read(a.descriptor),mapping=r.execution.mapping(a.descriptor),topic=r.state.objects[mapping.sharedId];
 const d={...a.descriptor,syncSource:'attachment-materialization'},mutate=()=>r.mutateAttachment(d,rows=>rows,{intent:{source:'native-attachment-materialization',localOnly:true,known:false}});
 r.matching.state.plans['synthetic-active-fence']={status:'prepared',plan:{objects:[{id:topic.id},{id:topic.parentId}]}};
 await assert.rejects(mutate(),rejects('SHARED_MATCH_PREPARING'));delete r.matching.state.plans['synthetic-active-fence'];
 const visible=r.isLocalVisible.bind(r);r.isLocalVisible=id=>id===topic.id?false:visible(id);await assert.rejects(mutate(),rejects('SHARED_LOCAL_REMOVED'));r.isLocalVisible=visible;
 r.closed=true;try{await assert.rejects(mutate(),rejects('APPLICATION_SHUTTING_DOWN'));}finally{r.closed=false;}
 assert.deepEqual(await a.queue.read(a.descriptor),before);assert.equal(f.calls(),0);
});

test('composer model selection uses the real shared native save contract and changes only the requested model across desktops',async t=>{
 const fs=require('node:fs/promises');const f=await fixture(t),a=await f.desktop('A'),b=await f.desktop('B'),{JSDOM}=require('/home/jenn/AGENTS_OS_Workspace/runtime/VCPChat/node_modules/jsdom'),r=a.runtime,id=a.descriptor.itemId;
 const before=f.shared.get(f.actor('A'),'sharedAB',f.owner.id),readConfig=async()=>r.decorateNativeConfig('agent',id,JSON.parse(await fs.readFile(r.root+'/Agents/'+id+'/config.json','utf8')));
 const dom=new JSDOM('<div class="chat-input-actions"><button id="sendMessageBtn"></button></div>',{runScripts:'outside-only',url:'https://synthetic.invalid'}),w=dom.window;w.console={error(){},warn(){}};let choose,current={id,type:'agent',config:await readConfig()};
 w.ModelPickerPopup={createModelPickerPopup:opts=>{choose=opts.onSelect;return{close(){},dispose(){}};}};w.eval(await fs.readFile(CHAT+'/modules/renderer/composerModelSelect.js','utf8'));
 const instance=w.ComposerModelSelect.init({electronAPI:{getAgentConfig:readConfig,saveAgentConfig:(_id,payload)=>r.saveNativeConfig('agent',id,payload)},selectedItemRef:{get:()=>current,set:v=>{current=v;}},sendMessageBtn:w.document.getElementById('sendMessageBtn')});t.after(()=>{instance.dispose();w.close();});
 choose('synthetic-next-model');await wait(()=>current.config.model==='synthetic-next-model','shared composer switch');const after=f.shared.get(f.actor('A'),'sharedAB',f.owner.id);assert.equal(after.version,before.version+1);assert.equal(after.config.model,'synthetic-next-model');for(const key of Object.keys(before.config))if(key!=='model')assert.deepEqual(after.config[key],before.config[key],key+' must remain unchanged');assert.deepEqual(Object.keys(after.config).filter(k=>!Object.hasOwn(before.config,k)).sort(),['avatar','ruleOverrides']);assert.equal(after.config.avatar,null);assert.deepEqual(after.config.ruleOverrides,{});assert.equal(current.config.__nativeSyncSharedBase.version,after.version);
 await b.runtime.tick();assert.equal(b.runtime.configs.state.objects[f.owner.id].config.model,'synthetic-next-model');assert.equal(f.calls(),0);
});

test('unsubmitted current-version title-only topic drafts do not block chat, while real execution conflicts remain fenced',async t=>{
 const fs=require('node:fs/promises'),f=await fixture(t),a=await f.desktop('A'),r=a.runtime,known=r.configs.state.objects[f.topic.id],original=structuredClone(known.config),name='Local pending title';
 const file=r.root+'/Agents/'+a.descriptor.itemId+'/config.json',raw=JSON.parse(await fs.readFile(file,'utf8'));raw.topics.find(x=>x.id===a.descriptor.topicId).name=name;await fs.writeFile(file,JSON.stringify(raw));
 await r.configs.edit(f.topic.id,'topic',{...original,name});const draft=structuredClone(r.configs.state.drafts[f.topic.id]);
 const accepted=await r.prepareSharedSend({descriptor:a.descriptor,message:msg('title-only-chat')});assert.equal(accepted.userMessage.id,'title-only-chat');await f.reply(a,accepted,await f.dispatch(a,accepted));assert.equal(f.calls(),1);assert.deepEqual(r.configs.state.drafts[f.topic.id],draft);assert.equal(f.shared.get(f.actor('A'),'sharedAB',f.topic.id).config.name,original.name);assert.equal(JSON.parse(await fs.readFile(file,'utf8')).topics.find(x=>x.id===a.descriptor.topicId).name,name);
 for(const [label,change]of [['concurrent title conflict',d=>{d.conflict=true;}],['stale base',d=>{d.expectedVersion++;}],['in-flight submission',d=>{d.submitted=true;}],['archive change',d=>{d.config.archived=!Boolean(original.archived);}],[ 'invalid kind',d=>{d.kind='agent';}]]){
  r.configs.state.drafts[f.topic.id]=structuredClone(draft);change(r.configs.state.drafts[f.topic.id]);await assert.rejects(r.prepareSharedSend({descriptor:a.descriptor,message:msg('must-block-'+label)}),rejects('SHARED_CONFIG_CONFLICT'),label);
 }
 r.configs.state.drafts[f.topic.id]=structuredClone(draft);await r.configs.edit(f.owner.id,'agent',{...r.configs.state.objects[f.owner.id].config,model:'pending-model'});await assert.rejects(r.prepareSharedSend({descriptor:a.descriptor,message:msg('must-block-model-draft')}),rejects('SHARED_CONFIG_CONFLICT'));assert.equal(f.calls(),1);
});

test('diagnostics distinguish nonblocking title drafts, real conflicts and pending execution settings',async t=>{
 const f=await fixture(t),a=await f.desktop('A'),r=a.runtime,known=r.configs.state.objects[f.topic.id];
 await r.configs.edit(f.topic.id,'topic',{...known.config,name:'Pending display title'});
 let d=r.adapter.diagnostics();assert.equal(d.configurationError,null);assert.equal(d.shared.configurationDrafts,1);assert.equal(d.shared.configurationConflicts,0);assert.equal(d.shared.executionBlockingDrafts,0);
 r.configs.state.drafts[f.topic.id].conflict=true;d=r.adapter.diagnostics();assert.equal(d.configurationError,'SHARED_CONFIG_CONFLICT');assert.equal(d.shared.configurationConflicts,1);assert.equal(d.shared.executionBlockingDrafts,1);
 r.configs.state.drafts[f.topic.id].conflict=false;await r.configs.edit(f.owner.id,'agent',{...r.configs.state.objects[f.owner.id].config,model:'pending-model'});d=r.adapter.diagnostics();assert.equal(d.configurationError,'SHARED_CONFIG_CONFLICT');assert.equal(d.shared.configurationDrafts,2);assert.equal(d.shared.configurationConflicts,0);assert.equal(d.shared.executionBlockingDrafts,1);assert.equal(f.calls(),0);
});

test('foreground uses only current-topic reads and leaves the global cursor to background maintenance',async t=>{
 const f=await fixture(t),a=await f.desktop('A'),r=a.runtime,before=r.replica.adapter.state.cursor;
 const originalTick=r.tick,originalSync=r.replica.sync;let maintenance=0,spaceSync=0;
 r.tick=async()=>{maintenance++;throw Error('foreground attempted full maintenance');};r.replica.sync=async()=>{spaceSync++;throw Error('foreground attempted space sync');};
 try{
  const accepted=await r.prepareSharedSend({descriptor:a.descriptor,message:msg('target-only-send')});assert.ok(accepted.admissionId);if(accepted.projectionPending)await r.execution.waitProjection(a.descriptor);assert.equal(maintenance,0);assert.equal(spaceSync,0);assert.equal(r.replica.adapter.state.cursor,before);assert.equal((await a.queue.read(a.descriptor)).at(-1).id,'target-only-send');const key=JSON.stringify([f.topic.topic.ownerType,f.topic.topic.ownerId,f.topic.topic.topicId,'target-only-send']);assert.ok((r.replica.adapter.state.topicCursors[f.topic.id]||0)>=1||r.replica.adapter.state.acked[key]?.seq===r.execution.state.requests['target-only-send'].accepted.userSeq);
 }finally{r.tick=originalTick;r.replica.sync=originalSync;}
 await r.replica.sync();assert.ok(r.replica.adapter.state.cursor>before);
});
test('target preflight waits for actual configuration materialization without waiting for full maintenance',async t=>{
 const f=await fixture(t),a=await f.desktop('A'),r=a.runtime;let release,entered=false,accepted;
 const gate=new Promise(resolve=>{release=resolve;});const write=r.configs.serial(async()=>{entered=true;await gate;});await wait(()=>entered,'native configuration write');
 const pending=r.prepareSharedSend({descriptor:a.descriptor,message:msg('after-native-config-write')}).then(v=>{accepted=v;});
 try{await new Promise(resolve=>setTimeout(resolve,30));assert.equal(accepted,undefined);release();await write;await pending;assert.ok(accepted);}finally{release();await write;await pending;}
});

test('topic-only inbox recovery preserves global progress and still receives unrelated history',async t=>{
 const f=await fixture(t),a=await f.desktop('A'),r=a.runtime,metadata=require(BOX+'/Plugin/NativeSync/sync/metadata'),mapping=r.execution.mapping(a.descriptor),globalBefore=r.adapter.state.cursor;
 const foreign=f.shared.create(f.actor('A'),{sharedSpaceId:'sharedAB',opId:'other-topic-cursor',kind:'topic',parentId:f.owner.id,localId:'other-topic-cursor',localParent:'origin',config:{name:'unrelated'}}).object;await r.tick();
 const apply=(topic,message,op)=>f.store.apply({...topic.topic,msgId:message.id,deviceId:'native-test',opId:op,baseHash:null,action:'upsert',message,metadata:metadata.envelopeFor(message,1)},{sharedSpace:'sharedAB',metadataPublisher:true});
 apply(foreign,{id:'other-before-target',role:'user',content:'unrelated retained',timestamp:1},'other-event');
 apply(f.topic,{id:'dependent-reply',role:'assistant',content:'retained fragment',timestamp:2,continuity:{version:1,known:true,requestId:'target-request',executionId:'target-work',dependsOnMessageIds:['later-proof']}},'dependent-reply');
 await assert.rejects(r.syncExecutionTopic(mapping),rejects('SHARED_TOPIC_DEPENDENCY_PENDING'));assert.equal(r.adapter.state.cursor,globalBefore);assert.equal(r.adapter.state.inbox.find(x=>x.event.msgId==='dependent-reply').advanceCursor,false);
 apply(f.topic,{id:'later-proof',role:'user',content:'confirmed dependency',timestamp:3,continuity:{version:1,known:true,requestId:'dependency-request',executionId:'dependency-work',dependsOnMessageIds:[]}},'dependency-proof');
 const events=f.shared.topicHistory(f.actor('A'),{sharedSpaceId:'sharedAB',sharedId:f.topic.id,after:0}).events,dependency=events.find(e=>e.msgId==='later-proof');await r.adapter.applyRemote(dependency,false,false);await r.adapter.drainInbox();assert.equal(r.adapter.state.cursor,globalBefore);assert.equal((await a.queue.read(a.descriptor)).some(m=>m.id==='dependent-reply'),true);
 await r.replica.sync();const local=r.localFor(foreign.id),owner=r.localFor(foreign.parentId);assert.equal((await a.queue.read({itemType:'agent',itemId:owner.localId,topicId:local.localId})).some(m=>m.id==='other-before-target'),true);
});
test('an empty target page cannot claim a later cursor or readiness',async t=>{
 const f=await fixture(t),a=await f.desktop('A'),r=a.runtime,mapping=r.execution.mapping(a.descriptor),before=r.adapter.state.cursor;
 f.store.apply({...f.topic.topic,msgId:'target-event',deviceId:'native-test',opId:'target-event',baseHash:null,action:'upsert',message:{id:'target-event',role:'user',content:'must arrive',timestamp:1}},{sharedSpace:'sharedAB'});
 f.control.topicPage=value=>({...value,events:[],nextSeq:value.headSeq,hasMore:false});await assert.rejects(r.syncExecutionTopic(mapping),rejects('SHARED_TOPIC_HISTORY_INVALID'));assert.equal(r.adapter.state.cursor,before);assert.equal(r.adapter.state.topicCursors?.[mapping.sharedId],undefined);assert.equal((await a.queue.read(a.descriptor)).length,0);
});
test('a newly created local topic registers only itself while an unrelated space pull is stalled',async t=>{
 const f=await fixture(t),a=await f.desktop('A'),r=a.runtime,fs=require('node:fs/promises'),path=require('node:path'),d={...a.descriptor,topicId:'new-local-ready-topic'};
 await r.host.ensureTopic('agent',d.itemId,{id:d.topicId,name:'new local topic',archived:false});const file=a.queue.getHistoryPath(d.itemId,d.topicId);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,'[]');
 let release,entered=false;const gate=new Promise(resolve=>{release=resolve;}),request=r.adapter.request;r.adapter.request=async(route,...args)=>{if(route.startsWith('/api/v1/sync/pull?')&&!entered){entered=true;await gate;}return request.call(r.adapter,route,...args);};const background=r.replica.sync();await wait(()=>entered,'held unrelated pull');let accepted,error;const pending=r.prepareSharedSend({descriptor:d,message:msg('new-topic-current-only')}).then(value=>{accepted=value},cause=>{error=cause});
 try{await wait(()=>accepted||error,'narrow new-topic registration');if(error)throw error;assert.ok(accepted.admissionId);assert.equal(f.calls(),0);if(accepted.projectionPending)await r.execution.waitProjection(d);assert.equal((await a.queue.read(d)).at(-1).id,'new-topic-current-only');assert.equal(r.execution.mapping(d).local.topicId,d.topicId);}finally{release();await background;await pending;}
});

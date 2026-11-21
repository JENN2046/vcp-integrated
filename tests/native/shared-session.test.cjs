'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,wait,BOX,ctx,rejects}=require('./fixtures/sharedSingleHarness.cjs');
const {sha256,stable}=require(BOX+'/Plugin/NativeSync/sync/protocol');
test('JSON requires an explicit terminal for streaming and explicit non-streaming replies',async t=>{
 const http=require('node:http'),{nativeResponse}=require(BOX+'/Plugin/NativeSync/mobile/nativeResponse');
 let reason;const server=http.createServer((req,res)=>{req.resume();res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'synthetic text'},...(reason?{finish_reason:reason}:{})}]}));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const run=stream=>nativeResponse({endpoint:{url:`http://127.0.0.1:${server.address().port}/v1/chat/completions`,key:'synthetic-only'},body:{stream},controller:new AbortController()});
 await assert.rejects(run(true),{code:'STREAM_INCOMPLETE_REVIEW_REQUIRED'});
 reason='stop';assert.equal((await run(true)).content,'synthetic text');reason=undefined;await assert.rejects(run(false),{code:'STREAM_INCOMPLETE_REVIEW_REQUIRED'});
});
function submission(f,id='session-user-request'){
 const context=f.shared.executionConfig(f.actor('A'),{sharedSpaceId:'sharedAB',sharedId:f.topic.id});
 return {sharedSpaceId:'sharedAB',sharedId:f.topic.id,requestId:id,expectedHead:context.head,configHash:context.hash,message:{id:'user_'+id,role:'user',content:'one immutable session input',timestamp:1}};
}
async function start(f){f.portal.engine.db.prepare('UPDATE mobile_executions SET not_before=0').run();f.portal.engine.setEndpoint({url:f.url+'/v1/chat/completions',key:'synthetic-only'});}
async function completed(f,id){await wait(()=>{const row=f.portal.engine.get(id);if(row.state==='review_required')throw Error(row.error_code);return row.state==='completed';},'session completion');}
async function httpSend(f,body,capabilities='shared-space-v1,shared-context-v1,shared-session-v1',route='session-send'){
 const r=await fetch(f.url+'/api/v1/sync/shared/'+route,{method:'POST',headers:{'content-type':'application/json','x-nativesync-source':'sourceA','x-nativesync-device':'deviceA','x-nativesync-space':f.store.sourceCatalog.spaceId,'x-nativesync-capabilities':capabilities},body:JSON.stringify(body)});
 return {status:r.status,value:await r.json()};
}
test('one HTTP session send owns durable execution and completes without a desktop startup or completion command',async t=>{
 const f=await fixture(t),body=submission(f),accepted=await httpSend(f,body);
 assert.equal(accepted.status,200,JSON.stringify(accepted.value));const id=accepted.value.workId;
 const row=f.portal.engine.get(id);assert.equal(row.kind,'shared_session');assert.equal(row.state,'queued');assert.equal(JSON.parse(row.accepted_actor).principal,'desktop:deviceA');
 assert.equal(f.calls(),0);assert.equal(f.store.metrics().journalRows,1);
 assert.equal((await httpSend(f,body)).value.workId,id);
 await start(f);await completed(f,id);assert.equal(f.calls(),1);assert.equal(f.store.metrics().journalRows,2);assert.equal(f.shared.active(f.topic.id),undefined);
 assert.equal(f.shared.workState(f.actor('B'),{sharedSpaceId:'sharedAB',workId:id}).request.state,'completed');
});
test('ordinary session admission rejects controlled mode even for an opted-in executor',async t=>{
 const f=await fixture(t),body=submission(f);
 const capabilities='shared-space-v1,shared-context-v1,shared-session-v1,shared-steering-v1,shared-controlled-tools-v1';
 const actor=f.shared.desktop({sourceId:'sourceA',deviceId:'deviceA',spaceId:f.store.sourceCatalog.spaceId},capabilities);
 f.shared.safeTools.add('Synthetic');
 f.shared.authorize(actor,body.sharedSpaceId,'execute');
 const invalid={...body,controlMode:'safe-tools-v1'};
 assert.throws(()=>f.shared.sessionSend(actor,invalid),{code:'SHARED_SESSION_CONTROL_MODE_UNSUPPORTED'});
 assert.equal((await httpSend(f,invalid,capabilities)).status,400);
 assert.equal(f.shared.active(f.topic.id),undefined);
 assert.equal(f.store.metrics().journalRows,0);
 const ordinary=f.shared.sessionSend(actor,body);
 assert.equal(f.portal.engine.get(ordinary.workId).kind,'shared_session');
 assert.equal(ordinary.turn.steeringCapable,undefined);
 assert.equal(f.store.metrics().journalRows,1);
});
test('shared session context follows checkpoint publication order across device clocks and message edits', async t => {
 const f = await fixture(t);
 const actorA = f.actor('A'), actorB = f.actor('B');
 const scope = { sharedSpaceId:'sharedAB', sharedId:f.topic.id };
 const packets = [];
 f.control.modelResponse = body => {
  packets.push(body);
  return {choices:[{message:{role:'assistant',content:'reply '+body.requestId},finish_reason:'stop'}]};
 };
 async function send(actor, id, timestamp) {
  const context = f.shared.executionConfig(actor, scope);
  const message = { id, role:'user', content:id, timestamp };
  const accepted = f.shared.sessionSend(actor, {
   ...scope, requestId:id, expectedHead:context.head, configHash:context.hash, message,
  });
  await start(f);
  await completed(f, accepted.id);
  return { message, replyId:f.portal.engine.get(accepted.id).reply_message_id, workId:accepted.id };
 }
 function compact(text, timestamp, covered) {
  const context = f.shared.executionConfig(actorA, scope);
  const intent = f.shared.compactPrepare(actorA, { ...scope, opId:'prepare-'+timestamp, expectedHead:context.head });
  const input = f.shared.compactInput(actorA, { ...scope, id:intent.id });
  assert.ok(input.history.some(message => message.id === covered));
  const message = {
   id:intent.messageId, role:'user', content:text, timestamp,
   contextCompaction:{kind:'vchat-context-checkpoint',version:1,checkpoint:text},
  };
  return f.shared.compactCommit(actorA, {
   ...scope, id:intent.id, sourceHash:intent.sourceHash, opId:'commit-'+timestamp, message,
  });
 }
 function assertPacket(ids, contents) {
  const packet = packets.at(-1);
  assert.deepEqual(packet.vcpchatExtensions.messageTimestampBindings.map(binding => binding.messageId), ids);
  assert.deepEqual(packet.messages.slice(1).map(message => message.content.map(part => part.text).join('')), contents);
 }
 const covered = await send(actorA, 'covered-input', 200);
 const first = compact('first checkpoint', 100, covered.message.id);
 const skewed = await send(actorB, 'between-checkpoints', 300);
 assertPacket([first.messageId, skewed.message.id], ['first checkpoint', skewed.message.content]);
 const last = compact('latest checkpoint', 60, skewed.message.id);
 const base = f.store.db.prepare('SELECT hash FROM messages WHERE topic_id=? AND msg_id=?').get(f.topic.id, skewed.message.id);
 const edit = f.shared.editMessage(actorA, {...scope, operation:{
  msgId:skewed.message.id, deviceId:actorA.principal, opId:'edit-covered', baseHash:base.hash, action:'upsert',
  message:{...skewed.message, content:'edited covered text', timestamp:400},
 }});
 assert.ok(edit.seq > last.seq);
 const retained = await send(actorB, 'retained-input', 40);
 assertPacket([last.messageId, retained.message.id], ['latest checkpoint', retained.message.content]);
 const current = await send(actorB, 'current-input', 20);
 assertPacket([last.messageId, retained.message.id, retained.replyId, current.message.id],
  ['latest checkpoint', retained.message.content, 'reply '+retained.workId, current.message.content]);
 assert.equal(f.calls(), 4);
 assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM journal WHERE topic_id=?').get(f.topic.id).n, 11);
});
test('a shared single checks the work fence once at the native provider boundary', async t => {
 for (const hold of [false, true]) {
  await t.test(hold ? 'held before provider dispatch' : 'accepted provider dispatch', async t => {
   const f = await fixture(t);
   const accepted = f.shared.sessionSend(f.actor('A'), submission(f));
   const fence = t.mock.method(f.shared.steering, 'fence');
   let checks, refusal, providerCalls = 0;
   f.control.nativeResponder = (_req, res) => {
    if (hold) require(BOX + '/Plugin/NativeSync/mobile/sharedSingle').hold(f.portal.engine, accepted);
    const before = fence.mock.callCount();
    try {
     ctx.assertDispatch();
    } catch (error) {
     refusal = error.code;
    }
    checks = fence.mock.callCount() - before;
    if (refusal) return res.status(409).json({ error: { code: refusal } });
    providerCalls++;
    res.json({ choices: [{ message: { role: 'assistant', content: 'synthetic answer' }, finish_reason: 'stop' }] });
   };
   await start(f);
   const state = hold ? 'review_required' : 'completed';
   await wait(() => f.portal.engine.get(accepted.id).state === state, state);
   assert.equal(checks, 1);
   assert.equal(refusal, hold ? 'SHARED_REQUEST_FENCED' : undefined);
   assert.equal(providerCalls, hold ? 0 : 1);
   assert.equal(f.store.metrics().journalRows, hold ? 1 : 2);
  });
 }
});
test('a shared Work without its dispatch fence cannot reach the provider', async t => {
 const f = await fixture(t);
 const accepted = f.shared.sessionSend(f.actor('A'), submission(f));
 const native = f.shared.native;
 const enter = native.enter.bind(native);
 t.mock.method(native, 'enter', (...args) => {
  const boundary = enter(...args);
  delete boundary.fence;
  return boundary;
 });
 let refusal;
 f.control.nativeResponder = (_req, res) => {
  try {
   ctx.assertDispatch();
   return res.json({ choices: [{ message: { content: 'unexpected' }, finish_reason: 'stop' }] });
  } catch (error) {
   refusal = error.code;
   return res.status(409).json({ error: { code: refusal } });
  }
 };
 await start(f);
 await wait(() => f.portal.engine.get(accepted.id).state === 'review_required', 'missing fence');
 assert.equal(refusal, 'SHARED_REQUEST_FENCED');
 assert.equal(f.store.metrics().journalRows, 1);
});
test('cross-device retries require explicit accepted identity and the exact immutable submission',async t=>{
 const f=await fixture(t),body=submission(f),a=f.shared.sessionSend(f.actor('A'),body);
 assert.throws(()=>f.shared.sessionSend(f.actor('B'),body),rejects('SHARED_TOPIC_BUSY'));
 const retry=f.shared.sessionSend(f.actor('B'),{...body,admissionId:a.id});assert.equal(retry.id,a.id);assert.equal(retry.replayed,true);
 assert.throws(()=>f.shared.sessionSend(f.actor('B'),{...body,admissionId:a.id,message:{...body.message,content:'changed'}}),rejects('REQUEST_ID_REUSED'));
 const foreign={kind:'mobile',principal:'mobile:foreign',spaceId:'foreign',permissions:['execute']};
 assert.throws(()=>f.shared.sessionSend(foreign,{...body,admissionId:a.id}),rejects('SHARED_PERMISSION_REQUIRED'));
 assert.equal(f.store.metrics().journalRows,1);await start(f);await completed(f,a.id);assert.equal(f.calls(),1);
});
test('admission is transactional, portable, strictly versioned and capability gated',async t=>{
 const f=await fixture(t),body=submission(f);
 assert.equal((await httpSend(f,body,'shared-space-v1')).value.error.code,'SHARED_CLIENT_UPGRADE_REQUIRED');
 assert.equal((await httpSend(f,{...body,executor:'arbitrary'})).value.error.code,'INVALID_SHARED_REQUEST');
 assert.throws(()=>f.shared.sessionSend(f.actor('A'),{...body,expectedHead:42}),rejects('SHARED_CONTEXT_CHANGED'));
 assert.throws(()=>f.shared.sessionSend(f.actor('A'),{...body,message:{...body.message,desktopReferences:[{path:'/synthetic'}]}}),rejects('DESKTOP_CONTEXT_REQUIRED'));
 assert.throws(()=>f.shared.sessionSend(f.actor('A'),{...body,message:{...body.message,content:'{{VCPChatWorkSpace}}'}}),rejects('DESKTOP_CONTEXT_REQUIRED'));
 f.portal.engine.fault=stage=>{if(stage==='session-accepted-intent')throw Object.assign(Error('synthetic rollback'),{code:'SYNTHETIC_FAILURE'});};
 assert.throws(()=>f.shared.sessionSend(f.actor('A'),body),rejects('SYNTHETIC_FAILURE'));
 assert.equal(f.store.metrics().journalRows,0);assert.equal(f.portal.engine.db.prepare('SELECT count(*) n FROM mobile_executions').get().n,0);assert.equal(f.shared.active(f.topic.id),undefined);
});
test('accepted-before-wake restart dispatches original configuration once, while unknown dispatch never replays',async t=>{
 const f=await fixture(t),body=submission(f),accepted=f.shared.sessionSend(f.actor('A'),body);
 const current=f.shared.get(f.actor('A'),'sharedAB',f.owner.id);f.shared.saveConfig(f.actor('A'),{sharedSpaceId:'sharedAB',sharedId:f.owner.id,opId:'later-config',expectedVersion:current.version,config:{...current.config,model:'later'}});
 await f.reopenBackend();assert.equal(f.calls(),0);assert.equal(f.shared.sessionSend(f.actor('B'),{...body,admissionId:accepted.id}).id,accepted.id);
 await start(f);await completed(f,accepted.id);assert.equal(f.calls(),1);assert.equal(JSON.parse(f.portal.engine.get(accepted.id).config_snapshot).model,'synthetic');
 const next=submission(f,'unknown-session-request');await require(BOX+'/Plugin/NativeSync/mobile/sharedConfiguration').prepareSharedConfiguration(f.portal.engine.configs,f.portal.topics.find(x=>x.key===f.topic.id));
 const unknown=f.shared.sessionSend(f.actor('A'),next);f.control.holdHttp=true;await start(f);await wait(()=>f.calls()===2,'unknown entered');f.heldResponse.destroy();await wait(()=>f.portal.engine.get(unknown.id).state==='review_required','unknown held');
 await f.reopenBackend();await start(f);assert.equal(f.calls(),2);assert.equal(f.portal.engine.get(unknown.id).state,'review_required');
});
test('a persisted native-terminal result survives backend reopen and only completes the original result intent',async t=>{
 const f=await fixture(t),body=submission(f),accepted=f.shared.sessionSend(f.actor('A'),body);
 const engine=f.portal.engine,original=engine.completeIntent.bind(engine);engine.completeIntent=row=>{if(row.state==='publishing')return;return original(row);};
 await start(f);await wait(()=>engine.get(accepted.id).state==='publishing','durable result intent');
 const admission=f.shared.db.prepare('SELECT * FROM shared_admissions WHERE id=?').get(accepted.id);assert.equal(admission.native_terminal,1);
 // Reconstruct SharedSpace as a process restart does, before MobilePortal.
 const {SharedSpace}=require(BOX+'/Plugin/NativeSync/sync/sharedSpace');
 const config={NativeSyncSharedSpaces:JSON.stringify([{id:'sharedAB',sources:['sourceA','sourceB']}])};new SharedSpace(f.store,config);
 assert.equal(f.shared.db.prepare('SELECT state FROM shared_admissions WHERE id=?').get(accepted.id).state,'dispatched');
 await f.reopenBackend();assert.equal(f.portal.engine.get(accepted.id).state,'completed');assert.equal(f.calls(),1);assert.equal(f.store.metrics().journalRows,2);
});
for (const projected of [false, true]) test('AA recovery publishes one durable parent reply after losing '+(projected?'the terminal flag':'the child projection'),async t=>{
 const f=await fixture(t),accepted=f.shared.sessionSend(f.actor('A'),submission(f));
 const taskId='aa-delegation-1000-00000001';
 let link,archiveAvailable=false;
 const release=ctx.registerNativeTaskProvider('AgentAssistant',identity=>archiveAvailable?{
  ...identity,schemaVersion:1,state:'completed',nativeStatus:'Succeed',revision:1,controlRevision:0,
  resultRef:'synthetic native archive',resultHash:sha256('original AA result'),summary:'original AA result',endTime:1,
 }:{...identity,state:'running',revision:0});
 t.after(release);
 f.control.nativeResponder=async(_req,res)=>{
  await ctx.runToolInvocation({pluginName:'AgentAssistant'},async()=>{
   link=await ctx.acceptNativeTask({pluginName:'AgentAssistant',nativeTaskId:taskId,agentBaseName:'Synthetic'});
   await link.observe({state:'running',revision:0});
  });
  res.json({choices:[{message:{role:'assistant',content:'original parent response'},finish_reason:'stop'}]});
 };
 await start(f);await wait(()=>f.portal.engine.get(accepted.id).state==='publishing','durable parent reply awaiting AA archive');
 f.shared.native.taskControls.claimFinal(accepted.id,link.identity,0);
 if (projected) {
  // Simulate the process dying after the verified child row committed, before
  // its completion signal reached the parent. No child is left to poll.
  const check=f.shared.native.checkTerminal;
  f.shared.native.checkTerminal=()=>{};
  archiveAvailable=true;
  try { await link.observe(await ctx.queryNativeTask('AgentAssistant',link.identity)); }
  finally { f.shared.native.checkTerminal=check; }
 }
 assert.equal(f.shared.active(f.topic.id).native_terminal,0);
 const {SharedSpace}=require(BOX+'/Plugin/NativeSync/sync/sharedSpace');
 new SharedSpace(f.store,{NativeSyncSharedSpaces:JSON.stringify([{id:'sharedAB',sources:['sourceA','sourceB']}])});
 assert.equal(f.shared.active(f.topic.id).state,'dispatched');
 await f.reopenBackend();
 assert.equal(f.portal.engine.get(accepted.id).state,'publishing');
 archiveAvailable=true;
 await start(f);await completed(f,accepted.id);
 assert.equal(f.calls(),1);assert.equal(f.store.metrics().journalRows,2);
 assert.equal(f.shared.workState(f.actor('A'),{sharedSpaceId:'sharedAB',workId:accepted.id}).request.nativeTasks[0].state,'completed');
});
test('session execution refuses public native dispatch and completion, preserving the server owner',async t=>{
 const f=await fixture(t),body=submission(f),accepted=f.shared.sessionSend(f.actor('A'),body),packet={requestId:accepted.id};
 assert.throws(()=>f.shared.prepareNative(f.actor('A'),{sharedSpaceId:'sharedAB',admissionId:accepted.id,requestId:accepted.id,bodyHash:sha256(stable(packet))}),rejects('SHARED_SESSION_DISPATCH_ONLY'));
 assert.throws(()=>f.shared.complete(f.actor('A'),{sharedSpaceId:'sharedAB',admissionId:accepted.id,opId:'forged-session-result',message:{id:'reply_'+accepted.id,role:'assistant',content:'forged'}}),rejects('SHARED_SESSION_COMPLETION_ONLY'));
 f.shared.catalog.grants.delete('sourceA');await start(f);await wait(()=>f.portal.engine.get(accepted.id).state==='review_required','revoked source held');assert.equal(f.calls(),0);
});
test('actual process exits before wake and after durable native result recover without another provider request',async t=>{
 const {spawnSync}=require('node:child_process'),path=require('node:path'),fs=require('node:fs/promises'),http=require('node:http');
 const express=require(BOX+'/node_modules/express'),ctx=require(BOX+'/modules/requestExecutionContext');
 const {CentralStore}=require(BOX+'/Plugin/NativeSync/sync/centralStore'),{SourceCatalog}=require(BOX+'/Plugin/NativeSync/sync/sourceCatalog'),{SharedSpace}=require(BOX+'/Plugin/NativeSync/sync/sharedSpace'),{SharedNative}=require(BOX+'/Plugin/NativeSync/sync/sharedNative'),{MobilePortal}=require(BOX+'/Plugin/NativeSync/mobile/portal');
 for(const stage of ['session-accepted-committed','reply-intent']){
  const program=`const {fixture}=require(${JSON.stringify(path.resolve(__dirname,'fixtures/sharedSingleHarness.cjs'))});
   (async()=>{const f=await fixture({diagnostic:()=>{},after:()=>{}}),c=f.shared.executionConfig(f.actor('A'),{sharedSpaceId:'sharedAB',sharedId:f.topic.id}),body={sharedSpaceId:'sharedAB',sharedId:f.topic.id,requestId:'actual-crash-request',expectedHead:c.head,configHash:c.hash,message:{id:'actual-crash-user',role:'user',content:'synthetic crash input',timestamp:1}};
   let id;f.portal.engine.fault=point=>{if(point===${JSON.stringify(stage)}){const row=f.portal.engine.db.prepare('SELECT id FROM mobile_executions').get();process.stdout.write('SESSION_CRASH '+JSON.stringify({root:f.root,id:row.id,calls:f.calls()})+'\\n');process.exit(71);}};
   const a=f.shared.sessionSend(f.actor('A'),body);f.portal.engine.db.prepare('UPDATE mobile_executions SET not_before=0').run();f.portal.engine.setEndpoint({url:f.url+'/v1/chat/completions',key:'synthetic-only'});setTimeout(()=>process.exit(72),5000);})().catch(()=>process.exit(73));`;
  const child=spawnSync(process.execPath,['-e',program],{encoding:'utf8',timeout:10000,env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,VCP_TEST_SERVER:process.env.VCP_TEST_SERVER}});
  assert.equal(child.status,71,child.stdout+child.stderr);const info=JSON.parse(child.stdout.split('\n').find(s=>s.startsWith('SESSION_CRASH ')).slice(14));
  const store=new CentralStore(info.root+'/central.sqlite'),config={NativeSyncFullSources:JSON.stringify(['A','B'].map(x=>({sourceId:'source'+x,deviceId:'device'+x,executionMode:'all-supported'}))),NativeSyncSharedSpaces:JSON.stringify([{id:'sharedAB',sources:['sourceA','sourceB']}]),NativeMobileOrigin:'https://synthetic-shared.invalid',NativeMobileConfigSync:true,NativeMobileTopics:'[]',NativeMobileStartDelayMs:10000};
  store.sourceCatalog=new SourceCatalog(store,config);store.shared=new SharedSpace(store,config);const portal=new MobilePortal({store,config,agentManager:{isAgent:()=>false}}),native=new SharedNative(store.shared,portal.engine),release=ctx.setSharedBoundary(native);
  let calls=0;const app=express();app.use(express.json());app.use(ctx.middleware);app.post('/v1/chat/completions',(_req,res)=>{calls++;res.json({choices:[{message:{role:'assistant',content:'one recovered synthetic reply'},finish_reason:'stop'}]});});
  const server=http.createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{
   if(stage==='session-accepted-committed'){assert.equal(info.calls,0);assert.equal(portal.engine.get(info.id).state,'queued');portal.engine.db.prepare('UPDATE mobile_executions SET not_before=0').run();portal.engine.setEndpoint({url:'http://127.0.0.1:'+server.address().port+'/v1/chat/completions',key:'synthetic-only'});await wait(()=>portal.engine.get(info.id).state==='completed','real crash recovery');assert.equal(calls,1);}
   else{assert.equal(info.calls,1);assert.equal(portal.engine.get(info.id).state,'completed');assert.equal(calls,0);}
   assert.equal(store.metrics().journalRows,2);
  }finally{release();native.close();await portal.close();server.closeAllConnections();await new Promise(r=>server.close(r));store.close();await fs.rm(info.root,{recursive:true,force:true});}
 }
});
test('never-dispatched running intent resumes, but persisted dispatch evidence and observer errors cannot cause replay',async t=>{
 const f=await fixture(t),accepted=f.shared.sessionSend(f.actor('A'),submission(f));
 f.portal.engine.db.prepare("UPDATE mobile_executions SET state='running',request_dispatched=0 WHERE id=?").run(accepted.id);
 await f.reopenBackend();assert.equal(f.portal.engine.get(accepted.id).state,'queued');
 f.shared.events={publish(){throw Error('synthetic slow observer');}};
 await start(f);await completed(f,accepted.id);assert.equal(f.calls(),1);
});
test('existing inline receipt and native registration capabilities remain usable and rejected native packets leave no registration',async t=>{
 const f=await fixture(t),capabilities='shared-space-v1,shared-context-v1,shared-inline-receipts-v1,shared-native-inline-v1';
 const response=await fetch(f.url+'/api/v1/sync/shared/info',{headers:{'x-nativesync-source':'sourceA','x-nativesync-device':'deviceA','x-nativesync-space':f.store.sourceCatalog.spaceId}});const info=await response.json();
 for(const cap of ['shared-inline-receipts-v1','shared-native-inline-v1','shared-session-v1','shared-events-v1'])assert.ok(info.features.includes(cap));
 const body=submission(f,'legacy-inline-request'),accepted=await httpSend(f,body,capabilities,'admit');assert.equal(accepted.status,200,JSON.stringify(accepted.value));assert.equal(accepted.value.inline.event.message.id,body.message.id);assert.ok(accepted.value.inline.config.execution);
 const id=accepted.value.id,packet={model:'synthetic',stream:false,requestId:'reply_'+id,messages:[{role:'user',content:body.message.content}],vcpchatExtensions:{requestContext:{ownerType:'agent',agentId:f.topic.topic.ownerId,topicId:f.topic.topic.topicId}}};
 const dispatch=async p=>{const r=await fetch(f.url+'/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json','x-nativesync-source':'sourceA','x-nativesync-device':'deviceA','x-nativesync-space':f.store.sourceCatalog.spaceId,'x-nativesync-capabilities':capabilities,'x-nativesync-admission':id,'x-nativesync-register':'v1','x-nativesync-body-hash':sha256(stable(p))},body:JSON.stringify(p)});return {status:r.status,body:await r.json()};};
 const rejected=await dispatch({...packet,model:'wrong-model'});assert.equal(rejected.body.error.code,'SHARED_NATIVE_CONFIG_CHANGED');assert.equal(f.shared.db.prepare('SELECT count(*) n FROM shared_native_requests').get().n,0);assert.equal(f.calls(),0);
 const native=await dispatch(packet);assert.equal(native.status,200,JSON.stringify(native));assert.equal(f.calls(),1);
 const completed=await httpSend(f,{sharedSpaceId:'sharedAB',admissionId:id,opId:'legacy-inline-complete',message:{id:'reply_'+id,role:'assistant',content:native.body.choices[0].message.content,timestamp:2}},capabilities,'complete');
 assert.equal(completed.status,200,JSON.stringify(completed.value));assert.equal(completed.value.inline.event.message.id,'reply_'+id);assert.equal(completed.value.request.state,'completed');
});
test('an accepted mobile session retains its actual principal and completes after its observing Cookie expires',async t=>{
 const f=await fixture(t);await f.phone();const session=f.shared.db.prepare('SELECT id,scopes FROM mobile_sessions').get();
 const actor=f.shared.mobile({id:session.id,scopes:JSON.parse(session.scopes)},'sharedAB','execute'),accepted=f.shared.sessionSend(actor,submission(f,'mobile-session-request'));
 const saved=JSON.parse(f.portal.engine.get(accepted.id).accepted_actor);assert.equal(saved.kind,'mobile');assert.equal(saved.principal,'mobile:'+session.id);assert.deepEqual(saved.permissions,['execute']);
 f.shared.db.prepare('UPDATE mobile_sessions SET expires=0 WHERE id=?').run(session.id);await start(f);await completed(f,accepted.id);assert.equal(f.calls(),1);
});
test('an interrupted durable partial result becomes reviewable while preserving its original pending operation',async t=>{
 const f=await fixture(t),accepted=f.shared.sessionSend(f.actor('A'),submission(f)),operation={msgId:'reply_'+accepted.id,message:{id:'reply_'+accepted.id,role:'assistant',content:'synthetic retained partial',timestamp:2}};
 f.shared.db.prepare("UPDATE shared_admissions SET state='review_required' WHERE id=?").run(accepted.id);
 f.portal.engine.db.prepare("UPDATE mobile_executions SET state='publishing',terminal_state='review_required',pending_operation=? WHERE id=?").run(JSON.stringify(operation),accepted.id);
 f.portal.engine.completeIntent(f.portal.engine.get(accepted.id));const row=f.portal.engine.get(accepted.id);
 assert.equal(row.state,'review_required');assert.deepEqual(JSON.parse(row.pending_operation),operation);assert.equal(f.store.metrics().journalRows,1);assert.equal(f.calls(),0);
});
test('HTTP owner review abandonment settles the original session atomically without erasing unknown effects or replaying it',async t=>{
 const f=await fixture(t),body=submission(f,'review-original-request'),accepted=await httpSend(f,body),id=accepted.value.id;
 assert.equal(accepted.status,200,JSON.stringify(accepted.value));f.control.holdHttp=true;await start(f);await wait(()=>f.calls()===1,'original dispatched');
 const abandon={sharedSpaceId:'sharedAB',admissionId:id,opId:'owner-review-decision',confirm:true};
 const running=await httpSend(f,{...abandon,opId:'cannot-abandon-running'},undefined,'abandon');assert.equal(running.value.error.code,'SHARED_REVIEW_CONFIRMATION_REQUIRED');
 // Existing native observation hooks record a synthetic unknown tool/AA fact.
 // The test never invokes an external tool or starts an AgentAssistant task.
 const hooks=f.portal.engine.nativeTasks.hooks(id,id),event={nativeRequestId:id,requestId:id,invocationId:'synthetic-review-invocation',pluginName:'AgentAssistant',nativeTaskId:'synthetic-review-task',agentBaseName:'SyntheticReview'};
 hooks.onToolDispatch(event);hooks.onTaskAccepted(event);f.portal.engine.nativeTasks.markUnknown(f.portal.engine.nativeTasks.get('AgentAssistant',event.nativeTaskId),'NATIVE_TASK_RECONCILIATION_REQUIRED');
 f.heldResponse.destroy();await wait(()=>f.portal.engine.get(id).state==='review_required','original unknown');
 assert.throws(()=>f.shared.abandon(f.actor('B'),abandon),rejects('SHARED_REQUEST_OWNER_REQUIRED'));
 const unconfirmed=await httpSend(f,{...abandon,confirm:false},undefined,'abandon');assert.equal(unconfirmed.value.error.code,'SHARED_REVIEW_CONFIRMATION_REQUIRED');
 const invocationBefore=f.portal.engine.nativeTasks.invocations(id),taskBefore=f.portal.engine.nativeTasks.get('AgentAssistant',event.nativeTaskId);
 const acknowledge=f.portal.engine.nativeTasks.acknowledge.bind(f.portal.engine.nativeTasks);
 f.portal.engine.nativeTasks.acknowledge=workId=>{acknowledge(workId);throw Object.assign(Error('synthetic settlement write failure'),{code:'SYNTHETIC_SETTLEMENT_WRITE_FAILURE'});};
 const rolledBack=await httpSend(f,abandon,undefined,'abandon');assert.equal(rolledBack.status,500);assert.equal(rolledBack.value.error.code,'SYNC_INTERNAL_ERROR');
 assert.equal(f.shared.db.prepare('SELECT state FROM shared_admissions WHERE id=?').get(id).state,'review_required');assert.equal(f.portal.engine.get(id).state,'review_required');assert.equal(f.portal.engine.get(id).review_resolved,0);assert.equal(f.portal.engine.nativeTasks.get('AgentAssistant',event.nativeTaskId).review_resolved,0);
 f.portal.engine.nativeTasks.acknowledge=acknowledge;
 const result=await httpSend(f,abandon,undefined,'abandon');assert.equal(result.status,200,JSON.stringify(result.value));assert.equal(result.value.request.state,'abandoned');
 const row=f.portal.engine.get(id);assert.equal(row.state,'cancelled');assert.equal(row.review_resolved,1);assert.match(row.error_code,/REVIEW_REQUIRED$/);
 assert.deepEqual(f.portal.engine.nativeTasks.invocations(id),invocationBefore);
 const task=f.portal.engine.nativeTasks.get('AgentAssistant',event.nativeTaskId);assert.equal(task.state,taskBefore.state);assert.equal(task.error_code,taskBefore.error_code);assert.equal(task.review_resolved,1);
 assert.equal(f.portal.engine.dependencyHeld(f.topic.id),undefined);assert.equal((await httpSend(f,abandon,undefined,'abandon')).value.replayed,true);
 assert.equal((await httpSend(f,{...body,admissionId:id})).value.id,id);assert.equal(f.calls(),1);
 await f.reopenBackend();assert.equal(f.portal.engine.get(id).state,'cancelled');assert.equal(f.portal.engine.get(id).review_resolved,1);assert.equal(f.portal.engine.dependencyHeld(f.topic.id),undefined);
 f.control.holdHttp=false;const next=await httpSend(f,submission(f,'review-next-request'));assert.equal(next.status,200,JSON.stringify(next.value));await start(f);await completed(f,next.value.id);assert.equal(f.calls(),2);
 assert.equal(f.shared.db.prepare('SELECT state FROM shared_admissions WHERE id=?').get(id).state,'abandoned');
});

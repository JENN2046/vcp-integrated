'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {fixture,wait,BOX}=require('./fixtures/sharedSingleHarness.cjs');
const {steps}=require(BOX+'/Plugin/NativeSync/mobile/groupTurn');

async function groupFixture(t){
 const f=await fixture(t),actor=f.actor('A'),sharedSpaceId='sharedAB';
 const second=f.shared.create(actor,{sharedSpaceId,opId:'stop-second',kind:'agent',localId:'stop2',config:{name:'Second',model:'synthetic',systemPrompt:'Second prompt',streamOutput:false}}).object;
 const members=[f.owner.id,second.id];
 const group=f.shared.create(actor,{sharedSpaceId,opId:'stop-group',kind:'group',localId:'stopg',config:{name:'Stop group',mode:'sequential',members,sequentialSpeakerOrder:members}}).object;
 const topic=f.shared.create(actor,{sharedSpaceId,opId:'stop-topic',kind:'topic',localId:'stopt',localParent:'stopg',parentId:group.id,config:{name:'Stop topic'}}).object;
 const phone=await f.phone(),route='/conversations/'+topic.id+'/messages';
 return {f,topic,phone,route};
}

test('cancel before any speaker is claimed releases the shared topic and replays the same accepted turn',async t=>{
 const {f,topic,phone,route}=await groupFixture(t);
 const input={requestId:'group-stop-before-claim',text:'cancel while queued'};
 const accepted=await phone.call(route,input,202),cancel='/executions/'+accepted.id+'/cancel-remaining';
 assert.equal(accepted.canCancelRemaining,true);
 assert.equal((await phone.call(cancel,{},202)).state,'cancelled');
 const duplicate=await phone.call(cancel,{},202);
 assert.equal(duplicate.remainingCancelled,true);
 assert.deepEqual(duplicate.steps.map(s=>[s.state,s.attempts]),[['cancelled',0],['cancelled',0]]);
 assert.equal((await phone.call(route,input,202)).id,accepted.id);
 assert.equal(f.shared.active(topic.id),undefined);
 assert.equal(f.store.metrics().journalRows,1);
 assert.equal(f.calls(),0);
 assert.equal((await phone.call(route,{requestId:'group-stop-next-turn',text:'reuse topic'},202)).state,'queued');
});

test('recover a published current speaker under a cancelled suffix without retrying native work',async t=>{
 const {f,topic,phone,route}=await groupFixture(t);
 f.control.holdHttp=true;
 const job=await phone.call(route,{requestId:'group-stop-recover-prefix',text:'keep the current result'},202);
 const engine=f.portal.engine,cancel='/executions/'+job.id+'/cancel-remaining';
 engine.db.prepare('UPDATE mobile_executions SET not_before=0 WHERE id=?').run(job.id);
 engine.setEndpoint({url:f.url+'/v1/chat/completions',key:'synthetic-only'});
 await wait(()=>f.calls()===1,'current model dispatched');
 assert.equal((await phone.call(cancel,{},202)).state,'running');
 assert.deepEqual(steps(engine,job.id).map(s=>s.state),['running','cancelled']);
 engine.fault=where=>{if(where==='group-step-applied')throw Error('synthetic process loss after shared commit');};
 f.heldResponse.json({choices:[{message:{role:'assistant',content:'CONFIRMED_CURRENT_REPLY'},finish_reason:'stop'}]});
 await wait(()=>engine.get(job.id).state==='recovering'&&!engine.active.has(job.id),'durable unacknowledged publish');
 const [pending]=steps(engine,job.id);
 assert.equal(pending.state,'publishing');
 assert.ok(pending.pending_operation);
 assert.equal(f.store.metrics().journalRows,2);
 await f.reopenBackend();
 const recovered=await phone.call(cancel,{},202);
 assert.equal(recovered.state,'cancelled');
 assert.deepEqual(recovered.steps.map(s=>[s.state,s.attempts]),[['completed',1],['cancelled',0]]);
 assert.equal(recovered.steps[0].replyMessageId,'reply_'+pending.id);
 assert.equal(f.shared.active(topic.id),undefined);
 assert.equal(f.calls(),1);
 assert.equal(f.store.metrics().journalRows,2);
});

test('cutoff wins between preparation and durable speaker claim',async t=>{
 const {f,topic,phone,route}=await groupFixture(t);
 const job=await phone.call(route,{requestId:'group-stop-during-prepare',text:'cancel during preparation'},202);
 const engine=f.portal.engine,row=engine.get(job.id);
 const worker=engine.run(row);
 assert.equal(engine.get(job.id).state,'running');
 assert.equal(steps(engine,job.id)[0].state,'queued');
 const stopped=engine.cancelRemaining(job.id,row.session_id);
 await worker;
 assert.equal(stopped.state,'cancelled');
 assert.deepEqual(stopped.steps.map(s=>[s.state,s.attempts]),[['cancelled',0],['cancelled',0]]);
 assert.equal(f.shared.active(topic.id),undefined);
 assert.equal(f.store.metrics().journalRows,1);
 assert.equal(f.calls(),0);
});

test('no queued speakers is a no-op while the last speaker is still running',async t=>{
 const {f,topic,phone,route}=await groupFixture(t);
 f.control.holdHttp=(_body,n)=>n===2;
 const job=await phone.call(route,{requestId:'group-stop-last-claimed',text:'running last speaker'},202);
 const engine=f.portal.engine,cancel='/executions/'+job.id+'/cancel-remaining';
 engine.db.prepare('UPDATE mobile_executions SET not_before=0 WHERE id=?').run(job.id);
 engine.setEndpoint({url:f.url+'/v1/chat/completions',key:'synthetic-only'});
 await wait(()=>f.calls()===2,'last model dispatched');
 const unchanged=await phone.call(cancel,{},202);
 assert.equal(unchanged.state,'running');
 assert.equal(unchanged.remainingCancelled,false);
 assert.equal(unchanged.canCancelRemaining,false);
 assert.deepEqual(unchanged.steps.map(s=>s.state),['completed','running']);
 f.heldResponse.json({choices:[{message:{role:'assistant',content:'LAST_CONFIRMED_REPLY'},finish_reason:'stop'}]});
 await wait(()=>engine.get(job.id).state==='completed','normal final settlement');
 assert.equal(f.shared.active(topic.id),undefined);
 assert.equal(f.store.metrics().journalRows,3);
});

test('a live delegated native child finishes through the same admission after the suffix is cancelled',async t=>{
 const {f,topic,phone,route}=await groupFixture(t),{ctx}=require('./fixtures/sharedSingleHarness.cjs');
 const hash=require(BOX+'/Plugin/NativeSync/sync/protocol').sha256;
 const childId='group-stop-live-aa-model',taskId='group-stop-live-aa-task';
 let link,parentResponse,childResponse;
 const releaseProvider=ctx.registerNativeTaskProvider('AgentAssistant',identity=>({...identity,state:'running',revision:0}));
 t.after(releaseProvider);
 f.control.nativeResponder=async(req,res)=>{
  if(req.body.requestId===childId){childResponse=res;return;}
  await ctx.runToolInvocation({pluginName:'AgentAssistant'},async()=>{
   link=await ctx.acceptNativeTask({pluginName:'AgentAssistant',nativeTaskId:taskId,agentBaseName:'Synthetic'});
   await link.observe({state:'running',revision:0});
  });
  parentResponse=res;
 };
 const job=await phone.call(route,{requestId:'group-stop-await-native-child',text:'keep native child running'},202);
 const engine=f.portal.engine,cancel='/executions/'+job.id+'/cancel-remaining';
 engine.db.prepare('UPDATE mobile_executions SET not_before=0 WHERE id=?').run(job.id);
 engine.setEndpoint({url:f.url+'/v1/chat/completions',key:'synthetic-only'});
 await wait(()=>parentResponse,'parent delegated the native task');
 const wire={model:'synthetic',stream:false,requestId:childId,messages:[{role:'user',content:'native child'}]};
 const registration=link.requests.register(wire);t.after(registration);
 const response=fetch(f.url+'/v1/chat/completions',{method:'POST',headers:{...registration.headers,'content-type':'application/json'},body:JSON.stringify(wire)});
 response.catch(()=>{});
 await wait(()=>childResponse,'native child model entered');
 assert.equal((await phone.call(cancel,{},202)).state,'running');
 parentResponse.json({choices:[{message:{role:'assistant',content:'CURRENT_REPLY_BEFORE_CHILD'},finish_reason:'stop'}]});
 await wait(()=>engine.get(job.id).state==='recovering','current reply settling with live child');
 const ongoing=f.shared.workState(f.actor('A'),{sharedSpaceId:'sharedAB',workId:job.id}).request;
 assert.equal(ongoing.state,'dispatched');
 assert.equal(ongoing.remainingCancelled,true);
 assert.equal(ongoing.firstSkippedOrdinal,1);
 assert.deepEqual(steps(engine,job.id).map(s=>s.state),['completed','cancelled']);
 childResponse.json({choices:[{message:{role:'assistant',content:'NATIVE_CHILD_RESULT'},finish_reason:'stop'}]});
 const finished=await response;
 assert.equal(finished.status,200);
 await finished.json();
 link.requests.confirmFinal(childId);
 await link.observe({schemaVersion:1,state:'completed',nativeStatus:'Succeed',revision:1,controlRevision:0,resultRef:'synthetic archive',
  resultHash:hash('native child result'),summary:'native child result',endTime:1});
 await wait(()=>engine.get(job.id).state==='cancelled','native proof settled the existing admission');
 assert.equal(f.shared.active(topic.id),undefined);
 assert.equal(f.calls(),2);
 assert.equal(f.store.metrics().journalRows,2);
});

'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {fixture,BOX,rejects}=require('./fixtures/sharedSingleHarness.cjs');
const {SharedSpace}=require(BOX+'/Plugin/NativeSync/sync/sharedSpace');
const {stable,sha256}=require(BOX+'/Plugin/NativeSync/sync/protocol');
const sharedSpaceId='sharedAB';
const mode='group-member-handoff-v2', capabilities='shared-space-v1,'+mode;
async function init(t,count){
 const f=await fixture(t);
 const {shared,store,owner,reopenBackend}=f;
 const actors=['A','B'].map(x=>shared.desktop({sourceId:'source'+x,deviceId:'device'+x,spaceId:store.sourceCatalog.spaceId},capabilities));
 const members=[owner.id];
 for(let i=1;i<count;i++)members.push(shared.create(actors[0],{sharedSpaceId,opId:'member-'+i,kind:'agent',localId:'member'+i,config:{name:'Member '+i,model:'synthetic',systemPrompt:'Portable text'}}).object.id);
 const group=shared.create(actors[0],{sharedSpaceId,opId:'group-config',kind:'group',localId:'group',config:{name:'Group',mode:'sequential',members}}).object;
 const topic=shared.create(actors[0],{sharedSpaceId,opId:'group-topic',kind:'topic',parentId:group.id,localId:'topic',localParent:'group',config:{name:'Topic'}}).object;
 const sharedId=topic.id;
 const configStore=f.portal.engine.configs;
 const descriptor=configStore.topics.find(entry=>entry.key===sharedId);
 const derived=await require(BOX+'/Plugin/NativeSync/mobile/sharedConfiguration').prepareSharedConfiguration(configStore,descriptor);
 assert.deepEqual(derived.agents.map(agent=>agent.id),members);
 if(count>32)assert.equal(store.db.prepare('SELECT max(version) AS v FROM shared_schema').get().v,4);
 const context=shared.executionConfig(actors[0],{sharedSpaceId,sharedId});
 const work=shared.admit(actors[0],{sharedSpaceId,sharedId,requestId:'group-input',expectedHead:context.head,configHash:context.hash,controlMode:mode,message:{id:'test-user',role:'user',content:'Input',timestamp:1}});
 assert.deepEqual(work.turn.plan,members);
 assert.equal(store.db.prepare('SELECT max(version) AS v FROM shared_schema').get().v,4);
 const scope={sharedSpaceId,workId:work.id};
 const state=()=>shared.workState(actors[0],scope).request;
 const id=n=>'group_'+work.id+'_'+n;
 const packet=(ordinal,pred=ordinal-1)=>({
  requestId:id(ordinal),model:'synthetic',messages:[{role:'user',content:'Input'},...(ordinal?[{role:'assistant',content:'Reply '+pred}]:[])],
  vcpchatExtensions:{requestContext:{ownerType:'group',topicId:topic.topic.topicId,agentId:members[ordinal]},
   ...(ordinal?{messageTimestampBindings:[{messageId:'reply_'+id(pred),sentMessageIndex:1,role:'assistant',source:'client_history',timestamp:pred+2,timestampIso:new Date(pred+2).toISOString(),sentMessageHash:'sha256:'+sha256('Reply '+pred)}]}:{})},
 });
 const native=(actor,ordinal,p=packet(ordinal))=>{
  const preparation=shared.prepareNative(actor,{sharedSpaceId,admissionId:work.id,requestId:id(ordinal),memberId:members[ordinal],bodyHash:sha256(stable(p))});
  const enter=()=>shared.native.enter({method:'POST',body:p,headers:{'x-nativesync-admission':work.id,'x-nativesync-source':actor.sourceId,'x-nativesync-device':actor.deviceId,'x-nativesync-space':store.sourceCatalog.spaceId,'x-nativesync-capabilities':capabilities}});
  return {preparation,enter};
 };
 const publish=(actor,n)=>shared.complete(actor,{sharedSpaceId,admissionId:work.id,opId:'reply-at-'+n,nativeRequestId:id(n),message:{id:'reply_'+id(n),role:'assistant',agentId:members[n],content:'Reply '+n,timestamp:n+2}});
 const command=(actor,name,n,overrides={})=>{
  const c=state().groupHandoff;
  return shared[name](actor,{...scope,opId:name+'-'+n,expectedExecutor:c.executor,expectedExecutorVersion:c.executorVersion,expectedNextOrdinal:c.nextOrdinal,expectedPreviousReplySeq:c.previousReplySeq,...overrides});
 };
 return {actors,store,state,native,publish,command,reopenBackend,shared,packet,group,members};
}
test('v2 completes one slot atomically',async t=>{
 const {actors:[a],state,native,publish}=await init(t,1);
 native(a,0).enter().finish(true);
 const result=publish(a,0);
 assert.equal(result.request.state,'completed');
 assert.deepEqual(state().groupHandoff.confirmedReplies,[result.receipt.seq]);
 assert.equal(publish(a,0).replayed,true);
});
for(const count of [4,33])test('frozen sequential plan of '+count+' members settles each slot once',async t=>{
 const {actors,store,state,native,publish,command,reopenBackend}=await init(t,count);
 const seqs=[];
 for(let n=0;n<count;n++){
  const actor=actors[n%2];
  if(n){
   assert.throws(()=>command(actor,'groupHandoff',n,{expectedNextOrdinal:n-1}),rejects('SHARED_GROUP_HANDOFF_STATE_CHANGED'));
   const old={expectedExecutor:state().groupHandoff.executor,expectedExecutorVersion:n-1};
   assert.equal(command(actor,'groupHandoff',n).request.groupHandoff.state,'awaiting_continue');
   assert.equal(command(actor,'groupHandoff',n,old).replayed,true);
   assert.throws(()=>native(actor,n),rejects('SHARED_GROUP_HANDOFF_FENCED'));
   assert.equal(command(actor,'groupContinue',n).request.groupHandoff.state,'continuing');
  }
  native(actor,n).enter().finish(true);
  const result=publish(actor,n);
  seqs.push(result.receipt.seq);
  assert.deepEqual(result.request.groupHandoff.confirmedReplies,seqs);
  assert.equal(result.request.groupHandoff.previousReplySeq,seqs.at(-1));
  assert.equal(publish(actor,n).replayed,true);
  if(n<count-1){
   assert.equal(state().groupHandoff.state,'awaiting_handoff');
   assert.equal(state().groupHandoff.nextOrdinal,n+1);
   if(n===1){new SharedSpace(store);await reopenBackend();}
   assert.equal(state().groupHandoff.state,'awaiting_handoff');
  }
 }
 assert.equal(state().groupHandoff.state,'completed');
 assert.equal(state().groupHandoff.nextOrdinal,null);
 assert.equal(store.metrics().journalRows,count+1);
 assert.deepEqual(state().nativeRequests.map(row=>row.state),Array(count).fill('model_terminal'));
});
test('stale predecessor binding prevents dispatch and cannot replace a prepared request',async t=>{
 const {actors:[a,b],store,state,native,publish,command,reopenBackend,packet}=await init(t,3);
 native(a,0).enter().finish(true);
 publish(a,0);
 command(b,'groupHandoff',1);
 command(b,'groupContinue',1);
 native(b,1).enter().finish(true);
 publish(b,1);
 command(a,'groupHandoff',2);
 command(a,'groupContinue',2);
 assert.throws(()=>native(a,2,packet(2,0)).enter(),rejects('SHARED_GROUP_HANDOFF_CONTEXT_CHANGED'));
 new SharedSpace(store);
 await reopenBackend();
 assert.equal(state().groupHandoff.state,'continuing');
 // The prepared hash remains immutable even after restart.
 assert.throws(()=>native(a,2).enter(),rejects('REQUEST_ID_REUSED'));
});
test('v2 marks in-flight native activity for review at restart',async t=>{
 const {actors:[a,b],store,state,native,publish,command,reopenBackend}=await init(t,2);
 native(a,0).enter().finish(true);
 publish(a,0);
 command(b,'groupHandoff',1);
 command(b,'groupContinue',1);
 native(b,1).enter();
 new SharedSpace(store);
 await reopenBackend();
 assert.equal(state().groupHandoff.state,'review_required');
 assert.equal(state().nativeRequests[1].state,'unknown');
 assert.throws(()=>native(b,1),rejects('SHARED_GROUP_HANDOFF_FENCED'));
});


test('sequential configuration and ordering accept more than a thousand distinct members within the payload budget',()=>{
 const {sharedConfig}=require(BOX+'/Plugin/NativeSync/sync/contracts.generated.cjs');
 const members=Array.from({length:1001},(_,i)=>'member_'+i);
 const group={name:'Group',mode:'sequential',members,sequentialSpeakerOrder:[...members].reverse()};
 assert.deepEqual(sharedConfig('group',group),group);
 assert.throws(()=>sharedConfig('group',{...group,members:[...members,members[0]]}),rejects('INVALID_SHARED_CONFIG'));
 assert.throws(()=>sharedConfig('group',{...group,sequentialSpeakerOrder:['not-a-member']}),rejects('INVALID_SHARED_CONFIG'));
});


test('editing membership after a boundary affects later admissions only',async t=>{
 const {shared,actors:[a,b],group,members,state,native,publish,command}=await init(t,3);
 native(a,0).enter().finish(true);
 publish(a,0);
 const future=[members[1],members[0]];
 shared.saveConfig(a,{sharedSpaceId,sharedId:group.id,opId:'future-members',expectedVersion:group.version,
  config:{...group.config,members:future,sequentialSpeakerOrder:future}});
 assert.deepEqual(shared.get(a,sharedSpaceId,group.id).config.members,future);
 assert.deepEqual(state().turn.plan,members);
 for(const [ordinal,actor] of [[1,b],[2,a]]){
  command(actor,'groupHandoff',ordinal);
  command(actor,'groupContinue',ordinal);
  native(actor,ordinal).enter().finish(true);
  publish(actor,ordinal);
 }
 assert.deepEqual(state().turn.plan,members);
 assert.deepEqual(state().nativeRequests.map(row=>row.memberId),members);
 assert.equal(state().state,'completed');
});

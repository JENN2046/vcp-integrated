'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,wait,BOX,ctx}=require('./fixtures/sharedSingleHarness.cjs');
const ToolExecutor=require(BOX+'/modules/vcpLoop/toolExecutor');
const records=require(BOX+'/modules/toolCallRecordStore');
test.after(()=>records.shutdown());
const {randomUUID,createHash}=require('node:crypto');
const routeHash=nonce=>createHash('sha256').update(nonce).digest('hex');
const capabilities='shared-space-v1,shared-topic-sponsor-v1';
async function post(f,body,device='A'){
 const response=await fetch(f.url+'/api/v1/sync/shared/topic-sponsor',{method:'POST',headers:{
  'content-type':'application/json','x-nativesync-source':'source'+device,'x-nativesync-device':'device'+device,
  'x-nativesync-space':f.store.sourceCatalog.spaceId,'x-nativesync-capabilities':capabilities
 },body:JSON.stringify(body)});
 return {status:response.status,value:await response.json()};
}
function userBody(f,nonce){
 const context=f.shared.executionConfig(f.actor('A'),{sharedSpaceId:'sharedAB',sharedId:f.topic.id});
 return {sharedSpaceId:'sharedAB',sharedId:f.topic.id,requestId:'sponsor-source-request',expectedHead:context.head,configHash:context.hash,...(nonce?{sponsorRouteHash:routeHash(nonce)}:{}),message:{id:'source-message',role:'user',content:'Source user',timestamp:1}};
}
const modelReply=content=>({choices:[{message:{role:'assistant',content},finish_reason:'stop'}]});
const sponsorBridge=require(BOX+'/Plugin/NativeSync/sync/sponsorExecutionBridge');
function dispatch(args,executionOptions,webSocketServer){
 const registry=require(BOX+'/modules/pluginBridgeRegistry').createDefaultExecutionBridgeRegistry();
 sponsorBridge.register(registry);
 return registry.execute({name:'TopicSponsor',isDistributed:true,serverId:'ordinary'},args,
  {toolName:'TopicSponsor',webSocketServer,executionOptions});
}
// Exercise the real preparation/record boundary. The controllable manager only
// supplies a pause between that boundary and bridge execution for reload tests.
function executePrepared(args, webSocketServer, beforeBridge = () => {}) {
 const registry = require(BOX+'/modules/pluginBridgeRegistry').createDefaultExecutionBridgeRegistry();
 sponsorBridge.register(registry);
 const plugin = {name:'TopicSponsor', isDistributed:true, serverId:'ordinary'};
 const manager = {
  executionBridgeRegistry:registry,
  getPlugin:()=>plugin,
  async processToolCall(toolName, input, _ip, _source, executionOptions) {
   beforeBridge();
   const response = await registry.execute(plugin,input,{toolName,webSocketServer,executionOptions});
   return response.result;
  }
 };
 const executor = new ToolExecutor({pluginManager:manager,webSocketServer:{broadcast(){}},vcpToolCode:false});
 return executor.execute({name:plugin.name,args:{...args}},'127.0.0.1',[]);
}
test('real ToolExecutor and distributed bridge issue a durable, device-bound existing-topic receipt',async t=>{
 const f=await fixture(t),actor=f.actor('A');
 const target=f.shared.create(actor,{sharedSpaceId:'sharedAB',opId:'sponsor-target',kind:'topic',parentId:f.owner.id,localId:'target',localParent:'origin',config:{name:'Sponsor target'}}).object;
 f.shared.bind(actor,{sharedSpaceId:'sharedAB',opId:'mirror-owner-binding',sharedId:f.owner.id,localId:'mirror-owner'});
 f.shared.bind(actor,{sharedSpaceId:'sharedAB',opId:'mirror-source-binding',sharedId:f.topic.id,localId:'mirror-source',localParent:'mirror-owner'});
 f.shared.bind(actor,{sharedSpaceId:'sharedAB',opId:'mirror-target-binding',sharedId:target.id,localId:'mirror-target',localParent:'mirror-owner'});
 const manager=require(BOX+'/Plugin'), hub=require(BOX+'/WebSocketServer'), nonce=randomUUID();
 sponsorBridge.register(manager.executionBridgeRegistry);
 const manifest={name:'TopicSponsor',pluginType:'service',entryPoint:{script:'synthetic.js'},communication:{protocol:'direct'}};
 const {distributedServers,pendingToolRequests,rejectPendingToolRequestsForServer}=hub.__testing;
 const recipientA='socket-a',recipientB='socket-b';
 let deliveriesA=0,deliveriesB=0;
 const originalDecision=manager.toolApprovalManager.getApprovalDecision.bind(manager.toolApprovalManager);
 manager.toolApprovalManager.getApprovalDecision=(tool,args)=>{
  if(args.message==='Rejected by fixture operator'){
   assert.equal(args.river_context,undefined);
   assert.equal(args._nativeSyncTopicSponsor,undefined);
   return {requiresApproval:true,notifyAiOnReject:true};
  }
  return originalDecision(tool,args);
 };
 t.after(()=>{manager.plugins.delete(manifest.name);manager.toolApprovalManager.shutdown();distributedServers.clear();});
 let envelope, providerTargetCalls=0, observedResult, sourceDone, transportError;
 const sourceFinished=new Promise(resolve=>{sourceDone=resolve;});
 const distributed=async(_id,name,wireArgs)=>{
  assert.equal(name,'TopicSponsor');
  const {_nativeSyncTopicSponsor:authority,...args}=wireArgs;
  assert.ok(authority);
  assert.notEqual(authority.proof,'model-supplied');
  assert.deepEqual([authority.sourceSharedId,authority.targetSharedId],[f.topic.id,target.id]);
  envelope={operationId:authority.operationId,proof:authority.proof,args};
  assert.deepEqual(args.river_context,[{role:'user',content:'recent user'},{role:'assistant',content:'recent assistant'}]);
  assert.equal((await post(f,envelope,'B')).status,403);
  assert.equal((await post(f,{...envelope,args:{...args,message:'edited'}})).value.error.code,'REQUEST_ID_REUSED');
  observedResult=await post(f,envelope);assert.equal(observedResult.status,200,JSON.stringify(observedResult.value));
  throw Error('synthetic loss after HTTP acceptance');
 };
 hub.setPluginManager(manager);
 const register=async(id,nativeSyncRouteId,send)=>{
  distributedServers.set(id,{ws:{readyState:1,send}});
  await hub.handleDistributedServerMessage(id,{type:'register_tools',data:{nativeSyncRouteId,tools:[structuredClone(manifest)],serverName:id}});
 };
 await register(recipientB,randomUUID(),()=>{deliveriesB++;});
 await register(recipientA,nonce,value=>{
  deliveriesA++;
  const {data}=JSON.parse(value);
  void distributed(recipientA,data.toolName,data.toolArgs).then(
   result=>hub.handleDistributedServerMessage(recipientA,{type:'tool_result',data:{requestId:data.requestId,status:'success',result}}),
   ()=>rejectPendingToolRequestsForServer(recipientA)
  );
 });
 assert.equal(manager.getPlugin(manifest.name).serverId,recipientB);
 manager.setWebSocketServer({...hub,broadcast(event){
  if(event.type==='tool_approval_request')manager.handleApprovalResponse(event.data.requestId,false,'synthetic rejection');
 }});
 const executor=new ToolExecutor({pluginManager:manager,webSocketServer:{broadcast(){}},vcpToolCode:false});
 const fakeCall={name:'TopicSponsor',river:'last:2',args:{command:'ReplyToTopic',topic_id:'target',source_topic_id:'topic',maid:'origin',sender_id:'origin',message:'Authorized peer message  ',_nativeSyncTopicSponsor:{proof:'model-supplied'}}};
 f.control.nativeResponder=async(req,res)=>{
  try{
   if(req.body.vcpchatExtensions.requestContext.topicId===target.topic.topicId){
    providerTargetCalls++;
    assert.ok(req.body.messages.some(m=>JSON.stringify(m.content).includes('Authorized peer message')));
    return res.json(modelReply('Target reply'));
   }
   const rejected=await executor.execute({...fakeCall,river:undefined,args:{...fakeCall.args,river_context:[{role:'user',content:'caller-supplied'}],message:'Rejected by fixture operator'}},'127.0.0.1',[]);
   assert.equal(rejected.success,false);
   assert.equal(f.shared.db.prepare('SELECT count(*) n FROM shared_topic_sponsor_grants').get().n,0);
   const a=distributedServers.get(recipientA);distributedServers.delete(recipientA);
   const denied=await executor.execute({...fakeCall,args:{...fakeCall.args}},'127.0.0.1',[]);
   assert.match(denied.error,/TOPIC_SPONSOR_RECIPIENT_UNAVAILABLE/);
   assert.equal(deliveriesB,0);
   assert.equal(f.shared.db.prepare('SELECT count(*) n FROM shared_topic_sponsor_grants').get().n,0);
   distributedServers.set(recipientA,a);
   const toolResult=await executor.execute(fakeCall,'127.0.0.1',[{role:'user',content:'older excluded'},{role:'user',name:'private-name',activation:'private-metadata',content:[{type:'text',text:'recent user'},{type:'image_url',image_url:{url:'data:image/png;base64,SYNTHETIC'}}]},{role:'assistant',tool_calls:[{id:'private'}],content:'recent assistant'}]);
   assert.equal(toolResult.success,true,JSON.stringify(toolResult));sourceDone();
   res.json(modelReply('Source reply'));
  }catch(error){transportError=error;sourceDone();res.status(500).json({error:{code:'SYNTHETIC_ERROR'}});}
 };
 const body=userBody(f,nonce),source=f.shared.sessionSend(actor,body);
 assert.throws(()=>f.shared.sessionSend(actor,{...body,message:{...body.message,role:'assistant'}}),{code:'INVALID_SHARED_SUBMISSION'});
 assert.equal((await post(f,{operationId:source.workId,proof:'a'.repeat(36),args:fakeCall.args})).status,403);
 f.portal.engine.startDelayMs=0;f.portal.engine.db.prepare('UPDATE mobile_executions SET not_before=0').run();
 f.portal.engine.setEndpoint({url:f.url+'/v1/chat/completions',key:'synthetic-only'});
 await Promise.race([sourceFinished,wait(()=>transportError||observedResult,'sponsor transport')]);if(transportError)throw transportError;
 const receipt=observedResult.value;
 await wait(()=>f.portal.engine.get(receipt.workId).state==='completed','target reply');
 const messages=f.shared.topicHistory(actor,{sharedSpaceId:'sharedAB',sharedId:target.id}).events;
 const sponsored=messages.find(row=>(row.message||row).id===receipt.message_id);
 assert.ok(sponsored,JSON.stringify(messages));
 const message=sponsored.message||sponsored;
 assert.equal(message.role,'assistant');
 assert.equal(message.name,'Synthetic shared');
 assert.equal(message.agentId,f.owner.id);
 assert.match(message.content,/Authorized peer message\n\n\[VCP_TOPIC_RIVER_V1\]/);
 assert.match(message.content,/\[\/VCP_TOPIC_RIVER_V1\]\n\n\[该发言发送自topic话题\]/);
 assert.doesNotMatch(message.content,/older excluded/);
 assert.equal(providerTargetCalls,1);
 assert.equal(deliveriesA,1);
 assert.equal(deliveriesB,0);
 assert.equal(pendingToolRequests.size,0);
 assert.equal(f.portal.engine.nativeTasks.invocations(source.workId).at(0).state,'returned');
 await f.reopenBackend();
 const replay=await post(f,envelope);assert.equal(replay.status,200,JSON.stringify(replay.value));
 assert.deepEqual(replay.value,{...receipt,replayed:true});
 assert.equal((await post(f,{...envelope,args:{...envelope.args,source_topic_id:'another'}})).value.error.code,'REQUEST_ID_REUSED');
});

test('missing or forged authority never becomes a distributed grant',async t=>{
 const f=await fixture(t),actor=f.actor('A');
 await dispatch({command:'ReplyToTopic',_nativeSyncTopicSponsor:{proof:'fake'}},{},{executeDistributedTool:(_id,_name,clean)=>assert.equal(clean._nativeSyncTopicSponsor,undefined)});
 const source=f.shared.sessionSend(actor,userBody(f));
 let finished=false;
 f.control.nativeResponder=async(_req,res)=>{
  const args={command:'ReplyToTopic',topic_id:'does-not-exist',message:'Synthetic',_nativeSyncTopicSponsor:{proof:'fake'}};
  let sends=0;const transport={executeDistributedTool(){sends++;}};
  await assert.rejects(dispatch(args,{},transport),{code:'TOPIC_SPONSOR_AUTHORITY_REQUIRED'});
  assert.equal(sends,0);
  const missing = await executePrepared(args,transport);
  assert.equal(missing.success,false);assert.match(missing.error,/TOPIC_SPONSOR_TARGET_NOT_BOUND/);
  const oldOwner=f.shared.native;let releaseOther;
  try {
   const stale = await executePrepared(args,transport,()=>{
    ctx.setSharedBoundary(null);
    releaseOther=ctx.setSharedBoundary({shared:f.shared});
   });
   assert.equal(stale.success,false);assert.match(stale.error,/TOPIC_SPONSOR_AUTHORITY_REQUIRED/);
  } finally { if(releaseOther){releaseOther();ctx.setSharedBoundary(oldOwner);} }
  assert.equal(sends,0);finished=true;res.json(modelReply('Source reply'));
 };
 f.portal.engine.db.prepare('UPDATE mobile_executions SET not_before=0').run();
 f.portal.engine.setEndpoint({url:f.url+'/v1/chat/completions',key:'synthetic-only'});
 await wait(()=>finished&&f.portal.engine.get(source.workId).state==='completed','source reply');
 assert.equal(f.shared.db.prepare('SELECT COUNT(*) count FROM shared_topic_sponsor_grants').get().count,0);
});

test('an unconfirmed distributed delivery stays in review until the original operation can be redeemed',async t=>{
 const f=await fixture(t),actor=f.actor('A');
 const target=f.shared.create(actor,{sharedSpaceId:'sharedAB',opId:'uncertain-target',kind:'topic',parentId:f.owner.id,localId:'target',localParent:'origin',config:{name:'Sponsor target'}}).object;
 const nonce=randomUUID(),source=f.shared.sessionSend(actor,userBody(f,nonce));
 let pending,transportError;
 f.control.nativeResponder=async(req,res)=>{
  try{
   if(req.body.vcpchatExtensions.requestContext.topicId===target.topic.topicId)return res.json(modelReply('Target reply'));
   const args={command:'ReplyToTopic',topic_id:target.id,message:'Original uncertain operation'};
   const toolHost={
    bindDistributedTool(name,hash){
     assert.equal(name,'TopicSponsor');assert.equal(hash,routeHash(nonce));
     return wireArgs=>{
      const {_nativeSyncTopicSponsor:envelope,...original}=wireArgs;
      pending={operationId:envelope.operationId,proof:envelope.proof,args:original};
      throw Error('synthetic transport interruption before acceptance');
     };
    }
   };
   const failed = await executePrepared(args,toolHost);
   assert.equal(failed.success,false);assert.match(failed.error,/TOPIC_SPONSOR_DELIVERY_UNCONFIRMED/);
   res.json(modelReply('Cannot confirm the original tool'));
  }catch(error){transportError=error;res.status(500).json({error:{code:'SYNTHETIC_ERROR'}});}
 };
 f.portal.engine.startDelayMs=0;f.portal.engine.db.prepare('UPDATE mobile_executions SET not_before=0').run();
 f.portal.engine.setEndpoint({url:f.url+'/v1/chat/completions',key:'synthetic-only'});
 await wait(()=>transportError||f.portal.engine.get(source.workId).state==='review_required','source review');
 if(transportError)throw transportError;
 assert.equal(f.portal.engine.nativeTasks.invocations(source.workId).at(0).state,'started');
 assert.equal(f.shared.active(target.id),undefined);
 const recovered=await post(f,pending);assert.equal(recovered.status,200,JSON.stringify(recovered.value));
 assert.equal(recovered.value.topic_id,'target');
 assert.equal((await post(f,pending)).value.workId,recovered.value.workId);
 await wait(()=>f.portal.engine.get(recovered.value.workId).state==='completed','target reply');
 assert.equal(f.portal.engine.get(source.workId).state,'review_required');
 assert.equal(f.portal.engine.nativeTasks.invocations(source.workId).at(0).state,'started');
});

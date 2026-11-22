'use strict';
const {stable,sha256,fail,messageKey,messageHash}=require('./protocol');
const endpoint='/api/v1/sync/shared/';
const finalHistoryCapability='shared-controlled-tools-history-v1';
const terminal=new Set(['completed','abandoned']);
class SharedSteeringClient{
 constructor(owner){this.owner=owner;this.runtime=owner.runtime;this.sessions=new Set();this.notified=new Map();}
 enabled(){return this.runtime.capabilities.features?.some(value=>['shared-steering-v1','shared-controlled-text-v1','shared-controlled-tools-v1','shared-controlled-aa-v1'].includes(value))===true;}
 steps(record){if(!record.generations)record.generations=[{generation:0,requestId:'reply_'+record.accepted.id,consumedInputSeq:0,config:record.config,nativeBody:record.nativeBody||null}];return record.generations;}
 find(requestId){for(const record of Object.values(this.owner.state.requests)){if(!record.steeringV1||!record.accepted||record.isSteeringInput)continue;const step=this.steps(record).find(s=>s.requestId===requestId);if(step)return {record,step};}return null;}
 policy(requestId){const found=this.find(requestId);return found?.step.config.rules[0]?.config.executionPolicy||null;}
 usesFinalHistory(record,step){
  return ['safe-tools-v1','agent-assistant-v1'].includes(record.accepted?.turn?.controlMode)&&step.generation===1&&
   (step.finalHistoryReadback===true||(record.accepted.turn.controlMode==='agent-assistant-v1'||this.runtime.capabilities.features?.includes(finalHistoryCapability)));
 }
 pendingFinalHistory(record,step){
  return !step.replyAccepted&&!step.finalHistoryReview&&
   Boolean(step.finalHistoryReadback&&step.nativeBody||step.replyIntent&&this.usesFinalHistory(record,step));
 }
 hasPendingFinalHistory(record){return record.generations?.some(step=>this.pendingFinalHistory(record,step))===true;}
 observeRequest(record,request){
  record.accepted=request;record.observedAt=Date.now();
  if(request.steering)record.control=request.steering;
  if(request.state==='abandoned'||request.state==='review_required'||
   request.state==='completed'&&!this.hasPendingFinalHistory(record)&&!record.generations?.some(step=>step.finalHistoryReview))
   record.phase=request.state;
 }
 async active(d,observedWorkId){
  const mapping=this.owner.mapping(d),value=await this.runtime.send(endpoint+'active?'+new URLSearchParams({sharedSpaceId:this.runtime.connection.sharedSpaceId,sharedId:mapping.sharedId}));
  if(!value.request?.turn?.steeringCapable)return null;
  if(observedWorkId&&observedWorkId!==value.request.id)throw fail('STEERING_TARGET_CHANGED');
  let record=Object.values(this.owner.state.requests).find(v=>!v.isSteeringInput&&v.accepted?.id===value.request.id);
  if(!record){record={steeringV1:Boolean(value.request.turn?.steeringCapable),remote:true,descriptor:{...d},sharedId:mapping.sharedId,phase:value.request.state,accepted:value.request,body:{requestId:value.request.requestId}};this.owner.state.requests['remote:'+value.request.id]=record;}
  this.observeRequest(record,value.request);await this.owner.save();return record;
 }
 async refresh(record){
  const {request}=await this.runtime.send(endpoint+'work?'+new URLSearchParams({sharedSpaceId:this.runtime.connection.sharedSpaceId,workId:record.accepted.id}));
  if(request){this.observeRequest(record,request);await this.owner.save();}
  return request;
 }
 query(record, extra={}){return this.runtime.send(endpoint+'steering?'+new URLSearchParams({...extra,sharedSpaceId:this.runtime.connection.sharedSpaceId,workId:record.accepted.id}));}
 async submit(record,d,message,{deferReady=false,modelSaveRef=null}={}){
  const r=this.runtime,o=this.owner,input=o.state.requests[message.id]||{phase:'local_pending',descriptor:{...d},localMessage:JSON.parse(JSON.stringify(message)),body:{requestId:message.id}};
  if(!input.isSteeringInput){
   const status=await this.query(record),canonical=r.adapter.canonical(message,this.owner.mapping(d).shared.topicId);
   const manifest=(canonical.attachments||[]).map(a=>({name:a.name,type:a.type,size:a.size,hash:a.blobHash||a.hash}));
   input.isSteeringInput=true;input.sharedId=record.sharedId;input.workId=record.accepted.id;input.localMessage=JSON.parse(JSON.stringify(message));input.descriptor={...d};
   input.steeringBody={sharedSpaceId:r.connection.sharedSpaceId,workId:record.accepted.id,opId:'steer_'+sha256(message.id).slice(0,40),inputId:message.id,observedRevision:status?.revision||0,message:{...canonical,attachments:[]},attachmentsReady:false,attachmentManifest:manifest,...(modelSaveRef?{modelSaveRef}:{})};
   o.state.requests[message.id]=input;await o.save();
  }
  try{input.inputReceipt=await r.send(endpoint+'steer',{body:input.steeringBody});}catch(error){if(error.code==='STEERING_TARGET_FINISHED'&&!input.inputReceipt){delete input.isSteeringInput;delete input.steeringBody;input.previousTargetWorkId=input.workId;input.targetFinished=true;delete input.workId;input.phase='local_pending';await o.save();}throw error;}input.phase='steering_received';input.timings||={};input.timings.received=Date.now();await o.save();
  if(!deferReady)void this.finishInput(input).catch(error=>{input.failureCode=error.code||'STEERING_INPUT_PREPARATION_FAILED';void o.save().catch(()=>{});});
  return {handled:true,success:true,inputAccepted:true,workId:input.workId,inputId:message.id,inputSeq:input.inputReceipt.inputSeq,applicationState:input.inputReceipt.applicationState,localState:'saved'};
 }
 finishInput(input){return this.owner.run('steer-input:'+input.localMessage.id,async()=>{
  const r=this.runtime;if(r.closed)throw fail('APPLICATION_SHUTTING_DOWN');
  if(input.readyReceipt)return input.readyReceipt;
  let message=input.localMessage;if(message.attachments?.length){if(!r.attachments)throw fail('ATTACHMENTS_NOT_ENABLED');message=await r.attachments.uploadMessage(input.descriptor,message);}
  const mapping=this.owner.mapping(input.descriptor),canonical=r.adapter.canonical(message,mapping.shared.topicId);
  const readyOp='steer_ready_'+sha256(input.localMessage.id+':'+(input.modelSaveResolutionRef?.opId||'')).slice(0,40);if(!input.readyBody||input.readyBody.opId!==readyOp)input.readyBody={sharedSpaceId:r.connection.sharedSpaceId,workId:input.workId,opId:readyOp,inputId:input.localMessage.id,message:canonical,...(input.steeringBody.modelSaveRef?{modelSaveRef:input.steeringBody.modelSaveRef}:{}),...(input.modelSaveResolutionRef?{modelSaveResolutionRef:input.modelSaveResolutionRef}:{})};await this.owner.save();
  input.readyReceipt=await r.send(endpoint+'steer-ready',{body:input.readyBody});input.phase='steering_ready';delete input.failureCode;await this.owner.save();await r.syncExecutionTopic(mapping);return input.readyReceipt;
 });}
 async promoteQueued(record){
  for(const input of Object.values(this.owner.state.requests).filter(v=>v.parentLocalInputId===record.body.requestId&&!v.isSteeringInput).sort((a,b)=>a.localInputSeq-b.localInputSeq)){
   await this.submit(record,input.descriptor,input.localMessage,{deferReady:Boolean(input.modelSaveRef&&!input.dependencyReady),modelSaveRef:input.modelSaveRef||null});
  }
 }
 async prepareNative(record,body){
  if(this.runtime.closed)throw fail('APPLICATION_SHUTTING_DOWN');
  const step=this.steps(record).find(s=>s.requestId===body.requestId);if(!step)throw fail('SHARED_NATIVE_ADMISSION_REQUIRED');
  const known=await this.refresh(record),prior=known?.nativeRequests?.find(n=>n.id===body.requestId);
  if(!known||terminal.has(known.state)||prior&&prior.state!=='prepared')throw fail('SHARED_RESULT_REQUIRES_REVIEW');
  if(body.model!==step.config.owner.config.model)throw fail('SHARED_NATIVE_CONFIG_CHANGED');
  if(!step.nativeBody){step.nativeBody=JSON.parse(JSON.stringify(body));if(step.generation===0)record.nativeBody=step.nativeBody;await this.owner.save();}
  if(this.usesFinalHistory(record,step)&&!step.finalHistoryReadback){step.finalHistoryReadback=true;await this.owner.save();}
  await this.runtime.send(endpoint+'native-request',{body:{sharedSpaceId:this.runtime.connection.sharedSpaceId,admissionId:record.accepted.id,requestId:step.requestId,bodyHash:sha256(stable(step.nativeBody)),generation:step.generation,consumedInputSeq:step.consumedInputSeq}});
  if(this.runtime.closed)throw fail('APPLICATION_SHUTTING_DOWN');step.phase='dispatching';step.timings||={};step.timings.native_prepared=Date.now();record.phase='dispatching';this.sessions.add(record.accepted.id);await this.owner.save();
  const readPausedMessage = async () => {
   const control=await this.query(record,{pausedRequestId:body.requestId});
   if(record.accepted.turn.controlMode==='agent-assistant-v1'&&control.workId===record.accepted.id&&control.applicationState==='awaiting_native_task'&&
      control.generations?.some(g=>g.generation===0&&g.requestId===body.requestId&&g.state==='awaiting_native_task')){
    return {awaitingNativeTask:true,workId:control.workId,requestId:body.requestId};
   }
   const reply=control.pausedReply,message=reply?.message;
   if(!message||message.id!==body.requestId||message.role!=='assistant'||message.finishReason!=='interrupted'||
      message.continuity?.executionId!==record.accepted.id||!Number.isSafeInteger(reply.seq)||reply.seq<1)return null;
   const mapping=this.owner.mapping(record.descriptor);
   // The Journal already owns this prefix. Let the ordinary projector finish
   // at its watermark without making a slow local projection a transport failure.
   await this.runtime.syncExecutionTopic(mapping,{minSeq:reply.seq}).catch(error=>{
    console.warn('[NativeSync] Paused Work History projection pending',error.code||error.name);
   });
   return message;
  };
  const pause=['safe-tools-v1','agent-assistant-v1'].includes(record.accepted.turn?.controlMode)&&step.generation===0?{readPausedMessage}:{};
  return {...pause,body:step.nativeBody,headers:{...require('./runtime').syncHeaders(this.runtime.connection),'X-NativeSync-Capabilities':'shared-space-v1,shared-context-v1,shared-steering-v1,shared-controlled-aa-v1','X-NativeSync-Admission':record.accepted.id,'X-NativeSync-Generation':String(step.generation),'X-NativeSync-Consumed-Input-Seq':String(step.consumedInputSeq)}};
 }
 async handoff(d,workId){
  const record=await this.active(d,workId);if(!record?.steeringV1)throw fail('SHARED_STEERING_TARGET_UNSUPPORTED');
  const status=await this.query(record),self='desktop:'+this.runtime.connection.deviceId;
  if(status.executor!==self){record.handoffIntent||={sharedSpaceId:this.runtime.connection.sharedSpaceId,workId,opId:'handoff_'+sha256(stable([workId,status.revision,status.generation,status.executor,self])).slice(0,40),expectedRevision:status.revision,expectedGeneration:status.generation,expectedExecutor:status.executor};await this.owner.save();try{record.control=await this.runtime.send(endpoint+'steer-handoff',{body:record.handoffIntent});}catch(error){if(['WORK_HANDOFF_STATE_CHANGED','WORK_SAFE_BOUNDARY_PENDING','CONTROLLED_TEXT_PORTABLE_REQUIRED'].includes(error.code)){delete record.handoffIntent;await this.owner.save();}throw error;}delete record.handoffIntent;}
  else record.control=status;
  this.sessions.add(workId);await this.owner.save();return {success:true,steering:record.control};
 }
 async prepare(d,{workId,expectedRevision}){
  const o=this.owner,r=this.runtime,mapping=o.mapping(d),record=Object.values(o.state.requests).find(v=>v.accepted?.id===workId&&!v.isSteeringInput&&v.sharedId===mapping.sharedId);
  if(!record||!record.steeringV1)throw fail('SHARED_REQUEST_NOT_FOUND');
  return o.run(mapping.sharedId,async()=>{
   const status=await this.query(record);if(status?.revision!==expectedRevision)throw fail('STEERING_REVISION_CHANGED');
   let ids=status.inputs.map(i=>i.inputId);const context=await r.send(endpoint+'context?'+new URLSearchParams({sharedSpaceId:r.connection.sharedSpaceId,sharedId:mapping.sharedId}));
   if(status.executor!=='desktop:'+r.connection.deviceId)throw fail('WORK_EXECUTOR_HANDOFF_REQUIRED');
   record.continuationIntents||={};const current=status.generations?.find(g=>g.generation===status.generation);
   let intent=current?.state==='prepared'&&status.applicationState==='applying'?Object.values(record.continuationIntents).find(body=>body.expectedRevision===expectedRevision&&body.expectedGeneration===status.generation-1):null;
   if(!intent){const key=expectedRevision+':'+status.generation;record.continuationIntents[key]||={sharedSpaceId:r.connection.sharedSpaceId,workId,opId:'continue_'+sha256(workId+':'+expectedRevision+':from:'+status.generation+':'+context.head+':'+(status.noDispatch&&status.generationRevision===status.revision?status.frozenConfigHash:context.hash)).slice(0,40),expectedRevision,expectedGeneration:status.generation,expectedHead:context.head,configHash:status.noDispatch&&status.generationRevision===status.revision?status.frozenConfigHash:context.hash};intent=record.continuationIntents[key];}
   await o.save();let result;try{result=await r.send(endpoint+'steer-prepare',{body:intent});}catch(error){if(['WORK_SAFE_BOUNDARY_PENDING','WORK_STEERING_COALESCING','SHARED_CONTEXT_CHANGED','STEERING_REVISION_CHANGED','STEERING_GENERATION_CHANGED','MODEL_SAVE_NOT_CURRENT','WORK_EXECUTOR_HANDOFF_REQUIRED'].includes(error.code)){record.continuationRejects||={};record.continuationRejects[intent.opId]=error.code;for(const [key,value]of Object.entries(record.continuationIntents))if(value===intent)delete record.continuationIntents[key];await o.save();}throw error;}ids=result.inputIds||ids;

   if(!this.steps(record).some(s=>s.generation===result.generation))record.generations.push({generation:result.generation,requestId:result.requestId,config:result.config,consumedInputSeq:result.consumedInputSeq});
   const step=this.steps(record).find(value=>value.generation===result.generation);
   if(this.usesFinalHistory(record,step))step.finalHistoryReadback=true;
   record.currentGeneration=result.generation;record.phase='continuing';await o.save();await r.syncExecutionTopic(mapping);
   const history=await r.replica.queue.read(mapping.shared),lastInput=status.inputs.at(-1),userId=result.contextCheckpoint&&(!lastInput||lastInput.inputSeq<=result.contextCheckpoint.throughInputSeq)?result.contextCheckpoint.messageId:(ids.at(-1)||record.accepted.turn?.userMessageId||record.body.message?.id),user=history.find(m=>m.id===userId);if(!user)throw fail('SHARED_USER_NOT_MATERIALIZED');
   const {executionConfig}=require('./sharedExecution');return {handled:true,success:true,admissionId:workId,workId,generation:result.generation,replyId:result.requestId,...(step.finalHistoryReadback&&{nativeFinalReadback:true}),userMessage:user,history,config:executionConfig(result.config),executionPolicy:result.config.rules[0]?.config.executionPolicy||{},tavernRules:require('./contracts.generated.cjs').sharedEffectiveRules([...(result.config.rules[0]?.config.tavernRules||[]),...(result.config.owner.config.tavernRules||[])],result.config.owner.config.ruleOverrides||{})};
  });
 }
 async complete(record,message,mapping){
  return this.owner.run(mapping.sharedId,async()=>{
   const step=this.steps(record).find(s=>s.requestId===message.id);if(!step)throw fail('SHARED_NATIVE_ADMISSION_REQUIRED');
   const retained=await this.owner.retainFailure(record,message,mapping);if(retained)return retained;
   delete step.localFailure;delete step.errorCode;delete step.failureDisposition;
   const readback=this.usesFinalHistory(record,step);
   if(readback){
    if(typeof message.content!=='string')throw fail('SHARED_REPLY_INTENT_CHANGED');
    const observedHash=sha256(message.content);
    if((step.observedFinalHash&&step.observedFinalHash!==observedHash)||(step.replyIntent&&step.replyIntent.content!==message.content))
     throw fail('SHARED_REPLY_INTENT_CHANGED');
    step.finalHistoryReadback=true;
    step.observedFinalHash=observedHash;
   }else{
    const value=this.runtime.adapter.canonical(message,mapping.shared.topicId);
    if(step.replyIntent&&stable(step.replyIntent)!==stable(value))throw fail('SHARED_REPLY_INTENT_CHANGED');
    step.replyIntent||=value;
   }
   record.phase='publishing';await this.owner.save();
   const result=await this.finishStep(record,step,mapping);
   if(!readback)await this.runtime.syncExecutionTopic(mapping);
   else if(!result)throw fail(step.finalHistoryReview?'SHARED_RESULT_REQUIRES_REVIEW':'SHARED_NATIVE_TERMINAL_REQUIRED');
   const history=result?.history||await this.runtime.replica.queue.read(mapping.shared);
   return {handled:true,success:true,localState:'saved',history,
    ...(result&&{authoritativeReply:result.authoritativeReply}),sync:{state:'captured',delivery:step.replyAccepted?'accepted':'pending',recoverable:true}};
  });
 }
 async readFinalReply(record,step,mapping){
  const r=this.runtime,workId=record.accepted.id,requestId=step.requestId;
  if(!step.finalHistoryReadback){step.finalHistoryReadback=true;await this.owner.save();}
  const result=await r.send(endpoint+'final-reply?'+new URLSearchParams({
   sharedSpaceId:r.connection.sharedSpaceId,workId,requestId,generation:String(step.generation),
  }));
  if(result?.workId!==workId||result.sharedId!==mapping.sharedId||result.requestId!==requestId||result.generation!==step.generation)
   throw fail('SHARED_FINAL_REPLY_INVALID');
  if(result.state==='pending')return;
  if(result.state==='review_required'){
   step.finalHistoryReview=true;record.phase=result.workState==='abandoned'?'abandoned':'review_required';
   await this.owner.save();return;
  }
  const {seq,currentSeq,historyState,message,contentHash}=result;
  if(result.state!=='committed'||!Number.isSafeInteger(seq)||seq<1||!Number.isSafeInteger(currentSeq)||currentSeq<seq||
   !/^[a-f0-9]{64}$/.test(contentHash)||!['original','edited','deleted'].includes(historyState)||
   (currentSeq===seq)!==(historyState==='original')||
   (historyState==='deleted'?message!==null:message?.id!==requestId)||
   (historyState==='original'&&(message.role!=='assistant'||message.finishReason!=='completed'||message.continuity?.executionId!==workId||
    message.continuity.requestId!==requestId||typeof message.content!=='string'||sha256(message.content)!==contentHash)))
   throw fail('SHARED_FINAL_REPLY_INVALID');
  if((step.observedFinalHash&&step.observedFinalHash!==contentHash)||
   (step.replyIntent&&(typeof step.replyIntent.content!=='string'||sha256(step.replyIntent.content)!==contentHash))){
   step.finalHistoryReview=true;record.phase='review_required';await this.owner.save();throw fail('SHARED_REPLY_INTENT_CHANGED');
  }

  // Only the ordinary topic projector writes History. A later acknowledged edit
  // or tombstone may already have superseded the server read snapshot.
  await r.syncExecutionTopic(mapping,{minSeq:currentSeq});
  const history=await r.replica.queue.read(mapping.shared);
  const key=messageKey({ownerType:mapping.shared.itemType,ownerId:mapping.shared.itemId,topicId:mapping.shared.topicId,msgId:requestId});
  const ack=r.replica.adapter.state.acked[key],projected=history.find(row=>row.id===requestId)||null;
  if(!ack||ack.seq<currentSeq||Boolean(projected)===ack.deleted||
   (projected&&messageHash(r.adapter.canonical(projected,mapping.shared.topicId))!==ack.hash)||
   (ack.seq===currentSeq&&(ack.deleted!==(historyState==='deleted')||(!ack.deleted&&messageHash(message)!==ack.hash))))
   throw fail('SHARED_FINAL_REPLY_PROJECTION_PENDING');

  step.replyAccepted=true;record.phase='completed';
  delete step.localFailure;delete step.failureDisposition;delete step.errorCode;
  record.accepted={...record.accepted,state:'completed',replySeq:seq};
  await this.owner.save();
  return {history,authoritativeReply:{message:projected,state:ack.deleted?'deleted':ack.seq===seq?'original':'edited',seq:ack.seq}};
 }
 async finishStep(record,step,mapping){
  if(this.usesFinalHistory(record,step)){
   mapping||=this.runtime.mappings().find(value=>value.sharedId===record.sharedId);
   if(!mapping)throw fail('SHARED_LOCAL_MAPPING_PENDING');
   return this.readFinalReply(record,step,mapping);
  }
  if(step.replyAccepted||step.skipped)return;
  const control=await this.query(record);if(control?.generations?.some(g=>g.generation===step.generation&&g.noDispatch)){step.skipped=true;record.phase='steering';await this.owner.save();return;}
  try{
   const result=await this.runtime.send(endpoint+'steer-turn-complete',{body:{sharedSpaceId:this.runtime.connection.sharedSpaceId,workId:record.accepted.id,opId:'turn_'+sha256(step.requestId).slice(0,40),generation:step.generation,message:step.replyIntent}});
   step.replyAccepted=true;record.phase=result.workState==='completed'?'completed':result.workState==='review_required'?'review_required':result.steering?.inputs.length?'steering':'background';record.control=result.steering;await this.owner.save();
  }catch(error){
   if(error.code==='SHARED_NATIVE_TERMINAL_REQUIRED'){
    const input=await this.query(record);if(!input?.inputs.length)throw error;
    const partial={...step.replyIntent,finishReason:'interrupted'};
    await this.runtime.send(endpoint+'steer-checkpoint',{body:{sharedSpaceId:this.runtime.connection.sharedSpaceId,workId:record.accepted.id,opId:'checkpoint_'+sha256(step.requestId).slice(0,40),generation:step.generation,message:partial}});
    step.replyAccepted=true;step.replyIntent=partial;record.phase='steering';await this.owner.save();
   }else if(!['WORK_SAFE_BOUNDARY_PENDING'].includes(error.code))throw error;
  }
 }
 async reconcile(record){
  const o=this.owner,r=this.runtime;if(r.closed)return;
  // A retained reply is not permission to publish into a fenced Work.
  if(this.hasPendingFinalHistory(record)){
   for(const step of this.steps(record)){
    if(!this.pendingFinalHistory(record,step))continue;
    try{await o.run(record.sharedId,()=>this.finishStep(record,step));}
    catch(error){console.warn('[NativeSync] Final Work History readback pending',error.code||error.name);}
   }
   return;
  }
  const current=await this.refresh(record);if(!current||terminal.has(current.state)||current.state==='review_required')return;
  for(const step of this.steps(record))if(step.replyIntent&&!step.replyAccepted&&!step.skipped&&!step.finalHistoryReadback)await o.run(record.sharedId,()=>this.finishStep(record,step));
  const known=await this.refresh(record);if(!known||terminal.has(record.phase)||known.state==='review_required')return;
  record.control=known.steering||await this.query(record);
  for(const input of Object.values(o.state.requests))if(input.isSteeringInput&&input.workId===record.accepted.id&&record.control?.applicationState==='applied'&&input.inputReceipt?.inputSeq<=record.control?.consumedInputSeq){input.phase='input_applied';}
  await o.save();
  if(!['safe-tools-v1','agent-assistant-v1'].includes(record.accepted.turn?.controlMode)&&record.control?.applicationState==='ready'&&this.sessions.has(record.accepted.id)&&record.control.executor==='desktop:'+r.connection.deviceId&&(this.notified.get(record.accepted.id)?.revision!==record.control.revision||Date.now()-this.notified.get(record.accepted.id).at>=1000)){
   this.notified.set(record.accepted.id,{revision:record.control.revision,at:Date.now()});const mapping=r.mappings().find(m=>m.sharedId===record.sharedId);if(!mapping)return;
   const value=await o.status(mapping.local,{refresh:false});r.notifyExecutionStatus?.({...value,readOnly:r.readOnly===true,controlledTextAvailable:!r.closed&&r.readOnly!==true&&r.capabilities.features?.includes('shared-controlled-text-v1')===true,continuation:{workId:record.accepted.id,expectedRevision:record.control.revision,expectedGeneration:record.control.generation,descriptor:mapping.local}});
  }
 }
}
module.exports={SharedSteeringClient};

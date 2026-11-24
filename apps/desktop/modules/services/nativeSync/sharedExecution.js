'use strict';
const path=require('node:path');
const {stable,sha256,fail,messageHash,messageKey,wireTopic,tombstoneHash}=require('./protocol');
const {fieldsFrom}=require('./metadata');
const {ownedJson}=require('./sharedLocal');
const {durableJson}=require('./durableJson');
const {NativeBodyArchive,eligible:bodyArchiveEligible}=require('./nativeBodyArchive');
const {sharedTaskList}=require('./sharedTaskList');
const groupHandoff=require('./sharedGroupHandoff');
const endpoint='/api/v1/sync/shared/';
const final=new Set(['completed','abandoned']);
function replyRecoveryHold(work){
 if(work?.state==='abandoned')return 'abandoned';
 if(work?.state==='review_required'||work?.state!=='completed'&&work?.nativeRequests?.some(v=>v.state==='unknown'))return 'review_required';
 return null;
}
const localShape=m=>({id:m.id,role:m.role,content:m.content,attachments:(m.attachments||[]).map(a=>({type:a.type,name:a.name,size:a.size,src:a.src,hash:a.hash||a._fileManagerData?.hash||null}))});
// A pending display title does not change execution. Keep its draft intact;
// only this exact unsubmitted, non-conflicting current-version case is exempt.
function blocksExecution(runtime,id){
 const draft=runtime.configs.state.drafts[id];if(!draft)return false;
 const known=runtime.configs.state.objects[id],object=runtime.state.objects[id],base=known?.materialized||known?.config;
 if(object?.kind!=='topic'||known?.kind!=='topic'||draft.kind!=='topic'||draft.conflict!==false||draft.submitted||draft.accepted||runtime.configs.state.intent||draft.expectedVersion!==known.version||typeof base?.name!=='string'||typeof draft.config?.name!=='string')return true;
 if(draft.config.archived!==undefined&&typeof draft.config.archived!=='boolean')return true;
 return stable({...draft.config,name:base.name,archived:draft.config.archived??false})!==stable({...base,archived:base.archived??false});
}
// The member reply intent stays outside History until central completion.
function isInterruptedGroupReplyPendingReview(record,step){
 const reply=step.reply;
 return record.config?.owner?.kind==='group'&&record.accepted?.state==='review_required'&&!step.accepted
  &&record.accepted.nativeRequests?.some(request=>request.id===step.id&&request.state==='unknown')
  &&reply?.id==='reply_'+step.id&&reply.role==='assistant'&&reply.finishReason==='interrupted'
  &&typeof reply.content==='string'&&Boolean(reply.content.trim());
}
function interruptedGroupReplies(record){
 return (record.steps||[]).filter(step=>isInterruptedGroupReplyPendingReview(record,step))
  .map(({id,reply})=>({nativeRequestId:id,messageId:reply.id,memberName:reply.name,text:reply.content}));
}
// Keep shared editable templates separate from the server-frozen native prompt.
function executionConfig(config,member){
 const raw=member||config.owner,derived=member?config.execution?.agents?.find(a=>a.id===member.id):config.execution;
 return {...require('./contracts.generated.cjs').sharedAgentExecution(raw.config),stripRegexes:raw.config.stripRegexes||[],...(derived?{systemPrompt:require('./contracts.generated.cjs').sharedSnapshotPrompt(derived)}:{})};
}
// Durable send/receipt intent around the existing native executor. No model
// call is made here; restart queries accepted identities but never dispatches.
const preAdmissionFailures = new Set([
 'SHARED_CONFIG_CONFLICT','SHARED_CONFIG_PENDING','SHARED_CONFIG_PENDING_CONFIRMATION',
 'MODEL_SAVE_NOT_CURRENT','MODEL_SAVE_REFERENCE_UNCONFIRMED','SHARED_CONTEXT_CHANGED',
 'SHARED_LOCAL_MAPPING_PENDING','SHARED_LOCAL_MAPPING_REQUIRED','SHARED_LOCAL_HISTORY_CONFLICT',
 'SHARED_MATCH_PREPARING','SHARED_TOPIC_BUSY','SHARED_RESULT_REQUIRES_REVIEW','DESKTOP_CONTEXT_REQUIRED',
 'SHARED_LOCAL_REMOVED','SHARED_LOCAL_TOPIC_NOT_FOUND','SHARED_UNREGISTERED_HISTORY',
 'SHARED_TOPIC_HISTORY_UPGRADE_REQUIRED','SHARED_CONTEXT_SERVER_UPGRADE_REQUIRED','NETWORK_UNAVAILABLE',
]);

class SharedExecution {
 static async open(runtime){
  const e=new SharedExecution(runtime),ledger=await ownedJson(runtime.root,e.file,{optional:true});
  e.state=ledger||{version:1,binding:runtime.binding(),requests:{}};
  if(![1,2,3,4].includes(e.state.version)||stable(e.state.binding)!==stable(runtime.binding()))throw fail('SHARED_BINDING_CHANGED');
  if(![3,4].includes(e.state.version)&&Object.values(e.state.requests).some(r=>r.nativeBodyRef))throw fail('SHARED_NATIVE_BODY_ARCHIVE_INVALID');
  await e.bodyArchive.validateAll(e.state.requests);
  if(runtime.readOnly&&Object.values(e.state.requests).some(r=>r.projection&&r.projection.state!=='saved'||r.replyProjectionPending||r.committedReply))throw fail('SHARED_READ_ONLY_NOT_SETTLED');
  const inputs=await ownedJson(runtime.root,e.inputFile,{optional:true});
  if(inputs&&(inputs.version!==1||stable(inputs.binding)!==stable(runtime.binding())||!inputs.localInputs||Array.isArray(inputs.localInputs)||typeof inputs.localInputs!=='object'))throw fail('SHARED_LOCAL_INPUT_STATE_INVALID');
  if(!ledger&&inputs)throw fail('SHARED_EXECUTION_STATE_REQUIRED');
  if(e.state.version===1){
   const localInputs=e.state.localInputs||{};
   if(!localInputs||Array.isArray(localInputs)||typeof localInputs!=='object')throw fail('SHARED_LOCAL_INPUT_STATE_INVALID');
   e.state.localInputs=localInputs;
   if(!runtime.readOnly){await durableJson(e.inputFile,{version:1,binding:runtime.binding(),localInputs});e.state.version=2;await e.save();}
  }else{
   if(!inputs)throw fail('SHARED_LOCAL_INPUT_STATE_REQUIRED');
   e.state.localInputs=inputs.localInputs;
  }
  // Keep the established execution/Steering API while the side file owns only
  // fresh text intents. An accepted ledger record always wins over its input.
  for(const [id,value]of Object.entries(e.state.localInputs)){
   if(!value?.descriptor||value.message?.id!==id||typeof value.message.content!=='string')throw fail('SHARED_LOCAL_INPUT_STATE_INVALID');
   if(!e.state.requests[id]){e.state.requests[id]={localInputSeq:value.localInputSeq||0,timings:value.timings||{},phase:'local_pending',descriptor:value.descriptor,localMessage:value.message,admitStarted:false,body:{requestId:id}};e.lightInputs.add(id);}
  }
  e.state.nextLocalInputSeq=Object.values(e.state.requests).reduce((n,v)=>Math.max(n,v.localInputSeq||0),e.state.nextLocalInputSeq||0);
  await require('./sharedSessionStore').SharedSessionStore.loadInto(e);
  return e;
 }
 constructor(runtime){this.runtime=runtime;this.steering=new (require('./sharedSteeringClient').SharedSteeringClient)(this);this.file=path.join(runtime.dir,'executions.json');this.inputFile=path.join(runtime.dir,'local-inputs.json');this.tails=new Map();this.liveGroups=new Set();this.lightInputs=new Set();this.freshAdmissions=new Set();this.projectionTasks=new Map();this.parallelProjectionEnabled=true;this.inlineNativeEnabled=true;this.projectionRevision=0;this.savedProjectionRevision=0;this.bodyArchive=new NativeBodyArchive(runtime);this.archiveTasks=new Map();this.nativeBodyArchivalEnabled=true;this.archiveError=null;}
 save(){this.disk=(this.disk||Promise.resolve()).catch(()=>{}).then(async()=>{const projectionRevision=this.projectionRevision;if(this.sessionStore){await this.sessionStore.flushRecords();await this.sessionStore.writeMain();}else{const {localInputs,...ledger}=this.state;ledger.requests=Object.fromEntries(Object.entries(this.state.requests).filter(([id,r])=>!this.lightInputs.has(id)||r.phase!=='local_pending'||r.admitStarted||r.accepted));await durableJson(this.file,ledger);}this.savedProjectionRevision=projectionRevision;this.runtime.planTick?.();});return this.disk;}
 updateInputs(change){
  let previousWriteFailed=false;
  const write=(this.inputDisk||Promise.resolve()).catch(()=>{previousWriteFailed=true;}).then(async()=>{
   // A lost rename/fsync acknowledgement can leave disk ahead of memory.
   // Reconfirm the known snapshot after failure, even for an empty deletion.
   const next={...this.state.localInputs};if(change(next)===false&&!previousWriteFailed)return;
   await durableJson(this.inputFile,{version:1,binding:this.runtime.binding(),localInputs:next});
   this.state.localInputs=next;
  });this.inputDisk=write;return write;
 }
 async rememberInputFailure(descriptor,message,code,serverSession){
  const failureCode=preAdmissionFailures.has(code)?code:undefined;
  await this.updateInputs(inputs=>{
   const input=inputs[message.id],record=this.state.requests[message.id];
   if(!input||!record||record.accepted||(record.admitStarted&&(!failureCode||record.rejected!==failureCode))||
      stable(input.descriptor)!==stable(descriptor)||stable(localShape(input.message))!==stable(localShape(message)))return false;
   const serverSessionPreferred=Boolean(serverSession||input.serverSessionPreferred);
   if(input.submissionErrorCode===failureCode&&Boolean(input.serverSessionPreferred)===serverSessionPreferred)return false;
   inputs[message.id]={...input,submissionErrorCode:failureCode,serverSessionPreferred};
  });
 }

 async consumeInputs(ids){await this.updateInputs(inputs=>{let changed=false;for(const id of ids)if(Object.hasOwn(inputs,id)){delete inputs[id];changed=true;}return changed;});for(const id of ids)this.lightInputs.delete(id);}
 run(id,fn){const prior=this.tails.get(id)||Promise.resolve(),next=prior.catch(()=>{}).then(fn);this.tails.set(id,next);next.finally(()=>{if(this.tails.get(id)===next)this.tails.delete(id);}).catch(()=>{});return next;}
 mapping(d){const r=this.runtime,shared=r.replica.queue.shared(d);const m=r.mappings().find(m=>stable(m.shared)===stable({itemType:shared.itemType||'agent',itemId:shared.itemId,topicId:shared.topicId}));if(!m)throw fail('SHARED_LOCAL_MAPPING_REQUIRED');return m;}
 query(record){const adopted=record.adoptGroupWork;return this.runtime.send(endpoint+(adopted?'work?':'request?')+new URLSearchParams({sharedSpaceId:this.runtime.connection.sharedSpaceId,...(adopted?{workId:record.accepted.id}:{requestId:record.body.requestId})}));}
 async refresh(record){if(record.steeringV1&&record.accepted)return this.steering.refresh(record);const result=await this.query(record);if(result.request){const phase=final.has(result.request.state)?result.request.state:record.phase,changed=stable(record.accepted)!==stable(result.request)||record.phase!==phase;record.accepted=result.request;record.observedAt=Date.now();record.phase=phase;if(changed)await this.save();}return result.request;}
 async stageLocal(d,message,options={}){
  const localSaveStarted=Date.now();
  if(this.runtime.readOnly)throw fail('SHARED_READ_ONLY');
  if(!d?.itemId||!d?.topicId||!['agent','group'].includes(d.itemType||'agent')||typeof message?.id!=='string'||typeof message.content!=='string')throw fail('INVALID_SHARED_SUBMISSION');
  this.runtime.queue.getHistoryPath(d.itemId,d.topicId);
  return this.run('local:'+message.id,async()=>{
   const prior=this.state.requests[message.id];
   if(prior?.accepted&&final.has(prior.phase))throw fail('SHARED_REQUEST_ALREADY_FINISHED');
   if(prior){if((prior.parentLocalInputId||null)!==(options.parentInputId||null)||(prior.modelSaveRef&&stable(prior.modelSaveRef)!==stable(options.modelSaveRef)))throw fail('SHARED_LOCAL_INTENT_CHANGED');if(stable(localShape(prior.localMessage))!==stable(localShape(message))||stable(prior.descriptor||this.runtime.mappings().find(m=>m.sharedId===prior.sharedId)?.local)!==stable(d))throw fail('SHARED_LOCAL_INTENT_CHANGED');if(!this.lightInputs.has(message.id))await this.save();return {handled:true,success:true,inputId:message.id,localState:'saved',phase:prior.phase};}
   if((d.itemType||'agent')==='agent'&&!message.attachments?.length&&!options.parentInputId&&!options.modelSaveRef){
    const plain=JSON.parse(JSON.stringify({...message,attachments:[]}));
    if(Buffer.byteLength(JSON.stringify(plain))>32*1024*1024)throw fail('LOCAL_INPUT_TOO_LARGE');
    const localInputSeq=(this.state.nextLocalInputSeq||0)+1,timings={local_save_started:localSaveStarted};this.state.nextLocalInputSeq=localInputSeq;
    await this.updateInputs(inputs=>{inputs[message.id]={descriptor:{...d},message:plain,localInputSeq,timings};});
    this.state.nextLocalInputSeq=localInputSeq;this.lightInputs.add(message.id);
    this.state.requests[message.id]={localInputSeq,timings,phase:'local_pending',descriptor:{...d},localMessage:plain,admitStarted:false,body:{requestId:message.id}};
    timings.local_saved=Date.now();return {handled:true,success:true,inputId:message.id,messageId:message.id,localState:'saved',phase:'local_pending',timings:{...timings}};
   }
   const refs=(await import('../../chat/composerDrafts.mjs')).attachmentReferences(message.attachments||[]);if(refs.some(ref=>!ref.src))throw fail('ATTACHMENT_REFERENCE_REQUIRED');
   const plain=JSON.parse(JSON.stringify({...message,attachments:refs}));
   if(Buffer.byteLength(JSON.stringify(plain))>32*1024*1024)throw fail('LOCAL_INPUT_TOO_LARGE');
   this.state.nextLocalInputSeq=(this.state.nextLocalInputSeq||0)+1;
   this.state.requests[message.id]={localInputSeq:this.state.nextLocalInputSeq,...(options.parentInputId?{parentLocalInputId:options.parentInputId}:{}),...(options.modelSaveRef?{modelSaveRef:options.modelSaveRef,dependencyReady:false}:{}),timings:{local_save_started:localSaveStarted},phase:'local_pending',descriptor:{...d},localMessage:plain,admitStarted:false,body:{requestId:message.id}};await this.save();
   this.state.requests[message.id].timings.local_saved=Date.now();return {handled:true,success:true,inputId:message.id,localState:'saved',phase:'local_pending',timings:{...this.state.requests[message.id].timings}};
  });
 }
 async prepare(d,message,options={},control={}){
  if(this.runtime.readOnly)throw fail('SHARED_READ_ONLY');
  const r=this.runtime,mapping=this.mapping(d);if(!r.isLocalVisible(mapping.sharedId))throw fail('SHARED_LOCAL_REMOVED');
  if(!r.capabilities.features?.includes('shared-context-v1'))throw fail('SHARED_CONTEXT_SERVER_UPGRADE_REQUIRED');
  await this.waitProjection(d);
  if(options.kind==='regenerate'&&options.targetMessage){
   options=await this.bindRegenerationTarget(mapping,message.id,options);
  }
  const priorInput=this.state.requests[message.id];if(priorInput?.admitStarted&&!priorInput.accepted)await this.refresh(priorInput);const resuming=Boolean(priorInput?.accepted&&priorInput.body?.requestId===message.id);
  const executionContext=resuming?{hash:priorInput.accepted.configHash,head:priorInput.accepted.contextHead}:await r.refreshForExecution(d,{...control,forceFresh:Boolean(control.forceFresh||options.modelSaveRef||options.targetSeq!==undefined)});if(!resuming&&options.modelSaveRef&&executionContext.model!==options.modelSaveRef.model)throw fail('MODEL_SAVE_NOT_CURRENT');
  return this.run(mapping.sharedId,async()=>{
   if(!r.isLocalVisible(mapping.sharedId))throw fail('SHARED_LOCAL_REMOVED');r.matching?.assert([mapping.sharedId,r.state.objects[mapping.sharedId].parentId]);
   const owner=r.state.objects[r.state.objects[mapping.sharedId].parentId],affected=new Set(executionContext.dependencies?[mapping.sharedId,...executionContext.dependencies.map(v=>v.id)]:[mapping.sharedId,owner.id,...(owner.config?.members||[]),...Object.values(r.state.objects).filter(o=>o.kind==='rules'&&!o.deleted).map(o=>o.id)]);
   if(!resuming&&Object.keys(r.configs.state.drafts).some(id=>affected.has(id)&&blocksExecution(r,id)))throw fail('SHARED_CONFIG_CONFLICT');
   if(message.attachments?.length&&!r.attachments)throw fail('ATTACHMENTS_NOT_ENABLED');
   const fast=r.capabilities.features?.includes('shared-inline-receipts-v1')&&mapping.shared.itemType==='agent'&&!message.attachments?.length&&(!options.kind||options.kind==='message')&&!options.controlMode;
   const signature=sha256(stable({...((options.kind&&options.kind!=='message')?options:{}),...(options.controlMode==='agent-assistant-v1'&&{delegation:options.delegation}),content:message.content,attachments:message.attachments||[]}));
   let record=Object.values(this.state.requests).find(v=>v.sharedId===mapping.sharedId&&!v.isSteeringInput&&!final.has(v.phase)
    &&!(groupHandoff.isMode(v.body?.controlMode)&&v.phase==='local_pending'&&v.rejected&&!v.admitStarted&&!groupHandoff.isMode(options.controlMode)));
   if(record&&(record.body?.controlMode||null)!==(options.controlMode||null))throw fail('CONTROLLED_MODE_IMMUTABLE');
   if(record?.serverSession)throw fail('SHARED_SESSION_DISPATCH_ONLY');
   if(record&&record.body?.requestId!==message.id&&(options.kind==='regenerate'||record.body?.kind==='regenerate'))throw fail('SHARED_TOPIC_BUSY');
   if(record?.accepted&&record.steeringV1&&record.body.requestId!==message.id){if(options.requireIdle||!options.observedWorkId)throw fail('SHARED_TOPIC_BUSY');return this.steering.submit(record,d,message,options);}
   if(record){
    if(record.signature!==signature){if(record.admitStarted===false&&!record.accepted){record.phase='abandoned';await this.save();record=null;}else throw fail('SHARED_TOPIC_BUSY');}
    const known=record?await this.refresh(record):null;
    if(known?.dispatched||(record?.nativeBody||record?.nativeBodyRef)&&known?.nativeRequests?.some(n=>n.state!=='prepared'))throw fail('SHARED_RESULT_REQUIRES_REVIEW');
    if(record&&final.has(record.phase))throw fail('SHARED_REQUEST_ALREADY_FINISHED');
   }
   if(!record){
    const local=this.state.requests[message.id];if(local&&local.phase!=='local_pending'&&!(control.forceFresh&&local.rejected==='SHARED_CONTEXT_CHANGED'&&!local.accepted))throw fail('SHARED_LOCAL_INTENT_CHANGED');
    if(local&&(stable(localShape(local.localMessage))!==stable(localShape(message))||stable(local.descriptor)!==stable(d)))throw fail('SHARED_LOCAL_INTENT_CHANGED');
    const config=executionContext;
    if(config.members?.some(m=>blocksExecution(r,m.id)))throw fail('SHARED_CONFIG_CONFLICT');
    const canonical=!options.kind||options.kind==='message'?r.adapter.canonical(message,mapping.shared.topicId):null;
    record={timings:this.state.requests[message.id]?.timings||{},...(options.modelSaveRef?{modelSaveRef:options.modelSaveRef}:{}),steeringV1:['text-only-v1','safe-tools-v1','agent-assistant-v1'].includes(options.controlMode)&&this.steering.enabled()&&mapping.shared.itemType==='agent',descriptor:{...d},sharedId:mapping.sharedId,signature,phase:'preparing',admitStarted:false,localMessage:message,body:{sharedSpaceId:r.connection.sharedSpaceId,sharedId:mapping.sharedId,requestId:message.id,expectedHead:config.head,configHash:config.hash,...Object.fromEntries(Object.entries(options).filter(([key])=>!['deferReady','observedWorkId','requireIdle','sponsorRouteHash'].includes(key)&&(!['modelSaveRef','modelSaveResolutionRef'].includes(key)||r.capabilities.features?.includes('shared-model-save-v1')))),...(options.controlMode==='agent-assistant-v1'?{}:require('./sharedTopicSponsor').topicSponsorRouteBinding(r,mapping,options.kind)),...(!options.kind||options.kind==='message'?{message:canonical}:{})}};
    this.state.requests[message.id]=record;await this.save();
   }
   if(record.localMessage?.attachments?.length&&!record.admitStarted){record.localMessage=await r.attachments.uploadMessage(d,record.localMessage);record.body.message=r.adapter.canonical(record.localMessage,mapping.shared.topicId);await this.save();}
   record.timings||={};record.timings.submitting=Date.now();record.admitStarted=true;await this.save();
   let inline,replayed=false;
   try{const response=await r.send(endpoint+'admit',{body:record.body});({inline,...record.accepted}=response);replayed=response.replayed===true;record.steeringV1=Boolean(record.accepted.turn?.steeringCapable);record.phase='accepted';record.timings.accepted=Date.now();if(!fast||record.steeringV1)await this.save();if(fast&&!record.steeringV1&&!replayed)this.freshAdmissions.add(record.accepted.id);}
   catch(error){if(options.controlMode&&['CONTROLLED_TEXT_PORTABLE_REQUIRED','CONTROLLED_TEXT_UNAVAILABLE','CONTROLLED_TOOLS_UNAVAILABLE','INVALID_SHARED_AA_DELEGATION','CONTROLLED_MODE_UNSUPPORTED','INVALID_SHARED_SUBMISSION'].includes(error.code)){record.phase='local_pending';record.admitStarted=false;record.rejected=error.code;await this.save();throw error;}if(error.code==='SHARED_TOPIC_BUSY'&&options.requireIdle){record.phase='local_pending';record.admitStarted=false;await this.save();throw fail('STEERING_TARGET_CHANGED');}if(error.code==='SHARED_TOPIC_BUSY'&&options.observedWorkId&&this.steering.enabled()&&mapping.local.itemType==='agent'&&(!options.kind||options.kind==='message')){record.phase='local_pending';record.admitStarted=false;await this.save();const active=await this.steering.active(d,options.observedWorkId);if(active?.steeringV1)return this.steering.submit(active,d,message,options);}
    if((options.targetSeq!==undefined&&error.code==='INVALID_SHARED_REQUEST')||['SHARED_TOPIC_BUSY','SHARED_CONTEXT_CHANGED','SHARED_MESSAGE_ALREADY_EXISTS','SHARED_REGENERATION_TARGET_CHANGED','SHARED_MATCH_PREPARING','MODEL_SAVE_NOT_CURRENT','MODEL_SAVE_REFERENCE_UNCONFIRMED'].includes(error.code)){record.phase='abandoned';record.rejected=error.code;await this.save();if(fast&&executionContext.optimistic&&error.code==='SHARED_CONTEXT_CHANGED'&&error.status===409)error.knownAdmissionRejected=true;}throw error;}
   const config=fast&&inline?.capability==='shared-inline-receipts-v1'&&!record.steeringV1?inline.config:(await r.send(endpoint+'request-config?'+new URLSearchParams({sharedSpaceId:r.connection.sharedSpaceId,admissionId:record.accepted.id}))).config;
   if(config.hash!==record.accepted.configHash||config.owner.kind!==mapping.shared.itemType)throw fail('SHARED_CONFIG_RESPONSE_INVALID');
   if(options.modelSaveRef&&config.owner.config.model!==options.modelSaveRef.model)throw fail('MODEL_SAVE_NOT_CURRENT');
   record.config=config;record.executionDependencies=executionContext.dependencies||record.executionDependencies;if(record.steeringV1)this.steering.sessions.add(record.accepted.id);
   const base=executionContext.executionHistory,parallel=this.parallelProjectionEnabled&&fast&&!record.steeringV1&&!replayed&&!record.nativeBody&&!record.nativeBodyRef&&Array.isArray(base)&&inline?.event&&r.capabilities.features?.includes('shared-native-inline-v1')&&!base.some(m=>m.id===record.body.message.id);
   if(parallel){
    const event=this.validateInline(mapping,inline.event,{seq:record.accepted.userSeq,messageId:record.body.message.id});
    if(event.hash!==messageHash(record.body.message)||r.adapter.inboundBlocked(event))throw fail('SHARED_INLINE_EVENT_INVALID');
    const user=r.adapter.canonical(event.message,mapping.shared.topicId),history=[...base.map(m=>({...m})),user];
    record.projection={state:'pending',event,beforeRevision:r.replica.queue.revision(base),afterRevision:r.replica.queue.revision(history),inputIds:[message.id,record.body.requestId]};
    await this.save();this.startProjection(record,mapping);return this.singleResult(record,config,user,history,{projectionPending:true});
   }
   await this.save();
   if(fast&&!record.steeringV1&&inline?.event){await this.applyInline(mapping,inline.event,{seq:record.accepted.userSeq,messageId:record.body.message.id});await r.verifyHistory(mapping);}else await r.syncExecutionTopic(mapping,{minSeq:record.accepted.userSeq||0});
   if(record.body.message?.attachments?.length)await r.attachments.restoreRemote({descriptor:d,messageId:record.body.message.id,nativeMessage:record.localMessage});
   record.timings.topic_ready=Date.now();if(record.steeringV1)await this.steering.promoteQueued(record);
   const history=await r.replica.queue.read(mapping.shared),user=history.find(m=>m.id===(record.accepted.turn?.userMessageId||record.body.message?.id));if((!record.accepted.turn||record.accepted.turn.kind==='message')&&!user)throw fail('SHARED_USER_NOT_MATERIALIZED');
   if(record.steeringV1&&Object.values(this.state.requests).some(v=>v.workId===record.accepted.id&&v.isSteeringInput))return {handled:true,success:true,inputAccepted:true,initialSuperseded:true,workId:record.accepted.id,history};
   if(fast&&!record.steeringV1){await this.rememberContext(mapping,record.accepted.userSeq,record.accepted.configHash);await this.save();}
   await this.consumeInputs([message.id,record.body.requestId]);
   if(config.owner.kind==='group')return this.groupResult(record,config,user,history);
   return {handled:true,success:true,admissionId:record.accepted.id,replyId:'reply_'+record.accepted.id,userMessage:user,history,turn:record.accepted.turn,config:executionConfig(config),executionPolicy:config.rules[0]?.config.executionPolicy||{},tavernRules:require('./contracts.generated.cjs').sharedEffectiveRules([...(config.rules[0]?.config.tavernRules||[]),...(config.owner.config.tavernRules||[])],config.owner.config.ruleOverrides||{})};
  });
 }
 async bindRegenerationTarget(mapping,requestId,{targetMessage,...options}){
  const r=this.runtime,{adapter,queue}=r.replica;
  const changed=()=>fail('SHARED_REGENERATION_TARGET_CHANGED');
  if(!options.targetId||targetMessage.id!==options.targetId||targetMessage.role!=='assistant'||
     targetMessage.isThinking||targetMessage.isPendingStream||targetMessage.contextCompaction)throw changed();
  const topicId=mapping.shared.topicId,expected=adapter.canonical(targetMessage,topicId);
  const targetHash=messageHash(expected);
  const prior=this.state.requests[requestId];
  if(prior?.body?.targetSeq!==undefined){
   if(prior.sharedId!==mapping.sharedId||prior.body.targetId!==expected.id||prior.body.targetHash!==targetHash)throw changed();
   return {...options,targetHash,targetSeq:prior.body.targetSeq};
  }
  const current=(await queue.read(mapping.shared)).find(m=>m.id===expected.id);
  if(!current||current.role!=='assistant'||current.isThinking||current.isPendingStream||current.contextCompaction)throw changed();
  const original=adapter.canonical(current,topicId);
  const metadataHash=sha256(stable(fieldsFrom(expected)));
  const base=adapter.state.acked[messageKey({...wireTopic(mapping.shared),msgId:expected.id})];
  if(!base||base.deleted||!Number.isSafeInteger(base.seq)||base.seq<1||base.hash!==targetHash||messageHash(original)!==targetHash||
     base.metadataHash!==metadataHash||sha256(stable(fieldsFrom(original)))!==metadataHash)throw changed();
  return {...options,targetHash,targetSeq:base.seq};
 }
 groupResult(record,config,user,history){
  const r=this.runtime;return {handled:true,success:true,record,history,userMessage:user,turn:record.accepted.turn,config:r.groupToLocal(config.owner.config),members:config.members.map(m=>({id:r.localFor(m.id).localId,...executionConfig(config,m)}))};
 }
 singleResult(record,config,user,history,extra={}){
  return {handled:true,success:true,admissionId:record.accepted.id,replyId:'reply_'+record.accepted.id,userMessage:user,history,turn:record.accepted.turn,config:executionConfig(config),executionPolicy:config.rules[0]?.config.executionPolicy||{},tavernRules:require('./contracts.generated.cjs').sharedEffectiveRules([...(config.rules[0]?.config.tavernRules||[]),...(config.owner.config.tavernRules||[])],config.owner.config.ruleOverrides||{}),...extra};
 }
 validateInline(mapping,event,{seq,messageId}){
  if(!event||event.seq!==seq||event.msgId!==messageId||event.action!=='upsert'||!this.runtime.adapter.sameTopic(event,mapping.shared))throw fail('SHARED_INLINE_EVENT_INVALID');
  return this.runtime.adapter.validateEvent(event);
 }
 async applyInline(mapping,event,{seq,messageId,proof}){
  event=this.validateInline(mapping,event,{seq,messageId});
  return this.runtime.replica.applyCommitted(mapping,event,proof);
 }
 startProjection(record,mapping){
  const key=record.body.requestId,prior=this.projectionTasks.get(key);if(prior)return prior;
  if(!record.projection||record.projection.state==='saved')return Promise.resolve();
  const task=new Promise(resolve=>setImmediate(resolve)).then(async()=>{
   const p=record.projection,r=this.runtime;
   try{
    await this.applyInline(mapping,p.event,{seq:record.accepted.userSeq,messageId:record.body.message.id,proof:p});
    const history=await r.verifyHistory(mapping);
    this.state.executionSnapshots||={};this.state.executionSnapshots[mapping.sharedId]={head:record.accepted.userSeq,hash:record.accepted.configHash,localRevision:r.replica.queue.revision(history),dependencies:record.executionDependencies,model:record.config.owner.config.model};
    // The durable accepted projection intent plus the adapter's durable
    // history/ACK already prove recovery. Checkpoint progress with the next
    // required ledger write (or close), rather than rewriting it on this path.
    await this.consumeInputs(p.inputIds);
    p.state='saved';delete p.error;this.projectionRevision++;
    // Completion notification is separate from the adapter's earlier write
    // notification, which may precede ACK/input recovery becoming durable.
    this.projectionNotice(mapping,key,'saved');
   }catch(error){
    p.state='failed';p.error=error.code||'SHARED_LOCAL_PROJECTION_FAILED';this.projectionRevision++;
    this.projectionNotice(mapping,key,'failed');
    throw Object.assign(error,{sharedAccepted:true,requestId:key});
   }
  });
  this.projectionTasks.set(key,task);task.finally(()=>{if(this.projectionTasks.get(key)===task)this.projectionTasks.delete(key);}).catch(()=>{});return task;
 }
 projectionNotice(mapping,requestId,projectionState){
  try{return this.runtime.notify?.({...mapping.local,agentId:mapping.local.itemId,ownerId:mapping.local.itemId,ownerType:mapping.local.itemType,source:'native-sync-projection',requestId,projectionState});}catch{return false;}
 }
 async waitProjection(d){
  await this.runtime.sessions?.waitProjection(d);
  const mapping=this.mapping(d);
  for(const record of Object.values(this.state.requests))if(record.sharedId===mapping.sharedId&&record.projection&&(record.projection.state!=='saved'||this.projectionTasks.has(record.body.requestId)))await this.startProjection(record,mapping);
 }
 async rememberContext(mapping,head,hash){
  const history=await this.runtime.replica.queue.read(mapping.shared);
  this.state.executionSnapshots||={};const record=Object.values(this.state.requests).find(v=>v.sharedId===mapping.sharedId&&v.accepted?.configHash===hash&&v.executionDependencies);this.state.executionSnapshots[mapping.sharedId]={head,hash,localRevision:this.runtime.replica.queue.revision(history),dependencies:record?.executionDependencies,model:record?.config?.owner.config.model};
 }
 policy(context,requestId){const policy=this.steering.policy(requestId);if(policy)return policy;const record=Object.values(this.state.requests).find(v=>v.accepted&&'reply_'+v.accepted.id===requestId);if(!record)throw fail('SHARED_NATIVE_ADMISSION_REQUIRED');if(record.serverSession)throw fail('SHARED_SESSION_DISPATCH_ONLY');return record.config.rules[0]?.config.executionPolicy||{};}
 async prepareNative(context,body){
  this.runtime.assertSharedAccess?.();
  if(this.runtime.closed)throw fail('APPLICATION_SHUTTING_DOWN');
  if(this.runtime.readOnly)throw fail('SHARED_READ_ONLY');
  const r=this.runtime,mapping=this.mapping({itemType:context?.ownerType||'agent',itemId:context?.agentId,topicId:context?.topicId});
  return this.run(mapping.sharedId,async()=>{
   const record=Object.values(this.state.requests).find(v=>v.accepted&&!v.isSteeringInput&&('reply_'+v.accepted.id===body.requestId||v.generations?.some(g=>g.requestId===body.requestId))&&v.sharedId===mapping.sharedId);
   if(!record||final.has(record.phase))throw fail('SHARED_NATIVE_ADMISSION_REQUIRED');
   if(record.serverSession)throw fail('SHARED_SESSION_DISPATCH_ONLY');
   if(record.steeringV1){const result=await this.steering.prepareNative(record,body);r.assertSharedAccess?.();return result;}
   const fresh=this.freshAdmissions.has(record.accepted.id)&&record.phase==='accepted'&&!record.nativeBody&&!record.nativeBodyRef&&!record.accepted.dispatched,known=fresh?record.accepted:await this.refresh(record);if(!known||known.dispatched||(known.nativeRequests||[]).some(n=>n.state!=='prepared'))throw fail('SHARED_RESULT_REQUIRES_REVIEW');
   if(body.model!==record.config.owner.config.model)throw fail('SHARED_NATIVE_CONFIG_CHANGED');
   // Seal the actual JSON wire image; undefined fields are absent after transport.
   if(!record.nativeBody&&!record.nativeBodyRef){record.nativeBody=JSON.parse(JSON.stringify(body));record.phase='dispatching';await this.save();}
   const nativeBody=await this.loadNativeBody(record);r.assertSharedAccess?.();
   this.freshAdmissions.delete(record.accepted.id);
   const inline=this.inlineNativeEnabled&&r.capabilities.features?.includes('shared-native-inline-v1')&&record.config.owner.kind==='agent'&&(!record.accepted.turn||record.accepted.turn.kind==='message');
   if(inline)return {body:nativeBody,headers:{...require('./runtime').syncHeaders(r.connection),'X-NativeSync-Capabilities':'shared-space-v1,shared-native-inline-v1','X-NativeSync-Admission':record.accepted.id,'X-NativeSync-Register':'v1','X-NativeSync-Body-Hash':sha256(stable(nativeBody))}};
   const registered=await r.send(endpoint+'native-request',{body:{sharedSpaceId:r.connection.sharedSpaceId,admissionId:record.accepted.id,requestId:body.requestId,bodyHash:sha256(stable(nativeBody))}});
   if(registered.state!=='prepared')throw fail('SHARED_RESULT_REQUIRES_REVIEW');
   if(record.phase!=='dispatching'){record.phase='dispatching';await this.save();}
   r.assertSharedAccess?.();return {body:nativeBody,...(record.config.owner.kind==='agent'&&record.body?.targetSeq!==undefined&&record.accepted.turn?.kind==='regenerate'?{regeneration:true}:{}),headers:{...require('./runtime').syncHeaders(r.connection),'X-NativeSync-Capabilities':'shared-space-v1','X-NativeSync-Admission':record.accepted.id}};
  });
 }
 async commitExistingMessage(d,intent,mapping){
  const r=this.runtime,operation=intent.operations?.[0],edit=intent.source==='message-edit';
  const expected=edit?operation?.expected:operation?.expected?.[0];
  const id=edit?operation?.id:operation?.ids?.[0];
  if(intent.version!==1||intent.requestId||intent.executionId||intent.localOnly||!Array.isArray(intent.operations)||intent.operations.length!==1||
     typeof id!=='string'||!id||expected?.id!==id||(expected.role!=='assistant'&&(edit||expected.role!=='user'))||
     (edit?(operation.kind!=='edit'||typeof operation.set?.content!=='string'||
       Object.keys(operation.set).some(key=>!['content','updatedAt'].includes(key))||
       (operation.unset!==undefined&&(!Array.isArray(operation.unset)||operation.unset.length))):
       (operation.kind!=='delete'||!Array.isArray(operation.ids)||operation.ids.length!==1||!Array.isArray(operation.expected)||operation.expected.length!==1)))throw fail('INVALID_SHARED_MESSAGE_MUTATION');
  const {applyMessageOperations,messagePreconditionValue}=await import('../../chat/historyMessageIntent.mjs');
  return this.run(mapping.sharedId,async()=>{
   r.assertSharedAccess();
   if(r.readOnly)throw fail('SHARED_READ_ONLY');
   if(r.closed||!r.ready)throw fail('SHARED_STARTUP_PENDING');
   if(!r.capabilities.features?.includes('shared-desktop-message-edit-v1'))throw fail('SHARED_CLIENT_UPGRADE_REQUIRED');
   if(!r.isLocalVisible(mapping.sharedId))throw fail('SHARED_LOCAL_REMOVED');
   if(d.itemId!==mapping.local.itemId||d.topicId!==mapping.local.topicId||this.mapping(d).sharedId!==mapping.sharedId)throw fail('SHARED_LOCAL_MAPPING_REQUIRED');
   r.matching.assert([mapping.sharedId,r.state.objects[mapping.sharedId].parentId]);
   const {adapter,queue}=r.replica,topicId=mapping.shared.topicId;
   const history=await queue.read(mapping.shared),current=history.find(message=>message.id===id);
   if(!current)throw fail('HISTORY_MESSAGE_NOT_FOUND');
   if(current.role!==expected.role||current.isThinking||current.isPendingStream||current.contextCompaction||
      messagePreconditionValue(current)!==messagePreconditionValue(expected))throw fail('HISTORY_MESSAGE_CONFLICT');
   if(intent.expectedRevision!==undefined&&intent.expectedRevision!==queue.revision(history))throw fail('HISTORY_REVISION_CONFLICT');
   const identity={...wireTopic(mapping.shared),msgId:id},base=adapter.state.acked[messageKey(identity)];
   const original=adapter.canonical(current,topicId);
   if(!base||base.deleted||!Number.isSafeInteger(base.seq)||base.seq<1||base.hash!==messageHash(original)||
      base.metadataHash!==sha256(stable(fieldsFrom(original))))throw fail('SHARED_LOCAL_HISTORY_CONFLICT');
   const next=applyMessageOperations([current],[operation]);
   const message=edit?adapter.canonical(next[0],topicId):null;
   const wire={...identity,deviceId:adapter.deviceId,action:edit?'upsert':'delete',baseHash:base.hash,baseSeq:base.seq,message,
      ...(message?._nativeSyncMetadata?{metadata:message._nativeSyncMetadata}:{})};
   const opId='desktop-message_'+sha256(stable(wire));
   const receipt=await r.send(endpoint+'message',{body:{sharedSpaceId:r.connection.sharedSpaceId,sharedId:mapping.sharedId,operation:{...wire,opId}}});
   if(!Number.isSafeInteger(receipt?.seq)||receipt.seq<base.seq||receipt.deleted!==!edit||
      receipt.hash!==(edit?messageHash(message):tombstoneHash(identity)))throw fail('SHARED_MESSAGE_RECEIPT_INVALID');
   await r.syncExecutionTopic(mapping,{minSeq:receipt.seq});
   const saved=await queue.read(mapping.shared);
   return {handled:true,success:true,localState:'saved',history:saved,revision:queue.revision(saved),sync:{state:'captured',delivery:'accepted',recoverable:true}};
  });
 }
 async commit(d,intent){
  const mapping=this.mapping(d);
  if(mapping.shared.itemType==='agent'&&['message-edit','message-remove'].includes(intent?.source))return this.commitExistingMessage(d,intent,mapping);
  const record=Object.values(this.state.requests).find(v=>v.sharedId===mapping.sharedId&&v.accepted&&!v.isSteeringInput&&('reply_'+v.accepted.id===intent.requestId||v.generations?.some(g=>g.requestId===intent.requestId)));
  if(!record)throw fail('SHARED_NATIVE_ADMISSION_REQUIRED');
  const appended=intent.operations.filter(o=>o.kind==='append');
  if(appended.length!==1||intent.operations.some(o=>o.kind!=='append'&&(o.kind!=='delete'||o.ids?.length))||appended[0].message.id!==(record.steeringV1?intent.requestId:'reply_'+record.accepted.id))throw fail('INVALID_SHARED_REPLY');
  return this.complete(record,appended[0].message,mapping);
 }
 async terminal(d,projected){const mapping=this.mapping(d),record=Object.values(this.state.requests).find(v=>v.sharedId===mapping.sharedId&&v.accepted&&!v.isSteeringInput&&('reply_'+v.accepted.id===projected.messageId||v.generations?.some(g=>g.requestId===projected.messageId)));if(!record)throw fail('SHARED_NATIVE_ADMISSION_REQUIRED');const message=projected.history.find(m=>m.id===projected.messageId&&!m.isThinking&&!m.isPendingStream);if(!message)throw fail('INVALID_SHARED_REPLY');return this.complete(record,message,mapping);}
 async retainFailure(record,message,mapping){
  if(!['failed','interrupted','cancelled'].includes(message.finishReason))return null;
  const step=record.steeringV1?this.steering.steps(record).find(v=>v.requestId===message.id):record;if(!step)throw fail('SHARED_NATIVE_ADMISSION_REQUIRED');
  const fact=await this.runtime.noteSharedSendFailure({descriptor:record.descriptor||mapping.local,requestId:message.id,code:message.errorCode});
  if(fact.handled&&['not_started','unknown'].includes(fact.classification)){
   step.localFailure=this.runtime.adapter.canonical(message,mapping.shared.topicId);step.failureDisposition=fact.classification;await this.save();
   if(fact.classification==='unknown')throw fail('SHARED_RESULT_REQUIRES_REVIEW');
   return {handled:true,success:true,localState:'saved',history:await this.runtime.replica.queue.read(mapping.shared),sync:{state:'captured',delivery:'not_started',recoverable:true}};
  }return null;
 }
 async complete(record,message,mapping,{recovering=false}={}){
  if(record.serverSession)throw fail('SHARED_SESSION_DISPATCH_ONLY');
  if(record.steeringV1)return this.steering.complete(record,message,mapping);
  return this.run(mapping.sharedId,async()=>{
   const known=recovering?await this.refresh(record):null;
   if(recovering&&(!known||await this.holdReplyRecovery(record)))return;
   const r=this.runtime;
   if(known?.state!=='completed'){
    const retained=await this.retainFailure(record,message,mapping);if(retained)return retained;
    const value=r.adapter.canonical(message,mapping.shared.topicId);
    if(record.reply&&stable(record.reply)!==stable(value))throw fail('SHARED_REPLY_INTENT_CHANGED');
    delete record.localFailure;delete record.errorCode;delete record.failureDisposition;record.reply=value;record.replyProjectionPending=true;record.phase='publishing';await this.save();await this.waitProjection(mapping.local);
    try{await this.finish(record);}catch(error){
     if(recovering&&error.code==='SHARED_REQUEST_FENCED'&&await this.holdReplyRecovery(record))return;
     throw error;
    }
    if(record.phase!=='completed'){
     if(recovering){await this.holdReplyRecovery(record);return;}
     throw fail('SHARED_NATIVE_TERMINAL_REQUIRED');
    }
   }
   if(record.committedReply){await this.applyInline(mapping,record.committedReply,{seq:record.accepted.replySeq,messageId:record.reply.id});await r.verifyHistory(mapping);delete record.committedReply;await this.rememberContext(mapping,record.accepted.replySeq,record.accepted.configHash);}else await r.syncExecutionTopic(mapping,{minSeq:record.accepted.replySeq||0});record.replyProjectionPending=false;await this.save();this.scheduleNativeBodyArchive(record);return {handled:true,success:true,localState:'saved',history:await r.replica.queue.read(mapping.shared),sync:{state:'captured',delivery:record.phase==='completed'?'accepted':'pending',recoverable:true}};
  });
 }
 async holdReplyRecovery(record){
  const phase=replyRecoveryHold(record.accepted);
  if(phase&&record.phase!==phase){record.phase=phase;await this.save();}
  return Boolean(phase);
 }
 async finish(record){
  const fast=this.runtime.capabilities.features?.includes('shared-inline-receipts-v1')&&record.config?.owner.kind==='agent';
  try{
   if(!fast){const known=await this.refresh(record);if(known?.state==='abandoned')throw fail('SHARED_REQUEST_FENCED');}
   const completed=await this.runtime.send(endpoint+'complete',{body:{sharedSpaceId:this.runtime.connection.sharedSpaceId,admissionId:record.accepted.id,opId:'desktop-complete_'+record.accepted.id,message:record.reply}});
   if(completed.request)record.accepted=completed.request;
   if(fast&&completed.inline?.capability==='shared-inline-receipts-v1')record.committedReply=completed.inline.event;
   record.phase='completed';await this.save();
  }catch(error){
   if(error.code!=='SHARED_NATIVE_TERMINAL_REQUIRED')throw error;
   const known=await this.refresh(record);if(known?.state==='abandoned')throw fail('SHARED_REQUEST_FENCED');
  }
 }
 needsRecordReconcile(record){
  if(!record.steeringV1&&record.reply&&record.phase==='abandoned'&&record.accepted?.state==='abandoned')return false;
  return (!final.has(record.phase)||record.replyProjectionPending||record.committedReply||this.steering.hasPendingFinalHistory(record))&&record.phase!=='local_pending'&&!record.isSteeringInput&&!record.serverSession&&(!record.projection||record.projection.state==='saved');
 }
 needsReconcile(){
  const records=Object.values(this.state.requests);
  return records.some(record=>record.projection&&record.projection.state!=='saved'||this.needsRecordReconcile(record)&&!(record.reply&&!record.steeringV1&&replyRecoveryHold(record.accepted)))||
   Object.values(this.state.compactions||{}).some(intent=>intent.phase==='publishing')||
   Object.values(this.state.compactionPrepareRequests||{}).some(intent=>intent.phase==='preparing'&&!this.runtime.activeCompactionPrepares?.has(intent.body.opId))||
   Object.entries(this.state.compactionPreparations||{}).some(([id,prepared])=>!prepared.cancelled&&!this.runtime.activeCompactions?.has(id)&&!this.state.compactions?.[id]?.body);
 }
 async reconcile(){
  for(const record of Object.values(this.state.requests))if(record.projection&&record.projection.state!=='saved'){const mapping=this.runtime.mappings().find(m=>m.sharedId===record.sharedId);if(mapping)try{await this.startProjection(record,mapping);}catch{/* Retain original accepted identity; no model replay. */}}
  await this.runtime.recoverSharedCompactionPrepares?.();for(const intent of Object.values(this.state.compactions||{}))if(intent.phase==='publishing')await this.run('compaction:'+intent.body.id,()=>this.runtime.finishSharedCompaction(intent));for(const record of Object.values(this.state.requests))if(this.needsRecordReconcile(record)){
  if(record.remote&&!record.steeringV1){await this.steering.refresh(record);continue;}if(record.steeringV1){if(!record.accepted)await this.refresh(record);if(!record.accepted)continue;if(!record.config&&!record.remote){const value=await this.runtime.send(endpoint+'request-config?'+new URLSearchParams({sharedSpaceId:this.runtime.connection.sharedSpaceId,admissionId:record.accepted.id}));record.config=value.config;await this.save();}await this.steering.reconcile(record);continue;}
  if(record.config?.owner.kind==='group'){await this.run(record.sharedId,async()=>{await this.refresh(record);try{if(record.accepted?.groupHandoff){await this.reconcileGroupHandoff(record);return;}if(final.has(record.phase))return;for(const step of record.steps||[])if(step.reply&&!step.accepted&&!isInterruptedGroupReplyPendingReview(record,step))await this.finishStep(record,step);const allAccepted=record.steps?.length===record.accepted.turn.plan.length&&record.steps.every(s=>s.accepted);if(record.groupFinishing||allAccepted)await this.finishGroup(record);}catch(error){if(error.code!=='SHARED_NATIVE_TERMINAL_REQUIRED')throw error;}});}
  else if(record.reply){const mapping=this.runtime.mappings().find(m=>m.sharedId===record.sharedId);if(mapping)await this.complete(record,record.reply,mapping,{recovering:true});}else await this.run(record.sharedId,()=>this.refresh(record));
 }}
 async abandon({descriptor,requestId,workId,confirmed}){
  if(confirmed!==true)throw fail('SHARED_REVIEW_CONFIRMATION_REQUIRED');
  const mapping=this.mapping(descriptor);
  const adopted=typeof workId==='string'&&this.state.requests['group-handoff:'+workId];
  const record=adopted?.adoptGroupWork?adopted:this.state.requests[requestId];
  if(!record?.accepted||record.sharedId!==mapping.sharedId||record.body.requestId!==requestId
   ||workId!==undefined&&record.accepted.id!==workId)throw fail('SHARED_REQUEST_NOT_FOUND');
  const r=this.runtime,isGroupHandoff=groupHandoff.isMode(record.body.controlMode);
  if(isGroupHandoff&&(!workId||descriptor.itemType!=='group'))throw fail('SHARED_REQUEST_NOT_FOUND');
  return this.run(mapping.sharedId,async()=>{
   if(isGroupHandoff){
    const known=await this.refresh(record);
    if(known?.id!==workId||known.requestId!==requestId||known.sharedId!==mapping.sharedId)throw fail('SHARED_REQUEST_NOT_FOUND');
    if(known.groupHandoff?.executor!==groupHandoff.executor(r))throw fail('SHARED_REQUEST_OWNER_REQUIRED');
   }
   const abandoned=await r.send(endpoint+'abandon',{body:{sharedSpaceId:r.connection.sharedSpaceId,admissionId:record.accepted.id,opId:'desktop-abandon_'+record.accepted.id,confirm:true}});
   record.phase='abandoned';this.freshAdmissions.delete(record.accepted.id);
   if(record.serverSession){
    const known=await this.query(record);if(known.request)record.accepted=known.request;record.serverProjectionPending=true;
    await r.sessions.persist(record);await r.sessions.project(record,mapping);return {success:true};
   }
   if(abandoned.request?.id===record.accepted.id)record.accepted={...record.accepted,...abandoned.request};
   await this.save();await this.refresh(record);return {success:true};
  });
 }
 localInputs(d){return Object.values(this.state.requests).filter(v=>v.descriptor&&stable(v.descriptor)===stable(d)&&v.localMessage&&v.phase!=='input_applied'&&!groupHandoff.isMode(v.body?.controlMode)&&((this.state.localInputs[v.localMessage.id]&&v.accepted)||(v.projection&&v.projection.state!=='saved')||(!v.accepted&&(!final.has(v.phase)||v.rejected))||v.isSteeringInput)).sort((a,b)=>(a.localInputSeq||0)-(b.localInputSeq||0)).map(v=>({inputId:v.localMessage.id,content:v.localMessage.content,attachments:(v.localMessage.attachments||[]).map(a=>({name:a.name,size:a.size,type:a.type})),phase:v.phase,accepted:Boolean(v.accepted),projectionPending:Boolean(v.serverProjectionPending||v.projection&&v.projection.state!=='saved'),received:Boolean(v.inputReceipt||v.accepted),submissionUnconfirmed:Boolean(v.admitStarted&&!v.accepted&&!v.rejected),errorCode:v.failureCode||v.rejected||(!v.accepted&&!v.admitStarted&&this.state.localInputs[v.localMessage.id]?.submissionErrorCode)||null,modelSaveRef:v.modelSaveRef||v.steeringBody?.modelSaveRef||null,parentInputId:v.parentLocalInputId||null,targetFinished:v.targetFinished===true}));}
 async status(d,{refresh=true}={}){
  const r=this.runtime;let mapping,queryError=null,queried=false;
  try{mapping=this.mapping(d);}catch(error){queryError=error.code||'SHARED_LOCAL_MAPPING_PENDING';}
  if(refresh&&mapping){try{if(r.capabilities.features?.includes('shared-topic-history-v1')&&(d.itemType||'agent')==='agent'){await this.steering.active(d);queried=true;}await this.reconcile();this.lastStatus||=new Map();if(queried)this.lastStatus.set(stable(d),Date.now());}catch(error){queryError=error.code||'EXECUTION_STATUS_UNAVAILABLE';}}
  const executions=Object.values(this.state.requests).filter(v=>(mapping?v.sharedId===mapping.sharedId:stable(v.descriptor)===stable(d))&&!v.isSteeringInput&&v.accepted).sort((a,b)=>(b.accepted?.userSeq??(final.has(b.phase)?0:Number.MAX_SAFE_INTEGER))-(a.accepted?.userSeq??(final.has(a.phase)?0:Number.MAX_SAFE_INTEGER))).map(v=>({id:v.accepted?.id,requestId:v.body.requestId,controlMode:v.accepted.turn?.controlMode,steering:v.control,outcome:v.generations?.find(g=>g.generation===(v.currentGeneration||0))?.replyIntent?.finishReason||v.reply?.finishReason,errorCode:v.generations?.find(g=>g.generation===(v.currentGeneration||0))?.errorCode||v.errorCode,model:v.generations?.find(g=>g.generation===(v.currentGeneration||0))?.config?.owner?.config?.model||v.config?.owner?.config?.model,canHandoff:Boolean(v.steeringV1&&v.control?.executor!=='desktop:'+r.connection.deviceId&&!final.has(v.phase)),replyMessageId:v.generations?.find(g=>g.generation===(v.currentGeneration||0)&&g.replyAccepted)?.requestId,state:v.phase==='review_required'?'review_required':v.phase==='background'?'background':v.control?.applicationState==='awaiting_native_task'?'running':v.phase==='steering'||v.control?.safeToolBoundary?'steering':v.phase==='completed'?'completed':v.phase==='abandoned'?'cancelled':v.serverSession&&v.accepted?.dispatched?'dispatched':v.accepted?.dispatched?((this.liveGroups.has(v.accepted.id)||v.accepted.nativeRequests?.some(n=>n.state==='dispatched'))?'running':'review_required'):v.accepted?'queued':'preparing',canResume:!v.remote&&!v.serverSession&&!final.has(v.phase)&&!v.accepted?.dispatched&&(v.accepted?.nativeRequests||[]).every(n=>n.state==='prepared'),interruptedGroupReplies:interruptedGroupReplies(v),retainedReplies:(v.generations||[v]).filter(s=>s.localFailure).map(s=>({requestId:s.requestId||'reply_'+v.accepted.id,message:s.localFailure,disposition:s.failureDisposition||'unknown'})),shared:true,executionHost:v.serverSession?'shared-backend':'native-desktop',timings:v.timings||{},nativePhases:(v.accepted?.nativeRequests||[]).map(n=>({requestId:n.id,phases:n.phases||{}})),phase:v.phase,canAbandon:!final.has(v.phase)&&Boolean(v.accepted)&&(v.serverSession?!v.remote&&(v.accepted.state==='review_required'||!v.accepted.dispatched):(v.accepted.state==='review_required'||!v.accepted.dispatched||v.accepted.nativeRequests?.every(n=>['unknown','model_terminal','prepared'].includes(n.state)))),nativeTasks:v.accepted?.nativeTasks||[],toolInvocations:v.accepted?.toolInvocations||[]})),localInputs=this.localInputs(d),observedAt=this.lastStatus?.get(stable(d))||Math.max(0,...Object.values(this.state.requests).filter(v=>stable(v.descriptor)===stable(d)).map(v=>v.observedAt||v.timings?.accepted||0))||null;
  const reportJobs=r.sessions?.reportJobs?.(mapping?.sharedId)||[];
  return {enabled:true,readOnly:false,localInputs,topic:{ownerType:d.itemType||'agent',ownerId:d.itemId,topicId:d.topicId},freshness:queried&&!queryError?'current':observedAt?'last-known':'unavailable',connection:queryError?(queryError==='NETWORK_UNAVAILABLE'?'offline':'error'):'online',observedAt,...(queryError?{error:{code:queryError}}:{}),local:{pendingInputs:localInputs.filter(v=>!v.received).length,pendingOperations:0,blockedOperations:0,pendingLocalCommit:Object.values(this.state.compactions||{}).some(v=>v.phase==='publishing'&&stable(v.descriptor)===stable(d))||Object.values(this.state.requests).some(v=>mapping&&v.sharedId===mapping.sharedId&&(v.phase==='publishing'||v.serverProjectionPending||v.replyProjectionPending&&!replyRecoveryHold(v.accepted)||v.projection&&v.projection.state!=='saved'))},executions,total:executions.length,reportJobs,displayJobs:sharedTaskList(executions,reportJobs)};
 }


 groupStep(record,memberId){
  const ordinal=record.accepted.groupHandoff?.nextOrdinal??(record.steps||[]).filter(s=>s.accepted).length;
  if(record.accepted.turn.plan[ordinal]!==memberId)throw fail('SHARED_GROUP_PLAN_CHANGED');
  return {id:'group_'+record.accepted.id+'_'+ordinal,ordinal,memberId};
 }
 async prepareGroupNative(record,memberId,body){
  this.runtime.assertSharedAccess?.();
  return this.run(record.sharedId,async()=>{
   const known=await this.refresh(record);if(!known||['abandoned','completed','review_required'].includes(known.state))throw fail('SHARED_RESULT_REQUIRES_REVIEW');
   const slot=this.groupStep(record,memberId);record.steps||=[];
   const controlled=known.groupHandoff;
   if(controlled&&(controlled.executor!==groupHandoff.executor(this.runtime)||!groupHandoff.canDispatch(known,slot.ordinal)))throw fail('SHARED_RESULT_REQUIRES_REVIEW');
   if(slot.id!==body.requestId)throw fail('SHARED_GROUP_PLAN_CHANGED');
   let step=record.steps.find(s=>s.ordinal===slot.ordinal);if(!step){step={...slot,body:JSON.parse(JSON.stringify(body))};record.steps.push(step);await this.save();}
   if(step.id!==body.requestId||step.memberId!==memberId)throw fail('SHARED_GROUP_PLAN_CHANGED');
   if(known.nativeRequests.some(n=>n.id!==step.id&&n.state!=='model_terminal')||known.nativeRequests.some(n=>n.id===step.id&&n.state!=='prepared'))throw fail('SHARED_RESULT_REQUIRES_REVIEW');
   await this.runtime.send(endpoint+'native-request',{body:{sharedSpaceId:this.runtime.connection.sharedSpaceId,admissionId:record.accepted.id,requestId:step.id,memberId,bodyHash:sha256(stable(step.body))}});
   if(this.runtime.closed)throw fail('APPLICATION_SHUTTING_DOWN');record.phase='dispatching';await this.save();this.runtime.assertSharedAccess?.();return {body:step.body,headers:{...require('./runtime').syncHeaders(this.runtime.connection),'X-NativeSync-Capabilities':'shared-space-v1'+(controlled?','+known.turn.controlMode:''),'X-NativeSync-Admission':record.accepted.id}};
  });
 }
 async groupReply(record,message){
  return this.run(record.sharedId,async()=>{
   const handoff=record.accepted.groupHandoff;
   if(handoff&&(message.finishReason==='failed'||message.errorCode&&message.finishReason!=='interrupted'))throw fail('SHARED_GROUP_RESULT_UNCONFIRMED');
   const step=(record.steps||[]).find(s=>'reply_'+s.id===message.id);if(!step)throw fail('INVALID_SHARED_REPLY');
   const mapping=this.runtime.mappings().find(m=>m.sharedId===record.sharedId),raw={...message,agentId:step.memberId,groupId:record.config.owner.id};
   const ids=[...new Set((step.body.vcpchatExtensions?.messageTimestampBindings||[]).map(m=>m.messageId).filter(Boolean))];
   raw.continuity={version:1,known:ids.length>0&&ids.length<=1000,requestId:step.id,executionId:record.accepted.id,dependsOnMessageIds:ids.length<=1000?ids:[]};
   if(raw.avatarUrl?.startsWith('file:'))delete raw.avatarUrl;
   const value=this.runtime.adapter.canonical(raw,mapping.shared.topicId);
   if(step.reply&&stable(step.reply)!==stable(value))throw fail('SHARED_REPLY_INTENT_CHANGED');
   step.reply=value;record.phase='publishing';await this.save();
   if(handoff&&value.finishReason==='interrupted'){
    await this.refresh(record);
    throw fail('SHARED_GROUP_RESULT_UNCONFIRMED');
   }
   try{await this.finishStep(record,step);}
   catch(error){
    if(value.finishReason==='interrupted'&&error.code==='SHARED_NATIVE_TERMINAL_REQUIRED'){
     try{
      await this.refresh(record);
      if(interruptedGroupReplies(record).length)this.runtime.notifyExecutionStatus({
       topic:{ownerType:'group',ownerId:record.descriptor.itemId,topicId:record.descriptor.topicId}
      });
     }catch{/* The existing durable partial remains available after reconciliation. */}
    }
    throw error;
   }
   await this.runtime.syncExecutionTopic(mapping);return this.runtime.replica.queue.read(mapping.shared);
  });
 }
 async finishStep(record,step){
  const result=await this.runtime.send(endpoint+'complete',{body:{sharedSpaceId:this.runtime.connection.sharedSpaceId,admissionId:record.accepted.id,opId:'desktop-step_'+step.id,nativeRequestId:step.id,message:step.reply}});
  if(result.request?.groupHandoff){
   if(result.replayed){
    if(!await this.refresh(record))throw fail('SHARED_GROUP_RESULT_UNCONFIRMED');
   }else record.accepted={...record.accepted,...result.request};
  }
  step.accepted=true;
  record.phase=final.has(record.accepted.state)?record.accepted.state:'accepted';
  record.timings??={};record.timings.accepted=Date.now();
  await this.save();
 }
 async reconcileGroupHandoff(record){
  const request=record.accepted,control=request.groupHandoff,r=this.runtime;
  const owned=control.executor===groupHandoff.executor(r);
  for(const step of record.steps||[]){
   if(step.accepted||!step.reply||['failed','interrupted'].includes(step.reply.finishReason))continue;
   if(groupHandoff.confirmedReplies(record.accepted)[step.ordinal]){
    step.accepted=true;await this.save();continue;
   }
   const current=record.accepted.groupHandoff;
   if(owned&&current.state===(step.ordinal===0?'first_member':'continuing')&&current.nextOrdinal===step.ordinal
    &&request.nativeRequests?.some(native=>native.id===step.id&&native.state==='model_terminal')){
    await this.finishStep(record,step);
   }
  }
  const latest=record.accepted;
  if(owned&&latest.turn.controlMode===groupHandoff.capability&&
   !final.has(latest.state)&&latest.groupHandoff.state!=='review_required'&&
   groupHandoff.confirmedReplies(latest).length===latest.turn.plan.length){
   const mapping=r.mappings().find(value=>value.sharedId===record.sharedId);
   if(mapping)await r.syncExecutionTopic(mapping,{minSeq:latest.replySeq});
   await this.finishGroup(record);
  }
 }
 async finishGroup(record){
  await this.runtime.send(endpoint+'complete',{body:{sharedSpaceId:this.runtime.connection.sharedSpaceId,admissionId:record.accepted.id,opId:'desktop-finish_'+record.accepted.id,finish:true}});
  record.phase='completed';await this.save();
 }
 async groupDone(record){record.groupFinishing=true;await this.save();return this.run(record.sharedId,()=>this.finishGroup(record));}
 loadNativeBody(record){return this.bodyArchive.load(record);}
 canArchiveBody(record){return bodyArchiveEligible(record)&&!this.projectionTasks.has(record.body.requestId)&&!this.liveGroups.has(record.accepted.id);}
 async archiveNativeBody(record){
  if(!this.canArchiveBody(record))return false;
  const body=record.nativeBody,ref=await this.bodyArchive.write(record);
  if(!this.canArchiveBody(record)||record.nativeBody!==body)return false;
  const version=this.state.version;record.nativeBodyRef=ref;delete record.nativeBody;this.state.version=3;
  try{await this.save();return true;}
  catch(error){record.nativeBody=body;delete record.nativeBodyRef;if(!Object.values(this.state.requests).some(r=>r.nativeBodyRef))this.state.version=version;throw error;}
 }
 scheduleNativeBodyArchive(record){
  if(!this.nativeBodyArchivalEnabled||this.runtime.readOnly||this.runtime.closed||!this.canArchiveBody(record))return;
  const key=record.body.requestId;if(this.archiveTasks.has(key))return;
  // The successful reply's durable save is already complete. This optional
  // optimization may not change that result or invoke a model on failure.
  const task=new Promise(resolve=>setImmediate(resolve)).then(()=>this.run(record.sharedId,()=>this.archiveNativeBody(record))).catch(error=>{this.archiveError=error.code||'SHARED_NATIVE_BODY_ARCHIVE_FAILED';return false;});
  this.archiveTasks.set(key,task);task.finally(()=>{if(this.archiveTasks.get(key)===task)this.archiveTasks.delete(key);}).catch(()=>{});
 }
 async compactNativeBodies(){
  if(this.runtime.readOnly)throw fail('SHARED_READ_ONLY');
  if(this.tails.size||this.projectionTasks.size||this.archiveTasks.size)throw fail('SHARED_EXECUTION_BUSY');
  // Offline/explicit batch only: write all immutable bodies, then one ledger.
  // The caller owns normal application exit and its launcher/install lock.
  const staged=[];
  for(const record of Object.values(this.state.requests))if(this.canArchiveBody(record))staged.push({record,body:record.nativeBody,ref:await this.bodyArchive.write(record)});
  const version=this.state.version,changed=[];
  for(const item of staged)if(this.canArchiveBody(item.record)&&item.record.nativeBody===item.body){item.record.nativeBodyRef=item.ref;delete item.record.nativeBody;changed.push(item);}
  if(changed.length){this.state.version=3;try{await this.save();}catch(error){for(const item of changed){item.record.nativeBody=item.body;delete item.record.nativeBodyRef;}if(!Object.values(this.state.requests).some(r=>r.nativeBodyRef))this.state.version=version;throw error;}}
  return {archived:changed.length,archivedBodyBytes:changed.reduce((n,v)=>n+v.ref.bodyBytes,0),version:this.state.version};
 }
 async close(){await Promise.allSettled([...this.tails.values()]);await Promise.allSettled([...this.archiveTasks.values()]);await Promise.allSettled([...this.projectionTasks.values()]);await Promise.allSettled([this.inputDisk,this.disk]);if(this.savedProjectionRevision!==this.projectionRevision)await Promise.allSettled([this.save()]);}
}
module.exports={SharedExecution,blocksExecution,executionConfig};

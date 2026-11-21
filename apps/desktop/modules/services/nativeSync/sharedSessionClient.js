'use strict';
const {stable,sha256,fail}=require('./protocol');
const endpoint='/api/v1/sync/shared/';
const terminal=new Set(['completed','abandoned','failed','cancelled','review_required']);
const pause=(ms,signal)=>new Promise(resolve=>{if(signal.aborted)return resolve();const finish=()=>{clearTimeout(timer);signal.removeEventListener('abort',finish);resolve();};const timer=setTimeout(finish,ms);signal.addEventListener('abort',finish,{once:true});});

function projectsSameTerminal(record, request){
 const saved=record?.accepted;
 return Boolean(saved&&request&&terminal.has(request.state)&&record.serverProjectionPending===false&&
  record.phase===request.state&&saved.state===request.state&&saved.id===request.id&&
  saved.requestId===request.requestId&&saved.userMessageId===request.userMessageId&&
  (saved.replyMessageId??null)===(request.replyMessageId??null)&&
  saved.userSeq===request.userSeq&&(saved.replySeq??null)===(request.replySeq??null));
}

function createSharedEventRequest(connection){
 return async(query,{signal}={})=>{
  const {syncHeaders}=require('./runtime');
  return fetch(connection.url+endpoint+'session-events?'+new URLSearchParams(query),{headers:{...syncHeaders(connection),Authorization:`Bearer ${connection.token}`,'X-NativeSync-Protocol':'2','X-NativeSync-Capabilities':'shared-space-v1,shared-session-v1,shared-events-v1,shared-report-list-v1'},redirect:'error',cache:'no-store',signal});
 };
}

// The existing execution ledger owns durable submit/receipt intents. This class
// only coordinates that ledger with the server-owned executor and observation.
class SharedSessionClient{
 constructor(runtime,{openEvents}={}){this.runtime=runtime;this.openEvents=openEvents;this.observers=new Map();this.topicObservers=new Map();this.projections=new Map();this.contexts=new Map();this.warming=new Map();this.closed=false;this.store=runtime.execution.sessionStore||new(require('./sharedSessionStore').SharedSessionStore)(runtime);this.activeByTopic=new Map();this.activeRecords=new Set();this.byExecution=new Map();this.byRequest=new Map();for(const record of Object.values(runtime.execution.state.requests))this.index(record);}
 index(record){
  const key=record.body?.requestId||record.localMessage?.id||record.accepted?.id,old=key&&this.byRequest.get(key);if(old&&old!==record){this.activeRecords.delete(old);this.activeByTopic.get(old.sharedId)?.delete(old);}if(key)this.byRequest.set(key,record);
  if(record.accepted?.id&&record.serverSession)this.byExecution.set(record.accepted.id,record);
  if(record.sharedId){let records=this.activeByTopic.get(record.sharedId);if(!records){records=new Set();this.activeByTopic.set(record.sharedId,records);}if(!['completed','abandoned','local_pending'].includes(record.phase))records.add(record);else records.delete(record);}
  if(record.serverSession&&(record.admitStarted||record.accepted)&&(!terminal.has(record.phase)||record.serverProjectionPending))this.activeRecords.add(record);else this.activeRecords.delete(record);
 }
 async persist(record){await this.store.save(record);this.index(record);}
 preview(record,mapping,{validateOnly=false}={}){
  const saved=record.partialPreview,p=saved?.partialResult;
  if(!p||!validateOnly&&(record.phase!=='review_required'||record.accepted?.state!=='review_required'))return null;
  if(p.version!==1||p.kind!=='length'||p.finishReason!=='length'||p.committed!==false||p.source!=='pending_operation'
   ||p.executionId!==record.accepted?.id||p.sharedSpaceId!==this.runtime.connection.sharedSpaceId||p.sharedId!==mapping.sharedId
   ||p.requestId!==record.body.requestId||p.userMessageId!==record.localMessage.id||p.userMessageId!==record.body.message.id
   ||p.messageId!=='reply_'+record.accepted.id||typeof saved.text!=='string'||sha256(saved.text)!==p.contentHash
   ||saved.request?.id!==p.executionId||saved.request.state!=='review_required'||saved.native?.id!==p.executionId||saved.native.state!=='review_required')throw fail('SHARED_EVENT_PARTIAL_INVALID');
  return {...saved,executionId:p.executionId,sharedId:p.sharedId,sharedSpaceId:p.sharedSpaceId,generation:0,
   offset:saved.text.length,gap:false,connection:'retained',projectionSynced:false,persistentPreview:true};
 }
 retainPartial(record,mapping,projection){
  if(!projection.partialResult)return;
  const next={partialResult:projection.partialResult,text:projection.text,request:projection.request,native:projection.native};
  const prior=record.partialPreview;record.partialPreview=next;
  try{this.preview(record,mapping,{validateOnly:true});if(prior&&(stable(prior.partialResult)!==stable(next.partialResult)||prior.text!==next.text))throw fail('SHARED_EVENT_PARTIAL_CONFLICT');}
  catch(error){record.partialPreview=prior;throw error;}
 }
 enabled(){return this.runtime.capabilities.features?.includes('shared-session-v1')===true;}
 async warm(descriptor,{forceFresh=false}={}){
  if(!this.enabled()||this.closed||this.runtime.readOnly)return;
  const r=this.runtime,mapping=r.execution.mapping(descriptor);if(mapping.shared.itemType!=='agent')return;
  if(this.warming.has(mapping.sharedId))return this.warming.get(mapping.sharedId);
  const task=(async()=>{const context=await r.refreshForExecution(descriptor,{forceFresh,sharedSessionHistory:true});const history=context.executionHistory||await r.verifyHistory(mapping);this.contexts.set(mapping.sharedId,{...context,history,revision:r.replica.queue.revision(history)});return context;})();
  this.warming.set(mapping.sharedId,task);try{return await task;}finally{this.warming.delete(mapping.sharedId);}
 }
 async context(descriptor,mapping){
  const r=this.runtime,old=this.contexts.get(mapping.sharedId);
  if(old&&Array.isArray(old.dependencies)&&r.state.baselines[mapping.sharedId]?.complete){
   let current=true;
   for(const dep of old.dependencies){const metadata=r.state.objects[dep.id],known=r.configs.state.objects[dep.id];if(!metadata||!known||known.version!==dep.version||known.hash!==dep.configHash){current=false;break;}await r.configs.scanNative(metadata);if(require('./sharedExecution').blocksExecution(r,dep.id))throw fail('SHARED_CONFIG_CONFLICT');}
   if(current){const history=await r.verifyHistory(mapping);if(r.replica.queue.revision(history)===old.revision)return {...old,history};}
  }
  await this.warm(descriptor);const value=this.contexts.get(mapping.sharedId);if(!value)throw fail('SHARED_CONFIG_PENDING');return value;
 }
 async prepare(descriptor,message,options={}){
  const r=this.runtime,e=r.execution,mapping=e.mapping(descriptor);
  if(!this.enabled()||mapping.shared.itemType!=='agent'||message.attachments?.length||options.kind&&options.kind!=='message'||options.parentInputId||options.deferReady)return null;
  return e.run(mapping.sharedId,async()=>{
   const existing=e.state.requests[message.id];
   if(existing?.serverSession&&existing.accepted)return this.accepted(existing,mapping);
   const held=[...(this.activeByTopic.get(mapping.sharedId)||[])].filter(v=>v.body?.requestId!==message.id&&!['completed','abandoned','local_pending'].includes(v.phase));
   for(const old of held)if(old.accepted&&old.serverSession){const response=await e.query(old);if(response.request){old.accepted=response.request;old.phase=response.request.state;await this.persist(old);}}
   if(held.some(v=>!['completed','abandoned','local_pending'].includes(v.phase)))throw fail('SHARED_TOPIC_BUSY');
   const resuming=existing?.serverSession&&existing.admitStarted&&!existing.rejected;
   const context=resuming?null:await this.context(descriptor,mapping);
   const desktopOnly=value=>/\{\{VCPChat(?:Canvas|WorkSpace)(?::[^{}]*)?\}\}/.test(value||'');
   if(context){
    // The physical History stays whole. Only the server knows each message's
    // first Journal position, including messages edited after the checkpoint.
    const desktopHistory=context.desktopHistoryRequired??context.history.some(m=>m.desktopReferences?.length||desktopOnly(m.content));
    if(desktopHistory||context.desktopConfigRequired||message.desktopReferences?.length||desktopOnly(message.content)||context.dependencies.some(dep=>desktopOnly(r.configs.state.objects[dep.id]?.config?.systemPrompt)))return null;
   }
   let record=existing;
   if(!record?.serverSession||record.rejected){
    const body={sharedSpaceId:r.connection.sharedSpaceId,sharedId:mapping.sharedId,...require('./sharedTopicSponsor').topicSponsorRouteBinding(r,mapping),requestId:message.id,expectedHead:context.head,configHash:context.hash,message:r.adapter.canonical(message,mapping.shared.topicId),...Object.fromEntries(['modelSaveRef','modelSaveResolutionRef'].filter(key=>options[key]).map(key=>[key,options[key]]))};
    record={...(existing||{}),attempt:(existing?.attempt||0)+1,serverSession:true,rejected:undefined,executionDependencies:context.dependencies,acceptedModel:context.model,descriptor:{...descriptor},sharedId:mapping.sharedId,localMessage:structuredClone(message),signature:sha256(stable({content:message.content,attachments:message.attachments||[]})),phase:'preparing',admitStarted:true,body};e.state.requests[message.id]=record;
   }else if(stable(record.localMessage)!==stable(message))throw fail('SHARED_LOCAL_INTENT_CHANGED');
   await this.persist(record);
   try{record.accepted=await r.send(endpoint+'session-send',{body:record.body});}
   catch(error){
    if(['DESKTOP_CONTEXT_REQUIRED','SHARED_SESSION_SINGLE_REQUIRED','SHARED_CONTEXT_CHANGED','SHARED_TOPIC_BUSY','SHARED_CONFIG_PENDING','MODEL_SAVE_NOT_CURRENT'].includes(error.code)){record.phase='local_pending';record.admitStarted=false;record.rejected=error.code;if(error.code==='SHARED_CONTEXT_CHANGED'){this.contexts.delete(mapping.sharedId);this.warm(descriptor,{forceFresh:true}).catch(()=>{});}}
    await this.persist(record);throw error;
   }
   record.phase='accepted';record.observedAt=Date.now();record.timings={...(record.timings||{}),accepted:record.observedAt};record.serverProjectionPending=true;await this.persist(record);
   return this.accepted(record,mapping,context?.history);
  });
 }
 async accepted(record,mapping,history){
  this.watch(mapping,record.accepted.id);this.project(record,mapping).catch(()=>{});
  const rows=history||this.contexts.get(mapping.sharedId)?.history||await this.runtime.replica.queue.read(mapping.shared);
  return {handled:true,success:true,admissionId:record.accepted.id,replyId:'reply_'+record.accepted.id,userMessage:record.localMessage,history:rows.some(m=>m.id===record.localMessage.id)?rows:[...rows,record.localMessage],projectionPending:true,serverSession:{executionId:record.accepted.id}};
 }
 project(record,mapping,{minSeq=record?.accepted?.userSeq||0,completed=false,request=record?.accepted,settledReplay=false}={}){
  const key=mapping.sharedId,previous=this.projections.get(key)||Promise.resolve();
  const task=previous.catch(()=>{}).then(async()=>{
   const r=this.runtime;if(this.closed||r.closed)return;
   // A replay of an already projected terminal still verifies physical History
   // through the native queue. Only a failed verification reopens recovery.
   const recheck=settledReplay&&projectsSameTerminal(record,request);
   try{await r.syncExecutionTopic(mapping,{minSeq});
    if(recheck){await r.execution.consumeInputs([record.body.requestId]);}
    else if(record){record.serverProjectionPending=true;if(completed)record.phase='completed';await this.persist(record);await r.execution.consumeInputs([record.body.requestId]);record.serverProjectionPending=false;await this.persist(record);}
   }catch(error){
    if(recheck&&projectsSameTerminal(record,request)){record.serverProjectionPending=true;await this.persist(record);}
    throw error;
   }
   // Completion receipts do not prove the current topic context: a peer may
   // append or edit while projection yields. Refresh through the existing API.
   this.contexts.delete(key);
   if(completed&&record?.accepted?.id){const observer=this.observers.get(record.accepted.id);if(observer)observer.projectionSynced=true;}this.notify(mapping,record?.accepted?.id,{projectionSynced:completed});
  }).finally(()=>{if(this.projections.get(key)===task)this.projections.delete(key);});
  this.projections.set(key,task);return task;
 }
 notify(mapping,executionId,extra={}){
  const observer=executionId&&this.observers.get(executionId),record=executionId&&this.byExecution.get(executionId),session=observer?.projection?.value()||(record&&this.preview(record,mapping));
  try{this.runtime.notifyExecutionStatus?.({enabled:true,readOnly:false,topic:{ownerType:mapping.local.itemType||'agent',ownerId:mapping.local.itemId,topicId:mapping.local.topicId},serverSession:{...session,...extra,executionId,canCancel:Boolean(record?.serverSession&&!record.remote&&!this.runtime.readOnly&&this.runtime.capabilities.features?.includes('shared-session-cancel-v1'))}});}catch{}
 }
 reportJobs(sharedId){return this.topicObservers.get(sharedId)?.reportJobs||[];}
 updateReports(entry,mapping,reports=[]){
  const validId=id=>typeof id==='string'&&/^[a-zA-Z0-9_.:-]{1,160}$/.test(id);
  const validTask=task=>validId(task?.nativeTaskId)&&validId(task.invocationId)&&
   typeof task.agentBaseName==='string'&&task.agentBaseName.length<=160;
  const validJob=job=>validId(job?.id)&&validId(job.requestId)&&Number.isSafeInteger(job.attempts)&&job.attempts>=0&&
   Array.isArray(job.tasks)&&job.tasks.length>0&&job.tasks.length<=64&&job.tasks.every(validTask);
  // A malformed optional catalogue cannot interrupt live work discovery.
  const list=Array.isArray(reports)&&reports.length<=5&&reports.every(validJob)?reports:[];
  const jobs=list.map(job=>({
   id:job.id,requestId:job.requestId,attempts:job.attempts,state:'completed',
   nativeTasks:job.tasks.map(task=>({nativeTaskId:task.nativeTaskId,invocationId:task.invocationId,
    agentBaseName:task.agentBaseName,state:'completed',resultRef:{kind:'AgentAssistantArchive',nativeTaskId:task.nativeTaskId}}))
  }));
  if(stable(entry.reportJobs||[])===stable(jobs))return;
  entry.reportJobs=jobs;
  this.runtime.notifyExecutionStatus?.({topic:{ownerId:mapping.local.itemId,ownerType:mapping.local.itemType||'agent',topicId:mapping.local.topicId},reportListChanged:true});
 }
 watchTopic(mapping){
  if(!this.openEvents||this.closed||this.topicObservers.has(mapping.sharedId))return;
  if(this.topicObservers.size>=8){const [id,old]=this.topicObservers.entries().next().value;old.controller.abort();this.topicObservers.delete(id);}
  const controller=new AbortController(),entry={controller,ready:false,task:null,discovered:new Set()};this.topicObservers.set(mapping.sharedId,entry);
  entry.task=(async()=>{
   const {consumeSharedEvents}=await import('./sharedEventClient.mjs');let attempts=0;
   while(!controller.signal.aborted&&!this.closed){
    try{
     const response=await this.openEvents({scope:'topic',sharedSpaceId:this.runtime.connection.sharedSpaceId,sharedId:mapping.sharedId},{signal:controller.signal});
     await consumeSharedEvents(response,event=>{
      if(event.sharedId!==mapping.sharedId||event.sharedSpaceId!==this.runtime.connection.sharedSpaceId||!['topic_ready','work'].includes(event.type))throw fail('SHARED_EVENT_IDENTITY_MISMATCH');
      if(controller.signal.aborted)return;
      attempts=0;entry.ready=true;
      if(event.type==='topic_ready')this.updateReports(entry,mapping,event.reports);
      if(event.type==='work'){if(typeof event.executionId!=='string'||!/^[a-zA-Z0-9_-]{1,96}$/.test(event.executionId))throw fail('SHARED_EVENT_IDENTITY_MISMATCH');entry.discovered.add(event.executionId);if(entry.discovered.size>128)entry.discovered.delete(entry.discovered.values().next().value);this.watch(mapping,event.executionId);}
     },{signal:controller.signal});
    }catch(error){
     if(controller.signal.aborted||this.closed)break;entry.ready=false;
     if(['SHARED_EVENT_PERMISSION_REQUIRED','SHARED_EVENT_IDENTITY_MISMATCH'].includes(error.code)){this.updateReports(entry,mapping,[]);break;}
     await pause(Math.min(10000,250*2**Math.min(attempts++,5)),controller.signal);
    }
   }
  })().catch(()=>{}).finally(()=>{if(this.topicObservers.get(mapping.sharedId)===entry)this.topicObservers.delete(mapping.sharedId);});
 }
 watch(mapping,executionId){
  if(!this.openEvents||this.closed)return;
  // The submitting desktop already renders this native Group work. Only its
  // peers need the separate observation view; neither path gains dispatch rights.
  if(mapping.shared.itemType==='group'&&Object.values(this.runtime.execution.state.requests).some(record=>!record.remote&&!record.serverSession&&record.sharedId===mapping.sharedId&&record.accepted?.id===executionId))return;
  const prior=this.observers.get(executionId);
  if(prior&&!prior.controller.signal.aborted&&!(terminal.has(prior.projection?.request?.state)&&!prior.boundRecord))return;
  if(prior){prior.controller.abort();this.observers.delete(executionId);}
  const controller=new AbortController(),entry={controller,projection:null,task:null};this.observers.set(executionId,entry);
  entry.task=(async()=>{
   const {SharedEventProjection,consumeSharedEvents}=await import('./sharedEventClient.mjs');entry.projection=new SharedEventProjection({executionId,sharedId:mapping.sharedId,sharedSpaceId:this.runtime.connection.sharedSpaceId});
   let attempts=0;
   while(!controller.signal.aborted&&!this.closed){
    const p=entry.projection;
    try{
     const query={sharedSpaceId:this.runtime.connection.sharedSpaceId,sharedId:mapping.sharedId,executionId,...(p.epoch?{epoch:p.epoch,after:String(p.seq)}:{})};
     const response=await this.openEvents(query,{signal:controller.signal});
     await consumeSharedEvents(response,async event=>{
      if(controller.signal.aborted)return;
      const finalRecord=this.byExecution.get(executionId);
      if(event.type==='snapshot'&&['completed','abandoned'].includes(finalRecord?.phase)&&event.request?.state!==finalRecord.phase){controller.abort();return;}
      await p.apply(event);attempts=0;
      // Hash checks yield. An explicit owner settlement may finish while that
      // snapshot is in flight; never overwrite its already accepted terminal.
      const settledRecord=this.byExecution.get(executionId);
      if(event.type==='snapshot'&&['completed','abandoned'].includes(settledRecord?.phase)&&event.request?.state!==settledRecord.phase){controller.abort();return;}
      const state=p.request?.state,record=this.byExecution.get(executionId);
      const settledReplay=event.type==='snapshot'&&projectsSameTerminal(record,p.request);
      if(event.type==='snapshot'&&record){
       this.retainPartial(record,mapping,p.value());record.accepted={...record.accepted,...p.request};record.observedAt=Date.now();if(state!=='completed')record.phase=state;if(terminal.has(state)&&!settledReplay)record.serverProjectionPending=true;await this.persist(record);
      }
      this.notify(mapping,executionId);
      if(event.type==='snapshot'&&terminal.has(state)&&(state!=='review_required'||['completed','review_required','failed','cancelled'].includes(p.native?.state))){
       entry.boundRecord=Boolean(record);
       await this.project(record,mapping,{minSeq:p.request?.replySeq||p.request?.userSeq||0,completed:state==='completed',request:p.request,settledReplay});
       this.notify(mapping,executionId,{projectionSynced:state==='completed'||state==='abandoned'});controller.abort();
      }else if(['completed','failed','cancelled','review_required'].includes(event.type)||event.type==='state'&&terminal.has(event.payload?.state)){
       // A terminal hint prompts a fresh authoritative snapshot. It never
       // commits a result or starts another execution.
       p.epoch=null;throw fail('SHARED_EVENT_TERMINAL_REFRESH');
      }
     },{signal:controller.signal});
    }catch(error){
     if(controller.signal.aborted||this.closed)break;
     if(error.code==='SHARED_EVENT_TERMINAL_REFRESH')continue;
     // A validly framed snapshot may still conflict with this local Work's
     // retained identity/hash. Never notify UI using that rejected projection.
     if(['SHARED_EVENT_PARTIAL_INVALID','SHARED_EVENT_PARTIAL_CONFLICT'].includes(error.code)){controller.abort();break;}
     p.connection='offline';this.notify(mapping,executionId,{errorCode:error.code||'SHARED_EVENT_DISCONNECTED'});
     if(['SHARED_EVENT_PERMISSION_REQUIRED','SHARED_EVENT_IDENTITY_MISMATCH','SHARED_EVENT_PARTIAL_INVALID','SHARED_EVENT_PARTIAL_CONFLICT'].includes(error.code))break;
     // A quiet replay can contain no frames: validate a fresh authoritative
     // snapshot after disconnection before reporting this observer online.
     p.epoch=null;
     await pause(Math.min(10000,250*2**Math.min(attempts++,5)),controller.signal);
    }
   }
  })().catch(()=>{}).finally(()=>{entry.stopped=true;if(this.observers.get(executionId)===entry)this.observers.delete(executionId);});
 }
 async observe(descriptor,{refresh=false}={}){
  if(!this.enabled()||this.closed)return;
  const r=this.runtime,mapping=r.execution.mapping(descriptor);if(!['agent','group'].includes(mapping.shared.itemType))return;
  // Group execution stays with its native desktop owner. The same read-only
  // topic/work stream observes its admission and final Queue projection.
  this.watchTopic(mapping);
  // A remote observer has no local submit record. Topic changes may remove its
  // view; reuse discovered identities to read snapshots, never submit a Work.
  for(const id of this.topicObservers.get(mapping.sharedId)?.discovered||[])this.watch(mapping,id);
  for(const record of this.activeRecords)if(record.sharedId===mapping.sharedId&&record.accepted){if(!terminal.has(record.phase)||record.serverProjectionPending)this.watch(mapping,record.accepted.id);if(record.serverProjectionPending)this.project(record,mapping).catch(()=>{});}
  if(refresh){
   await this.warm(descriptor);
  }
 }
 async reconcile(){
  const r=this.runtime;if(this.closed||!this.enabled())return;
  for(const record of [...this.activeRecords]){
   if(!record.serverSession||terminal.has(record.phase)&&!record.serverProjectionPending)continue;
   if(r.execution.tails.has(record.sharedId))continue;
   const mapping=r.mappings().find(value=>value.sharedId===record.sharedId);if(!mapping)continue;
   if(!record.accepted){const result=await r.execution.query(record);if(!result.request)continue;record.accepted=result.request;record.phase=result.request.state;record.serverProjectionPending=true;await this.persist(record);}
   this.watch(mapping,record.accepted.id);
   if(record.serverProjectionPending)this.project(record,mapping,{minSeq:record.accepted.replySeq||record.accepted.userSeq||0,completed:record.accepted.state==='completed'}).catch(()=>{});
  }
 }
 async waitProjection(descriptor){
  const mapping=this.runtime.execution.mapping(descriptor),pending=this.projections.get(mapping.sharedId);if(pending)await pending;
  for(const record of this.activeRecords)if(record.sharedId===mapping.sharedId&&record.accepted&&record.serverProjectionPending)await this.project(record,mapping,{minSeq:record.accepted.replySeq||record.accepted.userSeq||0,completed:record.accepted.state==='completed'});
 }
 values(descriptor){
  const mapping=this.runtime.execution.mapping(descriptor),values=new Map();
  for(const record of this.byExecution.values())if(record.sharedId===mapping.sharedId){const saved=this.preview(record,mapping);if(saved)values.set(saved.executionId,saved);}
  for(const observer of this.observers.values())if(observer.projection?.sharedId===mapping.sharedId){const live=observer.projection.value();if(!values.has(live.executionId)||live.partialResult||live.request?.state==='completed'||live.request?.state==='abandoned')values.set(live.executionId,{...live,projectionSynced:observer.projectionSynced===true,canCancel:Boolean(this.byExecution.get(live.executionId)?.serverSession&&!this.byExecution.get(live.executionId)?.remote&&!this.runtime.readOnly&&this.runtime.capabilities.features?.includes('shared-session-cancel-v1'))});}
  return [...values.values()];
 }
 async close(){this.closed=true;for(const observer of [...this.observers.values(),...this.topicObservers.values()])observer.controller.abort();await Promise.allSettled([...this.observers.values(),...this.topicObservers.values()].map(v=>v.task));await Promise.allSettled([...this.projections.values(),...this.warming.values()]);this.observers.clear();this.topicObservers.clear();}
}
module.exports={SharedSessionClient,createSharedEventRequest};

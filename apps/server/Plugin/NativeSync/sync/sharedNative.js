'use strict';
const {sha256,stable}=require('./protocol');
const {sharedIdentity}=require('./contracts.generated.cjs');
const fail=(code,status=409)=>Object.assign(Error(code),{code,status});
const NATIVE_INLINE_CAPABILITY='shared-native-inline-v1';

// Admission at the existing VCP HTTP boundary. Execution remains in ToolBox;
// tool/AA observations reuse NativeTaskLinks rather than a second task runner.
class SharedNative {
 constructor(shared,engine){
  this.shared=shared;this.db=shared.db;this.engine=engine;this.closed=false;this.seenPhases=new Set();
  this.continuations=require('../../../modules/nativeContinuationStore.cjs').createNativeContinuationStore(require('node:path').resolve(__dirname,'../../../.state/native-continuations'));
  this.db.exec(`CREATE TABLE IF NOT EXISTS shared_request_phases(work_id TEXT NOT NULL,request_id TEXT NOT NULL,stage TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(request_id,stage));
   CREATE TABLE IF NOT EXISTS shared_native_requests(
   id TEXT PRIMARY KEY,admission_id TEXT NOT NULL,principal TEXT NOT NULL,member_id TEXT,
   body_hash TEXT NOT NULL,state TEXT NOT NULL,ordinal INTEGER NOT NULL,
   UNIQUE(admission_id,ordinal));`);
  this.db.exec('CREATE INDEX IF NOT EXISTS idx_shared_local_context ON shared_local_bindings(kind,local_id,local_parent)');
  this.db.prepare("UPDATE shared_native_requests SET state='unknown' WHERE state='dispatched'").run();
  shared.native=this;
  if(!shared.events||shared.events.closed)shared.events=new (require('./sharedEvents').SharedEvents)(shared,engine);
  this.approvalObserver=event=>{try{const row=this.db.prepare('SELECT admission_id FROM shared_native_requests WHERE id=?').get(event.requestId);if(row)this.engine.emitEvent?.(row.admission_id,'approval',{state:event.waiting?'waiting_approval':'running',nativeRequestId:event.requestId});}catch{/* Observers do not own tool or model execution. */}};
  require('../../../modules/requestExecutionContext').events.on('approval',this.approvalObserver);
  this.taskControls=new (require('./sharedTaskControls').SharedTaskControls)(shared);this.taskRequests=new (require('./sharedTaskRequests').SharedTaskRequests)(this);shared.steering.onInput=(workId)=>{require('../../../modules/requestExecutionContext').interruptWork(workId);return this.taskControls.request(workId);};if(engine?.get&&engine.configs)require('../mobile/groupTurn').recover(engine);
 }
 prepare(actor,body,{session=false}={}){
  if(this.draining||this.closed)throw fail('HOST_DRAINING',503);
  this.shared.authorize(actor,body.sharedSpaceId,'execute');
  if(this.shared.readOnly)throw fail('SHARED_READ_ONLY');
  sharedIdentity(body.requestId);
  if(!/^[a-f0-9]{64}$/.test(body.bodyHash||''))throw fail('INVALID_SHARED_NATIVE_REQUEST',400);
  return this.shared.atomic(()=>{
   const admission=this.shared.admission(actor,body.sharedSpaceId,body.admissionId);
   const turn=require('./sharedTurns').intent(admission);if(turn.steeringCapable&&(turn.controlMode==='text-only-v1'?!require('./releasePolicy.cjs').sharedControlledText:!require('./releasePolicy.cjs').sharedSteering))throw fail('SHARED_STEERING_UNAVAILABLE');
   if(turn.controlMode==='text-only-v1'&&(!Number.isSafeInteger(body.generation)||body.generation<0||!Number.isSafeInteger(body.consumedInputSeq)||body.consumedInputSeq<0))throw fail('INVALID_STEERING_GENERATION');
   if(turn.controlMode==='text-only-v1'){const current=this.shared.steering.control(admission),frozen=this.shared.steering.generation(admission.id,body.generation);if(current.executor!==actor.principal)throw fail('WORK_EXECUTOR_HANDOFF_REQUIRED');if(!frozen||frozen.executor!==actor.principal||frozen.request_id!==body.requestId||frozen.consumed_seq!==body.consumedInputSeq||current.generation!==body.generation)throw fail('INVALID_STEERING_GENERATION');this.shared.steering.fence(admission.id,body.generation,actor.principal);}
   if(this.engine.get?.(admission.id)?.kind==='shared_session'&&!session)throw fail('SHARED_SESSION_DISPATCH_ONLY');
   if(this.shared.steering.enabled&&require('./sharedTurns').intent(admission).steeringCapable)this.shared.steering.control(admission);
   const selected=body.generation===undefined?null:this.shared.steering.generation(admission.id,body.generation);
   if((selected?.executor||admission.principal)!==actor.principal)throw fail('SHARED_REQUEST_OWNER_REQUIRED',403);
   const prior=this.db.prepare('SELECT * FROM shared_native_requests WHERE id=?').get(body.requestId);
   if(prior){if(prior.admission_id!==admission.id||prior.principal!==actor.principal||prior.body_hash!==body.bodyHash||(prior.member_id||null)!==(body.memberId||null))throw fail('REQUEST_ID_REUSED');return {requestId:prior.id,state:prior.state,replayed:true};}
   if(!['accepted','dispatched'].includes(admission.state))throw fail('SHARED_REQUEST_NOT_DISPATCHABLE');
   if(this.db.prepare("SELECT 1 FROM shared_native_requests WHERE admission_id=? AND state IN ('prepared','dispatched','unknown')").get(admission.id))throw fail('SHARED_TOPIC_BUSY');
   const generation=body.generation===undefined?null:this.shared.steering.generation(admission.id,body.generation);
   if(body.generation!==undefined&&(!this.shared.steering.enabled||!generation||generation.executor!==actor.principal||generation.request_id!==body.requestId||generation.consumed_seq!==body.consumedInputSeq))throw fail('INVALID_STEERING_GENERATION');
   this.shared.steering.fence(admission.id,generation?.generation||0,actor.principal);
   const config=JSON.parse(generation?.config_json||admission.config_json),group=config.owner.kind==='group';
   if(group){if(!config.members.some(m=>m.id===body.memberId&&!m.deleted))throw fail('SHARED_MEMBER_NOT_AUTHORIZED',403);}
   else if(body.memberId!==undefined||!generation&&this.db.prepare('SELECT 1 FROM shared_native_requests WHERE admission_id=?').get(admission.id))throw fail('SHARED_REQUEST_ALREADY_DISPATCHED');
   const ordinal=this.db.prepare('SELECT count(*) n FROM shared_native_requests WHERE admission_id=?').get(admission.id).n;
   if(group&&require('./sharedTurns').intent(admission).plan?.[ordinal]!==body.memberId)throw fail('SHARED_GROUP_PLAN_CHANGED');
   if(ordinal>=1000)throw fail('SHARED_REQUEST_LIMIT');
   this.db.prepare("INSERT INTO shared_native_requests VALUES(?,?,?,?,?,'prepared',?)").run(body.requestId,admission.id,actor.principal,body.memberId||null,body.bodyHash,ordinal);
   this.db.prepare('UPDATE shared_admissions SET native_terminal=0 WHERE id=?').run(admission.id);
   // NativeTaskLinks already binds a child request through the existing step
   // table. This row observes desktop execution; the mobile scheduler never runs it.
   const mobileStep=this.db.prepare('SELECT * FROM mobile_execution_steps WHERE id=?').get(body.requestId);
   if(mobileStep){if(mobileStep.job_id!==admission.id||mobileStep.step_index!==ordinal||mobileStep.agent_id!==body.memberId)throw fail('SHARED_GROUP_PLAN_CHANGED');}
   else this.db.prepare("INSERT INTO mobile_execution_steps(id,job_id,step_index,agent_id,state,created_at,updated_at) VALUES(?,?,?,?,'pending',?,?)").run(body.requestId,admission.id,ordinal,body.memberId||config.owner.id,Date.now(),Date.now());
   this.phase(admission.id,body.requestId,'native_prepared');return {requestId:body.requestId,state:'prepared',replayed:false};
  });
 }
 knownContext(context){
  if(!context?.agentId||!context?.topicId)return false;
  if(this.shared.topicFor([context.ownerType||'agent',context.agentId,context.topicId]))return true;
  // An unadmitted request has no authenticated Source binding. Its own header
  // cannot hide a known shared local identity. Group packets name a speaker,
  // so recognize the group topic instead of treating the speaker as its owner.
  if(context.ownerType==='group'||context.isGroupMessage===true){
   if(this.db.prepare("SELECT 1 FROM shared_objects WHERE id=? AND kind='topic' AND owner_type='group'").get(context.topicId))return true;
   return Boolean(this.db.prepare("SELECT 1 FROM shared_local_bindings b JOIN shared_objects t ON t.id=b.object_id WHERE b.kind='topic' AND b.local_id=? AND t.owner_type='group' LIMIT 1").get(context.topicId));
  }
  return Boolean(this.db.prepare("SELECT 1 FROM shared_local_bindings WHERE kind='topic' AND local_id=? AND local_parent=? LIMIT 1").get(context.topicId,context.agentId));
 }
 enter(req,trustedActor=null){
  if(req.headers?.['x-nativesync-register']==='v1')return this.shared.atomic(()=>this.enterChecked(req,trustedActor));
  return this.enterChecked(req,trustedActor);
 }
 enterChecked(req,trustedActor=null){
  const ticket=req.headers?.['x-nativesync-admission'];
  if(!ticket){if(this.knownContext(req.body?.vcpchatExtensions?.requestContext))throw fail('SHARED_NATIVE_ADMISSION_REQUIRED');return null;}
  if(this.draining)throw fail('HOST_DRAINING',503);
  if(this.closed||this.shared.readOnly)throw fail('SHARED_READ_ONLY');
  const actor=trustedActor||this.shared.desktop({sourceId:req.headers['x-nativesync-source'],deviceId:req.headers['x-nativesync-device'],spaceId:req.headers['x-nativesync-space'],scopeHash:req.headers['x-nativesync-scope']},req.headers['x-nativesync-capabilities']);
  const admission=this.db.prepare('SELECT * FROM shared_admissions WHERE id=?').get(ticket);
  if(!admission)throw fail('SHARED_REQUEST_OWNER_REQUIRED',403);
  const turn=require('./sharedTurns').intent(admission);if(turn.steeringCapable&&(turn.controlMode==='text-only-v1'?!require('./releasePolicy.cjs').sharedControlledText:!require('./releasePolicy.cjs').sharedSteering))throw fail('SHARED_STEERING_UNAVAILABLE');
  if(this.engine.get?.(ticket)?.kind==='shared_session'&&!trustedActor)throw fail('SHARED_SESSION_DISPATCH_ONLY');
  this.shared.authorize(actor,admission.space_id,'execute');
  const inline=req.method==='POST'&&actor.kind==='desktop'&&req.headers['x-nativesync-register']==='v1'&&String(req.headers['x-nativesync-capabilities']||'').split(',').includes(NATIVE_INLINE_CAPABILITY);
  if(inline&&admission.principal!==actor.principal)throw fail('SHARED_REQUEST_OWNER_REQUIRED',403);
  const bodyHash=sha256(stable(req.body));
  if(inline){const sealed=req.headers['x-nativesync-body-hash'];if(!/^[a-f0-9]{64}$/.test(sealed||''))throw fail('INVALID_SHARED_NATIVE_REQUEST',400);if(sealed!==bodyHash)throw fail('SHARED_NATIVE_BODY_CHANGED');}
  let row=this.db.prepare('SELECT * FROM shared_native_requests WHERE id=? AND admission_id=?').get(req.body?.requestId,ticket);
  if(!row&&inline){
   const frozen=JSON.parse(admission.config_json),turn=require('./sharedTurns').intent(admission);
   if(frozen.owner.kind!=='agent'||turn.kind!=='message'||turn.steeringCapable)throw fail('SHARED_NATIVE_INLINE_UNAVAILABLE');
   if(admission.state!=='accepted')throw fail('SHARED_REQUEST_ALREADY_DISPATCHED');
   if(req.body.requestId!=='reply_'+admission.id)throw fail('INVALID_SHARED_NATIVE_REQUEST',400);
   this.prepare(actor,{sharedSpaceId:admission.space_id,admissionId:admission.id,requestId:req.body.requestId,bodyHash});
   row=this.db.prepare('SELECT * FROM shared_native_requests WHERE id=? AND admission_id=?').get(req.body.requestId,ticket);
  }
  if(!row||row.principal!==actor.principal)throw fail('SHARED_REQUEST_OWNER_REQUIRED',403);
  const generation=this.shared.steering.requestGeneration(admission.id,row.id);
  if(turn.controlMode==='text-only-v1'&&(!generation||generation.executor!==actor.principal))throw fail('INVALID_STEERING_GENERATION');
  if(turn.controlMode==='text-only-v1'){const gen=req.headers['x-nativesync-generation'],seq=req.headers['x-nativesync-consumed-input-seq'];if(!/^\d+$/.test(gen||'')||!/^\d+$/.test(seq||'')||Number(gen)!==generation.generation||Number(seq)!==generation.consumed_seq)throw fail('INVALID_STEERING_GENERATION');if(this.shared.steering.control(admission).executor!==actor.principal)throw fail('WORK_EXECUTOR_HANDOFF_REQUIRED');}
  if(generation)this.shared.steering.fence(admission.id,generation.generation,actor.principal);
  const frozen=JSON.parse(generation?.config_json||admission.config_json),member=row.member_id?frozen.members.find(m=>m.id===row.member_id):frozen.owner;
  const expectedModel=frozen.owner.kind==='group'&&frozen.owner.config.useUnifiedModel?frozen.owner.config.unifiedModel:member?.config.model;
  if(req.body.model!==expectedModel)throw fail('SHARED_NATIVE_CONFIG_CHANGED');
  const topic=this.shared.row(admission.space_id,admission.topic_id),context=req.body?.vcpchatExtensions?.requestContext;
  const localTopic=actor.kind==='desktop'&&context&&this.db.prepare("SELECT 1 FROM shared_local_bindings WHERE source_id=? AND object_id=? AND kind='topic' AND local_id=? AND hidden=0").get(actor.sourceId,topic.id,context.topicId);
  if(!context||context.ownerType!==topic.owner_type||context.topicId!==topic.topic_id&&!localTopic)throw fail('SHARED_NATIVE_CONTEXT_CHANGED');
  const canonicalAgent=topic.owner_type==='group'?member?.id:topic.owner_id;
  const boundAgent=actor.kind!=='desktop'?false:topic.owner_type==='group'?this.db.prepare("SELECT 1 FROM shared_local_bindings WHERE source_id=? AND kind='agent' AND object_id=? AND local_id=? AND hidden=0").get(actor.sourceId,member.id,context.agentId):this.db.prepare("SELECT 1 FROM shared_local_bindings WHERE source_id=? AND kind='topic' AND object_id=? AND local_parent=? AND hidden=0").get(actor.sourceId,topic.id,context.agentId);
  if(context.agentId!==canonicalAgent&&!boundAgent)throw fail('SHARED_NATIVE_CONTEXT_CHANGED');
  if(bodyHash!==row.body_hash)throw fail('SHARED_NATIVE_BODY_CHANGED');
  if(row.state!=='prepared'||!['accepted','dispatched'].includes(admission.state))throw fail('SHARED_REQUEST_ALREADY_DISPATCHED');
  let continuedBody=req.body;
  if(generation?.generation>0){
   // Skip proven never-dispatched generations, retaining the last native results.
   let previous,proof;
   for(let n=generation.generation-1;n>=0;n--){
    const candidate=this.shared.steering.generation(admission.id,n),stored=this.db.prepare('SELECT proof_json FROM shared_native_checkpoints WHERE work_id=? AND generation=?').get(admission.id,n);
    if(!candidate||!stored)throw fail('NATIVE_CHECKPOINT_REQUIRED');
    const value=JSON.parse(stored.proof_json);if(!value.noDispatch){previous=candidate;proof=value;break;}
   }
   if(previous){const inputs=this.db.prepare('SELECT input_id FROM shared_work_inputs WHERE work_id=? AND input_seq>? AND input_seq<=? ORDER BY input_seq').all(admission.id,previous.consumed_seq,generation.consumed_seq);
    const link=this.db.prepare('SELECT * FROM shared_compaction_native_links WHERE request_id=? AND proof_hash=? ORDER BY journal_seq DESC LIMIT 1').get(previous.request_id,proof.hash);
    if(link){const checkpoint=this.shared.store.readProjected(()=>{const value=this.shared.store.findMessage.get(topic.owner_type,topic.owner_id,topic.topic_id,link.checkpoint_id);return value?[value]:[];})[0]?.message;if(!checkpoint)throw fail('NATIVE_COMPACTION_CHECKPOINT_MISSING');
     const after=this.db.prepare('SELECT input_id FROM shared_work_inputs WHERE work_id=? AND input_seq>? AND input_seq<=? ORDER BY input_seq').all(admission.id,Math.max(previous.consumed_seq,link.through_input_seq),generation.consumed_seq);
     continuedBody=this.continuations.mergeCompactedBody(previous.request_id,req.body,{workId:admission.id,expectedHash:proof.hash,checkpoint,inputIds:after.map(v=>v.input_id)});
    }else continuedBody=this.continuations.mergeBody(previous.request_id,req.body,{workId:admission.id,expectedHash:proof.hash,inputIds:inputs.map(v=>v.input_id),partialMessageId:previous.request_id});}

  }
  const textOnly=require('./sharedTurns').intent(admission).controlMode===require('./sharedControlledText').MODE;
  if(textOnly&&((req.body.tools||[]).length||req.body.functions||!Array.isArray(req.body.messages)||continuedBody.messages.some(message=>!['system','developer','user','assistant'].includes(message.role)||typeof message.content!=='string'||require('./sharedControlledText').local(message.content))))throw fail('CONTROLLED_TEXT_ONLY');
  const steeringEnabled=require('./sharedTurns').intent(admission).steeringCapable&&Boolean(this.db.prepare('SELECT 1 FROM shared_work_controls WHERE work_id=?').get(admission.id));
  if(steeringEnabled)this.continuations.begin({workId:admission.id,requestId:row.id,generation:generation?.generation||0,controlRevision:generation?.revision||0},continuedBody.messages,continuedBody.vcpchatExtensions||{});
  this.shared.atomic(()=>{
   this.db.prepare("UPDATE shared_native_requests SET state='dispatched' WHERE id=?").run(row.id);
   this.db.prepare("UPDATE shared_admissions SET state='dispatched',dispatched=1 WHERE id=?").run(admission.id);
  });
  const base=this.engine.nativeTasks.hooks(admission.id,row.id);
  const fence=()=>{
   if(this.closed)throw fail('SHARED_NATIVE_CLOSED',503);
   this.shared.steering.fence(admission.id,generation?.generation||0,actor.principal);
   const current=this.db.prepare('SELECT state FROM shared_admissions WHERE id=?').get(admission.id);
   if(!current||current.state!=='dispatched')throw fail('SHARED_REQUEST_FENCED');
  };
  const hint=(event,state)=>this.engine.emitEvent?.(admission.id,'tool',{state,nativeRequestId:row.id,...(event.invocationId?{invocationId:event.invocationId}:{}),...(event.nativeTaskId?{nativeTaskId:event.nativeTaskId}:{})});
  const hooks={...base,onToolDispatch:event=>{fence();const value=base.onToolDispatch(event);hint(event,'started');return value;},onTaskAccepted:event=>{fence();const value=base.onTaskAccepted(event);hint(event,'accepted');return value;},onToolSettled:event=>{const value=base.onToolSettled(event);hint(event,'settled');this.checkTerminal(admission.id);return value;},onTaskObserved:event=>{const value=base.onTaskObserved(event);hint(event,'observed');this.checkTerminal(admission.id);return value;}};
  let ended=false;
  if(generation)this.db.prepare("UPDATE shared_work_generations SET state='preprocessing' WHERE work_id=? AND generation=?").run(admission.id,generation.generation);
  this.phase(admission.id,row.id,'native_entered');this.engine.emitEvent?.(admission.id,'state',{state:'dispatched'});
  let previewStopped=false;
  const observeAssistantText=(row.member_id||textOnly&&generation)?text=>{
   try{
    if(previewStopped||ended||this.closed||typeof text!=='string'||!text)return;
    const at=text.indexOf('<'),safe=at<0?text:text.slice(0,at);
    if(safe)this.shared.events?.publishNative(admission.id,row.id,'native_delta',safe);
    if(at>=0){previewStopped=true;this.shared.events?.publishNative(admission.id,row.id,'native_gap');}
   }catch{/* A read-only preview cannot affect native execution. */}
  }:undefined;
  try{if(observeAssistantText)this.shared.events?.publishNative(admission.id,row.id,'native_start');}catch{/* Observer startup cannot affect dispatch. */}
  // assertDispatch checks the fence before applying this generation transition.
  const applied=generation?()=>{
   this.db.prepare("UPDATE shared_work_generations SET state='running' WHERE work_id=? AND generation=? AND state='preprocessing'").run(admission.id,generation.generation);
  }:undefined;
  return {textOnly,observeAssistantText,sponsorAuthority:{actor,admissionId:admission.id,spaceId:admission.space_id,routeHash:JSON.parse(admission.user_op||'{}').sponsorRouteHash},phase:name=>this.phase(admission.id,row.id,name),steeringEnabled,workId:admission.id,generation:generation?.generation||0,fence,applied,continuation:()=>continuedBody,checkpoint:steeringEnabled?{completion:value=>this.continuations.completion(row.id,value),assistant:content=>this.continuations.assistant(row.id,content),result:(invocation,value)=>this.continuations.result(row.id,invocation,value)}:null,bridge:hooks,finish:success=>{
   if(ended||this.closed)return;ended=true;
   this.phase(admission.id,row.id,'native_settled');
   const steered=this.shared.steering.modelStopped(admission.id,row.id);
   this.db.prepare('UPDATE shared_native_requests SET state=? WHERE id=?').run(success||steered?'model_terminal':'unknown',row.id);
   if(!success&&!steered){this.db.prepare("UPDATE shared_admissions SET state='review_required' WHERE id=? AND state='dispatched'").run(admission.id);this.engine.emitEvent?.(admission.id,'state',{state:'review_required'});}
   else this.checkTerminal(admission.id);
  }};
 }
 phase(workId,requestId,stage){const key=requestId+':'+stage;if(this.seenPhases.has(key))return;if(!['native_prepared','native_entered','vcp_preprocessing','provider_attempt','first_model_body','native_settled','final_persisted'].includes(stage))throw fail('INVALID_EXECUTION_PHASE');this.db.prepare('INSERT OR IGNORE INTO shared_request_phases VALUES(?,?,?,?)').run(workId,requestId,stage,Date.now());this.seenPhases.add(key);if(this.seenPhases.size>50000)this.seenPhases.delete(this.seenPhases.values().next().value);}
 checkTerminal(admissionId){
  if(this.closed)return;
  const admission=this.db.prepare('SELECT * FROM shared_admissions WHERE id=?').get(admissionId),config=JSON.parse(admission.config_json);
  if(config.owner.kind==='group'&&this.db.prepare('SELECT count(*) n FROM shared_native_requests WHERE admission_id=?').get(admissionId).n!==require('./sharedTurns').intent(admission).plan.length)return;
  const pending=this.db.prepare("SELECT 1 FROM shared_native_requests WHERE admission_id=? AND state IN ('prepared','dispatched','unknown') LIMIT 1").get(admissionId);
  const native=this.engine.nativeTasks;
  if(!pending&&!native.unsettledTools(admissionId)&&!native.needsReview(admissionId)&&native.list(admissionId).every(task=>['completed','failed','cancelled','stopped'].includes(task.state))){this.shared.nativeTerminal(admissionId);if(this.shared.steering.enabled)this.shared.steering.closeIfFinished(admissionId);}
 }
 checkpointProof(workId,requestId,settled){const g=this.shared.steering.requestGeneration(workId,requestId);if(g&&settled.length===0&&this.db.prepare('SELECT 1 FROM shared_native_no_dispatch WHERE work_id=? AND generation=?').get(workId,g.generation))return {requestId,hash:null,settledInvocationIds:[],noDispatch:true};return this.continuations.proof(requestId,workId,settled);}
 canReview(admissionId){const rows=[...this.db.prepare('SELECT state FROM shared_native_requests WHERE admission_id=?').all(admissionId),...this.db.prepare('SELECT state FROM shared_native_child_requests WHERE work_id=?').all(admissionId)];return rows.length>0&&rows.every(r=>['model_terminal','unknown','prepared'].includes(r.state));}
 close(){this.closed=true;require('../../../modules/requestExecutionContext').events.off('approval',this.approvalObserver);this.shared.events?.close?.();}
 beginDrain(){this.draining=true;this.shared.events?.close?.();}
 snapshot(){return {accepting:!this.closed&&!this.draining,dispatched:this.db.prepare("SELECT count(*) n FROM shared_native_requests WHERE state='dispatched'").get().n,held:this.db.prepare("SELECT count(*) n FROM shared_admissions WHERE state IN ('preparing','accepted','dispatched','review_required')").get().n};}
}
module.exports={SharedNative,NATIVE_INLINE_CAPABILITY};

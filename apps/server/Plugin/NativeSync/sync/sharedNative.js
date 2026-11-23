'use strict';
const controlled=require('./sharedControlledText');
const handoff=require('./sharedGroupHandoff');
const {SharedDelegation,linkageHash}=require('./sharedDelegation');
const {resolveEffectiveModel}=require('@vcp/core-rules/group/modelSelection');
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
  shared.native=this;
  if(!shared.events||shared.events.closed)shared.events=new (require('./sharedEvents').SharedEvents)(shared,engine);
  this.approvalObserver=event=>{try{const row=this.db.prepare('SELECT admission_id FROM shared_native_requests WHERE id=?').get(event.requestId);if(row)this.engine.emitEvent?.(row.admission_id,'approval',{state:event.waiting?'waiting_approval':'running',nativeRequestId:event.requestId});}catch{/* Observers do not own tool or model execution. */}};
  require('../../../modules/requestExecutionContext').events.on('approval',this.approvalObserver);
  this.taskControls=new (require('./sharedTaskControls').SharedTaskControls)(shared);this.taskRequests=new (require('./sharedTaskRequests').SharedTaskRequests)(this);shared.steering.onInput=(workId)=>{require('../../../modules/requestExecutionContext').interruptWork(workId);return this.taskControls.request(workId);};
  this.delegations=new SharedDelegation(this);
  // AA may initialize after NativeSync. Reconcile its final replies after the
  // native task provider is ready, without ever redispatching either request.
  this.recoveryFinals=new Map(this.finalCandidates(controlled.AA_MODE).map(row=>[row.request_id,row.id]));
  const retryFinal=[...this.recoverFinalReplies(),...this.recoveryFinals.keys()];
  this.db.prepare("UPDATE shared_native_requests SET state='unknown' WHERE state='dispatched' AND id NOT IN (SELECT value FROM json_each(?))").run(JSON.stringify(retryFinal));
  handoff.recoverUnknown(shared);
  if(engine?.get&&engine.configs){
   this.verifyRecoveredToolBoundaries();
   require('../mobile/groupTurn').recover(engine);
   // A verified AA row can commit just before its parent terminal flag.
   // Such a child has left the reconcile queue. Recheck the existing reply
   // intent on startup without scheduling either the parent or the child.
   const pendingReplies=this.db.prepare(`SELECT a.id FROM shared_admissions a
    JOIN mobile_executions j ON j.id=a.id AND j.state='publishing' AND j.pending_operation IS NOT NULL
    JOIN shared_native_requests r ON r.id=a.id AND r.admission_id=a.id AND r.state='model_terminal'
    WHERE a.state='dispatched' AND a.native_terminal=0 AND EXISTS (
     SELECT 1 FROM mobile_native_tasks t WHERE t.execution_id=a.id AND t.state IN ('completed','failed','stopped','cancelled'))`).all();
   for(const row of pendingReplies)this.checkTerminal(row.id);
  }
 }
 finalCandidates(mode){
  return this.db.prepare(`SELECT a.id,g.request_id FROM shared_admissions a
   JOIN shared_work_generations g ON g.work_id=a.id AND g.generation=1 AND g.state='running'
   JOIN shared_work_controls c ON c.work_id=g.work_id AND c.generation=g.generation
   JOIN shared_native_requests r ON r.id=g.request_id AND r.admission_id=a.id
   WHERE a.state='dispatched' AND r.state IN ('dispatched','model_terminal')
    AND json_extract(a.user_op,'$.sharedTurn.controlMode')=?`).all(mode);
 }
 recoverFinalReplies({delegation=false}={}){
  const retry=[];
  const candidates=delegation?Array.from(this.recoveryFinals,([request_id,id])=>({request_id,id})):this.finalCandidates(controlled.TOOLS_MODE);
  for(const row of candidates){
   const result=this.tryFinalReply(row.id,row.request_id);
   if(result===null)retry.push(row.request_id);
   else{
    if(delegation)this.recoveryFinals.delete(row.request_id);
    if(!result){
     if(delegation)this.db.prepare("UPDATE shared_native_requests SET state='unknown' WHERE id=? AND state='dispatched'").run(row.request_id);
     this.requireFinalReview(row.id);
    }
   }
  }
  return retry;
 }
 requireFinalReview(workId){
  return this.db.prepare("UPDATE shared_admissions SET state='review_required',native_terminal=0 WHERE id=? AND state='dispatched'").run(workId).changes;
 }
 tryFinalReply(workId,requestId){
  try{
   if(this.db.prepare(`SELECT 1 FROM shared_admissions a JOIN shared_work_generations g ON g.work_id=a.id
    WHERE a.id=? AND a.state='completed' AND a.reply_seq IS NOT NULL
     AND g.generation=1 AND g.request_id=? AND g.state='completed'`).get(workId,requestId))return true;
   const data=this.continuations.read(requestId);
   if(!data?.completion)return false;
   return this.shared.steering.publishNativeFinal(workId,requestId,data);
  }catch(error){
   console.warn('[NativeSync] SAFE_TOOL_FINAL_REPLY_FAILED',error.code||'UNEXPECTED');
   // Keep the existing dispatch fence through a storage outage. The same
   // proof may settle on a late submission or the next startup.
   if(this.isStorageFailure(error))return null;
   return false;
  }
 }
 isStorageFailure(error){
  return error.code==='NATIVE_ARCHIVE_STORAGE_UNAVAILABLE'||error.code?.startsWith('ERR_SQLITE_')||['EIO','ENOSPC','EDQUOT','EROFS','EACCES','EPERM','EAGAIN','EBUSY','EMFILE','ENFILE'].includes(error.code);
 }
 verifyRecoveredToolBoundaries(){
  const candidates=this.db.prepare(`SELECT a.id,g.request_id,p.proof_json FROM shared_admissions a
   JOIN shared_work_generations g ON g.work_id=a.id AND g.generation=0 AND g.state='paused'
   JOIN shared_native_checkpoints p ON p.work_id=g.work_id AND p.generation=0
   WHERE a.state='dispatched' AND json_extract(a.user_op,'$.sharedTurn.controlMode')=?`).all(controlled.TOOLS_MODE);
  for(const row of candidates){
   try{
    this.verifiedToolBoundary(row.id,row.request_id,JSON.parse(row.proof_json));
   }catch(error){
    this.db.prepare("UPDATE shared_admissions SET state='review_required',native_terminal=0 WHERE id=?").run(row.id);
    console.warn('[NativeSync] SAFE_TOOL_RECOVERY_FAILED',error.code||'UNEXPECTED');
   }
  }
 }
 toolLedger(workId){
  return this.db.prepare(`SELECT invocation_id,native_request_id,plugin_name,record_id,state
   FROM mobile_native_invocations WHERE execution_id=? ORDER BY rowid`).all(workId);
 }
 settledBoundary(row,requestId,savedProof){
  if(require('./sharedTurns').intent(row).controlMode===controlled.AA_MODE)return this.delegations.checkpoint(row.id,requestId,savedProof);
  return this.checkedToolCheckpoint(row.id,requestId,savedProof);
 }
 verifiedToolBoundary(workId,requestId,savedProof){
  return this.checkedToolCheckpoint(workId,requestId,savedProof).proof;
 }
 checkedToolCheckpoint(workId,requestId,savedProof){
  const ledger=this.toolLedger(workId);
  const reject=()=>fail('NATIVE_CHECKPOINT_RESULTS_UNCONFIRMED');
  if(!ledger.length||ledger.length>2||ledger.some(call=>call.native_request_id!==requestId||call.state!=='returned'))throw reject();
  if(ledger.length===2){
   const admission=this.db.prepare('SELECT user_op FROM shared_admissions WHERE id=?').get(workId);
   const turn=admission&&require('./sharedTurns').intent(admission);
   if(turn?.controlMode!==controlled.TOOLS_MODE||turn.toolBatchLimit!==2)throw reject();
  }
  const ids=ledger.map(call=>call.invocation_id);
  const proof=savedProof||this.checkpointProof(workId,requestId,ids);
  if(stable(proof.settledInvocationIds)!==stable(ids))throw reject();
  const receipts=this.continuations.compactionToolResults(requestId,workId,proof);
  if(receipts.length!==ledger.length)throw reject();
  for(const [index,call] of ledger.entries()){
   const receipt=receipts[index].result;
   if(receipt.invocationId!==call.invocation_id||receipt.pluginName!==call.plugin_name||
      receipt.recordId!==call.record_id||!Object.hasOwn(receipt,'result')||
      (ledger.length===2&&receipt.batchOrdinal!==index))throw reject();
  }
  return {proof,receipts};
 }
 prepare(actor,body,{session=false}={}){
  if(this.draining||this.closed)throw fail('HOST_DRAINING',503);
  this.shared.authorize(actor,body.sharedSpaceId,'execute');
  if(this.shared.readOnly)throw fail('SHARED_READ_ONLY');
  sharedIdentity(body.requestId);
  if(!/^[a-f0-9]{64}$/.test(body.bodyHash||''))throw fail('INVALID_SHARED_NATIVE_REQUEST',400);
  return this.shared.atomic(()=>{
   const admission=this.shared.admission(actor,body.sharedSpaceId,body.admissionId);
   const turn=require('./sharedTurns').intent(admission);if(turn.steeringCapable&&!controlled.enabled(this.shared,turn.controlMode))throw fail('SHARED_STEERING_UNAVAILABLE');
   controlled.assertAAClient(actor,turn.controlMode);
   if(turn.controlMode===controlled.AA_MODE&&body.generation===0&&!this.shared.delegationAgents.has(turn.delegation.agentName))throw fail('INVALID_SHARED_AA_DELEGATION');
   if(controlled.isControlled(turn.controlMode)&&(!Number.isSafeInteger(body.generation)||body.generation<0||!Number.isSafeInteger(body.consumedInputSeq)||body.consumedInputSeq<0))throw fail('INVALID_STEERING_GENERATION');
   if(controlled.isControlled(turn.controlMode)){const current=this.shared.steering.control(admission),frozen=this.shared.steering.generation(admission.id,body.generation);if(current.executor!==actor.principal)throw fail('WORK_EXECUTOR_HANDOFF_REQUIRED');if(!frozen||frozen.executor!==actor.principal||frozen.request_id!==body.requestId||frozen.consumed_seq!==body.consumedInputSeq||current.generation!==body.generation)throw fail('INVALID_STEERING_GENERATION');this.shared.steering.fence(admission.id,body.generation,actor.principal);}
   if(this.engine.get?.(admission.id)?.kind==='shared_session'&&!session)throw fail('SHARED_SESSION_DISPATCH_ONLY');
   if(this.shared.steering.enabled&&require('./sharedTurns').intent(admission).steeringCapable)this.shared.steering.control(admission);
   const controlledGroup=handoff.matches(admission);
   const prior=this.db.prepare('SELECT * FROM shared_native_requests WHERE id=?').get(body.requestId);
   if(controlledGroup){
    if(body.generation!==undefined||body.consumedInputSeq!==undefined)throw fail('INVALID_STEERING_GENERATION');
    const ordinal=prior?.ordinal??this.db.prepare('SELECT count(*) n FROM shared_native_requests WHERE admission_id=?').get(admission.id).n;
    handoff.assertSlot(this.shared,actor,admission,ordinal,body.requestId);
   }
   const selected=body.generation===undefined?null:this.shared.steering.generation(admission.id,body.generation);
   if(!controlledGroup&&(selected?.executor||admission.principal)!==actor.principal)throw fail('SHARED_REQUEST_OWNER_REQUIRED',403);
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
   const stop=this.engine.get?.(admission.id)?.group_stop_index;
   if(stop!=null&&ordinal>=stop)throw fail('SHARED_REQUEST_FENCED');
   // V2 has already fenced this exact ordinal against its frozen plan.
   if(ordinal>=1000&&turn.controlMode!==handoff.PLAN_MODE)throw fail('SHARED_REQUEST_LIMIT');
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
 enter(req,trustedActor=null,replyOperation){
  if(req.headers?.['x-nativesync-register']==='v1')return this.shared.atomic(()=>this.enterChecked(req,trustedActor,replyOperation));
  return this.enterChecked(req,trustedActor,replyOperation);
 }
 enterChecked(req,trustedActor=null,replyOperation){
  const ticket=req.headers?.['x-nativesync-admission'];
  if(!ticket){if(this.knownContext(req.body?.vcpchatExtensions?.requestContext))throw fail('SHARED_NATIVE_ADMISSION_REQUIRED');return null;}
  if(this.draining)throw fail('HOST_DRAINING',503);
  if(this.closed||this.shared.readOnly)throw fail('SHARED_READ_ONLY');
  const actor=trustedActor||this.shared.desktop({sourceId:req.headers['x-nativesync-source'],deviceId:req.headers['x-nativesync-device'],spaceId:req.headers['x-nativesync-space'],scopeHash:req.headers['x-nativesync-scope']},req.headers['x-nativesync-capabilities']);
  const admission=this.db.prepare('SELECT * FROM shared_admissions WHERE id=?').get(ticket);
  if(!admission)throw fail('SHARED_REQUEST_OWNER_REQUIRED',403);
  const turn=require('./sharedTurns').intent(admission);if(turn.steeringCapable&&!controlled.enabled(this.shared,turn.controlMode))throw fail('SHARED_STEERING_UNAVAILABLE');
  controlled.assertAAClient(actor,turn.controlMode);
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
  const controlledGroup=handoff.matches(admission);
  const groupControl=controlledGroup?handoff.assertSlot(this.shared,actor,admission,row.ordinal,row.id):null;
  const stop=this.engine.get?.(admission.id)?.group_stop_index;
  if(stop!=null&&row.ordinal>=stop)throw fail('SHARED_REQUEST_FENCED');
  const generation=this.shared.steering.requestGeneration(admission.id,row.id);
  if(controlled.isControlled(turn.controlMode)&&(!generation||generation.executor!==actor.principal))throw fail('INVALID_STEERING_GENERATION');
  if(controlled.isControlled(turn.controlMode)){const gen=req.headers['x-nativesync-generation'],seq=req.headers['x-nativesync-consumed-input-seq'];if(!/^\d+$/.test(gen||'')||!/^\d+$/.test(seq||'')||Number(gen)!==generation.generation||Number(seq)!==generation.consumed_seq)throw fail('INVALID_STEERING_GENERATION');if(this.shared.steering.control(admission).executor!==actor.principal)throw fail('WORK_EXECUTOR_HANDOFF_REQUIRED');}
  if(generation)this.shared.steering.fence(admission.id,generation.generation,actor.principal);
  const frozen=JSON.parse(generation?.config_json||admission.config_json),member=row.member_id?frozen.members.find(m=>m.id===row.member_id):frozen.owner;
  let expectedModel=member?.config.model;
  if(frozen.owner.kind==='group'){
   expectedModel=resolveEffectiveModel(frozen.owner.config,member?.config).effectiveModel;
   if(!member||!expectedModel)throw fail('SHARED_NATIVE_CONFIG_CHANGED');
  }
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
    const link=this.db.prepare('SELECT * FROM shared_compaction_native_links WHERE request_id=? AND proof_hash=? ORDER BY journal_seq DESC LIMIT 1').get(previous.request_id,linkageHash(proof));
    if(controlled.transferable(turn.controlMode)){
     if(!link)throw fail('NATIVE_COMPACTION_CHECKPOINT_MISSING');
     this.settledBoundary(admission,previous.request_id,proof);
     if(turn.controlMode===controlled.AA_MODE)this.shared.steering.verifyCompactionLink(admission,topic,previous,proof,generation.consumed_seq);

    }
    if(link){const checkpoint=this.shared.store.readProjected(()=>{const value=this.shared.store.findMessage.get(topic.owner_type,topic.owner_id,topic.topic_id,link.checkpoint_id);return value?[value]:[];})[0]?.message;if(!checkpoint)throw fail('NATIVE_COMPACTION_CHECKPOINT_MISSING');
     const after=this.db.prepare('SELECT input_id FROM shared_work_inputs WHERE work_id=? AND input_seq>? AND input_seq<=? ORDER BY input_seq').all(admission.id,Math.max(previous.consumed_seq,link.through_input_seq),generation.consumed_seq);
     continuedBody=this.continuations.mergeCompactedBody(previous.request_id,req.body,{workId:admission.id,expectedHash:proof.hash,checkpoint,inputIds:after.map(v=>v.input_id)});
    }else continuedBody=this.continuations.mergeBody(previous.request_id,req.body,{workId:admission.id,expectedHash:proof.hash,inputIds:inputs.map(v=>v.input_id),partialMessageId:previous.request_id});}

  }
  const transferable=controlled.transferable(turn.controlMode);
  const delegationWork=turn.controlMode===controlled.AA_MODE;
  const delegation=delegationWork&&generation?.generation===0?{
   agentName:turn.delegation.agentName,prompt:JSON.parse(admission.user_op).message.content,
  }:null;
  if(delegation&&!this.shared.delegationAgents.has(delegation.agentName))throw fail('INVALID_SHARED_AA_DELEGATION');
  const safeTools=generation?.generation!==0?null:delegation?new Set(['AgentAssistant']):
   turn.controlMode===controlled.TOOLS_MODE?this.shared.safeTools:null;
  if(groupControl)handoff.assertBody(this.shared,admission,topic,groupControl,row.ordinal,req.body);
  const textOnly=controlledGroup||turn.controlMode===controlled.MODE||transferable&&!safeTools;
  if(controlled.isControlled(turn.controlMode)&&((req.body.tools||[]).length||req.body.functions||!Array.isArray(req.body.messages)||continuedBody.messages.some(message=>!['system','developer','user','assistant'].includes(message.role)||typeof message.content!=='string'||controlled.local(message.content))))throw fail('CONTROLLED_TEXT_ONLY');
  const steeringEnabled=require('./sharedTurns').intent(admission).steeringCapable&&Boolean(this.db.prepare('SELECT 1 FROM shared_work_controls WHERE work_id=?').get(admission.id));
  if(delegation)continuedBody=withDelegationInstruction(continuedBody,delegation);
  if(steeringEnabled)this.continuations.begin({workId:admission.id,requestId:row.id,generation:generation?.generation||0,controlRevision:generation?.revision||0},continuedBody.messages,continuedBody.vcpchatExtensions||{});
  this.shared.atomic(()=>{
   if(groupControl){
    const fresh=this.db.prepare('SELECT * FROM shared_admissions WHERE id=?').get(admission.id);
    const current=handoff.assertSlot(this.shared,actor,fresh,row.ordinal,row.id);
    if(current.executor_version!==groupControl.executor_version)throw fail('SHARED_GROUP_HANDOFF_FENCED');
    if(row.ordinal>0)handoff.verifyPrevious(this.shared,fresh,topic,current,row.ordinal);
   }
   if(!this.db.prepare("UPDATE shared_native_requests SET state='dispatched' WHERE id=? AND state='prepared'").run(row.id).changes)throw fail('SHARED_REQUEST_ALREADY_DISPATCHED');
   this.db.prepare("UPDATE shared_admissions SET state='dispatched',dispatched=1 WHERE id=?").run(admission.id);
  });
  const base=this.engine.nativeTasks.hooks(admission.id,row.id);
  let batchNames=null,settledCount=0,pausedAtFence=false;
  const beginToolBatch=safeTools?names=>{
   fence();
   if(batchNames||!names.length||names.length>(turn.toolBatchLimit===2?2:1))throw fail('CONTROLLED_TOOL_CALL_LIMIT');
   if(names.some(name=>!safeTools.has(name))||new Set(names).size!==names.length)throw fail('CONTROLLED_TOOL_FORBIDDEN');
   batchNames=names;
  }:null;
  const fence=()=>{
   if(this.closed)throw fail('SHARED_NATIVE_CLOSED',503);
   if(batchNames&&settledCount===batchNames.length){pausedAtFence=true;throw fail('WORK_SAFE_TOOL_BOUNDARY');}
   this.shared.steering.fence(admission.id,generation?.generation||0,actor.principal);
   const current=this.db.prepare(groupControl?'SELECT * FROM shared_admissions WHERE id=?':'SELECT state FROM shared_admissions WHERE id=?').get(admission.id);
   if(groupControl&&handoff.assertSlot(this.shared,actor,current,row.ordinal,row.id).executor_version!==groupControl.executor_version)
    throw fail('SHARED_GROUP_HANDOFF_FENCED');
   if(!current||current.state!=='dispatched')throw fail('SHARED_REQUEST_FENCED');
  };
  const hint=(event,state)=>this.engine.emitEvent?.(admission.id,'tool',{state,nativeRequestId:row.id,...(event.invocationId?{invocationId:event.invocationId}:{}),...(event.nativeTaskId?{nativeTaskId:event.nativeTaskId}:{})});
  const hooks={...base,
   onToolDispatch:event=>{
    fence();
    if(controlledGroup)throw fail('CONTROLLED_TEXT_TOOLS_FORBIDDEN');
    if(safeTools){
     if(!safeTools.has(event.pluginName))throw fail('CONTROLLED_TOOL_FORBIDDEN');
     const prior=this.toolLedger(admission.id);
     if(!batchNames||event.batchNames!==batchNames||event.batchSize!==batchNames.length||
        event.batchOrdinal!==settledCount||prior.length!==settledCount||
        batchNames[settledCount]!==event.pluginName)throw fail('CONTROLLED_TOOL_CALL_LIMIT');
     if(settledCount){
      const previous=prior[0],archive=this.continuations.read(row.id);
      const receipt=archive?.results[previous.invocation_id];
      if(archive?.identity.workId!==admission.id||previous.state!=='returned'||previous.native_request_id!==row.id||previous.plugin_name!==batchNames[0]||
         !receipt||receipt.invocationId!==previous.invocation_id||receipt.recordId!==previous.record_id||
         receipt.pluginName!==previous.plugin_name||receipt.batchOrdinal!==0||receipt.batchSize!==2||
         stable(receipt.batchNames)!==stable(batchNames)||!Object.hasOwn(receipt,'result'))throw fail('NATIVE_CHECKPOINT_RESULTS_UNCONFIRMED');
     }
    }
    const value=base.onToolDispatch(event);hint(event,'started');return value;
   },
   onTaskAccepted:event=>{fence();if(controlledGroup)throw fail('CONTROLLED_TEXT_TOOLS_FORBIDDEN');if(safeTools&&!delegation)throw fail('CONTROLLED_TOOL_FORBIDDEN');
    if(delegation&&(event.pluginName!=='AgentAssistant'||this.engine.nativeTasks.list(admission.id).length))throw fail('CONTROLLED_TOOL_CALL_LIMIT');const value=base.onTaskAccepted(event);hint(event,'accepted');return value;},
   onToolSettled:event=>{const value=base.onToolSettled(event);if(safeTools&&event.outcome==='returned'){
    if(event.batchNames!==batchNames||event.batchOrdinal!==settledCount)throw fail('NATIVE_INVOCATION_IDENTITY_MISMATCH');
    settledCount++;
   }hint(event,'settled');this.checkTerminal(admission.id);return value;},
   onTaskObserved:event=>{const value=base.onTaskObserved(event);hint(event,'observed');this.checkTerminal(admission.id);return value;}
  };
  let ended=false;
  const ownsFinalReply=transferable&&generation?.generation===1;
  const controlledFinalReply=ownsFinalReply?value=>{
   if(ended||this.closed)throw fail('SHARED_REQUEST_FENCED');
   if(value?.finishReason!=='stop'||typeof value.content!=='string'||!value.content.trim())throw fail('NATIVE_COMPLETION_INVALID');
   const timestamp=this.continuations.read(row.id)?.completion?.timestamp??Date.now();
   const record={version:1,workId:admission.id,generation:1,requestId:row.id,
    executor:actor.principal,content:value.content,finishReason:value.finishReason,timestamp};
   this.continuations.completion(row.id,{...record,digest:sha256(stable(record))});
   this.tryFinalReply(admission.id,row.id);
  }:undefined;
  const sessionFinalReply=trustedActor&&row.id===admission.id&&typeof replyOperation==='function'?value=>{
   if(ended||this.closed)throw fail('SHARED_REQUEST_FENCED');
   if(value?.finishReason!=='stop'||typeof value.content!=='string'||!value.content||Buffer.byteLength(value.content)>4*1024*1024)return;
   fence();
   if(this.engine.nativeTasks.uncertainTools(admission.id))return;
   this.shared.atomic(()=>{
    const sealed=this.db.prepare(`UPDATE mobile_executions SET native_final_operation=?
     WHERE id=? AND (kind IS NULL OR kind='shared_session') AND state='running' AND request_dispatched=1 AND cancel_requested=0
      AND pending_operation IS NULL AND native_final_operation IS NULL`).run(require('../mobile/sharedSingle').sealNativeFinal(row,admission,replyOperation(value.content)),row.id);
    if(!sealed.changes)return;
    if(!this.db.prepare("UPDATE shared_native_requests SET state='model_terminal' WHERE id=? AND state='dispatched'").run(row.id).changes)throw fail('SHARED_REQUEST_FENCED');
    this.phase(admission.id,row.id,'final_persisted');
    this.checkTerminal(admission.id);
   });
  }:undefined;
  if(sessionFinalReply)sessionFinalReply.readStreamDelta=require('@vcp/core-rules/group/streamDelta').groupStreamDelta;
  const finalReply=controlledFinalReply||sessionFinalReply;
  if(generation)this.db.prepare("UPDATE shared_work_generations SET state='preprocessing' WHERE work_id=? AND generation=?").run(admission.id,generation.generation);
  this.phase(admission.id,row.id,'native_entered');this.engine.emitEvent?.(admission.id,'state',{state:'dispatched'});
  let previewStopped=false;
  const observeAssistantText=(row.member_id||controlled.isControlled(turn.controlMode)&&generation)?text=>{
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
  const finish=success=>{
   if(ended||this.closed)return;ended=true;
   this.phase(admission.id,row.id,'native_settled');
   if(ownsFinalReply){
    if(this.tryFinalReply(admission.id,row.id)!==false)return;
    const held=this.shared.atomic(()=>{
     this.db.prepare("UPDATE shared_native_requests SET state='unknown' WHERE id=? AND state='dispatched'").run(row.id);
     return this.requireFinalReview(admission.id);
    });
    if(held)this.engine.emitEvent?.(admission.id,'state',{state:'review_required'});
    return;
   }
   if(sessionFinalReply&&this.engine.get(row.id)?.native_final_operation){
    this.checkTerminal(admission.id);
    return;
   }
   if(delegation){
    if(pausedAtFence){
     const saved=this.shared.atomic(()=>{
      const update=this.db.prepare("UPDATE shared_work_generations SET state='awaiting_native_task' WHERE work_id=? AND generation=0 AND state='running'").run(admission.id);
      if(!update.changes)return false;
      this.db.prepare("UPDATE shared_native_requests SET state='model_terminal' WHERE id=? AND state='dispatched'").run(row.id);
      return true;
     });
     if(saved){
      this.delegations.trackAwaiting(admission.id);
      this.checkTerminal(admission.id);
      return;
     }
    }
    // A text-only answer, a missing launch receipt, or a dropped parent
    // execution cannot close the Work or trigger another native request.
    success=false;
   }
   if(pausedAtFence&&!delegation){
    try{
     this.shared.atomic(()=>{
      const update=this.db.prepare("UPDATE shared_work_generations SET state='paused' WHERE work_id=? AND generation=? AND state='running'").run(admission.id,generation.generation);
      if(!update.changes)throw fail('SHARED_GENERATION_FENCED');
      this.db.prepare("UPDATE shared_native_requests SET state='model_terminal' WHERE id=?").run(row.id);
      this.shared.steering.checkpointSettledTool(actor,admission,generation);
     });
    }catch(error){console.warn('[NativeSync] SAFE_TOOL_CHECKPOINT_FAILED',error.code||'UNEXPECTED');success=false;}
    if(this.shared.steering.generation(admission.id,generation.generation)?.state==='paused'){
     try{this.engine.emitEvent?.(admission.id,'state',{state:'dispatched'});}catch{/* Polling can recover the committed pause. */}
     return;
    }
   }
   if(transferable&&this.engine.nativeTasks.uncertainTools(admission.id))success=false;
   const steered=this.shared.steering.modelStopped(admission.id,row.id);
   this.db.prepare('UPDATE shared_native_requests SET state=? WHERE id=?').run(success||steered?'model_terminal':'unknown',row.id);
   if(!success&&!steered){this.db.prepare("UPDATE shared_admissions SET state='review_required' WHERE id=? AND state='dispatched'").run(admission.id);this.engine.emitEvent?.(admission.id,'state',{state:'review_required'});}
   else this.checkTerminal(admission.id);
  };
  return {textOnly,safeTools,delegation,beginToolBatch,observeAssistantText,sponsorAuthority:controlledGroup?null:{actor,admissionId:admission.id,spaceId:admission.space_id,routeHash:JSON.parse(admission.user_op||'{}').sponsorRouteHash},phase:name=>this.phase(admission.id,row.id,name),steeringEnabled,workId:admission.id,generation:generation?.generation||0,fence,applied,continuation:()=>continuedBody,checkpoint:steeringEnabled?{finalReply,completion:value=>this.continuations.completion(row.id,value),assistant:content=>this.continuations.assistant(row.id,content),result:(invocation,value)=>this.continuations.result(row.id,invocation,value)}:null,sessionFinalReply,bridge:hooks,finish,
   settleToolPause:()=>{
    if(!pausedAtFence)return false;
    finish(false);
    const state=this.shared.steering.generation(admission.id,generation.generation)?.state;
    if(delegation){
     const work=this.db.prepare('SELECT state FROM shared_admissions WHERE id=?').get(admission.id);
     return work?.state==='dispatched'&&['paused','awaiting_native_task'].includes(state)?state:false;
    }
    return state==='paused';
   }};
 }
 phase(workId,requestId,stage){const key=requestId+':'+stage;if(this.seenPhases.has(key))return;if(!['native_prepared','native_entered','vcp_preprocessing','provider_attempt','first_model_body','native_settled','final_persisted'].includes(stage))throw fail('INVALID_EXECUTION_PHASE');this.db.prepare('INSERT OR IGNORE INTO shared_request_phases VALUES(?,?,?,?)').run(workId,requestId,stage,Date.now());if(this.db.isTransaction)return;this.seenPhases.add(key);if(this.seenPhases.size>50000)this.seenPhases.delete(this.seenPhases.values().next().value);}
 checkTerminal(admissionId,{advanceGroup=true}={}){
  if(this.closed)return;
  const admission=this.db.prepare('SELECT * FROM shared_admissions WHERE id=?').get(admissionId);
  const job=this.engine.get?.(admissionId),stop=job?.group_stop_index;
  if(advanceGroup&&job?.state==='recovering'&&require('../mobile/groupTurn').isGroup(job)){
   queueMicrotask(()=>{
    if(this.closed)return;
    try{require('../mobile/groupTurn').advanceSettlement(this.engine,admissionId);}
    catch(error){console.warn('[NativeSync] GROUP_SETTLEMENT_FAILED',error.code||'UNEXPECTED');}
   });
  }
  if(!admission)return;
  const recheck=admission.state==='review_required'&&(stop!=null||(!advanceGroup&&require('../mobile/groupTurn').isGroup(job)));
  if(admission.state!=='dispatched'&&!recheck)return;
  const config=JSON.parse(admission.config_json);
  const mode=require('./sharedTurns').intent(admission).controlMode;
  if(mode===controlled.AA_MODE&&this.shared.steering.control(admission).generation===0){this.delegations.advance(admission);return;}
  if(mode===controlled.TOOLS_MODE&&this.shared.steering.generation(admissionId,0)?.state==='paused'&&this.shared.steering.control(admission).generation===0)return;
  const pending=this.db.prepare("SELECT 1 FROM shared_native_requests WHERE admission_id=? AND state IN ('prepared','dispatched','unknown') LIMIT 1").get(admissionId);
  const native=this.engine.nativeTasks;
  if(pending)return;
  if(this.taskRequests.uncertain(admissionId)){
   this.db.prepare("UPDATE shared_admissions SET state='review_required',native_terminal=0 WHERE id=? AND state='dispatched'").run(admissionId);
   this.engine.emitEvent?.(admissionId,'state',{state:'review_required'});
   return;
  }
  if(config.owner.kind==='group'){
   const counts=this.db.prepare("SELECT count(*) n,coalesce(sum(state='model_terminal'),0) terminal FROM shared_native_requests WHERE admission_id=?").get(admissionId);
   if(counts.n!==(stop??require('./sharedTurns').intent(admission).plan.length))return;
   if(stop!=null&&(counts.terminal!==stop||native.uncertainTools(admissionId)))return;
  }
  if(!this.taskRequests.pending(admissionId)&&!native.unsettledTools(admissionId)&&!native.needsReview(admissionId)&&native.list(admissionId).every(task=>['completed','failed','cancelled','stopped'].includes(task.state))){this.shared.nativeTerminal(admissionId);if(this.shared.steering.enabled)this.shared.steering.closeIfFinished(admissionId);}
 }
 checkpointProof(workId,requestId,settled){const g=this.shared.steering.requestGeneration(workId,requestId);if(g&&settled.length===0&&this.db.prepare('SELECT 1 FROM shared_native_no_dispatch WHERE work_id=? AND generation=?').get(workId,g.generation))return {requestId,hash:null,settledInvocationIds:[],noDispatch:true};return this.continuations.proof(requestId,workId,settled);}
 canReview(admissionId){const rows=[...this.db.prepare('SELECT state FROM shared_native_requests WHERE admission_id=?').all(admissionId),...this.db.prepare('SELECT state FROM shared_native_child_requests WHERE work_id=?').all(admissionId)];return rows.length>0&&rows.every(r=>['model_terminal','unknown','prepared','not_dispatched'].includes(r.state));}
 close(){this.closed=true;require('../../../modules/requestExecutionContext').events.off('approval',this.approvalObserver);this.shared.events?.close?.();}
 beginDrain(){this.draining=true;this.shared.events?.close?.();}
 snapshot(){return {accepting:!this.closed&&!this.draining,dispatched:this.db.prepare("SELECT count(*) n FROM shared_native_requests WHERE state='dispatched'").get().n,held:this.db.prepare("SELECT count(*) n FROM shared_admissions WHERE state IN ('preparing','accepted','dispatched','review_required')").get().n};}
}
function withDelegationInstruction(body,{agentName,prompt}){
 const instruction=[
  'The user explicitly requested one native AgentAssistant delegation for this Work.',
  'Respond with a single native VCP tool request using tool_name AgentAssistant and exactly these arguments:',
  'agent_name: '+JSON.stringify(agentName),
  'task_delegation: true',
  'prompt: '+JSON.stringify(prompt),
  'Use the native VCP tool envelope and copy the decoded argument values exactly.',
 ].join('\n');
 const messages=[...body.messages],first=messages[0];
 if(first?.role==='system'||first?.role==='developer'){
  messages[0]={...first,content:first.content+'\n\n'+instruction};
  return {...body,messages};
 }
 messages.unshift({role:'system',content:instruction});
 const ext=body.vcpchatExtensions||{};
 return {...body,messages,vcpchatExtensions:{...ext,messageTimestampBindings:ext.messageTimestampBindings?.map(binding=>({...binding,sentMessageIndex:binding.sentMessageIndex+1}))}};
}
module.exports={SharedNative,NATIVE_INLINE_CAPABILITY};

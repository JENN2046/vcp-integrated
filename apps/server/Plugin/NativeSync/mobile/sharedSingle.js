'use strict';
const {stable,sha256}=require('../sync/protocol');
const fail=code=>Object.assign(Error(code),{code,status:409});
function acceptedActor(engine,row){
 if(row.kind==='shared_session')return require('../sync/sharedSession').acceptedActor(engine,row);
 const topic=engine.topics.get(row.topic_key),shared=engine.store.shared;
 const admission=shared?.db.prepare('SELECT * FROM shared_admissions WHERE id=?').get(row.id);
 if(!topic?.sharedSpaceId||!admission||admission.topic_id!==row.topic_key||admission.space_id!==topic.sharedSpaceId||admission.principal!=='mobile:'+row.session_id)throw fail('SHARED_REQUEST_OWNER_REQUIRED');
 // This is the server's durable accepted request, not a renewed public grant.
 return {kind:'mobile',principal:admission.principal,spaceId:admission.space_id,permissions:['execute']};
}
const mobileRequestHash=(topicKey,text,attachments)=>sha256(JSON.stringify(attachments.length?[topicKey,text,attachments]:[topicKey,text]));
const mobileMessageId=(sessionId,requestId)=>'mobile_'+sha256(sessionId+'\0'+requestId).slice(0,32);
function mobileRecoveryBound(engine,row){
 const topic=engine.topics.get(row.topic_key),db=engine.db;
 if(topic?.ownerType!=='agent'||!topic.sharedSpaceId||topic.directoryDeleted||
  row.accepted_actor!=null||row.group_plan!=null||row.group_stop_index!=null)return false;
 const admission=db.prepare('SELECT * FROM shared_admissions WHERE id=?').get(row.id);
 if(admission.topic_id!==topic.key||admission.space_id!==topic.sharedSpaceId||admission.principal!=='mobile:'+row.session_id||
  admission.request_id!==row.request_id||admission.user_seq!==row.user_seq||admission.reply_seq!=null||
  row.user_message_id!==mobileMessageId(row.session_id,row.request_id))return false;
 const original=db.prepare(`SELECT j.* FROM journal j
  JOIN applied_ops a ON a.device_id=j.device_id AND a.op_id=? AND json_extract(a.result_json,'$.seq')=j.seq
   AND json_extract(a.result_json,'$.hash')=j.hash
  WHERE j.seq=? AND j.owner_type=? AND j.owner_id=? AND j.topic_id=? AND j.msg_id=? AND j.device_id=? AND j.action='upsert'`)
  .get('shared-user:'+row.request_id,row.user_seq,topic.ownerType,topic.ownerId,topic.topicId,row.user_message_id,admission.principal);
 if(!original)return false;
 let operation,payload,message;
 try{operation=JSON.parse(admission.user_op);payload=JSON.parse(row.request_payload);message=JSON.parse(original.message_json);}catch{return false;}
 const files=payload?.attachments??[],turn=operation?.sharedTurn;
 if(payload?.requestId!==row.request_id||typeof payload.text!=='string'||!Array.isArray(files)||
  mobileRequestHash(row.topic_key,payload.text,files)!==row.request_hash||
  turn?.kind!=='message'||!Array.isArray(turn.plan)||turn.plan.length!==0||
  turn.userMessageId!==row.user_message_id||turn.topicSponsor||turn.steeringCapable||
  operation.ownerType!==topic.ownerType||operation.ownerId!==topic.ownerId||operation.topicId!==topic.topicId||
  operation.deviceId!==admission.principal||operation.opId!=='shared-user:'+row.request_id||operation.action!=='upsert'||
  operation.msgId!==row.user_message_id)return false;
 return [operation.message,message].every(m=>m?.id===row.user_message_id&&m.role==='user'&&m.content===payload.text);
}
function requeueUndispatched(engine){
 const db=engine.db;
 const tables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>row.name));
 if(!tables.has('shared_native_requests'))return;
 // A prepared request may reuse its original identity. Any evidence of
 // dispatch or child activity delegates recovery to the existing review path.
 engine.store.shared.atomic(()=>{
 const candidates=db.prepare(`SELECT e.* FROM mobile_executions e JOIN shared_admissions a ON a.id=e.id
  WHERE (e.kind IS NULL OR e.kind='shared_session') AND e.state='running' AND e.request_dispatched=0
   AND e.tool_started=0 AND e.cancel_requested=0 AND e.pending_operation IS NULL AND e.native_final_operation IS NULL
   AND e.reply_message_id IS NULL AND e.error_code IS NULL AND e.review_resolved=0 AND e.terminal_state='completed'
   AND a.state='accepted' AND a.dispatched=0 AND a.native_terminal=0
   AND NOT EXISTS (SELECT 1 FROM mobile_native_invocations i WHERE i.execution_id=e.id)
   AND NOT EXISTS (SELECT 1 FROM mobile_native_tasks t WHERE t.execution_id=e.id)
   AND NOT EXISTS (SELECT 1 FROM shared_native_requests n WHERE n.admission_id=e.id
    AND (n.state<>'prepared' OR n.id<>e.id OR n.principal<>a.principal OR n.member_id IS NOT NULL OR n.ordinal<>0))
   AND NOT EXISTS (SELECT 1 FROM mobile_execution_steps s WHERE s.job_id=e.id
    AND (s.id<>e.id OR s.step_index<>0 OR s.state<>'pending' OR s.attempts<>0 OR s.tool_started<>0
     OR s.pending_operation IS NOT NULL OR s.reply_message_id IS NOT NULL OR s.error_code IS NOT NULL))
   ${tables.has('shared_request_phases')?"AND NOT EXISTS (SELECT 1 FROM shared_request_phases p WHERE p.work_id=e.id AND (p.stage<>'native_prepared' OR p.request_id<>e.id))":''}
   ${['shared_native_child_requests','shared_native_task_controls'].filter(name=>tables.has(name))
       .map(name=>`AND NOT EXISTS (SELECT 1 FROM ${name} WHERE work_id=e.id)`).join(' ')}`).all();
 const queue=db.prepare("UPDATE mobile_executions SET state='queued',updated_at=? WHERE id=?");
 for(const row of candidates){
  if(row.kind==='shared_session'||mobileRecoveryBound(engine,row))queue.run(Date.now(),row.id);
 }
 });
}
function accept(engine,sessionId,{topicKey,requestId,text,attachments=[]}){
 const shared=engine.store.shared,topic=engine.topics.get(topicKey);
 if(topic.ownerType!=='agent')throw fail('SHARED_GROUP_EXECUTION_NOT_READY');
 if(!shared?.native)throw fail('SHARED_NATIVE_UNAVAILABLE');
 const session=engine.db.prepare('SELECT * FROM mobile_sessions WHERE id=? AND expires>?').get(sessionId,Date.now());
 const actor=shared.mobile(session&&{id:sessionId,scopes:JSON.parse(session.scopes)},topic.sharedSpaceId,'execute');
 if(typeof requestId!=='string'||!/^[a-zA-Z0-9_-]{8,80}$/.test(requestId)||typeof text!=='string'||!Array.isArray(attachments)||attachments.length>8||attachments.some(id=>typeof id!=='string')||(!text.trim()&&!attachments.length)||text.length>12000)throw fail('INVALID_TEXT_SUBMISSION');
 const requestHash=mobileRequestHash(topicKey,text,attachments);
 return shared.atomic(()=>{
  const prior=engine.db.prepare('SELECT * FROM mobile_executions WHERE session_id=? AND request_id=?').get(sessionId,requestId);
  if(prior){if(prior.request_hash!==requestHash)throw fail('REQUEST_ID_REUSED');return {...engine.public(prior,sessionId),replayed:true};}
  if(engine.quiescing)throw fail('HOST_DRAINING');
  if(engine.dependencyHeld(topicKey))throw fail('DEPENDENCY_REVIEW_REQUIRED');
  if(engine.db.prepare('SELECT count(*) n FROM mobile_executions WHERE session_id=? AND created_at>?').get(sessionId,Date.now()-60000).n>=20)throw fail('SUBMISSION_RATE_LIMIT');
  const config=engine.configs.snapshot(topic);engine.configs.assertRunnable(topic,config);
  const now=Date.now(),msgId=mobileMessageId(sessionId,requestId),row=shared.topic(actor,topic.sharedSpaceId,topic.key,'execute');
  const files=attachments.length?(engine.attachments?engine.attachments.claim(actor.principal,topicKey,attachments):(()=>{throw fail('ATTACHMENTS_NOT_ENABLED');})()):[];
  const message={id:msgId,role:'user',content:text,timestamp:now,...(files.length?{attachments:files}:{})};
  const context=require('./effectiveContext'),head=shared.head(row);
  const history=context.admissionHistory(engine.store,[topic.ownerType,topic.ownerId,topic.topicId],head);
  context.assertPortableHistory([...history,message]);
  const admitted=shared.admit(actor,{sharedSpaceId:topic.sharedSpaceId,sharedId:topic.key,requestId,expectedHead:head,configHash:config.sharedTemplateHash,message});
  engine.db.prepare("INSERT INTO mobile_executions(id,session_id,request_id,topic_key,request_hash,user_message_id,user_seq,state,created_at,updated_at,not_before,config_snapshot,request_payload) VALUES(?,?,?,?,?,?,?,'queued',?,?,?,?,?)").run(admitted.id,sessionId,requestId,topicKey,requestHash,msgId,admitted.userSeq,now,now,now+engine.startDelayMs,JSON.stringify(config),JSON.stringify({requestId,text,...(attachments.length?{attachments}:{})}));
  if(files.length)engine.attachments.bindExecution(actor.principal,topicKey,attachments,admitted.id,msgId);
  engine.wake();return {...engine.public(engine.get(admitted.id),sessionId),replayed:false};
 });
}
function register(engine,row,packet,published,replyOperation){
 const shared=engine.store.shared,topic=engine.topics.get(row.topic_key),actor=acceptedActor(engine,row);
 shared.native.prepare(actor,{sharedSpaceId:topic.sharedSpaceId,admissionId:row.id,requestId:row.id,bodyHash:sha256(stable(JSON.parse(JSON.stringify(packet))))},{session:row.kind==='shared_session'});
 return require('../../../modules/requestExecutionContext').register(row.id,published,engine.nativeTasks.hooks(row.id),{actor,admissionId:row.id,replyOperation});
}
function sealNativeFinal(request,admission,operation){
 const proof={version:1,executionId:admission.id,nativeRequestId:request.id,principal:request.principal,
  bodyHash:request.body_hash,finishReason:'stop',operation:JSON.parse(JSON.stringify(operation))};
 return JSON.stringify({...proof,digest:sha256(stable(proof))});
}
function nativeFinalOperation(engine,row){
 const request=engine.db.prepare('SELECT * FROM shared_native_requests WHERE id=? AND admission_id=?').get(row.id,row.id);
 const topic=engine.topics.get(row.topic_key);
 let record;
 try{record=JSON.parse(row.native_final_operation);}catch{throw fail('NATIVE_FINAL_PROOF_INVALID_REVIEW_REQUIRED');}
 const {digest,...proof}=record||{},op=proof.operation,m=op?.message;
 if(proof.version!==1||proof.finishReason!=='stop'||proof.executionId!==row.id||proof.nativeRequestId!==row.id||
  !request||request.state!=='model_terminal'||request.principal!==proof.principal||request.body_hash!==proof.bodyHash||
  acceptedActor(engine,row).principal!==proof.principal||digest!==sha256(stable(proof))||
  op?.ownerType!==topic?.ownerType||op?.ownerId!==topic?.ownerId||op?.topicId!==topic?.topicId||
  op?.msgId!=='reply_'+row.id||op.opId!=='reply:'+row.id||op.action!=='upsert'||
  m?.id!==op.msgId||m.role!=='assistant'||typeof m.content!=='string'||!m.content||
  m.continuity?.executionId!==row.id||m.continuity.requestId!==row.request_id){
  throw fail('NATIVE_FINAL_PROOF_INVALID_REVIEW_REQUIRED');
 }
 return op;
}
function promoteNativeFinal(engine,row){
 if((row.kind!=null&&row.kind!=='shared_session')||row.cancel_requested||engine.nativeTasks.uncertainTools(row.id)||engine.nativeTasks.needsReview(row.id))return;
 const admission=engine.db.prepare("SELECT state,dispatched,native_terminal FROM shared_admissions WHERE id=?").get(row.id);
 if(admission?.state!=='dispatched'||!admission.dispatched||!admission.native_terminal)return;
 let operation;
 try{operation=nativeFinalOperation(engine,row);}catch{return;}
 // This only recreates the existing write-ahead publication intent. The
 // scheduler never re-enters ToolBox for a final already sealed by ToolBox.
 engine.db.prepare(`UPDATE mobile_executions SET state='publishing',pending_operation=?,updated_at=?
  WHERE id=? AND state='running' AND request_dispatched=1 AND cancel_requested=0
   AND pending_operation IS NULL AND native_final_operation=?`).run(JSON.stringify(operation),Date.now(),row.id,row.native_final_operation);
}
function complete(engine,row){
 const shared=engine.store.shared,topic=engine.topics.get(row.topic_key),actor=acceptedActor(engine,row),op=JSON.parse(row.pending_operation);
 const admission=shared.admission(actor,topic.sharedSpaceId,row.id);
 if(admission.state==='abandoned')throw fail('SHARED_REQUEST_FENCED');
 if(row.terminal_state&&row.terminal_state!=='completed'){
  // Interrupted partial content is retained in the original durable operation,
  // but cannot masquerade as a successful assistant message or replay work.
  engine.db.prepare("UPDATE mobile_executions SET state=?,updated_at=? WHERE id=?").run(row.terminal_state,Date.now(),row.id);
  engine.emitEvent?.(row.id,'state',{state:row.terminal_state});return false;
 }
 if(engine.nativeTasks.needsReview(row.id,{deferReconciliation:admission.state==='dispatched'&&!admission.native_terminal})||engine.nativeTasks.unsettledTools(row.id)||shared.native?.taskRequests?.uncertain(row.id)){
  engine.db.prepare("UPDATE mobile_executions SET state='review_required',error_code='NATIVE_SETTLEMENT_REVIEW_REQUIRED' WHERE id=?").run(row.id);
  engine.db.prepare("UPDATE shared_admissions SET state='review_required' WHERE id=? AND state='dispatched'").run(row.id);return false;
 }
 if(!admission.native_terminal)return false;
 shared.complete(actor,{sharedSpaceId:topic.sharedSpaceId,admissionId:row.id,opId:'mobile-complete_'+row.id,message:op.message},{session:row.kind==='shared_session'});
 engine.db.prepare("UPDATE mobile_executions SET state='completed',reply_message_id=?,pending_operation=NULL,native_final_operation=NULL,updated_at=? WHERE id=?").run(op.msgId,Date.now(),row.id);engine.emitEvent?.(row.id,'completed',{});return true;
}
function hold(engine,row){
 const shared=engine.store.shared;if(!shared)return;
 shared.db.prepare("UPDATE shared_admissions SET state='review_required' WHERE id=? AND state IN ('accepted','dispatched')").run(row.id);
}
function abandon(engine,row){
 const shared=engine.store.shared,topic=engine.topics.get(row.topic_key),actor=acceptedActor(engine,row);
 return shared.abandon(actor,{sharedSpaceId:topic.sharedSpaceId,admissionId:row.id,opId:'mobile-abandon_'+row.id,confirm:true});
}
module.exports={accept,register,complete,hold,abandon,acceptedActor,promoteNativeFinal,sealNativeFinal,nativeFinalOperation,requeueUndispatched};

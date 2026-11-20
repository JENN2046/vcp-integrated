'use strict';
const {stable,sha256}=require('./protocol');
const {sharedIdentity}=require('./contracts.generated.cjs');
const fail=(code,status=409)=>Object.assign(Error(code),{code,status});
const CAPABILITY='shared-session-v1';

// Accepted authority is persisted with the existing execution intent. It is not
// a new grant, and browser-supplied identities never enter this function.
function actorRecord(actor){
 if(actor?.kind==='desktop')return {kind:'desktop',principal:actor.principal,sourceId:actor.sourceId,deviceId:actor.deviceId,capabilities:actor.capabilities||''};
 if(actor?.kind==='mobile')return {kind:'mobile',principal:actor.principal,spaceId:actor.spaceId,permissions:['execute']};
 throw fail('SHARED_PERMISSION_REQUIRED',403);
}
function acceptedActor(engine,row){
 const shared=engine.store.shared,admission=shared?.db.prepare('SELECT * FROM shared_admissions WHERE id=?').get(row.id),topic=engine.topics.get(row.topic_key);
 let actor;try{actor=JSON.parse(row.accepted_actor);}catch{throw fail('SHARED_EXECUTION_CONTRACT_CORRUPT');}
 if(!actor||stable(actor)!==stable(actorRecord(actor)))throw fail('SHARED_EXECUTION_CONTRACT_CORRUPT');
 if(!admission||!topic||admission.topic_id!==row.topic_key||admission.space_id!==topic.sharedSpaceId||admission.principal!==actor?.principal)throw fail('SHARED_REQUEST_OWNER_REQUIRED',403);
 if(actor.kind==='desktop'){
  if(actor.principal!=='desktop:'+actor.deviceId)throw fail('SHARED_REQUEST_OWNER_REQUIRED',403);
  actor=shared.desktop({sourceId:actor.sourceId,deviceId:actor.deviceId,spaceId:shared.catalog.spaceId},actor.capabilities);
 }else if(actor.kind!=='mobile'||actor.spaceId!==admission.space_id||!Array.isArray(actor.permissions)||stable(actor.permissions)!==stable(['execute']))throw fail('SHARED_REQUEST_OWNER_REQUIRED',403);
 shared.authorize(actor,admission.space_id,'execute');return actor;
}
function portable(shared,topic,config,message){
 const engine=shared.native.engine,descriptor=engine.topics.get(topic.id);
 if(!descriptor||descriptor.ownerType!=='agent'||!config.execution)throw fail('SHARED_CONFIG_PENDING');
 engine.configs.verify(descriptor,config.execution);engine.configs.assertRunnable(descriptor,config.execution);
 const records=shared.store.readProjected(()=>shared.db.prepare('SELECT * FROM messages WHERE owner_type=? AND owner_id=? AND topic_id=? AND deleted=0 ORDER BY last_seq').all(topic.owner_type,topic.owner_id,topic.topic_id));
 const messages=[...records.map(r=>r.message),message];
 if(messages.some(m=>m.desktopReferences?.length))throw fail('DESKTOP_CONTEXT_REQUIRED');
 require('../mobile/groupRequest').assertPortableContext(messages);
}
function result(shared,row,replayed){
 return {...shared.publicAdmission(shared.db.prepare('SELECT * FROM shared_admissions WHERE id=?').get(row.id)),workId:row.id,replayed,execution:shared.native.engine.public(row,null)};
}
function reviewable(shared,execution,admission){
 const neverDispatched=!admission.dispatched&&!admission.native_terminal&&!execution.tool_started&&(execution.request_dispatched===0||execution.state==='queued')
  &&!shared.db.prepare("SELECT 1 FROM shared_native_requests WHERE admission_id=? AND state<>'prepared' LIMIT 1").get(admission.id)
  &&!shared.db.prepare('SELECT 1 FROM mobile_native_invocations WHERE execution_id=? LIMIT 1').get(admission.id)
  &&!shared.db.prepare('SELECT 1 FROM mobile_native_tasks WHERE execution_id=? LIMIT 1').get(admission.id);
 return Boolean(neverDispatched||shared.native?.canReview(admission.id));
}
function settleAbandon(shared,execution){
 // This acknowledges an explicit review decision. Unknown tool/task facts and
 // the original partial result remain available; no task is claimed stopped.
 shared.db.prepare("UPDATE mobile_executions SET state='cancelled',cancel_requested=1,review_resolved=1,updated_at=? WHERE id=? AND kind='shared_session'").run(Date.now(),execution.id);
 shared.db.prepare("UPDATE mobile_execution_steps SET state='cancelled' WHERE job_id=? AND state='queued'").run(execution.id);
 shared.native.engine.nativeTasks.acknowledge(execution.id);
}
function send(shared,actor,body,sponsor=null){
 const sponsored=sponsor===require('./sharedTopicSponsor').dispatchKey;
 if(shared.readOnly)throw fail('SHARED_READ_ONLY');
 const engine=shared.native?.engine;if(!engine)throw fail('SHARED_NATIVE_UNAVAILABLE');
 const topic=shared.topic(actor,body.sharedSpaceId,body.sharedId,'execute');
 if(topic.owner_type!=='agent')throw fail('SHARED_SESSION_SINGLE_REQUIRED');
 sharedIdentity(body.requestId);if(body.admissionId!==undefined)sharedIdentity(body.admissionId);
  if(!body.message||body.message.role!==(sponsored?'assistant':'user')||typeof body.message.content!=='string'||!body.message.content.trim())throw fail('INVALID_SHARED_SUBMISSION',400);
 const {admissionId,...submission}=body,hash=sha256(stable(submission));
 const response=shared.atomic(()=>{
  const admission=admissionId?shared.admission(actor,body.sharedSpaceId,admissionId):shared.db.prepare('SELECT * FROM shared_admissions WHERE principal=? AND request_id=?').get(actor.principal,body.requestId);
  if(admission){
   if(admission.space_id!==body.sharedSpaceId||admission.topic_id!==topic.id)throw fail('SHARED_REQUEST_OWNER_REQUIRED',403);
   const row=engine.get(admission.id);
   if(!row||row.kind!=='shared_session'||row.request_hash!==hash)throw fail('REQUEST_ID_REUSED');
   return result(shared,row,true);
  }
  if(admissionId)throw fail('SHARED_REQUEST_NOT_FOUND',404);
  if(engine.quiescing||engine.draining)throw fail('HOST_DRAINING',503);
  if(engine.dependencyHeld(topic.id))throw fail('DEPENDENCY_REVIEW_REQUIRED');
  const config=shared.freezeForExecution(actor,topic);portable(shared,topic,config,body.message);
  // This route deliberately preserves ordinary single-turn semantics even if
  // the client also supports the separately gated steering experiment.
  const acceptedActor=actorRecord(actor),ordinary={...actor,capabilities:String(actor.capabilities||'').split(',').filter(c=>c!=='shared-steering-v1').join(',')};
  const accepted=shared.admit(ordinary,submission,{session:true,sponsor}),now=Date.now();
  engine.db.prepare("INSERT INTO mobile_executions(id,session_id,request_id,topic_key,request_hash,user_message_id,user_seq,state,created_at,updated_at,not_before,config_snapshot,request_payload,kind,accepted_actor) VALUES(?,?,?,?,?,?,?,'queued',?,?,?,?,?,'shared_session',?)").run(accepted.id,actor.principal,body.requestId,topic.id,hash,body.message.id,accepted.userSeq,now,now,now+engine.startDelayMs,JSON.stringify(config.execution),JSON.stringify(submission),JSON.stringify(acceptedActor));
  engine.fault('session-accepted-intent');
  return result(shared,engine.get(accepted.id),false);
 });
 if(!sponsored)notify(engine,response);return response;
}
function notify(engine,response){engine.fault('session-accepted-committed');engine.emitEvent?.(response.workId,'state',{state:response.execution.state});engine.wake();}
module.exports={CAPABILITY,send,notify,acceptedActor,actorRecord,reviewable,settleAbandon};

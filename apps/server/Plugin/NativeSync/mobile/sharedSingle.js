'use strict';
const {stable,sha256}=require('../sync/protocol');
const fail=code=>Object.assign(Error(code),{code,status:409});
function acceptedActor(engine,row){
 if(row.kind==='shared_session')return require('../sync/sharedSession').acceptedActor(engine,row);
 const topic=engine.topics.get(row.topic_key),shared=engine.store.shared;
 const admission=shared?.db.prepare('SELECT * FROM shared_admissions WHERE id=?').get(row.id);
 if(!topic?.sharedSpaceId||!admission||admission.space_id!==topic.sharedSpaceId||admission.principal!=='mobile:'+row.session_id)throw fail('SHARED_REQUEST_OWNER_REQUIRED');
 // This is the server's durable accepted request, not a renewed public grant.
 return {kind:'mobile',principal:admission.principal,spaceId:admission.space_id,permissions:['execute']};
}
function accept(engine,sessionId,{topicKey,requestId,text,attachments=[]}){
 const shared=engine.store.shared,topic=engine.topics.get(topicKey);
 if(topic.ownerType!=='agent')throw fail('SHARED_GROUP_EXECUTION_NOT_READY');
 if(!shared?.native)throw fail('SHARED_NATIVE_UNAVAILABLE');
 const session=engine.db.prepare('SELECT * FROM mobile_sessions WHERE id=? AND expires>?').get(sessionId,Date.now());
 const actor=shared.mobile(session&&{id:sessionId,scopes:JSON.parse(session.scopes)},topic.sharedSpaceId,'execute');
 if(typeof requestId!=='string'||!/^[a-zA-Z0-9_-]{8,80}$/.test(requestId)||typeof text!=='string'||!Array.isArray(attachments)||attachments.length>8||attachments.some(id=>typeof id!=='string')||(!text.trim()&&!attachments.length)||text.length>12000)throw fail('INVALID_TEXT_SUBMISSION');
 const requestHash=sha256(JSON.stringify(attachments.length?[topicKey,text,attachments]:[topicKey,text]));
 return shared.atomic(()=>{
  const prior=engine.db.prepare('SELECT * FROM mobile_executions WHERE session_id=? AND request_id=?').get(sessionId,requestId);
  if(prior){if(prior.request_hash!==requestHash)throw fail('REQUEST_ID_REUSED');return {...engine.public(prior,sessionId),replayed:true};}
  if(engine.quiescing)throw fail('HOST_DRAINING');
  if(engine.dependencyHeld(topicKey))throw fail('DEPENDENCY_REVIEW_REQUIRED');
  if(engine.db.prepare('SELECT count(*) n FROM mobile_executions WHERE session_id=? AND created_at>?').get(sessionId,Date.now()-60000).n>=20)throw fail('SUBMISSION_RATE_LIMIT');
  const config=engine.configs.snapshot(topic);engine.configs.assertRunnable(topic,config);
  const now=Date.now(),msgId='mobile_'+sha256(sessionId+'\0'+requestId).slice(0,32),row=shared.topic(actor,topic.sharedSpaceId,topic.key,'execute');
  const files=attachments.length?(engine.attachments?engine.attachments.claim(actor.principal,topicKey,attachments):(()=>{throw fail('ATTACHMENTS_NOT_ENABLED');})()):[];
  const admitted=shared.admit(actor,{sharedSpaceId:topic.sharedSpaceId,sharedId:topic.key,requestId,expectedHead:shared.head(row),configHash:config.sharedTemplateHash,message:{id:msgId,role:'user',content:text,timestamp:now,...(files.length?{attachments:files}:{})}});
  engine.db.prepare("INSERT INTO mobile_executions(id,session_id,request_id,topic_key,request_hash,user_message_id,user_seq,state,created_at,updated_at,not_before,config_snapshot,request_payload) VALUES(?,?,?,?,?,?,?,'queued',?,?,?,?,?)").run(admitted.id,sessionId,requestId,topicKey,requestHash,msgId,admitted.userSeq,now,now,now+engine.startDelayMs,JSON.stringify(config),JSON.stringify({requestId,text,...(attachments.length?{attachments}:{})}));
  if(files.length)engine.attachments.bindExecution(actor.principal,topicKey,attachments,admitted.id,msgId);
  engine.wake();return {...engine.public(engine.get(admitted.id),sessionId),replayed:false};
 });
}
function register(engine,row,packet,published){
 const shared=engine.store.shared,topic=engine.topics.get(row.topic_key),actor=acceptedActor(engine,row);
 shared.native.prepare(actor,{sharedSpaceId:topic.sharedSpaceId,admissionId:row.id,requestId:row.id,bodyHash:sha256(stable(JSON.parse(JSON.stringify(packet))))},{session:row.kind==='shared_session'});
 return require('../../../modules/requestExecutionContext').register(row.id,published,engine.nativeTasks.hooks(row.id),{actor,admissionId:row.id});
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
 engine.db.prepare("UPDATE mobile_executions SET state='completed',reply_message_id=?,pending_operation=NULL,updated_at=? WHERE id=?").run(op.msgId,Date.now(),row.id);engine.emitEvent?.(row.id,'completed',{});return true;
}
function hold(engine,row){
 const shared=engine.store.shared;if(!shared)return;
 shared.db.prepare("UPDATE shared_admissions SET state='review_required' WHERE id=? AND state IN ('accepted','dispatched')").run(row.id);
}
function abandon(engine,row){
 const shared=engine.store.shared,topic=engine.topics.get(row.topic_key),actor=acceptedActor(engine,row);
 return shared.abandon(actor,{sharedSpaceId:topic.sharedSpaceId,admissionId:row.id,opId:'mobile-abandon_'+row.id,confirm:true});
}
module.exports={accept,register,complete,hold,abandon,acceptedActor};

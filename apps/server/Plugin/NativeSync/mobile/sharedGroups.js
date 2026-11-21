'use strict';
const {sha256,stable}=require('../sync/protocol');
const {acceptedActor}=require('./sharedSingle');
const fail=code=>Object.assign(Error(code),{code,status:409});
function admit(engine,sessionId,input,topic,config,message,invitation){
 const shared=engine.store.shared;if(!shared?.native)throw fail('SHARED_NATIVE_UNAVAILABLE');
 const session=engine.db.prepare('SELECT * FROM mobile_sessions WHERE id=? AND expires>?').get(sessionId,Date.now());
 const actor=shared.mobile(session&&{id:sessionId,scopes:JSON.parse(session.scopes)},topic.sharedSpaceId,'execute');
 const row=shared.topic(actor,topic.sharedSpaceId,topic.key,'execute');
 return shared.admit(actor,{sharedSpaceId:topic.sharedSpaceId,sharedId:topic.key,requestId:input.requestId,expectedHead:shared.head(row),configHash:config.sharedTemplateHash,...(invitation?{kind:'invite',memberId:input.agentId}:{message})});
}
function register(engine,job,candidate,packet,member){
 const shared=engine.store.shared,topic=engine.topics.get(job.topic_key),actor=acceptedActor(engine,job);
 shared.prepareNative(actor,{sharedSpaceId:topic.sharedSpaceId,admissionId:job.id,requestId:candidate.id,memberId:member.id,bodyHash:sha256(stable(JSON.parse(JSON.stringify(packet))))});
 return require('../../../modules/requestExecutionContext').register(candidate.id,member,engine.nativeTasks.hooks(job.id,candidate.id),{actor,admissionId:job.id});
}
function completeStep(engine,step,op){
 const job=engine.get(step.job_id),shared=engine.store.shared,topic=engine.topics.get(job.topic_key);
 return shared.complete(acceptedActor(engine,job),{sharedSpaceId:topic.sharedSpaceId,admissionId:job.id,opId:'mobile-step_'+step.id,nativeRequestId:step.id,message:op.message});
}
function hasLiveSettlement(engine,id){
 const native=engine.store.shared.native,tasks=engine.nativeTasks,db=engine.db;
 // A restart marks live projections for one native read. Give that read a
 // chance to return the already-written AA archive when no request was lost.
 if(tasks.needsReview(id,{deferReconciliation:true})||native.taskRequests.uncertain(id)||
    db.prepare("SELECT 1 FROM shared_native_requests WHERE admission_id=? AND state='unknown'").get(id)||
    db.prepare("SELECT 1 FROM mobile_native_invocations WHERE execution_id=? AND state='error' AND coalesce(error_code,'')<>'NATIVE_CANCELLED_BEFORE_EXECUTION'").get(id))return false;
 return Boolean(db.prepare("SELECT 1 FROM shared_native_requests WHERE admission_id=? AND state='dispatched'").get(id)||
                db.prepare("SELECT 1 FROM shared_native_child_requests WHERE work_id=? AND state='dispatched'").get(id)||
                db.prepare(`SELECT 1 FROM mobile_native_tasks WHERE execution_id=? AND (state IN ('accepted','running','waiting','cancelling') OR
                 (state='unknown' AND error_code='NATIVE_TASK_RECONCILIATION_REQUIRED'))`).get(id));
}
function finish(engine,job){
 const shared=engine.store.shared,topic=engine.topics.get(job.topic_key),actor=acceptedActor(engine,job);
 const admission=shared.admission(actor,topic.sharedSpaceId,job.id);
 if(admission.state!=='completed')shared.native.checkTerminal(job.id,{advanceGroup:false});
 const result=shared.complete(actor,{sharedSpaceId:topic.sharedSpaceId,admissionId:job.id,opId:'mobile-group-finish_'+job.id,finish:true});
 if(result.replayed){
  if(admission.state!=='completed')throw fail('SHARED_NATIVE_TERMINAL_REQUIRED');
  const source=shared.topic(actor,topic.sharedSpaceId,topic.key,'execute');
  require('../sync/sharedTurns').verifyGroupFinish(shared,source,admission);
 }
 return result;
}
module.exports={admit,register,completeStep,finish,hasLiveSettlement};

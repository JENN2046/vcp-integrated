'use strict';
const {sha256,stable}=require('./protocol');
const fail=code=>Object.assign(Error(code),{code});
const context=require('../../../modules/requestExecutionContext');

/** A trusted AA child request, not a second scheduler or client-supplied authority. */
class SharedTaskRequests{
 constructor(native){this.native=native;this.shared=native.shared;this.db=native.db;this.db.exec(`CREATE TABLE IF NOT EXISTS shared_native_child_requests(id TEXT PRIMARY KEY,work_id TEXT NOT NULL,plugin_name TEXT NOT NULL,task_id TEXT NOT NULL,body_hash TEXT NOT NULL,model TEXT NOT NULL,control_revision INTEGER NOT NULL,state TEXT NOT NULL);`);this.db.prepare("UPDATE shared_native_child_requests SET state='unknown' WHERE state='dispatched'").run();}
 pending(workId){return Boolean(this.db.prepare("SELECT 1 FROM shared_native_child_requests WHERE work_id=? AND state IN ('prepared','dispatched','unknown') LIMIT 1").get(workId));}
 uncertain(workId){
  return Boolean(this.db.prepare(`SELECT 1 FROM shared_native_child_requests r WHERE r.work_id=? AND
   (r.state='unknown' OR EXISTS (SELECT 1 FROM mobile_native_invocations i WHERE i.native_request_id=r.id AND i.execution_id=r.work_id
    AND (i.state='error' AND coalesce(i.error_code,'')<>'NATIVE_CANCELLED_BEFORE_EXECUTION' OR i.state='started' AND r.state='model_terminal'))) LIMIT 1`).get(workId));
 }
 resumeAllowed(workId){return !this.db.prepare("SELECT 1 FROM shared_admissions WHERE id=? AND state='review_required'").get(workId)&&!this.db.prepare("SELECT 1 FROM shared_native_requests WHERE admission_id=? AND state='unknown'").get(workId)&&!this.db.prepare("SELECT 1 FROM shared_native_child_requests WHERE work_id=? AND state='unknown'").get(workId)&&!this.db.prepare("SELECT 1 FROM mobile_native_invocations WHERE execution_id=? AND state='error' AND coalesce(error_code,'')<>'NATIVE_CANCELLED_BEFORE_EXECUTION'").get(workId);}
 fence(workId,identity,revision){
  if(this.native.closed||this.native.draining)throw fail('HOST_DRAINING');
  const row=this.native.taskControls.row(workId,identity),control=this.native.taskControls.ensure(workId,identity),work=this.db.prepare('SELECT state FROM shared_admissions WHERE id=?').get(workId),current=this.db.prepare('SELECT revision FROM shared_work_controls WHERE work_id=?').get(workId)?.revision||0;
  if(!work||work.state!=='dispatched'||['completed','failed','cancelled','stopped'].includes(row.state)||control.final_revision!==null)throw fail('NATIVE_TASK_CONTROL_CLOSED');
  if(!this.resumeAllowed(workId))throw fail('NATIVE_TASK_RESULT_REQUIRES_REVIEW');
  if(current!==revision||control.applied_revision!==revision)throw fail('WORK_STEERING_PENDING');
 }
 binding(workId,identity,actor){
  this.native.taskControls.ensure(workId,identity);
  return Object.freeze({workId,resumeAllowed:()=>this.resumeAllowed(workId),
   registerRequest:(body,revision)=>this.prepare(workId,identity,body,revision,actor),
   childState:requestId=>this.childState(workId,identity,requestId),
   applied:receipt=>this.native.taskControls.observe(this.native.taskControls.row(workId,identity),receipt),
   workRevision:()=>this.db.prepare('SELECT revision FROM shared_work_controls WHERE work_id=?').get(workId)?.revision||0,
   finalRevision:()=>this.native.taskControls.get(identity)?.final_revision??null,
   claimFinal:revision=>this.native.taskControls.claimFinal(workId,identity,revision),
   assertCurrent:revision=>this.fence(workId,identity,revision),
   refresh:()=>this.native.taskControls.request(workId),
  });
 }
 prepare(workId,identity,body,revision,actor){
  this.fence(workId,identity,revision);
  if(typeof body.requestId!=='string'||body.requestId.length>256||!Array.isArray(body.messages)||typeof body.model!=='string')throw fail('INVALID_NATIVE_CHILD_REQUEST');
  const normalized=JSON.parse(JSON.stringify(body)),hash=sha256(stable(normalized));
  const row=this.native.taskControls.row(workId,identity),admission=this.db.prepare('SELECT * FROM shared_admissions WHERE id=?').get(workId);
  // Older native control handles restored after a restart have no live actor.
  // Only their recorded desktop admission can rebind through its current membership.
  if(!actor&&admission.principal.startsWith('desktop:')){
   const member=this.db.prepare('SELECT source_id,device_id FROM shared_members WHERE space_id=? AND device_id=?').get(admission.space_id,admission.principal.slice(8));
   if(member)actor={kind:'desktop',principal:admission.principal,sourceId:member.source_id,deviceId:member.device_id};
  }
  if(!actor||actor.principal!==admission.principal)throw fail('SHARED_REQUEST_OWNER_REQUIRED');
  this.shared.topic(actor,admission.space_id,admission.topic_id,'execute');
  this.shared.atomic(()=>{
   const previous=this.db.prepare('SELECT * FROM shared_native_child_requests WHERE id=?').get(body.requestId);
   if(previous){if(previous.work_id!==workId||previous.task_id!==identity.nativeTaskId||previous.body_hash!==hash||previous.control_revision!==revision)throw fail('REQUEST_ID_REUSED');if(previous.state!=='prepared')throw fail('SHARED_RESULT_REQUIRES_REVIEW');return;}
   this.db.prepare("UPDATE shared_native_child_requests SET state='not_dispatched' WHERE work_id=? AND task_id=? AND state='prepared' AND control_revision<?").run(workId,identity.nativeTaskId,revision);
   if(this.db.prepare("SELECT 1 FROM shared_native_child_requests WHERE work_id=? AND task_id=? AND state IN ('prepared','dispatched','unknown')").get(workId,identity.nativeTaskId))throw fail('NATIVE_TASK_REQUEST_BUSY');
   const model=this.db.prepare('SELECT model FROM shared_native_child_requests WHERE work_id=? AND task_id=? LIMIT 1').get(workId,identity.nativeTaskId)?.model;
   if(model&&model!==body.model)throw fail('NATIVE_TASK_MODEL_CHANGED');
   this.db.prepare("INSERT INTO shared_native_child_requests VALUES(?,?,?,?,?,?,?,'prepared')").run(body.requestId,workId,identity.pluginName,identity.nativeTaskId,hash,body.model,revision);
   const ordinal=Number(this.db.prepare('SELECT coalesce(min(step_index),0)-1 n FROM mobile_execution_steps WHERE job_id=?').get(workId).n);
   this.db.prepare("INSERT INTO mobile_execution_steps(id,job_id,step_index,agent_id,state,created_at,updated_at) VALUES(?,?,?,?,'pending',?,?)").run(body.requestId,workId,ordinal,row.agent_base_name,Date.now(),Date.now());
  });
  return context.register(body.requestId,{},null,{kind:'native-task',actor,admissionId:workId,identity,controlRevision:revision});
 }
 enter(req,authority){
  const workId=authority.admissionId,identity=authority.identity,row=this.db.prepare('SELECT * FROM shared_native_child_requests WHERE id=?').get(req.body?.requestId);
  if(!row||row.work_id!==workId||row.task_id!==identity.nativeTaskId||row.plugin_name!==identity.pluginName||row.control_revision!==authority.controlRevision||row.body_hash!==sha256(stable(req.body))||row.model!==req.body.model)throw fail('NATIVE_TASK_CONTROL_IDENTITY_CHANGED');
  this.fence(workId,identity,row.control_revision);
  const admission=this.db.prepare('SELECT * FROM shared_admissions WHERE id=?').get(workId);
  if(authority.actor?.principal!==admission.principal)throw fail('SHARED_REQUEST_OWNER_REQUIRED');
  this.shared.topic(authority.actor,admission.space_id,admission.topic_id,'execute');
  if(row.state!=='prepared')throw fail('SHARED_REQUEST_ALREADY_DISPATCHED');
  this.native.continuations.begin({workId,requestId:row.id,generation:row.control_revision,controlRevision:row.control_revision},req.body.messages,req.body.vcpchatExtensions||{});
  this.db.prepare("UPDATE shared_native_child_requests SET state='dispatched' WHERE id=?").run(row.id);
  const base=this.native.engine.nativeTasks.hooks(workId,row.id),fence=()=>this.fence(workId,identity,row.control_revision);
  const bridge={...base,onToolDispatch:event=>{fence();return base.onToolDispatch(event)},onTaskAccepted:event=>{fence();return base.onTaskAccepted(event)},
   onToolSettled:event=>{const result=base.onToolSettled(event);this.native.checkTerminal(workId);return result;}};
  const steeringEnabled=require('./sharedTurns').intent(admission).steeringCapable===true;let ended=false;
  return {phase:name=>this.native.phase(workId,row.id,name),steeringEnabled,workId,generation:row.control_revision,fence,bridge,continuation:body=>body,
   checkpoint:{completion:value=>this.native.continuations.completion(row.id,value),assistant:content=>this.native.continuations.assistant(row.id,content),result:(invocation,value)=>this.native.continuations.result(row.id,invocation,value)},
   finish:success=>{if(ended)return;ended=true;const current=this.db.prepare('SELECT revision FROM shared_work_controls WHERE work_id=?').get(workId)?.revision||0;this.db.prepare('UPDATE shared_native_child_requests SET state=? WHERE id=?').run(success||current>row.control_revision?'model_terminal':'unknown',row.id);this.native.checkTerminal(workId);},
  };
 }
 childState(workId,identity,requestId){
  this.native.taskControls.row(workId,identity);const row=this.db.prepare('SELECT * FROM shared_native_child_requests WHERE id=? AND work_id=? AND task_id=?').get(requestId,workId,identity.nativeTaskId);
  if(!row)return {state:'not_started'};const tasks=this.native.engine.nativeTasks;
  if(row.state==='unknown'||this.db.prepare("SELECT 1 FROM mobile_native_invocations WHERE native_request_id=? AND state='error' AND coalesce(error_code,'')<>'NATIVE_CANCELLED_BEFORE_EXECUTION'").get(row.id))return {state:'review_required'};
  if(row.state==='dispatched'||tasks.unsettledTools(workId,row.id))return {state:'waiting_safe_boundary'};
  if(['prepared','not_dispatched'].includes(row.state))return {state:'not_started'};
  const ids=this.db.prepare("SELECT invocation_id FROM mobile_native_invocations WHERE execution_id=? AND native_request_id=? AND (state='returned' OR (state='error' AND error_code='NATIVE_CANCELLED_BEFORE_EXECUTION')) ORDER BY invocation_id").all(workId,row.id).map(v=>v.invocation_id);
  return {state:'safe',response:this.native.continuations.read(row.id)?.completion||null,messages:this.native.continuations.context(row.id,{workId,settledInvocationIds:ids}),proof:this.native.continuations.proof(row.id,workId,ids)};
 }
}
module.exports={SharedTaskRequests};

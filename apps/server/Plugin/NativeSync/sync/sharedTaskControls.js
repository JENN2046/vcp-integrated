'use strict';
const nativeContext=require('../../../modules/requestExecutionContext');
const {sha256,stable}=require('./protocol');
const fail=code=>Object.assign(Error(code),{code});

class SharedTaskControls {
 constructor(shared){
  this.shared=shared;this.db=shared.db;this.tails=new Map();
  this.db.exec(`CREATE TABLE IF NOT EXISTS shared_native_task_controls(plugin_name TEXT NOT NULL,native_task_id TEXT NOT NULL,work_id TEXT NOT NULL,desired_revision INTEGER NOT NULL DEFAULT 0,applied_revision INTEGER NOT NULL DEFAULT 0,final_revision INTEGER,receipt_json TEXT,PRIMARY KEY(plugin_name,native_task_id));`);
 }
 identity(row){return {pluginName:row.plugin_name,nativeTaskId:row.native_task_id,agentBaseName:row.agent_base_name,nativeRequestId:row.native_request_id,invocationId:row.invocation_id,recordId:row.record_id};}
 row(workId,identity){const row=this.shared.native.engine.nativeTasks.get(identity.pluginName,identity.nativeTaskId);if(!row||row.execution_id!==workId||!this.shared.native.engine.nativeTasks.matches(row,identity))throw fail('NATIVE_TASK_CONTROL_IDENTITY_CHANGED');return row;}
 get(identity){return this.db.prepare('SELECT * FROM shared_native_task_controls WHERE plugin_name=? AND native_task_id=?').get(identity.pluginName,identity.nativeTaskId);}
 ensure(workId,identity){this.row(workId,identity);this.db.prepare('INSERT OR IGNORE INTO shared_native_task_controls(plugin_name,native_task_id,work_id) VALUES(?,?,?)').run(identity.pluginName,identity.nativeTaskId,workId);return this.get(identity);}
 request(workId){
  const prior=this.tails.get(workId)||Promise.resolve();const next=prior.catch(()=>{}).then(()=>this.send(workId));this.tails.set(workId,next);next.finally(()=>{if(this.tails.get(workId)===next)this.tails.delete(workId);}).catch(()=>{});return next;
 }
 async send(workId){
  const control=this.db.prepare('SELECT * FROM shared_work_controls WHERE work_id=?').get(workId);if(!control||control.revision===0)return;
  const work=this.db.prepare('SELECT * FROM shared_admissions WHERE id=?').get(workId);if(!work)return;
  const inputs=this.db.prepare('SELECT * FROM shared_work_inputs WHERE work_id=? AND input_seq<=? ORDER BY input_seq').all(workId,control.revision);
  const ready=inputs.every(i=>i.attachments_ready&&i.journal_seq);const tasks=this.shared.native.engine.nativeTasks;
  for(const row of this.db.prepare("SELECT * FROM mobile_native_tasks WHERE execution_id=? AND state NOT IN ('completed','failed','cancelled','stopped')").all(workId)){
   const identity=this.identity(row),entry=this.ensure(workId,identity);if(entry.final_revision!==null)continue;
   this.db.prepare('UPDATE shared_native_task_controls SET desired_revision=? WHERE plugin_name=? AND native_task_id=?').run(control.revision,identity.pluginName,identity.nativeTaskId);
   const values=inputs.map(i=>({inputId:i.input_id,inputSeq:i.input_seq,message:JSON.parse(i.message_json)}));
   if(ready)for(const value of values)if(value.message.attachments?.length){
    if(!this.shared.store.attachments)throw fail('ATTACHMENTS_NOT_ENABLED');
    value.modelContent=await this.shared.store.attachments.content(work.topic_id,value.message,true,{bytes:0});
   }
   try{
    const query=await nativeContext.queryNativeTask(identity.pluginName,identity),revision=query.control?.controlRevision||0;
    if(query.control){this.observe(row,query.control);if(query.control.controlRevision===control.revision&&stable(query.control.inputRefs)===stable(values.map(v=>v.inputId))&&(!ready||query.control.dependenciesReady===true))continue;}
    const request={workId,opId:'steer-task:'+sha256(stable([workId,identity,control.revision,ready])).slice(0,40),expectedRevision:revision,controlRevision:control.revision,inputRefs:values.map(v=>v.inputId),inputs:values,ready};
    const receipt=await nativeContext.controlNativeTask(identity.pluginName,identity,request);
    this.observe(row,receipt);
   }catch(error){this.db.prepare('UPDATE shared_native_task_controls SET receipt_json=? WHERE plugin_name=? AND native_task_id=?').run(JSON.stringify({state:'blocked',code:error.code||'NATIVE_TASK_CONTROL_UNAVAILABLE'}),identity.pluginName,identity.nativeTaskId);}
  }
 }
 observe(row,receipt){
  const identity=this.identity(row),entry=this.get(identity);if(!entry)return;
  if(!receipt?.identity||!this.shared.native.engine.nativeTasks.matches(row,receipt.identity)||receipt?.workId!==row.execution_id||!Number.isSafeInteger(receipt.controlRevision)||receipt.controlRevision>entry.desired_revision||!Number.isSafeInteger(receipt.appliedControlRevision)||receipt.appliedControlRevision>receipt.controlRevision)throw fail('NATIVE_TASK_CONTROL_RECEIPT_INVALID');
  if(receipt.controlRevision<entry.applied_revision)return;
  this.db.prepare('UPDATE shared_native_task_controls SET applied_revision=?,receipt_json=? WHERE plugin_name=? AND native_task_id=?').run(Math.max(entry.applied_revision,receipt.appliedControlRevision),JSON.stringify(receipt),identity.pluginName,identity.nativeTaskId);
 }
 public(row){const entry=this.get(this.identity(row));if(!entry)return {};let receipt={};try{receipt=JSON.parse(entry.receipt_json||'{}');}catch{}
  return {controlRevision:entry.desired_revision,appliedControlRevision:entry.applied_revision,safeBoundary:receipt.safeBoundary===true||entry.applied_revision>=entry.desired_revision,controlState:receipt.state,controlError:receipt.code,finalControlRevision:entry.final_revision};
 }
 claimFinal(workId,identity,revision){
  this.row(workId,identity);
  return this.shared.atomic(()=>{
   const entry=this.ensure(workId,identity),work=this.db.prepare('SELECT revision FROM shared_work_controls WHERE work_id=?').get(workId),current=work?.revision||0;
   if(entry.final_revision!==null){if(entry.final_revision===revision)return true;throw fail('NATIVE_TASK_CONTROL_FINAL_CHANGED');}
   if(current!==revision||entry.applied_revision!==revision)throw fail('WORK_STEERING_PENDING');
   if(this.db.prepare("SELECT 1 FROM shared_native_child_requests WHERE work_id=? AND task_id=? AND state IN ('dispatched','unknown')").get(workId,identity.nativeTaskId))throw fail('NATIVE_TASK_RESULT_REQUIRES_REVIEW');
   if(this.db.prepare(`SELECT 1 FROM mobile_native_invocations i JOIN shared_native_child_requests r ON r.id=i.native_request_id
     WHERE r.work_id=? AND r.task_id=? AND i.execution_id=r.work_id AND i.state<>'returned' AND (i.state<>'error' OR coalesce(i.error_code,'')<>'NATIVE_CANCELLED_BEFORE_EXECUTION')`).get(workId,identity.nativeTaskId))throw fail('NATIVE_TASK_RESULT_REQUIRES_REVIEW');
   this.db.prepare("UPDATE shared_native_child_requests SET state='not_dispatched' WHERE work_id=? AND task_id=? AND state='prepared'").run(workId,identity.nativeTaskId);
   if(entry.final_revision!==null&&entry.final_revision!==revision)throw fail('NATIVE_TASK_CONTROL_FINAL_CHANGED');
   this.db.prepare('UPDATE shared_native_task_controls SET final_revision=? WHERE plugin_name=? AND native_task_id=?').run(revision,identity.pluginName,identity.nativeTaskId);return true;
  });
 }
 verifyFinal(row,data){const entry=this.get(this.identity(row));if(entry&&(entry.final_revision===null||data.controlRevision!==entry.final_revision))throw fail('NATIVE_TASK_CONTROL_FINAL_UNCONFIRMED');}
}
module.exports={SharedTaskControls};

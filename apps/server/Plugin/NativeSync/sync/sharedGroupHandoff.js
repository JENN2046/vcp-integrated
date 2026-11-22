'use strict';
const {sha256}=require('./protocol');
const {intent}=require('./sharedTurns');
const controlled=require('./sharedControlledText');

const MODE='group-member-handoff-v1';
const fail=(code,status=409)=>Object.assign(Error(code),{code,status});
const matches=row=>intent(row).controlMode===MODE;
const nativeId=(row,ordinal)=>'group_'+row.id+'_'+ordinal;
const available=shared=>Boolean(shared.native?.engine);
function requireClient(actor){
 if(actor.kind!=='desktop')throw fail('SHARED_GROUP_HANDOFF_DEVICE_REQUIRED',403);
 if(!String(actor.capabilities||'').split(',').includes(MODE))throw fail('SHARED_CLIENT_UPGRADE_REQUIRED');
}
function schema(db){
 db.exec(`CREATE TABLE IF NOT EXISTS shared_group_handoffs(
  work_id TEXT PRIMARY KEY,executor TEXT NOT NULL,executor_version INTEGER NOT NULL,
  state TEXT NOT NULL,first_reply_seq INTEGER);`);
}
function control(shared,row){
 const value=shared.db.prepare('SELECT * FROM shared_group_handoffs WHERE work_id=?').get(row.id);
 if(!value)throw fail('SHARED_GROUP_HANDOFF_STATE_CHANGED');
 return value;
}
function admit(shared,actor,topic,config,body,turn){
 requireClient(actor);
 if(!available(shared)||config.owner.kind!=='group'||config.owner.config.mode!=='sequential'||turn.kind!=='message'||
  config.members.length!==2||turn.plan.length!==2||new Set(turn.plan).size!==2||
  body.delegation!==undefined||body.sponsorRouteHash!==undefined||body.memberId!==undefined||body.targetId!==undefined)
  throw fail('SHARED_GROUP_HANDOFF_UNSUPPORTED');
 if(!plainMessage(body.message)||!body.message.content.trim())throw fail('INVALID_SHARED_SUBMISSION',400);
 controlled.assertPortable(shared,topic,config,body.message);
 if(controlled.local(JSON.stringify(config.members)))throw fail('CONTROLLED_TEXT_PORTABLE_REQUIRED');
 turn.controlMode=MODE;
}
function create(shared,row){
 // Older hosts may otherwise treat the frozen turn as an ordinary group.
 shared.db.prepare('INSERT OR IGNORE INTO shared_schema VALUES(3)').run();
 shared.db.prepare("INSERT INTO shared_group_handoffs VALUES(?,?,0,'first_member',NULL)").run(row.id,row.principal);
}
function publicState(shared,row){
 const c=control(shared,row);
 const state=['completed','abandoned','review_required'].includes(row.state)?row.state:c.state;
 const nextOrdinal=state==='first_member'?0:['awaiting_handoff','awaiting_continue','continuing'].includes(state)?1:null;
 return {state,executor:c.executor,executorVersion:c.executor_version,nextOrdinal,
  nextRequestId:nextOrdinal===null?null:nativeId(row,nextOrdinal),firstReplySeq:c.first_reply_seq};
}
function requireExecutor(shared,actor,row){
 requireClient(actor);
 shared.topic(actor,row.space_id,row.topic_id,'execute');
 const c=control(shared,row);
 if(c.executor!==actor.principal)throw fail('SHARED_REQUEST_OWNER_REQUIRED',403);
 return c;
}
function assertSlot(shared,actor,row,ordinal,requestId){
 const c=requireExecutor(shared,actor,row);
 if(!['accepted','dispatched'].includes(row.state)||
  !(ordinal===0&&c.state==='first_member'||ordinal===1&&c.state==='continuing')||
  nativeId(row,ordinal)!==requestId)throw fail('SHARED_GROUP_HANDOFF_FENCED');
 return c;
}
// The final model state and the visible Journal projection must identify the same member slot.
function verifyBoundary(shared,row,topic,c){
 const [first]=intent(row).plan;
 const registered=shared.db.prepare(`SELECT 1 FROM shared_native_requests
  WHERE admission_id=? AND id=? AND ordinal=0 AND member_id=? AND principal=? AND state='model_terminal'`).get(row.id,nativeId(row,0),first,row.principal);
 const [record]=shared.store.readProjected(()=>shared.db.prepare(`SELECT m.* FROM messages m JOIN journal j
  ON j.seq=m.last_seq AND j.owner_type=m.owner_type AND j.owner_id=m.owner_id AND j.topic_id=m.topic_id
  AND j.msg_id=m.msg_id AND j.hash=m.hash AND j.device_id=? AND j.action='upsert'
  WHERE m.owner_type=? AND m.owner_id=? AND m.topic_id=? AND m.msg_id=? AND m.deleted=0 AND m.last_seq=?`)
  .all(row.principal,topic.owner_type,topic.owner_id,topic.topic_id,'reply_'+nativeId(row,0),c.first_reply_seq));
 if(!registered||c.first_reply_seq<=row.user_seq||record?.message?.role!=='assistant'||record.message.agentId!==first||typeof record.message.content!=='string')
  throw fail('SHARED_GROUP_HANDOFF_BOUNDARY_CHANGED');
 return record.message;
}
function transition(shared,actor,body,takeover){
 const requested=shared.admission(actor,body.sharedSpaceId,body.workId);
 requireClient(actor);
 const topic=shared.topic(actor,requested.space_id,requested.topic_id,'execute');
 if(!matches(requested))throw fail('SHARED_GROUP_HANDOFF_UNSUPPORTED');
 const action=takeover?'group-handoff':'group-continue';
 return shared.receipt(actor,body,action,()=>{
  const row=shared.admission(actor,body.sharedSpaceId,body.workId);
  const c=control(shared,row);
  if(c.executor!==body.expectedExecutor||c.executor_version!==body.expectedExecutorVersion)throw fail('SHARED_GROUP_HANDOFF_STATE_CHANGED');
  if(takeover?actor.principal===c.executor:actor.principal!==c.executor)throw fail('SHARED_REQUEST_OWNER_REQUIRED',403);
  if(row.state!=='dispatched'||c.state!==(takeover?'awaiting_handoff':'awaiting_continue')||
   shared.db.prepare("SELECT 1 FROM shared_native_requests WHERE admission_id=? AND (ordinal>0 OR state<>'model_terminal')").get(row.id))
   throw fail('SHARED_GROUP_HANDOFF_FENCED');
  verifyBoundary(shared,row,topic,c);
  controlled.assertPortable(shared,topic,JSON.parse(row.config_json),{content:''});
  shared.db.prepare('UPDATE shared_group_handoffs SET executor=?, executor_version=?, state=? WHERE work_id=?')
   .run(actor.principal,c.executor_version+(takeover?1:0),takeover?'awaiting_continue':'continuing',row.id);
  return {request:shared.publicAdmission(row)};
 });
}
function textOf(message){
 const content=message?.content;
 if(typeof content==='string')return content;
 if(Array.isArray(content)&&content.length&&content.every(part=>part?.type==='text'&&typeof part.text==='string'))
  return content.map(part=>part.text).join('\n');
 return null;
}
function assertBody(shared,row,topic,c,ordinal,body){
 if(body.tools!==undefined&&(!Array.isArray(body.tools)||body.tools.length)||body.functions!==undefined||
  !Array.isArray(body.messages)||!body.messages.length||body.messages.some(message=>{
   const content=textOf(message);
   return !['system','developer','user','assistant'].includes(message?.role)||content===null||controlled.local(content)||
    message.tool_calls!==undefined||message.function_call!==undefined;
  }))throw fail('CONTROLLED_TEXT_ONLY');
 if(ordinal!==1)return;
 const first=verifyBoundary(shared,row,topic,c);
 const bindings=body.vcpchatExtensions?.messageTimestampBindings;
 const invalid=()=>fail('SHARED_GROUP_HANDOFF_CONTEXT_CHANGED');
 if(!Array.isArray(bindings)||bindings.length>body.messages.length)throw invalid();
 const indexes=new Set(),ids=new Set();
 let firstBound=false;
 for(const binding of bindings){
  if(!binding||typeof binding.messageId!=='string'||!binding.messageId||
   !Number.isSafeInteger(binding.sentMessageIndex)||binding.sentMessageIndex<0||
   indexes.has(binding.sentMessageIndex)||ids.has(binding.messageId))throw invalid();
  const message=body.messages[binding.sentMessageIndex];
  if(!message||binding.role!==message.role||binding.source!=='client_history'||
   !Number.isSafeInteger(binding.timestamp)||typeof binding.timestampIso!=='string'||
   Date.parse(binding.timestampIso)!==binding.timestamp||new Date(binding.timestamp).toISOString()!==binding.timestampIso||
   binding.sentMessageHash!=='sha256:'+sha256(textOf(message)))throw invalid();
  indexes.add(binding.sentMessageIndex);
  ids.add(binding.messageId);
  if(binding.messageId===first.id){
   if(binding.role!==first.role||binding.timestamp!==first.timestamp)throw invalid();
   firstBound=true;
  }
 }
 if(!firstBound)throw invalid();
}
function plainMessage(message){
 return typeof message?.content==='string'&&!controlled.local(message.content)&&!message.attachments?.length&&!message.desktopReferences?.length&&
  !message.contextCompaction&&!message.tool_calls&&!message.tool_call_id&&!message.function_call&&!message.isThinking&&!message.isPendingStream;
}
function assertReply(shared,actor,row,step,message){
 assertSlot(shared,actor,row,step.ordinal,step.id);
 if(step.principal!==actor.principal||!plainMessage(message)||!message.content.trim()||
  message.interrupted||message.errorCode||message.finishReason&&!['completed','stop','length'].includes(message.finishReason))
  throw fail('INVALID_SHARED_REPLY',400);
}
function pause(shared,row,topic,replySeq){
 verifyBoundary(shared,row,topic,{first_reply_seq:replySeq});
 shared.db.prepare("UPDATE shared_group_handoffs SET state='awaiting_handoff',first_reply_seq=? WHERE work_id=?")
  .run(replySeq,row.id);
}
// Only a published first member with no request in flight survives the generic restart review.
function recoverable(tables){
 if(!tables.has('shared_native_requests'))return '';
 return ` AND NOT (EXISTS (SELECT 1 FROM shared_group_handoffs h
  WHERE h.work_id=shared_admissions.id AND h.first_reply_seq IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM shared_native_requests r WHERE r.admission_id=shared_admissions.id AND r.state IN ('dispatched','unknown')))`;
}
function recoverUnknown(shared){
 shared.db.prepare(`UPDATE shared_admissions SET state='review_required',native_terminal=0 WHERE state='dispatched'
  AND id IN (SELECT h.work_id FROM shared_group_handoffs h JOIN shared_native_requests r ON r.admission_id=h.work_id WHERE r.state='unknown')`).run();
}
module.exports={MODE,available,requireClient,matches,schema,admit,create,publicState,requireExecutor,assertSlot,assertBody,assertReply,pause,transition,recoverable,recoverUnknown};

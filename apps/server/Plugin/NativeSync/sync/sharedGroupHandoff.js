'use strict';
const {sha256}=require('./protocol');
const {intent}=require('./sharedTurns');
const controlled=require('./sharedControlledText');

const MODE='group-member-handoff-v1', PLAN_MODE='group-member-handoff-v2';
const fail=(code,status=409)=>Object.assign(Error(code),{code,status});
const isMode=mode=>mode===MODE||mode===PLAN_MODE;
const matches=row=>isMode(intent(row).controlMode);
const nativeId=(row,ordinal)=>'group_'+row.id+'_'+ordinal;
const available=shared=>Boolean(shared.native?.engine);
function requireClient(actor,mode){
 if(actor.kind!=='desktop')throw fail('SHARED_GROUP_HANDOFF_DEVICE_REQUIRED',403);
 if(!String(actor.capabilities||'').split(',').includes(mode))throw fail('SHARED_CLIENT_UPGRADE_REQUIRED');
}
function schema(db){
 db.exec(`CREATE TABLE IF NOT EXISTS shared_group_handoffs(
  work_id TEXT PRIMARY KEY,executor TEXT NOT NULL,executor_version INTEGER NOT NULL,
  state TEXT NOT NULL,first_reply_seq INTEGER);
 CREATE TABLE IF NOT EXISTS shared_group_handoff_replies(
  work_id TEXT NOT NULL,ordinal INTEGER NOT NULL,reply_seq INTEGER NOT NULL,PRIMARY KEY(work_id,ordinal));`);
}
function control(shared,row){
 const value=shared.db.prepare('SELECT * FROM shared_group_handoffs WHERE work_id=?').get(row.id);
 if(!value)throw fail('SHARED_GROUP_HANDOFF_STATE_CHANGED');
 return value;
}
function admit(shared,actor,topic,config,body,turn){
 const mode=body.controlMode;
 requireClient(actor,mode);
 if(!available(shared)||config.owner.kind!=='group'||config.owner.config.mode!=='sequential'||turn.kind!=='message'||
  !turn.plan.length||new Set(turn.plan).size!==turn.plan.length||
  (mode===MODE&&(config.members.length!==2||turn.plan.length!==2))||
  body.delegation!==undefined||body.sponsorRouteHash!==undefined||body.memberId!==undefined||body.targetId!==undefined)
  throw fail('SHARED_GROUP_HANDOFF_UNSUPPORTED');
 if(!plainMessage(body.message)||!body.message.content.trim())throw fail('INVALID_SHARED_SUBMISSION',400);
 controlled.assertPortable(shared,topic,config,body.message);
 if(controlled.local(JSON.stringify(config.members)))throw fail('CONTROLLED_TEXT_PORTABLE_REQUIRED');
 turn.controlMode=mode;
}
function create(shared,row){
 // Older hosts may otherwise treat the frozen turn as an ordinary group.
 shared.db.prepare('INSERT OR IGNORE INTO shared_schema VALUES(?)').run(intent(row).controlMode===PLAN_MODE?4:3);
 shared.db.prepare("INSERT INTO shared_group_handoffs VALUES(?,?,0,'first_member',NULL)").run(row.id,row.principal);
}
function confirmedReplies(shared,row,c){
 if(intent(row).controlMode===MODE)return c.first_reply_seq===null?[]:[c.first_reply_seq];
 return shared.db.prepare('SELECT reply_seq FROM shared_group_handoff_replies WHERE work_id=? ORDER BY ordinal').all(row.id).map(r=>r.reply_seq);
}
function publicState(shared,row){
 const c=control(shared,row),confirmed=confirmedReplies(shared,row,c);
 const state=['completed','abandoned','review_required'].includes(row.state)?row.state:c.state;
 const nextOrdinal=state==='first_member'?0:['awaiting_handoff','awaiting_continue','continuing'].includes(state)?confirmed.length:null;
 const view={state,executor:c.executor,executorVersion:c.executor_version,nextOrdinal,
  nextRequestId:nextOrdinal===null?null:nativeId(row,nextOrdinal)};
 if(intent(row).controlMode===MODE)return {...view,firstReplySeq:c.first_reply_seq};
 return {...view,previousReplySeq:confirmed.at(-1)??null,confirmedReplies:confirmed};
}
function requireExecutor(shared,actor,row){
 requireClient(actor,intent(row).controlMode);
 shared.topic(actor,row.space_id,row.topic_id,'execute');
 const c=control(shared,row);
 if(c.executor!==actor.principal)throw fail('SHARED_REQUEST_OWNER_REQUIRED',403);
 return c;
}
function assertSlot(shared,actor,row,ordinal,requestId){
 const c=requireExecutor(shared,actor,row);
 if(!['accepted','dispatched'].includes(row.state)||
  c.state!==(ordinal===0?'first_member':'continuing')||
  ordinal!==confirmedReplies(shared,row,c).length||ordinal>=intent(row).plan.length||
  nativeId(row,ordinal)!==requestId)throw fail('SHARED_GROUP_HANDOFF_FENCED');
 return c;
}
// Require the visible Journal projection from the principal that actually ran the slot.
function verifyBoundary(shared,row,topic,ordinal,replySeq){
 const member=intent(row).plan[ordinal],requestId=nativeId(row,ordinal);
 const registered=shared.db.prepare(`SELECT principal FROM shared_native_requests
  WHERE admission_id=? AND id=? AND ordinal=? AND member_id=? AND state='model_terminal'`).get(row.id,requestId,ordinal,member);
 if(!registered||ordinal===0&&registered.principal!==row.principal||!Number.isSafeInteger(replySeq)||replySeq<=row.user_seq)
  throw fail('SHARED_GROUP_HANDOFF_BOUNDARY_CHANGED');
 const [record]=shared.store.readProjected(()=>shared.db.prepare(`SELECT m.* FROM messages m JOIN journal j
  ON j.seq=m.last_seq AND j.owner_type=m.owner_type AND j.owner_id=m.owner_id AND j.topic_id=m.topic_id
  AND j.msg_id=m.msg_id AND j.hash=m.hash AND j.device_id=? AND j.action='upsert'
  WHERE m.owner_type=? AND m.owner_id=? AND m.topic_id=? AND m.msg_id=? AND m.deleted=0 AND m.last_seq=?`)
  .all(registered.principal,topic.owner_type,topic.owner_id,topic.topic_id,'reply_'+requestId,replySeq));
 if(record?.message?.role!=='assistant'||record.message.agentId!==member||!plainMessage(record.message))
  throw fail('SHARED_GROUP_HANDOFF_BOUNDARY_CHANGED');
 return record.message;
}
function verifyPrevious(shared,row,topic,c,ordinal){
 return verifyBoundary(shared,row,topic,ordinal-1,confirmedReplies(shared,row,c)[ordinal-1]);
}
function transition(shared,actor,body,takeover){
 const requested=shared.admission(actor,body.sharedSpaceId,body.workId);
 const topic=shared.topic(actor,requested.space_id,requested.topic_id,'execute');
 const {controlMode}=intent(requested);
 if(!isMode(controlMode))throw fail('SHARED_GROUP_HANDOFF_UNSUPPORTED');
 requireClient(actor,controlMode);
 const action=takeover?'group-handoff':'group-continue';
 return shared.receipt(actor,body,action,()=>{
  const row=shared.admission(actor,body.sharedSpaceId,body.workId);
  const c=control(shared,row);
  const confirmed=confirmedReplies(shared,row,c),ordinal=confirmed.length;
  if(c.executor!==body.expectedExecutor||c.executor_version!==body.expectedExecutorVersion||
   (controlMode===PLAN_MODE&&(ordinal!==body.expectedNextOrdinal||confirmed.at(-1)!==body.expectedPreviousReplySeq)))
   throw fail('SHARED_GROUP_HANDOFF_STATE_CHANGED');
  if(takeover?actor.principal===c.executor:actor.principal!==c.executor)throw fail('SHARED_REQUEST_OWNER_REQUIRED',403);
  if(row.state!=='dispatched'||c.state!==(takeover?'awaiting_handoff':'awaiting_continue')||
   !ordinal||ordinal>=intent(row).plan.length||shared.db.prepare("SELECT 1 FROM shared_native_requests WHERE admission_id=? AND (ordinal>=? OR state<>'model_terminal')").get(row.id,ordinal))
   throw fail('SHARED_GROUP_HANDOFF_FENCED');
  verifyPrevious(shared,row,topic,c,ordinal);
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
 if(ordinal===0)return;
 const previous=verifyPrevious(shared,row,topic,c,ordinal);
 const bindings=body.vcpchatExtensions?.messageTimestampBindings;
 const invalid=()=>fail('SHARED_GROUP_HANDOFF_CONTEXT_CHANGED');
 if(!Array.isArray(bindings)||bindings.length>body.messages.length)throw invalid();
 const indexes=new Set(),ids=new Set();
 let previousBound=false;
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
  if(binding.messageId===previous.id){
   if(binding.role!==previous.role||binding.timestamp!==previous.timestamp)throw invalid();
   previousBound=true;
  }
 }
 if(!previousBound)throw invalid();
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
function confirmReply(shared,row,topic,ordinal,replySeq){
 const turn=intent(row);
 if(turn.controlMode===MODE){
  if(ordinal===0){
   verifyBoundary(shared,row,topic,ordinal,replySeq);
   shared.db.prepare("UPDATE shared_group_handoffs SET state='awaiting_handoff',first_reply_seq=? WHERE work_id=?").run(replySeq,row.id);
  }
  return false;
 }
 verifyBoundary(shared,row,topic,ordinal,replySeq);
 shared.db.prepare('INSERT INTO shared_group_handoff_replies VALUES(?,?,?)').run(row.id,ordinal,replySeq);
 const final=ordinal===turn.plan.length-1;
 shared.db.prepare('UPDATE shared_group_handoffs SET state=? WHERE work_id=?').run(final?'completed':'awaiting_handoff',row.id);
 return final;
}
// A confirmed prefix survives restart only while no later request has crossed the model boundary.
function recoverable(tables){
 if(!tables.has('shared_native_requests'))return '';
 return ` AND NOT (EXISTS (SELECT 1 FROM shared_group_handoffs h
  WHERE h.work_id=shared_admissions.id AND (h.first_reply_seq IS NOT NULL OR EXISTS (
   SELECT 1 FROM shared_group_handoff_replies p WHERE p.work_id=h.work_id))
  AND NOT EXISTS (SELECT 1 FROM shared_native_requests r WHERE r.admission_id=shared_admissions.id
   AND (r.state IN ('dispatched','unknown') OR (r.state='model_terminal'
    AND json_extract(shared_admissions.user_op,'$.sharedTurn.controlMode')='${PLAN_MODE}'
    AND NOT EXISTS (SELECT 1 FROM shared_group_handoff_replies p WHERE p.work_id=h.work_id AND p.ordinal=r.ordinal))))))`;
}
function recoverUnknown(shared){
 shared.db.prepare(`UPDATE shared_admissions SET state='review_required',native_terminal=0 WHERE state='dispatched'
  AND id IN (SELECT h.work_id FROM shared_group_handoffs h JOIN shared_native_requests r ON r.admission_id=h.work_id WHERE r.state='unknown')`).run();
}
module.exports={MODE,PLAN_MODE,available,isMode,requireClient,matches,schema,admit,create,publicState,requireExecutor,assertSlot,assertBody,assertReply,confirmReply,verifyPrevious,transition,recoverable,recoverUnknown};

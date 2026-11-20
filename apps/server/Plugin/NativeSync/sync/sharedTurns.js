'use strict';
const fail=(code,status=409)=>Object.assign(Error(code),{code,status});
const modes={sequential:require('../nativeRules/Groupmodules/modes/sequentialMode'),naturerandom:require('../nativeRules/Groupmodules/modes/natureRandomMode'),invite_only:require('../nativeRules/Groupmodules/modes/inviteOnlyMode')};
const tuple=t=>[t.owner_type,t.owner_id,t.topic_id];
function intent(row){return JSON.parse(row.user_op||'{}').sharedTurn||{kind:'message'};}
function history(shared,topic){return shared.store.readProjected(()=>shared.db.prepare('SELECT * FROM messages WHERE owner_type=? AND owner_id=? AND topic_id=? AND deleted=0 ORDER BY last_seq').all(...tuple(topic))).map(r=>({...r.row,message:r.message}));}
function prepare(shared,topic,config,body,sponsored=false){
 const kind=body.kind||'message';if(!['message','invite','regenerate'].includes(kind))throw fail('INVALID_SHARED_SUBMISSION',400);
 const records=history(shared,topic),index=kind==='regenerate'?records.findIndex(r=>r.msg_id===body.targetId):-1;
 if(kind==='regenerate'&&(index<0||records[index].message.role!=='assistant'))throw fail('SHARED_REGENERATION_TARGET_CHANGED');
 if(kind==='invite'&&config.owner.kind!=='group')throw fail('INVALID_SHARED_SUBMISSION',400);
 const selectedHistory=(kind==='regenerate'?records.slice(0,index):records).map(r=>r.message);
 const user=kind==='message'?body.message:[...selectedHistory].reverse().find(m=>m.role==='user');
 if(kind==='message'&&(!user||user.role!==(sponsored?'assistant':'user')||typeof user.id!=='string'||!user.id))throw fail('INVALID_SHARED_SUBMISSION',400);
 let plan=[];
 if(config.owner.kind==='group'){
  const group=config.owner.config,mode=modes[group.mode];if(!mode)throw fail('GROUP_MODE_REQUIRES_DESKTOP');
  const members=config.members.map(m=>({id:m.id,...m.config}));
  if(members.length!==group.members.length||config.members.some(m=>m.deleted))throw fail('SHARED_MEMBER_NOT_AUTHORIZED',403);
  if(kind!=='message'){
   const memberId=body.memberId||(kind==='regenerate'?records[index].message.agentId:null);
   if(!members.some(m=>m.id===memberId))throw fail('SHARED_MEMBER_NOT_AUTHORIZED',403);
   if(kind==='regenerate'&&records[index].message.agentId!==memberId)throw fail('SHARED_REGENERATION_TARGET_CHANGED');
   plan=[memberId];
  }else{
   const nativeGroup={...group,modeSettings:{...group.modeSettings,naturerandom:{memberTags:group.memberTags||{},tagMatchMode:group.tagMatchMode||'strict'}}};
   plan=mode.determineSpeakers(members,[...selectedHistory,user],nativeGroup,user,{isAborted:()=>false}).map(m=>m.id);
  }
 }
 return {kind,plan,...(sponsored?{topicSponsor:true}:{}),userMessageId:user?.id||null,...(kind==='regenerate'?{targetId:body.targetId,targetHash:records[index].hash}:{} )};
}
function complete(shared,actor,body,row){
 const topic=shared.topic(actor,row.space_id,row.topic_id,'execute'),turn=intent(row),group=topic.owner_type==='group';
 if(!group)return false;
 if(!['accepted','dispatched','review_required'].includes(row.state))throw fail('SHARED_REQUEST_FENCED');
 if(body.finish===true){
  const steps=shared.db.prepare('SELECT * FROM shared_native_requests WHERE admission_id=? ORDER BY ordinal').all(row.id);
  if(steps.length!==turn.plan.length||steps.some((s,i)=>s.state!=='model_terminal'||s.member_id!==turn.plan[i]))throw fail('SHARED_NATIVE_TERMINAL_REQUIRED');
  const native=shared.native?.engine.nativeTasks;
  if(steps.length&&(!native||native.needsReview(row.id)||native.unsettledTools(row.id)||native.list(row.id).some(t=>!['completed','failed','cancelled','stopped'].includes(t.state))))throw fail('SHARED_NATIVE_TERMINAL_REQUIRED');
  const replies=shared.store.readProjected(()=>shared.db.prepare('SELECT * FROM messages WHERE owner_type=? AND owner_id=? AND topic_id=? AND msg_id IN (SELECT value FROM json_each(?))').all(...tuple(topic),JSON.stringify(steps.map(s=>'reply_'+s.id))));
  if(replies.length!==steps.length||replies.some(r=>r.row.deleted))throw fail('SHARED_NATIVE_TERMINAL_REQUIRED');
  if(steps.length&&!row.native_terminal)throw fail('SHARED_NATIVE_TERMINAL_REQUIRED');
  shared.db.prepare("UPDATE shared_admissions SET state='completed' WHERE id=?").run(row.id);
  return {request:shared.publicAdmission(shared.admission(actor,row.space_id,row.id))};
 }
 const step=shared.db.prepare('SELECT * FROM shared_native_requests WHERE id=? AND admission_id=?').get(body.nativeRequestId,row.id),message=body.message;
 if(!step||step.state!=='model_terminal'||turn.plan[step.ordinal]!==step.member_id)throw fail('SHARED_NATIVE_TERMINAL_REQUIRED');
 if(!message||message.role!=='assistant'||message.id!=='reply_'+step.id||message.agentId!==step.member_id)throw fail('INVALID_SHARED_REPLY',400);
 const native=shared.native?.engine.nativeTasks;
 if(!native||native.needsReview(row.id)||native.unsettledTools(row.id))throw fail('SHARED_NATIVE_TERMINAL_REQUIRED');
 const receipt=writeReply(shared,actor,topic,row,message,'shared-step:'+step.id);
 if(turn.kind==='regenerate')replaceTarget(shared,actor,topic,row,turn);
 shared.db.prepare('UPDATE shared_admissions SET reply_seq=? WHERE id=?').run(receipt.seq,row.id);
 return {request:shared.publicAdmission(shared.admission(actor,row.space_id,row.id)),receipt};
}
function writeReply(shared,actor,topic,row,message,opId){
 const normalized={...message};delete normalized._nativeSyncMetadata;
 return shared.store.apply({ownerType:topic.owner_type,ownerId:topic.owner_id,topicId:topic.topic_id,msgId:message.id,deviceId:actor.principal,opId,action:'upsert',baseHash:null,message:normalized,metadata:require('./metadata').envelopeFor(message,1)},{sharedSpace:row.space_id,attachmentPrincipal:actor.principal,metadataPublisher:true});
}
function replaceTarget(shared,actor,topic,row,turn=intent(row)){
 if(turn.kind!=='regenerate')return;
 const target=shared.store.readProjected(()=>shared.db.prepare('SELECT * FROM messages WHERE owner_type=? AND owner_id=? AND topic_id=? AND msg_id=?').all(...tuple(topic),turn.targetId))[0]?.row;
 if(!target||target.hash!==turn.targetHash||target.deleted)throw fail('SHARED_REGENERATION_TARGET_CHANGED');
 shared.store.apply({ownerType:topic.owner_type,ownerId:topic.owner_id,topicId:topic.topic_id,msgId:turn.targetId,deviceId:actor.principal,opId:'shared-replaced:'+row.id,action:'delete',baseHash:turn.targetHash},{sharedSpace:row.space_id,metadataPublisher:true});
}
module.exports={intent,history,prepare,complete,writeReply,replaceTarget};

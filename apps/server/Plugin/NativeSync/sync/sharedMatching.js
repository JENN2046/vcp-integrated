'use strict';
const {createHash}=require('node:crypto');
const {stable,sha256}=require('./protocol');
const {sharedIdentity}=require('./contracts.generated.cjs');
const fail=(code,status=409)=>Object.assign(Error(code),{code,status});
const normalized=value=>value.normalize('NFKC').trim().toLocaleLowerCase('en-US');
function* rows(shared,topic){
 const query=shared.db.prepare(`SELECT m.*,(SELECT min(seq) FROM journal j WHERE j.owner_type=m.owner_type AND j.owner_id=m.owner_id AND j.topic_id=m.topic_id AND j.msg_id=m.msg_id) first_seq FROM messages m WHERE owner_type=? AND owner_id=? AND topic_id=? ORDER BY first_seq,msg_id`);
 let batch=[];
 for(const row of query.iterate(topic.owner_type,topic.owner_id,topic.topic_id)){
  batch.push(row);if(batch.length===128){shared.store.projectRows(batch);yield* batch;batch=[];}
 }
 if(batch.length){shared.store.projectRows(batch);yield* batch;}
}
const fact=row=>({id:row.msg_id,hash:row.hash,deleted:row.deleted,metadataVersion:row.metadata_version,metadataHash:row.metadata_hash});
function compare(shared,left,right){
 const a=rows(shared,left),b=rows(shared,right),leftHash=createHash('sha256'),rightHash=createHash('sha256');let same=true,lc=0,rc=0;
 for(;;){const x=a.next(),y=b.next();if(x.done&&y.done)break;
  if(!x.done){lc++;leftHash.update(stable(fact(x.value))+'\n');}if(!y.done){rc++;rightHash.update(stable(fact(y.value))+'\n');}
  if(!x.done&&!y.done&&stable(fact(x.value))!==stable(fact(y.value)))same=false;
 }
 return {relation:same?(lc===rc?'equal':'prefix'):'fork',leftCount:lc,rightCount:rc,leftHash:leftHash.digest('hex'),rightHash:rightHash.digest('hex')};
}
function preview(shared,actor,{sharedSpaceId,leftId,rightId}){
 shared.authorize(actor,sharedSpaceId,'config');
 return shared.store.readSnapshot(()=>{
  const left=shared.row(sharedSpaceId,leftId),right=shared.row(sharedSpaceId,rightId);
  if(left.id===right.id||left.kind!==right.kind||!['agent','group','topic'].includes(left.kind))throw fail('INVALID_SHARED_MATCH',400);
  if(left.kind==='topic'&&(left.parent_id!==right.parent_id||left.owner_type!==right.owner_type))throw fail('SHARED_MATCH_PARENT_REQUIRED');
  const l=shared.object(left),r=shared.object(right),history=left.kind==='topic'?compare(shared,left,right):null;
  const groups=left.kind==='agent'?shared.db.prepare("SELECT * FROM shared_objects WHERE space_id=? AND kind='group' AND deleted=0 ORDER BY id").all(sharedSpaceId).map(row=>shared.object(row)).filter(group=>group.config.members.includes(left.id)||group.config.members.includes(right.id)):[];
  const memberCollision=groups.some(group=>group.config.members.includes(left.id)&&group.config.members.includes(right.id));
  const roots=[left.id,right.id,...groups.map(g=>g.id)],scope=shared.db.prepare('SELECT * FROM shared_objects WHERE space_id=? AND (id IN (SELECT value FROM json_each(?)) OR parent_id IN (SELECT value FROM json_each(?))) ORDER BY id').all(sharedSpaceId,JSON.stringify(roots),JSON.stringify(roots));
  const objects=scope.map(row=>({id:row.id,version:row.version,deleted:Boolean(row.deleted),head:row.kind==='topic'?shared.head(row):null}));
  const requiredSources=[...new Set([left.origin_source,right.origin_source,...shared.db.prepare('SELECT DISTINCT source_id FROM shared_local_bindings WHERE object_id IN (SELECT value FROM json_each(?))').all(JSON.stringify(objects.map(o=>o.id))).map(r=>r.source_id)])].sort();
  const plan={sharedSpaceId,leftId,rightId,objects,requiredSources,kind:left.kind,leftVersion:left.version,rightVersion:right.version,leftConfigHash:l.configHash,rightConfigHash:r.configHash,sameName:normalized(l.config.name)===normalized(r.config.name),history,groups:groups.map(g=>({id:g.id,version:g.version,hash:g.configHash})),memberCollision,
   // Global head changes in unrelated topics do not invalidate this plan.
   leftHead:left.kind==='topic'?shared.head(left):null,rightHead:right.kind==='topic'?shared.head(right):null};
  return {plan,planHash:sha256(stable(plan)),requiresConfigChoice:l.configHash!==r.configHash,mergeAllowed:history?.relation!=='fork'&&!memberCollision,suggested:normalized(l.config.name)===normalized(r.config.name)};
 });
}
function entries(shared,planHash){return shared.db.prepare('SELECT source_id,proof_json FROM shared_preparations WHERE plan_hash=? ORDER BY source_id').all(planHash).map(r=>({source:r.source_id,...JSON.parse(r.proof_json)}));}
function pending(shared,ids,except){
 const keys=new Set(ids);for(const row of shared.db.prepare("SELECT plan_hash,proof_json FROM shared_preparations WHERE json_extract(proof_json,'$.status') IN ('prepared','committed')").all()){
  if(row.plan_hash===except)continue;const item=JSON.parse(row.proof_json);if(item.plan.objects.some(o=>keys.has(o.id)))throw fail('SHARED_MATCH_PREPARING');
 }
}
function currentEntries(shared,planHash){const all=entries(shared,planHash),generation=Math.max(0,...all.map(r=>r.generation||0));return all.filter(r=>(r.generation||0)===generation);}
function prepare(shared,actor,body){
 if(shared.readOnly)throw fail('SHARED_READ_ONLY');shared.authorize(actor,body.sharedSpaceId,'config');if(actor.kind!=='desktop')throw fail('SHARED_DEVICE_REQUIRED',403);
 return shared.atomic(()=>{
  const fresh=preview(shared,actor,body);if(fresh.planHash!==body.planHash)throw fail('SHARED_MATCH_CHANGED');if(!fresh.mergeAllowed)throw fail(fresh.plan.memberCollision?'SHARED_GROUP_MEMBER_COLLISION':'SHARED_HISTORY_FORK');
  pending(shared,fresh.plan.objects.map(o=>o.id),body.planHash);
  for(const o of fresh.plan.objects)if(shared.active(o.id))throw fail('SHARED_TOPIC_BUSY');
  const proof=body.proof;
  if(!proof||Object.keys(proof).some(k=>!['pendingOperations','pendingCommits','activeRequests','stateHash'].includes(k))||['pendingOperations','pendingCommits','activeRequests'].some(k=>proof[k]!==0)||!/^[a-f0-9]{64}$/.test(proof.stateHash||''))throw fail('SHARED_SOURCE_NOT_SETTLED');
  const preparationId=body.preparationId||body.planHash;sharedIdentity(preparationId);
  if(!fresh.plan.requiredSources.includes(actor.sourceId))throw fail('SHARED_DEVICE_REQUIRED',403);
  const current=currentEntries(shared,body.planHash),latest=current[0];
  if(latest&&latest.preparationId!==preparationId&&current.some(r=>['prepared','committed'].includes(r.status)))throw fail('SHARED_MATCH_GENERATION_CHANGED');
  if(latest?.preparationId===preparationId&&current.every(r=>r.status==='cancelled'))throw fail('SHARED_MATCH_CANCELLED');
  const generation=latest?.preparationId===preparationId?latest.generation:(latest?.generation||0)+1;
  const old=current.find(r=>r.source===actor.sourceId&&r.preparationId===preparationId);if(old&&['committed','applied'].includes(old.status))throw fail('SHARED_MATCH_ALREADY_COMMITTED');
  shared.db.prepare('INSERT INTO shared_preparations VALUES(?,?,?) ON CONFLICT(plan_hash,source_id) DO UPDATE SET proof_json=excluded.proof_json').run(body.planHash,actor.sourceId,JSON.stringify({status:'prepared',plan:fresh.plan,proof,preparationId,generation}));return {prepared:true,planHash:body.planHash};
 });
}
function state(shared,planHash){
 const all=currentEntries(shared,planHash);if(!all.length)return null;const plan=all[0].plan;if(!plan)return null;
 const committed=all.find(r=>['committed','applied'].includes(r.status));
 return {planHash,preparationId:all[0].preparationId,generation:all[0].generation,plan,status:committed?(plan.requiredSources.every(source=>all.some(r=>r.source===source&&r.status==='applied'))?'complete':'committed'):all.every(r=>r.status==='cancelled')?'cancelled':'prepared',preparedSources:all.filter(r=>r.status==='prepared').map(r=>r.source),appliedSources:all.filter(r=>r.status==='applied').map(r=>r.source),result:committed?.result||null};
}
function states(shared,actor,{sharedSpaceId,after='',limit=64,active}){
 shared.authorize(actor,sharedSpaceId,'config');if(actor.kind!=='desktop')throw fail('SHARED_DEVICE_REQUIRED',403);
 if(!Number.isSafeInteger(limit)||limit<1||limit>128||typeof after!=='string')throw fail('INVALID_SHARED_PAGE',400);
 const rows=shared.db.prepare("SELECT DISTINCT plan_hash FROM shared_preparations WHERE plan_hash>? AND json_extract(proof_json,'$.plan.sharedSpaceId')=? "+(active==='1'?"AND json_extract(proof_json,'$.status') IN ('prepared','committed') ":'')+"ORDER BY plan_hash LIMIT ?").all(after,sharedSpaceId,limit+1),page=rows.slice(0,limit);
 return {plans:page.map(r=>state(shared,r.plan_hash)),hasMore:rows.length>limit,next:page.at(-1)?.plan_hash||after};
}
function one(shared,actor,{sharedSpaceId,planHash}){shared.authorize(actor,sharedSpaceId,'config');if(actor.kind!=='desktop')throw fail('SHARED_DEVICE_REQUIRED',403);const value=state(shared,planHash);if(value&&value.plan.sharedSpaceId!==sharedSpaceId)throw fail('SHARED_MATCH_NOT_FOUND',404);return {plan:value};}
function cancel(shared,actor,{sharedSpaceId,planHash,preparationId,leftId,rightId}){
 shared.authorize(actor,sharedSpaceId,'config');return shared.atomic(()=>{
  let current=state(shared,planHash);
  if(!current){
   sharedIdentity(preparationId);shared.row(sharedSpaceId,leftId);shared.row(sharedSpaceId,rightId);
   shared.db.prepare('INSERT INTO shared_preparations VALUES(?,?,?)').run(planHash,actor.sourceId,JSON.stringify({status:'cancelled',preparationId,generation:1,plan:{sharedSpaceId,leftId,rightId,objects:[],requiredSources:[actor.sourceId]}}));return state(shared,planHash);
  }
  if(current.plan.sharedSpaceId!==sharedSpaceId||!current.plan.requiredSources.includes(actor.sourceId))throw fail('SHARED_MATCH_NOT_FOUND',404);
  if(preparationId&&current.preparationId!==preparationId)return current;
  if(['committed','complete'].includes(current.status))return current;
  for(const row of currentEntries(shared,planHash))shared.db.prepare('UPDATE shared_preparations SET proof_json=? WHERE plan_hash=? AND source_id=?').run(JSON.stringify({...row,status:'cancelled'}),planHash,row.source);
  return state(shared,planHash);
 });
}
function applied(shared,actor,{sharedSpaceId,planHash,preparationId,stateHash}){
 shared.authorize(actor,sharedSpaceId,'config');if(!/^[a-f0-9]{64}$/.test(stateHash||''))throw fail('SHARED_SOURCE_NOT_SETTLED');
 return shared.atomic(()=>{const current=state(shared,planHash),record=currentEntries(shared,planHash).find(r=>r.source===actor.sourceId);
  if(!current||preparationId&&current.preparationId!==preparationId||current.plan.sharedSpaceId!==sharedSpaceId||!record||!['committed','applied'].includes(record.status))throw fail('SHARED_MATCH_NOT_FOUND',404);
  shared.db.prepare('UPDATE shared_preparations SET proof_json=? WHERE plan_hash=? AND source_id=?').run(JSON.stringify({...record,status:'applied',appliedHash:stateHash}),planHash,actor.sourceId);return state(shared,planHash);
 });
}
function confirm(shared,actor,body){
 shared.authorize(actor,body.sharedSpaceId,'config');
 return shared.receipt(actor,body,'match',()=>{
  const fresh=preview(shared,actor,body);if(fresh.planHash!==body.planHash)throw fail('SHARED_MATCH_CHANGED');
  if(!fresh.mergeAllowed)throw fail(fresh.plan.memberCollision?'SHARED_GROUP_MEMBER_COLLISION':'SHARED_HISTORY_FORK');
  const {plan}=fresh,left=shared.row(body.sharedSpaceId,body.leftId),right=shared.row(body.sharedSpaceId,body.rightId);
  const preparations=currentEntries(shared,body.planHash);if(!preparations.length)throw fail('SHARED_SOURCE_NOT_SETTLED');if(preparations[0]?.preparationId!==(body.preparationId||body.planHash))throw fail('SHARED_MATCH_GENERATION_CHANGED');for(const source of plan.requiredSources)if(!preparations.some(r=>r.source===source&&r.status==='prepared'))throw fail('SHARED_SOURCE_NOT_SETTLED');
  const topicIds=shared.db.prepare("SELECT id FROM shared_objects WHERE id IN (?,?) OR parent_id IN (?,?)").all(left.id,right.id,left.id,right.id).map(r=>r.id);
  for(const topicId of topicIds)if(shared.active(topicId))throw fail('SHARED_TOPIC_BUSY');
  sharedIdentity(body.keepId);let keep=body.keepId===left.id?left:body.keepId===right.id?right:null;if(!keep)throw fail('INVALID_SHARED_MATCH',400);
  let other=keep.id===left.id?right:left;
  if(plan.history){const longest=plan.history.leftCount>=plan.history.rightCount?left:right;if(keep.id!==longest.id&&plan.history.leftCount!==plan.history.rightCount)throw fail('SHARED_LONGER_HISTORY_REQUIRED');}
  else if(fresh.requiresConfigChoice&&!['left','right'].includes(body.configChoice))throw fail('SHARED_CONFIG_CHOICE_REQUIRED');
  if(!plan.history&&fresh.requiresConfigChoice){
   const chosen=shared.object(body.configChoice==='left'?left:right);
   if(chosen.id!==keep.id){const version=keep.version+1;shared.db.prepare('INSERT INTO shared_configs VALUES(?,?,?,?)').run(keep.id,version,chosen.configHash,JSON.stringify(chosen.config));shared.db.prepare('UPDATE shared_objects SET version=? WHERE id=?').run(version,keep.id);keep.version=version;}
  }
  // Preserve every original message/receipt. Only future routing is canonical.
  shared.db.prepare('INSERT INTO shared_aliases VALUES(?,?)').run(other.id,keep.id);
  shared.db.prepare('UPDATE shared_objects SET deleted=1 WHERE id=?').run(other.id);

  if(!plan.history){
   const children=shared.db.prepare('SELECT * FROM shared_objects WHERE parent_id=? AND deleted=0').all(other.id);
   for(const child of children){shared.db.prepare('UPDATE shared_objects SET parent_id=? WHERE id=?').run(keep.id,child.id);shared.changed(child,'reparented');}
   for(const reference of plan.groups){
    const group=shared.row(body.sharedSpaceId,reference.id),value=shared.object(group).config;
    if(!value.members.includes(other.id))continue;
    value.members=value.members.map(member=>member===other.id?keep.id:member);
    if(value.memberTags&&Object.hasOwn(value.memberTags,other.id)){value.memberTags[keep.id]=value.memberTags[other.id];delete value.memberTags[other.id];}
    for(const order of [value.sequentialSpeakerOrder,value.modeSettings?.sequential?.speakerOrder])if(order)for(let i=0;i<order.length;i++)if(order[i]===other.id)order[i]=keep.id;
    const version=group.version+1;shared.db.prepare('INSERT INTO shared_configs VALUES(?,?,?,?)').run(group.id,version,sha256(stable(value)),JSON.stringify(value));shared.db.prepare('UPDATE shared_objects SET version=? WHERE id=?').run(version,group.id);group.version=version;shared.changed(group,'config');
   }
  }
  if(plan.history)copyAttachmentLinks(shared,keep,other);
  updateBindings(shared,plan,keep,other);
  shared.changed(other,'merged');shared.changed(keep,'merged');const result={object:shared.object(keep),retainedAlias:other.id,kind:plan.kind};
  for(const row of preparations)shared.db.prepare('UPDATE shared_preparations SET proof_json=? WHERE plan_hash=? AND source_id=?').run(JSON.stringify({...row,status:'committed',result}),body.planHash,row.source);
  return result;
 });
}
function copyAttachmentLinks(shared,keep,other){
 if(!shared.store.attachments)return;
 const key=t=>JSON.stringify([t.owner_type,t.owner_id,t.topic_id]);
 const links=shared.db.prepare('SELECT * FROM attachment_links WHERE topic_identity=?').all(key(other));
 for(const link of links){
  const entry=shared.store.readProjected(()=>shared.db.prepare('SELECT * FROM messages WHERE owner_type=? AND owner_id=? AND topic_id=? AND msg_id=? AND deleted=0').all(keep.owner_type,keep.owner_id,keep.topic_id,link.msg_id))[0];
  const attachment=entry?.message.attachments?.find(a=>a.id===link.attachment_id);if(!attachment||![attachment.hash,attachment.blobHash].includes(link.hash))continue;
  const existing=shared.db.prepare('SELECT hash FROM attachment_links WHERE topic_identity=? AND msg_id=? AND attachment_id=?').get(key(keep),link.msg_id,link.attachment_id);if(existing&&existing.hash!==link.hash)throw fail('SYNC_STORAGE_CORRUPT',500);
  shared.db.prepare('INSERT OR IGNORE INTO attachment_links VALUES(?,?,?,?)').run(key(keep),link.msg_id,link.attachment_id,link.hash);
  for(const frame of shared.db.prepare('SELECT * FROM attachment_frames WHERE topic_identity=? AND msg_id=? AND attachment_id=?').all(key(other),link.msg_id,link.attachment_id))if(attachment.frameHashes?.[frame.frame_index]===frame.hash)shared.db.prepare('INSERT OR IGNORE INTO attachment_frames VALUES(?,?,?,?,?)').run(key(keep),link.msg_id,link.attachment_id,frame.frame_index,frame.hash);
 }
}
function updateBindings(shared,plan,keep,other){
 for(const source of plan.requiredSources){
  const choices=shared.db.prepare('SELECT * FROM shared_local_bindings WHERE source_id=? AND object_id IN (?,?) ORDER BY hidden,local_id').all(source,keep.id,other.id);
  const preferred=other.origin_source===source&&keep.origin_source!==source?other.id:keep.id,selected=choices.find(b=>b.object_id===preferred&&!b.hidden)||choices.find(b=>!b.hidden);
  if(!selected)continue;
  shared.db.prepare('UPDATE shared_local_bindings SET object_id=?,hidden=1 WHERE source_id=? AND object_id IN (?,?)').run(keep.id,source,keep.id,other.id);
  shared.db.prepare('UPDATE shared_local_bindings SET hidden=0 WHERE source_id=? AND kind=? AND local_parent=? AND local_id=?').run(source,selected.kind,selected.local_parent,selected.local_id);
  if(keep.kind==='topic')continue;
  const topics=shared.db.prepare("SELECT * FROM shared_objects WHERE parent_id=? AND kind='topic' AND deleted=0 ORDER BY id").all(keep.id);
  for(const topic of topics){
   const old=shared.db.prepare("SELECT * FROM shared_local_bindings WHERE source_id=? AND object_id=? AND kind='topic' AND hidden=0").get(source,topic.id);if(!old||old.local_parent===selected.local_id)continue;
   let localId=old.local_id,collision=shared.db.prepare("SELECT object_id FROM shared_local_bindings WHERE source_id=? AND kind='topic' AND local_parent=? AND local_id=?").get(source,selected.local_id,localId);
   if(collision&&collision.object_id!==topic.id)localId='ns_merge_'+sha256(topic.id).slice(0,24);
   collision=shared.db.prepare("SELECT object_id FROM shared_local_bindings WHERE source_id=? AND kind='topic' AND local_parent=? AND local_id=?").get(source,selected.local_id,localId);if(collision&&collision.object_id!==topic.id)throw fail('SHARED_LOCAL_ALREADY_BOUND');
   shared.db.prepare("UPDATE shared_local_bindings SET hidden=1 WHERE source_id=? AND object_id=? AND kind='topic'").run(source,topic.id);
   shared.db.prepare("INSERT INTO shared_local_bindings(space_id,source_id,kind,local_parent,local_id,object_id,hidden) VALUES(?,?,'topic',?,?,?,0) ON CONFLICT(space_id,source_id,kind,local_parent,local_id) DO UPDATE SET hidden=0").run(keep.space_id,source,selected.local_id,localId,topic.id);
  }
 }
}
module.exports={preview,prepare,confirm,pending,states,one,cancel,applied};

'use strict';
const {stable,sha256}=require('./protocol');
const fail=code=>Object.assign(Error(code),{code,status:409});
/** Shared versions authorize publication. Private execution evidence stays in VCP. */
class SharedCompaction{
 constructor(shared){this.shared=shared;this.db=shared.db;this.db.exec(`
 CREATE TABLE IF NOT EXISTS shared_compaction_intents(id TEXT PRIMARY KEY,principal TEXT NOT NULL,topic_id TEXT NOT NULL,proof_json TEXT NOT NULL,message_id TEXT NOT NULL,committed_seq INTEGER,work_id TEXT,state TEXT NOT NULL DEFAULT 'prepared');
 CREATE TABLE IF NOT EXISTS shared_compaction_native_links(request_id TEXT NOT NULL,proof_hash TEXT NOT NULL,checkpoint_id TEXT NOT NULL,journal_seq INTEGER NOT NULL,through_input_seq INTEGER NOT NULL,PRIMARY KEY(request_id,checkpoint_id));
 CREATE TABLE IF NOT EXISTS shared_work_compactions(work_id TEXT NOT NULL,through_seq INTEGER NOT NULL,checkpoint_id TEXT NOT NULL,journal_seq INTEGER NOT NULL,PRIMARY KEY(work_id,checkpoint_id));`);
 const columns=this.db.prepare('PRAGMA table_info(shared_compaction_intents)').all();if(!columns.some(v=>v.name==='work_id'))this.db.exec('ALTER TABLE shared_compaction_intents ADD COLUMN work_id TEXT');if(!columns.some(v=>v.name==='state'))this.db.exec("ALTER TABLE shared_compaction_intents ADD COLUMN state TEXT NOT NULL DEFAULT 'prepared'");
 this.db.exec("UPDATE shared_compaction_intents SET work_id=json_extract(proof_json,'$.work.id') WHERE work_id IS NULL AND json_extract(proof_json,'$.work.id') IS NOT NULL;UPDATE shared_compaction_intents SET state='committed' WHERE committed_seq IS NOT NULL AND state='prepared';CREATE INDEX IF NOT EXISTS idx_shared_compaction_work ON shared_compaction_intents(work_id,state)");}
 active(workId){return this.db.prepare("SELECT id,principal FROM shared_compaction_intents WHERE work_id=? AND state='prepared' ORDER BY rowid DESC LIMIT 1").get(workId)||null;}
 invalidate(workId){this.db.prepare("UPDATE shared_compaction_intents SET state='superseded' WHERE work_id=? AND state='prepared'").run(workId);}

 topic(actor,space,id){if(actor.kind!=='desktop')throw fail('SHARED_STEERING_DEVICE_REQUIRED');this.shared.authorize(actor,space,'config');if(this.shared.readOnly)throw fail('SHARED_READ_ONLY');const topic=this.shared.topic(actor,space,id,'execute');if(topic.owner_type!=='agent')throw fail('SHARED_COMPACTION_SINGLE_CHAT_ONLY');return topic;}
 snapshot(actor,topic){
  const s=this.shared,work=s.active(topic.id);let control=null,frozenHash=null;
  if(work){
   if(!s.steering.enabled||!require('./sharedTurns').intent(work).steeringCapable)throw fail('WORK_SAFE_BOUNDARY_PENDING');
   control=s.steering.control(work);const generation=s.steering.generation(work.id,control.generation),native=s.native.engine.nativeTasks;
   if(control.executor!==actor.principal)throw fail('WORK_EXECUTOR_HANDOFF_REQUIRED');frozenHash=JSON.parse(generation.config_json).hash;
   if(!generation.checkpoint_json||!['paused','paused_terminal','completed'].includes(generation.state)||native.needsReview(work.id)||native.uncertainTools(work.id)||native.unsettledTools(work.id,generation.request_id)||this.db.prepare("SELECT 1 FROM shared_native_requests WHERE admission_id=? AND state IN ('dispatched','unknown')").get(work.id)||this.db.prepare('SELECT 1 FROM shared_work_inputs WHERE work_id=? AND (attachments_ready=0 OR journal_seq IS NULL)').get(work.id))throw fail('WORK_SAFE_BOUNDARY_PENDING');
  }
  const rows=this.db.prepare(`SELECT m.* FROM messages m WHERE m.owner_type=? AND m.owner_id=? AND m.topic_id=? AND m.deleted=0 ORDER BY (SELECT min(j.seq) FROM journal j WHERE j.owner_type=m.owner_type AND j.owner_id=m.owner_id AND j.topic_id=m.topic_id AND j.msg_id=m.msg_id)`).all(topic.owner_type,topic.owner_id,topic.topic_id);
  const projected=s.store.readProjected(()=>rows),history=projected.map(v=>v.message),lastCheckpoint=projected.filter(v=>v.message.contextCompaction?.kind==='vchat-context-checkpoint').at(-1)?.row.last_seq||0;
  const nativeProofs=[];
  if(s.native)for(const generation of this.db.prepare(`SELECT g.* FROM shared_work_generations g JOIN shared_admissions a ON a.id=g.work_id WHERE a.topic_id=? AND g.checkpoint_json IS NOT NULL ORDER BY a.rowid,g.generation`).all(topic.id)){
   if(JSON.parse(generation.checkpoint_json).noDispatch)continue;
   const stored=this.db.prepare('SELECT proof_json FROM shared_native_checkpoints WHERE work_id=? AND generation=?').get(generation.work_id,generation.generation);if(!stored)throw fail('NATIVE_CHECKPOINT_REQUIRED');const proof=JSON.parse(stored.proof_json);
   const actual=s.native.continuations.proof(generation.request_id,generation.work_id,proof.settledInvocationIds);if(actual.hash!==proof.hash)throw fail('NATIVE_CHECKPOINT_CHANGED');
   nativeProofs.push({requestId:generation.request_id,workId:generation.work_id,hash:actual.hash});
   if(this.db.prepare('SELECT 1 FROM shared_compaction_native_links WHERE request_id=? AND proof_hash=? AND journal_seq<=?').get(generation.request_id,actual.hash,lastCheckpoint))continue;
   const data=s.native.continuations.read(generation.request_id);
   for(const [index,event]of data.events.entries()){
    const content=event.kind==='assistant'?event.content:'[已结清的原生工具结果，不得重复执行]\n'+JSON.stringify(data.results[event.invocationId]);
    if(event.kind==='assistant'&&history.some(m=>m.role==='assistant'&&m.content===content))continue;
    history.push({id:'native_evidence_'+sha256(stable([generation.request_id,index])).slice(0,32),role:event.kind==='assistant'?'assistant':'user',content,name:'原生检查点证据'});
   }
  }
  const proof={topicId:topic.id,head:s.head(topic),configHash:frozenHash||s.freezeForExecution(actor,topic).hash,work:work?{id:work.id,revision:control.revision,generation:control.generation,executor:control.executor}:null,canonical:projected.map(v=>({id:v.row.msg_id,hash:v.row.hash,seq:v.row.last_seq,metadataHash:v.row.metadata_hash})),native:nativeProofs};
  return {proof,history};
 }
 prepare(actor,body){const topic=this.topic(actor,body.sharedSpaceId,body.sharedId);return this.shared.receipt(actor,body,'compact-prepare',()=>{
  if(!Number.isSafeInteger(body.expectedHead)||body.expectedHead!==this.shared.head(topic))throw fail('SHARED_COMPACTION_SOURCE_CHANGED');
  const active=this.shared.active(topic.id);if(active){const control=this.shared.steering.control(active);if(control.executor!==actor.principal)throw fail('WORK_EXECUTOR_HANDOFF_REQUIRED');this.shared.steering.quiesceUnstarted(active,control);}
  this.db.prepare("UPDATE shared_compaction_intents SET state='superseded' WHERE topic_id=? AND principal=? AND state='prepared'").run(topic.id,actor.principal);
  const snapshot=this.snapshot(actor,topic),id='compact_'+sha256(stable([actor.principal,body.opId])).slice(0,40),messageId='checkpoint_'+id;
  this.db.prepare("INSERT INTO shared_compaction_intents(id,principal,topic_id,proof_json,message_id,committed_seq,work_id,state) VALUES(?,?,?,?,?,NULL,?,'prepared')").run(id,actor.principal,topic.id,JSON.stringify(snapshot.proof),messageId,snapshot.proof.work?.id||null);
  return {id,messageId,sourceHash:sha256(stable(snapshot.proof)),head:snapshot.proof.head,workId:snapshot.proof.work?.id||null};
 });}
 get(actor,body){const intent=this.db.prepare('SELECT * FROM shared_compaction_intents WHERE id=?').get(body.id);if(!intent||intent.principal!==actor.principal)throw fail('SHARED_COMPACTION_NOT_FOUND');if(intent.state!=='prepared')throw fail('SHARED_COMPACTION_SUPERSEDED');const topic=this.topic(actor,body.sharedSpaceId,intent.topic_id),snapshot=this.snapshot(actor,topic);if(stable(snapshot.proof)!==stable(JSON.parse(intent.proof_json)))throw fail('SHARED_COMPACTION_SOURCE_CHANGED');return {id:intent.id,messageId:intent.message_id,sourceHash:sha256(stable(snapshot.proof)),history:snapshot.history};}
 cancel(actor,body){return this.shared.receipt(actor,body,'compact-cancel',()=>{
  const intent=this.db.prepare('SELECT * FROM shared_compaction_intents WHERE id=?').get(body.id);if(!intent||intent.principal!==actor.principal)throw fail('SHARED_COMPACTION_NOT_FOUND');this.topic(actor,body.sharedSpaceId,intent.topic_id);
  if(intent.committed_seq)return {success:true,alreadyCommitted:true,messageId:intent.message_id,seq:intent.committed_seq};
  this.db.prepare("UPDATE shared_compaction_intents SET state='cancelled' WHERE id=? AND state='prepared'").run(intent.id);return {success:true,cancelled:true};
 });}
 commit(actor,body){return this.shared.receipt(actor,body,'compact-commit',()=>{
  const intent=this.db.prepare('SELECT * FROM shared_compaction_intents WHERE id=?').get(body.id);if(!intent||intent.principal!==actor.principal)throw fail('SHARED_COMPACTION_NOT_FOUND');if(intent.state!=='prepared')throw fail('SHARED_COMPACTION_SUPERSEDED');const topic=this.topic(actor,body.sharedSpaceId,intent.topic_id),saved=JSON.parse(intent.proof_json),snapshot=this.snapshot(actor,topic);
  if(body.sourceHash!==sha256(stable(saved))||stable(snapshot.proof)!==stable(saved))throw fail('SHARED_COMPACTION_SOURCE_CHANGED');
  const m=body.message,metadata=require('./metadata');if(m?.id!==intent.message_id||m.role!=='user'||!m.contextCompaction||m.attachments?.length)throw fail('INVALID_CHECKPOINT_METADATA');metadata.fieldsFrom(m);
  const value={...m};delete value._nativeSyncMetadata;
  const receipt=this.shared.store.apply({ownerType:topic.owner_type,ownerId:topic.owner_id,topicId:topic.topic_id,msgId:m.id,deviceId:actor.principal,opId:'shared-checkpoint:'+intent.id,baseHash:null,action:'upsert',message:value,metadata:metadata.envelopeFor(m,1)},{sharedSpace:topic.space_id,metadataPublisher:true});
  this.db.prepare("UPDATE shared_compaction_intents SET committed_seq=?,state='committed' WHERE id=?").run(receipt.seq,intent.id);
  for(const p of saved.native)this.db.prepare('INSERT INTO shared_compaction_native_links VALUES(?,?,?,?,?)').run(p.requestId,p.hash,m.id,receipt.seq,saved.work?.revision||0);
  if(saved.work)this.db.prepare('INSERT INTO shared_work_compactions VALUES(?,?,?,?)').run(saved.work.id,saved.work.revision,m.id,receipt.seq);
  return {success:true,messageId:m.id,seq:receipt.seq};
 });}
}
module.exports={SharedCompaction};

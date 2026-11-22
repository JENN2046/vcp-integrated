'use strict';
const {randomUUID} = require('node:crypto');
const {stable,sha256,identity} = require('./protocol');
const {sharedIdentity:id,sharedConfig,SHARED_SPACE_CAPABILITY} = require('./contracts.generated.cjs');
const fail=(code,status=409)=>Object.assign(Error(code),{code,status});
const clone=value=>JSON.parse(JSON.stringify(value));
const tuple=row=>[row.owner_type,row.owner_id,row.topic_id];
function localId(value){try{identity({ownerType:'agent',ownerId:value,topicId:'_local',msgId:'_'});}catch{throw fail('INVALID_SHARED_IDENTITY',400);}return value;}

// Opt-in shared ownership. Source bindings and the accepted message journal are
// preserved; this registry grants access to canonical objects, not new messages.
class SharedSpace {
 constructor(store,config={}, {configurationOnly=false}={}) {
  this.store=store;this.db=store.db;this.catalog=store.sourceCatalog;
  this.configurationOnly=configurationOnly;
  this.safeTools=require('./sharedControlledText').allowedTools(config.NativeSyncSharedSafeTools);
  this.readOnly=config.NativeSyncSharedReadOnly===true||require('./releasePolicy.cjs').sharedReadOnly;
  let grants;try{grants=JSON.parse(config.NativeSyncSharedSpaces||'[]');}catch{throw fail('INVALID_SHARED_GRANTS',400);}
  if(!Array.isArray(grants)||grants.length>32)throw fail('INVALID_SHARED_GRANTS',400);
  this.grants=new Map();
  for(const grant of grants){
   if(!grant||Object.keys(grant).some(k=>!['id','sources'].includes(k))||!Array.isArray(grant.sources)||!grant.sources.length||grant.sources.length>32||new Set(grant.sources).size!==grant.sources.length)throw fail('INVALID_SHARED_GRANTS',400);
   id(grant.id);if(this.grants.has(grant.id))throw fail('INVALID_SHARED_GRANTS',400);
   for(const source of grant.sources){const g=this.catalog?.grants.get(source);if(!g||require('./sourceScope').normalizeScope(g.scope))throw fail('SHARED_FULL_SOURCE_REQUIRED',400);}
   this.grants.set(grant.id,new Set(grant.sources));
  }
  this.atomic(()=>{
   this.db.exec(`CREATE TABLE IF NOT EXISTS shared_schema(version INTEGER NOT NULL PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS shared_spaces(id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS shared_members(space_id TEXT NOT NULL,source_id TEXT NOT NULL,device_id TEXT NOT NULL,PRIMARY KEY(space_id,source_id),UNIQUE(space_id,device_id));
    CREATE TABLE IF NOT EXISTS shared_objects(id TEXT PRIMARY KEY,space_id TEXT NOT NULL,kind TEXT NOT NULL,parent_id TEXT,owner_type TEXT,owner_id TEXT,topic_id TEXT,version INTEGER NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,origin_source TEXT NOT NULL,UNIQUE(owner_type,owner_id,topic_id));
    CREATE INDEX IF NOT EXISTS idx_shared_objects_space ON shared_objects(space_id,id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_shared_single_rules ON shared_objects(space_id) WHERE kind='rules' AND deleted=0;
    CREATE TABLE IF NOT EXISTS shared_configs(object_id TEXT NOT NULL,version INTEGER NOT NULL,hash TEXT NOT NULL,config_json TEXT NOT NULL CHECK(json_valid(config_json)),PRIMARY KEY(object_id,version));
    CREATE TABLE IF NOT EXISTS shared_local_bindings(space_id TEXT NOT NULL,source_id TEXT NOT NULL,kind TEXT NOT NULL,local_parent TEXT NOT NULL DEFAULT '',local_id TEXT NOT NULL,object_id TEXT NOT NULL,hidden INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(space_id,source_id,kind,local_parent,local_id));
    CREATE INDEX IF NOT EXISTS idx_shared_bindings_object ON shared_local_bindings(object_id,source_id);
    CREATE TABLE IF NOT EXISTS shared_aliases(alias_id TEXT PRIMARY KEY,target_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS shared_preparations(plan_hash TEXT NOT NULL,source_id TEXT NOT NULL,proof_json TEXT NOT NULL CHECK(json_valid(proof_json)),PRIMARY KEY(plan_hash,source_id));
    CREATE TABLE IF NOT EXISTS shared_receipts(principal TEXT NOT NULL,op_id TEXT NOT NULL,request_hash TEXT NOT NULL,result_json TEXT NOT NULL CHECK(json_valid(result_json)),PRIMARY KEY(principal,op_id));
    CREATE TABLE IF NOT EXISTS shared_changes(seq INTEGER PRIMARY KEY AUTOINCREMENT,space_id TEXT NOT NULL,object_id TEXT NOT NULL,version INTEGER NOT NULL,kind TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_shared_changes_space ON shared_changes(space_id,seq);
    CREATE TABLE IF NOT EXISTS shared_admissions(id TEXT PRIMARY KEY,space_id TEXT NOT NULL,topic_id TEXT NOT NULL,principal TEXT NOT NULL,request_id TEXT NOT NULL,request_hash TEXT NOT NULL,state TEXT NOT NULL,config_json TEXT NOT NULL CHECK(json_valid(config_json)),context_head INTEGER NOT NULL,user_op TEXT,user_seq INTEGER,reply_seq INTEGER,dispatched INTEGER NOT NULL DEFAULT 0,native_terminal INTEGER NOT NULL DEFAULT 0,UNIQUE(principal,request_id));
    CREATE UNIQUE INDEX IF NOT EXISTS idx_shared_active_topic ON shared_admissions(topic_id) WHERE state IN ('preparing','accepted','dispatched','review_required');`);
   require('./sharedTopicSponsor').schema(this.db);
   const version=this.db.prepare('SELECT max(version) v FROM shared_schema').get().v;
   if(version!==null&&![1,2].includes(version))throw fail('SHARED_SCHEMA_UPGRADE_REQUIRED');
   this.db.prepare('INSERT OR IGNORE INTO shared_schema VALUES(1)').run();
   for(const space of this.grants.keys())this.db.prepare('INSERT OR IGNORE INTO shared_spaces VALUES(?)').run(space);
  });
  this.db.exec('CREATE TABLE IF NOT EXISTS shared_model_save_receipts(principal TEXT NOT NULL,op_id TEXT NOT NULL,owner_id TEXT NOT NULL,model TEXT NOT NULL,version INTEGER NOT NULL,PRIMARY KEY(principal,op_id))');
  if(!configurationOnly)this.compaction=new (require('./sharedCompaction').SharedCompaction)(this);
  const policy=require('./releasePolicy.cjs');
  this.steering=new (require('./sharedSteering').SharedSteering)(this,{enabled:!configurationOnly&&(policy.sharedSteering===true||policy.sharedControlledText===true)});
  // The Mobile runtime owns recovery of existing execution state.
  if(configurationOnly)return;
  // A durable reply intent can wait for AA's final receipt when the parent model
  // is already settled. A lost parent result still needs review after restart.
  const tables=new Set(this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>row.name));
  const recoverableTask=['shared_native_requests','shared_native_child_requests','shared_native_task_controls'].every(name=>tables.has(name))?`
   OR (EXISTS (SELECT 1 FROM shared_native_requests r WHERE r.admission_id=shared_admissions.id AND r.state='model_terminal')
    AND NOT EXISTS (SELECT 1 FROM shared_native_requests r WHERE r.admission_id=shared_admissions.id AND r.state<>'model_terminal')
    AND NOT EXISTS (SELECT 1 FROM shared_native_child_requests r WHERE r.work_id=shared_admissions.id AND r.state IN ('prepared','dispatched','unknown'))
    AND EXISTS (SELECT 1 FROM shared_native_task_controls c WHERE c.work_id=shared_admissions.id AND c.final_revision IS NOT NULL))`:'';
  const publishing=tables.has('mobile_executions')?` AND NOT (EXISTS (SELECT 1 FROM mobile_executions e
   WHERE e.id=shared_admissions.id AND e.state='publishing' AND e.pending_operation IS NOT NULL)
   AND (native_terminal=1${recoverableTask}))`:'';
  // A committed tool pause remains transferable across restarts.
  const safePause=tables.has('shared_native_requests')?` AND NOT (
   coalesce(json_extract(user_op,'$.sharedTurn.controlMode'),'')='safe-tools-v1' AND EXISTS (
    SELECT 1 FROM shared_work_generations g JOIN shared_native_requests r ON r.id=g.request_id
     JOIN shared_native_checkpoints p ON p.work_id=g.work_id AND p.generation=g.generation
     JOIN shared_work_controls c ON c.work_id=g.work_id
    WHERE g.work_id=shared_admissions.id AND g.generation=0 AND g.state='paused'
      AND g.checkpoint_json IS NOT NULL AND r.state='model_terminal'
      AND (c.generation=0 OR (c.generation=1 AND EXISTS (
       SELECT 1 FROM shared_work_generations next WHERE next.work_id=g.work_id AND next.generation=1 AND next.state='prepared')))
      AND NOT EXISTS (SELECT 1 FROM shared_native_requests n WHERE n.admission_id=g.work_id AND n.state IN ('dispatched','unknown'))
   ))`:'';
  // Leave this narrow dispatch shape to SharedNative. Only its native archive
  // and the tool ledger can distinguish a durable final reply from a lost one.
  const nativeFinal=tables.has('shared_native_requests')?` AND NOT (
   coalesce(json_extract(user_op,'$.sharedTurn.controlMode'),'')='safe-tools-v1' AND EXISTS (
    SELECT 1 FROM shared_work_generations g
     JOIN shared_work_controls c ON c.work_id=g.work_id AND c.generation=g.generation
     JOIN shared_native_requests r ON r.id=g.request_id AND r.admission_id=g.work_id
    WHERE g.work_id=shared_admissions.id AND g.generation=1 AND g.state='running'
      AND r.state IN ('dispatched','model_terminal')
   ))`:'';
  const sessionFinal=tables.has('mobile_executions')&&this.db.prepare('PRAGMA table_info(mobile_executions)').all().some(c=>c.name==='native_final_operation')?`
   AND NOT (native_terminal=1 AND EXISTS (SELECT 1 FROM mobile_executions e
     WHERE e.id=shared_admissions.id AND (e.kind IS NULL OR e.kind='shared_session') AND e.state='running'
      AND e.cancel_requested=0 AND e.native_final_operation IS NOT NULL))`:'';
  this.db.prepare("UPDATE shared_admissions SET state='review_required' WHERE state='dispatched'"+publishing+safePause+nativeFinal+sessionFinal).run();
 }
 atomic(fn){
  const own=!this.db.isTransaction;
  this.db.exec(own?'BEGIN IMMEDIATE':'SAVEPOINT shared_operation');
  try{const result=fn();if(result?.then)throw Error('ASYNC_SHARED_TRANSACTION');this.db.exec(own?'COMMIT':'RELEASE shared_operation');return result;}
  catch(error){this.db.exec(own?'ROLLBACK':'ROLLBACK TO shared_operation');if(!own)this.db.exec('RELEASE shared_operation');throw error;}
 }
 desktop(binding,capabilities){
  if(!String(capabilities||'').split(',').includes(SHARED_SPACE_CAPABILITY))throw fail('SHARED_CLIENT_UPGRADE_REQUIRED');
  this.catalog.binding(binding);
  return Object.freeze({kind:'desktop',principal:'desktop:'+binding.deviceId,sourceId:binding.sourceId,deviceId:binding.deviceId,capabilities:String(capabilities||'')});
 }
 mobile(session,space,permission){
  id(space);if(!session?.id||!this.grants.has(space)||!session.scopes?.includes('shared:'+space+':'+permission))throw fail('SHARED_PERMISSION_REQUIRED',403);
  return Object.freeze({kind:'mobile',principal:'mobile:'+session.id,spaceId:space,permissions:session.scopes.filter(s=>s.startsWith('shared:'+space+':')).map(s=>s.split(':')[2])});
 }
 authorize(actor,space,permission='read',member=true){
  id(space);const grant=this.grants.get(space);if(!grant)throw fail('SHARED_SPACE_NOT_APPROVED',403);
  if(actor?.kind==='desktop'){
   if(!grant.has(actor.sourceId)||this.catalog.grants.get(actor.sourceId)?.deviceId!==actor.deviceId)throw fail('SHARED_SPACE_NOT_APPROVED',403);
   if(member&&!this.db.prepare('SELECT 1 FROM shared_members WHERE space_id=? AND source_id=? AND device_id=?').get(space,actor.sourceId,actor.deviceId))throw fail('SHARED_MEMBERSHIP_REQUIRED',403);
  }else if(actor?.kind!=='mobile'||actor.spaceId!==space||!actor.permissions.includes(permission))throw fail('SHARED_PERMISSION_REQUIRED',403);
 }
 receipt(actor,body,action,fn){
  if(this.readOnly)throw fail('SHARED_READ_ONLY');
  id(body.opId);const hash=sha256(stable({action,body}));
  const result=this.atomic(()=>{
   const old=this.db.prepare('SELECT * FROM shared_receipts WHERE principal=? AND op_id=?').get(actor.principal,body.opId);
   if(old){if(old.request_hash!==hash)throw fail('IDEMPOTENCY_KEY_REUSED');return {...JSON.parse(old.result_json),replayed:true};}
   const result=fn();this.db.prepare('INSERT INTO shared_receipts VALUES(?,?,?,?)').run(actor.principal,body.opId,hash,JSON.stringify(result));return {...result,replayed:false};
  });
  this.store.onSharedChange?.();return result;
 }
 join(actor,body){
  this.authorize(actor,body.sharedSpaceId,'config',false);if(actor.kind!=='desktop')throw fail('SHARED_DEVICE_REQUIRED',403);
  return this.receipt(actor,body,'join',()=>{
   if(this.db.prepare('SELECT 1 FROM shared_members WHERE source_id=? AND space_id<>?').get(actor.sourceId,body.sharedSpaceId))throw fail('SHARED_SOURCE_ALREADY_JOINED');
   this.db.prepare('INSERT OR IGNORE INTO shared_members VALUES(?,?,?)').run(body.sharedSpaceId,actor.sourceId,actor.deviceId);
   return {joined:true,sharedSpaceId:body.sharedSpaceId};
  });
 }
 row(space,objectId,allowDeleted=false){
  id(objectId);const row=this.db.prepare('SELECT * FROM shared_objects WHERE id=? AND space_id=?').get(objectId,space);
  if(!row||row.deleted&&!allowDeleted)throw fail('SHARED_OBJECT_NOT_FOUND',404);return row;
 }
 canonical(space,objectId){
  const seen=new Set();let current=objectId;
  for(;;){if(seen.has(current))throw fail('SYNC_STORAGE_CORRUPT',500);seen.add(current);
   const alias=this.db.prepare('SELECT target_id FROM shared_aliases WHERE alias_id=?').get(current);
   if(!alias)return this.row(space,current);current=alias.target_id;
  }
 }
 object(row){
  const config=this.db.prepare('SELECT hash,config_json FROM shared_configs WHERE object_id=? AND version=?').get(row.id,row.version);
  if(!config||sha256(stable(JSON.parse(config.config_json)))!==config.hash)throw fail('SYNC_STORAGE_CORRUPT',500);
  return {id:row.id,sharedSpaceId:row.space_id,kind:row.kind,parentId:row.parent_id,version:row.version,configHash:config.hash,config:JSON.parse(config.config_json),deleted:Boolean(row.deleted),originSource:row.origin_source,...(row.owner_type?{topic:{ownerType:row.owner_type,ownerId:row.owner_id,topicId:row.topic_id}}:{})};
 }
 get(actor,space,objectId){this.authorize(actor,space,'config');return this.object(this.row(space,objectId,true));}
 directory(actor,{sharedSpaceId,after='',limit=128}){
  this.authorize(actor,sharedSpaceId);if(!Number.isSafeInteger(limit)||limit<1||limit>128||typeof after!=='string'||after.length>96)throw fail('INVALID_SHARED_PAGE',400);
  return this.store.readSnapshot(()=>{
   const rows=this.db.prepare('SELECT * FROM shared_objects WHERE space_id=? AND id>? ORDER BY id LIMIT ?').all(sharedSpaceId,after,limit+1),page=rows.slice(0,limit);
   const head=this.db.prepare('SELECT coalesce(max(seq),0) n FROM shared_changes WHERE space_id=?').get(sharedSpaceId).n;
   const configAllowed=actor.kind==='desktop'||actor.permissions.includes('config');
   return {objects:page.map(row=>{const value=this.object(row);if(!configAllowed){value.name=value.config.name;delete value.config;}return value;}),next:page.at(-1)?.id||after,hasMore:rows.length>limit,revision:head};
  });
 }
 changes(actor,{sharedSpaceId,after=0,limit=128}){
  this.authorize(actor,sharedSpaceId);if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>128)throw fail('INVALID_SHARED_PAGE',400);
  return this.store.readSnapshot(()=>{const rows=this.db.prepare('SELECT * FROM shared_changes WHERE space_id=? AND seq>? ORDER BY seq LIMIT ?').all(sharedSpaceId,after,limit+1),page=rows.slice(0,limit);return {changes:page.map(r=>({seq:r.seq,id:r.object_id,version:r.version,kind:r.kind})),next:page.at(-1)?.seq??after,hasMore:rows.length>limit};});
 }
 changed(row,kind){this.db.prepare('INSERT INTO shared_changes(space_id,object_id,version,kind) VALUES(?,?,?,?)').run(row.space_id,row.id,row.version,kind);}
 validateRelations(space,kind,config){
  if(kind==='group')for(const member of config.members){const row=this.row(space,member);if(row.kind!=='agent')throw fail('INVALID_SHARED_MEMBER',400);}
 }
 create(actor,body){
  const space=body.sharedSpaceId;this.authorize(actor,space,'config');
  if(actor.kind!=='desktop')throw fail('SHARED_DEVICE_REQUIRED',403);
  localId(body.localId);if(body.localParent!==undefined)localId(body.localParent);
  const config=sharedConfig(body.kind,body.config);
  return this.receipt(actor,body,'create',()=>{
   this.validateRelations(space,body.kind,config);
   if(body.kind==='rules'){
    const existing=this.db.prepare("SELECT * FROM shared_objects WHERE space_id=? AND kind='rules' AND deleted=0").get(space);
    if(existing){
     this.db.prepare('INSERT INTO shared_local_bindings(space_id,source_id,kind,local_parent,local_id,object_id) VALUES(?,?,?,?,?,?)').run(space,actor.sourceId,'rules','',body.localId,existing.id);
     return {object:this.object(existing),existing:true};
    }
   }
   const prior=this.db.prepare('SELECT 1 FROM shared_local_bindings WHERE space_id=? AND source_id=? AND kind=? AND local_parent=? AND local_id=?').get(space,actor.sourceId,body.kind,body.localParent||'',body.localId);
   if(prior)throw fail('SHARED_LOCAL_ALREADY_BOUND');
   const sharedId='shared_'+randomUUID().replaceAll('-','');let topic=null,parent=null;
   if(body.kind==='topic'){
    parent=this.row(space,body.parentId);this.assertNotPrepared([parent.id]);if(!['agent','group'].includes(parent.kind))throw fail('INVALID_SHARED_PARENT',400);
    topic={ownerType:parent.kind,ownerId:parent.id,topicId:sharedId};identity({...topic,msgId:'_'});
   }else if(body.parentId!==undefined)throw fail('INVALID_SHARED_PARENT',400);
   this.db.prepare('INSERT INTO shared_objects VALUES(?,?,?,?,?,?,?,?,0,?)').run(sharedId,space,body.kind,parent?.id||null,topic?.ownerType||null,topic?.ownerId||null,topic?.topicId||null,1,actor.sourceId);
   this.db.prepare('INSERT INTO shared_configs VALUES(?,?,?,?)').run(sharedId,1,sha256(stable(config)),JSON.stringify(config));
   this.db.prepare('INSERT INTO shared_local_bindings(space_id,source_id,kind,local_parent,local_id,object_id) VALUES(?,?,?,?,?,?)').run(space,actor.sourceId,body.kind,body.localParent||'',body.localId,sharedId);
   const row=this.row(space,sharedId);this.changed(row,'created');return {object:this.object(row)};
  });
 }
 bind(actor,body){
  this.authorize(actor,body.sharedSpaceId,'config');if(actor.kind!=='desktop')throw fail('SHARED_DEVICE_REQUIRED',403);localId(body.localId);if(body.localParent!==undefined)localId(body.localParent);
  return this.receipt(actor,body,'bind',()=>{const row=this.row(body.sharedSpaceId,body.sharedId);if(body.restore===true)this.assertNotPrepared([row.id,row.parent_id]);
   const hidden=this.db.prepare('SELECT 1 FROM shared_local_bindings b WHERE b.source_id=? AND b.object_id=? AND b.hidden=1 AND NOT EXISTS(SELECT 1 FROM shared_local_bindings a WHERE a.source_id=b.source_id AND a.object_id=b.object_id AND a.hidden=0) LIMIT 1').get(actor.sourceId,row.id);if(hidden&&body.restore!==true)throw fail('SHARED_LOCAL_REMOVED');if(body.restore!==undefined&&typeof body.restore!=='boolean')throw fail('INVALID_SHARED_REQUEST',400);
   const existing=this.db.prepare('SELECT * FROM shared_local_bindings WHERE space_id=? AND source_id=? AND kind=? AND local_parent=? AND local_id=?').get(body.sharedSpaceId,actor.sourceId,row.kind,body.localParent||'',body.localId);
   if(existing&&existing.object_id!==row.id)throw fail('SHARED_LOCAL_ALREADY_BOUND');
   this.db.prepare('INSERT INTO shared_local_bindings(space_id,source_id,kind,local_parent,local_id,object_id) VALUES(?,?,?,?,?,?) ON CONFLICT(space_id,source_id,kind,local_parent,local_id) DO UPDATE SET hidden=0').run(body.sharedSpaceId,actor.sourceId,row.kind,body.localParent||'',body.localId,row.id);
   return {object:this.object(row)};
  });
 }
 modelSaveReceipt(actor,opId,object){if(object.kind==='agent'&&typeof object.config.model==='string')this.db.prepare('INSERT OR IGNORE INTO shared_model_save_receipts VALUES(?,?,?,?,?)').run(actor.principal,opId,object.id,object.config.model,object.version);}
 checkModelSave(actor,topic,reference,config,resolution){if(!reference)return;if(resolution){if(resolution.model!==reference.model)throw fail('MODEL_SAVE_REFERENCE_CHANGED');reference=resolution;}if(typeof reference.opId!=='string'||typeof reference.model!=='string'||config.owner.config.model!==reference.model)throw fail('MODEL_SAVE_NOT_CURRENT');const receipt=this.db.prepare('SELECT 1 FROM shared_model_save_receipts WHERE principal=? AND op_id=? AND owner_id=? AND model=?').get(actor.principal,reference.opId,topic.owner_id,reference.model);if(!receipt)throw fail('MODEL_SAVE_REFERENCE_UNCONFIRMED');}
 saveConfig(actor,body){
  this.authorize(actor,body.sharedSpaceId,'config');
  if(this.configurationOnly&&this.row(body.sharedSpaceId,body.sharedId).kind!=='agent')throw fail('SHARED_CONFIGURATION_ONLY');
  return this.receipt(actor,body,'config',()=>{
   const row=this.row(body.sharedSpaceId,body.sharedId),config=sharedConfig(row.kind,body.config);this.assertNotPrepared([row.id,row.parent_id]);
   if(!Number.isSafeInteger(body.expectedVersion)||body.expectedVersion!==row.version)throw fail('SHARED_CONFIG_CONFLICT');
   this.validateRelations(body.sharedSpaceId,row.kind,config);
   if(stable(config)===stable(this.object(row).config)){this.modelSaveReceipt(actor,body.opId,this.object(row));return {object:this.object(row)};}
   const version=row.version+1;this.db.prepare('INSERT INTO shared_configs VALUES(?,?,?,?)').run(row.id,version,sha256(stable(config)),JSON.stringify(config));
   this.db.prepare('UPDATE shared_objects SET version=? WHERE id=?').run(version,row.id);row.version=version;this.changed(row,'config');this.modelSaveReceipt(actor,body.opId,this.object(row));
   return {object:this.object(row)};
  });
 }
 executionTrajectory(actor,query){return require('./nativeTrajectory').list(this,actor,query);}
 cancelSession(actor,body){return require('./nativeTrajectory').cancel(this,actor,body);}
 remove(actor,body){
  this.authorize(actor,body.sharedSpaceId,'config');
  if(!['device','all'].includes(body.mode))throw fail('INVALID_SHARED_DELETE',400);
  return this.receipt(actor,body,'remove',()=>{
   const row=this.row(body.sharedSpaceId,body.sharedId,true);this.assertNotPrepared([row.id,row.parent_id]);
   const active=this.db.prepare("SELECT 1 FROM shared_admissions a JOIN shared_objects t ON t.id=a.topic_id WHERE (t.id=? OR t.parent_id=? OR EXISTS(SELECT 1 FROM json_each(a.config_json,'$.members') m WHERE json_extract(m.value,'$.id')=?)) AND a.state IN ('preparing','accepted','dispatched','review_required') LIMIT 1").get(row.id,row.id,row.id);
   if(active)throw fail('SHARED_TOPIC_BUSY');
   if(body.mode==='device'){
    if(actor.kind!=='desktop')throw fail('SHARED_DEVICE_REQUIRED',403);
    this.db.prepare('UPDATE shared_local_bindings SET hidden=1 WHERE object_id=? AND source_id=?').run(row.id,actor.sourceId);return {removed:'device',sharedId:row.id};
   }
   if(body.confirm!==true||body.expectedVersion!==row.version)throw fail('SHARED_DELETE_CONFIRMATION_REQUIRED');
   const rows=this.db.prepare('SELECT * FROM shared_objects WHERE (id=? OR parent_id=?) AND deleted=0').all(row.id,row.id);
   for(const r of rows){this.db.prepare('UPDATE shared_objects SET deleted=1 WHERE id=?').run(r.id);this.changed(r,'deleted');}
   return {removed:'all',sharedId:row.id};
  });
 }
 topicFor(tupleValue){return this.db.prepare("SELECT * FROM shared_objects WHERE owner_type=? AND owner_id=? AND topic_id=? AND kind='topic'").get(...tupleValue);}
 legacyGuard(topic){if(this.topicFor([topic.ownerType,topic.ownerId,topic.topicId]))throw fail('SHARED_CLIENT_UPGRADE_REQUIRED');}
 adopt(actor,body){
  const space=body.sharedSpaceId;this.authorize(actor,space,'config');if(actor.kind!=='desktop')throw fail('SHARED_DEVICE_REQUIRED',403);
  const kind=body.kind,ownerType=kind==='topic'?body.ownerType:kind,ownerId=kind==='topic'?body.localParent:body.localId,topicId=kind==='topic'?body.localId:'';
  if(!['agent','group'].includes(ownerType)||!['agent','group','topic'].includes(kind))throw fail('INVALID_SHARED_IDENTITY',400);
  try{identity({ownerType,ownerId,topicId:topicId||'_owner',msgId:'_'});}catch{throw fail('INVALID_SHARED_IDENTITY',400);}
  const config=sharedConfig(kind,body.config);
  return this.receipt(actor,body,'adopt',()=>{
   const source=this.catalog.entity(actor.sourceId,ownerType,ownerId,topicId);
   if(!source||source.deleted||kind==='topic'&&!source.ready)throw fail('SHARED_SOURCE_NOT_SETTLED');
   if(this.db.prepare('SELECT 1 FROM shared_objects WHERE owner_type=? AND owner_id=? AND topic_id=?').get(ownerType,ownerId,topicId))throw fail('SHARED_LOCAL_ALREADY_BOUND');
   this.validateRelations(space,kind,config);
   let parent=null;if(kind==='topic'){
    parent=this.row(space,body.parentId);this.assertNotPrepared([parent.id]);if(parent.kind!==ownerType)throw fail('INVALID_SHARED_PARENT',400);
    const ownerBinding=this.db.prepare('SELECT 1 FROM shared_local_bindings WHERE space_id=? AND source_id=? AND kind=? AND local_id=? AND object_id=?').get(space,actor.sourceId,ownerType,ownerId,parent.id);
    if(!ownerBinding)throw fail('SHARED_LOCAL_MAPPING_REQUIRED');
   }
   const objectId='shared_'+randomUUID().replaceAll('-','');
   this.db.prepare('INSERT INTO shared_objects VALUES(?,?,?,?,?,?,?,?,0,?)').run(objectId,space,kind,parent?.id||null,ownerType,ownerId,topicId,1,actor.sourceId);
   this.db.prepare('INSERT INTO shared_configs VALUES(?,?,?,?)').run(objectId,1,sha256(stable(config)),JSON.stringify(config));
   this.db.prepare('INSERT INTO shared_local_bindings(space_id,source_id,kind,local_parent,local_id,object_id) VALUES(?,?,?,?,?,?)').run(space,actor.sourceId,kind,kind==='topic'?ownerId:'',body.localId,objectId);
   const row=this.row(space,objectId);this.changed(row,'adopted');return {object:this.object(row)};
  });
 }
 assertNotPrepared(ids){return require('./sharedMatching').pending(this,ids);}
 matchState(actor,body){return require('./sharedMatching').one(this,actor,body);}
 matchStates(actor,body){return require('./sharedMatching').states(this,actor,body);}
 cancelMatch(actor,body){return require('./sharedMatching').cancel(this,actor,body);}
 appliedMatch(actor,body){return require('./sharedMatching').applied(this,actor,body);}
 previewMatch(actor,body){return require('./sharedMatching').preview(this,actor,body);}
 prepareMatch(actor,body){return require('./sharedMatching').prepare(this,actor,body);}
 confirmMatch(actor,body){return require('./sharedMatching').confirm(this,actor,body);}
 nativeJob(admissionId){const row=this.db.prepare('SELECT * FROM shared_admissions WHERE id=?').get(admissionId);return row?{...row,topic_key:row.topic_id}:null;}
 sourceManaged(sourceId){return Boolean(this.db.prepare('SELECT 1 FROM shared_members WHERE source_id=? LIMIT 1').get(sourceId));}
 prepareNative(actor,body){if(!this.native)throw fail('SHARED_NATIVE_UNAVAILABLE',503);return this.native.prepare(actor,body);}
 beginSharedBaseline(actor,body){const row=this.topic(actor,body.sharedSpaceId,body.sharedId);return this.catalog.beginMobile(actor.principal,{key:row.id,ownerType:row.owner_type,ownerId:row.owner_id,topicId:row.topic_id},body.planId);}
 sharedBaseline(actor,body){const row=this.topic(actor,body.sharedSpaceId,body.sharedId);return this.catalog.mobilePage(actor.principal,{key:row.id,ownerType:row.owner_type,ownerId:row.owner_id,topicId:row.topic_id},body.baselineId,body.after??0,body.limit??100);}
 topic(actor,space,topicId,permission='read'){
  this.authorize(actor,space,permission);const row=this.canonical(space,topicId);
  if(row.kind!=='topic')throw fail('SHARED_TOPIC_REQUIRED',400);
  this.row(space,row.parent_id);if(permission==='execute'&&actor.kind==='desktop'&&this.db.prepare('SELECT 1 FROM shared_local_bindings b WHERE b.source_id=? AND b.hidden=1 AND b.object_id IN (?,?) AND NOT EXISTS(SELECT 1 FROM shared_local_bindings a WHERE a.source_id=b.source_id AND a.object_id=b.object_id AND a.hidden=0) LIMIT 1').get(actor.sourceId,row.id,row.parent_id))throw fail('SHARED_LOCAL_REMOVED');return row;
 }
 history(actor,{sharedSpaceId,sharedId,after=0,limit=100}){
  const topic=this.topic(actor,sharedSpaceId,sharedId);if(topic.id!==sharedId&&after>0)throw fail('SHARED_TOPIC_MERGED');
  return this.store.pull(after,limit,[JSON.stringify(tuple(topic))],{spaceId:sharedSpaceId});
 }
 topicHistory(actor,{sharedSpaceId,sharedId,after=0,limit=100}){
  const topic=this.topic(actor,sharedSpaceId,sharedId);if(topic.id!==sharedId)throw fail('SHARED_TOPIC_MERGED');
  if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>500)throw fail('INVALID_CURSOR',400);
  // A separate topic cursor. It conveys no progress over other Journal rows.
  return this.store.readSnapshot(()=>{
   const headSeq=Math.max(after,this.head(topic));
   const rows=this.db.prepare('SELECT seq FROM journal WHERE owner_type=? AND owner_id=? AND topic_id=? AND seq>? ORDER BY seq LIMIT ?').all(...tuple(topic),after,limit);
   const seqs=rows.map(v=>v.seq),records=this.store.readProjected(()=>seqs.length?this.store.readJournalSeqs.all(JSON.stringify(seqs)):[]);
   const events=records.map(({row,message})=>({seq:Number(row.seq),ownerType:row.owner_type,ownerId:row.owner_id,topicId:row.topic_id,msgId:row.msg_id,action:row.action,hash:row.hash,message,sourceDevice:row.device_id}));
   const nextSeq=rows.at(-1)?.seq??after;return {sharedId:topic.id,events,headSeq,nextSeq,hasMore:nextSeq<headSeq};
  });
 }
 spaceHistory(actor,{sharedSpaceId,after=0,limit=100}){
  this.authorize(actor,sharedSpaceId);
  const topics=this.db.prepare("SELECT t.* FROM shared_objects t JOIN shared_objects o ON o.id=t.parent_id WHERE t.space_id=? AND t.kind='topic' AND t.deleted=0 AND o.deleted=0 AND NOT EXISTS(SELECT 1 FROM shared_local_bindings b WHERE b.source_id=? AND b.hidden=1 AND b.object_id IN (t.id,o.id) AND NOT EXISTS(SELECT 1 FROM shared_local_bindings a WHERE a.source_id=b.source_id AND a.object_id=b.object_id AND a.hidden=0))").all(sharedSpaceId,actor.kind==='desktop'?actor.sourceId:'');
  return this.store.pull(after,limit,topics.map(row=>JSON.stringify(tuple(row))),{spaceId:sharedSpaceId});
 }
 bindings(actor,{sharedSpaceId}){
  this.authorize(actor,sharedSpaceId);if(actor.kind!=='desktop')throw fail('SHARED_DEVICE_REQUIRED',403);
  return {bindings:this.db.prepare('SELECT kind,local_parent AS localParent,local_id AS localId,object_id AS sharedId,hidden FROM shared_local_bindings WHERE space_id=? AND source_id=? ORDER BY kind,local_parent,local_id').all(sharedSpaceId,actor.sourceId).map(row=>({...row,hidden:Boolean(row.hidden)}))};
 }
 head(row){return Number(this.db.prepare('SELECT coalesce(max(seq),0) n FROM journal WHERE owner_type=? AND owner_id=? AND topic_id=?').get(...tuple(row)).n);}
 freeze(row){
  const owner=this.object(this.row(row.space_id,row.parent_id));
  const members=owner.kind==='group'?owner.config.members.map(member=>this.object(this.row(row.space_id,member))):[];
  const rules=this.db.prepare("SELECT * FROM shared_objects WHERE space_id=? AND kind='rules' AND deleted=0 ORDER BY id").all(row.space_id).map(r=>this.object(r));
  const config={owner,members,rules};return {hash:sha256(stable(config)),...config};
 }
 freezeForExecution(actor,topic){const config=this.freeze(topic);
   // Freeze the exact derived native prompt/rules with the admission, before
   // any dispatch. Later AgentManager or shared edits affect new requests only.
   const configs=this.native?.engine.configs,latest=configs?.latest(topic.id);
   if(latest){const execution=JSON.parse(latest.config_json);if(execution.sharedTemplateHash===config.hash){
    const descriptor=configs.topics.find(t=>t.key===topic.id&&t.sharedSpaceId===topic.space_id);
    config.execution=configs.verify(descriptor,{version:latest.version,hash:latest.hash,...execution},{desktopContext:actor.kind==='desktop'});
   }}
   if(configs&&!config.execution&&[config.owner,...config.members].some(o=>configs.hasAgentReference(o.config.systemPrompt||'').length))throw fail('SHARED_CONFIG_PENDING');
  return config;
 }
 executionConfig(actor,{sharedSpaceId,sharedId,sharedSessionHistory=false}){
  const row=this.topic(actor,sharedSpaceId,sharedId,'execute');
  return this.store.readSnapshot(()=>{
   const result={...this.freeze(row),head:this.head(row)};
   if(sharedSessionHistory&&row.owner_type==='agent'){
    const context=require('../mobile/effectiveContext');
    result.desktopHistoryRequired=context.requiresDesktopContext(context.admissionHistory(this.store,tuple(row),result.head));
   }
   return result;
  });
 }
 sessionSend(actor,body){return require('./sharedSession').send(this,actor,body);}
 active(topicId){return this.db.prepare("SELECT * FROM shared_admissions WHERE topic_id=? AND state IN ('preparing','accepted','dispatched','review_required')").get(topicId);}
 admission(actor,space,admissionId){
  this.authorize(actor,space,'execute');id(admissionId);
  const row=this.db.prepare('SELECT * FROM shared_admissions WHERE id=? AND space_id=?').get(admissionId,space);
  if(!row)throw fail('SHARED_REQUEST_NOT_FOUND',404);return row;
 }
 publicAdmission(row){const control=this.db.prepare('SELECT * FROM shared_work_controls WHERE work_id=?').get(row.id),turn=require('./sharedTurns').intent(row),stop=row.principal.startsWith('mobile:')&&turn.plan?.length?this.native?.engine.get?.(row.id)?.group_stop_index:null;return {id:row.id,sharedSpaceId:row.space_id,sharedId:row.topic_id,requestId:row.request_id,state:row.state,configHash:JSON.parse(row.config_json).hash,contextHead:row.context_head,userSeq:row.user_seq,replySeq:row.reply_seq,dispatched:Boolean(row.dispatched),turn,...(stop!=null?{remainingCancelled:true,firstSkippedOrdinal:stop}:{}),...(turn.steeringCapable&&this.steering&&(this.steering.enabled||control)?{steering:this.steering.public(row,control)}:{})};}
 async taskResult(actor,{sharedSpaceId,workId,nativeTaskId}){const row=this.admission(actor,sharedSpaceId,workId),topic=this.topic(actor,sharedSpaceId,row.topic_id);if(!this.native)throw fail('SHARED_NATIVE_UNAVAILABLE');return this.native.engine.nativeTasks.result(topic.id,row.id,nativeTaskId);}
 workState(actor,{sharedSpaceId,workId}){const row=this.admission(actor,sharedSpaceId,workId);this.topic(actor,sharedSpaceId,row.topic_id,'execute');return {request:this.publicWork(actor,row)};}
 publicWork(actor,row){
  const canStop=!this.readOnly&&row.principal===actor.principal&&row.state==='dispatched'&&!this.native?.closed&&!this.native?.draining;
  const nativeTasks=(this.native?.engine.nativeTasks.list(row.id)||[]).map(task=>({...task,
   stopAllowed:canStop&&task.pluginName==='AgentAssistant'&&['accepted','running','waiting'].includes(task.state),
   stopRequested:task.state==='cancelling',
  }));
  return {...this.publicAdmission(row),nativeRequests:this.nativeStatus(row),nativeTasks,toolInvocations:this.native?.engine.nativeTasks.invocations(row.id)||[]};
 }
 async stopTask(actor,{sharedSpaceId,workId,nativeTaskId}){
  const row=this.admission(actor,sharedSpaceId,workId);
  this.topic(actor,sharedSpaceId,row.topic_id,'execute');
  if(row.principal!==actor.principal)throw fail('SHARED_REQUEST_OWNER_REQUIRED',403);
  if(this.readOnly)throw fail('SHARED_READ_ONLY');
  if(!this.native||this.native.closed||this.native.draining)throw fail('SHARED_NATIVE_UNAVAILABLE');
  await this.native.engine.nativeTasks.stop(workId,nativeTaskId,row.state==='dispatched');
  return this.workState(actor,{sharedSpaceId,workId});
 }
 activeWork(actor,{sharedSpaceId,sharedId}){const topic=this.topic(actor,sharedSpaceId,sharedId,'execute'),row=this.active(topic.id);return row?this.workState(actor,{sharedSpaceId,workId:row.id}):{request:null};}
 requestConfig(actor,{sharedSpaceId,admissionId}){
  this.authorize(actor,sharedSpaceId,'config');
  const row=this.admission(actor,sharedSpaceId,admissionId);
  if(row.principal!==actor.principal)throw fail('SHARED_REQUEST_OWNER_REQUIRED',403);
  return {config:JSON.parse(row.config_json)};
 }
 nativeStatus(row){if(!this.native)return [];return [...this.db.prepare('SELECT id,state,member_id AS memberId,ordinal FROM shared_native_requests WHERE admission_id=? ORDER BY ordinal').all(row.id),...this.db.prepare('SELECT id,state,task_id AS nativeTaskId,control_revision AS controlRevision FROM shared_native_child_requests WHERE work_id=? ORDER BY id').all(row.id).map(v=>({...v,child:true}))].map(v=>({...v,phases:Object.fromEntries(this.db.prepare('SELECT stage,at FROM shared_request_phases WHERE request_id=? ORDER BY at').all(v.id).map(p=>[p.stage,p.at]))}));}
 request(actor,{sharedSpaceId,requestId}){
  this.authorize(actor,sharedSpaceId,'execute');id(requestId);
  const row=this.db.prepare('SELECT * FROM shared_admissions WHERE principal=? AND request_id=? AND space_id=?').get(actor.principal,requestId,sharedSpaceId);
  return {request:row?this.publicWork(actor,row):null};
 }
 admit(actor,body,{session=false,sponsor=null}={}){
  if(session&&body.controlMode!==undefined)throw fail('SHARED_SESSION_CONTROL_MODE_UNSUPPORTED',400);
  const sponsored=sponsor===require('./sharedTopicSponsor').dispatchKey&&session;
  if(this.readOnly)throw fail('SHARED_READ_ONLY');
  const topic=this.topic(actor,body.sharedSpaceId,body.sharedId,'execute');id(body.requestId);
  if((body.kind||'message')==='message'&&body.message?.role!==(sponsored?'assistant':'user'))throw fail('INVALID_SHARED_SUBMISSION',400);
  if(body.sponsorRouteHash!==undefined&&(actor.kind!=='desktop'||topic.owner_type!=='agent'||(body.kind||'message')!=='message'||typeof body.sponsorRouteHash!=='string'||!/^[a-f0-9]{64}$/.test(body.sponsorRouteHash)))throw fail('INVALID_TOPIC_SPONSOR_ROUTE',400);
  const requestHash=sha256(stable(body));
  return this.atomic(()=>{
   const old=this.db.prepare('SELECT * FROM shared_admissions WHERE principal=? AND request_id=?').get(actor.principal,body.requestId);
   if(old){if(old.request_hash!==requestHash)throw fail('REQUEST_ID_REUSED');return {...this.publicAdmission(old),replayed:true};}
   this.assertNotPrepared([topic.id,topic.parent_id]);if(this.active(topic.id))throw fail('SHARED_TOPIC_BUSY');
   const config=this.freezeForExecution(actor,topic),head=this.head(topic);
   if(body.expectedHead!==head||body.configHash!==config.hash)throw fail('SHARED_CONTEXT_CHANGED');this.checkModelSave(actor,topic,body.modelSaveRef,config,body.modelSaveResolutionRef);
   const turn=require('./sharedTurns').prepare(this,topic,config,body,sponsored),message=body.message;if(require('./sharedControlledText').admit(this,actor,topic,config,body,turn)){turn.steeringCapable=true;turn.controlMode=body.controlMode;this.db.prepare('INSERT OR IGNORE INTO shared_schema VALUES(2)').run();}require('./sharedAttachments').validate(this,actor,topic,message,config,turn);if(turn.kind==='message'&&(!message||message.role!==(sponsored?'assistant':'user')||typeof message.id!=='string'||!message.id))throw fail('INVALID_SHARED_SUBMISSION',400);
   const admissionId='request_'+randomUUID().replaceAll('-','');
   const acceptedMessage=turn.steeringCapable||session?{...message,continuity:{version:1,known:true,executionId:admissionId,requestId:body.requestId,dependsOnMessageIds:[]}}:message;
   const op=turn.kind==='message'?{ownerType:topic.owner_type,ownerId:topic.owner_id,topicId:topic.topic_id,msgId:message.id,deviceId:actor.principal,opId:'shared-user:'+body.requestId,baseHash:null,action:'upsert',message:{...acceptedMessage}}:{};
   if(turn.kind==='message'&&this.store.findMessage.get(...tuple(topic),message.id))throw fail('SHARED_MESSAGE_ALREADY_EXISTS');
   this.db.prepare("INSERT INTO shared_admissions(id,space_id,topic_id,principal,request_id,request_hash,state,config_json,context_head,user_op) VALUES(?,?,?,?,?,?,'preparing',?,?,?)").run(admissionId,topic.space_id,topic.id,actor.principal,body.requestId,requestHash,JSON.stringify(config),head,JSON.stringify({...op,sharedTurn:turn,...(body.sponsorRouteHash?{sponsorRouteHash:body.sponsorRouteHash}:{})}));
   let receipt={seq:head};
   if(turn.kind==='message'){const metadata=require('./metadata');op.metadata=metadata.envelopeFor(op.message,1);delete op.message._nativeSyncMetadata;receipt=this.store.apply(op,{sharedSpace:topic.space_id,attachmentPrincipal:actor.principal,metadataPublisher:true});}
   this.db.prepare("UPDATE shared_admissions SET state='accepted',user_seq=? WHERE id=?").run(receipt.seq,admissionId);
   const accepted=this.admission(actor,topic.space_id,admissionId);if(turn.steeringCapable)this.steering.control(accepted);
   return {...this.publicAdmission(accepted),replayed:false};
  });
 }
 // Called by the native request boundary, not a client-supplied terminal flag.
 dispatch(actor,{sharedSpaceId,admissionId}){
  if(this.readOnly)throw fail('SHARED_READ_ONLY');
  return this.atomic(()=>{
   const row=this.admission(actor,sharedSpaceId,admissionId);
   if(row.principal!==actor.principal)throw fail('SHARED_REQUEST_OWNER_REQUIRED',403);
   if(row.state!=='accepted')throw fail(row.dispatched?'SHARED_REQUEST_ALREADY_DISPATCHED':'SHARED_REQUEST_NOT_DISPATCHABLE');
   this.db.prepare("UPDATE shared_admissions SET state='dispatched',dispatched=1 WHERE id=?").run(row.id);
   return {request:this.publicAdmission(this.admission(actor,sharedSpaceId,row.id)),config:JSON.parse(row.config_json)};
  });
 }
 nativeTerminal(admissionId){
  id(admissionId);this.db.prepare("UPDATE shared_admissions SET native_terminal=1 WHERE id=? AND state IN ('dispatched','review_required')").run(admissionId);
 }
 complete(actor,body,{session=false}={}){
  this.authorize(actor,body.sharedSpaceId,'execute');
  const result=this.receipt(actor,body,'complete',()=>{
   const row=this.admission(actor,body.sharedSpaceId,body.admissionId);
   if(!session&&this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mobile_executions'").get()&&this.db.prepare("SELECT 1 FROM mobile_executions WHERE id=? AND kind='shared_session'").get(row.id))throw fail('SHARED_SESSION_COMPLETION_ONLY');
   if(row.principal!==actor.principal)throw fail('SHARED_REQUEST_OWNER_REQUIRED',403);
   if(this.db.prepare('SELECT 1 FROM shared_work_controls WHERE work_id=? AND (revision>0 OR generation>0)').get(row.id))throw fail('SHARED_CLIENT_UPGRADE_REQUIRED');
   const groupResult=require('./sharedTurns').complete(this,actor,body,row);if(groupResult)return groupResult;
   if(row.state!=='dispatched'||!row.native_terminal)throw fail('SHARED_NATIVE_TERMINAL_REQUIRED');
   const topic=this.topic(actor,row.space_id,row.topic_id,'execute'),message=body.message;
   if(!message||message.role!=='assistant'||message.id!=='reply_'+row.id)throw fail('INVALID_SHARED_REPLY',400);
   const metadata=require('./metadata'),normalized={...message};delete normalized._nativeSyncMetadata;
   const receipt=this.store.apply({ownerType:topic.owner_type,ownerId:topic.owner_id,topicId:topic.topic_id,msgId:message.id,deviceId:actor.principal,opId:'shared-reply:'+row.id,action:'upsert',baseHash:null,message:normalized,metadata:metadata.envelopeFor(message,1)},{sharedSpace:row.space_id,attachmentPrincipal:actor.principal,metadataPublisher:true});
   require('./sharedTurns').replaceTarget(this,actor,topic,row);
   this.db.prepare("UPDATE shared_admissions SET reply_seq=?,state='completed' WHERE id=?").run(receipt.seq,row.id);
   return {request:this.publicAdmission(this.admission(actor,row.space_id,row.id)),receipt};
  });
  if(!session&&result.request?.state==='completed'&&!this.db.isTransaction)this.native?.engine.emitEvent?.(result.request.id,'completed',{});return result;
 }
 abandon(actor,body){
  this.authorize(actor,body.sharedSpaceId,'execute');
  const result=this.receipt(actor,body,'abandon',()=>{
   const row=this.admission(actor,body.sharedSpaceId,body.admissionId);
   const execution=this.native?.engine.get?.(row.id),session=execution?.kind==='shared_session';
   if(session&&(row.principal!==actor.principal))throw fail('SHARED_REQUEST_OWNER_REQUIRED',403);
   if(row.principal!==actor.principal&&this.db.prepare('SELECT executor FROM shared_work_controls WHERE work_id=?').get(row.id)?.executor!==actor.principal)throw fail('SHARED_REQUEST_OWNER_REQUIRED',403);
   if(session&&(body.confirm!==true||!require('./sharedSession').reviewable(this,execution,row)))throw fail('SHARED_REVIEW_CONFIRMATION_REQUIRED');
   if(body.confirm===true&&row.state==='dispatched'&&this.native?.canReview(row.id)){this.db.prepare("UPDATE shared_admissions SET state='review_required' WHERE id=?").run(row.id);row.state='review_required';}
   if(body.confirm!==true||!['accepted','review_required'].includes(row.state))throw fail('SHARED_REVIEW_CONFIRMATION_REQUIRED');
   this.db.prepare("UPDATE shared_admissions SET state='abandoned' WHERE id=?").run(row.id);
   if(session)require('./sharedSession').settleAbandon(this,execution);
   return {request:this.publicAdmission(this.admission(actor,row.space_id,row.id))};
  });
  this.native?.engine.emitEvent?.(body.admissionId,'state',{state:'cancelled'});
  if(this.native?.engine.get?.(body.admissionId)?.kind==='shared_session')this.native.engine.wake();return result;
 }
 steer(actor,body){return this.steering.submit(actor,body);}
 steerReady(actor,body){return this.steering.ready(actor,body);}
 steerCheckpoint(actor,body){return this.steering.checkpoint(actor,body);}
 steerFinalReply(actor,body){return this.steering.finalReply(actor,body);}
 steerTurnComplete(actor,body){return this.steering.completeTurn(actor,body);}
 compactPrepare(actor,body){return this.compaction.prepare(actor,body);}
 compactInput(actor,body){return this.compaction.get(actor,body);}
 compactCancel(actor,body){return this.compaction.cancel(actor,body);}
 compactCommit(actor,body){return this.compaction.commit(actor,body);}
 steerHandoff(actor,body){return this.steering.handoff(actor,body);}
 steerPrepare(actor,body){return this.steering.prepare(actor,body);}
 steeringState(actor,body){return this.steering.status(actor,body);}
 editMessage(actor,body){
  if(this.readOnly)throw fail('SHARED_READ_ONLY');
  const topic=this.topic(actor,body.sharedSpaceId,body.sharedId,'execute');
  return this.atomic(()=>{
   const op=body.operation;if(!op||op.deviceId!==actor.principal)throw fail('SHARED_REQUEST_OWNER_REQUIRED',403);
   const apply=()=>this.store.apply({...op,ownerType:topic.owner_type,ownerId:topic.owner_id,topicId:topic.topic_id},{sharedSpace:topic.space_id,metadataPublisher:true,attachmentPrincipal:actor.principal});
   if(op.baseSeq!==undefined){
    if(actor.kind!=='desktop'||topic.owner_type!=='agent'||!Number.isSafeInteger(op.baseSeq)||op.baseSeq<1)throw fail('INVALID_SHARED_MESSAGE_MUTATION',400);
    // CentralStore verifies that the original operation and receipt are identical.
    if(this.store.findOp.get(actor.principal,op.opId))return apply();
   }
   this.assertNotPrepared([topic.id,topic.parent_id]);if(this.active(topic.id))throw fail('SHARED_TOPIC_BUSY');
   const row=this.store.findMessage.get(...tuple(topic),op.msgId);
   if(!row)throw fail('SHARED_MESSAGE_NOT_FOUND',404);
   if(op.baseSeq!==undefined){
    if(row.deleted||row.last_seq!==op.baseSeq||row.hash!==op.baseHash)throw fail('MESSAGE_CONFLICT');
    const original=this.store.projectMessage(row);
    if(original.role!=='assistant'||original.isThinking||original.isPendingStream||original.contextCompaction)throw fail('INVALID_SHARED_MESSAGE_MUTATION',400);
    if(op.action==='upsert'){
     const {content,updatedAt,...unchanged}=op.message||{};
     const {content:oldContent,updatedAt:oldUpdatedAt,...oldFields}=original;
     if(typeof content!=='string'||(updatedAt!==undefined&&(!Number.isSafeInteger(updatedAt)||updatedAt<0))||
        stable(unchanged)!==stable(oldFields)||stable(op.metadata)!==stable(original._nativeSyncMetadata))throw fail('INVALID_SHARED_MESSAGE_MUTATION',400);
    }
   }
   return apply();
  });
 }
}
module.exports={SharedSpace};

'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {stable,sha256,fail}=require('./protocol');
const {durableJson}=require('./durableJson');
const {ownedJson}=require('./sharedLocal');
const {assertHistoryPath}=require('./sourceDirectory');
const own=(object,key)=>Object.prototype.hasOwnProperty.call(object,key);
const clone=value=>JSON.parse(JSON.stringify(value));
const hash=value=>sha256(stable(value));
const isObject=value=>value&&typeof value==='object'&&!Array.isArray(value);
const final=new Set(['completed','abandoned']);
const validEpoch=value=>typeof value==='string'&&/^[a-f0-9-]{36}$/.test(value);
function messageIdentity(value){return {...value,attachments:value.attachments||[]};}
// Poll freshness is not execution intent. Keep every other durable field in this comparison.
function withoutObservation({observedAt,...record}){return record;}

// The existing local execution ledger, split by server-session request identity.
// This store never admits, dispatches, queries, or resolves remote executions.
class SharedSessionStore{
 constructor(runtime,{fresh=false}={}){
  if(!fresh&&runtime.execution?.sessionStore)return runtime.execution.sessionStore;
  this.runtime=runtime;this.execution=runtime.execution||null;this.directory=path.join(runtime.dir,'session-records');
  this.rows=new Map();this.bases=new Map();this.loaded=false;this.initializing=false;this.fenceCommitted=false;this.retiredEpoch=null;this.writeJson=durableJson;
 }
 static async loadInto(execution){
  const store=new SharedSessionStore(execution.runtime,{fresh:true});store.execution=execution;execution.sessionStore=store;
  const {state}=execution,meta=state.sessionStore;
  if(state.version===4){if(!isObject(meta)||meta.version!==1||!validEpoch(meta.epoch)||!['initializing','files'].includes(meta.mode)||meta.retiredEpoch!==undefined&&(!validEpoch(meta.retiredEpoch)||meta.mode!=='initializing'))throw fail('SHARED_SESSION_STORE_INVALID');store.epoch=meta.epoch;store.initializing=meta.mode==='initializing';store.fenceCommitted=true;store.retiredEpoch=meta.retiredEpoch||null;}
  else if(meta!==undefined){if(!isObject(meta)||meta.version!==1||meta.mode!=='embedded'||!validEpoch(meta.epoch))throw fail('SHARED_SESSION_STORE_INVALID');store.retiredEpoch=meta.epoch;}
  for(const [id,record]of Object.entries(state.requests))if(!execution.lightInputs.has(id))store.bases.set(id,hash(record));
  if(state.version===4){
   const exists=await store.checkDirectory({optional:store.initializing});
   if(exists){
    const markerFile=path.join(store.directory,'.store.json');await store.checkFile(markerFile,{optional:store.initializing});
    const marker=await ownedJson(store.runtime.root,markerFile,{optional:store.initializing});
    if(marker)store.validateMarker(marker,store.initializing&&marker.epoch===store.retiredEpoch?store.retiredEpoch:store.epoch);else if(!store.initializing)throw fail('SHARED_SESSION_STORE_MISSING');
    for(const {name,value}of await store.readRecords()){
     if(store.initializing&&store.retiredEpoch&&value?.epoch===store.retiredEpoch){const retired=store.validateEnvelope(name,value,store.retiredEpoch),current=state.requests[retired.requestId];if(!current?.serverSession||hash(store.identity(current))!==retired.identityHash||current.accepted?.id!==retired.record.accepted?.id)throw fail('SHARED_SESSION_RECORD_CONFLICT');continue;}
     const envelope=store.validateEnvelope(name,value,store.epoch),id=envelope.requestId,old=own(state.requests,id)?state.requests[id]:undefined;
     if(old){
      const same=hash(old)===envelope.recordHash,baseline=store.bases.get(id)===envelope.baseHash&&envelope.baseHash!==null;
      const input=execution.lightInputs.has(id)&&store.sameInput(old,envelope.record);
      const observationOnly=Number.isSafeInteger(old.observedAt)&&old.observedAt>=0&&Number.isSafeInteger(envelope.record.observedAt)&&envelope.record.observedAt>=0&&hash(withoutObservation(old))===hash(withoutObservation(envelope.record));
      if(!same&&!baseline&&!input&&!observationOnly)throw fail('SHARED_SESSION_RECORD_CONFLICT');
      if(!store.sameInput(old,envelope.record))throw fail('SHARED_SESSION_RECORD_CONFLICT');
     }
     Object.defineProperty(state.requests,id,{value:envelope.record,enumerable:true,writable:true,configurable:true});execution.lightInputs.delete(id);store.rows.set(id,envelope);
     state.nextLocalInputSeq=Math.max(state.nextLocalInputSeq||0,envelope.record.localInputSeq||0);
    }
   }
  }
  if(store.runtime.readOnly&&Object.values(state.requests).some(record=>record.serverSession&&(record.serverProjectionPending||record.replyProjectionPending||record.committedReply||record.projection&&record.projection.state!=='saved')))throw fail('SHARED_READ_ONLY_NOT_SETTLED');
  store.loaded=true;return store;
 }
 binding(){return this.runtime.binding();}
 validateMarker(value,epoch){if(!isObject(value)||value.version!==1||value.epoch!==epoch||stable(value.binding)!==stable(this.binding()))throw fail('SHARED_SESSION_STORE_BINDING_CHANGED');}
 identity(record){
  const id=record?.body?.requestId,binding=this.binding();
  if(!isObject(record)||record.serverSession!==true||typeof id!=='string'||!id||id.length>160||!isObject(record.descriptor)||typeof record.descriptor.itemId!=='string'||typeof record.descriptor.topicId!=='string'||!['agent',undefined].includes(record.descriptor.itemType)||typeof record.sharedId!=='string'||!record.sharedId||!isObject(record.localMessage)||record.localMessage.id!==id||typeof record.localMessage.content!=='string'||record.body.sharedSpaceId!==binding.sharedSpaceId||record.body.sharedId!==record.sharedId||record.body.message?.id!==id)throw fail('SHARED_SESSION_RECORD_INVALID');
  if(record.accepted!==undefined&&(!isObject(record.accepted)||typeof record.accepted.id!=='string'||!record.accepted.id||record.accepted.requestId!==id||record.accepted.sharedId!==record.sharedId||record.accepted.sharedSpaceId!==binding.sharedSpaceId))throw fail('SHARED_SESSION_RECORD_INVALID');
  if(record.nativeBody||record.nativeBodyRef||record.steeringV1||record.isSteeringInput||record.remote)throw fail('SHARED_SESSION_RECORD_INVALID');
  return {binding,requestId:id,sharedId:record.sharedId,descriptor:record.descriptor,message:messageIdentity(record.localMessage),submission:{sharedSpaceId:record.body.sharedSpaceId,sharedId:record.body.sharedId,requestId:id,message:record.body.message}};
 }
 sameInput(left,right){return left?.localMessage?.id===right.body.requestId&&stable(left.descriptor)===stable(right.descriptor)&&stable(messageIdentity(left.localMessage))===stable(messageIdentity(right.localMessage));}
 validateEnvelope(name,value,epoch){
  if(!isObject(value)||value.version!==1||value.epoch!==epoch||typeof value.requestId!=='string'||name!==sha256(value.requestId)+'.json'||stable(value.binding)!==stable(this.binding())||!(value.baseHash===null||/^[a-f0-9]{64}$/.test(value.baseHash||''))||value.record?.body?.requestId!==value.requestId||value.identityHash!==hash(this.identity(value.record))||value.recordHash!==hash(value.record))throw fail('SHARED_SESSION_RECORD_CORRUPT');
  return value;
 }
 async checkDirectory({optional=false,create=false}={}){
  const root=await fs.lstat(this.runtime.root);if(root.isSymbolicLink()||!root.isDirectory()||process.platform!=='win32'&&root.uid!==process.getuid())throw fail('SHARED_SESSION_STORE_PATH_INVALID');
  await assertHistoryPath(this.runtime.root,path.join(this.directory,'.store.json'));
  if(create)await fs.mkdir(this.directory,{recursive:true,mode:0o700});
  let stat;try{stat=await fs.lstat(this.directory);}catch(error){if(optional&&error.code==='ENOENT')return false;throw error;}
  if(!stat.isDirectory()||stat.isSymbolicLink()||process.platform!=='win32'&&(stat.uid!==process.getuid()||(stat.mode&0o077)!==0))throw fail('SHARED_SESSION_STORE_PATH_INVALID');return true;
 }
 async readRecords(){
  const result=[];
  for(const entry of await fs.readdir(this.directory,{withFileTypes:true})){
   if(entry.name==='.store.json'){await this.checkFile(path.join(this.directory,entry.name));continue;}
   // durableJson may leave an uncommitted temporary after process death. It
   // has no committed identity and is never loaded, renamed or removed here.
   if(/^(?:[a-f0-9]{64}\.json|\.store\.json)\.[a-f0-9-]{36}\.tmp$/.test(entry.name)){await this.checkFile(path.join(this.directory,entry.name));continue;}
   if(!/^[a-f0-9]{64}\.json$/.test(entry.name)||!entry.isFile()||entry.isSymbolicLink())throw fail('SHARED_SESSION_STORE_PATH_INVALID');
   const file=path.join(this.directory,entry.name);await this.checkFile(file);result.push({name:entry.name,value:await ownedJson(this.runtime.root,file)});
  }
  return result;
 }
 async checkFile(file,{optional=false}={}){
  await assertHistoryPath(this.runtime.root,file);let stat;
  try{stat=await fs.lstat(file);}catch(error){if(optional&&error.code==='ENOENT')return false;throw error;}
  if(stat.isSymbolicLink()||!stat.isFile()||stat.nlink!==1||process.platform!=='win32'&&(stat.uid!==process.getuid()||(stat.mode&0o077)!==0))throw fail('SHARED_SESSION_STORE_PATH_INVALID');return true;
 }
 ledger({excludeDurable=true}={}){
  const e=this.execution,{localInputs,...ledger}=e.state;ledger.requests=Object.create(null);
  for(const [id,record]of Object.entries(e.state.requests)){
   if(e.lightInputs.has(id)&&record.phase==='local_pending'&&!record.admitStarted&&!record.accepted)continue;
   // A committed side record owns the row. In-memory changes can be newer
   // than the side snapshot while another save is queued, and can include
   // optional undefined fields that are absent from the durable JSON.
   if(excludeDurable&&record.serverSession&&this.rows.has(id))continue;
   ledger.requests[id]=clone(record);
  }
  return clone(ledger);
 }
 async writeMain(options){
  const ledger=this.ledger(options);await assertHistoryPath(this.runtime.root,this.execution.file);await this.writeJson(this.execution.file,ledger);
  this.bases=new Map(Object.entries(ledger.requests).map(([id,record])=>[id,hash(record)]));this.execution.savedProjectionRevision=this.execution.projectionRevision;return ledger;
 }
 async ensureFormat(){
  const e=this.execution;if(!e||!this.loaded)throw fail('SHARED_SESSION_STORE_NOT_LOADED');
  // Native-body archiving historically selects v3. Its ordinary save cannot
  // downgrade the newer session-file fence; only the explicit offline rollback
  // switches this metadata to embedded mode.
  if(this.fenceCommitted&&e.state.sessionStore?.epoch===this.epoch&&['files','initializing'].includes(e.state.sessionStore.mode))e.state.version=4;
  if(e.state.version!==4){
   this.epoch=randomUUID();e.state.version=4;e.state.sessionStore={version:1,mode:'initializing',epoch:this.epoch,...(this.retiredEpoch?{retiredEpoch:this.retiredEpoch}:{})};this.initializing=true;this.fenceCommitted=false;
   // Commit the format fence before making any side file authoritative. The
   // embedded snapshot remains sufficient across every interrupted migration.
  }
  if(!this.fenceCommitted){await this.writeMain({excludeDurable:false});this.fenceCommitted=true;}
  if(!this.initializing)return;
  await this.checkDirectory({create:true});
  const markerFile=path.join(this.directory,'.store.json');await this.checkFile(markerFile,{optional:true});const marker=await ownedJson(this.runtime.root,markerFile,{optional:true});
  if(marker){
   if(marker.epoch===this.epoch)this.validateMarker(marker,this.epoch);
   else if(this.retiredEpoch){this.validateMarker(marker,this.retiredEpoch);for(const {name,value}of await this.readRecords()){const old=this.validateEnvelope(name,value,this.retiredEpoch),current=e.state.requests[old.requestId];if(!current?.serverSession||hash(this.identity(current))!==old.identityHash||current.accepted?.id!==old.record.accepted?.id)throw fail('SHARED_SESSION_RECORD_CONFLICT');}}
   else throw fail('SHARED_SESSION_STORE_BINDING_CHANGED');
  }
  await this.writeJson(markerFile,{version:1,binding:this.binding(),epoch:this.epoch});
  for(const record of Object.values(e.state.requests))if(record.serverSession)await this.writeOne(record,{retiredEpoch:this.retiredEpoch});
  e.state.sessionStore={version:1,mode:'files',epoch:this.epoch};
  try{await this.writeMain();this.initializing=false;this.retiredEpoch=null;}
  catch(error){e.state.sessionStore.mode='initializing';throw error;}
 }
 async writeOne(record,{retiredEpoch=null}={}){
  const snapshot=clone(record),identity=this.identity(snapshot),id=identity.requestId,identityHash=hash(identity),recordHash=hash(snapshot),prior=this.rows.get(id);
  if(prior&&(prior.identityHash!==identityHash||prior.record.accepted?.id&&prior.record.accepted.id!==snapshot.accepted?.id))throw fail('SHARED_SESSION_RECORD_CONFLICT');
  if(prior?.recordHash===recordHash)return;
  await this.checkDirectory();const file=path.join(this.directory,sha256(id)+'.json');
  if(await this.checkFile(file,{optional:true})){
   const old=await ownedJson(this.runtime.root,file),oldEpoch=old?.epoch;
   if(oldEpoch!==this.epoch&&oldEpoch!==retiredEpoch)throw fail('SHARED_SESSION_RECORD_CONFLICT');
   const disk=this.validateEnvelope(path.basename(file),old,oldEpoch);
   if(disk.identityHash!==identityHash||disk.record.accepted?.id&&disk.record.accepted.id!==snapshot.accepted?.id)throw fail('SHARED_SESSION_RECORD_CONFLICT');
   if(prior&&disk.recordHash!==prior.recordHash&&disk.recordHash!==recordHash)throw fail('SHARED_SESSION_RECORD_CONFLICT');
  }
  const envelope={version:1,binding:this.binding(),epoch:this.epoch,requestId:id,identityHash,baseHash:prior?.baseHash??this.bases.get(id)??null,recordHash,record:snapshot};
  await this.writeJson(file,envelope);this.rows.set(id,envelope);
 }
 save(record){
  const e=this.execution;if(!e||this.runtime.readOnly)throw fail(this.runtime.readOnly?'SHARED_READ_ONLY':'SHARED_SESSION_STORE_NOT_LOADED');
  const id=this.identity(record).requestId;if(!own(e.state.requests,id)||e.state.requests[id]!==record)throw fail('SHARED_SESSION_RECORD_CONFLICT');
  e.disk=(e.disk||Promise.resolve()).catch(()=>{}).then(async()=>{await this.ensureFormat();await this.writeOne(record);});return e.disk;
 }
 // Called inside SharedExecution.save's existing serialization queue. Legacy
 // callers may have changed a session record; save those changes before the
 // main ledger excludes them. Session hot-path callers use save(record) above.
 async flushRecords(){
  if(!this.loaded)return;
  if(this.execution.state.version!==4&&!Object.values(this.execution.state.requests).some(record=>record.serverSession))return;
  await this.ensureFormat();for(const record of Object.values(this.execution.state.requests))if(record.serverSession)await this.writeOne(record);
 }
 rollbackToV3({offline=false}={}){
  const e=this.execution;
  if(!offline||!e||this.runtime.readOnly||e.tails.size||e.projectionTasks.size||e.archiveTasks.size||this.runtime.sessions?.observers?.size||this.runtime.sessions?.projections?.size||this.runtime.sessions?.warming?.size)throw fail('SHARED_SESSION_ROLLBACK_REQUIRES_OFFLINE');
  e.disk=(e.disk||Promise.resolve()).catch(()=>{}).then(async()=>{
   if(Object.keys(e.state.localInputs||{}).length)throw fail('SHARED_SESSION_ROLLBACK_UNSETTLED');
   for(const record of Object.values(e.state.requests))if(record.serverSession&&(!final.has(record.phase)||!final.has(record.accepted?.state)||record.serverProjectionPending||record.replyProjectionPending||record.committedReply||record.projection&&record.projection.state!=='saved'))throw fail('SHARED_SESSION_ROLLBACK_UNSETTLED');
   const oldVersion=e.state.version,oldMeta=e.state.sessionStore;
   if(oldVersion!==4)return {version:oldVersion,changed:false};
   e.state.version=3;e.state.sessionStore={version:1,mode:'embedded',epoch:this.epoch};
   try{await this.writeMain({excludeDurable:false});}
   catch(error){e.state.version=oldVersion;e.state.sessionStore=oldMeta;throw error;}
   this.rows.clear();this.retiredEpoch=this.epoch;this.initializing=false;this.fenceCommitted=false;return {version:3,changed:true,records:Object.values(e.state.requests).filter(record=>record.serverSession).length};
  });return e.disk;
 }
}
module.exports={SharedSessionStore};

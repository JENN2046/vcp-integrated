'use strict';
const fs=require('node:fs/promises');
const {randomUUID}=require('node:crypto');
const {durableJson}=require('./durableJson');
const {sharedConfig,sharedIdentity}=require('./contracts.generated.cjs');
const {stable,fail}=require('./protocol');
const {validateConfig,checkVersion}=require('./sharedConfigVersion');

// A local projection and draft, not another accepted configuration authority.
// writeLocal must use native owner/rule managers and preserve private fields.
class SharedConfigReplica {
 static async open(options){
  const replica=new SharedConfigReplica(options);let loaded;
  try{loaded=JSON.parse(await fs.readFile(options.statePath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  if(loaded){if(loaded.version!==1||stable(loaded.binding)!==stable(replica.state.binding)||!loaded.objects||!loaded.drafts)throw fail('SHARED_CONFIG_STATE_INVALID');replica.state=loaded;}
  await replica.recover();return replica;
 }
 constructor({statePath,sharedSpaceId,deviceId,send,readLocal,writeLocal,materializeTarget,persist=durableJson}){
  sharedIdentity(sharedSpaceId);
  if(typeof send!=='function'||typeof readLocal!=='function'||typeof writeLocal!=='function')throw fail('SHARED_NATIVE_CONFIG_AUTHORITY_REQUIRED');
  Object.assign(this,{statePath,sharedSpaceId,send,readLocal,writeLocal,materializeTarget,persist});
  this.state={version:1,binding:{sharedSpaceId,deviceId},objects:{},drafts:{},intent:null};this.tail=Promise.resolve();
 }
 serial(fn){const task=this.tail.catch(()=>{}).then(fn);this.tail=task;return task;}
 async saveState(next){await this.persist(this.statePath,next);this.state=next;}
 validate(object){validateConfig(object,this.sharedSpaceId);}
 checkCurrent(object){
  this.validate(object);
  const known=this.state.objects[object.id];
  if(known)checkVersion(object,known.version,known.hash);
 }
 async recover(){
  const intent=this.state.intent;if(!intent)return;
  this.checkCurrent(intent.object);
  const {object,before}=intent,current=await this.readLocal(object);
  const target=this.materializeTarget?this.materializeTarget(object):object.config;
  // A partial multi-file write may contain either old or new values per field.
  // Anything else is a local edit and is preserved instead of overwritten.
  if(current){for(const key of new Set([...Object.keys(current),...Object.keys(target),...Object.keys(before||{})])){
   if(stable(current[key])===stable(before?.[key])||stable(current[key])===stable(target[key]))continue;
   if(key==='tavernRules'&&['official','user'].every(source=>{
    const part=rules=>(rules||[]).filter(r=>(r.source==='official'?'official':'user')===source);
    return stable(part(current[key]))===stable(part(before?.[key]))||stable(part(current[key]))===stable(part(target[key]));
   }))continue;
   throw fail('SHARED_LOCAL_CONFIG_CONFLICT');
  }}
  await this.writeLocal(object,{before:before||null,recovering:true});
  const written=await this.readLocal(object);
  if(stable(written)!==stable(target))throw fail('SHARED_CONFIG_MATERIALIZATION_MISMATCH');
  const next=structuredClone(this.state);next.objects[object.id]={version:object.version,hash:object.configHash,kind:object.kind,config:object.config,materialized:target};next.intent=null;
  if(next.drafts[object.id]?.accepted===true)delete next.drafts[object.id];
  await this.saveState(next);
 }
 receive(object){return this.serial(()=>this.receiveNow(object));}
 applyConfirmed(object,before){return this.serial(async()=>{
  await this.recover();this.checkCurrent(object);if(this.state.drafts[object.id])throw fail('SHARED_CONFIG_CONFLICT');
  const next=structuredClone(this.state);next.intent={object:structuredClone(object),before:structuredClone(before)};await this.saveState(next);await this.recover();return {applied:true};
 });}
 async receiveNow(object){
  this.validate(object);
  await this.recover();const known=this.state.objects[object.id];
  if(known)checkVersion(object,known.version,known.hash);
  const before=await this.readLocal(object),draft=this.state.drafts[object.id];
  if(draft&&!draft.accepted)return {conflict:true,version:object.version};
  const target=this.materializeTarget?this.materializeTarget(object):object.config;
  if(!(draft?.accepted&&Object.hasOwn(draft,'beforeLocal')&&stable(before)===stable(draft.beforeLocal))&&known&&before&&stable(before)!==stable(known.materialized||known.config)&&stable(before)!==stable(target)){
   const next=structuredClone(this.state);next.drafts[object.id]={opId:randomUUID(),kind:object.kind,config:before,expectedVersion:known.version,conflict:true};await this.saveState(next);return {conflict:true,version:object.version};
  }
  if(known?.version===object.version&&stable(before)===stable(target)){if(draft?.accepted){const next=structuredClone(this.state);delete next.drafts[object.id];await this.saveState(next);}return {unchanged:true};}
  const next=structuredClone(this.state);next.intent={object:structuredClone(object),before};await this.saveState(next);await this.recover();return {applied:true,version:object.version};
 }
 scanNative(metadata){return this.serial(async()=>{
  await this.recover();const known=this.state.objects[metadata.id];if(!known)return;
  const current=await this.readLocal({...metadata,config:known.config});
  if(current&&stable(current)!==stable(known.materialized||known.config)&&!this.state.drafts[metadata.id]){
   const next=structuredClone(this.state);next.drafts[metadata.id]={opId:randomUUID(),kind:known.kind,config:sharedConfig(known.kind,current),expectedVersion:known.version,conflict:false};await this.saveState(next);
  }
 });}
 edit(objectId,kind,config){return this.serial(async()=>{
  sharedIdentity(objectId);const accepted=this.state.objects[objectId];if(!accepted)throw fail('SHARED_CONFIG_BASE_REQUIRED');
  const next=structuredClone(this.state);next.drafts[objectId]={opId:randomUUID(),kind,config:sharedConfig(kind,config),expectedVersion:accepted.version,conflict:false};await this.saveState(next);return this.state.drafts[objectId];
 });}
 publish(objectId,options){return this.serial(()=>this.publishNow(objectId,options));}
 async publishNow(objectId,{onAccepted}={}){
  const attempt=this.state.drafts[objectId],receipt=attempt?.nativeSave?.receipt;
  const previousReceipt=receipt?.opId===attempt?.opId?receipt?.object:null;
  if(previousReceipt)onAccepted?.(previousReceipt);
  await this.recover();const draft=this.state.drafts[objectId];if(!draft)return previousReceipt?{unchanged:true,resultObject:previousReceipt}:{unchanged:true};if(draft.conflict)throw fail('SHARED_CONFIG_CONFLICT');
  const body={sharedSpaceId:this.sharedSpaceId,sharedId:objectId,opId:draft.opId,expectedVersion:draft.expectedVersion,config:draft.config};let result;
  try{result=previousReceipt?{object:previousReceipt}:await this.send('/api/v1/sync/shared/config',{body});}
  catch(e){if(e.code==='SHARED_CONFIG_CONFLICT'){const next=structuredClone(this.state);next.drafts[objectId].conflict=true;next.drafts[objectId].submitted=false;await this.saveState(next);}throw e;}
  if(onAccepted||draft.nativeSave){
   this.validate(result.object);
   if(result.object.id!==objectId||result.object.kind!==draft.kind)throw fail('SHARED_CONFIG_RESPONSE_INVALID');
   onAccepted?.(result.object);
  }
  const next=structuredClone(this.state);next.drafts[objectId].accepted=true;
  if(draft.nativeSave)next.drafts[objectId].nativeSave.receipt={opId:draft.opId,object:result.object};
  await this.saveState(next);
  if(this.state.objects[objectId]?.version>result.object.version){const latest=structuredClone(this.state);delete latest.drafts[objectId];await this.saveState(latest);return {resultObject:result.object,replayed:true};}
  return {...await this.receiveNow(result.object),resultObject:result.object};
 }
 submit(objectId,kind,config,{expectedVersion,opId,nativeSave,onAccepted}){return this.serial(async()=>{
  sharedIdentity(opId);sharedIdentity(objectId);const value=sharedConfig(kind,config),previous=this.state.drafts[objectId];
  if(previous?.submitted&&previous.opId!==opId)throw fail('SHARED_CONFIG_PENDING_CONFIRMATION');
  if(previous?.opId===opId&&(previous.expectedVersion!==expectedVersion||stable(previous.config)!==stable(value)))throw fail('IDEMPOTENCY_KEY_REUSED');
  if(!Number.isSafeInteger(expectedVersion)||expectedVersion<1)throw fail('SHARED_CONFIG_BASE_REQUIRED');
  const accepted=this.state.objects[objectId];if(!accepted)throw fail('SHARED_CONFIG_BASE_REQUIRED');const beforeLocal=previous?.opId===opId?previous.beforeLocal:await this.readLocal({id:objectId,kind,config:accepted.config});
  const next=structuredClone(this.state);next.drafts[objectId]={opId,kind,config:value,expectedVersion,conflict:false,submitted:true,beforeLocal,...(nativeSave?{nativeSave}:null)};await this.saveState(next);
  return this.publishNow(objectId,{onAccepted});
 });}
 resolve(object,choice){return this.serial(async()=>{
  this.checkCurrent(object);
  if(!['server','local'].includes(choice))throw fail('INVALID_SHARED_CONFIG_RESOLUTION');
  const draft=this.state.drafts[object.id];if(!draft)throw fail('SHARED_CONFIG_DRAFT_REQUIRED');if(draft.submitted&&!draft.conflict&&!draft.accepted)throw fail('SHARED_CONFIG_PENDING_CONFIRMATION');
  if(choice==='server'){
   const next=structuredClone(this.state);delete next.drafts[object.id];next.intent={object:structuredClone(object),before:await this.readLocal(object)};await this.saveState(next);await this.recover();return {applied:true};
  }
  const next=structuredClone(this.state);next.drafts[object.id]={...draft,opId:randomUUID(),expectedVersion:object.version,conflict:false};await this.saveState(next);return {draft:true};
 });}
 executable(objectId){return Boolean(this.state.objects[objectId]&&!this.state.intent&&!this.state.drafts[objectId]);}
 adopt(object){return this.serial(async()=>{
  this.validate(object);if(this.state.objects[object.id])return this.receiveNow(object);
  const current=await this.readLocal(object),target=this.materializeTarget?this.materializeTarget(object):object.config;
  const next=structuredClone(this.state);next.objects[object.id]={version:object.version,hash:object.configHash,kind:object.kind,config:object.config,materialized:target};
  if(current&&stable(current)!==stable(target))next.drafts[object.id]={opId:randomUUID(),kind:object.kind,config:current,expectedVersion:object.version,conflict:true};
  await this.saveState(next);return {adopted:true,conflict:Boolean(next.drafts[object.id])};
 });}
}
module.exports={SharedConfigReplica};

'use strict';
const authorityControl=require('./historyAuthority');
const fs=require('node:fs/promises'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {assertHistoryPath}=require('./sourceDirectory'),{fail}=require('./protocol');
const endpoint='/api/v1/sync/shared/';
class SharedDirectory {
 constructor(runtime){this.r=runtime;runtime.state.localRemovals||={};}
 visible(id){const r=this.r,o=r.state.objects[id],local=r.state.locals[id],operation=r.state.localRemovals[id];if(!o||o.deleted||local?.hidden||operation&&!['restored','rejected'].includes(operation.stage))return false;return !o.parentId||this.visible(o.parentId);}
 async bindings(){
  if(authorityControl.authorityFor(this.r))return authorityControl.withAuthority(authorityControl.authorityFor(this.r),'shared-directory-bindings',()=>this.bindingsPrepared());
  return this.bindingsPrepared();
 }
 async bindingsPrepared(){const r=this.r,{bindings}=await r.send(endpoint+'bindings?'+new URLSearchParams({sharedSpaceId:r.connection.sharedSpaceId}));for(const b of bindings){const l=r.state.locals[b.sharedId];if(l&&l.localId===b.localId&&(l.localParent||'')===(b.localParent||''))l.hidden=b.hidden===true;}await r.save();}
 paths(id){const r=this.r,o=r.state.objects[id],l=r.localFor(id),base=path.join(r.dir,'removed',id);if(o.kind==='topic'){const parent=r.localFor(o.parentId);return [];}if(['agent','group'].includes(o.kind))return [{from:path.join(r.root,o.kind==='agent'?'Agents':'AgentGroups',l.localId),to:path.join(base,'owner')}];throw fail('SHARED_DIRECTORY_OWNER_REQUIRED');}
 async exists(file){await assertHistoryPath(this.r.root,path.join(file,'_shared_directory_probe'));try{const s=await fs.lstat(file);if(!s.isDirectory()||s.isSymbolicLink())throw fail('SHARED_LOCAL_PATH_CONFLICT');return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
 async moves(operation,restore=false){
  if(authorityControl.authorityFor(this.r))return authorityControl.withAuthority(authorityControl.authorityFor(this.r),'shared-directory-moves',()=>this.movesPrepared(operation,restore));
  return this.movesPrepared(operation,restore);
 }
 async movesPrepared(operation,restore=false){for(const move of operation.moves){const from=restore?move.to:move.from,to=restore?move.from:move.to,a=await this.exists(from),b=await this.exists(to);if(a&&b)throw fail('SHARED_LOCAL_PATH_CONFLICT');if(a){await fs.mkdir(path.dirname(to),{recursive:true});await assertHistoryPath(this.r.root,to);await fs.rename(from,to);if(process.platform!=='win32')for(const dir of new Set([path.dirname(from),path.dirname(to)])){const d=await fs.open(dir,'r');try{await d.sync();}finally{await d.close();}}}await this.r.save();}}
 async archive(id,operation){
  if(authorityControl.authorityFor(this.r))return authorityControl.withAuthority(authorityControl.authorityFor(this.r),'shared-directory-archive',()=>this.archivePrepared(id,operation));
  return this.archivePrepared(id,operation);
 }
 async archivePrepared(id,operation){const r=this.r,o=r.state.objects[id],l=r.localFor(id);if(o.kind==='topic'){const parent=r.state.objects[o.parentId];if(this.visible(o.parentId))await r.host.detachTopic(parent.kind,r.localFor(o.parentId).localId,l.localId);}await this.moves(operation);operation.stage='removed';await r.save();r.notifyDirectory(o);}
 async recover(){const r=this.r;for(const [id,operation]of Object.entries(r.state.localRemovals)){
  if(operation.stage==='pending'){try{await r.send(endpoint+'remove',{body:operation.body});operation.stage='accepted';await r.save();}catch(e){if(['SHARED_TOPIC_BUSY','SHARED_DELETE_CONFIRMATION_REQUIRED','SHARED_OBJECT_NOT_FOUND'].includes(e.code)){operation.stage='rejected';await r.save();}else throw e;}}
  if(operation.stage==='accepted')await this.archive(id,operation);
  if(operation.stage==='restoring')await this.restoreNow(id,operation);
 }}
 async remove({sharedId,mode,expectedVersion,confirmed,opId},beforePrepare){
  const r=this.r;r.matching?.assert([sharedId]);if(confirmed!==true||!['device','all'].includes(mode))throw fail('SHARED_DELETE_CONFIRMATION_REQUIRED');const o=r.state.objects[sharedId];if(!o||!r.state.locals[sharedId])throw fail('SHARED_LOCAL_MAPPING_REQUIRED');
  const pending=r.state.localRemovals[sharedId];
  if(opId&&pending?.stage==='pending'&&pending.body?.opId===opId){
   if(pending.body.mode!==mode||pending.body.expectedVersion!==expectedVersion)throw fail('REQUEST_ID_REUSED');
   await this.recover();if(pending.stage==='removed')return {removed:mode,sharedId,replayed:true};
  }
  r.directoryPaused=true;await r.running;
  try{
   for(;;){const tail=r.configs.tail;await tail.catch(()=>{});if(tail===r.configs.tail)break;}if(r.configs.state.intent)throw fail('SHARED_CONFIG_RECOVERY_REQUIRED');if(Object.values(r.configs.state.drafts).some(d=>d.submitted))throw fail('SHARED_CONFIG_PENDING_CONFIRMATION');
   await r.replica.sync();const prior=r.state.localRemovals[sharedId];if(prior&&!['rejected','restored','removed'].includes(prior.stage))throw fail('SHARED_DIRECTORY_PENDING');
   if(mode==='device' && o.kind==='topic'){
    const parent=r.state.objects[o.parentId],owner=r.localFor(o.parentId),topic=r.localFor(sharedId);
    const config=await r.host.readNativeOwner(parent.kind,owner.localId);
    if(!config?.topics?.some(t=>t?.id && t.id!==topic.localId && r.isLocalTopicVisible(parent.kind,owner.localId,t.id)))throw fail('SHARED_LAST_LOCAL_TOPIC');
   }
   // Invoked synchronously immediately before recording the confirmed scope.
   beforePrepare?.();
   const operation=r.state.localRemovals[sharedId]={stage:'pending',body:{sharedSpaceId:r.connection.sharedSpaceId,sharedId,mode,expectedVersion,confirm:true,opId:opId||randomUUID()},moves:this.paths(sharedId)};await r.save();
   try{await r.send(endpoint+'remove',{body:operation.body});operation.stage='accepted';await r.save();await this.archive(sharedId,operation);}
   catch(e){if(['SHARED_TOPIC_BUSY','SHARED_DELETE_CONFIRMATION_REQUIRED','SHARED_OBJECT_NOT_FOUND'].includes(e.code)){operation.stage='rejected';await r.save();}throw e;}
   // Both the shared receipt and the local archive have committed.
   try { await this.bindings(); }
   catch(error) { return {removed:mode,sharedId,warning:'已移除，本机绑定列表尚未刷新：'+(error.code||error.message)}; }
   return {removed:mode,sharedId};
  }finally{r.directoryPaused=false;r.scheduleTick();}
 }
 async tombstones(){const r=this.r;for(const kind of ['agent','group','topic'])for(const o of Object.values(r.state.objects).filter(o=>o.kind===kind&&o.deleted&&r.state.locals[o.id]&&!r.state.locals[o.id].aliasOf)){const old=r.state.localRemovals[o.id];if(old?.stage==='removed')continue;const operation=r.state.localRemovals[o.id]={stage:'accepted',moves:this.paths(o.id),tombstone:true};await r.save();await this.archive(o.id,operation);}}
 async restore({sharedId,confirmed}){
  const r=this.r;r.matching?.assert([sharedId]);const o=r.state.objects[sharedId];if(!o||o.deleted)throw fail('SHARED_OBJECT_DELETED');if(confirmed!==true)throw fail('SHARED_RESTORE_CONFIRMATION_REQUIRED');if(o.parentId&&!this.visible(o.parentId))throw fail('SHARED_PARENT_NOT_LOCAL');const operation=r.state.localRemovals[sharedId];if(!operation||operation.stage!=='removed')throw fail('SHARED_LOCAL_REMOVAL_REQUIRED');
  r.directoryPaused=true;await r.running;try{operation.restoreOpId||=randomUUID();operation.stage='restoring';await r.save();await this.restoreNow(sharedId,operation);return {restored:true,sharedId};}finally{r.directoryPaused=false;r.scheduleTick();}
 }
 async restoreNow(id,operation){
  if(authorityControl.authorityFor(this.r))return authorityControl.withAuthority(authorityControl.authorityFor(this.r),'shared-directory-restoreNow',()=>this.restoreNowPrepared(id,operation));
  return this.restoreNowPrepared(id,operation);
 }
 async restoreNowPrepared(id,operation){
  const r=this.r,o=r.state.objects[id],l=r.localFor(id);if(o.deleted)throw fail('SHARED_OBJECT_DELETED');
  await r.send(endpoint+'bind',{body:{sharedSpaceId:r.connection.sharedSpaceId,sharedId:id,opId:operation.restoreOpId,restore:true,localId:l.localId,...(l.localParent?{localParent:l.localParent}:{})}});
  await this.moves(operation,true);l.hidden=false;operation.stage='restored';
  for(const topic of Object.values(r.state.objects).filter(t=>t.kind==='topic'&&(t.id===id||t.parentId===id))){r.attachments?.retryMissing(topic.id);r.attachments?.work.invalidate(topic.id);delete r.state.baselines[topic.id];if(!topic.deleted&&this.visible(topic.id)){const parent=r.state.objects[topic.parentId],local=r.localFor(topic.id);await r.host.ensureTopic(parent.kind,r.localFor(parent.id).localId,{id:local.localId,name:r.configs.state.objects[topic.id]?.config.name||topic.id});}}
  await r.save();r.notifyDirectory(o);
 }
}
module.exports={SharedDirectory};

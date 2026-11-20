'use strict';
// Native UI adaptation only. The existing directory/configuration authorities
// own all writes and recovery; this module owns no execution or sync ledger.
const {randomUUID}=require('node:crypto');
const {fail,sha256,stable}=require('./protocol');
const binding=(r,s,id)=>sha256(stable({binding:r.binding(),sharedId:id,parentId:r.state.objects[id]?.parentId||null,itemType:s.itemType||'agent',itemId:s.itemId,topicId:s.topicId||null}));

function validateScope(runtime,scope){
 const kind=scope?.itemType||'agent';
 if(!['agent','group'].includes(kind)||typeof scope?.itemId!=='string'||!scope.itemId||Object.hasOwn(scope,'topicId')&&(typeof scope.topicId!=='string'||!scope.topicId))throw fail('INVALID_NATIVE_SCOPE');
 runtime.queue.getHistoryPath(scope.itemId,scope.topicId||'_native_owner_probe');return kind;
}
function nativeObject(runtime,scope){
 const kind=validateScope(runtime,scope);
 const owner=runtime.nativeObject(kind,scope.itemId);if(!owner)return null;
 if(owner.retired||owner.deleted)throw fail('SHARED_OBJECT_MERGED');
 runtime.matching.assert([owner.id]);
 if(!runtime.isLocalVisible(owner.id))throw fail('SHARED_LOCAL_REMOVED');
 if(!scope.topicId)return owner;
 const candidates=Object.entries(runtime.state.locals).filter(([,l])=>l.kind==='topic'&&!l.aliasOf&&l.localParent===scope.itemId&&l.localId===scope.topicId);
 if(candidates.length!==1)throw fail('SHARED_LOCAL_MAPPING_PENDING');
 const object=runtime.state.objects[candidates[0][0]];
 if(!object||object.deleted||object.parentId!==owner.id)throw fail('SHARED_OBJECT_DELETED');
 runtime.matching.assert([object.id]);if(!runtime.isLocalVisible(object.id))throw fail('SHARED_LOCAL_REMOVED');
 return object;
}
async function deletionContext(runtime,scope){
 validateScope(runtime,scope);
 const local=Object.entries(runtime.state.locals).find(([,l])=>!l.aliasOf&&l.kind===(scope?.topicId?'topic':scope?.itemType||'agent')&&l.localId===(scope?.topicId||scope?.itemId)&&(!scope?.topicId||l.localParent===scope.itemId));
 const pending=local&&runtime.state.localRemovals[local[0]];
 if(pending?.body&&['pending','accepted'].includes(pending.stage))return {success:true,kind:'shared',expectedVersion:pending.body.expectedVersion,operationId:pending.body.opId,expectedBinding:binding(runtime,scope,pending.body.sharedId),allowedModes:[pending.body.mode],pendingMode:pending.body.mode};
 const object=nativeObject(runtime,scope);if(!object)return {success:true,kind:'local'};
 if(runtime.closed||!runtime.ready)throw fail('SHARED_STARTUP_PENDING');
 if(runtime.readOnly)throw fail('SHARED_READ_ONLY');
 // Refresh the actual metadata version. Preview is read-only and does not
 // initialize a missing history, claim a deletion, or register new bindings.
 const {object:current}=await runtime.send('/api/v1/sync/shared/config?'+new URLSearchParams({sharedSpaceId:runtime.connection.sharedSpaceId,sharedId:object.id}));
 if(current.id!==object.id||current.kind!==object.kind||current.deleted)throw fail('SHARED_OBJECT_DELETED');
 return {success:true,kind:'shared',name:current.config?.name,expectedVersion:current.version,operationId:randomUUID(),expectedBinding:binding(runtime,scope,object.id),allowedModes:['all','device']};
}
// Two native windows can confirm different topics against the same owner list.
const removalTails=new WeakMap();
async function serializeRemoval(runtime,operation) {
 const prior=removalTails.get(runtime)||Promise.resolve();
 const next=prior.catch(()=>{}).then(operation);
 removalTails.set(runtime,next);
 try{return await next;}finally{if(removalTails.get(runtime)===next)removalTails.delete(runtime);}
}

function remove(runtime,scope,options={},callbacks={}) {
 return serializeRemoval(runtime,()=>removeConfirmed(runtime,scope,options,callbacks));
}

function checkedBinding(runtime,scope,options,isCurrent) {
 if(isCurrent && !isCurrent())throw fail('SHARED_NATIVE_BINDING_CHANGED');
 if(runtime.closed||!runtime.ready||runtime.isStopping?.())throw fail('SHARED_STARTUP_PENDING');
 if(runtime.readOnly)throw fail('SHARED_READ_ONLY');
 const kind=scope.itemType||'agent',entries=Object.entries(runtime.state.locals);
 const owners=entries.filter(([,l])=>!l.aliasOf&&l.kind===kind&&l.localId===scope.itemId);
 if(owners.length!==1)throw fail('SHARED_NATIVE_BINDING_CHANGED');
 const members=scope.topicId?entries.filter(([,l])=>!l.aliasOf&&l.kind==='topic'&&l.localId===scope.topicId&&l.localParent===scope.itemId):owners;
 if(members.length!==1)throw fail('SHARED_NATIVE_BINDING_CHANGED');
 const [id]=members[0],object=runtime.state.objects[id];
 if(!object||(scope.topicId&&object.parentId!==owners[0][0])||binding(runtime,scope,id)!==options.expectedBinding)throw fail('SHARED_NATIVE_BINDING_CHANGED');
 return id;
}

async function removeConfirmed(runtime,scope,options,{createDefaultTopic,isCurrent}){
 validateScope(runtime,scope);
 if(options.confirmed!==true||!['all','device'].includes(options.mode)||!Number.isSafeInteger(options.expectedVersion)||typeof options.operationId!=='string'||!/^[A-Za-z0-9_-]{1,96}$/.test(options.operationId))throw fail('SHARED_DELETE_CONFIRMATION_REQUIRED');
 const sharedId=checkedBinding(runtime,scope,options,isCurrent);
 const prior=runtime.state.localRemovals[sharedId];
 const sameOperation=prior?.body?.opId===options.operationId&&prior.body.mode===options.mode&&prior.body.expectedVersion===options.expectedVersion;
 if(sameOperation&&['pending','accepted'].includes(prior.stage))await runtime.directoryState.recover();
 let warning;
 const replayed=sameOperation&&prior.stage==='removed';
 if(!replayed){
  const checkTarget=()=>{
   if(checkedBinding(runtime,scope,options,isCurrent)!==sharedId||nativeObject(runtime,scope)?.id!==sharedId)throw fail('SHARED_NATIVE_BINDING_CHANGED');
  };
  checkTarget();
  // The directory may wait for configuration and replica work. Recheck the
  // original confirmation after that wait, before journaling a deletion.
  const accepted=await runtime.directoryState.remove({sharedId,mode:options.mode,expectedVersion:options.expectedVersion,confirmed:true,opId:options.operationId},checkTarget);
  warning=accepted.warning;
 }
 const receipt={success:true,removed:options.mode,...(replayed?{replayed:true}:{}),...(warning?{warning}:{})};
 if(!scope.topicId)return {...receipt,remainingTopics:[]};
 // Refresh and replacement are local follow-up work. Failure here must not
 // change a successful removal into a failed deletion on the form.
 try {
  const config=await runtime.host.readNativeOwner(scope.itemType||'agent',scope.itemId);
  if(!Array.isArray(config?.topics))throw fail('SHARED_LOCAL_MAPPING_REQUIRED');
  receipt.remainingTopics=config.topics;
 } catch(error) {
  return addRemovalWarning(receipt,'话题已移除，本机话题列表尚未刷新',error);
 }
 if(options.mode!=='all'||receipt.remainingTopics.length||!createDefaultTopic)return receipt;
 try {
  checkedBinding(runtime,scope,options,isCurrent);
  if(!nativeObject(runtime,{itemType:scope.itemType,itemId:scope.itemId}))throw fail('SHARED_NATIVE_BINDING_CHANGED');
  const next=await createDefaultTopic();
  if(!next?.success||!Array.isArray(next.topics)||!next.topics.length)throw Error(next?.error||'SHARED_LOCAL_MAPPING_REQUIRED');
  receipt.remainingTopics=next.topics;
 } catch(error) {
  return addRemovalWarning(receipt,'话题已删除，补建主话题尚未完成',error);
 }
 return receipt;
}
function addRemovalWarning(receipt,message,error){
 return {...receipt,warning:[receipt.warning,message+'：'+(error.code||error.message)].filter(Boolean).join('；')};
}
async function renameTopic(runtime,scope,name,options={}){
 const object=nativeObject(runtime,scope);if(!object)return null;
 if(object.kind!=='topic'||typeof name!=='string'||!name.trim())throw fail('INVALID_TOPIC_TITLE');
 if(!Number.isSafeInteger(options.expectedVersion)||typeof options.operationId!=='string'||!/^[A-Za-z0-9_-]{1,96}$/.test(options.operationId)||options.expectedBinding!==binding(runtime,scope,object.id))throw fail('SHARED_CONFIG_BASE_REQUIRED');
 if(runtime.readOnly)throw fail('SHARED_READ_ONLY');
 const {object:current}=await runtime.send('/api/v1/sync/shared/config?'+new URLSearchParams({sharedSpaceId:runtime.connection.sharedSpaceId,sharedId:object.id}));
 await runtime.configs.submit(object.id,'topic',{...current.config,name:name.trim()},{expectedVersion:options.expectedVersion,opId:options.operationId});
 const config=await runtime.host.readNativeOwner(scope.itemType||'agent',scope.itemId);
 return {success:true,topics:config?.topics||[]};
}
async function avatar(runtime,kind,localId,data){
 const object=nativeObject(runtime,{itemType:kind,itemId:localId});if(!object)return null;
 const result = await require('./nativeConfigSave').saveNativeOwnerAvatar({
  root: runtime.root, runtime, kind, localId, data,
 });
 if (!result?.success) throw fail(result?.error || 'SHARED_AVATAR_FAILED');
 return result;
}
module.exports={nativeObject,deletionContext,serializeRemoval,remove,renameTopic,avatar};

'use strict';
const path=require('node:path');
const {ownedJson}=require('./sharedLocal');
const {stable,fail}=require('./protocol');
const {SharedConfigReplica}=require('./sharedConfigReplica');
const {SharedDirectory}=require('./sharedDirectory');
const {SharedMatching}=require('./sharedMatching');
const {openSharedReplica}=require('./sharedReplica');
const endpoint='/api/v1/sync/shared/';
const settled=s=>!s?.pending&&!s?.outbox?.length&&!s?.inbox?.length&&!Object.keys(s?.localCommits||{}).length&&!Object.keys(s?.drift||{}).length;
const blocked=async()=>{throw fail('SHARED_READ_ONLY');};

// Compatibility reading of an already joined, fully materialized replica.
// No join, discovery, binding, upload, confirmation, or execution recovery.
async function open(r){
 if(!r.state.adopted||r.state.pending||Object.values(r.state.localRemovals||{}).some(o=>!['removed','restored','rejected'].includes(o.stage)))throw fail('SHARED_READ_ONLY_NOT_SETTLED');
 const configs=await ownedJson(r.root,path.join(r.dir,'configs.json'));
 const messages=await ownedJson(r.root,path.join(r.dir,'messages.json'));
 const executions=await ownedJson(r.root,path.join(r.dir,'executions.json'),{optional:true});
 if(configs.intent||Object.values(configs.drafts||{}).some(d=>d.submitted)||!settled(messages)||Object.values(executions?.requests||{}).some(e=>!['completed','abandoned'].includes(e.phase)))throw fail('SHARED_READ_ONLY_NOT_SETTLED');
 r.matching=await SharedMatching.open(r);
 if(Object.values(r.matching.state.plans).some(p=>!['complete','cancelled','rejected'].includes(p.status)))throw fail('SHARED_READ_ONLY_NOT_SETTLED');
 for(const m of r.mappings())if(!r.state.baselines[m.sharedId]?.complete)throw fail('SHARED_READ_ONLY_NOT_SETTLED');
 const send=r.send;r.send=(route,options)=>options?.body!==undefined?Promise.reject(fail('SHARED_READ_ONLY')):send(route,options);
 // GET bindings proves the original membership still exists; it cannot join it.
 r.directoryState=new SharedDirectory(r);await r.directoryState.bindings();
 if(r.isStopping())throw fail('APPLICATION_SHUTTING_DOWN');
 r.releaseHost=r.host.activate?.(r);
 r.configs=await SharedConfigReplica.open({statePath:path.join(r.dir,'configs.json'),sharedSpaceId:r.connection.sharedSpaceId,deviceId:r.connection.deviceId,send:r.send,readLocal:o=>r.readLocal(o),writeLocal:o=>r.writeLocal(o),materializeTarget:o=>r.target(o)});
 r.replica=await openSharedReplica({queue:r.queue,statePath:path.join(r.dir,'messages.json'),connection:r.connection,mappings:r.mappings(),send:r.send,notify:r.notify});
 const adapter=r.adapter,beforeMutation=adapter.beforeMutation.bind(adapter),beforeWrite=adapter.beforeWrite.bind(adapter);
 adapter.beforeInitialize=async()=>{throw fail('SHARED_READ_ONLY');};
 adapter.beforeMutation=async d=>{if(!['remote','attachment-materialization'].includes(d.syncSource))throw fail('SHARED_READ_ONLY');return beforeMutation(d);};
 adapter.beforeWrite=async d=>{if(!['remote','attachment-materialization'].includes(d.syncSource))throw fail('SHARED_READ_ONLY');return beforeWrite(d);};
 const diagnostics=adapter.diagnostics.bind(adapter);adapter.diagnostics=()=>({...diagnostics(),readOnly:true,configurationError:r.error||'SHARED_READ_ONLY',shared:{transportError:r.waitClient?.transportError,spaceId:r.connection.sharedSpaceId,objects:r.directoryEntries().length,ready:r.ready,readOnly:true,configurationConflicts:Object.values(r.configs.state.drafts).filter(d=>d.conflict===true).length}});
 r.execution=await require('./sharedExecution').SharedExecution.open(r);adapter.sharedExecution=r.execution;
 r.execution.prepare=blocked;r.execution.prepareNative=blocked;r.execution.prepareGroupNative=blocked;r.execution.abandon=blocked;
 if(r.connection.syncAttachments&&r.capabilities.features?.includes('shared-attachments-v1')){
  r.attachments=new (require('./attachments').DesktopAttachments)({queue:r.queue,appDataRoot:r.root,connection:{...r.connection,topics:r.mappings().filter(m=>r.isLocalVisible(m.sharedId)).map(m=>m.local)},send:r.send,download:r.download,storeAttachment:r.storeAttachment,routeBase:'/api/plugins/NativeSync/shared-attachments/',localOnly:true,getMapping:()=>r.mappings().map(m=>({key:m.sharedId,ownerType:m.local.itemType,ownerId:m.local.itemId,topicId:m.local.topicId})),onMaterialized:(d,result)=>r.notify({agentId:d.itemId,ownerId:d.itemId,ownerType:d.itemType,topicId:d.topicId,revision:result.revision,source:'native-sync'})});
  adapter.attachmentRecovery = r.attachments;
 }
 await tick(r);
 if(r.isStopping())throw fail('APPLICATION_SHUTTING_DOWN');
 r.ready=true;
 r.startScheduler();
}

async function tick(r,{hints=null,forceAttachments=false,skipAttachments=false}={}){
  if(r.closed)return;
  let after='';
  if(!hints||hints.has('changes')||hints.has('matches'))for(;;){
   const page=await r.send(endpoint+'directory?'+new URLSearchParams({sharedSpaceId:r.connection.sharedSpaceId,after,limit:'128'}));
   for(const object of page.objects){
    // New/unbound objects require the normal candidate, never an implicit join.
    if(!r.state.locals[object.id]){r.error='SHARED_READ_ONLY_REPLICA_INCOMPLETE';continue;}
    const old=r.state.objects[object.id];if(!old||object.deleted!==old.deleted)throw fail('SHARED_READ_ONLY_REPLICA_CHANGED');
    if(!object.deleted&&r.isLocalVisible(object.id))await r.configs.receive(object);
    const summary=r.summary(object);
    if(stable(old)!==stable(summary)){
     r.state.objects[object.id]=summary;
     r.readOnlyRegistryDirty=true;
    }
   }
   if(!page.hasMore)break;if(!page.next||page.next===after)throw fail('SHARED_DIRECTORY_INVALID');after=page.next;
  }
  if(r.readOnlyRegistryDirty){
   await r.save();
   r.readOnlyRegistryDirty=false;
  }
  if(!hints||hints.has('pull')||r.recoverableMessages())await r.replica.sync({pullOnly:true});
  else r.adapter.retryNotifications();
  if(!skipAttachments&&r.attachments&&(forceAttachments||r.attachments.work.shouldRun()))await r.attachments.work.run(r.mappings().filter(m=>r.isLocalVisible(m.sharedId)).map(m=>({...m.local,attachmentBinding:m.sharedId})),{readOnly:true});
  r.error=null;
}
module.exports={open,tick};

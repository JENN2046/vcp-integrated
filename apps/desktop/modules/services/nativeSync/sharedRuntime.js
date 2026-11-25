'use strict';
const authorityControl=require('./historyAuthority');
const path=require('node:path'),fs=require('node:fs/promises');
const {randomUUID}=require('node:crypto');
const {stable,sha256,fail,messageKey,messageHash,descriptor}=require('./protocol');
const {ownedJson,readSettledSource,inspectShared}=require('./sharedLocal');
const {SharedWaitClient,auditMs,lanes}=require('./sharedWaitClient');
const recoveryDelay=1000;
const denied=e=>[401,403].includes(e.status)||e.code==='SHARED_SPACE_NOT_APPROVED';
const membershipDenied=e=>e.status===401||['SHARED_SPACE_NOT_APPROVED','SHARED_MEMBERSHIP_REQUIRED','SOURCE_SCOPE_REQUIRED','SOURCE_BINDING_REQUIRED'].includes(e.code);
const permissionError=()=>fail('SHARED_WATCH_PERMISSION_REQUIRED');
const {durableJson}=require('./durableJson');
const {sourceDirectory}=require('./sourceDirectory');
const {sharedConfig}=require('./contracts.generated.cjs');
const {SharedConfigReplica}=require('./sharedConfigReplica');
const {openSharedReplica}=require('./sharedReplica');
const {projectNativeConfig}=require('./sharedHost');
const {emptyHash,fieldsFrom}=require('./metadata');
const {validateConfig,observeConfigVersions}=require('./sharedConfigVersion');
const endpoint='/api/v1/sync/shared/';
const kindOrder=['agent','group','rules','topic'];
const inactiveTaskWork = new Set(['completed','cancelled','failed']);
const activeTaskStates = new Set(['accepted','running','waiting','cancelling']);

function localTopicConfig(topic){
 return {name:topic.name||topic.id,archived:topic.archived===true};
}

function startupFence(sharedSpaceId,error=()=>null){
 const blocked=async()=>{throw fail(error()||'SHARED_STARTUP_PENDING');};
 return {isRecoveryFence:true,sharedSpaceId,topics:[],fullSource:true,isEnabled:()=>true,beforeWrite:blocked,beforeMutation:blocked,beginDelete:blocked,diagnostics:()=>({enabled:false,readOnly:true,degraded:error()||'SHARED_STARTUP_PENDING',outboxSize:0,inboundBuffered:0,conflicts:[],localCommits:[]})};
}
class SharedRuntime {
 static async open(options){
  const runtime=new SharedRuntime(options);
  try{await runtime.open();}
  catch(error){
   if(!runtime.isStopping()){await runtime.close();throw error;}
   // Explicit desktop shutdown owns partial-runtime cleanup and its result.
   runtime.ready=false;
  }
  return runtime;
 }
 constructor({queue,appDataRoot,connection,sharedHost,send,openEvents,openWatch,notify=()=>{},notifyExecutionStatus=()=>{},intervalMs=1000,agentConfigEvents,download,storeAttachment,isStopping=()=>false,historyAuthority=authorityControl.authorityForQueue(queue)}){
  Object.assign(this,{queue,root:path.resolve(appDataRoot),connection,host:sharedHost,notify,notifyExecutionStatus,intervalMs,storeAttachment,isStopping});
  this.accessController=new AbortController();
  this.download=download&&((route,options)=>this.withSharedAccess(download,route,options));
  this.openEvents=openEvents&&((query,options)=>this.withSharedAccess(openEvents,query,options));
  this.proveMembership=()=>send(endpoint+'bindings?'+new URLSearchParams({sharedSpaceId:this.connection.sharedSpaceId}));
  // All remote config GETs, including the settings editor and pre-save reads,
  // use the same acceptance rule before the caller can consume the response.
  this.send=(route,options)=>{
   if(this.readOnly&&options?.body!==undefined)return Promise.reject(fail('SHARED_READ_ONLY'));
   const response=route===endpoint+'info'?send(route,options):this.withSharedAccess(send,route,options).catch(error=>{
    if(membershipDenied(error))this.denyShared();
    throw error;
   });
   if(options?.body)return response;
   if(route.startsWith(endpoint+'config?'))return response.then(async result=>{
    const id=new URLSearchParams(route.slice(route.indexOf('?')+1)).get('sharedId');
    await this.observeConfigs([result.object],id);return result;
   });
   if(route.startsWith(endpoint+'directory?'))return response.then(async result=>{
    if(!Array.isArray(result.objects))throw fail('SHARED_DIRECTORY_INVALID');
    await this.observeConfigs(result.objects);return result;
   });
   return response;
  };
  this.trajectorySource=require('./trajectorySource').createTrajectorySource(this);
  this.waitClient=new SharedWaitClient(send,connection.sharedSpaceId,reason=>{
   if(reason==='reconnect')this.capabilityInvalidated=true;
   this.scheduleTick();
  },{openWatch,invalidate:error=>{
   if(denied(error))this.denyShared();else{this.capabilityInvalidated=true;this.scheduleTick();}
  }});
  authorityControl.bindAuthority(this,historyAuthority);
  this.dir=path.join(this.root,'.native-sync/shared',connection.sharedSpaceId);this.file=path.join(this.dir,'registry.json');
  this.closed=false;this.ready=false;this.error=null;this.optimisticEnabled=true;
  this.agentConfigEvents=agentConfigEvents;this.dirty=true;this.activeCompactionPrepares=new Set();this.activeCompactions=new Set();
  this.queue.configureSync(startupFence(connection.sharedSpaceId,()=>this.error));
 }
 async observeConfigs(objects,requestedId){
  for(const object of objects){
   const id=requestedId===undefined?object?.id:requestedId;
   validateConfig(object,this.connection.sharedSpaceId,id,this.configs?.state.objects[id],this.state?.objects[id]);
  }
  await observeConfigVersions(this.root,this.connection,objects);
 }
 save(){const next=(this.registryDisk||Promise.resolve()).catch(()=>{}).then(async()=>{await durableJson(this.file,this.state);this.planTick();});this.registryDisk=next;return next;}
 async command(action,body){
  if(this.state.pending){const p=this.state.pending;if(p.action!==action||stable(p.body)!==stable(body))throw fail('SHARED_PENDING_REGISTRATION');}
  else{this.state.pending={action,body};await this.save();}
  return this.sendPendingRegistration();
 }
 async sendPendingRegistration(){
  const pending=this.state.pending;
  try{return await this.send(endpoint+pending.action,{body:pending.body});}
  catch(error){
   const body=pending.body,old=this.state.locals[body.parentId],target=old?.aliasOf&&this.state.objects[old.aliasOf],local=target&&this.state.locals[target.id];
   const completed=target&&Object.values(this.matching.state.plans).some(p=>p.status==='complete'&&p.result?.retainedAlias===body.parentId&&p.result?.object?.id===target.id);
   // A successful old receipt is retried unchanged above. This 404 means the
   // original create was not accepted; only an applied native merge authorizes
   // choosing its retained owner for the same local, still-empty topic.
   if(error.code!=='SHARED_OBJECT_NOT_FOUND'||error.status!==404||pending.action!=='objects'||body.kind!=='topic'||pending.recovery||!completed||!this.state.objects[body.parentId]?.deleted||!local||local.aliasOf||local.hidden||target.deleted||old.kind!==target.kind||old.localId!==body.localParent||local.localId!==body.localParent)throw error;
   const rows=await this.queue.read({itemType:target.kind,itemId:body.localParent,topicId:body.localId});
   if(rows.length)throw fail('SHARED_UNREGISTERED_HISTORY');
   const original=structuredClone(body);
   this.state.pending={action:pending.action,body:{...body,parentId:target.id,opId:this.op('reparent:'+body.opId+':'+target.id)},recovery:{reason:'SHARED_PARENT_MERGED',originalBody:original}};
   await this.save();
   return this.send(endpoint+pending.action,{body:this.state.pending.body});
  }
 }
 async recoverRegistrationNow(){if(this.state.pending){const result=await this.sendPendingRegistration();await this.recordCommand(this.state.pending,result);await this.finishCommand();}}
 serialRegistration(fn){const next=(this.registrationTail||Promise.resolve()).catch(()=>{}).then(fn);this.registrationTail=next;return next;}
 recoverRegistration(){return this.serialRegistration(()=>this.recoverRegistrationNow());}
 async finishCommand(){this.state.pending=null;await this.save();}
 op(key){return 'shared_'+sha256(this.connection.sharedJoinOpId+'\0'+key).slice(0,40);}
 binding(){const c=this.connection;return {sharedSpaceId:c.sharedSpaceId,sourceId:c.sourceId,deviceId:c.deviceId,spaceId:c.spaceId,sourceRoot:this.root};}
 async open(){
  if(authorityControl.authorityFor(this))return authorityControl.withAuthority(authorityControl.authorityFor(this),'shared-open',()=>this.openPrepared());
  return this.openPrepared();
 }
 async openPrepared(){
  if(!this.host||this.host.capability!=='shared-space-v1')throw fail('SHARED_NATIVE_CONFIG_AUTHORITY_REQUIRED');
  const previous=await readSettledSource(this.root,this.connection);this.legacy=previous;
  this.capabilities=await inspectShared(this.connection,previous,this.send,{allowReadOnly:true});
  const loaded=await ownedJson(this.root,this.file,{optional:true});
  this.readOnly=this.capabilities.readOnly===true||require('./releasePolicy.cjs').sharedReadOnly;
  if(this.readOnly&&!loaded)throw fail('SHARED_READ_ONLY_EXISTING_REPLICA_REQUIRED');
  this.state=loaded||{version:1,binding:this.binding(),legacyHash:sha256(stable(previous)),locals:{},objects:{},baselines:{},adopted:false,pending:null};
  if(this.state.version!==1||stable(this.state.binding)!==stable(this.binding())||this.state.legacyHash!==sha256(stable(previous)))throw fail('SHARED_BINDING_CHANGED');
  this.coreSingle = new (require('./coreSingleClient').CoreSingleClient)(this);
  const coreAdvertised = this.coreSingle.owns({ itemType: 'agent' });
  if (this.state.coreSingle && !coreAdvertised) throw fail('CORE_AUTHORITY_UNAVAILABLE');
  if (coreAdvertised && !this.state.coreSingle) { this.state.coreSingle=true; await this.save(); }
  if(this.readOnly)return require('./sharedReadonly').open(this);
  this.matching=await require('./sharedMatching').SharedMatching.open(this);
  if(this.isStopping())throw fail('APPLICATION_SHUTTING_DOWN');
  this.releaseHost=this.host.activate?.(this);this.directoryState=new (require('./sharedDirectory').SharedDirectory)(this);
  await this.send(endpoint+'join',{body:{sharedSpaceId:this.connection.sharedSpaceId,opId:this.connection.sharedJoinOpId}});
  // Registration commands survive accepted responses lost before local save.
  await this.recoverRegistration();
  this.configs=await SharedConfigReplica.open({statePath:path.join(this.dir,'configs.json'),sharedSpaceId:this.connection.sharedSpaceId,deviceId:this.connection.deviceId,send:this.send,readLocal:o=>this.readLocal(o),writeLocal:o=>this.writeLocal(o),materializeTarget:o=>this.target(o)});
  if(!this.state.adopted){await this.discover(true);this.state.adopted=true;await this.save();}
  await this.directoryState.recover();await this.directory();
  await this.pollDirectory();await this.directoryState.bindings();
  await this.ensureRules();
  await this.materialize();
  const mappings=this.legacyMappings();
  this.replica=await openSharedReplica({queue:this.queue,statePath:path.join(this.dir,'messages.json'),connection:this.connection,mappings,send:this.send,notify:this.notify,historyAuthority:authorityControl.authorityFor(this)});
  // Origin histories already have verified per-message bases. Retain them so
  // baseline reconciliation never mistakes a current v2 for an empty v1 base.
  await this.replica.adapter.transaction(next=>{
   for(const mapping of mappings)if(mapping.adopted)for(const [key,value]of Object.entries(this.legacy.acked)){
    const [type,owner,topic]=JSON.parse(key);if(type===mapping.shared.itemType&&owner===mapping.shared.itemId&&topic===mapping.shared.topicId&&!next.acked[key])next.acked[key]=structuredClone(value);
   }
  });
  const adapter=this.replica.adapter;
  this.configureHistoryPolicy(adapter);
  const diagnostics=adapter.diagnostics.bind(adapter);adapter.diagnostics=()=>{
   const ids=Object.keys(this.configs.state.drafts),blocking=ids.filter(id=>require('./sharedExecution').blocksExecution(this,id));
   return {...diagnostics(),readOnly:this.readOnly,configurationError:this.error||(blocking.length?'SHARED_CONFIG_CONFLICT':null),shared:{transportError:this.waitClient?.transportError,spaceId:this.connection.sharedSpaceId,objects:this.directoryEntries().length,ready:this.ready,configurationDrafts:ids.length,configurationConflicts:ids.filter(id=>this.configs.state.drafts[id].conflict===true).length,executionBlockingDrafts:blocking.length,steeringEnabled:this.capabilities.features?.includes('shared-steering-v1')===true}};
  };
  await this.matching.poll();await this.directoryState.tombstones();
  await this.backfill({verifyExisting:true});await this.replica.sync();
  if(this.connection.syncAttachments&&this.capabilities.features?.includes('shared-attachments-v1')){
   const connection={...this.connection,topics:this.legacyMappings().filter(m=>this.isLocalVisible(m.sharedId)&&!this.matching?.fenced(m.sharedId)).map(m=>m.local)};
   this.attachments=new (require('./attachments').DesktopAttachments)({queue:{readSnapshot:d=>this.queue.readSnapshot(d),mutate:(...args)=>this.mutateAttachment(...args)},appDataRoot:this.root,connection,send:this.send,download:this.download,storeAttachment:this.storeAttachment,routeBase:'/api/plugins/NativeSync/shared-attachments/',localOnly:true,getMapping:()=>this.legacyMappings().map(m=>({key:m.sharedId,ownerType:m.local.itemType,ownerId:m.local.itemId,topicId:m.local.topicId})),onMaterialized:(d,result)=>this.notify({agentId:d.itemId,ownerId:d.itemId,ownerType:d.itemType,topicId:d.topicId,revision:result.revision,source:'native-sync'})});
   adapter.attachmentRecovery = this.attachments;
  }
  this.execution=await require('./sharedExecution').SharedExecution.open(this);adapter.sharedExecution=this.execution;await this.execution.reconcile();this.sessions=new (require('./sharedSessionClient').SharedSessionClient)(this,{openEvents:this.openEvents});
  if(this.isStopping())throw fail('APPLICATION_SHUTTING_DOWN');
  this.ready=true;await this.sessions.reconcile();
  this.topicSponsor=new (require('./sharedTopicSponsor').SharedTopicSponsor)(this);
  this.topicSponsorRecovery=this.topicSponsor.recover().catch(error=>console.warn('[NativeSync] TopicSponsor recovery pending:',error.code||'UNKNOWN'));
  if(this.isStopping())throw fail('APPLICATION_SHUTTING_DOWN');
  this.changed=()=>{this.dirty=true;this.scheduleTick();};this.agentConfigEvents?.on?.('agent-config-updated',this.changed);adapter.directoryChanged=this.changed;
  this.startScheduler();
 }
 configureHistoryPolicy(adapter){
  const beforeMutation=adapter.beforeMutation.bind(adapter),beforeWrite=adapter.beforeWrite.bind(adapter);
  adapter.beforeInitialize=async d=>{
   this.assertSharedAccess();
   if(this.readOnly)throw fail('SHARED_READ_ONLY');
   if(this.closed||!this.ready)throw fail('SHARED_STARTUP_PENDING');
   const mapping=this.mappings().find(m=>m.shared.itemType===(d.itemType||'agent')&&m.shared.itemId===d.itemId&&m.shared.topicId===d.topicId);
   if(!mapping)throw fail('SHARED_LOCAL_MAPPING_REQUIRED');
   if(!this.isLocalVisible(mapping.sharedId))throw fail('SHARED_LOCAL_REMOVED');
   if(this.state.pending)throw fail('SHARED_PENDING_REGISTRATION');
   this.matching.assert([mapping.sharedId,this.state.objects[mapping.sharedId].parentId]);
   if(this.coreSingle?.owns(d))return;
   adapter.assertInitializationReady(d);
   await beforeMutation(d);await beforeWrite(d);
  };
  adapter.beforeMutation=async d=>{if(this.coreSingle?.owns(d))throw fail('CORE_ROUTE_REQUIRED');if(!['remote','attachment-materialization'].includes(d.syncSource))throw fail('SHARED_EXECUTION_NOT_READY');return beforeMutation(d);};
  adapter.beforeWrite=async d=>{if(this.coreSingle?.owns(d))throw fail('CORE_ROUTE_REQUIRED');if(!['remote','attachment-materialization'].includes(d.syncSource))throw fail('SHARED_EXECUTION_NOT_READY');return beforeWrite(d);};
 }
 async recordCommand(p,result){
  if(authorityControl.authorityFor(this))return authorityControl.withAuthority(authorityControl.authorityFor(this),'shared-recordCommand',()=>this.recordCommandPrepared(p,result));
  return this.recordCommandPrepared(p,result);
 }
 async recordCommandPrepared(p,result){
  const object=result.object;if(!object||object.sharedSpaceId!==this.connection.sharedSpaceId)throw fail('SHARED_CONFIG_RESPONSE_INVALID');
  if(p.action==='adopt'||p.action==='objects'){
   this.state.locals[object.id]={kind:object.kind,localId:p.body.localId,localParent:p.body.localParent||'',adopted:p.action==='adopt',seed:true};
  }else if(p.action==='bind')this.state.locals[object.id]={kind:object.kind,localId:p.body.localId,localParent:p.body.localParent||'',adopted:false,seed:false};
  if(!this.state.objects[object.id]||this.state.objects[object.id].version<=object.version)this.state.objects[object.id]=this.summary(object);await this.save();
 }
 summary(object){const {config,...metadata}=object;return metadata;}
 register(action,body){return this.serialRegistration(async()=>{
  await this.recoverRegistrationNow();
  const existing=action==='bind'?this.state.locals[body.sharedId]&&body.sharedId:['objects','adopt'].includes(action)?Object.keys(this.state.locals).find(id=>{const local=this.state.locals[id];return local.kind===body.kind&&local.localId===body.localId&&(local.localParent||'')===(body.localParent||'');}):null;
  if(existing)return (await this.send(endpoint+'config?'+new URLSearchParams({sharedSpaceId:this.connection.sharedSpaceId,sharedId:existing}))).object;
  return this.registerNow(action,body);
 });}
 async registerNow(action,body){
  const full={sharedSpaceId:this.connection.sharedSpaceId,...body};
  const result=await this.command(action,full);await this.recordCommand({action,body:full},result);await this.finishCommand();if((this.configs?.state.objects[result.object.id]?.version||0)>result.object.version)return (await this.send(endpoint+'config?'+new URLSearchParams({sharedSpaceId:this.connection.sharedSpaceId,sharedId:result.object.id}))).object;return result.object;
 }
 notifyDirectory(object,extra={}){
  if(this.backgroundDenied)return;
  const local=object&&this.state.locals[object.id];if(!local||local.kind!==object.kind||local.aliasOf)return false;
  const change={...extra,kind:object.kind,id:local.localId,sharedId:object.id,sharedSpaceId:this.connection.sharedSpaceId,version:object.version,deleted:object.deleted===true};
  if(object.kind==='topic'){
   const owner=this.state.objects[object.parentId],parent=owner&&this.state.locals[owner.id];
   if(!owner||!['agent','group'].includes(owner.kind)||!parent||parent.kind!==owner.kind||parent.aliasOf||local.localParent!==parent.localId)return false;
   Object.assign(change,{topicId:local.localId,ownerId:parent.localId,ownerType:owner.kind,ownerSharedId:owner.id});
  }
  this.host.notify?.(change);return true;
 }
 localFor(id){const local=this.state.locals[id];if(!local)throw fail('SHARED_LOCAL_MAPPING_REQUIRED');return local;}
 sharedMember(localId){const found=Object.entries(this.state.locals).find(([id,l])=>l.kind==='agent'&&!l.aliasOf&&l.localId===localId);if(!found){const alias=this.state.retiredOwners?.['agent:'+localId];if(alias)return alias;throw fail('SHARED_MEMBER_NOT_REGISTERED');}return found[0];}
 groupToShared(config){const value=structuredClone(config),convert=id=>this.sharedMember(id);value.members=value.members.map(convert);if(value.memberTags)value.memberTags=Object.fromEntries(Object.entries(value.memberTags).map(([id,v])=>[convert(id),v]));for(const order of [value.sequentialSpeakerOrder,value.modeSettings?.sequential?.speakerOrder])if(order)for(let i=0;i<order.length;i++)order[i]=convert(order[i]);return value;}
 groupToLocal(config){const value=structuredClone(config),convert=id=>this.localFor(id).localId;value.members=value.members.map(convert);if(value.memberTags)value.memberTags=Object.fromEntries(Object.entries(value.memberTags).map(([id,v])=>[convert(id),v]));for(const order of [value.sequentialSpeakerOrder,value.modeSettings?.sequential?.speakerOrder])if(order)for(let i=0;i<order.length;i++)order[i]=convert(order[i]);return value;}
 target(object){if(object.kind==='topic')return {name:object.config.name,archived:object.config.archived===true};if(['agent','group'].includes(object.kind))return this.host.projectOwner(object.kind,object.config);if(object.kind==='rules')return {name:object.config.name,tavernRules:this.host.projectRuleStore(object.config.tavernRules||[]),executionPolicy:this.host.projectPolicy(object.config.executionPolicy||{})};return object.config;}
 async readLocal(object){
  object={...this.state.objects[object.id],...object};
  const local=this.localFor(object.id);
  if(['agent','group'].includes(object.kind)){const value=await this.host.readOwner(object.kind,local.localId);return value&&object.kind==='group'?this.groupToShared(value):value;}
  if(object.kind==='rules')return {name:object.config.name,tavernRules:await this.host.readRules(),executionPolicy:await this.host.readPolicy()};
  const parent=this.localFor(object.parentId),raw=await ownedJson(this.root,path.join(this.root,parent.kind==='agent'?'Agents':'AgentGroups',parent.localId,'config.json'),{optional:true}),topic=raw?.topics?.find(t=>t.id===local.localId);
  return topic?localTopicConfig(topic):null;
 }
 async writeLocal(object){
  const local=this.localFor(object.id);
  if(['agent','group'].includes(object.kind))return this.host.writeOwner(object.kind,local.localId,object.kind==='group'?this.groupToLocal(this.target(object)):this.target(object));
  if(object.kind==='rules'){const target=this.target(object);await this.host.writeRules(target.tavernRules);await this.host.writePolicy(target.executionPolicy);return;}
  const parent=this.localFor(object.parentId);return this.host.ensureTopic(parent.kind,parent.localId,{id:local.localId,name:object.config.name,archived:object.config.archived===true,nativeSyncOriginSource:object.originSource});
 }
 async adoptRegisteredConfig(object){
  // Keep seed set for crash recovery until the config replica has persisted its baseline.
  await this.configs.adopt(object);
  this.state.locals[object.id].seed=false;
  await this.save();
 }
 async discover(adopting=false,onNativeTopic){
  const directory=await sourceDirectory({appDataRoot:this.root,connection:this.connection,onNativeTopic,readAgentConfig:id=>ownedJson(this.root,path.join(this.root,'Agents',id,'config.json')),readGroupConfig:id=>ownedJson(this.root,path.join(this.root,'AgentGroups',id,'config.json'))});
  if(directory.errors.length)throw fail(directory.errors[0].code);
  for(const kind of ['agent','group'])for(const owner of directory.agents.filter(o=>o.ownerType===kind)){
   if(this.state.retiredOwners?.[kind+':'+owner.ownerId]||Object.values(this.state.locals).some(l=>l.kind===kind&&l.localId===owner.ownerId))continue;
   let config=await this.host.readOwner(kind,owner.ownerId);if(kind==='group')config=this.groupToShared(config);config=sharedConfig(kind,config);
   const object=await this.register(adopting?'adopt':'objects',{opId:this.op('owner:'+kind+':'+owner.ownerId),kind,localId:owner.ownerId,config});await this.adoptRegisteredConfig(object);this.notifyDirectory(object);
  }
  for(const topic of directory.topics){
   if(Object.values(this.state.locals).some(l=>l.kind==='topic'&&l.localParent===topic.ownerId&&l.localId===topic.topicId))continue;
   const owner=this.nativeObject(topic.ownerType,topic.ownerId),parent=owner&&!owner.retired&&!owner.deleted?[owner.id,this.localFor(owner.id)]:null;if(!parent)throw fail('SHARED_LOCAL_MAPPING_REQUIRED');
   if(!adopting){const rows=await this.queue.read({itemType:topic.ownerType,itemId:topic.ownerId,topicId:topic.topicId});if(rows.length)throw fail('SHARED_UNREGISTERED_HISTORY');}
   const object=await this.register(adopting?'adopt':'objects',{opId:this.op('topic:'+topic.ownerType+':'+topic.ownerId+':'+topic.topicId),kind:'topic',...(adopting?{ownerType:topic.ownerType}:{}),localId:topic.topicId,localParent:topic.ownerId,parentId:parent[0],config:{name:topic.name,archived:topic.archived===true}});await this.adoptRegisteredConfig(object);this.notifyDirectory(object);
  }
 }
 async directory(){
  let after='',revision=null;
  do{const page=await this.send(endpoint+'directory?'+new URLSearchParams({sharedSpaceId:this.connection.sharedSpaceId,after,limit:'128'}));
   if(!Array.isArray(page.objects)||!Number.isSafeInteger(page.revision))throw fail('SHARED_DIRECTORY_INVALID');
   // Keep the first page watermark: changes to an already visited object (or
   // a newly inserted lower ID) must still be read from the change feed.
   revision=revision===null?page.revision:Math.min(revision,page.revision);
   for(const object of page.objects)this.state.objects[object.id]=this.summary(object);
   if(!page.hasMore)break;if(!page.next||page.next===after)throw fail('SHARED_DIRECTORY_INVALID');after=page.next;
  }while(true);
  this.state.revision=revision;await this.save();await this.bindMissing();
 }
 async bindMissing(){
  for(const kind of kindOrder)for(const object of Object.values(this.state.objects).filter(o=>o.kind===kind&&!o.deleted)){
   if(this.state.locals[object.id])continue;
   const localId='ns_'+sha256(this.connection.sharedSpaceId+':'+object.id).slice(0,24),parent=kind==='topic'?this.localFor(object.parentId):null;
   const candidate=kind==='topic'?path.join(this.root,'UserData',parent.localId,'topics',localId):path.join(this.root,kind==='agent'?'Agents':kind==='group'?'AgentGroups':'.native-sync/shared',localId);
   try{await fs.lstat(candidate);throw fail('SHARED_LOCAL_PATH_COLLISION');}catch(e){if(e.code!=='ENOENT')throw e;}
   await this.register('bind',{opId:this.op('bind:'+object.id),sharedId:object.id,localId,...(parent?{localParent:parent.localId}:{})});
  }
 }
 async ensureRules(){
  if(Object.values(this.state.objects).some(o=>o.kind==='rules'))return;
  const object=await this.register('objects',{opId:this.op('global-rules'),kind:'rules',localId:'shared_rules',config:{name:'共享规则',tavernRules:await this.host.readRules(),executionPolicy:await this.host.readPolicy()}});await this.configs.adopt(object);
 }
 async pollDirectory(){
  for(;;){
   const page=await this.send(endpoint+'changes?'+new URLSearchParams({sharedSpaceId:this.connection.sharedSpaceId,after:String(this.state.revision||0),limit:'128'}));
   if(!Array.isArray(page.changes)||!Number.isSafeInteger(page.next)||page.next<(this.state.revision||0)||page.hasMore&&page.next===(this.state.revision||0))throw fail('SHARED_DIRECTORY_INVALID');
   for(const change of page.changes){const {object}=await this.send(endpoint+'config?'+new URLSearchParams({sharedSpaceId:this.connection.sharedSpaceId,sharedId:change.id}));this.state.objects[object.id]=this.summary(object);}
   if(this.state.revision!==page.next||page.changes.length){this.state.revision=page.next;await this.save();}if(!page.hasMore)break;
  }
  await this.bindMissing();
 }
 async materialize(){
  if(!Object.values(this.state.objects).some(metadata=>this.needsMaterialization(metadata)))return;
  if(authorityControl.authorityFor(this))return authorityControl.withAuthority(authorityControl.authorityFor(this),'shared-materialize',()=>this.materializePrepared());
  return this.materializePrepared();
 }
 needsMaterialization(metadata){
  if(!kindOrder.includes(metadata.kind)||metadata.deleted||!this.isLocalVisible(metadata.id)||this.matching?.fenced(metadata.id))return false;
  const known=this.configs.state.objects[metadata.id];
  // A host projection fix can change output without a server version change.
  return !(known?.version===metadata.version&&!this.state.locals[metadata.id]?.seed&&stable(known.materialized||known.config)===stable(this.target({...metadata,config:known.config})));
 }
 async materializePrepared(){
  for(const kind of kindOrder)for(const metadata of Object.values(this.state.objects).filter(o=>o.kind===kind&&this.needsMaterialization(o))){
   const known=this.configs.state.objects[metadata.id];
   // A host projection fix can change native output without a new server
   // configuration version. Reuse the existing guarded projection intent;
   // receive() preserves conflicting local edits as drafts.
   const {object}=await this.send(endpoint+'config?'+new URLSearchParams({sharedSpaceId:this.connection.sharedSpaceId,sharedId:metadata.id}));
   this.state.objects[object.id]=this.summary(object);await this.save();
   if(this.state.locals[metadata.id].seed||metadata.kind==='rules'&&!known){await this.adoptRegisteredConfig(object);}
   else {const result=await this.configs.receive(object);if(result.applied)this.notifyDirectory(object);}
  }
 }
 mappings(){return Object.entries(this.state.locals).filter(([id,l])=>l.kind==='topic'&&!l.aliasOf&&this.state.objects[id]?.topic).map(([id,l])=>{const t=this.state.objects[id].topic;return {sharedId:id,adopted:l.adopted,local:{itemType:t.ownerType,itemId:l.localParent,topicId:l.localId},shared:{itemType:t.ownerType,itemId:t.ownerId,topicId:t.topicId}};});}
 legacyMappings(){return this.mappings().filter(mapping=>!this.coreSingle?.owns(mapping.shared));}
 async verifyHistory(mapping){
  const a=this.replica.adapter,rows=await a.queue.read(mapping.shared),seen=new Set();
  for(const raw of rows){const m=a.canonical(raw,mapping.shared.topicId),key=messageKey({...this.state.objects[mapping.sharedId].topic,msgId:m.id}),ack=a.state.acked[key];if(!ack||ack.deleted||ack.hash!==messageHash(m)||ack.metadataHash!==sha256(stable(fieldsFrom(m)))||raw.isPendingStream||raw.isThinking)throw fail('SHARED_LOCAL_HISTORY_CONFLICT');seen.add(key);}
  for(const [key,ack]of a.ackedEntriesForTopic(mapping.shared)){const [type,owner,topic]=JSON.parse(key);if(type===mapping.shared.itemType&&owner===mapping.shared.itemId&&topic===mapping.shared.topicId&&!ack.deleted&&!seen.has(key))throw fail('SHARED_LOCAL_HISTORY_CONFLICT');}
  return rows;
 }
 async backfill({verifyExisting=false,only=null}={}){
  const a=this.replica.adapter;
  for(const mapping of this.legacyMappings()){
   if(only&&mapping.sharedId!==only)continue;
   if(!this.isLocalVisible(mapping.sharedId))continue;
   let plan=this.state.baselines[mapping.sharedId];if(plan?.complete){if(verifyExisting)await this.verifyHistory(mapping);continue;}
   if(!plan){plan=this.state.baselines[mapping.sharedId]={planId:randomUUID(),after:0,count:0};await this.save();}
   if(!plan.remote){plan.remote=await this.send(endpoint+'baselines',{body:{sharedSpaceId:this.connection.sharedSpaceId,sharedId:mapping.sharedId,planId:plan.planId}});await this.save();}
   while(!plan.complete){
    const page=await this.send(endpoint+'baseline?'+new URLSearchParams({sharedSpaceId:this.connection.sharedSpaceId,sharedId:mapping.sharedId,baselineId:plan.remote.id,after:String(plan.after),limit:'100'}));
    if(page.id!==plan.remote.id||page.watermark!==plan.remote.watermark||page.total!==plan.remote.total||!Array.isArray(page.events)||page.events.length>100||!Number.isSafeInteger(page.next)||page.next<plan.after||page.hasMore&&page.next===plan.after)throw fail('SHARED_BASELINE_INVALID');
    let last=plan.after;for(const event of page.events){if(event.position<=last||event.position>page.next||event.seq>page.watermark||!a.sameTopic(event,mapping.shared))throw fail('SHARED_BASELINE_INVALID');last=event.position;await a.applyRemote(event,false,false,true);}
    plan.after=page.next;plan.count+=page.events.length;if(!page.hasMore){if(plan.count!==page.total)throw fail('SHARED_BASELINE_INVALID');plan.complete=true;}await this.save();
   }
   await this.verifyHistory(mapping);
  }
  if (a.state.cursor) return;
  const mappings = this.legacyMappings();
  if (!mappings.length || !mappings.every(m => this.state.baselines[m.sharedId]?.complete)) return;
  const watermark = mappings.reduce((min, m) => Math.min(min, this.state.baselines[m.sharedId].remote.watermark), Number.MAX_SAFE_INTEGER);
  // An empty baseline at cursor zero is already durable. Repeated background
  // ticks need no state transaction until there is a new baseline watermark.
  if (a.state.cursor === watermark) return;
  await a.transaction(next => { if (!next.cursor) next.cursor = watermark; });
 }
 // Directory/configuration/message state has one serial owner. Binary network
 // transfer runs outside it; its eventual native history write rejoins this owner.
 serialCore(fn){const next=(this.coreTail||Promise.resolve()).catch(()=>{}).then(fn);this.coreTail=next;return next;}
 async mutateAttachment(d,change,options){return this.serialCore(async()=>{
  this.assertSharedAccess();
  if(this.closed)throw fail('APPLICATION_SHUTTING_DOWN');
  const mapping=this.execution.mapping(d),owner=this.state.objects[mapping.sharedId]?.parentId;
  if(!this.isLocalVisible(mapping.sharedId))throw fail('SHARED_LOCAL_REMOVED');
  this.matching.assert([mapping.sharedId,owner]);
  return this.queue.mutate(d,change,options);
 });}
 startScheduler(){
  if(this.intervalMs<=0)return;
  this.nextAudit=Date.now()+auditMs-(parseInt(sha256(this.connection.deviceId).slice(0,8),16)%30000);
  this.configureWatch();
  this.adapter.onLocalWork=()=>this.scheduleTick('pull');
  this.adapter.onHistoryHint=()=>this.scheduleTick();
  if(this.attachments)this.attachments.work.onWake=()=>this.scheduleTick('attachments');
  this.scheduleTick();
 }
 assertSharedAccess(){
  if(this.backgroundDenied)throw permissionError();
 }
 async withSharedAccess(transport,query,options={}){
  this.assertSharedAccess();
  const access=this.accessController.signal;
  const signal=options.signal?AbortSignal.any([access,options.signal]):access;
  const result=await transport(query,{...options,signal});
  if(access.aborted)throw permissionError();
  return result;
 }
 denyShared(){
  if(this.backgroundDenied)return;
  this.backgroundDenied=true;this.capabilityInvalidated=true;
  this.error=permissionError().code;
  this.accessController.abort();
  this.waitClient.close();
  this.nativeTaskViews?.clear();
  this.execution?.groupHandoffObserved?.clear();
  this.sessions?.invalidateAccess();
  this.planTick();
 }
 configureWatch(){
  const features=this.capabilities.features||[];
  this.waitClient.configure(this.waitClient.openWatch&&features.includes('shared-watch-v1')?'watch':features.includes('shared-wait-v1'));
 }
 recoverableMessages(){
  const a=this.adapter;
  return Boolean(a?.degraded||a?.state.pending||a?.state.inbox.length||(!this.readOnly&&a?.state.outbox.some(op=>!op.status&&!a.outboundBlocked(op))));
 }
 recoverableDirectory(){
  return !this.readOnly&&(this.state.pending||this.capabilities.features?.includes('shared-merge-v1')&&this.matching?.needsPoll()||
   Object.values(this.state.localRemovals||{}).some(operation=>['pending','accepted','restoring'].includes(operation.stage))||
   this.legacyMappings().some(mapping=>this.isLocalVisible(mapping.sharedId)&&!this.state.baselines[mapping.sharedId]?.complete));
 }
 recoverableExecution(){
  return !this.readOnly&&(this.execution?.needsReconcile()||this.sessions?.needsReconcile());
 }
 planTick(){
  clearTimeout(this.timer);
  if(this.closed||!this.nextAudit||this.directoryPaused||this.running)return;
  // Legacy hosts retain their previous cadence. Watch hosts sleep until a
  // notification, an unfinished obligation's deadline, or the repair audit.
  const now=Date.now(),legacy=this.waitClient.mode!=='watch';
  const attachmentDue=this.attachments?.work.nextDueAt?.()??Infinity;
  const workDue=this.recoverableMessages()||this.recoverableDirectory()||this.recoverableExecution();
  let due=Math.min(this.nextAudit,attachmentDue,workDue?(this.nextRecovery||now):Infinity,legacy?(this.nextLegacy||now):Infinity);
  if(this.tickRequested)due=now;
  if(this.backgroundDenied)due=this.nextAudit;
  due=Math.max(this.retryTickAt||0,due);
  this.timer=setTimeout(()=>this.runTick(),Math.max(0,due-now));this.timer.unref?.();
 }
 scheduleTick(lane){
  if(this.closed||!this.nextAudit)return;
  if(lanes.includes(lane))this.waitClient.dirty.add(lane);
  if(lane==='attachments')this.attachmentsRequested=true;
  this.tickRequested=true;this.planTick();
 }
 runTick(){
  if(this.closed||this.running||this.directoryPaused)return;
  this.tickRequested=false;
  const now=Date.now(),audit=now>=this.nextAudit,legacy=this.waitClient.mode!=='watch';
  const attachmentRequested=this.attachmentsRequested||(this.attachments?.work.nextDueAt?.()??Infinity)<=Date.now();this.attachmentsRequested=false;
  if(audit)this.nextAudit=now+auditMs;
  this.nextLegacy=now+this.intervalMs;
  const recovery=now>=(this.nextRecovery||0);
  if(recovery)this.nextRecovery=now+recoveryDelay;
  this.running=Promise.resolve().then(async()=>{
   if(audit||this.capabilityInvalidated||(legacy&&now-(this.lastCapabilityCheck||0)>=5000)){
    await this.refreshCapabilities();
    if(this.backgroundDenied){
     const result=await this.proveMembership();
     if(!Array.isArray(result?.bindings))throw fail('SHARED_BINDINGS_INVALID');
     this.accessController=new AbortController();
     this.backgroundDenied=false;
    }
    this.capabilityInvalidated=false;
    this.configureWatch();
   }
   const hints=this.waitClient.take({audit});
   await this.tick({background:true,hints,forceLocal:audit,skipExecution:!legacy&&!audit&&!hints.has('pull')&&!(recovery&&this.recoverableExecution()),forceAttachments:attachmentRequested||audit||!legacy&&(hints.has('changes')||hints.has('matches'))});
   if(this.waitClient.mode==='watch'&&!this.closed){
    await this.serialCore(()=>this.replica.auditLocalHistories?.(audit,id=>
     this.isLocalVisible(id)&&!this.state.objects[id]?.deleted&&!this.matching.fenced(id)&&this.state.baselines[id]?.complete));
   }
   this.retryTickAt=0;this.tickFailures=0;
  }).catch(error=>{
   this.waitClient.all();
   this.error=error.code||'SHARED_SYNC_FAILED';
   if(membershipDenied(error)){
    this.denyShared();
   }else{
    this.retryTickAt=Date.now()+Math.min(30000,recoveryDelay*2**Math.min(this.tickFailures||0,5));
    this.tickFailures=(this.tickFailures||0)+1;
    // Watch reconnect already supplies an independent wake while disconnected.
    if(this.waitClient.mode!=='watch'||this.waitClient.online)this.tickRequested=true;
   }
  }).finally(()=>{this.running=null;this.planTick();});
 }
 async refreshCapabilities(){
  const next=await inspectShared(this.connection,this.legacy,this.send,{allowReadOnly:true});
  if(Boolean(this.state.coreSingle)!==next.spaces.some(space=>space.id===this.connection.sharedSpaceId&&space.coreSingle===true)){
   throw fail('CORE_AUTHORITY_CHANGED_RESTART_REQUIRED');
  }
  this.lastCapabilityCheck=Date.now();
  if(next.readOnly&&!this.readOnly){
   this.readOnly=true;
   this.nativeTaskViews?.clear();
   this.sessions?.invalidateAccess();
  }
  const changed=stable(next.features)!==stable(this.capabilities.features);
  this.capabilities=next;
  if(changed)this.notifyExecutionStatus?.({capabilities:{steeringEnabled:next.features?.includes('shared-steering-v1')===true}});
 }
 async tickCore({forceLocal=false,background=false,hints=null}={}){
  if(this.closed)return;
  await this.recoverRegistration();
  if(!hints||hints.has('matches')||this.matching.needsPoll())await this.matching.poll();
  await this.directoryState.recover();
  if(!hints||hints.has('changes'))await this.pollDirectory();
  await this.directoryState.tombstones();await this.materialize();
  const localScan=forceLocal||this.dirty||!this.lastLocalScan||(!background||this.waitClient.mode!=='watch')&&Date.now()-this.lastLocalScan>=5000;
  let scannedTopics;
  if(localScan){
   this.dirty=false;this.lastLocalScan=Date.now();
   scannedTopics=new Map();
   await this.discover(false,(kind,ownerId,topic)=>{
    scannedTopics.set(JSON.stringify([kind,ownerId,topic.id]),localTopicConfig(topic));
   });
  }
  for(const mapping of this.legacyMappings())if(!this.replica.adapter.isEnabled(mapping.shared))await this.replica.add(mapping);
  await this.backfill();
  for(const [id,known]of Object.entries(this.configs.state.objects)){
   if(this.configs.state.drafts[id])continue;
   if(!localScan)continue;
   const metadata=this.state.objects[id];if(!metadata||metadata.deleted||!this.isLocalVisible(id)||this.matching.fenced(id))continue;
   if(metadata.kind==='topic'){
    const owner=this.localFor(metadata.parentId),topic=this.localFor(id);
    const observed=scannedTopics.get(JSON.stringify([owner.kind,owner.localId,topic.localId]));
    // Only skip a matching observation from this scan. A difference must
    // still go through the normal fresh read before it can become a draft.
    if(observed&&stable(observed)===stable(known.materialized||known.config))continue;
   }
   const object={...metadata,config:known.config},current=await this.readLocal(object);
   if(current&&stable(current)!==stable(known.materialized||known.config))await this.configs.edit(id,known.kind,current);
  }
  if(!hints||hints.has('pull')||this.recoverableMessages())await this.replica.sync();
  else this.adapter.retryNotifications();
  this.error=null;
 }
 async tick({forceLocal=false,skipExecution=false,skipAttachments=false,background=false,hints=null,forceAttachments=false}={}){
  if(this.closed)return;
  this.assertSharedAccess();
  if(!background&&Date.now()-(this.lastCapabilityCheck||0)>=5000)await this.refreshCapabilities();
  if(this.readOnly){
   await this.serialCore(()=>require('./sharedReadonly').tick(this,{hints,forceAttachments,skipAttachments}));
   return;
  }
  await this.serialCore(()=>this.tickCore({forceLocal,background,hints}));if(this.closed)return;
  if(!skipAttachments && this.attachments && (forceAttachments||this.attachments.work.shouldRun())){
   const topics=this.mappings().filter(m=>this.isLocalVisible(m.sharedId)&&!this.matching?.fenced(m.sharedId))
       .map(m=>({...m.local,attachmentBinding:m.sharedId}));
   this.attachments.connection.topics=topics;
   await this.attachments.work.run(topics,{readOnly:this.readOnly});
   this.adapter.attachmentSkippedDetails=this.attachments.skippedDetails;
  }
  if(!skipExecution&&!this.closed){await this.execution?.reconcile();await this.sessions?.reconcile();}
 }
 get adapter(){return this.replica?.adapter||null;}
 async nativeTrajectory(scope,{limit=200}={}){this.assertSharedAccess();
  if(!this.capabilities.features?.includes('shared-execution-trace-v1'))return {records:[],total:0,truncated:false,initiatorOnly:true,unsupported:true};
  this.trajectoryCache||=new Map();
  const owned=Object.values(this.execution.state.requests).some(r=>r.serverSession&&!r.remote&&r.descriptor?.itemId===scope?.itemId&&r.descriptor?.topicId===scope?.topicId&&r.accepted?.id);
  if(!owned)return {records:[],total:0,truncated:false,initiatorOnly:true,missingHistoricalTraces:0};
  const mapping=this.execution.mapping(scope),records=[],missing=[],denied=[];let bytes=0,budgetLimited=false;
  const held=Object.values(this.execution.state.requests).filter(r=>r.serverSession&&!r.remote&&r.sharedId===mapping.sharedId&&r.accepted?.id);
  for(const request of held.sort((a,b)=>(b.accepted.userSeq||0)-(a.accepted.userSeq||0)).slice(0,100)){
   try{const cached=this.trajectoryCache.get(request.accepted.id),ttl=request.accepted.state==='completed'&&cached?.value.available?60000:1000;
    const page=cached&&Date.now()-cached.at<ttl?cached.value:await this.send(endpoint+'execution-trace?'+new URLSearchParams({sharedSpaceId:this.connection.sharedSpaceId,workId:request.accepted.id,limit:'100'}));
    if(!Array.isArray(page.records)||page.records.length>200||page.records.some(v=>typeof v.id!=='string'||v.source?.executionId!==request.accepted.id||v.source?.nativeRequestId!==v.requestId))throw fail('SHARED_TRACE_IDENTITY_MISMATCH');
    if(page!==cached?.value){this.trajectoryCache.set(request.accepted.id,{value:page,at:Date.now(),bytes:Buffer.byteLength(JSON.stringify(page))});while(this.trajectoryCache.size>16||[...this.trajectoryCache.values()].reduce((n,v)=>n+v.bytes,0)>16*1024*1024)this.trajectoryCache.delete(this.trajectoryCache.keys().next().value);}
    for(const record of [...page.records].reverse()){const size=Buffer.byteLength(JSON.stringify(record));if(bytes+size>4*1024*1024){budgetLimited=true;break;}bytes+=size;records.push(record);}if(!page.available)missing.push(request.accepted.id);
    if(budgetLimited)break;}
   catch(e){if(e.code==='TRACE_INITIATOR_REQUIRED'){denied.push(request.accepted.id);continue;}throw e;}
  }
  const unique=[...new Map(records.map(r=>[r.id,r])).values()].sort((a,b)=>a.startedAt-b.startedAt);
  return {records:unique.slice(-Math.min(200,Math.max(1,limit))),total:unique.length,truncated:budgetLimited||held.length>100||unique.length>limit,missingHistoricalTraces:missing.length,initiatorOnly:true};
 }
 async cancelNativeSession({descriptor,executionId,operationId}){this.assertSharedAccess();
  if(this.coreSingle?.owns(descriptor))return this.coreSingle.control(descriptor,executionId,'cancel',operationId);
  require('./contracts.generated.cjs').sharedIdentity(executionId);
  if(!this.capabilities.features?.includes('shared-session-cancel-v1'))throw fail('SHARED_SESSION_CONTROL_UPGRADE_REQUIRED');
  if(this.readOnly)throw fail('SHARED_READ_ONLY');
  const mapping=this.execution.mapping(descriptor),record=Object.values(this.execution.state.requests).find(r=>r.serverSession&&!r.remote&&r.sharedId===mapping.sharedId&&r.accepted?.id===executionId);
  if(!record)throw fail('SHARED_REQUEST_OWNER_REQUIRED');
  if(operationId!==undefined)require('./contracts.generated.cjs').sharedIdentity(operationId);
  record.cancelIntent||={sharedSpaceId:this.connection.sharedSpaceId,workId:executionId,opId:operationId||randomUUID()};await this.execution.save();
  const receipt=await this.send(endpoint+'session-cancel',{body:record.cancelIntent});
  await this.execution.refresh(record);return receipt;
 }
 nativeRulesContext(){const object=Object.values(this.state.objects).find(o=>o.kind==='rules'&&!o.deleted),known=object&&this.configs.state.objects[object.id];if(!known)throw fail('SHARED_CONFIG_BASE_REQUIRED');return {sharedId:object.id,version:known.version};}
 async saveNativeRules(store){this.assertSharedAccess();
  if(this.readOnly)throw fail('SHARED_READ_ONLY');
  const marker=store?.__nativeSyncSharedBase,base=this.nativeRulesContext();
  if(!marker||marker.sharedId!==base.sharedId||!Number.isSafeInteger(marker.version))throw fail('SHARED_CONFIG_BASE_REQUIRED');
  const {object:latest}=await this.send(endpoint+'config?'+new URLSearchParams({sharedSpaceId:this.connection.sharedSpaceId,sharedId:base.sharedId}));
  await this.configs.submit(base.sharedId,'rules',{...latest.config,tavernRules:this.host.projectRuleStore(store.rules)},{expectedVersion:marker.version,opId:store.__nativeSyncSharedOpId||'native_rules_'+sha256(stable({base:marker,rules:store.rules})).slice(0,40)});
  return {success:true,store:{version:3,rules:await this.host.readRules(),__nativeSyncSharedBase:this.nativeRulesContext()}};
 }
 saveNativeRuleOverride(owner,patch){this.assertSharedAccess();
  // Directory materialization holds History authority before entering the
  // config replica. Keep that tick out while the native save materializes.
  return this.serialCore(async()=>{
   const kind=owner?.type,id=owner?.id,object=this.nativeObject(kind,id);if(!object)throw fail('SHARED_LOCAL_MAPPING_REQUIRED');
   if(!patch?.__nativeSyncSharedBase||patch.__nativeSyncSharedBase.sharedId!==object.id||![true,false,null].includes(patch.value)||typeof patch.key!=='string')throw fail('SHARED_CONFIG_BASE_REQUIRED');
   const raw=await this.host.readNativeOwner(kind,id),rules={...(raw.conversationOverrides?.rules||{})};
   if(patch.value===null)delete rules[patch.key];else Object.defineProperty(rules,patch.key,{value:patch.value,enumerable:true,writable:true,configurable:true});
   return this.saveNativeConfigPrepared(kind,id,{...raw,conversationOverrides:{...raw.conversationOverrides,rules},__nativeSyncSharedBase:patch.__nativeSyncSharedBase});
  });
 }
 nativeDeletionContext(scope){this.assertSharedAccess();return require('./nativeOperations').deletionContext(this,scope);}
 removeNativeObject(scope,options,callbacks){this.assertSharedAccess();return require('./nativeOperations').remove(this,scope,options,callbacks);}
 renameNativeTopic(scope,name,options){this.assertSharedAccess();return require('./nativeOperations').renameTopic(this,scope,name,options);}
 saveNativeAvatar(kind,id,data){this.assertSharedAccess();return require('./nativeOperations').avatar(this,kind,id,data);}
 directoryEntries(){
  return Object.values(this.state.objects).filter(o=>!o.deleted&&!o.retired&&
   (o.kind!=='topic'||(this.state.objects[o.parentId]&&!this.state.objects[o.parentId].deleted&&!this.state.objects[o.parentId].retired)));
 }
 async sharedConfigContext(){this.assertSharedAccess();const owner=Object.values(this.state.objects).find(o=>['agent','group'].includes(o.kind)&&!o.deleted);return {enabled:this.ready&&!this.closed,topic:{sharedSpaceId:this.connection.sharedSpaceId,sharedOwnerId:owner?.id},context:{entryId:this.connection.spaceId,sessionMarker:'desktop:'+this.connection.deviceId}};}
 async sharedConfigRequest({route,body}){this.assertSharedAccess();
  if(this.closed||!this.ready)throw fail('SHARED_STARTUP_PENDING');
  if(this.readOnly&&body)throw fail('SHARED_READ_ONLY');
  const url=new URL('/'+route,'https://shared.invalid');if(!['/shared/match-preview','/shared/match-prepare','/shared/match-confirm','/shared/match-cancel','/shared/matches','/shared/matching-local','/shared/directory-view','/shared/match-state','/shared/directory','/shared/config','/shared/config-resolution','/shared/local-remove','/shared/local-restore'].includes(url.pathname))throw fail('SHARED_ROUTE_NOT_APPROVED');
  const space=body?body.sharedSpaceId:url.searchParams.get('sharedSpaceId');if(space!==this.connection.sharedSpaceId)throw fail('SHARED_SPACE_NOT_APPROVED');
  if(url.pathname==='/shared/directory-view'){
   if(body)throw fail('INVALID_SHARED_REQUEST');
   return {entries:this.directoryEntries().map(o=>({id:o.id,kind:o.kind,parentId:o.parentId,
    name:this.configs.state.objects[o.id]?.config?.name||o.name||o.id,
    conflict:this.configs.state.drafts[o.id]?.conflict===true,
    pending:!!this.configs.state.drafts[o.id]}))};
  }
  if(url.pathname==='/shared/matching-local')return {plans:Object.values(this.matching.state.plans).map(p=>this.matching.public(p))};
  if(url.pathname==='/shared/match-preview')return this.matching.preview(body);
  if(url.pathname==='/shared/match-prepare')return this.matching.prepare(body);
  if(url.pathname==='/shared/match-confirm')return this.matching.confirm(body);
  if(url.pathname==='/shared/match-cancel')return this.matching.cancel(body);
  if(body){
   if(body.sharedId&&['/shared/local-remove','/shared/local-restore'].includes(url.pathname))this.matching.assert([body.sharedId]);
   if(url.pathname==='/shared/local-remove')return require('./nativeOperations').serializeRemoval(this,()=>this.directoryState.remove(body));
   if(url.pathname==='/shared/local-restore')return this.directoryState.restore(body);
   // Materialization can acquire native History authority while holding the
   // config queue. A directory tick takes those locks in the opposite order,
   // so queue the complete editor mutation alongside the native config save.
   return this.serialCore(async()=>{
    if(this.closed||!this.ready||this.isStopping())throw fail('SHARED_STARTUP_PENDING');
    if(url.pathname==='/shared/config-resolution'){
     if(Object.keys(body).some(k=>!['sharedSpaceId','sharedId','choice'].includes(k)))throw fail('INVALID_SHARED_REQUEST');
     const {object}=await this.send(endpoint+'config?'+new URLSearchParams({sharedSpaceId:space,sharedId:body.sharedId}));if(!this.isLocalVisible(object.id))throw fail('SHARED_LOCAL_REMOVED');if(this.configs.state.drafts[object.id])await this.configs.resolve(object,body.choice);this.notifyDirectory(object,{discardDraft:body.choice==='server'});return {object};
    }
    if(url.pathname!=='/shared/config'||Object.keys(body).some(k=>!['sharedSpaceId','sharedId','opId','expectedVersion','config'].includes(k)))throw fail('INVALID_SHARED_REQUEST');
    this.matching.assert([body.sharedId]);
    const {object}=await this.send(endpoint+'config?'+new URLSearchParams({sharedSpaceId:space,sharedId:body.sharedId}));if(!this.isLocalVisible(object.id))throw fail('SHARED_LOCAL_REMOVED');await this.configs.submit(object.id,object.kind,body.config,body);
    const result=await this.send(endpoint+'config?'+new URLSearchParams({sharedSpaceId:space,sharedId:object.id}));this.state.objects[result.object.id]=this.summary(result.object);await this.save();this.notifyDirectory(result.object);return result;
   });
  }
  const result=await this.send('/api/v1/sync'+url.pathname+url.search);
  if(url.pathname==='/shared/config'&&result.object){const draft=this.configs.state.drafts[result.object.id];if(draft)result.localDraft=structuredClone(draft);result.localAvailable=this.isLocalVisible(result.object.id);result.readOnly=this.readOnly||result.readOnly===true;}
  if(url.pathname==='/shared/directory')for(const o of result.objects)o.localAvailable=this.isLocalVisible(o.id);
  return result;
 }
 isLocalVisible(id){return this.directoryState?this.directoryState.visible(id):true;}
 isLocalTopicVisible(kind,ownerId,topicId){const match=Object.entries(this.state.locals).find(([,l])=>l.kind==='topic'&&l.localParent===ownerId&&l.localId===topicId);return !match||this.isLocalVisible(match[0]);}
 assertNativeMutation(kind,localId,topicId){this.assertSharedAccess();if(this.readOnly)throw fail('SHARED_READ_ONLY');const owner=this.nativeObject(kind,localId);if(!owner)return;if(owner.retired||owner.deleted)throw fail('SHARED_OBJECT_MERGED');const topic=topicId&&Object.entries(this.state.locals).find(([,l])=>l.kind==='topic'&&!l.aliasOf&&l.localParent===localId&&l.localId===topicId);this.matching.assert([owner.id,topic?.[0]]);}
 nativeObject(kind,localId){const all=Object.entries(this.state.locals).filter(([,l])=>l.kind===kind&&l.localId===localId),entry=all.find(([id,l])=>!l.aliasOf&&!this.state.objects[id]?.deleted);if(entry)return this.state.objects[entry[0]];const retired=this.state.retiredOwners?.[kind+':'+localId];return retired?{...this.state.objects[retired],retired:true}:all[0]?this.state.objects[all[0][0]]:null;}
 isLocalOwnerVisible(kind,id){const object=this.nativeObject(kind,id);return !object||!object.retired&&this.isLocalVisible(object.id);}
 decorateNativeConfig(kind,localId,value){if(!value||value.error)return value;const object=this.nativeObject(kind,localId),known=object&&this.configs?.state.objects[object.id];return known?{...value,...(value.topics?{topics:value.topics.filter(t=>this.isLocalTopicVisible(kind,localId,t.id))}:{}),__nativeSyncSharedBase:{sharedId:object.id,version:known.version}}:value;}
 saveNativeConfig(kind,localId,raw){this.assertSharedAccess();
  // A directory tick can materialize a group while holding History authority.
  // Serialize group saves with that tick before entering the config replica queue.
  const save=()=>this.saveNativeConfigPrepared(kind,localId,raw);
  return kind==='group'?this.serialCore(save):save();
 }
 async saveNativeConfigPrepared(kind,localId,raw){
  if(this.readOnly)throw fail('SHARED_READ_ONLY');
  const object=this.nativeObject(kind,localId);if(!object)return null;if(object.retired)throw fail('SHARED_OBJECT_MERGED');this.matching.assert([object.id]);if(!this.isLocalVisible(object.id))throw fail('SHARED_LOCAL_REMOVED');const marker=raw.__nativeSyncSharedBase;
  if(!marker||marker.sharedId!==object.id||!Number.isSafeInteger(marker.version))throw fail('SHARED_CONFIG_BASE_REQUIRED');
  const accepted=this.configs.state.objects[object.id],{object:latest}=await this.send(endpoint+'config?'+new URLSearchParams({sharedSpaceId:this.connection.sharedSpaceId,sharedId:object.id})),value=projectNativeConfig(this,kind,raw,latest.config);
  if(!raw.__nativeSyncSharedOpId&&marker.version===latest.version&&marker.version===accepted.version&&stable(value)===stable(accepted.materialized||accepted.config)){await this.configs.serial(()=>this.host.writeNativeExtras(kind,localId,raw));return {success:true,sharedVersion:accepted.version,model:accepted.config.model};}
  try{await this.configs.submit(object.id,kind,value,{expectedVersion:marker.version,opId:raw.__nativeSyncSharedOpId||'native_'+sha256(stable({id:object.id,version:marker.version,value})).slice(0,40)});}
  catch(error){throw error;}
  await this.configs.serial(()=>this.host.writeNativeExtras(kind,localId,raw));this.notifyDirectory(this.state.objects[object.id]);return {success:true,sharedVersion:this.configs.state.objects[object.id].version,model:this.configs.state.objects[object.id].config.model};
 }
 async syncExecutionTopic(mapping,{minSeq=0}={}){
  if(!this.state.baselines[mapping.sharedId]?.complete)await this.backfill({only:mapping.sharedId});
  if(!this.capabilities.features?.includes('shared-topic-history-v1')){await this.replica.sync();await this.verifyHistory(mapping);return {legacy:true};}
  const result=await this.replica.syncTopic(mapping,{after:this.state.baselines[mapping.sharedId]?.remote?.watermark||0,minSeq});await this.verifyHistory(mapping);return result;
 }
 async refreshForExecution(d,{forceFresh=false,sharedSessionHistory=false}={}){this.assertSharedAccess();
  if(this.closed||!this.ready)throw fail('SHARED_STARTUP_PENDING');
  if(!this.capabilities.features?.includes('shared-topic-history-v1')){await this.serialCore(()=>this.tickCore({forceLocal:true}));const mapping=this.execution.mapping(d),context=await this.send(endpoint+'context?'+new URLSearchParams({sharedSpaceId:this.connection.sharedSpaceId,sharedId:mapping.sharedId}),{sharedSessionHistory});return {...context,model:this.configs.state.objects[this.state.objects[mapping.sharedId].parentId]?.config.model,legacy:true};}
  const mapping=this.execution.mapping(d);this.matching.assert([mapping.sharedId,this.state.objects[mapping.sharedId].parentId]);
  const snapshot=this.execution.state.executionSnapshots?.[mapping.sharedId],adapter=this.adapter;
  if(this.optimisticEnabled&&!forceFresh&&!sharedSessionHistory&&(d.itemType||'agent')==='agent'&&this.capabilities.features?.includes('shared-inline-receipts-v1')&&snapshot&&Array.isArray(snapshot.dependencies)&&this.state.baselines[mapping.sharedId]?.complete){
   for(const dependency of snapshot.dependencies){const metadata=this.state.objects[dependency.id];if(!metadata)continue;if(this.matching.fenced(dependency.id))throw fail('SHARED_MATCH_PREPARING');await this.configs.scanNative(metadata);if(require('./sharedExecution').blocksExecution(this,dependency.id))throw fail('SHARED_CONFIG_CONFLICT');}
   const history=await this.replica.queue.read(mapping.shared);
   if(this.replica.queue.revision(history)===snapshot.localRevision&&!adapter.state.outbox.some(e=>adapter.sameTopic(e,mapping.shared))&&!adapter.state.inbox.some(e=>adapter.sameTopic(e.event,mapping.shared))&&!(adapter.state.pending&&adapter.sameTopic(adapter.state.pending.event,mapping.shared))){
    const executionHistory=await this.verifyHistory(mapping);return {head:snapshot.head,hash:snapshot.hash,model:snapshot.model,dependencies:snapshot.dependencies,optimistic:true,executionHistory};
   }
  }
  const context=await this.send(endpoint+'context?'+new URLSearchParams({sharedSpaceId:this.connection.sharedSpaceId,sharedId:mapping.sharedId}),{sharedSessionHistory});
  if(!Array.isArray(context.dependencies))throw fail('SHARED_TOPIC_HISTORY_UPGRADE_REQUIRED');
  // Detect native edits only in configurations used by this send. Admission
  // independently freezes and checks the server hash, including newly added rules.
  for(const dependency of context.dependencies){
   const known=this.configs.state.objects[dependency.id],metadata=this.state.objects[dependency.id];
   if(!known||!metadata)continue;
   if(this.matching.fenced(dependency.id))throw fail('SHARED_MATCH_PREPARING');
   await this.configs.scanNative(metadata);
   if(require('./sharedExecution').blocksExecution(this,dependency.id))throw fail('SHARED_CONFIG_CONFLICT');
  }
  const projection=await this.syncExecutionTopic(mapping,{minSeq:context.head});
  if(sharedSessionHistory&&context.desktopHistoryRequired!==undefined){
   // A baseline can cover Journal entries from other topics. Its cursor may
   // legitimately exceed the last mutation of this particular topic.
   if(projection.topicHeadSeq!==undefined){
    if(projection.topicHeadSeq!==context.head)throw fail('SHARED_CONTEXT_CHANGED');
   }else if(projection.head!==context.head){
    // Older servers report only the coverage cursor. Recheck the authority
    // snapshot before using the context; admission still enforces its CAS.
    const latest=await this.send(endpoint+'context?'+new URLSearchParams({sharedSpaceId:this.connection.sharedSpaceId,sharedId:mapping.sharedId}),{sharedSessionHistory:true});
    if(latest.head!==context.head||latest.hash!==context.hash||latest.desktopHistoryRequired!==context.desktopHistoryRequired||latest.desktopConfigRequired!==context.desktopConfigRequired)throw fail('SHARED_CONTEXT_CHANGED');
   }
  }
  const executionHistory=await this.verifyHistory(mapping);return {...context,executionHistory};
 }

 async executionMapping(d){
  try{return this.execution.mapping(d);}catch(error){if(error.code!=='SHARED_LOCAL_MAPPING_REQUIRED')throw error;}
  if(this.closed||!this.ready)throw fail('SHARED_STARTUP_PENDING');if(this.directoryPaused)throw fail('SHARED_DIRECTORY_PENDING');
  const kind=d.itemType||'agent',owner=this.nativeObject(kind,d.itemId);if(!owner||owner.retired||owner.deleted||!this.isLocalVisible(owner.id))throw fail('SHARED_LOCAL_MAPPING_PENDING');this.matching.assert([owner.id]);
  if(!this.host.readTopic)throw fail('SHARED_NATIVE_TOPIC_AUTHORITY_REQUIRED');const config=await this.host.readTopic(kind,d.itemId,d.topicId);if(!config)throw fail('SHARED_LOCAL_TOPIC_NOT_FOUND');
  await require('./sourceDirectory').assertHistoryPath(this.root,this.queue.getHistoryPath(d.itemId,d.topicId));const rows=await this.queue.read(d);if(rows.length)throw fail('SHARED_UNREGISTERED_HISTORY');
  const object=await this.register('objects',{opId:this.op('topic:'+kind+':'+d.itemId+':'+d.topicId),kind:'topic',localId:d.topicId,localParent:d.itemId,parentId:owner.id,config});await this.adoptRegisteredConfig(object);
  const mapping=this.mappings().find(m=>m.sharedId===object.id);if(!mapping)throw fail('SHARED_LOCAL_MAPPING_REQUIRED');if(!this.coreSingle?.owns(d)){await this.replica.add(mapping);await this.backfill({only:object.id});}return this.execution.mapping(d);
 }

 async submitSharedSteering({descriptor,message,observedWorkId,...options}){this.assertSharedAccess();
 if(this.coreSingle?.owns(descriptor)){
  if(!observedWorkId||message?.attachments?.length)throw fail('CORE_STEERING_TEXT_REQUIRED');
  return {...await this.coreSingle.steer(descriptor,observedWorkId,message.content,message.id),handled:true,success:true,inputAccepted:true};
 }
if(this.closed||!this.ready)throw fail('APPLICATION_SHUTTING_DOWN');let record;
 if(options.parentInputId){const input=this.execution.state.requests[message.id],parent=this.execution.state.requests[options.parentInputId];if(!input||input.parentLocalInputId!==options.parentInputId||stable(input.descriptor)!==stable(descriptor))throw fail('SHARED_LOCAL_INTENT_CHANGED');
  if(!parent?.accepted){input.phase='waiting_parent';await this.execution.save();return {handled:true,success:true,pendingParent:true,inputId:message.id,localState:'saved'};}record=parent;
 }else record=await this.execution.steering.active(descriptor,observedWorkId);if(!record)throw fail('STEERING_NO_ACTIVE_WORK');if(!record.steeringV1)throw fail('SHARED_STEERING_TARGET_UNSUPPORTED');return this.execution.steering.submit(record,descriptor,message,options);}
 async recoverSharedCompactionPrepare(intent){
  const receipt=await this.send(endpoint+'compact-prepare',{body:intent.body});
  if(typeof receipt?.id!=='string'||receipt.messageId!=='checkpoint_'+receipt.id||!/^[a-f0-9]{64}$/.test(receipt.sourceHash||''))throw fail('SHARED_COMPACTION_RESPONSE_INVALID');
  this.execution.state.compactionPreparations||={};const prepared={descriptor:{...intent.descriptor},sharedId:intent.body.sharedId,sourceHash:receipt.sourceHash,messageId:receipt.messageId,workId:receipt.workId};
  const old=this.execution.state.compactionPreparations[receipt.id];if(old&&stable({...old,cancelled:undefined})!==stable(prepared))throw fail('SHARED_CHECKPOINT_SCOPE_CHANGED');
  // Reserve the receipt before publishing it to the recovery loop as a preparation.
  if(this.activeCompactionPrepares.has(intent.body.opId))this.activeCompactions.add(receipt.id);
  this.execution.state.compactionPreparations[receipt.id]=old||prepared;intent.receipt=receipt;intent.phase='prepared';await this.execution.save();return receipt;
 }
 async recoverSharedCompactionPrepares(){
  for(const intent of Object.values(this.execution.state.compactionPrepareRequests||{}))if(intent.phase==='preparing'&&!this.activeCompactionPrepares.has(intent.body.opId)){
   try{const receipt=await this.recoverSharedCompactionPrepare(intent);await this.cancelSharedCompaction({descriptor:intent.descriptor,id:receipt.id,closing:this.closed});intent.phase='cancelled';await this.execution.save();}
   catch(error){if(['SHARED_COMPACTION_SOURCE_CHANGED','WORK_SAFE_BOUNDARY_PENDING','SHARED_STEERING_UNAVAILABLE','WORK_EXECUTOR_HANDOFF_REQUIRED'].includes(error.code)){intent.phase='rejected';intent.errorCode=error.code;await this.execution.save();}else throw error;}
  }
  for(const [id,prepared]of Object.entries(this.execution.state.compactionPreparations||{}))if(!prepared.cancelled&&!this.activeCompactions.has(id)&&!this.execution.state.compactions?.[id]?.body)await this.cancelSharedCompaction({descriptor:prepared.descriptor,id,closing:this.closed});
 }
 async prepareSharedCompaction({descriptor,retryId}){this.assertSharedAccess();if(this.coreSingle?.owns(descriptor))return this.coreSingle.prepareCompaction(descriptor,retryId);
  if(this.closed||!this.ready)throw fail('APPLICATION_SHUTTING_DOWN');const mapping=this.execution.mapping(descriptor);if(!this.capabilities.features?.includes('shared-compaction-v1'))throw fail('SHARED_COMPACTION_UPGRADE_REQUIRED');const context=await this.refreshForExecution(descriptor,{forceFresh:true});if(this.closed)throw fail('APPLICATION_SHUTTING_DOWN');
  const publications=this.execution.state.compactions||{};
  if(retryId!==undefined){
   const preparations=this.execution.state.compactionPreparations||{};
   const prior=Object.hasOwn(preparations,retryId)&&preparations[retryId];
   if(!prior||prior.sharedId!==mapping.sharedId||stable(prior.descriptor)!==stable(descriptor))throw fail('SHARED_CHECKPOINT_SCOPE_CHANGED');
   const original=publications[retryId];
   if(original&&original.phase!=='blocked')return this.confirmSharedCompaction(original,true);
   if(!original&&!prior.cancelled)throw fail('SHARED_CHECKPOINT_PUBLICATION_PENDING');
  }
  const pending=Object.values(publications).find(intent=>{
   if(stable(intent.descriptor)!==stable(descriptor)||intent.phase==='blocked')return false;
   if(intent.awaitingConfirmation||intent.phase==='publishing')return true;
   // Older desktops cancelled after a failed readback, even when the original commit had landed.
   const preparation=this.execution.state.compactionPreparations?.[intent.body.id];
   return intent.awaitingConfirmation===undefined&&preparation?.cancelled&&intent.phase==='completed'&&intent.receipt?.seq===context.head;
  });
  if(pending)return this.confirmSharedCompaction(pending,true);
  const opId='compact_prepare_'+randomUUID(),intent={descriptor:{...descriptor},body:{sharedSpaceId:this.connection.sharedSpaceId,sharedId:mapping.sharedId,opId,expectedHead:context.head},phase:'preparing'};this.execution.state.compactionPrepareRequests||={};this.execution.state.compactionPrepareRequests[opId]=intent;this.activeCompactionPrepares.add(opId);
  try{
   await this.execution.save();if(this.closed)throw fail('APPLICATION_SHUTTING_DOWN');const receipt=await this.recoverSharedCompactionPrepare(intent);if(this.closed){await this.cancelSharedCompaction({descriptor,id:receipt.id,closing:true});throw fail('APPLICATION_SHUTTING_DOWN');}
   const result=await this.send(endpoint+'compact-input?'+new URLSearchParams({sharedSpaceId:this.connection.sharedSpaceId,id:receipt.id}));if(result?.id!==receipt.id||result.messageId!==receipt.messageId||result.sourceHash!==receipt.sourceHash||!Array.isArray(result.history))throw fail('SHARED_COMPACTION_RESPONSE_INVALID');
   return {handled:true,success:true,...result};
  }catch(error){if(intent.receipt)this.activeCompactions.delete(intent.receipt.id);throw error;}finally{this.activeCompactionPrepares.delete(opId);}
 }

 async cancelSharedCompaction({descriptor,id,closing=false}){this.assertSharedAccess();if(this.coreSingle?.owns(descriptor))return this.coreSingle.cancelCompaction(descriptor,id);if(this.closed&&!closing)throw fail('APPLICATION_SHUTTING_DOWN');
  const prepared=this.execution.state.compactionPreparations?.[id];if(!prepared||stable(prepared.descriptor)!==stable(descriptor))throw fail('SHARED_CHECKPOINT_SCOPE_CHANGED');
  const intent=this.execution.state.compactions?.[id];if(intent&&['publishing','completed'].includes(intent.phase)){await this.execution.run('compaction:'+id,()=>this.finishSharedCompaction(intent));return {success:true,alreadyCommitted:true};}
  const result=await this.send(endpoint+'compact-cancel',{body:{sharedSpaceId:this.connection.sharedSpaceId,id,opId:'compact_cancel_'+id}});prepared.cancelled=true;this.activeCompactions.delete(id);await this.execution.save();if(result.alreadyCommitted)await this.syncExecutionTopic(this.execution.mapping(descriptor),{minSeq:result.seq});return result;
 }
 async finishSharedCompaction(intent){
  if(intent.phase==='completed')return;const mapping=this.execution.mapping(intent.descriptor);
  try{intent.receipt=await this.send(endpoint+'compact-commit',{body:intent.body});}catch(error){if(!['NETWORK_UNAVAILABLE','SYNC_HTTP_ERROR'].includes(error.code)){intent.phase='blocked';intent.errorCode=error.code;}await this.execution.save();throw error;}
  if(intent.receipt?.success!==true||intent.receipt.messageId!==intent.body.message.id||
   !Number.isSafeInteger(intent.receipt.seq)||intent.receipt.seq<1)throw fail('SHARED_COMPACTION_RESPONSE_INVALID');
  await this.syncExecutionTopic(mapping,{minSeq:intent.receipt.seq});intent.phase='completed';this.activeCompactions.delete(intent.body.id);delete intent.errorCode;await this.execution.save();
 }
 async confirmSharedCompaction(intent,recovered=false){
  const {body,descriptor}=intent,mapping=this.execution.mapping(descriptor);
  const preparation=this.execution.state.compactionPreparations?.[body.id];
  if(body.sharedSpaceId!==this.connection.sharedSpaceId||!preparation||
   preparation?.sourceHash!==body.sourceHash||preparation.messageId!==body.message.id||
   preparation.sharedId!==mapping.sharedId||stable(preparation.descriptor)!==stable(descriptor))throw fail('SHARED_CHECKPOINT_SCOPE_CHANGED');
  return this.execution.run('compaction:'+body.id,async()=>{
   await this.finishSharedCompaction(intent);
   const history=await this.replica.queue.read(mapping.shared),message=history.find(row=>row.id===body.message.id);
   if(intent.receipt?.success!==true||!Number.isSafeInteger(intent.receipt.seq)||intent.receipt.seq<1||
    intent.receipt.messageId!==body.message.id||!message||messageHash(message)!==messageHash(body.message)||
    stable(fieldsFrom(message))!==stable(fieldsFrom(body.message)))throw fail('SHARED_CHECKPOINT_PROJECTION_CONFLICT');
   intent.awaitingConfirmation=false;
   try{await this.execution.save();}catch(error){intent.awaitingConfirmation=true;throw error;}
   return {handled:true,success:true,recovered,id:body.id,messageId:message.id,message,history};
  });
 }
 async commitSharedCompaction({descriptor,id,sourceHash,message}){this.assertSharedAccess();if(this.coreSingle?.owns(descriptor))return this.coreSingle.commitCompaction(descriptor,{id,sourceHash,message});
  if(this.closed||!this.ready)throw fail('APPLICATION_SHUTTING_DOWN');const mapping=this.execution.mapping(descriptor),body={sharedSpaceId:this.connection.sharedSpaceId,id,sourceHash,opId:'compact_commit_'+id,message:this.adapter.canonical(message,mapping.shared.topicId)};
  const preparation=this.execution.state.compactionPreparations?.[id];if(!preparation||stable(preparation.descriptor)!==stable(descriptor)||preparation.sharedId!==mapping.sharedId||preparation.sourceHash!==sourceHash||preparation.messageId!==message.id)throw fail('SHARED_CHECKPOINT_SCOPE_CHANGED');
  this.execution.state.compactions||={};let intent=this.execution.state.compactions[id];if(intent&&(stable(intent.body)!==stable(body)||stable(intent.descriptor)!==stable(descriptor)))throw fail('SHARED_CHECKPOINT_INTENT_CHANGED');
  if(!intent){intent=this.execution.state.compactions[id]={descriptor:{...descriptor},body,phase:'publishing',awaitingConfirmation:true};await this.execution.save();}
  return this.confirmSharedCompaction(intent);
 }

 async handoffSharedWork({descriptor,workId}){this.assertSharedAccess();if(this.closed||!this.ready)throw fail('APPLICATION_SHUTTING_DOWN');return this.execution.steering.handoff(descriptor,workId);}
 async noteSharedSendFailure({descriptor,requestId,code,message}){this.assertSharedAccess();
  const found=this.execution.steering.find(requestId)||(()=>{const record=Object.values(this.execution.state.requests).find(v=>v.accepted&&'reply_'+v.accepted.id===requestId);return record?{record,step:record}:null;})();if(!found)return {handled:false};
  const {record,step}=found,mapping=this.execution.mapping(descriptor);if(mapping.sharedId!==record.sharedId)throw fail('SHARED_REQUEST_NOT_FOUND');step.errorCode=/^[A-Z][A-Z0-9_]{0,79}$/.test(code||'')?code:'REQUEST_FAILED';
  let known;try{known=await this.execution.refresh(record);}catch{record.phase='review_required';if(message?.id===requestId&&message.role==='assistant'&&typeof message.content==='string'){step.localFailure=this.adapter.canonical(message,mapping.shared.topicId);step.failureDisposition='unknown';}await this.execution.save();return {handled:true,classification:'unknown'};}
  const native=known?.nativeRequests?.find(v=>v.id===requestId),control=known?.steering;
  let classification=native?.state==='model_terminal'?'terminal':native?.state==='prepared'||!native?'not_started':'unknown';
  if(control&&control.revision>(step.consumedInputSeq||0)&&native?.state!=='unknown')classification='steering';
  if(classification==='not_started'){step.phase='not_started';record.phase='accepted';}else if(classification==='unknown')record.phase='review_required';
  if(message&&['not_started','unknown'].includes(classification)){if(message.id!==requestId||message.role!=='assistant'||typeof message.content!=='string')throw fail('INVALID_SHARED_REPLY');step.localFailure=this.adapter.canonical(message,mapping.shared.topicId);step.failureDisposition=classification;}
  await this.execution.save();return {handled:true,classification};
 }
 async confirmSharedModelSave({itemId,reference}){this.assertSharedAccess();
  if(this.closed||!this.ready)throw fail('APPLICATION_SHUTTING_DOWN');const object=this.nativeObject('agent',itemId);if(!object||!reference?.opId||!reference.model)throw fail('MODEL_SAVE_REFERENCE_CHANGED');
  const draft=this.configs.state.drafts[object.id];let opId;
  if(draft){if(draft.config.model!==reference.model||draft.opId!==reference.opId&&!draft.opId.startsWith('model_confirm_'))throw fail('SHARED_CONFIG_PENDING_CONFIRMATION');opId=draft.opId;await this.configs.publish(object.id);}
  const current=(await this.send(endpoint+'config?'+new URLSearchParams({sharedSpaceId:this.connection.sharedSpaceId,sharedId:object.id}))).object;
  if(current.config.model!==reference.model)throw fail('MODEL_SAVE_NOT_CURRENT');
  if(!opId){opId='model_confirm_'+randomUUID();await this.configs.submit(object.id,'agent',current.config,{expectedVersion:current.version,opId});}
  return {success:true,reference:{opId,model:reference.model}};
 }
 async retrySharedInput({descriptor,inputId,modelSaveResolutionRef}){this.assertSharedAccess();
  if(this.closed||!this.ready)throw fail('APPLICATION_SHUTTING_DOWN');const input=this.execution.state.requests[inputId];if(!input||stable(input.descriptor)!==stable(descriptor)||!input.localMessage)throw fail('SHARED_INPUT_NOT_FOUND');
  if(modelSaveResolutionRef){const original=input.modelSaveRef||input.steeringBody?.modelSaveRef;if(!original||modelSaveResolutionRef.model!==original.model)throw fail('MODEL_SAVE_REFERENCE_CHANGED');input.modelSaveResolutionRef=modelSaveResolutionRef;input.dependencyReady=true;await this.execution.save();}
  if(input.isSteeringInput){if(!input.inputReceipt)await this.submitSharedSteering({descriptor,message:input.localMessage,observedWorkId:input.workId,modelSaveRef:input.steeringBody.modelSaveRef,deferReady:true});await this.execution.steering.finishInput(input);return {success:true,inputAccepted:true,inputId};}
  if(input.targetFinished){const active=await this.execution.steering.active(descriptor);if(active)throw fail('STEERING_TARGET_CHANGED');input.previousParentInputId=input.parentLocalInputId;delete input.parentLocalInputId;await this.execution.save();return this.prepareSharedSend({descriptor,message:input.localMessage,...(input.body?.controlMode?{controlMode:input.body.controlMode, ...(input.body.delegation&&{delegation:input.body.delegation})}:{}),requireIdle:true,...(input.modelSaveRef?{modelSaveRef:input.modelSaveRef}:{}),...(input.modelSaveResolutionRef?{modelSaveResolutionRef:input.modelSaveResolutionRef}:{})});}
  if(input.parentLocalInputId)return this.submitSharedSteering({descriptor,message:input.localMessage,parentInputId:input.parentLocalInputId,modelSaveRef:input.modelSaveRef,deferReady:Boolean(input.modelSaveRef&&!input.dependencyReady)});
  if(input.rejected&&!input.accepted){input.phase='local_pending';if(!input.serverSession){delete input.sharedId;delete input.signature;}await this.execution.save();}
  const serverSession=!input.admitStarted&&this.execution.state.localInputs[inputId]?.serverSessionPreferred===true;
  return this.prepareSharedSend({descriptor,message:input.localMessage,serverSession,...(input.body?.controlMode?{controlMode:input.body.controlMode, ...(input.body.delegation&&{delegation:input.body.delegation})}:{}),...(input.modelSaveRef?{modelSaveRef:input.modelSaveRef}:{}),...(input.modelSaveResolutionRef?{modelSaveResolutionRef:input.modelSaveResolutionRef}:{})});
 }
 async readySharedInput({inputId,modelSaveRef}){this.assertSharedAccess();const input=this.execution.state.requests[inputId];if(!input)throw fail('SHARED_INPUT_NOT_FOUND');if(stable(input.modelSaveRef||input.steeringBody?.modelSaveRef||null)!==stable(modelSaveRef||null))throw fail('MODEL_SAVE_REFERENCE_CHANGED');input.dependencyReady=true;await this.execution.save();if(!input.isSteeringInput)return {success:true,pendingParent:true};return {success:true,...await this.execution.steering.finishInput(input)};}

 async prepareSharedContinuation({descriptor,...options}){this.assertSharedAccess();if(this.coreSingle?.owns(descriptor))throw fail('CORE_CONTINUATION_NOT_MIGRATED');if(this.closed||!this.ready)throw fail('APPLICATION_SHUTTING_DOWN');
  const record=Object.values(this.execution.state.requests).find(value=>value.accepted?.id===options.workId&&!value.isSteeringInput),control=record&&await this.execution.steering.query(record);
  const mode=record?.accepted?.turn?.controlMode;
  if(['text-only-v1','safe-tools-v1','agent-assistant-v1'].includes(mode)&&control?.generation===0&&control.revision===0&&control.executor==='desktop:'+this.connection.deviceId&&control.generations?.[0]?.state==='prepared'&&record.localMessage)return this.execution.prepare(descriptor,record.localMessage,{controlMode:mode,...(record.body.delegation&&{delegation:record.body.delegation})});
  return this.execution.steering.prepare(descriptor,options);
 }
 async stageLocalSharedInput({descriptor,message,...options}){this.assertSharedAccess();if(this.coreSingle?.owns(descriptor))throw fail('CORE_STEERING_NOT_MIGRATED');if(this.closed)throw fail('APPLICATION_SHUTTING_DOWN');return this.execution.stageLocal(descriptor,message,options);}
 async prepareSharedSend({descriptor,message,localOnly=false,serverSession=false,...options}){
  this.assertSharedAccess();
  if(this.coreSingle?.owns(descriptor)){
   if(localOnly)return {handled:false};
   if(!serverSession||options.controlMode||message.desktopReferences?.length)throw fail('CORE_COMMAND_NOT_MIGRATED');
   return this.coreSingle.send(descriptor,message);
  }
  if(options.controlMode!==undefined){
   const tools=options.controlMode==='safe-tools-v1',aa=options.controlMode==='agent-assistant-v1';
   if(!tools&&!aa&&options.controlMode!=='text-only-v1')throw fail('CONTROLLED_MODE_UNSUPPORTED');
   if(!this.capabilities.features?.includes(aa?'shared-controlled-aa-v1':tools?'shared-controlled-tools-v1':'shared-controlled-text-v1'))throw fail(aa?'CONTROLLED_AA_UNAVAILABLE':tools?'CONTROLLED_TOOLS_UNAVAILABLE':'CONTROLLED_TEXT_UNAVAILABLE');
   const existing=this.execution.state.requests[message?.id];
   if(serverSession||existing&&existing.body?.controlMode!==options.controlMode)throw fail('CONTROLLED_MODE_IMMUTABLE');
  }
  if(localOnly)return this.execution.stageLocal(descriptor,message,options);
  try{return await this.admitSharedSend(descriptor,message,serverSession,options);}
  catch(error){
   if(!this.readOnly&&message?.id&&this.execution.state.localInputs[message.id]){
    // Diagnostic metadata must never mask the original admission outcome.
    await this.execution.rememberInputFailure(descriptor,message,error?.code,serverSession).catch(()=>{});
   }
   throw error;
  }
 }
 async admitSharedSend(descriptor,message,serverSession,options){
  if(this.readOnly)throw fail('SHARED_READ_ONLY');
  const mapping=await this.executionMapping(descriptor);
  this.matching.assert([mapping.sharedId,this.state.objects[mapping.sharedId].parentId]);
  if(this.closed||!this.ready)throw fail('APPLICATION_SHUTTING_DOWN');
  if(!options.controlMode&&(serverSession||this.execution.state.requests[message?.id]?.serverSession)&&this.sessions?.enabled()){
   const accepted=await this.sessions.prepare(descriptor,message,options);
   if(accepted)return accepted;
  }
  try{return await this.execution.prepare(descriptor,message,options);}
  catch(error){
   if(error.code!=='SHARED_CONTEXT_CHANGED'||error.status!==409||!error.knownAdmissionRejected)throw error;
   return this.execution.prepare(descriptor,message,options,{forceFresh:true});
  }
 }
 async abandonSharedSend(payload){this.assertSharedAccess();if(this.coreSingle?.owns(payload.descriptor)){if(payload.confirmed!==true)throw fail('WORK_REVIEW_CONFIRMATION_REQUIRED');return this.coreSingle.control(payload.descriptor,payload.requestId,'release');}if(this.closed)throw fail('APPLICATION_SHUTTING_DOWN');return this.execution.abandon(payload);}
 async getExecutionStatus(d,options={}){
  const unavailable=()=>({enabled:true,readOnly:true,connection:'error',configurationError:permissionError().code,executions:[]});
  if(this.backgroundDenied)return unavailable();
  if(this.readOnly){this.nativeTaskViews?.clear();return {enabled:true,readOnly:true,configurationError:'SHARED_READ_ONLY',executions:[],connection:'online'};}if(!d?.itemId||!d?.topicId)return {enabled:true,readOnly:false};
  if(this.coreSingle?.owns(d))return this.coreSingle.status(d);
  const sessionsEnabled=this.sessions?.enabled();
  let observationError;
  try{
   if(this.capabilities.features?.includes('shared-controlled-text-v1')&&(d.itemType||'agent')==='agent'){
    await this.execution.steering.active(d);await this.execution.reconcile();
   }
   if(sessionsEnabled)await this.sessions.observe(d,{refresh:options.refresh!==false});
  }catch(error){
   // Expose local recovery only for these transient reads, never on authorization failure.
   if(!['SHARED_LOCAL_MAPPING_REQUIRED','NETWORK_UNAVAILABLE'].includes(error?.code))throw error;
   observationError=error?.code==='NETWORK_UNAVAILABLE'?'NETWORK_UNAVAILABLE':'EXECUTION_STATUS_UNAVAILABLE';
  }
  const value=await this.execution.status(d,sessionsEnabled?{...options,refresh:false}:options);
  if(observationError&&!value.error){
   value.error={code:observationError};value.connection=observationError==='NETWORK_UNAVAILABLE'?'offline':'error';
   value.freshness=value.observedAt?'last-known':'unavailable';
  }
  if(this.backgroundDenied)return unavailable();
  let mapping;try{mapping=this.execution.mapping(d);}catch{this.dirty=true;return value;}
  if(sessionsEnabled){
   value.serverSessions=this.sessions.values(d);
   if(!observationError)await this.refreshNativeTaskViews(value,d,options.refresh!==false);
  }
  if(this.backgroundDenied)return unavailable();
  if(this.matching.fenced(mapping.sharedId)||this.matching.fenced(this.state.objects[mapping.sharedId].parentId))return {...value,readOnly:true,configurationError:'SHARED_MATCH_PREPARING'};
  if(d.itemType==='group'){
   const handoff=require('./sharedGroupHandoff'),group=this.configs.state.objects[this.state.objects[mapping.sharedId].parentId];
   const access=this.accessController?.signal;
   value.groupHandoff=await handoff.observe(this.execution,mapping,{refresh:options.refresh!==false,connection:value.connection});
   if(this.backgroundDenied||access?.aborted)return unavailable();
   value.groupHandoffAvailable=handoff.enabled(this)&&(Boolean(value.groupHandoff)||Boolean(handoff.startMode(this,group?.config)));
   const groupWork=value.groupHandoff;
   for(const job of value.executions.filter(job=>handoff.isMode(job.controlMode))){
    job.canResume=false;
    job.canAbandon=job.id===groupWork?.id&&groupWork.owned&&groupWork.fresh&&groupWork.state==='review_required';
    if(job.id===groupWork?.id)job.state=groupWork.state==='abandoned'?'cancelled':groupWork.state;
   }
  }
  return {...value,controlledTextAvailable:this.capabilities.features?.includes('shared-controlled-text-v1')===true,controlledAAAvailable:this.capabilities.features?.includes('shared-controlled-aa-v1')===true,controlledToolsAvailable:this.capabilities.features?.includes('shared-controlled-tools-v1')===true};
 }

 async refreshNativeTaskViews(value, descriptor, refresh) {
  this.nativeTaskViews ||= new Map();
  const mapping = this.execution.mapping(descriptor);
  const owned = value.executions.slice(0, 5).filter(job => {
   const record = this.sessions.byExecution.get(job.id);
   return record?.serverSession && !record.remote && record.sharedId === mapping.sharedId;
  });
  await Promise.all(owned.map(async job => {
   let view = this.nativeTaskViews.get(job.id);
   const linkedActive = (view?.nativeTasks || job.nativeTasks).some(task => activeTaskStates.has(task.state));
   if (refresh && (linkedActive || !inactiveTaskWork.has(job.state))) {
    try {
     const query = new URLSearchParams({sharedSpaceId: this.connection.sharedSpaceId, workId: job.id});
     const {request} = await this.send(endpoint + 'work?' + query);
     if (request?.id !== job.id || request.sharedId !== mapping.sharedId) throw fail('NATIVE_TASK_WORK_MISMATCH');
     view = {...require('./nativeTasks').projectNativeWork(request), verifiedAt: Date.now()};
    } catch {
     // Preserve observed status on a failed read. The stop control requires a verified read.
     view = {nativeTasks: view?.nativeTasks || job.nativeTasks, toolInvocations: view?.toolInvocations || job.toolInvocations};
    }
    this.nativeTaskViews.delete(job.id);
    this.nativeTaskViews.set(job.id, view);
    if (this.nativeTaskViews.size > 80) this.nativeTaskViews.delete(this.nativeTaskViews.keys().next().value);
   }
   const tasks = view?.nativeTasks || job.nativeTasks;
   const verified = view?.verifiedAt && Date.now() - view.verifiedAt < 5000;
   job.nativeTasks = verified ? tasks : tasks.map(task => ({...task,stopAllowed:false}));
   if (view) job.toolInvocations = view.toolInvocations;
  }));
  value.displayJobs = require('./sharedTaskList').sharedTaskList(value.executions, value.reportJobs);
 }
 async stopNativeTask({descriptor, workId, nativeTaskId} = {}) {this.assertSharedAccess();
  if (this.closed || !this.ready) throw fail('APPLICATION_SHUTTING_DOWN');
  if (this.readOnly) throw fail('SHARED_READ_ONLY');
  require('./contracts.generated.cjs').sharedIdentity(workId);
  if (typeof nativeTaskId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(nativeTaskId)) throw fail('INVALID_NATIVE_TASK_QUERY');
  const mapping = this.execution.mapping(descriptor);
  this.matching.assert([mapping.sharedId, this.state.objects[mapping.sharedId].parentId]);
  const record = this.sessions?.byExecution.get(workId);
  if (!record?.serverSession || record.remote || record.sharedId !== mapping.sharedId) throw fail('SHARED_REQUEST_OWNER_REQUIRED');
  const body = {sharedSpaceId: this.connection.sharedSpaceId, workId, nativeTaskId};
  await this.send(endpoint + 'task-stop', {body});
  return {success: true};
 }
 async getNativeTaskResult(d,workId,nativeTaskId){this.assertSharedAccess();if(this.closed)throw fail('APPLICATION_SHUTTING_DOWN');const mapping=this.execution.mapping(d);const known=await this.send(endpoint+'work?'+new URLSearchParams({sharedSpaceId:this.connection.sharedSpaceId,workId}));if(known.request?.sharedId!==mapping.sharedId)throw fail('NATIVE_TASK_RESULT_MISMATCH');const value=await this.send(endpoint+'task-result?'+new URLSearchParams({sharedSpaceId:this.connection.sharedSpaceId,workId,nativeTaskId}));return {...value,topic:{ownerType:d.itemType||'agent',ownerId:d.itemId,topicId:d.topicId}};}
 async close(){if(this.closed)return;this.closed=true;this.nativeTaskViews?.clear();const watchClosed=this.waitClient.close();clearTimeout(this.timer);await this.coreSingle?.close();await this.sessions?.close();try{await this.recoverSharedCompactionPrepares();}catch{}for(const [id,prepared]of Object.entries(this.execution?.state.compactionPreparations||{}))if(!prepared.cancelled&&!this.execution.state.compactions?.[id]?.body)try{await this.cancelSharedCompaction({descriptor:prepared.descriptor,id,closing:true});}catch{}clearTimeout(this.timer);if(this.changed)this.agentConfigEvents?.off?.('agent-config-updated',this.changed);await Promise.allSettled([watchClosed,this.running,this.refreshing,this.attachments?.work?.running,this.coreTail,this.registrationTail,this.registryDisk,this.topicSponsorRecovery]);await this.execution?.close();await this.replica?.close();this.releaseHost?.();}
}
module.exports={SharedRuntime,startupFence};

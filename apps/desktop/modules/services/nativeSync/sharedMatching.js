'use strict';
const authorityControl=require('./historyAuthority');
const path=require('node:path'),fs=require('node:fs/promises'),{randomUUID}=require('node:crypto');
const {stable,sha256,fail}=require('./protocol'),{ownedJson}=require('./sharedLocal'),{durableJson}=require('./durableJson');
const endpoint='/api/v1/sync/shared/';
const done=new Set(['complete','cancelled','rejected']);
class SharedMatching {
 static async open(r){const m=new SharedMatching(r),loaded=await ownedJson(r.root,m.file,{optional:true});if(loaded){if(loaded.version!==1||stable(loaded.binding)!==stable(r.binding()))throw fail('SHARED_BINDING_CHANGED');m.state=loaded;}return m;}
 constructor(r){this.r=r;this.file=path.join(r.dir,'matching.json');this.state={version:1,binding:r.binding(),plans:{}};this.tail=Promise.resolve();}
 serial(fn){const next=this.tail.catch(()=>{}).then(fn);this.tail=next;return next;}
 async save(){await durableJson(this.file,this.state);this.r.planTick?.();}
 fenced(id){return Object.values(this.state.plans).some(p=>!done.has(p.status)&&p.plan.objects.some(o=>o.id===id));}
 assert(ids){if(ids.some(id=>this.fenced(id)))throw fail('SHARED_MATCH_PREPARING');}
 viewScope(){const local=new Set(),shared=new Set();for(const p of Object.values(this.state.plans).filter(p=>!done.has(p.status)))for(const o of p.plan.objects){shared.add(o.id);for(const l of [p.before?.locals[o.id],this.r.state.locals[o.id]])if(l)local.add(l.kind==='topic'?l.localParent:l.localId);}return {localIds:[...local],sharedIds:[...shared]};}
 async views(){if(!this.r.ready)return;const scope=this.viewScope(),signature=stable(scope);if(!scope.localIds.length&&!this.viewsActive)return;await this.r.host.prepareViews?.(scope);this.viewsActive=scope.localIds.length>0;}
 async preview(body){const r=this.r;if(!r.capabilities.features?.includes('shared-merge-v1'))throw fail('SHARED_MERGE_UPGRADE_REQUIRED');return r.send(endpoint+'match-preview',{body:{sharedSpaceId:r.connection.sharedSpaceId,leftId:body.leftId,rightId:body.rightId}});}
 async prepare(body){return this.serial(async()=>{
  const preview=await this.preview(body);if(preview.planHash!==body.planHash)throw fail('SHARED_MATCH_CHANGED');
  const preparationId=body.preparationId||randomUUID().replaceAll('-','');let record=this.state.plans[preparationId];
  if(!record){record=this.state.plans[preparationId]={preparationId,planHash:preview.planHash,plan:preview.plan,status:'freezing',choice:{keepId:body.keepId,configChoice:body.configChoice}};await this.save();}
  await this.capture(record);await this.postPrepared(record);return this.public(record);
 });}
 public(p){return {preparationId:p.preparationId,planHash:p.planHash,plan:p.plan,choice:p.choice,status:p.status,error:p.error||null,preparedSources:p.remote?.preparedSources||[],appliedSources:p.remote?.appliedSources||[]};}
 async capture(record){
  const r=this.r;await this.views();if(record.before)return;
  const ids=new Set(record.plan.objects.map(o=>o.id)),mappings=r.mappings().filter(m=>ids.has(m.sharedId));
  if(record.plan.objects.some(o=>!r.state.locals[o.id]))throw fail('SHARED_LOCAL_MAPPING_REQUIRED');
  if(Object.keys(r.configs.state.drafts).some(id=>ids.has(id)))throw fail('SHARED_CONFIG_CONFLICT');
  if(r.configs.state.intent)throw fail('SHARED_CONFIG_PENDING_CONFIRMATION');
  if(Object.values(r.execution?.state.requests||{}).some(v=>ids.has(v.sharedId)&&!['completed','abandoned'].includes(v.phase)))throw fail('SHARED_SOURCE_NOT_SETTLED');
  await r.replica.sync();const a=r.adapter,related=e=>mappings.some(m=>a.sameTopic(e,m.shared));
  if(a.state.outbox.some(related)||a.state.inbox.some(row=>related(row.event||row))||a.state.pending&&related(a.state.pending.event)||Object.keys(a.state.localCommits).some(key=>mappings.some(m=>a.topicKey(m.shared)===key)))throw fail('SHARED_SOURCE_NOT_SETTLED');
  const before={locals:Object.fromEntries([...ids].map(id=>[id,structuredClone(r.state.locals[id])])),histories:{},owners:{}};
  for(const m of mappings){await r.verifyHistory(m);const rows=await r.queue.read(m.local);before.histories[m.sharedId]={local:m.local,revision:r.queue.revision(rows),config:await r.readLocal({...r.state.objects[m.sharedId],config:r.configs.state.objects[m.sharedId].config})};}
  for(const obj of record.plan.objects){const o=r.state.objects[obj.id];if(!['agent','group'].includes(o.kind))continue;
   const l=r.localFor(o.id),raw=await ownedJson(r.root,path.join(r.root,o.kind==='agent'?'Agents':'AgentGroups',l.localId,'config.json'));
   before.owners[`${o.kind}:${l.localId}`]={config:await r.readLocal({...o,config:r.configs.state.objects[o.id].config}),topicIds:(raw.topics||[]).map(t=>t.id)};
  }
  record.before=before;record.status='prepared-local';await this.save();await this.views();
 }
 async postPrepared(record){
  const r=this.r;await this.verifyPrepared(record);await r.send(endpoint+'match-prepare',{body:{sharedSpaceId:r.connection.sharedSpaceId,leftId:record.plan.leftId,rightId:record.plan.rightId,planHash:record.planHash,preparationId:record.preparationId,proof:{pendingOperations:0,pendingCommits:0,activeRequests:0,stateHash:sha256(stable(record.before))}}});record.status='prepared';record.error=null;await this.save();
 }
 async verifyPrepared(p){const r=this.r;
  for(const [id,h]of Object.entries(p.before.histories)){const rows=await ownedJson(r.root,r.queue.getHistoryPath(h.local.itemId,h.local.topicId),{optional:true})||[];if(r.queue.revision(rows)!==h.revision)throw fail('SHARED_LOCAL_HISTORY_CONFLICT');const cfg=await r.readLocal({...r.state.objects[id],config:r.configs.state.objects[id].config});if(stable(cfg)!==stable(h.config))throw fail('SHARED_LOCAL_CONFIG_CONFLICT');}
  if(Object.keys(r.configs.state.drafts).some(id=>p.plan.objects.some(o=>o.id===id)))throw fail('SHARED_CONFIG_CONFLICT');
 }
 async cancel(body){return this.serial(async()=>{const p=this.state.plans[body.preparationId];if(!p)throw fail('SHARED_MATCH_NOT_FOUND');const remote=await this.r.send(endpoint+'match-cancel',{body:{sharedSpaceId:this.r.connection.sharedSpaceId,planHash:p.planHash,preparationId:p.preparationId,leftId:p.plan.leftId,rightId:p.plan.rightId}});if(remote.preparationId===p.preparationId&&remote.status==='cancelled'){p.status='cancelled';await this.save();await this.views();}return remote;});}
 async confirm(body){return this.serial(async()=>{
  const r=this.r,p=this.state.plans[body.preparationId];if(!p||p.status!=='prepared')throw fail('SHARED_SOURCE_NOT_SETTLED');await this.views();await this.verifyPrepared(p);
  const input={sharedSpaceId:r.connection.sharedSpaceId,leftId:p.plan.leftId,rightId:p.plan.rightId,planHash:p.planHash,preparationId:p.preparationId,opId:'merge_'+p.preparationId,keepId:body.keepId,...(body.configChoice?{configChoice:body.configChoice}:{})};
  if(p.confirmBody&&stable(p.confirmBody)!==stable(input))throw fail('IDEMPOTENCY_KEY_REUSED');p.confirmBody=input;await this.save();
  try{const result=await r.send(endpoint+'match-confirm',{body:p.confirmBody});p.status='committed';p.result=result;await this.save();return result;}catch(error){if(error.code!=='NETWORK_UNAVAILABLE'){p.confirmBody=null;await this.save();}throw error;}
 });}
 needsPoll(){return Boolean(this.scanAfter)||Object.values(this.state.plans).some(p=>!done.has(p.status));}
 async poll(){if(!this.r.capabilities.features?.includes('shared-merge-v1'))return {plans:[]};return this.serial(async()=>{
  const r=this.r,page=await r.send(endpoint+'matches?'+new URLSearchParams({sharedSpaceId:r.connection.sharedSpaceId,after:this.scanAfter||'',limit:'64',active:'1'})),remote=[...page.plans];this.scanAfter=page.hasMore?page.next:'';
  for(const p of Object.values(this.state.plans).filter(p=>!done.has(p.status)))if(!remote.some(x=>x.preparationId===p.preparationId)){
   const {plan}=await r.send(endpoint+'match-state?'+new URLSearchParams({sharedSpaceId:r.connection.sharedSpaceId,planHash:p.planHash}));if(plan&&plan.preparationId!==p.preparationId){p.status='cancelled';await this.save();}else if(plan)remote.push(plan);
  }
  for(const item of remote){
   if(!item.plan.requiredSources.includes(r.connection.sourceId))continue;
   let p=this.state.plans[item.preparationId];
   if(!p){if(['complete','cancelled'].includes(item.status))continue;p=this.state.plans[item.preparationId]={...item,status:'freezing'};await this.save();}
   p.remote=item;
   if(item.status==='cancelled'){p.status='cancelled';await this.save();continue;}
   if(item.status==='prepared'){
    if(!r.ready)continue;
    try{await this.capture(p);if(!item.preparedSources.includes(r.connection.sourceId))await this.postPrepared(p);else p.status='prepared';p.error=null;}
    catch(e){p.error=e.code||'SHARED_SOURCE_NOT_SETTLED';await this.save();}
   }else if(['committed','complete'].includes(item.status)){
    if(!p.before)throw fail('SHARED_MATCH_PREPARATION_LOST');p.result=item.result;p.status='committed';await this.save();
    await this.project(p);if(item.status==='complete')p.status='complete';await this.save();
   }
  }
  // The user requested preparation, not confirmation. Retry only its local
  // readiness checks while a native projection finishes; no model is run.
  if(r.ready)for(const p of Object.values(this.state.plans))if(['freezing','prepared-local'].includes(p.status)&&!remote.some(x=>x.preparationId===p.preparationId)){
   try{await this.capture(p);await this.postPrepared(p);p.error=null;}catch(e){p.error=e.code||'SHARED_SOURCE_NOT_SETTLED';if(['SHARED_MATCH_CHANGED','SHARED_MATCH_CANCELLED','SHARED_MATCH_GENERATION_CHANGED'].includes(e.code))p.status='rejected';await this.save();}
  }
  // A lost confirmation response is recovered by the original operation ID.
  for(const p of Object.values(this.state.plans))if(p.confirmBody&&p.status==='prepared'&&!remote.some(x=>x.preparationId===p.preparationId&&x.result)){
   const result=await r.send(endpoint+'match-confirm',{body:p.confirmBody});p.result=result;p.status='committed';await this.save();
  }
  try{await this.views();}catch(e){if(!['SHARED_NATIVE_VIEW_NOT_READY','SHARED_LOCAL_DRAFT_PENDING'].includes(e.code))throw e;}return {plans:Object.values(this.state.plans).map(p=>this.public(p))};
 });}
 normalizeGroup(value){const r=this.r,v=structuredClone(value),resolve=id=>r.state.locals[id]?.aliasOf||id;if(v.members)v.members=v.members.map(resolve);if(v.memberTags)v.memberTags=Object.fromEntries(Object.entries(v.memberTags).map(([id,tags])=>[resolve(id),tags]));for(const order of [v.sequentialSpeakerOrder,v.modeSettings?.sequential?.speakerOrder])if(order)for(let i=0;i<order.length;i++)order[i]=resolve(order[i]);return v;}
 async project(p){
  if(authorityControl.authorityFor(this.r))return authorityControl.withAuthority(authorityControl.authorityFor(this.r),'shared-matching-project',()=>this.projectPrepared(p));
  return this.projectPrepared(p);
 }
 async projectPrepared(p){
  const r=this.r;
  if(p.projected){await r.send(endpoint+'match-applied',{body:{sharedSpaceId:r.connection.sharedSpaceId,planHash:p.planHash,preparationId:p.preparationId,stateHash:p.projected}});return;}
  // Back up one topic at a time before changing any local mapping. These are
  // retained source copies, never a rollback of accepted ledger facts.
  p.backups||={};for(const [id,entry]of Object.entries(p.before.histories))if(!p.backups[id]){
   const file=r.queue.getHistoryPath(entry.local.itemId,entry.local.topicId),rows=await ownedJson(r.root,file,{optional:true})||[];
   if(r.queue.revision(rows)!==entry.revision)throw fail('SHARED_LOCAL_HISTORY_CONFLICT');
   const backup=path.join(r.dir,'merged',p.preparationId,'histories',id+'.json'),existing=await ownedJson(r.root,backup,{optional:true});if(existing&&r.queue.revision(existing)!==entry.revision)throw fail('SHARED_LOCAL_HISTORY_CONFLICT');if(!existing)await durableJson(backup,rows);
   p.backups[id]=backup;await this.save();
  }
  const {bindings}=await r.send(endpoint+'bindings?'+new URLSearchParams({sharedSpaceId:r.connection.sharedSpaceId}));
  if(!p.nextLocals){
   p.nextLocals=Object.fromEntries(p.plan.objects.map(o=>[o.id,structuredClone(r.state.locals[o.id])]));const keep=p.result.object.id,other=p.result.retainedAlias;
   for(const obj of p.plan.objects){if(obj.id===other){p.nextLocals[other]={...p.nextLocals[other],aliasOf:keep,hidden:true};continue;}const binding=bindings.find(b=>b.sharedId===obj.id&&!b.hidden);if(binding)p.nextLocals[obj.id]={...p.nextLocals[obj.id],localId:binding.localId,localParent:binding.localParent,hidden:false};}
   await this.save();
  }
  Object.assign(r.state.locals,p.nextLocals);r.state.retiredOwners||={};
  if(p.result.kind!=='topic')for(const id of [p.result.object.id,p.result.retainedAlias]){const before=p.before.locals[id],active=r.state.locals[p.result.object.id];if(before.localId!==active.localId)r.state.retiredOwners[before.kind+':'+before.localId]=p.result.object.id;}
  await r.save();
  for(const obj of p.plan.objects){const {object}=await r.send(endpoint+'config?'+new URLSearchParams({sharedSpaceId:r.connection.sharedSpaceId,sharedId:obj.id}));r.state.objects[obj.id]=r.summary(object);}await r.save();
  await r.replica.rebind(r.mappings());
  const keep=p.result.object.id,other=p.result.retainedAlias;p.copied||={};
  for(const obj of p.plan.objects){const metadata=r.state.objects[obj.id];if(metadata.kind!=='topic'||metadata.deleted)continue;
   const source=p.backups[obj.id];if(!source)continue;const local=r.localFor(obj.id),descriptor={itemType:metadata.topic.ownerType,itemId:local.localParent,topicId:local.localId},rows=await ownedJson(r.root,source),current=await ownedJson(r.root,r.queue.getHistoryPath(descriptor.itemId,descriptor.topicId),{optional:true});
   const old=Object.values(p.before.histories).find(h=>h.local.itemId===descriptor.itemId&&h.local.topicId===descriptor.topicId);
   if(current&&r.queue.revision(current)!==r.queue.revision(rows)&&(!old||r.queue.revision(current)!==old.revision))throw fail('SHARED_LOCAL_HISTORY_CONFLICT');
   // Native eligibility is published through the existing host before the
   // same Queue may project into a newly rebound physical topic.
   await r.host.ensureTopic(descriptor.itemType,descriptor.itemId,{id:descriptor.topicId,name:r.configs.state.objects[obj.id]?.config.name||obj.id,nativeSyncOriginSource:metadata.originSource});
   await r.replica.queue.project({itemType:metadata.topic.ownerType,itemId:metadata.topic.ownerId,topicId:metadata.topic.topicId},rows);p.copied[obj.id]=true;await this.save();
  }
  for(const obj of p.plan.objects){const metadata=r.state.objects[obj.id];if(metadata.deleted||!['agent','group'].includes(metadata.kind))continue;
   const {object}=await r.send(endpoint+'config?'+new URLSearchParams({sharedSpaceId:r.connection.sharedSpaceId,sharedId:obj.id})),local=r.localFor(obj.id),before=p.before.owners[`${object.kind}:${local.localId}`];if(!before)throw fail('SHARED_MATCH_PREPARATION_LOST');
   await r.configs.applyConfirmed(object,this.normalizeGroup(before.config));
   const topics=Object.values(r.state.objects).filter(t=>t.kind==='topic'&&!t.deleted&&t.parentId===obj.id),ids=topics.map(t=>r.localFor(t.id).localId),file=path.join(r.root,object.kind==='agent'?'Agents':'AgentGroups',local.localId,'config.json'),raw=await ownedJson(r.root,file);
   if(raw.topics?.some(t=>!before.topicIds.includes(t.id)&&!ids.includes(t.id)))throw fail('SHARED_LOCAL_DIRECTORY_CONFLICT');
   for(const t of topics)await r.host.ensureTopic(object.kind,local.localId,{id:r.localFor(t.id).localId,name:r.configs.state.objects[t.id]?.config.name||t.id,nativeSyncOriginSource:t.originSource});await r.host.retainTopics(object.kind,local.localId,ids);
  }
  const old=p.before.locals[other],active=r.localFor(keep);
  if(p.result.kind!=='topic')for(const id of [keep,other]){const before=p.before.locals[id];if(before.localId!==active.localId){const kind=p.result.kind,from=path.join(r.root,kind==='agent'?'Agents':'AgentGroups',before.localId),to=path.join(r.dir,'merged',p.preparationId,'owner',id);await r.directoryState.moves({moves:[{from,to}]});}}
  if(p.result.kind==='topic'){
   const parent=r.state.objects[keep].parentId,owner=r.state.objects[parent],location=r.localFor(parent),active=r.localFor(keep),before=Object.values(p.before.histories).find(h=>h.local.itemId===active.localParent&&h.local.topicId===active.localId);
   const {object}=await r.send(endpoint+'config?'+new URLSearchParams({sharedSpaceId:r.connection.sharedSpaceId,sharedId:keep}));await r.configs.applyConfirmed(object,before?.config||null);
   for(const id of [p.before.locals[other].localId,p.before.locals[keep].localId])if(id!==active.localId&&!Object.entries(r.state.locals).some(([key,l])=>key!==other&&!l.aliasOf&&l.kind==='topic'&&l.localParent===location.localId&&l.localId===id))await r.host.detachTopic(owner.kind,location.localId,id);
  }
  p.projected=sha256(stable({locals:r.state.locals,files:p.copied}));await this.save();await r.send(endpoint+'match-applied',{body:{sharedSpaceId:r.connection.sharedSpaceId,planHash:p.planHash,preparationId:p.preparationId,stateHash:p.projected}});r.notifyDirectory(r.state.objects[keep]);
 }
}
module.exports={SharedMatching};

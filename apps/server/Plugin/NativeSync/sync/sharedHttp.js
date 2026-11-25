'use strict';
const {SHARED_SPACE_CAPABILITY} = require('./contracts.generated.cjs');
const fail=(code,status=400)=>Object.assign(Error(code),{code,status});
const posts={join:['join',['sharedSpaceId','opId']],objects:['create',['sharedSpaceId','opId','kind','localId','localParent','parentId','config']],adopt:['adopt',['sharedSpaceId','opId','kind','ownerType','localId','localParent','parentId','config']],bind:['bind',['sharedSpaceId','opId','sharedId','localId','localParent','restore']],config:['saveConfig',['sharedSpaceId','opId','sharedId','expectedVersion','config']],remove:['remove',['sharedSpaceId','opId','sharedId','mode','confirm','expectedVersion']],admit:['admit',['sharedSpaceId','sharedId','requestId','expectedHead','configHash','message','kind','targetId','targetHash','targetSeq','memberId','modelSaveRef','modelSaveResolutionRef','controlMode','delegation','sponsorRouteHash']],complete:['complete',['sharedSpaceId','admissionId','opId','message','nativeRequestId','finish']],abandon:['abandon',['sharedSpaceId','admissionId','opId','confirm']],message:['editMessage',['sharedSpaceId','sharedId','operation']], 'match-preview':['previewMatch',['sharedSpaceId','leftId','rightId']], 'match-prepare':['prepareMatch',['sharedSpaceId','leftId','rightId','planHash','proof','preparationId']], 'match-confirm':['confirmMatch',['sharedSpaceId','leftId','rightId','planHash','opId','keepId','configChoice','preparationId']]};
posts['native-request']=['prepareNative',['sharedSpaceId','admissionId','requestId','bodyHash','memberId','generation','consumedInputSeq']];
posts['match-cancel']=['cancelMatch',['sharedSpaceId','planHash','preparationId','leftId','rightId']];
posts['match-applied']=['appliedMatch',['sharedSpaceId','planHash','preparationId','stateHash']];
posts.steer=['steer',['sharedSpaceId','workId','opId','inputId','observedRevision','message','attachmentsReady','attachmentManifest','modelSaveRef']];
posts['steer-ready']=['steerReady',['sharedSpaceId','workId','opId','inputId','message','modelSaveRef','modelSaveResolutionRef']];
posts['steer-checkpoint']=['steerCheckpoint',['sharedSpaceId','workId','opId','generation','message']];
posts['steer-turn-complete']=['steerTurnComplete',['sharedSpaceId','workId','opId','generation','message']];
posts['compact-prepare']=['compactPrepare',['sharedSpaceId','sharedId','opId','expectedHead']];
posts['compact-cancel']=['compactCancel',['sharedSpaceId','id','opId']];
posts['compact-commit']=['compactCommit',['sharedSpaceId','id','opId','sourceHash','message']];
const handoffFields=['sharedSpaceId','workId','opId','expectedExecutor','expectedExecutorVersion','expectedNextOrdinal','expectedPreviousReplySeq'];
posts['group-handoff']=['groupHandoff',handoffFields];
posts['group-continue']=['groupContinue',handoffFields];
posts['steer-handoff']=['steerHandoff',['sharedSpaceId','workId','opId','expectedRevision','expectedGeneration','expectedExecutor']];
posts['steer-prepare']=['steerPrepare',['sharedSpaceId','workId','opId','expectedRevision','expectedGeneration','expectedHead','configHash']];
posts.baselines=['beginSharedBaseline',['sharedSpaceId','sharedId','planId']];
posts['session-send']=['sessionSend',['sharedSpaceId','sharedId','requestId','expectedHead','configHash','message','modelSaveRef','modelSaveResolutionRef','admissionId','sponsorRouteHash']];
const gets={directory:['directory',['sharedSpaceId','after','limit']],changes:['changes',['sharedSpaceId','after','limit']],config:['get',['sharedSpaceId','sharedId']],context:['executionConfig',['sharedSpaceId','sharedId']],request:['request',['sharedSpaceId','requestId']],history:['history',['sharedSpaceId','sharedId','after','limit']],pull:['spaceHistory',['sharedSpaceId','after','limit']],bindings:['bindings',['sharedSpaceId']]};
gets['compact-input']=['compactInput',['sharedSpaceId','id']];
gets['topic-history']=['topicHistory',['sharedSpaceId','sharedId','after','limit']];
gets['execution-trace']=['executionTrajectory',['sharedSpaceId','workId','limit']];
posts['session-cancel']=['cancelSession',['sharedSpaceId','workId','opId']];
posts['task-stop']=['stopTask',['sharedSpaceId','workId','nativeTaskId']];
gets.active=['activeWork',['sharedSpaceId','sharedId']];
gets['task-result']=['taskResult',['sharedSpaceId','workId','nativeTaskId']];
gets.work=['workState',['sharedSpaceId','workId']];
gets['final-reply']=['steerFinalReply',['sharedSpaceId','workId','requestId','generation']];
gets.steering=['steeringState',['sharedSpaceId','workId','pausedRequestId']];
gets.matches=['matchStates',['sharedSpaceId','after','limit','active']];
gets['match-state']=['matchState',['sharedSpaceId','planHash']];
gets['request-config']=['requestConfig',['sharedSpaceId','admissionId']];
gets.baseline=['sharedBaseline',['sharedSpaceId','sharedId','baselineId','after','limit']];
const configurationReads = new Set(['config', 'directory', 'changes', 'bindings', 'wait']);
function fields(value,keys){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)))throw fail('INVALID_SHARED_REQUEST');}
async function readBody(req){
 if(req.body!==undefined){if(Buffer.byteLength(JSON.stringify(req.body))>512*1024)throw fail('BODY_TOO_LARGE',413);return req.body;}
 const chunks=[];let size=0;for await(const chunk of req){size+=Buffer.byteLength(chunk);if(size>512*1024)throw fail('BODY_TOO_LARGE',413);chunks.push(Buffer.from(chunk));}
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw fail('INVALID_SHARED_REQUEST');}
}
function desktopBinding(req){
 return {sourceId:req.headers?.['x-nativesync-source'],deviceId:req.headers?.['x-nativesync-device'],spaceId:req.headers?.['x-nativesync-space'],scopeHash:req.headers?.['x-nativesync-scope']};
}
function sharedInfo(shared,sourceId){
 const policy=require('./releasePolicy.cjs');
 const wait=require('./sharedWait'),controlled=require('./sharedControlledText'),handoff=require('./sharedGroupHandoff');
 const features=typeof shared.db.function==='function'?[wait.capability,wait.watchCapability]:[];
 features.push('shared-model-save-v1');
 if(!shared.configurationOnly)features.push(
  'shared-compaction-v1','shared-topic-history-v1','shared-desktop-message-edit-v1','shared-attachments-v1','shared-merge-v1','shared-context-v1',
  require('./sharedInline.cjs').CAP,
  ...(handoff.available(shared)?[handoff.MODE,handoff.PLAN_MODE]:[]),
  ...(shared.native?[require('./sharedNative').NATIVE_INLINE_CAPABILITY]:[]),
  ...(shared.native?.engine?[require('./sharedSession').CAPABILITY,'shared-execution-trace-v1','shared-session-cancel-v1',require('./sharedTopicSponsor').CAPABILITY]:[]),
  ...(shared.events&&!shared.events.closed?['shared-events-v1']:[]),
  ...(policy.sharedSteering?['shared-steering-v1']:[]),
  ...(shared.native?.engine&&require('./sharedControlledText').enabled(shared,require('./sharedControlledText').TOOLS_MODE)?[require('./sharedControlledText').TOOLS_CAPABILITY,require('./sharedControlledText').TOOL_PAIR_CAPABILITY,require('./sharedControlledText').TOOLS_HISTORY_CAPABILITY]:[]),
  ...(shared.native?.engine&&controlled.enabled(shared,controlled.AA_MODE)?[controlled.AA_CAPABILITY]:[]),
  ...(shared.native?.engine&&policy.sharedControlledText?[require('./sharedControlledText').CAPABILITY]:[]),
 );
 return {capability:SHARED_SPACE_CAPABILITY,schemaVersion:1,features,readOnly:shared.readOnly,spaces:[...shared.grants].filter(([,sources])=>sources.has(sourceId)).map(([id])=>({id,...((shared.coreWorkspace||shared.core?.workspace)===id&&{coreSingle:true})}))};
}
function openSharedWatch(store,req,res,url,onClose,heartbeatMs=15000){
 const shared=store.shared;
 if(!shared||typeof shared.db.function!=='function')throw fail('SHARED_WATCH_UNAVAILABLE',404);
 const query=Object.fromEntries(url.searchParams);
 fields(query,['sharedSpaceId','since']);
 if(url.searchParams.size!==Object.keys(query).length)throw fail('INVALID_SHARED_REQUEST');
 const {sharedSpaceId:space}=query;
 const binding=desktopBinding(req),clientCapabilities=req.headers['x-nativesync-capabilities'];
 const actor=shared.desktop(binding,clientCapabilities);
 shared.authorize(actor,space);
 const info=JSON.stringify(sharedInfo(shared,actor.sourceId));
 const hub=require('./sharedWait').hub(shared);
 let token=query.since,closed=false,timer,unsubscribe;
 const close=()=>{
  if(closed)return;
  closed=true;
  clearInterval(timer);
  unsubscribe?.();
  req.off('aborted',close);
  res.off('close',close);
  if(!res.writableEnded&&!res.destroyed)res.end();
  onClose();
 };
 const write=frame=>{
  if(!res.write(frame)){
   // Hints need no backlog. Reconnect compares against the last received token.
   res.destroy();
   close();
  }
 };
 const invalidate=reason=>{
  write(`event: invalidate\ndata: ${JSON.stringify({reason})}\n\n`);
  close();
 };
 const check=heartbeat=>{
  if(closed)return;
  if(res.destroyed||res.writableEnded){close();return;}
  try{
   if(store.shared!==shared){invalidate('capabilities_changed');return;}
   if(shared.db.isTransaction)return;
   try{shared.authorize(shared.desktop(binding,clientCapabilities),space);}
   catch{invalidate('authorization_lost');return;}
   if(JSON.stringify(sharedInfo(shared,actor.sourceId))!==info){invalidate('capabilities_changed');return;}
   const value=hub.snapshot(actor,space,token);
   if(value.changed.length){
    token=value.token;
    write(`event: hint\ndata: ${JSON.stringify(value)}\n\n`);
   }else if(heartbeat)write(': heartbeat\n\n');
  }catch{close();}
 };
 unsubscribe=hub.subscribe(actor,space,token,check);
 try{
  req.once('aborted',close);
  res.once('close',close);
  res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store, no-transform','X-Accel-Buffering':'no'});
  res.flushHeaders?.();
  timer=setInterval(()=>check(true),heartbeatMs);
  timer.unref?.();
  check(true);
 }catch(error){close();throw error;}
 return {close};
}
async function sharedRequest(store,req,url,mobileActor,signal){
 const shared=store.shared;if(!shared)throw fail('SHARED_SPACE_UNAVAILABLE',409);
 const name=url.pathname.replace(/^\/shared\//,'');
 const binding=desktopBinding(req);
 if(name==='info'&&req.method==='GET'&&!mobileActor){
  shared.catalog.binding(binding);
  return sharedInfo(shared,binding.sourceId);
 }
 const actor=mobileActor||shared.desktop(binding,req.headers?.['x-nativesync-capabilities']);
 if(shared.configurationOnly&&!((req.method==='GET'&&configurationReads.has(name))||
  (req.method==='POST'&&name==='config')))throw fail('SHARED_CONFIGURATION_ONLY',409);
 if(req.method==='POST'&&name.startsWith('steer')&&!String(req.headers?.['x-nativesync-capabilities']||'').split(',').includes('shared-steering-v1'))throw fail('SHARED_CLIENT_UPGRADE_REQUIRED',409);
 if(name==='wait'&&req.method==='GET'){
  if(mobileActor||typeof shared.db.function!=='function')throw fail('SHARED_WAIT_UNAVAILABLE',404);
  const query=Object.fromEntries(url.searchParams);fields(query,['sharedSpaceId','since']);
  if(url.searchParams.size!==Object.keys(query).length)throw fail('INVALID_SHARED_REQUEST');
  shared.authorize(actor,query.sharedSpaceId);
  return require('./sharedWait').hub(shared).wait(actor,query.sharedSpaceId,query.since,signal);
 }
 if(req.method==='GET'){
  const route=gets[name];if(!route)throw fail('NOT_FOUND',404);
  const query=Object.fromEntries(url.searchParams);fields(query,route[1]);
  if(url.searchParams.size!==Object.keys(query).length)throw fail('INVALID_SHARED_REQUEST');
  if(query.limit!==undefined)query.limit=Number(query.limit);
  if(query.after!==undefined&&!['directory','matches'].includes(name))query.after=Number(query.after);
  if(name==='config')return {object:shared.get(actor,query.sharedSpaceId,query.sharedId),readOnly:shared.readOnly};
  const sharedSessionHistory=name==='context'&&actor.kind==='desktop'&&String(req.headers?.['x-nativesync-capabilities']||'').split(',').includes('shared-session-history-v1');
  let desktopConfigRequired=false;
  if(name==='context'&&shared.native?.engine.configs){
   shared.topic(actor,query.sharedSpaceId,query.sharedId,'execute');
   if(actor.kind==='desktop'&&!String(req.headers?.['x-nativesync-capabilities']||'').split(',').includes('shared-context-v1'))throw fail('SHARED_CONTEXT_CLIENT_UPGRADE_REQUIRED',409);
   const configs=shared.native.engine.configs,topic=configs.topics.find(t=>t.key===query.sharedId&&t.sharedSpaceId===query.sharedSpaceId);
   if(!topic)throw fail('SHARED_CONFIG_PENDING',409);
   const execution=await require('../mobile/sharedConfiguration').prepareSharedConfiguration(configs,topic,{desktopContext:actor.kind==='desktop'});
   if(sharedSessionHistory&&execution&&topic.ownerType==='agent'){
    try{configs.verify(topic,execution);}catch(error){if(error.code!=='DESKTOP_CONTEXT_REQUIRED')throw error;desktopConfigRequired=true;}
   }
  }
  if(sharedSessionHistory)query.sharedSessionHistory=true;
  const result=shared[route[0]](actor,query);
  if(name==='directory')result.readOnly=shared.readOnly;
  // Execute permission does not expose the private configuration template.
  if(name==='context')return {hash:result.hash,head:result.head,model:result.owner.config.model,...(desktopConfigRequired?{desktopConfigRequired:true}:{}),...(result.desktopHistoryRequired===undefined?{}:{desktopHistoryRequired:result.desktopHistoryRequired}),dependencies:[result.owner,...result.members,...result.rules].map(v=>({id:v.id,kind:v.kind,version:v.version,configHash:v.configHash}))};
  return result;
 }
 if(req.method==='POST'){
  if(name==='topic-sponsor'){
   const sponsor=require('./sharedTopicSponsor');
   if(!String(req.headers?.['x-nativesync-capabilities']||'').split(',').includes(sponsor.CAPABILITY))throw fail('SHARED_CLIENT_UPGRADE_REQUIRED',409);
   const body=await readBody(req);fields(body,['operationId','proof','args']);
   return sponsor.accept(shared,actor,body);
  }
  if(name==='session-send'&&!String(req.headers?.['x-nativesync-capabilities']||'').split(',').includes(require('./sharedSession').CAPABILITY))throw fail('SHARED_CLIENT_UPGRADE_REQUIRED',409);
  if(name.startsWith('match-')&&name!=='match-preview'&&!String(req.headers?.['x-nativesync-capabilities']||'').split(',').includes('shared-merge-v1'))throw fail('SHARED_MERGE_CLIENT_UPGRADE_REQUIRED',409);
  const route=posts[name];if(!route)throw fail('NOT_FOUND',404);
  if(name==='admit'&&actor.kind==='desktop'&&shared.native&&!String(req.headers?.['x-nativesync-capabilities']||'').split(',').includes('shared-context-v1'))throw fail('SHARED_CONTEXT_CLIENT_UPGRADE_REQUIRED',409);
  const body=await readBody(req);
  if(name==='native-request'&&body.generation!==undefined&&!String(req.headers?.['x-nativesync-capabilities']||'').split(',').includes('shared-steering-v1'))throw fail('SHARED_CLIENT_UPGRADE_REQUIRED',409);
  fields(body,route[1]);
  // The paired browser does not need the private session id to edit a message.
  // editMessage still enforces execute permission, current base and principal.
  if(mobileActor&&name==='message'&&body.operation&&body.operation.deviceId===undefined){
   body.operation={...body.operation,deviceId:actor.principal};
  }
  const inline=require('./sharedInline.cjs');
  if((name==='session-send'||name==='admit'&&actor.kind==='desktop'&&inline.enabled(req))&&shared.native?.engine.configs){
   shared.topic(actor,body.sharedSpaceId,body.sharedId,'execute');
   // A replay belongs to its frozen admission, even if today's template is no
   // longer runnable. The actual admission still verifies immutable identity.
   const accepted=()=>name==='session-send'&&body.admissionId?shared.admission(actor,body.sharedSpaceId,body.admissionId):shared.request(actor,{sharedSpaceId:body.sharedSpaceId,requestId:body.requestId}).request;
   if(!accepted()){
    try{
     const configs=shared.native.engine.configs,topic=configs.topics.find(t=>t.key===body.sharedId&&t.sharedSpaceId===body.sharedSpaceId);
     if(!topic)throw fail('SHARED_CONFIG_PENDING',409);
     await require('../mobile/sharedConfiguration').prepareSharedConfiguration(configs,topic,{desktopContext:name==='admit'&&actor.kind==='desktop'});
    }catch(error){if(!accepted())throw error;}
   }
  }
  const result=shared[route[0]](actor,body);return inline.enabled(req)?inline.envelope(shared,actor,name,body,result):result;
 }
 throw fail('METHOD_NOT_ALLOWED',405);
}
module.exports={sharedRequest,openSharedWatch};

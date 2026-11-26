'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises');
const {fixture,wait,BOX}=require('./fixtures/sharedSingleHarness.cjs');
const confirmed=c=>({confirmed:true,mode:'all',expectedVersion:c.expectedVersion,operationId:c.operationId,expectedBinding:c.expectedBinding});
test('native-operation assembly preserves accepted C5 controlled-text policy',()=>{
 assert.deepEqual(require(BOX+'/Plugin/NativeSync/sync/releasePolicy.cjs'),{sharedReadOnly:false,sharedSteering:false,sharedControlledText:true});
});
test('native deletion previews and removes a registered topic without a history file, preserving ledger facts',async t=>{
 const f=await fixture(t),a=await f.desktop('A'),metrics=f.store.metrics();
 await fs.rm(a.queue.getHistoryPath(a.descriptor.itemId,a.descriptor.topicId),{force:true});
 const context=await a.runtime.nativeDeletionContext(a.descriptor);assert.equal(context.kind,'shared');
 const result=await a.runtime.removeNativeObject(a.descriptor,confirmed(context));assert.equal(result.success,true);
 assert.deepEqual(f.store.metrics(),metrics);assert.equal(f.shared.get(f.actor('A'),'sharedAB',f.topic.id).deleted,true);
 const replay=await a.runtime.removeNativeObject(a.descriptor,confirmed(context));assert.equal(replay.replayed,true);
 assert.equal(f.calls(),0);
});
test('native deletion refuses missing confirmation and stale versions without local deletion',async t=>{
 const f=await fixture(t),a=await f.desktop('A'),context=await a.runtime.nativeDeletionContext(a.descriptor);
 await assert.rejects(a.runtime.removeNativeObject(a.descriptor,{}),{code:'SHARED_DELETE_CONFIRMATION_REQUIRED'});
 await assert.rejects(a.runtime.removeNativeObject(a.descriptor,{...confirmed(context),expectedVersion:0}),{code:'SHARED_DELETE_CONFIRMATION_REQUIRED'});
 assert.equal(a.runtime.isLocalVisible(f.topic.id),true);assert.deepEqual(await a.queue.read(a.descriptor),[]);
});
test('native deletion ignores Renderer supplied sharedId and routes the native scope only',async t=>{
 const f=await fixture(t),a=await f.desktop('A'),context=await a.runtime.nativeDeletionContext(a.descriptor);
 await a.runtime.removeNativeObject(a.descriptor,{...confirmed(context),sharedId:f.owner.id});
 assert.equal(f.shared.get(f.actor('A'),'sharedAB',f.owner.id).deleted,false);assert.equal(f.shared.get(f.actor('A'),'sharedAB',f.topic.id).deleted,true);
});
test('native topic rename receives an authoritative configuration receipt',async t=>{
 const f=await fixture(t),a=await f.desktop('A');
 const result=await a.runtime.renameNativeTopic(a.descriptor,'Renamed through native UI',confirmed(await a.runtime.nativeDeletionContext(a.descriptor)));
 assert.equal(result.success,true);assert.equal(f.shared.get(f.actor('A'),'sharedAB',f.topic.id).config.name,'Renamed through native UI');
});
test('idle topic discovery skips a matching native projection and rereads differences before drafting', async t => {
 const f = await fixture(t);
 const {runtime, descriptor} = await f.desktop('A');
 const topicId = f.topic.id;
 const ensure = (name, archived) => runtime.host.ensureTopic(descriptor.itemType, descriptor.itemId, {
  id: descriptor.topicId, name, archived
 });
 const readLocal = runtime.readLocal.bind(runtime);
 let topicReads = 0;
 runtime.readLocal = object => {
  if (object.id === topicId) topicReads++;
  return readLocal(object);
 };
 await runtime.tickCore({forceLocal:true});
 assert.equal(topicReads, 0);
 assert.equal(runtime.configs.state.drafts[topicId], undefined);

 await ensure('Observed during discovery', false);
 const discover = runtime.discover.bind(runtime);
 runtime.discover = async (...args) => {
  await discover(...args);
  await ensure('Latest native title', true);
 };
 await runtime.tickCore({forceLocal:true});
 assert.equal(topicReads, 1);
 assert.deepEqual(runtime.configs.state.drafts[topicId].config, {name:'Latest native title', archived:true});
 assert.equal(f.shared.get(f.actor('A'), 'sharedAB', topicId).config.name, 'One history');
});
function submit(f,id){const c=f.shared.executionConfig(f.actor('A'),{sharedSpaceId:'sharedAB',sharedId:f.topic.id});return f.shared.sessionSend(f.actor('A'),{sharedSpaceId:'sharedAB',sharedId:f.topic.id,requestId:id,expectedHead:c.head,configHash:c.hash,message:{id:'user_'+id,role:'user',content:'synthetic trajectory input',timestamp:1}});}
async function execute(f){f.portal.engine.db.prepare('UPDATE mobile_executions SET not_before=0').run();f.portal.engine.setEndpoint({url:f.url+'/v1/chat/completions',key:'SYNTHETIC_SECRET_MUST_NOT_APPEAR'});}
test('real native request and response trace survives backend reopen and is initiator-only',async t=>{
 const f=await fixture(t),accepted=submit(f,'native_trace_once');await execute(f);
 await wait(()=>f.portal.engine.get(accepted.id).state==='completed','trace completion');
 const query={sharedSpaceId:'sharedAB',workId:accepted.id};const page=await f.shared.executionTrajectory(f.actor('A'),query);
 assert.equal(page.records.length,1);assert.equal(page.records[0].response.text,'SYNTHETIC_REPLY_1');
 assert.ok(JSON.stringify(page).includes('synthetic trajectory input'));assert.ok(!JSON.stringify(page).includes('SYNTHETIC_SECRET_MUST_NOT_APPEAR'));
 await assert.rejects(f.shared.executionTrajectory(f.actor('B'),query),{code:'TRACE_INITIATOR_REQUIRED'});
 await f.reopenBackend();const restored=await f.shared.executionTrajectory(f.actor('A'),query);
 assert.equal(restored.records[0].id,page.records[0].id);assert.equal(f.calls(),1);
});
test('queued cancellation is idempotent, preserves the input and never dispatches a model',async t=>{
 const f=await fixture(t),accepted=submit(f,'native_cancel_queued'),body={sharedSpaceId:'sharedAB',workId:accepted.id,opId:'cancel_queued_once'};
 assert.throws(()=>f.shared.cancelSession(f.actor('B'),body),{code:'SHARED_REQUEST_OWNER_REQUIRED'});
 const a=f.shared.cancelSession(f.actor('A'),body),b=f.shared.cancelSession(f.actor('A'),body);assert.deepEqual(a.execution,b.execution);assert.equal(b.replayed,true);
 assert.equal(f.portal.engine.get(accepted.id).state,'cancelled');assert.equal(f.calls(),0);assert.equal(f.store.metrics().journalRows,1);
});
test('dispatched stop retains review-required uncertainty and cannot replay on restart',async t=>{
 const f=await fixture(t);f.control.holdHttp=true;const accepted=submit(f,'native_cancel_running');await execute(f);
 await wait(()=>f.calls()===1,'native dispatch');f.shared.cancelSession(f.actor('A'),{sharedSpaceId:'sharedAB',workId:accepted.id,opId:'cancel_running_once'});
 await wait(()=>f.portal.engine.get(accepted.id).state==='review_required','cancel uncertain');
 await f.reopenBackend();await execute(f);assert.equal(f.calls(),1);assert.equal(f.portal.engine.get(accepted.id).state,'review_required');
});
test('native configuration and global rules keep local fields, versions and failed drafts',async t=>{
 const f=await fixture(t),a=await f.desktop('A'),runtime=a.runtime,raw=await runtime.host.readNativeOwner('agent',a.descriptor.itemId);
 const base=runtime.configs.state.objects[f.owner.id];
 const result=await runtime.saveNativeConfig('agent',a.descriptor.itemId,{...raw,name:'Native editor name',localOnlyPreference:'keep-on-device',__nativeSyncSharedBase:{sharedId:f.owner.id,version:base.version}});
 assert.equal(result.success,true);assert.equal(f.shared.get(f.actor('A'),'sharedAB',f.owner.id).config.localOnlyPreference,undefined);
 assert.equal((await runtime.host.readNativeOwner('agent',a.descriptor.itemId)).localOnlyPreference,'keep-on-device');
 const marker=runtime.nativeRulesContext(),rule={id:'native_rule',name:'Rule',type:'system_suffix',enabled:true,content:'synthetic rule',scope:'global',source:'user'};
 assert.equal((await runtime.saveNativeRules({rules:[rule],__nativeSyncSharedBase:marker})).success,true);
 await assert.rejects(runtime.saveNativeRules({rules:[{...rule,content:'stale'}],__nativeSyncSharedBase:marker}),{code:'SHARED_CONFIG_CONFLICT'});
 assert.ok(Object.values(runtime.configs.state.drafts).some(d=>d.conflict));
});
test('native avatar uses the editor version and existing shared asset validation',async t=>{
 const f=await fixture(t),a=await f.desktop('A');
 const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5WqE8AAAAASUVORK5CYII=','base64');
 const data={type:'image/png',buffer:bytes,__nativeSyncSharedBase:{sharedId:f.owner.id,version:a.runtime.configs.state.objects[f.owner.id].version}};
 const result=await a.runtime.saveNativeAvatar('agent',a.descriptor.itemId,data);assert.equal(result.success,true);assert.ok(result.avatarUrl.startsWith('file:'));
 await assert.rejects(a.runtime.saveNativeAvatar('agent',a.descriptor.itemId,data),{code:'SHARED_CONFIG_CONFLICT'});
});
test('empty topic identities cannot turn a topic operation into an owner deletion',async t=>{
 const f=await fixture(t),a=await f.desktop('A'),ownerScope={itemType:'agent',itemId:a.descriptor.itemId};
 const ownerContext=await a.runtime.nativeDeletionContext(ownerScope);
 await assert.rejects(a.runtime.removeNativeObject({...ownerScope,topicId:undefined},confirmed(ownerContext)),{code:'INVALID_NATIVE_SCOPE'});
 assert.equal(f.shared.get(f.actor('A'),'sharedAB',f.owner.id).deleted,false);
});
test('a preview from another device cannot authorize this native binding',async t=>{
 const f=await fixture(t),a=await f.desktop('A'),b=await f.desktop('B'),context=await a.runtime.nativeDeletionContext(a.descriptor);
 await assert.rejects(b.runtime.removeNativeObject(b.descriptor,confirmed(context)),{code:'SHARED_NATIVE_BINDING_CHANGED'});
 assert.equal(f.shared.get(f.actor('A'),'sharedAB',f.topic.id).deleted,false);
});
test('read-only native operations preserve the accepted directory',async t=>{
 const f=await fixture(t),a=await f.desktop('A');a.runtime.readOnly=true;
 await assert.rejects(a.runtime.nativeDeletionContext(a.descriptor),{code:'SHARED_READ_ONLY'});
 assert.equal(f.shared.get(f.actor('A'),'sharedAB',f.topic.id).deleted,false);
});

test('device-only native removal keeps the final topic and its shared binding',async t=>{
 const f=await fixture(t),a=await f.desktop('A'),r=a.runtime,d=a.descriptor;
 const ctx=await r.nativeDeletionContext(d);
 await assert.rejects(r.removeNativeObject(d,{...confirmed(ctx),mode:'device'}),{code:'SHARED_LAST_LOCAL_TOPIC'});
 assert.equal(r.isLocalVisible(f.topic.id),true);
 assert.equal((await r.host.readNativeOwner('agent',d.itemId)).topics.some(x=>x.id===d.topicId),true);
});

test('simultaneous device removals from two native windows leave one local topic', async t => {
 const f=await fixture(t);
 const second=f.shared.create(f.actor('A'),{sharedSpaceId:'sharedAB',opId:'second',
  kind:'topic',parentId:f.owner.id,localId:'second',localParent:'origin',config:{name:'Second topic'}}).object;
 const {runtime,descriptor}=await f.desktop('B');
 const scopes=[descriptor,{...descriptor,topicId:runtime.localFor(second.id).localId}];
 const confirmations=await Promise.all(scopes.map(scope=>runtime.nativeDeletionContext(scope)));
 const results=await Promise.allSettled(scopes.map((scope,i)=>
  runtime.removeNativeObject(scope,{...confirmed(confirmations[i]),mode:'device'})));
 assert.equal(results.filter(result=>result.status==='fulfilled'&&result.value.success).length,1);
 assert.equal(results.find(result=>result.status==='rejected')?.reason.code,'SHARED_LAST_LOCAL_TOPIC');
 const owner=await runtime.host.readNativeOwner('agent',descriptor.itemId);
 assert.equal(owner.topics.length,1);
 for(const id of [f.topic.id,second.id])assert.equal(f.shared.get(f.actor('A'),'sharedAB',id).deleted,false);
});

test('native Agent creation binds its owner and every initial topic before creating History',async t=>{
 const {CHAT}=require('./fixtures/sharedSingleHarness.cjs');
 const {conversationKey}=require(CHAT+'/modules/services/historyMutationQueue');
 const AgentConfigManager=require(CHAT+'/modules/utils/agentConfigManager');
 const f=await fixture(t),desktop=await f.desktop('A');
 const agents=desktop.data+'/Agents';
 const source=await fs.readFile(CHAT+'/modules/ipc/agentHandlers.js','utf8');
 const handlers={};
 const start=source.indexOf("    ipcMain.handle('create-agent'");
 const end=source.indexOf("    ipcMain.handle('delete-agent'",start);
 assert(start>=0&&end>start);
 require('node:vm').runInNewContext(source.slice(start,end),{
  ipcMain:{handle:(name,fn)=>{handlers[name]=fn;}},fs,path:require('node:path'),crypto:require('node:crypto'),
  AGENT_DIR:agents,historyMutationQueue:desktop.queue,agentConfigManager:new AgentConfigManager(agents),
  conversationKey,invalidateCaches(){},console:{error(){}}
 });
 const topics=[{id:'default',name:'主要对话'},{id:'extra',name:'第二话题'}];
 const name='native_create';
 const result=await handlers['create-agent']({},name,{topics});
 assert.equal(result.success,true,result.error);
 const matching=()=>f.shared.directory(f.actor('B'),{sharedSpaceId:'sharedAB'}).objects.filter(o=>!o.deleted);
 const owners=matching().filter(o=>o.kind==='agent'&&o.config.name===name);
 assert.equal(owners.length,1);
 assert.equal(matching().filter(o=>o.parentId===owners[0].id&&o.kind==='topic').length,topics.length);
 for(const {id} of topics){
  assert.deepEqual(JSON.parse(await fs.readFile(desktop.queue.getHistoryPath(result.agentId,id),'utf8')),[]);
 }
 const initialObjects=matching().filter(o=>o.id===owners[0].id||o.parentId===owners[0].id);
 for(const object of initialObjects){
  assert.equal(desktop.runtime.needsMaterialization(desktop.runtime.state.objects[object.id]),false,
   'a newly registered object must not open a second authority transition on first read');
 }
 const firstSnapshot=await desktop.queue.readSnapshot({itemType:'agent',itemId:result.agentId,topicId:'default'});
 assert.deepEqual(firstSnapshot.history,[]);
 const before=await fs.readdir(agents);desktop.runtime.readOnly=true;
 const refused=await handlers['create-agent']({},'readonly');
 assert.equal(refused.error,'SHARED_READ_ONLY');assert.deepEqual(await fs.readdir(agents),before);
 assert.equal(f.calls(),0);
});

test('native group creation opens the initial histories and publishes one shared group',async t=>{
 const {CHAT}=require('./fixtures/sharedSingleHarness.cjs');
 const f=await fixture(t),desktop=await f.desktop('A');
 const groups=require(CHAT+'/Groupmodules/groupchat');
 groups.initializePaths({APP_DATA_ROOT_IN_PROJECT:desktop.data,USER_DATA_DIR:desktop.data+'/UserData',AGENT_DIR:desktop.data+'/Agents'});
 groups.initializeRuntimeServices({historyMutationQueue:desktop.queue});
 const topics=[{id:'first',name:'主要群聊'},{id:'extra',name:'另一话题'}];
 const create=await groups.createAgentGroup('native_group_create',{topics});
 assert.equal(create.success,true,create.error);
 const objects=f.shared.directory(f.actor('B'),{sharedSpaceId:'sharedAB'}).objects.filter(o=>!o.deleted);
 const matches=objects.filter(o=>o.kind==='group'&&o.config.name==='native_group_create');
 assert.equal(matches.length,1);
 assert.equal(objects.filter(o=>o.kind==='topic'&&o.parentId===matches[0].id).length,topics.length);
 for(const {id} of topics){
  const d={itemType:'group',itemId:create.agentGroup.id,topicId:id};
  assert.deepEqual((await desktop.queue.readSnapshot(d)).history,[]);
  assert.deepEqual(JSON.parse(await fs.readFile(desktop.queue.getHistoryPath(d.itemId,id),'utf8')),[]);
 }
 const groupDir=desktop.data+'/AgentGroups',prior=await fs.readdir(groupDir);
 desktop.runtime.readOnly=true;
 assert.equal((await groups.createAgentGroup('refused')).error,'SHARED_READ_ONLY');
 assert.deepEqual(await fs.readdir(groupDir),prior);
 assert.equal(f.calls(),0);
});

test('main group send resumes the accepted message and completes an invite-only turn without a model',async t=>{
 const {CHAT}=require('./fixtures/sharedSingleHarness.cjs'),f=await fixture(t);
 const group=f.shared.create(f.actor('A'),{sharedSpaceId:'sharedAB',opId:'group-entry',kind:'group',localId:'entry-group',config:{name:'Entry group',mode:'invite_only',members:[f.owner.id]}}).object;
 const topic=f.shared.create(f.actor('A'),{sharedSpaceId:'sharedAB',opId:'entry-topic',kind:'topic',localParent:'entry-group',localId:'main',parentId:group.id,config:{name:'Main'}}).object;
 const {runtime,queue,data}=await f.desktop('A'),d={itemType:'group',itemId:runtime.localFor(group.id).localId,topicId:runtime.localFor(topic.id).localId};
 const message={id:'group_entry_user',role:'user',content:'one question',timestamp:1};
 const first=await runtime.prepareSharedSend({descriptor:d,message});
 const groupChat=require(CHAT+'/Groupmodules/groupchat');
 groupChat.initializePaths({APP_DATA_ROOT_IN_PROJECT:data,AGENT_DIR:data+'/Agents',USER_DATA_DIR:data+'/UserData',SETTINGS_FILE:data+'/settings.json'});
 groupChat.initializeRuntimeServices({historyMutationQueue:queue});
 const context=require(CHAT+'/modules/services/conversationContext');
 context.initialize({load:owner=>groupChat.getAgentGroupConfig(owner.id),workspace:()=>({}),rules:async()=>[]});
 t.after(()=>context.initialize(null));
 const src=await fs.readFile(CHAT+'/modules/ipc/groupChatHandlers.js','utf8');
 const i=src.indexOf("    ipcMain.handle('send-group-chat-message'"),j=src.indexOf("    ipcMain.handle('inviteAgentToSpeak'",i);
 const prelude=src.slice(src.indexOf('    const coreGroup = '),src.indexOf("    ipcMain.handle('get-group-chat-history'"));
 let handler;const sender={};
 require('node:vm').runInNewContext(prelude+src.slice(i,j),{ipcMain:{handle:(n,fn)=>{handler=fn;}},mainWindow:{webContents:sender},historyMutationQueue:queue,
  groupChat,topicAdmission:{submit(){throw Error('unexpected local submission');}},createStreamSender:()=>()=>{},getAgentConfigById:()=>{}});
 const result=await handler({sender},d.itemId,d.topicId,{...message,content:{text:message.content},originalUserText:message.content});
 assert.equal(result.success,true,result.error);assert.equal(first.record.phase,'completed');
 assert.deepEqual((await queue.readSnapshot(d)).history.map(m=>m.id),[message.id]);assert.equal(f.calls(),0);
});

test('shared group settings publish tags only for current members',async t=>{
 const f=await fixture(t),{runtime}=await f.desktop('A');
 const cfg=runtime.host.projectOwner('group',{name:'two now one',members:['kept'],mode:'invite_only',memberTags:{kept:'one',former:'two'}});
 assert.deepEqual(cfg.memberTags,{kept:'one'});
});
test('native group invitation checks topic membership against the host when the frozen config omits topics',async t=>{
 const {CHAT}=require('./fixtures/sharedSingleHarness.cjs');
 const f=await fixture(t),{data}=await f.desktop('A'),path=require('node:path');
 const source=await fs.readFile(CHAT+'/Groupmodules/groupchat.js','utf8');
 const begin=source.indexOf('async function assertNativeGroupTopic('),end=source.indexOf('async function readLatestGroupHistory',begin);
 assert(begin>=0&&end>begin);
 const id='guarded-group',topic='new-topic',root=path.join(data,'AgentGroups'),dir=path.join(root,id),file=path.join(dir,'config.json'),history=path.join(data,'UserData',id,'topics',topic,'history.json');
 await fs.mkdir(dir);await fs.mkdir(path.dirname(history),{recursive:true});await fs.writeFile(history,'[]');await fs.writeFile(file,JSON.stringify({topics:[{id:topic}]}));
 const guard=require('node:vm').runInNewContext(source.slice(begin,end)+';assertNativeGroupTopic',{sharedGroup:{current:()=>true},fs:{readJson:async p=>JSON.parse(await fs.readFile(p)),pathExists:async p=>fs.access(p).then(()=>true,()=>false)},path,mainAppPaths:{AGENT_GROUPS_DIR:root}});
 await guard(id,topic,{members:[]},history);await fs.writeFile(file,JSON.stringify({topics:[]}));
 await assert.rejects(guard(id,topic,{topics:[{id:topic}]},history),/已不存在/);
});

test('shared group composer can hand off its own input while checkpoints stay blocked',async()=>{
 const {CHAT}=require('./fixtures/sharedSingleHarness.cjs');
 const src=await fs.readFile(CHAT+'/modules/chatManager.js','utf8'),i=src.indexOf('        let sendAuthority;'),j=src.indexOf('        if (!isSendContextCurrent()) return;',i);
 assert(i>=0&&j>i);
 const mayContinue=require('node:vm').runInNewContext('(async request=>{'+src.slice(i,j)+'return true;})',{
  executionAuthority:async()=>({success:true,kind:'shared'}),electronAPI:{prepareSharedSend(){}},
  sendContext:{itemType:'group',agentId:'group',topicId:'topic'},uiHelper:{showToastNotification(){}}
 });
 assert.equal(await mayContinue(null),true);
 assert.equal(await mayContinue({checkpointMessageId:'checkpoint'}),undefined);
 assert.equal(await mayContinue({conversation:{}}),undefined);
});

test('native Agent rule override keeps directory materialization out until the accepted save finishes',async t=>{
 const f=await fixture(t),a=await f.desktop('A'),runtime=a.runtime;
 const owner={type:'agent',id:a.descriptor.itemId};
 const rule={id:'pilot_rule',name:'Pilot rule',type:'system_suffix',enabled:true,content:'synthetic rule',scope:'global',source:'user'};
 await runtime.saveNativeRules({rules:[rule],__nativeSyncSharedBase:runtime.nativeRulesContext()});
 const base={sharedId:f.owner.id,version:runtime.configs.state.objects[f.owner.id].version};
 const send=runtime.configs.send;
 const accepted=Promise.withResolvers(),resume=Promise.withResolvers();
 runtime.configs.send=async (...args)=>{
  const result=await send(...args);
  if(args[1]?.body?.sharedId===f.owner.id){accepted.resolve();await resume.promise;}
  return result;
 };
 const save=runtime.saveNativeRuleOverride(owner,{kind:'rule',key:'user:pilot_rule',value:false,__nativeSyncSharedBase:base});
 void save.then(()=>accepted.resolve(),accepted.reject);
 await accepted.promise;
 let responseReleased=false,directoryEnteredEarly=false;
 const tick=runtime.serialCore(async()=>{
  // Record a regression without leaving the fixture in a deadlocked state.
  directoryEnteredEarly=!responseReleased;
  if(!directoryEnteredEarly)await runtime.tickCore({forceLocal:true});
 });
 await new Promise(setImmediate);
 responseReleased=true;
 resume.resolve();
 assert.equal((await save).sharedVersion,base.version+1);
 await tick;
 assert.equal(directoryEnteredEarly,false);
 assert.equal((await runtime.host.readNativeOwner(owner.type,owner.id)).conversationOverrides.rules['user:pilot_rule'],false);
 assert.equal(f.calls(),0);
});

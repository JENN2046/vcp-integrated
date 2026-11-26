'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {extractAgentDTO}=require('../../../VCPDistributedServer/Plugin/VCPMobileSync/dto/agent.dto');
const {extractGroupDTO}=require('../../../VCPDistributedServer/Plugin/VCPMobileSync/dto/group.dto');
const {assertHistoryPath}=require('./sourceDirectory');
const {ownedJson}=require('./sharedLocal');
const {durableJson}=require('./durableJson');
const {fail,stable}=require('./protocol');
const activeRoots=new Map(),groupTails=new Map();
const ruleFields=['id','name','type','enabled','content','scope','builtinKey','isBuiltin','role','depth','wrap','order','source'];
const projectRules=rules=>(rules||[]).map(r=>Object.fromEntries(ruleFields.filter(k=>Object.hasOwn(r,k)).map(k=>[k,r[k]])));
function rootOwns(file){return [...activeRoots.keys()].some(root=>path.resolve(file).startsWith(root+path.sep));}
async function writeNativeJson(file,value,fallback){return rootOwns(file)?durableJson(file,value):fallback();}
function serializeGroup(file,fn){
 if(!rootOwns(file))return fn();
 const key=process.platform==='win32'?file.toLowerCase():file,previous=groupTails.get(key)||Promise.resolve();
 const next=previous.catch(()=>{}).then(fn);groupTails.set(key,next);
 next.finally(()=>{if(groupTails.get(key)===next)groupTails.delete(key);}).catch(()=>{});return next;
}
function agentProjection(raw){
 const dto=extractAgentDTO(raw);
 return {...dto,avatar:raw.avatar||null,stripRegexes:raw.stripRegexes||[],tavernRules:raw.nativeSyncSharedRules||raw.tavernRules||[],ruleOverrides:raw.conversationOverrides?.rules||raw.ruleOverrides||{}};
}
function groupProjection(raw){
 const {createdAt,...dto}=extractGroupDTO(raw),members=dto.members||[];
 const order=raw.modeSettings?.sequential?.speakerOrder||raw.sequentialSpeakerOrder||members;
 if(dto.memberTags)dto.memberTags=Object.fromEntries(Object.entries(dto.memberTags).filter(([id])=>members.includes(id)));
 return {...dto,avatar:raw.avatar||null,tavernRules:raw.nativeSyncSharedRules||raw.tavernRules||[],ruleOverrides:raw.conversationOverrides?.rules||raw.ruleOverrides||{},sequentialSpeakerOrder:[...order],modeSettings:{sequential:{speakerOrder:[...order]}}};
}
function projectNativeConfig(runtime,kind,raw,base){
 const value=runtime.host.projectOwner(kind,{
  ...raw,
  stripRegexes:raw.stripRegexes===undefined?base.stripRegexes:raw.stripRegexes,
  conversationOverrides:{...raw.conversationOverrides,rules:raw.conversationOverrides?.rules??raw.ruleOverrides??base.ruleOverrides??{}},
  nativeSyncSharedRules:raw.nativeSyncSharedRules||base.tavernRules,
  avatar:base.avatar,
 });
 return kind==='group'?runtime.groupToShared(value):value;
}
function policyProjection(s={}){return {userName:s.userName||'用户',enableThoughtChainInjection:s.enableThoughtChainInjection===true,enableContextSanitizer:s.enableContextSanitizer===true,contextSanitizerDepth:s.contextSanitizerDepth===undefined?2:Number(s.contextSanitizerDepth),enableVcpToolInjection:s.enableVcpToolInjection===true,
 ...(typeof s.enableContextCompaction==='boolean'&&{enableContextCompaction:s.enableContextCompaction}),
 ...Object.fromEntries(['contextCompactionModel','contextCompactionFallbackModel']
  .filter(key=>typeof s[key]==='string').map(key=>[key,s[key].trim()]))};}
function createSharedHost({appDataRoot,agentConfigManager,groupChat,tavernHandlers,settingsManager,readSettings,thumbnail,prepareViews,notify=()=>{}}){
 const root=path.resolve(appDataRoot);
 if(!agentConfigManager?.readAgentConfig||!agentConfigManager.updateAgentConfig||!agentConfigManager.writeAgentConfig)throw fail('SHARED_NATIVE_CONFIG_AUTHORITY_REQUIRED');
 const folder=kind=>kind==='agent'?'Agents':kind==='group'?'AgentGroups':null;
 const file=(kind,id)=>{require('./protocol').identity({ownerType:kind,ownerId:id,topicId:'_',msgId:'_'});return path.join(root,folder(kind),id,'config.json');};
 const read=async(kind,id)=>{
  const raw=await ownedJson(root,file(kind,id),{optional:true});if(!raw)return null;
  if(kind==='agent')return agentConfigManager.readAgentConfig(id);
  if(!groupChat?.getAgentGroupConfig)throw fail('SHARED_NATIVE_GROUP_AUTHORITY_REQUIRED');return groupChat.getAgentGroupConfig(id);
 };
 const update=async(kind,id,fn,{existingOnly=false}={})=>{
  const exists=await ownedJson(root,file(kind,id),{optional:true});
  if(!exists&&existingOnly)throw fail('SHARED_LOCAL_MAPPING_REQUIRED');
  if(kind==='agent'){
   if(exists)return agentConfigManager.updateAgentConfig(id,fn);
   return agentConfigManager.writeAgentConfig(id,fn({topics:[]}));
  }
  let result;
  if(exists){
   if(!groupChat?.mutateGroupConfig)throw fail('SHARED_NATIVE_GROUP_AUTHORITY_REQUIRED');
   result=await groupChat.mutateGroupConfig(id,fn);
  }else{
   if(!groupChat?.initializeAgentGroupConfig)throw fail('SHARED_NATIVE_GROUP_AUTHORITY_REQUIRED');
   result=await groupChat.initializeAgentGroupConfig(id,fn({topics:[]}));
  }
  if(result?.success===false)throw fail('SHARED_NATIVE_GROUP_WRITE_FAILED');return result;
 };
 let applyRuleStore;
 const host={capability:'shared-space-v1',
  activate(runtime){
   if(tavernHandlers?.setRuleProvider){
    const {createTavernRuleProvider}=require('./tavernRuleProvider');
    const provider=createTavernRuleProvider(runtime,()=>activeRoots.get(root)===runtime);
    applyRuleStore=tavernHandlers.setRuleProvider(root,provider);
   }
   activeRoots.set(root,runtime);
   const policyChanged=settings=>{
    if(runtime.closed||runtime.readOnly||runtime.waitClient?.mode!=='watch')return;
    const rules=Object.values(runtime.configs.state.objects).find(object=>object.kind==='rules');
    const expected=(rules?.materialized||rules?.config)?.executionPolicy;
    if(!settings||!require('node:util').isDeepStrictEqual(policyProjection(settings),expected))runtime.changed?.();
   };
   const externalSettings=event=>policyChanged(event?.settings);
   const uncertainSettings=()=>policyChanged(null);
   settingsManager?.on?.('settings-updated',policyChanged);
   settingsManager?.on?.('settings-external-updated',externalSettings);
   settingsManager?.on?.('settings-external-error',uncertainSettings);
   return ()=>{
    settingsManager?.off?.('settings-updated',policyChanged);
    settingsManager?.off?.('settings-external-updated',externalSettings);
    settingsManager?.off?.('settings-external-error',uncertainSettings);
    if(activeRoots.get(root)!==runtime)return;
    tavernHandlers?.setRuleProvider?.(root,null);applyRuleStore=null;activeRoots.delete(root);
   };
  },notify,prepareViews,
  projectOwner(kind,raw){return kind==='agent'?agentProjection(raw):groupProjection(raw);},
  projectPolicy:policyProjection,
  projectRuleStore(rules){if(!tavernHandlers?.engine)return projectRules(rules);const split=tavernHandlers.engine.splitRuleStore({version:3,rules});return projectRules(tavernHandlers.engine.combineRuleStores(split.officialStore,split.userStore).rules);},
  readNativeOwner:read,
  async nativeAvatarUrl(kind,id){const dir=path.join(root,folder(kind),id);for(const name of ['avatar.png','avatar.jpg','avatar.webp']){try{await fs.access(path.join(dir,name));return require('node:url').pathToFileURL(path.join(dir,name)).href;}catch(e){if(e.code!=='ENOENT')throw e;}}return null;},
  async normalizeAvatar(data){const bytes=Buffer.from(data?.buffer||[]),type=String(data?.type||'');if(!bytes.length||bytes.length>20*1024*1024||!['image/png','image/jpeg','image/webp','image/gif'].includes(type))throw fail('INVALID_AVATAR');if(bytes.length<=18000&&type!=='image/gif')return 'data:'+type+';base64,'+bytes.toString('base64');if(!thumbnail)throw fail('SHARED_AVATAR_PROJECTION_REQUIRED');return thumbnail(bytes);},
  async readTopic(kind,id,topicId){const raw=await read(kind,id),topic=raw?.topics?.find(t=>t.id===topicId);return topic?{name:topic.name||topicId,archived:topic.archived===true}:null;},
  async readOwner(kind,id){const raw=await read(kind,id);if(!raw)return null;const value={...raw,avatar:await require('./sharedAvatar').readAvatar(root,path.join(root,folder(kind),id),thumbnail)};if(kind==='agent')value.stripRegexes=await ownedJson(root,path.join(root,'Agents',id,'regex_rules.json'),{optional:true})||[];return host.projectOwner(kind,value);},
  async writeOwner(kind,id,value){
   const {avatar,stripRegexes,tavernRules,ruleOverrides,...fields}=value;
   if(kind==='group')fields.modeSettings={...fields.modeSettings,naturerandom:{memberTags:fields.memberTags||{},tagMatchMode:fields.tagMatchMode||'strict'}};
   await update(kind,id,raw=>({...raw,...fields,...(kind==='group'?{avatar:avatar?'avatar.'+(avatar.startsWith('data:image/jpeg;')?'jpg':avatar.startsWith('data:image/webp;')?'webp':'png'):null}:{}),nativeSyncSharedRules:tavernRules||[],conversationOverrides:{...raw.conversationOverrides,rules:ruleOverrides||{}}}));
   if(kind==='agent')await durableJson(path.join(root,'Agents',id,'regex_rules.json'),stripRegexes||[]);
   if(await require('./sharedAvatar').readAvatar(root,path.join(root,folder(kind),id),thumbnail)!==(avatar||null))await require('./sharedAvatar').writeAvatar(root,path.join(root,folder(kind),id),avatar||null);
  },
  async writeNativeExtras(kind,id,patch){return update(kind,id,raw=>{const excluded=new Set([...Object.keys(host.projectOwner(kind,{...raw,stripRegexes:[]})),'topics','id','agentDataPath','avatarUrl','_historyDeleting','_historyDeletedTopics','nativeSyncOriginSource','__nativeSyncSharedBase','__nativeSyncSharedOpId','nativeSyncSharedRules','conversationOverrides']);const extra=Object.fromEntries(Object.entries(patch).filter(([key])=>!excluded.has(key)));return {...raw,...extra,...(patch.conversationOverrides?{conversationOverrides:{...raw.conversationOverrides,...patch.conversationOverrides,rules:raw.conversationOverrides?.rules||{}}}:{})};},{existingOnly:true});},
  async detachTopic(kind,ownerId,topicId){return update(kind,ownerId,raw=>({...raw,topics:(raw.topics||[]).filter(t=>t.id!==topicId)}));},
  async retainTopics(kind,ownerId,ids){return update(kind,ownerId,raw=>({...raw,topics:(raw.topics||[]).filter(t=>ids.includes(t.id))}));},
  async ensureTopic(kind,ownerId,topic){return update(kind,ownerId,raw=>({...raw,topics:[...(raw.topics||[]).filter(t=>t.id!==topic.id),{...(raw.topics||[]).find(t=>t.id===topic.id),...topic}]}));},
  async readRules(){
   if(!tavernHandlers?.readSharedRules)throw fail('SHARED_NATIVE_RULE_AUTHORITY_REQUIRED');return projectRules(await tavernHandlers.readSharedRules());
  },
  async writeRules(rules){
   if(!tavernHandlers?.writeStore)throw fail('SHARED_NATIVE_RULE_AUTHORITY_REQUIRED');
   const store={version:3,rules};
   const result=applyRuleStore?await applyRuleStore(store):await tavernHandlers.writeStore(store,{materializing:true});
   if(result?.success===false)throw fail('SHARED_NATIVE_RULE_WRITE_FAILED');
  },
  async readPolicy(){return policyProjection(await(readSettings?readSettings():settingsManager.readSettings()));},
  async writePolicy(policy){if(!settingsManager?.updateSettings)throw fail('SHARED_NATIVE_SETTINGS_AUTHORITY_REQUIRED');return settingsManager.updateSettings(s=>({...s,...policy}));},
 };
 return host;
}
function runtimeForRoot(root){return activeRoots.get(path.resolve(root));}
async function belongsToSharedRoot(root){
 const data=path.join(root,'.native-sync');
 const connection=await ownedJson(root,path.join(data,'connection.json'),{optional:true});
 if(connection?.sharedSpaceId||connection?.sharedJoinOpId)return true;
 const state=await ownedJson(root,path.join(data,'state.json'),{optional:true});
 if(state?.sharedSpaceId)return true;
 const shared=path.join(data,'shared');
 await assertHistoryPath(root,path.join(shared,'_authority'));
 try{return (await fs.readdir(shared)).length>0;}catch(error){if(error.code==='ENOENT')return false;throw error;}
}
module.exports={createSharedHost,writeNativeJson,serializeGroup,projectRules,runtimeForRoot,belongsToSharedRoot,projectNativeConfig};

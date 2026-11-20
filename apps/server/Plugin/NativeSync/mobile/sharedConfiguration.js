'use strict';
const {sha256,stable}=require('../sync/protocol');
const {sharedEffectiveRules,sharedAgentExecution}=require('../sync/contracts.generated.cjs');
const fail=code=>Object.assign(Error(code),{code,status:409});
const agentFields=['name','systemPrompt','model','temperature','contextTokenLimit','maxOutputTokens','streamOutput','tavernRules','stripRegexes'];
const project=raw=>{const value=sharedAgentExecution(raw);return Object.fromEntries(agentFields.filter(k=>Object.hasOwn(value,k)).map(k=>[k,value[k]]));};

// A shared ID or uploaded alias is not native prompt authority. Reuse only an
// explicit server Source/owner mapping and an accepted originating binding.
function approvedAlias(configs,shared,object){
 if(!configs.hasAgentReference(object.config.systemPrompt||'').length)return undefined;
 const bindings=shared.db.prepare("SELECT local_id FROM shared_local_bindings WHERE space_id=? AND source_id=? AND object_id=? AND kind='agent' AND hidden=0").all(object.sharedSpaceId,object.originSource,object.id);
 const names=new Set(bindings.map(b=>b.local_id));
 const matches=(configs.sourceCatalog.staticTopics||[]).filter(t=>t.sourceId===object.originSource&&t.ownerType==='agent'&&names.has(t.ownerId)&&typeof t.agentAlias==='string');
 const aliases=[...new Set(matches.map(t=>t.agentAlias))];
 if(aliases.length>1)throw fail('CONFIG_PROMPT_AUTHORITY_CONFLICT');
 return aliases[0];
}
async function prepareSharedConfiguration(configs,topic,{desktopContext=false}={}){
 const shared=configs.sourceCatalog?.store?.shared;
 if(!shared||!topic.sharedSpaceId)return null;
 if(shared.readOnly)throw fail('SHARED_READ_ONLY');
 const row=shared.row(topic.sharedSpaceId,topic.key),frozen=shared.freeze(row);
 if(frozen.rules.length>1)throw fail('SHARED_GLOBAL_RULES_CONFLICT');
 const globals=frozen.rules[0]?.config||{},owner=frozen.owner;
 const tavernRules=sharedEffectiveRules([...(globals.tavernRules||[]),...(owner.config.tavernRules||[])],owner.config.ruleOverrides||{}),executionPolicy=globals.executionPolicy||{};
 let input;
 if(owner.kind==='group'){
  const {avatar,tavernRules:_,ruleOverrides:__,...group}=owner.config;
  input={group,agents:frozen.members.map(member=>({id:member.id,...project(member.config)})),tavernRules,executionPolicy};
 }else input={...project(owner.config),tavernRules,executionPolicy};
 const nativeTopic={...topic,...(owner.kind==='agent'?{agentAlias:approvedAlias(configs,shared,owner)}:{memberAliases:Object.fromEntries(frozen.members.map(m=>[m.id,approvedAlias(configs,shared,m)]))})};
 const value=await configs.normalize(nativeTopic,input,{desktopContext});
 if(shared.freeze(row).hash!==frozen.hash)throw fail('SHARED_CONFIG_PENDING');
 value.sharedTemplateHash=frozen.hash;const hash=sha256(stable(value));
 shared.atomic(()=>{
  const latest=configs.latest(topic.key);
  if(latest?.hash!==hash)configs.db.prepare('INSERT INTO owner_execution_configs(topic_key,version,hash,config_json,created_at) VALUES(?,?,?,?,?)').run(topic.key,(latest?.version||0)+1,hash,JSON.stringify(value),Date.now());
  configs.db.prepare('DELETE FROM native_sync_metadata WHERE key=?').run('sourceExecutionIssue:'+topic.key);
 });
 // Desktop keeps local placeholders for its own native evaluator. Mobile must
 // still pass the portability check before accepting or dispatching anything.
 const latest=configs.latest(topic.key);
 return configs.verify(topic,{version:latest.version,hash:latest.hash,...JSON.parse(latest.config_json)},{desktopContext});
}
function refreshSharedConfigurations(configs){
 if(configs.sharedPreparing)return configs.sharedPreparing;
 const shared=configs.sourceCatalog?.store?.shared;if(!shared||shared.readOnly)return Promise.resolve();
 const topics=configs.topics.filter(t=>t.sharedSpaceId&&!t.directoryDeleted);if(!topics.length)return Promise.resolve();
 const topic=topics[(configs.sharedOffset||0)%topics.length];configs.sharedOffset=(configs.sharedOffset||0)+1;
 const hash=shared.freeze(shared.row(topic.sharedSpaceId,topic.key)).hash;
 if(configs.sharedValidated?.get(topic.key)===hash)return Promise.resolve();
 configs.sharedPreparing=prepareSharedConfiguration(configs,topic).then(()=>{
  configs.sharedValidated||=new Map();configs.sharedValidated.set(topic.key,hash);
 }).catch(error=>{
  configs.db.prepare('INSERT INTO native_sync_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('sourceExecutionIssue:'+topic.key,JSON.stringify({code:error.code||'SHARED_CONFIG_PENDING'}));
 }).finally(()=>{configs.sharedPreparing=null;});return configs.sharedPreparing;
}
module.exports={prepareSharedConfiguration,refreshSharedConfigurations};

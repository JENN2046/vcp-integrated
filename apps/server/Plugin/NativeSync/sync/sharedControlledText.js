'use strict';
const MODE='text-only-v1',CAPABILITY='shared-controlled-text-v1';
const TOOLS_MODE='safe-tools-v1',TOOLS_CAPABILITY='shared-controlled-tools-v1';
const TOOL_PAIR_CAPABILITY='shared-controlled-tool-pair-v1';
const TOOLS_HISTORY_CAPABILITY='shared-controlled-tools-history-v1';
const AA_MODE='agent-assistant-v1',AA_CAPABILITY='shared-controlled-aa-v1';
const transferable=mode=>mode===TOOLS_MODE||mode===AA_MODE;
const isControlled=mode=>mode===MODE||transferable(mode);
const hasCapability=(actor,capability)=>actor?.kind==='desktop'&&String(actor.capabilities||'').split(',').includes(capability);
function assertAAClient(actor,mode){
 if(mode===AA_MODE&&!hasCapability(actor,AA_CAPABILITY))throw fail('SHARED_CLIENT_UPGRADE_REQUIRED');
}
function allowedAgents(raw='[]'){
 let agents;try{agents=JSON.parse(raw||'[]');}catch{throw fail('INVALID_SHARED_AA_AGENTS');}
 if(!Array.isArray(agents)||agents.length>32||new Set(agents).size!==agents.length||
  agents.some(name=>typeof name!=='string'||!name||name.length>160||name.trim()!==name||/[\x00-\x1f\x7f]/.test(name)))throw fail('INVALID_SHARED_AA_AGENTS');
 return new Set(agents);
}
function allowedTools(raw='[]'){
 let tools;try{tools=JSON.parse(raw||'[]');}catch{throw fail('INVALID_SHARED_SAFE_TOOLS');}
 if(!Array.isArray(tools)||tools.length>32||tools.some(name=>typeof name!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(name)))throw fail('INVALID_SHARED_SAFE_TOOLS');
 return new Set(tools);
}
function enabled(shared,mode){
 const policy=require('./releasePolicy.cjs');
 if(mode===MODE)return policy.sharedControlledText;
 if(mode===TOOLS_MODE)return policy.sharedControlledText&&shared.safeTools?.size>0;
 if(mode===AA_MODE)return policy.sharedControlledText&&shared.delegationAgents?.size>0&&
  require('../../../modules/requestExecutionContext').hasNativeTaskProvider('AgentAssistant');
 return policy.sharedSteering;
}
const fail=code=>Object.assign(Error(code),{code,status:409});
const local=value=>/\{\{VCPChat(?:Canvas|WorkSpace)(?::[^{}]*)?\}\}/.test(value||'');
function assertPortable(shared,topic,config,message){
 const rows=shared.store.readProjected(()=>shared.db.prepare('SELECT * FROM messages WHERE owner_type=? AND owner_id=? AND topic_id=? AND deleted=0').all(topic.owner_type,topic.owner_id,topic.topic_id));
 if([message,...rows.map(row=>row.message)].some(value=>value?.desktopReferences?.length||value?.attachments?.length||typeof value?.content!=='string'||local(value.content))||local(JSON.stringify([config.owner.config,config.rules])))throw fail('CONTROLLED_TEXT_PORTABLE_REQUIRED');
}
function admit(shared,actor,topic,config,body,turn){
 if(body.delegation!==undefined&&body.controlMode!==AA_MODE)throw fail('INVALID_SHARED_AA_DELEGATION');
 if(body.controlMode===undefined)return false;
 if(!isControlled(body.controlMode))throw fail('CONTROLLED_MODE_UNSUPPORTED');
 if(!shared.native?.engine||!enabled(shared,body.controlMode)||actor.kind!=='desktop'||!hasCapability(actor,body.controlMode===AA_MODE?AA_CAPABILITY:body.controlMode===TOOLS_MODE?TOOLS_CAPABILITY:CAPABILITY)||config.owner.kind!=='agent'||turn.kind!=='message')throw fail('CONTROLLED_TEXT_UNAVAILABLE');
 if(typeof body.message?.content!=='string'||!body.message.content.trim())throw fail('INVALID_SHARED_SUBMISSION');
 if(body.controlMode===AA_MODE){
  const delegation=body.delegation;
  if(!delegation||typeof delegation!=='object'||Object.keys(delegation).length!==1||!Object.hasOwn(delegation,'agentName')||!shared.delegationAgents.has(delegation.agentName)||
   body.sponsorRouteHash!==undefined)throw fail('INVALID_SHARED_AA_DELEGATION');
  turn.delegation={agentName:delegation.agentName};
 }
 assertPortable(shared,topic,config,body.message);
 if(body.controlMode===TOOLS_MODE&&actor.capabilities.split(',').includes(TOOL_PAIR_CAPABILITY))turn.toolBatchLimit=2;
 return true;
}
function assertWork(shared,row,topic,actor,message={content:'',attachments:[]}){if(isControlled(require('./sharedTurns').intent(row).controlMode))assertPortable(shared,topic,shared.freezeForExecution(actor,topic),message);}
module.exports={MODE,CAPABILITY,TOOLS_MODE,TOOLS_CAPABILITY,TOOL_PAIR_CAPABILITY,TOOLS_HISTORY_CAPABILITY,AA_MODE,AA_CAPABILITY,transferable,isControlled,enabled,allowedTools,allowedAgents,assertAAClient,admit,assertPortable,assertWork,local};

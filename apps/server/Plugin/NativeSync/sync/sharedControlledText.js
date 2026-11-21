'use strict';
const MODE='text-only-v1',CAPABILITY='shared-controlled-text-v1';
const TOOLS_MODE='safe-tools-v1',TOOLS_CAPABILITY='shared-controlled-tools-v1';
const isControlled=mode=>mode===MODE||mode===TOOLS_MODE;
function allowedTools(raw='[]'){
 let tools;try{tools=JSON.parse(raw||'[]');}catch{throw fail('INVALID_SHARED_SAFE_TOOLS');}
 if(!Array.isArray(tools)||tools.length>32||tools.some(name=>typeof name!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(name)))throw fail('INVALID_SHARED_SAFE_TOOLS');
 return new Set(tools);
}
function enabled(shared,mode){
 const policy=require('./releasePolicy.cjs');
 if(mode===MODE)return policy.sharedControlledText;
 if(mode===TOOLS_MODE)return policy.sharedControlledText&&shared.safeTools?.size>0;
 return policy.sharedSteering;
}
const fail=code=>Object.assign(Error(code),{code,status:409});
const local=value=>/\{\{VCPChat(?:Canvas|WorkSpace)(?::[^{}]*)?\}\}/.test(value||'');
function assertPortable(shared,topic,config,message){
 const rows=shared.store.readProjected(()=>shared.db.prepare('SELECT * FROM messages WHERE owner_type=? AND owner_id=? AND topic_id=? AND deleted=0').all(topic.owner_type,topic.owner_id,topic.topic_id));
 if([message,...rows.map(row=>row.message)].some(value=>value?.desktopReferences?.length||value?.attachments?.length||typeof value?.content!=='string'||local(value.content))||local(JSON.stringify([config.owner.config,config.rules])))throw fail('CONTROLLED_TEXT_PORTABLE_REQUIRED');
}
function admit(shared,actor,topic,config,body,turn){
 if(body.controlMode===undefined)return false;
 if(!isControlled(body.controlMode))throw fail('CONTROLLED_MODE_UNSUPPORTED');
 if(!shared.native?.engine||!enabled(shared,body.controlMode)||actor.kind!=='desktop'||!String(actor.capabilities||'').split(',').includes(body.controlMode===TOOLS_MODE?TOOLS_CAPABILITY:CAPABILITY)||config.owner.kind!=='agent'||turn.kind!=='message')throw fail('CONTROLLED_TEXT_UNAVAILABLE');
 if(typeof body.message?.content!=='string'||!body.message.content.trim())throw fail('INVALID_SHARED_SUBMISSION');
 assertPortable(shared,topic,config,body.message);return true;
}
function assertWork(shared,row,topic,actor,message={content:'',attachments:[]}){if(isControlled(require('./sharedTurns').intent(row).controlMode))assertPortable(shared,topic,shared.freezeForExecution(actor,topic),message);}
module.exports={MODE,CAPABILITY,TOOLS_MODE,TOOLS_CAPABILITY,isControlled,enabled,allowedTools,admit,assertPortable,assertWork,local};

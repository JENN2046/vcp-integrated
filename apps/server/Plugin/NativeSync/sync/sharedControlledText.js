'use strict';
const MODE='text-only-v1',CAPABILITY='shared-controlled-text-v1';
const fail=code=>Object.assign(Error(code),{code,status:409});
const local=value=>/\{\{VCPChat(?:Canvas|WorkSpace)(?::[^{}]*)?\}\}/.test(value||'');
function assertPortable(shared,topic,config,message){
 const rows=shared.store.readProjected(()=>shared.db.prepare('SELECT * FROM messages WHERE owner_type=? AND owner_id=? AND topic_id=? AND deleted=0').all(topic.owner_type,topic.owner_id,topic.topic_id));
 if([message,...rows.map(row=>row.message)].some(value=>value?.desktopReferences?.length||value?.attachments?.length||typeof value?.content!=='string'||local(value.content))||local(JSON.stringify([config.owner.config,config.rules])))throw fail('CONTROLLED_TEXT_PORTABLE_REQUIRED');
}
function admit(shared,actor,topic,config,body,turn){
 if(body.controlMode===undefined)return false;
 if(body.controlMode!==MODE)throw fail('CONTROLLED_MODE_UNSUPPORTED');
 if(!shared.native?.engine||!require('./releasePolicy.cjs').sharedControlledText||actor.kind!=='desktop'||!String(actor.capabilities||'').split(',').includes(CAPABILITY)||config.owner.kind!=='agent'||turn.kind!=='message')throw fail('CONTROLLED_TEXT_UNAVAILABLE');
 if(typeof body.message?.content!=='string'||!body.message.content.trim())throw fail('INVALID_SHARED_SUBMISSION');
 assertPortable(shared,topic,config,body.message);return true;
}
function assertWork(shared,row,topic,actor,message={content:'',attachments:[]}){if(require('./sharedTurns').intent(row).controlMode===MODE)assertPortable(shared,topic,shared.freezeForExecution(actor,topic),message);}
module.exports={MODE,CAPABILITY,admit,assertPortable,assertWork,local};

'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {fail,stable}=require('./protocol');
const {assertHistoryPath}=require('./sourceDirectory');
const {normalizeScope}=require('./sourceScope');
async function ownedJson(root,file,{optional=false}={}){
 await assertHistoryPath(root,file);
 try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(optional&&error.code==='ENOENT')return null;throw Object.assign(error,{code:error instanceof SyntaxError?'SHARED_LOCAL_STATE_INVALID':error.code});}
}
function settled(state,connection){
 if(!state||state.version!==3||state.deviceId!==connection.deviceId||!state.source||!Array.isArray(state.topics))throw fail('SHARED_SOURCE_STATE_REQUIRED');
 const binding=state.source.binding;
 if(binding?.sourceId!==connection.sourceId||binding.deviceId!==connection.deviceId||binding.spaceId!==connection.spaceId||normalizeScope(binding.scope))throw fail('SOURCE_BINDING_CHANGED');
 if(state.outbox?.length||state.inbox?.length||state.pending||Object.keys(state.localCommits||{}).length||Object.keys(state.drift||{}).length||state.source.pendingCatalog||Object.values(state.source.deletions||{}).some(r=>!['published','aborted'].includes(r.stage)))throw fail('SHARED_SOURCE_NOT_SETTLED');
 for(const topic of state.topics){const key=JSON.stringify({ownerId:topic.itemId,ownerType:topic.itemType||'agent',topicId:topic.topicId});const plan=state.source.plans?.[key];if(!plan||plan.stage!=='complete'||plan.error)throw fail('SHARED_SOURCE_NOT_SETTLED');}
 return state;
}
async function readSettledSource(root,connection){return settled(await ownedJson(root,path.join(root,'.native-sync/state.json')),connection);}
async function inspectShared(connection,state,send,{allowReadOnly=false}={}){
 settled(state,connection);
 const info=await send('/api/v1/sync/shared/info');
 if(info.capability!=='shared-space-v1'||info.schemaVersion!==1||info.readOnly&&!allowReadOnly||!info.spaces?.some(s=>s.id===connection.sharedSpaceId))throw fail('SHARED_SPACE_NOT_APPROVED');
 return info;
}
module.exports={ownedJson,readSettledSource,settled,inspectShared};

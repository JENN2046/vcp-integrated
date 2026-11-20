'use strict';
const {fail}=require('./protocol');
const topicKey=topic=>JSON.stringify([topic.ownerType,topic.ownerId,topic.topicId]);

// A disposable index of ACK identities, including tombstones. Values are always
// read from the current authoritative dictionary; hashes and deletion/metadata
// flags are deliberately never cached here.
function buildAckedTopicIndex(acked){
 if(!acked||typeof acked!=='object'||Array.isArray(acked))throw fail('INVALID_SYNC_STATE');
 const topics=new Map();
 for(const key of Object.keys(acked)){
  let parts;try{parts=JSON.parse(key);}catch{throw fail('INVALID_SYNC_STATE');}
  if(!Array.isArray(parts)||parts.length!==4||parts.some(value=>typeof value!=='string'))throw fail('INVALID_SYNC_STATE');
  const scope=JSON.stringify(parts.slice(0,3));let keys=topics.get(scope);if(!keys){keys=[];topics.set(scope,keys);}keys.push(key);
 }
 // Committed membership belongs to adapter.transaction's cloned next state.
 // Sealing only the key container preserves plain JSON/structuredClone and
 // allows existing values to change while preventing invisible add/delete.
 Object.seal(acked);
 return {source:acked,entries(topic){return (topics.get(topicKey(topic))||[]).map(key=>[key,acked[key]]);}};
}
module.exports={buildAckedTopicIndex};

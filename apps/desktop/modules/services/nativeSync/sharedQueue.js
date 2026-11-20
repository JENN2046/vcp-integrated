'use strict';
const {fail} = require('./protocol');
const {randomUUID}=require('node:crypto');
const key=d=>JSON.stringify([d.itemType||'agent',d.itemId,d.topicId]);

// Keep the existing durable HistoryMutationQueue and adapter receipts. Only
// descriptors cross this boundary; message identities/hashes stay canonical.
class SharedQueue {
 constructor(queue,mappings,sharedSpaceId){
  if(queue.syncPolicy&&(!queue.syncPolicy.isRecoveryFence||queue.syncPolicy.sharedSpaceId!==sharedSpaceId))throw fail('SYNC_ALREADY_ATTACHED');
  this.native=queue;this.policy=queue.syncPolicy?{...queue.syncPolicy,topics:mappings.map(m=>m.shared)}:null;this.toLocal=new Map();this.toShared=new Map();this.projections=new Set();
  this.userDataDir=queue.userDataDir;
  for(const mapping of mappings)this.add(mapping);
 }
 add({local,shared}){
  const localKey=key(local),sharedKey=key(shared);
  if(this.toLocal.has(sharedKey)&&key(this.toLocal.get(sharedKey))!==localKey||this.toShared.has(localKey)&&key(this.toShared.get(localKey))!==sharedKey)throw fail('SHARED_LOCAL_ALREADY_BOUND');
  this.toLocal.set(sharedKey,{...local});this.toShared.set(localKey,{...shared});
 }
 local(d){const value=this.toLocal.get(key(d));if(!value)throw fail('SHARED_LOCAL_MAPPING_REQUIRED');return {...d,...value};}
 shared(d){const value=this.toShared.get(key(d));return value?{...d,...value}:d;}
 reset(mappings){this.toLocal.clear();this.toShared.clear();for(const m of mappings)this.add(m);}
 getHistoryPath(itemId,topicId){
  const matches=[...this.toLocal].filter(([k])=>{const [,owner,topic]=JSON.parse(k);return owner===itemId&&topic===topicId;});
  if(matches.length!==1)throw fail('SHARED_LOCAL_MAPPING_REQUIRED');
  const value=matches[0][1];return this.native.getHistoryPath(value.itemId,value.topicId);
 }
 get syncPolicy(){return this.policy;}
 configureSync(policy,observer){
  this.policy=policy;
  if(!policy){this.native.configureSync(null);return;}
  const translate=new Set(['isEnabled','beforeRead','beforeMutation','beforeWrite','beforeInitialize','prepareLocalCommit','retryLocalCommit','deletedMessageIds']);
  const facade=new Proxy(policy,{get:(target,name)=>{
   const value=Reflect.get(target,name,target);
   if(typeof value!=='function')return value;
   return translate.has(name)?(d,...args)=>{if(name==='beforeInitialize'&&!this.toShared.has(key(d)))throw fail('SHARED_LOCAL_MAPPING_REQUIRED');return value.call(target,this.shared(d),...args);}:value.bind(target);
  }});
  this.native.configureSync(facade,observer?event=>this.projections.has(event.descriptor.syncMergeProjection)?Promise.resolve():observer({...event,descriptor:this.shared(event.descriptor)}):null);
 }
 revision(history){return this.native.revision(history);}
 run(d,fn){return this.native.run(this.local(d),fn);}
 async project(d,history){
  // A confirmed mapping move copies already accepted native rows. It is not
  // a new Journal event and must not manufacture an event/ACK or upload echo.
  const local=this.local(d),token=randomUUID();this.projections.add(token);
  try{return await this.native.run(local,()=>this.native.write({...local,syncSource:'remote',syncMergeProjection:token},history));}finally{this.projections.delete(token);}
 }
 inspect(d){return this.native.inspect(this.local(d));}
 async initializeIfMissing(d,history){try{return await this.native.initializeIfMissing(this.local(d),history);}catch(error){if(error.code==='SHARED_LOCAL_MAPPING_REQUIRED')error.initializationStatus='pending';throw error;}}
 deleteHistory(d,operation){
  if(d.topicId)return this.native.deleteHistory(this.local(d),operation);
  const owners=[...this.toLocal].filter(([k])=>{const [type,id]=JSON.parse(k);return type===(d.itemType||'agent')&&id===d.itemId;}).map(([,v])=>({itemId:v.itemId,itemType:v.itemType||'agent'}));
  const unique=new Map(owners.map(o=>[JSON.stringify(o),o]));if(unique.size!==1)throw fail('SHARED_LOCAL_MAPPING_REQUIRED');
  return this.native.deleteHistory({...d,...[...unique.values()][0]},operation);
 }
 read(d){return this.native.read(this.local(d));}
 mutate(d,fn,options){return this.native.mutate(this.local(d),fn,options);}
 write(d,history,options){return this.native.write(this.local(d),history,options);}
 replace(d,history,options){return this.native.replace(this.local(d),history,options);}
 readSnapshot(d){return this.native.readSnapshot(this.local(d));}
}
module.exports={SharedQueue};

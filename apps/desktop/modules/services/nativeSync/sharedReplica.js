'use strict';
const authorityControl=require('./historyAuthority');
const fs=require('node:fs/promises');
const {NativeSyncAdapter}=require('./adapter');
const {SharedQueue}=require('./sharedQueue');
const {fail,stable}=require('./protocol');
const {sharedIdentity}=require('./contracts.generated.cjs');

// This is the existing message adapter behind a verified descriptor map, not a
// second message synchronizer. Host configuration/discovery owns the mappings.
async function openSharedReplica({queue,statePath,connection,mappings,send,notify=()=>{},historyAuthority=authorityControl.authorityForQueue(queue)}){
 sharedIdentity(connection.sharedSpaceId);
 const mapped=new SharedQueue(queue,mappings,connection.sharedSpaceId);
 const query=new URLSearchParams({sharedSpaceId:connection.sharedSpaceId});
 const request=async(route,options={})=>{
  if(route.startsWith('/api/v1/sync/pull?')){
   const params=new URL(route,'http://localhost').searchParams;
   return send('/api/v1/sync/shared/pull?'+query+'&'+new URLSearchParams({after:params.get('after_seq'),limit:params.get('limit')}));
  }
  if(route==='/api/v1/sync/push'){
   const op=options.body,mapping=mappings.find(m=>m.shared.itemId===op.ownerId&&m.shared.topicId===op.topicId&&(m.shared.itemType||'agent')===op.ownerType);
   if(!mapping)throw fail('SHARED_LOCAL_MAPPING_REQUIRED');
   return send('/api/v1/sync/shared/message',{body:{sharedSpaceId:connection.sharedSpaceId,sharedId:mapping.sharedId,operation:op}});
  }
  throw fail('SHARED_ROUTE_NOT_APPROVED');
 };
 let previous;try{previous=JSON.parse(await fs.readFile(statePath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
 const topics=(previous?.topics||mappings.map(m=>m.shared)).map(d=>({itemId:d.itemId,itemType:d.itemType||'agent',topicId:d.topicId}));
 if(topics.some(topic=>!mappings.some(m=>stable(m.shared)===stable(topic))))throw fail('SHARED_LOCAL_MAPPING_REQUIRED');
 if(mapped.policy)mapped.policy.topics=topics;
 const adapter=await NativeSyncAdapter.open({queue:mapped,historyAuthority,statePath,sharedSpaceId:connection.sharedSpaceId,deviceId:'desktop:'+connection.deviceId,url:connection.url,token:connection.token,topics,request,notify:event=>{
  const local=mapped.local({itemId:event.ownerId||event.agentId,itemType:event.ownerType||'agent',topicId:event.topicId});
  notify({...event,agentId:local.itemId,ownerId:local.itemId,ownerType:local.itemType,topicId:local.topicId});
 }});
 for(const mapping of mappings)if(!adapter.isEnabled(mapping.shared))await adapter.addSharedTopic(mapping.shared);
 // Existing source codecs preserve local live-reference data while new devices
 // retain the readonly remote reference without requiring a local original.
 // Each caller needs a complete round after its own accepted receipt. Joining
 // an older in-flight pull could miss that receipt; concurrent rounds hit BUSY.
 // Event projection shares only the short durable recovery slot. Network rounds
 // never own this slot, so an unrelated slow pull cannot hold a foreground read.
 let projection=Promise.resolve();const apply=adapter.applyRemote.bind(adapter);
 adapter.applyRemote=async(event,...args)=>{event=await adapter.pages.hydrate(event);const next=projection.catch(()=>{}).then(async()=>{if(args[2]!==true&&adapter.inboundBlocked(event))throw fail('SHARED_TOPIC_DEPENDENCY_PENDING');try{return await apply(event,...args);}catch(error){if(!error.syncStatePersistenceFailure&&adapter.state.pending&&adapter.sameEvent(adapter.state.pending.event,event))await adapter.parkProjection(event,error);throw error;}});projection=next;return next;};
 const topicTails=new Map();
 const topicSync=(mapping,{after=0,minSeq=0}={})=>{
  const id=mapping.sharedId,prior=topicTails.get(id)||Promise.resolve();
  const next=prior.catch(()=>{}).then(async()=>{
   let cursor=adapter.state.topicCursors?.[id]||after;
   for(let page=0;page<10000;page++){
    const value=await send('/api/v1/sync/shared/topic-history?'+query+'&'+new URLSearchParams({sharedId:id,after:String(cursor),limit:'100'}));
    if(value.sharedId!==id||!Array.isArray(value.events)||value.events.length>100||!Number.isSafeInteger(value.headSeq)||!Number.isSafeInteger(value.nextSeq)||value.nextSeq<cursor||value.nextSeq>value.headSeq||value.hasMore!==(value.nextSeq<value.headSeq)||value.hasMore&&value.nextSeq===cursor)throw fail('SHARED_TOPIC_HISTORY_INVALID');
    let last=cursor;const events=[];for(const raw of value.events){if(!Number.isSafeInteger(raw.seq)||raw.seq<=last||raw.seq>value.nextSeq||!adapter.sameTopic(raw,mapping.shared))throw fail('SHARED_TOPIC_HISTORY_INVALID');last=raw.seq;events.push(adapter.validateEvent(await adapter.pages.hydrate(raw)));}
    if(last!==value.nextSeq)throw fail('SHARED_TOPIC_HISTORY_INVALID');
    // An empty page adds no durable intent. Keep the cursor checkpoint below,
    // including after an earlier rename/fsync failure with uncertain durability.
    if(events.length)await adapter.transaction(state=>{for(const event of events){const prior=state.inbox.find(v=>v.event.seq===event.seq);if(prior&&!adapter.sameEvent(prior.event,event))throw fail('CORRUPT_EVENT');if(!prior)state.inbox.push({event,advanceCursor:false});}});
    for(const event of events){if(adapter.inboundBlocked(event))throw fail('SHARED_TOPIC_DEPENDENCY_PENDING');await adapter.applyRemote(event,false,false);}

    cursor=value.nextSeq;
    await adapter.transaction(state=>{state.topicCursors||={};state.topicCursors[id]=cursor;});
    if(!value.hasMore){if(cursor<minSeq)throw fail('SHARED_TOPIC_VERSION_PENDING');adapter.retryNotifications();return {head:cursor};}
   }throw fail('PAGINATION_STALLED');
  });topicTails.set(id,next);next.finally(()=>{if(topicTails.get(id)===next)topicTails.delete(id);}).catch(()=>{});return next;
 };
 let mappingTail=Promise.resolve();const mapSerial=fn=>{const next=mappingTail.catch(()=>{}).then(fn);mappingTail=next;return next;};
 let tail=Promise.resolve();
 const serial=fn=>{const next=tail.catch(()=>{}).then(fn);tail=next;return next;};
 const applyCommitted=async(mapping,event,proof)=>{
  if(!adapter.sameTopic(event,mapping.shared))throw fail('SHARED_INLINE_EVENT_INVALID');
  event=adapter.validateEvent(await adapter.pages.hydrate(event));
  await adapter.transaction(state=>{
   let old=state.inbox.find(v=>v.event.seq===event.seq);
   if(old&&!adapter.sameEvent(old.event,event))throw fail('CORRUPT_EVENT');
   if(!old){old={event,advanceCursor:false};state.inbox.push(old);}
   if(proof){
    const prior=old.projectionRecovery;
    if(prior&&(!adapter.sameEvent(prior.event,event)||prior.beforeRevision!==proof.beforeRevision||prior.afterRevision!==proof.afterRevision))throw fail('RECOVERY_HISTORY_CONFLICT');
    if(!prior)old.projectionRecovery={event,beforeRevision:proof.beforeRevision,afterRevision:proof.afterRevision,advanceCursor:false,initialImport:false};
   }
  });
  return adapter.applyRemote(event,false,false);
 };
 // The host watches only its selected History. Foreign writes are evidence of
 // drift, not send intents. Resolve the path against this replica's bindings;
 // never read a path supplied by the window or advance a Journal cursor here.
 const observedFiles=new Set();
 const fileKey=file=>process.platform==='win32'?file.toLowerCase():file;
 adapter.externalHistoryChanged=file=>{
  if(!adapter.onHistoryHint||typeof file!=='string')return;
  const key=fileKey(file);
  if(!adapter.bindings.has(key))return;
  observedFiles.add(key);
  adapter.onHistoryHint();
 };
 async function auditLocalHistories(all,eligible=()=>true){
  if(!all&&!observedFiles.size)return;
  const hinted=new Set(observedFiles);
  observedFiles.clear();
  for(const {sharedId,local,shared} of mappings){
   if(!eligible(sharedId)||(!all&&!hinted.has(fileKey(queue.getHistoryPath(local.itemId,local.topicId)))))continue;
   const key=adapter.topicKey(shared);
   await mapped.run(shared,async()=>{
    const {pending,inbox,localCommits}=adapter.state;
    if(localCommits[key]||(pending&&adapter.sameTopic(pending.event,shared))||inbox.some(row=>adapter.sameTopic(row.event,shared)))return;
    try{await adapter.capture(shared,await mapped.read(shared));}
    catch(error){
     if(error.syncStatePersistenceFailure)throw error;
     const code=error.code||'HISTORY_READ_FAILED';
     if(adapter.state.drift[key]?.code!==code)await adapter.transaction(next=>{next.drift[key]={code};});
    }
   });
  }
 }
 return {adapter,queue:mapped,syncTopic:topicSync,applyCommitted,auditLocalHistories,
  rebind:next=>serial(()=>mapSerial(async()=>{await adapter.transaction(state=>{state.topics=next.map(m=>({itemId:m.shared.itemId,itemType:m.shared.itemType||'agent',topicId:m.shared.topicId}));});mapped.reset(next);adapter.topics=adapter.state.topics.map(t=>({...t}));mappings.splice(0,mappings.length,...next);adapter.bindings.clear();for(const m of next){const file=mapped.getHistoryPath(m.shared.itemId,m.shared.topicId);adapter.bindings.set(process.platform==='win32'?file.toLowerCase():file,JSON.stringify(require('./protocol').wireTopic(m.shared)));}})),
  add:mapping=>mapSerial(async()=>{if(mappings.some(m=>m.sharedId===mapping.sharedId))return;mapped.add(mapping);await adapter.addSharedTopic(mapping.shared);mappings.push(mapping);}),
  sync:({pullOnly=false}={})=>serial(()=>pullOnly?adapter.pull():adapter.synchronize()),close:()=>serial(async()=>{await Promise.allSettled([...topicTails.values(),projection,mappingTail]);return adapter.close();})};
}
module.exports={openSharedReplica};

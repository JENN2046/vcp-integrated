'use strict';
const {randomUUID,createHash}=require('node:crypto');
const fail=(code,status=409)=>Object.assign(Error(code),{code,status});
const defaults={maxWorks:128,maxEvents:256,maxEventBytes:64*1024,maxBytes:512*1024,maxBodyBytes:256*1024,maxNativeBodies:32,maxSubscribers:128,maxSubscribersPerWork:16,maxSubscribersPerTopic:16,retentionMs:120000};
const statusTypes=new Set(['state','status','accepted','queued','dispatched','running','completed','failed','cancelled','review_required','tool','approval']);
const digest=text=>createHash('sha256').update(text).digest('hex');

// A bounded, disposable observation cache. Admissions, native execution and the
// committed Journal remain authoritative; a cache miss never dispatches work.
class SharedEvents{
 constructor(shared,engine,{limits={}}={}){
  this.shared=shared;this.engine=engine;this.epoch=randomUUID();this.streams=new Map();this.topicListeners=new Map();this.subscribers=0;this.closed=false;
  this.limits={...defaults,...limits};for(const [name,value]of Object.entries(this.limits))if(!Number.isSafeInteger(value)||value<1)throw fail('INVALID_EVENT_LIMIT',400);
  if(this.limits.maxNativeBodies>32)throw fail('INVALID_EVENT_LIMIT',400);
  if(this.limits.maxEventBytes<4)throw fail('INVALID_EVENT_LIMIT',400);
 }
 row(workId){const row=this.shared.db.prepare('SELECT * FROM shared_admissions WHERE id=?').get(workId);if(!row)throw fail('SHARED_REQUEST_NOT_FOUND',404);return row;}
 topicKey(space,topic){return JSON.stringify([space,topic]);}
 validateTopic(actor,query){
  if(this.closed)throw fail('SHARED_EVENTS_CLOSED',503);
  if(!query||typeof query.sharedId!=='string'||typeof query.sharedSpaceId!=='string'||Object.keys(query).some(key=>!['scope','sharedSpaceId','sharedId'].includes(key))||query.scope!==undefined&&query.scope!=='topic')throw fail('INVALID_SHARED_EVENT_REQUEST',400);
  const topic=this.shared.topic(actor,query.sharedSpaceId,query.sharedId,'read');
  if(topic.id!==query.sharedId)throw fail('SHARED_EVENT_SCOPE_MISMATCH',403);return topic;
 }
 validateTopicSubscription(actor,query){
  const topic=this.validateTopic(actor,query),key=this.topicKey(query.sharedSpaceId,topic.id),listeners=this.topicListeners.get(key);
  if(this.subscribers>=this.limits.maxSubscribers||(listeners?.size||0)>=this.limits.maxSubscribersPerTopic)throw fail('SHARED_EVENT_SUBSCRIBERS_LIMIT',429);
  return {topic,key,listeners};
 }
 // Discovery carries only a committed current work identity. It does not
 // replace the work's independent replay cursor, body projection or lifetime.
 discover(row){
  const listeners=this.topicListeners.get(this.topicKey(row.space_id,row.topic_id));
  if(!listeners?.size||this.shared.db.isTransaction||this.shared.active(row.topic_id)?.id!==row.id)return;
  const event=Object.freeze({type:'work',sharedSpaceId:row.space_id,sharedId:row.topic_id,executionId:row.id});
  for(const listener of [...listeners])listener.work(event);
 }
 subscribeTopic(actor,query,send,{onClose=()=>{}}={}){
  if(typeof send!=='function')throw fail('INVALID_SHARED_EVENT_REQUEST',400);
  const {topic,key,listeners:existing}=this.validateTopicSubscription(actor,query),listeners=existing||new Set();let closed=false;
  const listener={lastWorkId:null,close:reason=>{if(closed)return;closed=true;listeners.delete(listener);if(!listeners.size)this.topicListeners.delete(key);this.subscribers--;try{onClose(reason);}catch{}},work:event=>{
   if(closed||listener.lastWorkId===event.executionId)return;
   try{this.validateTopic(actor,query);listener.lastWorkId=event.executionId;if(send(event)===false)listener.close('slow_subscriber');}catch{listener.close('authorization_or_subscriber_error');}
  }};
  const wantsReports=actor.kind==='desktop'&&actor.capabilities?.split(',').includes('shared-report-list-v1')&&typeof this.engine?.nativeTasks?.recentReports==='function';
  let lastReports;
  const ready=(readReports)=>{
   const event={type:'topic_ready',sharedSpaceId:query.sharedSpaceId,sharedId:topic.id};
   if(wantsReports){
    let reports=[];
    try{
     this.shared.topic(actor,query.sharedSpaceId,topic.id,'execute');
     reports=readReports();
    }catch(error){if(error.code!=='SHARED_LOCAL_REMOVED')throw error;}
    const signature=JSON.stringify(reports);
    if(lastReports===signature)return;
    lastReports=signature;
    event.reports=reports;
   }
   if(send(event)===false)listener.close('slow_subscriber');
  };
  if(wantsReports)listener.refreshReports=readReports=>{
   if(closed)return;
   try{this.validateTopic(actor,query);ready(readReports);}catch{listener.close('authorization_or_subscriber_error');}
  };
  this.topicListeners.set(key,listeners);listeners.add(listener);this.subscribers++;
  try{
   ready(()=>this.engine.nativeTasks.recentReports(query.sharedSpaceId,topic.id));
   if(!closed){const active=this.shared.active(topic.id);if(active)listener.work({type:'work',sharedSpaceId:query.sharedSpaceId,sharedId:topic.id,executionId:active.id});}
  }catch(error){listener.close('subscriber_error');throw error;}
  return {close:()=>listener.close('observer_closed'),get closed(){return closed;}};
 }
 validate(actor,query){
  if(!query||typeof query.executionId!=='string'||typeof query.sharedId!=='string'||typeof query.sharedSpaceId!=='string')throw fail('INVALID_SHARED_EVENT_REQUEST',400);
  const topic=this.shared.topic(actor,query.sharedSpaceId,query.sharedId,'read'),row=this.row(query.executionId);
  if(topic.id!==query.sharedId||row.space_id!==query.sharedSpaceId||row.topic_id!==topic.id)throw fail('SHARED_EVENT_SCOPE_MISMATCH',403);
  return row;
 }
 stream(workId){
  if(this.closed)throw fail('SHARED_EVENTS_CLOSED',503);
  let stream=this.streams.get(workId);if(stream)return stream;
  if(this.streams.size>=this.limits.maxWorks){
   const candidate=[...this.streams].find(([,value])=>value.listeners.size===0);
   if(!candidate)throw fail('SHARED_EVENT_CAPACITY',503);this.streams.delete(candidate[0]);
  }
  const row=this.row(workId);
  stream={epoch:this.epoch+'.'+randomUUID(),seq:0,generation:0,offset:0,body:'',bodyComplete:!row.dispatched,activity:null,nativeBodies:new Map(),nativeBytes:0,hash:createHash('sha256'),events:[],bytes:0,listeners:new Set()};
  this.streams.set(workId,stream);return stream;
 }
 prune(stream){const now=Date.now();while(stream.events.length&&(stream.events.length>this.limits.maxEvents||stream.bytes>this.limits.maxBytes||stream.events[0].event.at<now-this.limits.retentionMs)){stream.bytes-=stream.events.shift().bytes;}}
 // Observation must never change the native model/tool outcome. In particular,
 // cache saturation or an already closed host can drop notifications safely.
 publish(workId,type,payload={}){
  try{
   const row=this.row(workId);
   this.discover(row);
   if(type==='completed' && row.state==='completed' && !this.shared.db.isTransaction){
    let reports;
    const readReports=()=>reports??=this.engine.nativeTasks.recentReports(row.space_id,row.topic_id);
    for(const listener of this.topicListeners.get(this.topicKey(row.space_id,row.topic_id))||[])listener.refreshReports?.(readReports);
   }
   if(type==='delta'&&typeof payload.text==='string'&&Buffer.byteLength(payload.text)>this.limits.maxEventBytes){
    let text=payload.text,last=null;
    while(text){let length=Math.min(text.length,this.limits.maxEventBytes);while(Buffer.byteLength(text.slice(0,length))>this.limits.maxEventBytes)length=Math.max(1,Math.floor(length/2));if(length<text.length&&/[\uD800-\uDBFF]/.test(text[length-1]))length--;if(!length)length=2;last=this.publishOne(workId,type,{...payload,text:text.slice(0,length)});text=text.slice(length);}return last;
   }
   return this.publishOne(workId,type,payload);
  }catch{return null;}
 }
 publishOne(workId,type,payload={}){
  const row=this.row(workId),stream=this.stream(workId);let value;
  if(payload.generation!==undefined&&payload.generation!==0)throw fail('SHARED_EVENT_GENERATION_UNSUPPORTED');
  if(type==='delta'){
   if(typeof payload.text!=='string'||!payload.text)return null;
   if(Buffer.byteLength(payload.text)>this.limits.maxEventBytes)throw fail('SHARED_EVENT_TOO_LARGE',413);
   value={text:payload.text,offset:stream.offset,endOffset:stream.offset+payload.text.length,hash:digest(payload.text)};
   stream.offset=value.endOffset;stream.hash.update(payload.text);
   if(stream.bodyComplete){if(stream.nativeBytes+Buffer.byteLength(stream.body)+Buffer.byteLength(payload.text)<=this.limits.maxBodyBytes)stream.body+=payload.text;else{stream.body='';stream.bodyComplete=false;}}
  }else{
   if(!statusTypes.has(type))throw fail('INVALID_SHARED_EVENT_TYPE',400);
   // Do not forward tool arguments/results, provider objects, prompts or hidden
   // reasoning. State notifications are hints; the next snapshot verifies them.
   value={};for(const key of ['state','requestId','nativeRequestId','nativeTaskId','invocationId','code'])if(typeof payload[key]==='string'&&/^[a-zA-Z0-9_.:-]{1,160}$/.test(payload[key]))value[key]=payload[key];
   if(type==='completed'&&row.state!=='completed')throw fail('SHARED_EVENT_TERMINAL_NOT_COMMITTED');
  }
  // Retain only the safe current activity in this disposable bounded cache.
  // A late/reconnecting observer must not miss an approval already in progress.
  if(type==='tool'&&['started','accepted','settled','observed'].includes(value.state)||type==='approval'&&['waiting_approval','running'].includes(value.state))stream.activity={type,state:value.state};
  else if(type==='delta'||type==='state'||['completed','failed','cancelled','review_required'].includes(type))stream.activity=null;
  return this.emit(stream,row,type,value);
 }
 emit(stream,row,type,value){
  const event=Object.freeze({sharedSpaceId:row.space_id,sharedId:row.topic_id,executionId:row.id,epoch:stream.epoch,generation:0,seq:++stream.seq,type,payload:Object.freeze(value),at:Date.now()});
  const bytes=Buffer.byteLength(JSON.stringify(event));stream.events.push({event,bytes});stream.bytes+=bytes;this.prune(stream);
  for(const listener of [...stream.listeners]){try{if(listener.send(event)===false)listener.close('slow_subscriber');}catch{listener.close('subscriber_error');}}
  return event;
 }
 // Identity is read from the existing native admission/controlled generation.
 // This disposable preview cannot grant control, dispatch or commit History.
 nativeIdentity(row,native){
  const config=JSON.parse(row.config_json),turn=require('./sharedTurns').intent(row);
  if(native.member_id){
   if(config.owner.kind!=='group'||!Array.isArray(turn.plan)||turn.plan[native.ordinal]!==native.member_id)throw fail('SHARED_EVENT_NATIVE_INVALID');
   const name=config.members.find(member=>member.id===native.member_id)?.config.name;
   return {nativeRequestId:native.id,memberId:native.member_id,ordinal:native.ordinal,memberName:typeof name==='string'?name.slice(0,160):''};
  }
  if(config.owner.kind!=='agent'||turn.controlMode!=='text-only-v1'||turn.steeringCapable!==true)throw fail('SHARED_EVENT_NATIVE_INVALID');
  const generation=this.shared.steering.requestGeneration(row.id,native.id);
  if(!generation||generation.executor!==native.principal)throw fail('SHARED_EVENT_NATIVE_INVALID');
  return {kind:'controlled-text',nativeRequestId:native.id,nativeGeneration:generation.generation,ordinal:generation.generation,memberName:typeof config.owner.config.name==='string'?config.owner.config.name.slice(0,160):''};
 }
 // Group children share this work's existing cache and total body budget.
 // Identities come from the authenticated native registration, never a client.
 publishNative(workId,nativeRequestId,type,text=''){
  try{
   if(!['native_start','native_delta','native_gap'].includes(type))throw fail('INVALID_SHARED_EVENT_TYPE',400);
   const row=this.row(workId),native=this.shared.db.prepare('SELECT * FROM shared_native_requests WHERE id=? AND admission_id=?').get(nativeRequestId,workId);
   if(!native||native.state!=='dispatched'||!['accepted','dispatched'].includes(row.state))throw fail('SHARED_EVENT_NATIVE_INVALID');
   const identity=this.nativeIdentity(row,native);
   if(identity.kind==='controlled-text'){
    const control=this.shared.db.prepare('SELECT * FROM shared_work_controls WHERE work_id=?').get(row.id),generation=this.shared.steering.requestGeneration(row.id,native.id);
    if(!control||control.generation!==generation.generation||control.executor!==native.principal||!['preprocessing','running'].includes(generation.state))throw fail('SHARED_EVENT_NATIVE_INVALID');
   }
   const stream=this.stream(workId);let body=stream.nativeBodies.get(native.id);
   if(!body){
    if(stream.nativeBodies.size>=this.limits.maxNativeBodies)return null;
    body={...identity,text:'',offset:0,gap:type!=='native_start'};stream.nativeBodies.set(native.id,body);
   }
   if(type==='native_start')return this.emit(stream,row,type,identity);
   if(body.gap)return null;
   if(type==='native_delta'){
    if(typeof text!=='string'||!text)return null;
    const bytes=Buffer.byteLength(text);
    if(bytes>this.limits.maxEventBytes||Buffer.byteLength(stream.body)+stream.nativeBytes+bytes>this.limits.maxBodyBytes){type='native_gap';}
    else{const value={...identity,text,offset:body.offset,endOffset:body.offset+text.length,hash:digest(text)};body.text+=text;body.offset+=text.length;stream.nativeBytes+=bytes;stream.activity=null;return this.emit(stream,row,type,value);}
   }
   body.gap=true;return this.emit(stream,row,'native_gap',{...identity,offset:body.offset,hash:digest(body.text)});
  }catch{return null;}
 }
 // Snapshot the already visible member prefix once, in the queue stop transaction.
 // Never use an unfiltered provider body or record a synthetic final message.
 retainGroupPrefix(workId,cutoff){
  const stream=this.streams.get(workId);
  if(!stream||cutoff<1)return;
  const native=this.shared.db.prepare(`SELECT n.id FROM shared_native_requests n
   JOIN mobile_execution_steps s ON s.id=n.id AND s.job_id=n.admission_id AND s.agent_id=n.member_id
   WHERE n.admission_id=? AND n.ordinal=? AND s.step_index=n.ordinal AND n.state='dispatched'
   AND s.state IN ('running','waiting_approval')`).get(workId,cutoff-1);
  const body=native&&stream.nativeBodies.get(native.id);
  if(!body?.text||Buffer.byteLength(body.text)>this.limits.maxBodyBytes)return;
  // Keep at most one event's worth of text. Streaming decode omits an
  // incomplete UTF-8 character at the bound; the cold snapshot marks a gap.
  const bytes=Buffer.from(body.text);
  const limit=Math.min(this.limits.maxEventBytes,defaults.maxEventBytes);
  const text=bytes.length<=limit?body.text:new TextDecoder('utf-8',{ignoreBOM:true}).decode(bytes.subarray(0,limit),{stream:true});
  const prefix={nativeRequestId:native.id,text,hash:digest(text)};
  this.shared.db.prepare('UPDATE mobile_executions SET group_stop_preview=? WHERE id=? AND group_stop_index=? AND group_stop_preview IS NULL')
   .run(JSON.stringify(prefix),workId,cutoff);
 }
 nativeSnapshot(row,stream,job){
  const turn=require('./sharedTurns').intent(row),config=JSON.parse(row.config_json);
  if(config.owner.kind!=='group'&&turn.controlMode!=='text-only-v1')return undefined;
  if(config.owner.kind==='group'&&(!Array.isArray(turn.plan)||!turn.plan.length))return undefined;
  const nativeRows=config.owner.kind==='group'
   ?this.shared.db.prepare('SELECT * FROM shared_native_requests WHERE admission_id=? ORDER BY ordinal LIMIT ?').all(row.id,this.limits.maxNativeBodies)
   :this.shared.db.prepare('SELECT n.* FROM shared_native_requests n JOIN shared_work_generations g ON g.work_id=n.admission_id AND g.request_id=n.id WHERE n.admission_id=? ORDER BY g.generation LIMIT ?').all(row.id,this.limits.maxNativeBodies);
  let retained;
  if(row.state==='review_required'&&job?.group_stop_preview){
   try{retained=JSON.parse(job.group_stop_preview);}catch{/* A missing preview cannot certify a result. */}
  }
  return nativeRows.map(native=>{
   const identity=this.nativeIdentity(row,native),saved=stream.nativeBodies.get(native.id);
   if(saved)return {...saved,hash:digest(saved.text)};
   if(retained?.nativeRequestId===native.id&&native.ordinal===job.group_stop_index-1&&
      typeof retained.text==='string'&&Buffer.byteLength(retained.text)<=this.limits.maxBodyBytes&&digest(retained.text)===retained.hash){
    return {...identity,text:retained.text,offset:retained.text.length,hash:retained.hash,gap:true};
   }
   return {...identity,text:'',offset:0,gap:native.state!=='prepared',hash:digest('')};
  });
 }
 snapshot(actor,query){
  const row=this.validate(actor,query),stream=this.stream(row.id);this.prune(stream);
  const native=this.engine?.get?.(row.id),request=this.shared.publicAdmission(row);
  let body={text:stream.body,offset:0,endOffset:stream.offset,complete:stream.bodyComplete,source:'temporary',hash:stream.hash.copy().digest('hex')};
  const nativeBodies=this.nativeSnapshot(row,stream,native);
  let partialResult;
  if(row.state==='review_required'&&!row.native_terminal&&!row.reply_seq&&native?.state==='review_required'&&native.pending_operation){
   // Read the original durable intent; never publish it or reinterpret old
   // unknown/pending facts without an explicit framing proof.
   let op;try{op=JSON.parse(native.pending_operation);}catch{}
   const proof=op?.message?.nativePartial,text=op?.message?.content,topic=this.shared.row(row.space_id,row.topic_id);
   if(proof?.version===1&&proof.kind==='length'&&proof.finishReason==='length'&&['sse','json'].includes(proof.transport)
    &&proof.nativeRequestId===row.id&&proof.executionId===row.id&&proof.sharedSpaceId===row.space_id&&proof.sharedId===row.topic_id
    &&proof.requestId===row.request_id&&proof.requestId===native.request_id&&proof.userMessageId===native.user_message_id
    &&proof.messageId==='reply_'+row.id&&op.msgId===proof.messageId&&op.message.id===proof.messageId&&op.message.role==='assistant'&&op.message.agentId===topic.owner_id
    &&op.opId==='reply:'+row.id&&op.action==='upsert'&&op.deviceId==='server:native-execution'
    &&op.message.finishReason==='length'&&op.ownerType===topic.owner_type&&op.ownerId===topic.owner_id&&op.topicId===topic.topic_id
    &&native.topic_key===row.topic_id&&typeof text==='string'&&text.length>0&&Buffer.byteLength(text)<=this.limits.maxBodyBytes&&proof.contentHash===digest(text)){
    partialResult={version:1,kind:'length',executionId:row.id,sharedSpaceId:row.space_id,sharedId:row.topic_id,requestId:row.request_id,userMessageId:native.user_message_id,messageId:proof.messageId,contentHash:proof.contentHash,finishReason:'length',source:'pending_operation',committed:false};
    body={text,offset:0,endOffset:text.length,complete:true,source:'pending_operation',messageId:proof.messageId,hash:proof.contentHash};
   }
  }
  if(row.reply_seq&&!nativeBodies){
   const records=this.shared.store.readProjected(()=>this.shared.store.readJournalSeqs.all(JSON.stringify([row.reply_seq])));
   const topic=this.shared.row(row.space_id,row.topic_id);
   const committed=records.find(value=>Number(value.row.seq)===Number(row.reply_seq)&&value.row.owner_type===topic.owner_type&&value.row.owner_id===topic.owner_id&&value.row.topic_id===topic.topic_id);
   if(committed&&typeof committed.message?.content==='string'){
    const text=committed.message.content;body={text:Buffer.byteLength(text)<=this.limits.maxBodyBytes?text:'',offset:0,endOffset:text.length,complete:Buffer.byteLength(text)<=this.limits.maxBodyBytes,source:'journal',seq:Number(row.reply_seq),messageId:committed.message.id,hash:digest(text)};
   }
  }
  return {sharedSpaceId:row.space_id,sharedId:row.topic_id,executionId:row.id,epoch:stream.epoch,generation:0,seq:stream.seq,request,native:native?{id:native.id,state:native.state,...(['shared_session','group_message','group_invitation'].includes(native.kind)?{kind:native.kind}:{})}:null,body,bodyUnavailable:!body.complete,...(nativeBodies?{nativeBodies}:{}),...(stream.activity&&!['completed','abandoned','failed','cancelled','review_required'].includes(row.state)?{activity:stream.activity}:{}),...(partialResult?{partialResult}:{})};
 }
 // subscribe and its initial snapshot/replay are synchronous: no publisher can
 // slip between their watermarks. send/onClose must never block on network I/O.
 validateSubscription(actor,query){
  const row=this.validate(actor,query),stream=this.stream(row.id);
  if(this.subscribers>=this.limits.maxSubscribers||stream.listeners.size>=this.limits.maxSubscribersPerWork)throw fail('SHARED_EVENT_SUBSCRIBERS_LIMIT',429);
  return {row,stream};
 }
 subscribe(actor,query,send,{after,epoch,onClose=()=>{}}={}){
  if(typeof send!=='function')throw fail('INVALID_SHARED_EVENT_REQUEST',400);
  const {row,stream}=this.validateSubscription(actor,query);this.prune(stream);
  if(after!==undefined&&(!Number.isSafeInteger(after)||after<0))throw fail('INVALID_SHARED_EVENT_CURSOR',400);
  let closed=false;const listener={send,close:reason=>{if(closed)return;closed=true;stream.listeners.delete(listener);this.subscribers--;try{onClose(reason);}catch{/* Observer cleanup cannot stop native execution. */}}};
  this.subscribers++;stream.listeners.add(listener);
  try{
   const first=stream.events[0]?.event.seq??stream.seq+1;
   let reason=null;if(after!==undefined){if(epoch!==stream.epoch)reason='epoch_changed';else if(after>stream.seq)reason='cursor_ahead';else if(after<first-1)reason='retention_gap';}
   if(reason&&send({type:reason==='retention_gap'?'gap':'reset',reason,epoch:stream.epoch,generation:0,seq:stream.seq,executionId:row.id})===false)listener.close('slow_subscriber');
   if(!closed){
    if(after===undefined||reason){if(send({type:'snapshot',...this.snapshot(actor,query)})===false)listener.close('slow_subscriber');}
    else for(const {event}of stream.events)if(event.seq>after&&!closed&&send(event)===false)listener.close('slow_subscriber');
   }
  }catch(error){listener.close('subscriber_error');throw error;}
  return {close:()=>listener.close('observer_closed'),get closed(){return closed;}};
 }
 close(){if(this.closed)return;this.closed=true;for(const stream of this.streams.values())for(const listener of [...stream.listeners])listener.close('host_closed');for(const listeners of this.topicListeners.values())for(const listener of [...listeners])listener.close('host_closed');this.streams.clear();this.topicListeners.clear();}
}
module.exports={SharedEvents};

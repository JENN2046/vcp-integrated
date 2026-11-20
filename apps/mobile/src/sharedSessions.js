import {SharedEventProjection,consumeSharedEvents} from '../../desktop/modules/services/nativeSync/sharedEventClient.mjs';

const terminal=new Set(['completed','abandoned','failed','cancelled','review_required','blocked_config','interrupted']);
const problem=code=>Object.assign(Error(code),{code});
const pause=(ms,signal)=>new Promise(resolve=>{
 if(signal.aborted)return resolve();
 const finish=()=>{clearTimeout(timer);signal.removeEventListener('abort',finish);resolve();};
 const timer=setTimeout(finish,ms);signal.addEventListener('abort',finish,{once:true});
});

// A bounded, disposable UI projection. It can only read the existing Cookie
// route; neither retrying a stream nor seeing a terminal hint submits work.
export function createSharedSessionObservers({openEvents,onChange=()=>{},onSettled=()=>{},onStatus=()=>{},onDenied=()=>{},maxSubscriptions=2,maxTextChars=128*1024,retryDelay=500,maxRetries=8}={}){
 if(typeof openEvents!=='function'||!Number.isSafeInteger(maxSubscriptions)||maxSubscriptions<1||maxSubscriptions>4||!Number.isSafeInteger(maxTextChars)||maxTextChars<1||maxTextChars>256*1024)throw problem('INVALID_SHARED_OBSERVER_OPTIONS');
 let scope='',version=0,context=null,closed=false,suspended=false,denied=false,discovery=null,committed=new Set();
 const entries=new Map();
 const current=entry=>!closed&&!suspended&&!denied&&entry.version===version&&entries.get(entry.id)===entry;
 const values=()=>[...entries.values()].map(entry=>({...entry.projection.value(),connection:entry.connection,state:entry.projection.native?.state||entry.projection.request?.state||entry.job.state,settled:entry.settled,messageId:entry.messageId||entry.job.replyMessageId||'reply_'+entry.id}));
 const emit=()=>onChange(values(),context);
 const stop=entry=>{entries.delete(entry.id);entry.controller.abort();};
 function reset(){version++;discovery?.controller.abort();discovery=null;for(const entry of [...entries.values()])stop(entry);scope='';context=null;denied=false;committed=new Set();emit();}
 function rejectAuthority(error){if(denied)return;denied=true;discovery?.controller.abort();discovery=null;for(const value of [...entries.values()])stop(value);emit();onDenied(error,context);}
 function run(entry){
  entry.task=(async()=>{
   let failures=0,resyncs=0;
   while(current(entry)&&!entry.settled){
    const p=entry.projection,query={sharedSpaceId:context.sharedSpaceId,sharedId:context.topicKey,executionId:entry.id,...(p.epoch?{epoch:p.epoch,after:String(p.seq)}:{})};
    try{
     entry.connection=failures?'reconnecting':'connecting';emit();
     const response=await openEvents(query,{signal:entry.controller.signal});
     if(!current(entry)){await response.body?.cancel();return;}
     if(response.status===401||response.status===403){await response.body?.cancel();throw Object.assign(problem('SHARED_EVENT_PERMISSION_REQUIRED'),{status:response.status});}
     await consumeSharedEvents(response,async event=>{
      if(!current(entry))return;
      await p.apply(event);if(!current(entry))return;
      failures=0;entry.connection='online';if(event.body?.messageId)entry.messageId=event.body.messageId;
      if(event.type==='snapshot'&&terminal.has(event.request?.state)){
       // Only the fresh authoritative snapshot settles a terminal hint.
       entry.settled=true;entry.connection='settled';emit();
       await onSettled(p.value(),context);entry.controller.abort();return;
      }
      emit();
      if(['completed','failed','cancelled','review_required'].includes(event.type)||event.type==='state'&&terminal.has(event.payload?.state)){
       if(++resyncs>maxRetries)throw problem('SHARED_EVENT_RETRY_LIMIT');p.epoch=null;throw problem('SHARED_EVENT_RESET_REQUIRED');
      }
      if(['state','status','tool','approval','native_start'].includes(event.type))onStatus(p.value(),context);
     },{signal:entry.controller.signal});
    }catch(error){
     if(!current(entry)||entry.controller.signal.aborted)return;
     if(error.code==='SHARED_EVENT_PERMISSION_REQUIRED'){
      rejectAuthority(error);return;
     }
     // An idle replay may have no frames; reconnect through the existing
     // authority snapshot before marking this observer online again.
     p.epoch=null;
     if(error.code==='SHARED_EVENT_RETRY_LIMIT'){entry.connection='disconnected';emit();return;}
     entry.connection='reconnecting';emit();
     if(error.code==='SHARED_EVENT_RESET_REQUIRED')continue;
     if(++failures>maxRetries){entry.connection='disconnected';emit();return;}
     await pause(Math.min(5000,retryDelay*2**(failures-1)),entry.controller.signal);
    }
   }
  })().catch(()=>{if(current(entry)){entry.connection='disconnected';emit();}});
 }
 function watchWork(job,discovered=false){
  // A committed reply can be an intermediate generation, not the Work's end.
  if(entries.has(job.id))return;
  if(entries.size>=maxSubscriptions){const old=[...entries.values()].find(value=>value.settled||value.connection==='disconnected');if(old)stop(old);}
  if(entries.size>=maxSubscriptions)return;
  const entry={id:job.id,job,version,controller:new AbortController(),projection:new SharedEventProjection({executionId:job.id,sharedId:context.topicKey,sharedSpaceId:context.sharedSpaceId,maxTextChars}),connection:'connecting',settled:false,messageId:null,discovered};entries.set(job.id,entry);run(entry);
 }
 function watchTopic(){
  if(discovery)return;
  const entry={version,controller:new AbortController(),connection:'connecting'};discovery=entry;
  const live=()=>!closed&&!suspended&&!denied&&discovery===entry&&entry.version===version;
  entry.task=(async()=>{
   let failures=0;
   while(live()){
    try{
     const response=await openEvents({scope:'topic',sharedSpaceId:context.sharedSpaceId,sharedId:context.topicKey},{signal:entry.controller.signal});
     if(!live()){await response.body?.cancel();return;}
     if(response.status===401||response.status===403){await response.body?.cancel();throw Object.assign(problem('SHARED_EVENT_PERMISSION_REQUIRED'),{status:response.status});}
     await consumeSharedEvents(response,event=>{
      if(!live())return;
      if(!event||!['topic_ready','work'].includes(event.type)||event.sharedId!==context.topicKey||event.sharedSpaceId!==context.sharedSpaceId||event.scope!==undefined&&event.scope!=='topic'||Object.keys(event).some(key=>!['type','sharedId','sharedSpaceId','scope','executionId'].includes(key)))throw problem('SHARED_EVENT_IDENTITY_MISMATCH');
      if(event.type==='work'&&(typeof event.executionId!=='string'||!/^[a-zA-Z0-9_-]{1,96}$/.test(event.executionId)))throw problem('SHARED_EVENT_IDENTITY_MISMATCH');
      failures=0;entry.connection='online';
      if(event.type==='work'){
       // This placeholder owns only a read subscription. The jobs list and
       // submitted/accepted UI facts still come from the existing API.
       watchWork({id:event.executionId,topicKey:context.topicKey,state:'observing'},true);onStatus(null,context);
      }
     },{signal:entry.controller.signal});
    }catch(error){
     if(!live()||entry.controller.signal.aborted)return;
     if(error.code==='SHARED_EVENT_PERMISSION_REQUIRED'){rejectAuthority(error);return;}
     entry.connection='reconnecting';
     if(error.code==='SHARED_EVENT_IDENTITY_MISMATCH'||++failures>maxRetries){entry.connection='disconnected';return;}
     await pause(Math.min(5000,retryDelay*2**(failures-1)),entry.controller.signal);
    }
   }
  })().catch(()=>{if(live())entry.connection='disconnected';});
 }
 function sync(next){
  if(closed)return;
  const key=next?.enabled&&next.topicKey&&next.sharedSpaceId?JSON.stringify([next.sharedSpaceId,next.topicKey,next.generation,next.authEpoch,next.entryId,next.sessionMarker]):'';
  if(key!==scope){reset();scope=key;context=key?{...next,jobs:undefined,committedIds:undefined}:null;}
  if(!key||suspended||denied)return;
  const jobs=(next.jobs||[]).filter(job=>job.topicKey===next.topicKey&&typeof job.id==='string');committed=new Set(next.committedIds||[]);watchTopic();
  const settledIds=new Set([...entries.values()].filter(entry=>entry.settled).map(entry=>entry.id));
  const knownIds=new Set(jobs.map(job=>job.id)),placeholders=[...entries.values()].filter(entry=>entry.discovered&&!knownIds.has(entry.id)).map(entry=>entry.job);
  const desired=[...jobs.filter(job=>!terminal.has(job.state)||entries.has(job.id)),...placeholders].slice(0,maxSubscriptions),ids=new Set(desired.map(job=>job.id));
  for(const entry of [...entries.values()])if(!ids.has(entry.id)||entry.settled&&committed.has(entry.messageId||entry.job.replyMessageId||'reply_'+entry.id))stop(entry);
  for(const job of desired){
   if(entries.has(job.id)){
    const previous=entries.get(job.id);previous.job=job;
    if(terminal.has(job.state)&&!previous.settled&&!previous.checkingTerminal){
     stop(previous);previous.projection.epoch=null;
     const nextEntry={...previous,controller:new AbortController(),connection:'reconnecting',checkingTerminal:true};entries.set(job.id,nextEntry);run(nextEntry);
    }
    continue;
   }
   if(settledIds.has(job.id)||terminal.has(job.state)||entries.size>=maxSubscriptions)continue;
   watchWork(job);
  }
  emit();
 }
 function suspend(){suspended=true;reset();}
 function resume(){if(closed)return;suspended=false;reset();}
 function close(){closed=true;reset();}
 return {sync,reset,suspend,resume,close,hasLive:()=>[...entries.values()].some(entry=>!entry.settled&&entry.connection==='online')};
}

// One temporary view per native member. Committed History owns the durable
// message and retires only that preview, even while another member is running.
export function sharedSessionPreviews(streams, committedIds=[]) {
 const committed=new Set(committedIds),values=[];
 for(const work of streams||[]){
  const parts=work.nativeBodies?.length?work.nativeBodies.map(body=>({...work,...body,messageId:body.kind==='controlled-text'?body.nativeRequestId:'reply_'+body.nativeRequestId,previewId:work.executionId+'/'+body.nativeRequestId})): [{...work,previewId:work.executionId}];
  for(const preview of parts){
   if(committed.has(preview.messageId)||preview.request?.state==='abandoned')continue;
   if(!preview.text&&!preview.gap&&!preview.activity&&terminal.has(preview.request?.state))continue;
   values.push(preview);
  }
 }
 return values;
}

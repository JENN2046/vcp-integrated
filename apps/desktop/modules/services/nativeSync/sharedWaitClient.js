'use strict';
const {syncHeaders}=require('./syncRequest');
const lanes=['matches','changes','pull'];
const validToken=/^[a-f0-9-]{36}(?:\.(?:0|[a-f0-9]{16})){3}$/;
const auditMs=15*60*1000;
const transportError=(code,status)=>Object.assign(Error(code),{code,status});

function createSharedWatchRequest(connection){
 return async(query,{signal})=>fetch(connection.url+'/api/v1/sync/shared/watch?'+query,{
  headers:{...syncHeaders(connection),Authorization:`Bearer ${connection.token}`,Accept:'text/event-stream','X-NativeSync-Protocol':'2','X-NativeSync-Capabilities':'shared-space-v1,shared-watch-v1'},
  redirect:'error',cache:'no-store',signal,
 });
}

const pause=(ms,signal)=>new Promise(resolve=>{
 if(signal.aborted)return resolve();
 const finish=()=>{clearTimeout(timer);signal.removeEventListener('abort',finish);resolve()};
 const timer=setTimeout(finish,ms);timer.unref?.();signal.addEventListener('abort',finish,{once:true});
});

class SharedWaitClient {
 constructor(send,space,wake,{openWatch,invalidate}={}){
  this.send=send;this.space=space;this.wake=wake;this.openWatch=openWatch;this.invalidate=invalidate;
  this.dirty=new Set(lanes);this.nextAudit=0;
 }
 all(){for(const lane of lanes)this.dirty.add(lane)}
 configure(enabled){
  const mode=enabled==='watch'&&this.openWatch?'watch':enabled===true?'wait':null;
  if(mode===(this.mode||null)&&(!mode||this.task))return;
  this.close();this.mode=mode;
  if(!mode)return;
  const controller=this.controller=new AbortController();
  const listen=mode==='watch'?this.watch(controller.signal):this.listen(controller.signal);
  this.task=listen.catch(()=>{if(!controller.signal.aborted){this.online=false;this.all();this.wake()}}).finally(()=>{if(this.controller===controller)this.task=null;});

 }
 close(){
  this.controller?.abort();this.controller=null;this.mode=null;this.online=false;this.transportError=null;this.nextAudit=0;this.all();
  const task=this.task;this.task=null;return task;
 }
 async listen(signal){
  let token,failures=0;
  while(!signal.aborted){
   const query=new URLSearchParams({sharedSpaceId:this.space});
   if(token)query.set('since',token);
   try{
    const started=performance.now();
    const value=await this.send('/api/v1/sync/shared/wait?'+query,{signal});
    if(signal.aborted)return;
    if(!validToken.test(value?.token)||!Array.isArray(value.changed)||!value.changed.every(k=>lanes.includes(k))
      ||(token===value.token && value.changed.length)
      ||(token && !value.changed.length && (value.token!==token || performance.now()-started<1000)))throw Error('INVALID_SHARED_WAIT');
    if(!token)this.all();
    for(const k of value.changed)this.dirty.add(k);
    token=value.token;failures=0;this.online=true;this.transportError=null;
    if(value.changed.length)this.wake();
   }catch(error){
    if(signal.aborted)return;
    this.online=false;this.transportError=error.code||'SHARED_WAIT_FAILED';this.all();token=undefined;
    if([401,403].includes(error.status)){this.invalidate?.(error);return;}
    const backoff=[403,404,409].includes(error.status)?30000:Math.min(10000,500*2**Math.min(failures++,5));
    await pause(backoff,signal);
   }
  }
 }
 async watch(signal){
  const {consumeSharedEvents}=await import('./sharedEventClient.mjs');
  let token,failures=0,reconnecting=false;
  while(!signal.aborted){
   const controller=new AbortController(),attempt=AbortSignal.any([signal,controller.signal]);
   const query=new URLSearchParams({sharedSpaceId:this.space});
   if(token)query.set('since',token);
   const readyDeadline=setTimeout(()=>controller.abort(),15000);readyDeadline.unref?.();
   const ready=()=>{
    if(attempt.aborted)return;
    clearTimeout(readyDeadline);
    if(!this.online){this.online=true;this.transportError=null;this.all();this.wake(reconnecting?'reconnect':undefined);}
   };
   let connectedAt;
   try{
    const response=await this.openWatch(query,{signal:attempt});
    if(attempt.aborted){await response.body?.cancel();throw transportError('SHARED_WATCH_TIMEOUT');}
    if(!response.ok){
     await response.body?.cancel();
     throw transportError('SHARED_WATCH_UNAVAILABLE',response.status);
    }
    connectedAt=performance.now();
    await consumeSharedEvents(response,(value,event)=>{
     if(attempt.aborted)return;
     if(event==='invalidate'&&['capabilities_changed','authorization_lost'].includes(value.reason)){
      throw transportError('SHARED_WATCH_INVALIDATED',value.reason==='authorization_lost'?403:409);
     }
     if(event!=='hint'||typeof value.token!=='string'||!validToken.test(value.token)||!Array.isArray(value.changed)
      ||!value.changed.length||value.changed.length>lanes.length||new Set(value.changed).size!==value.changed.length
      ||!value.changed.every(lane=>lanes.includes(lane)))throw transportError('INVALID_SHARED_WATCH');
     // Accept duplicate wakeups without advancing any durable cursor.
     token=value.token;for(const lane of value.changed)this.dirty.add(lane);
     if(this.online)this.wake();else ready();
    },{signal:attempt,envelope:true,maxFrameBytes:2048,onComment:()=>{if(token)ready();}});
    throw transportError('SHARED_WATCH_DISCONNECTED');
   }catch(error){
    if(signal.aborted)return;
    this.online=false;this.transportError=error.code||'SHARED_WATCH_FAILED';
    if([401,403,404,409].includes(error.status)){token=undefined;this.invalidate?.(error);}
    if([401,403].includes(error.status))return;
    if(reconnecting){this.all();this.wake('reconnect');}
    reconnecting=true;
    if(connectedAt!==undefined&&performance.now()-connectedAt>=30000)failures=0;
   }finally{clearTimeout(readyDeadline);controller.abort();}
   const base=Math.min(30000,1000*2**Math.min(failures++,5));
   await pause(Math.min(30000,Math.round(base*(0.8+Math.random()*0.4))),signal);
  }
 }
 take({audit=false}={}){
  if(audit)this.all();
  if(this.mode!=='watch'&&!this.online)return new Set(lanes);
  if(this.mode==='wait'&&performance.now()>=this.nextAudit){this.all();this.nextAudit=performance.now()+60000}
  const result=this.dirty;this.dirty=new Set();return result;
 }
}
module.exports={SharedWaitClient,createSharedWatchRequest,auditMs,lanes};

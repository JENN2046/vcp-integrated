'use strict';
const lanes=['matches','changes','pull'];
const validToken=/^[a-f0-9-]{36}(?:\.(?:0|[a-f0-9]{16})){3}$/;
class SharedWaitClient {
 constructor(send,space,wake){
  this.send=send;this.space=space;this.wake=wake;this.dirty=new Set(lanes);this.nextAudit=0;
 }
 all(){for(const lane of lanes)this.dirty.add(lane)}
 configure(enabled){
  if(!enabled){this.close();return}
  if(this.controller)return;
  const controller=this.controller=new AbortController();
  this.listen(controller.signal).catch(()=>{if(!controller.signal.aborted){this.online=false;this.all()}});
 }
 close(){
  this.controller?.abort();this.controller=null;this.online=false;this.transportError=null;this.all();
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
    const backoff=[403,404,409].includes(error.status)?30000:Math.min(10000,500*2**Math.min(failures++,5));
    await new Promise(resolve=>{
     const finish=()=>{clearTimeout(timer);signal.removeEventListener('abort',finish);resolve()};
     const timer=setTimeout(finish,backoff);timer.unref?.();signal.addEventListener('abort',finish,{once:true});
    });
   }
  }
 }
 take(){
  if(!this.online)return new Set(lanes);
  if(performance.now()>=this.nextAudit){this.all();this.nextAudit=performance.now()+60000}
  const result=this.dirty;this.dirty=new Set();return result;
 }
}
module.exports={SharedWaitClient};

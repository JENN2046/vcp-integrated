'use strict';
const fail=(code,status=400)=>Object.assign(Error(code),{code,status});
// Existing authenticated HTTP routes call this adapter with a fresh actor
// resolver. Never put credentials in URLs or reuse a captured mobile session.
function openSharedEventStream({shared,req,res,resolveActor,query,onClose=()=>{},heartbeatMs=15000}){
 if(!shared?.events||typeof resolveActor!=='function')throw fail('SHARED_EVENTS_UNAVAILABLE',409);
 if(!Number.isSafeInteger(heartbeatMs)||heartbeatMs<1)throw fail('INVALID_SHARED_EVENT_REQUEST');
 const parameters=new URL(req.url,'http://nativesync.invalid').searchParams;
 if(!query&&parameters.size!==new Set(parameters.keys()).size)throw fail('INVALID_SHARED_EVENT_REQUEST');
 const source=query||Object.fromEntries(parameters),keys=['scope','sharedSpaceId','sharedId','executionId','after','epoch'];
 if(Object.keys(source).some(key=>!keys.includes(key)))throw fail('INVALID_SHARED_EVENT_REQUEST');
 const topicScope=source.scope==='topic';
 if(source.scope!==undefined&&!topicScope||topicScope&&Object.keys(source).some(key=>['executionId','after','epoch'].includes(key)))throw fail('INVALID_SHARED_EVENT_REQUEST');
 const cursor=source.after===undefined?undefined:Number(source.after);
 if(source.after!==undefined&&(!/^\d+$/.test(String(source.after))||!Number.isSafeInteger(cursor)))throw fail('INVALID_SHARED_EVENT_CURSOR');
 if(source.epoch!==undefined&&(typeof source.epoch!=='string'||source.epoch.length>100))throw fail('INVALID_SHARED_EVENT_CURSOR');
 const scope={sharedSpaceId:source.sharedSpaceId,sharedId:source.sharedId,...(topicScope?{scope:'topic'}:{executionId:source.executionId})};
 const actor=resolveActor();if(actor?.then)throw fail('ASYNC_SHARED_EVENT_ACTOR');if(topicScope)shared.events.validateTopicSubscription(actor,scope);else shared.events.validateSubscription(actor,scope);
 let subscription,timer,drainTimer,closed=false,blocked=false,pending=[],pendingBytes=0;
 const close=reason=>{if(closed)return;closed=true;clearInterval(timer);clearTimeout(drainTimer);pending=[];pendingBytes=0;subscription?.close();req.removeListener('aborted',aborted);res.removeListener('close',aborted);res.removeListener('drain',drain);if(!res.writableEnded)res.end();try{onClose(reason);}catch{/* Observer cleanup cannot stop native execution. */}};
 const aborted=()=>close('observer_closed');
 const authorized=()=>{try{const current=resolveActor();if(current?.then)throw fail('ASYNC_SHARED_EVENT_ACTOR');if(topicScope)shared.events.validateTopic(current,scope);else shared.events.validate(current,scope);return true;}catch{close('authorization_lost');return false;}};
 const write=frame=>{if(!authorized())return;if(!res.write(frame)){blocked=true;clearTimeout(drainTimer);drainTimer=setTimeout(()=>close('slow_subscriber'),30000);drainTimer.unref?.();}};
 const drain=()=>{if(closed)return;blocked=false;clearTimeout(drainTimer);while(pending.length&&!blocked){const frame=pending.shift();pendingBytes-=Buffer.byteLength(frame);write(frame);}};
 const send=event=>{
  if(closed||res.destroyed||res.writableEnded)return false;
  if(!authorized())return false;
  // Node accepts the entire write even when it asks for backpressure. A large
  // valid snapshot gets one bounded write plus time to drain; later events
  // have a separate bounded queue, never a second model execution lifetime.
  const frame=event.type==='heartbeat'?': heartbeat\n\n':`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  if(blocked){if(event.type==='heartbeat')return true;pendingBytes+=Buffer.byteLength(frame);if(pendingBytes>512*1024||pending.length>=256){close('slow_subscriber');return false;}pending.push(frame);}else write(frame);return true;
 };
 try{
  res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','X-Accel-Buffering':'no'});res.flushHeaders?.();
  req.once('aborted',aborted);res.once('close',aborted);res.on('drain',drain);
  subscription=topicScope?shared.events.subscribeTopic(actor,scope,send,{onClose:close}):shared.events.subscribe(actor,scope,send,{after:cursor,epoch:source.epoch,onClose:close});
  if(closed)subscription.close();else{timer=setInterval(()=>send({type:'heartbeat'}),heartbeatMs);timer.unref?.();}
  return {close:()=>close('observer_closed')};
 }catch(error){close('stream_error');throw error;}
}
module.exports={openSharedEventStream};

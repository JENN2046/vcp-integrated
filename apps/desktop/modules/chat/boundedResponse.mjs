/** Bounded body reads: heartbeats and tiny chunks do not renew the wall deadline. */
export async function readResponseText(response,{maxBytes=32*1024*1024,deadline=Date.now()+900000,signal}={}){
 const fail=code=>Object.assign(Error(code),{code});let timer,onAbort,reader;
 const stop=()=>{try{reader?.cancel?.().catch?.(()=>{});response.body?.destroy?.();}catch{}};
 try{
  if(signal?.aborted)throw fail('RESPONSE_ABORTED');
  const bytes=[];let size=0;const add=part=>{const data=typeof part==='string'?new TextEncoder().encode(part):new Uint8Array(part);size+=data.byteLength;if(size>maxBytes)throw fail('RESPONSE_BODY_TOO_LARGE');bytes.push(data);};
  const task=(async()=>{
   if(response.body?.getReader){reader=response.body.getReader();while(true){const value=await reader.read();if(value.done)break;add(value.value);}}
   else if(response.body?.[Symbol.asyncIterator]){for await(const part of response.body)add(part);}
   else add(await response.text());
   const combined=new Uint8Array(size);let offset=0;for(const part of bytes){combined.set(part,offset);offset+=part.length;}return new TextDecoder('utf-8',{fatal:true}).decode(combined);
  })();
  return await Promise.race([task,new Promise((_,reject)=>{timer=setTimeout(()=>reject(fail('RESPONSE_BODY_TIMEOUT')),Math.max(1,deadline-Date.now()));onAbort=()=>reject(fail('RESPONSE_ABORTED'));signal?.addEventListener('abort',onAbort,{once:true});if(signal?.aborted)onAbort();})]);
 }catch(error){stop();throw error;}finally{clearTimeout(timer);if(onAbort)signal?.removeEventListener('abort',onAbort);try{reader?.releaseLock?.();}catch{}}
}
export function validateCompletion(value){
 const choice=value?.choices?.[0],code=value?.error?.code||(value?.error?'VCP_UPSTREAM_ERROR':!choice||!choice.message||!['stop','length','content_filter','tool_calls','function_call'].includes(choice.finish_reason)?'MODEL_RESPONSE_INCOMPLETE':null);
 if(code){const error=Object.assign(Error(code),{code});if(typeof choice?.message?.content==='string'&&choice.message.content)Object.defineProperty(error,'partialText',{value:choice.message.content});throw error;}return value;
}

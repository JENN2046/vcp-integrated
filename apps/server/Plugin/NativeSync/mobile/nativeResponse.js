'use strict';
const {groupStreamDelta}=require('../nativeRules/Groupmodules/streamDelta');
const {createHash}=require('node:crypto');
const MAX_OUTPUT=4*1024*1024;
const error=(code,partialContent='')=>Object.assign(new Error(code),{code,partialContent});
const hash=text=>createHash('sha256').update(text).digest('hex');

// Framing evidence is not native execution success. The native handler and
// task ledger still own tools, completion and unknown-side-effect protection.
async function nativeResponse({endpoint,body,controller,headerTimeoutMs=120000,idleTimeoutMs=62000,onWaiting,onDelta,observation,headers={}}){
 let observedJSON=null,observedError=null,observedSuccess=false;
 let timer,phase='headers',partial='',waiting=false,timedOut=null,finishReason=null;
 const emitDelta=value=>{try{onDelta?.(value);}catch{/* observation never changes execution */}};
 const arm=()=>{clearTimeout(timer);if(!waiting)timer=setTimeout(()=>{timedOut=phase==='headers'?'RESPONSE_HEADER_TIMEOUT_REVIEW_REQUIRED':'STREAM_IDLE_TIMEOUT_REVIEW_REQUIRED';controller.abort();},phase==='headers'?headerTimeoutMs:idleTimeoutMs);};
 const setWaiting=value=>{waiting=value;arm();};onWaiting?.(setWaiting);arm();
 const terminal=reason=>{
  if(reason===undefined||reason===null||reason==='')throw error('STREAM_INCOMPLETE_REVIEW_REQUIRED',partial);
  if(!['stop','length'].includes(reason))throw error('MODEL_TERMINAL_INVALID_REVIEW_REQUIRED',partial);
  if(finishReason&&finishReason!==reason)throw error('MODEL_TERMINAL_CONFLICT_REVIEW_REQUIRED',partial);
  finishReason=reason;
 };
 const result=transport=>{
  if(!finishReason)throw error('STREAM_INCOMPLETE_REVIEW_REQUIRED',partial);
  if(!partial)throw error('INVALID_MODEL_RESULT_REVIEW_REQUIRED');
  if(finishReason==='length'&&(typeof body.requestId!=='string'||!body.requestId))throw error('MODEL_RESPONSE_IDENTITY_REVIEW_REQUIRED',partial);
  observedSuccess=true;
  return {content:partial,finishReason,terminalEvidence:{version:1,nativeRequestId:body.requestId,finishReason,transport,contentHash:hash(partial)}};
 };
 try{
  const response=await fetch(endpoint.url,{method:'POST',headers:{...headers,Authorization:`Bearer ${endpoint.key}`,'Content-Type':'application/json'},redirect:'error',signal:controller.signal,body:JSON.stringify(body)});
  if(!response.ok){const status=response.status;try{await response.body?.cancel();}catch{}return {modelError:true,httpStatus:status,content:''};}
  phase='body';arm();
  const type=response.headers.get('content-type')||'';
  if(!body.stream||!type.includes('text/event-stream')){
   let raw='';const decoder=new TextDecoder('utf-8',{fatal:true});for await(const chunk of response.body){arm();raw+=decoder.decode(chunk,{stream:true});if(Buffer.byteLength(raw)>MAX_OUTPUT)throw error('MODEL_RESPONSE_BUDGET_REVIEW_REQUIRED');}raw+=decoder.decode();
   let value;try{value=JSON.parse(raw);}catch{throw error('INVALID_MODEL_RESULT_REVIEW_REQUIRED');}
   if(!value||typeof value!=='object'||Array.isArray(value))throw error('INVALID_MODEL_RESULT_REVIEW_REQUIRED');
   observedJSON=value;
   const choice=value.choices?.[0],content=choice?.message?.content;
   if(typeof content==='string')partial=content;
   if(Object.hasOwn(value,'error')){const status=Number(value.error?.status||value.error?.code);if(Number.isInteger(status)&&status>=400&&status<=599)return {modelError:true,httpStatus:status,content:partial};throw error('MODEL_STREAM_ERROR_REVIEW_REQUIRED',partial);}
   terminal(choice?.finish_reason);
   if(value.nativeFailure&&!(finishReason==='length'&&value.nativeFailure.code==='MODEL_RESPONSE_TRUNCATED'))throw error('MODEL_STREAM_ERROR_REVIEW_REQUIRED',partial);
   const out=result('json');emitDelta({text:partial,offset:0});return out;
  }
  const decoder=new TextDecoder('utf-8',{fatal:true}),reader=response.body.getReader();let buffer='',done=false;
  const frame=raw=>{
   const data=raw.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n').trim();
   if(!data)return;
   if(done)throw error('MODEL_TERMINAL_CONFLICT_REVIEW_REQUIRED',partial);
   if(data==='[DONE]'){done=true;return;}
   let value;try{value=JSON.parse(data);}catch{throw error('STREAM_MALFORMED_REVIEW_REQUIRED',partial);}
   if(!value||typeof value!=='object'||Array.isArray(value))throw error('STREAM_MALFORMED_REVIEW_REQUIRED',partial);
   if(Object.hasOwn(value,'error')){const status=Number(value.error?.status||value.error?.code);if(Number.isInteger(status)&&status>=400&&status<=599)throw Object.assign(error('MODEL_HTTP_ERROR',partial),{httpStatus:status});throw error('MODEL_STREAM_ERROR_REVIEW_REQUIRED',partial);}
   try{observation?.chunk(value);}catch{}
   const text=groupStreamDelta(value),offset=partial.length;partial+=text;
   if(Buffer.byteLength(partial)>MAX_OUTPUT)throw error('MODEL_RESPONSE_BUDGET_REVIEW_REQUIRED',Buffer.from(partial).subarray(0,MAX_OUTPUT).toString('utf8').replace(/\uFFFD$/,''));
   const reason=value.choices?.[0]?.finish_reason;
   if(reason!==undefined&&reason!==null)terminal(reason);
   if(value.nativeFailure&&!(finishReason==='length'&&value.nativeFailure.code==='MODEL_RESPONSE_TRUNCATED'))throw error('MODEL_STREAM_ERROR_REVIEW_REQUIRED',partial);
   if(text)emitDelta({text,offset});
  };
  try{
   while(true){
    const value=await reader.read();
    if(value.done){buffer+=decoder.decode();break;}
    arm();buffer+=decoder.decode(value.value,{stream:true});let boundary;
    while((boundary=/\r?\n\r?\n/.exec(buffer))){frame(buffer.slice(0,boundary.index));buffer=buffer.slice(boundary.index+boundary[0].length);}
    if(buffer.length>MAX_OUTPUT)throw error('STREAM_MALFORMED_REVIEW_REQUIRED',partial);
    if(done){if(buffer.trim())throw error('STREAM_MALFORMED_REVIEW_REQUIRED',partial);break;}
   }
   if(buffer.trim())throw error('STREAM_INCOMPLETE_REVIEW_REQUIRED',partial);
   return result('sse');
  }finally{try{await reader.cancel();}catch{}reader.releaseLock();}
 }catch(e){
  observedError=e;
  if(timedOut)throw error(timedOut,partial);
  if(typeof e.code==='string'&&e.code.startsWith('ERR_ENCODING_'))throw error('STREAM_MALFORMED_REVIEW_REQUIRED',partial);
  if(e.code==='MODEL_HTTP_ERROR')return {modelError:true,httpStatus:e.httpStatus,content:e.partialContent||''};
  if(typeof e.code==='string')throw Object.assign(e,{partialContent:e.partialContent||partial});
  throw error(controller.signal.aborted?'EXECUTION_INTERRUPTED_REVIEW_REQUIRED':'MODEL_TRANSPORT_REVIEW_REQUIRED',partial);
 }finally{try{observation?.finish(observedSuccess?(observedJSON?{response:observedJSON}:{}):{error:{name:'NativeExecution',message:observedError?.code||'MODEL_RESPONSE_UNCONFIRMED'}});}catch{}clearTimeout(timer);onWaiting?.(null);}
}
module.exports={nativeResponse};

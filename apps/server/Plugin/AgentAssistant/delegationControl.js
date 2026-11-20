'use strict';
const path=require('node:path'),{createHash}=require('node:crypto');
const {identityOf,sameIdentity}=require('./delegationContinuity');
const {createNativeContinuationStore}=require('../../modules/nativeContinuationStore.cjs');
const fail=code=>Object.assign(Error(code),{code});
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** AA owns checkpoints. NativeSync receives only identity-bound control receipts. */
function createDelegationControl(root){
 const store=createNativeContinuationStore(path.join(root,'.state/native-aa-control'));
 const key=identity=>'aa-control:'+identity.nativeTaskId;
 const read=identity=>{
  identity=identityOf(identity);const data=store.read(key(identity));if(!data)return null;
  if(!sameIdentity(data.control?.identity,identity))throw fail('NATIVE_TASK_CONTROL_IDENTITY_CHANGED');return data;
 };
 const receipt=data=>({identity:{...data.control.identity},workId:data.control.workId,controlRevision:data.control.revision,appliedControlRevision:data.control.appliedRevision,
  inputRefs:data.control.inputRefs||[],dependenciesReady:data.control.ready===true,state:data.control.finalized?'finalized':data.control.finalIntent?'finalizing':data.control.inFlight?'running':data.control.revision>data.control.appliedRevision?'waiting_safe_boundary':'applied',
  safeBoundary:!data.control.inFlight,checkpointRevision:data.revision,checkpointHash:digest(data),childRequestId:data.control.inFlight?.requestId||null});
 return Object.freeze({
  accept(identity,{workId,task}){
   identity=identityOf(identity);if(read(identity))return;
   store.begin({workId,requestId:key(identity),controlRevision:0},[]);
   store.update(key(identity),data=>{data.control={identity,workId,task,revision:0,appliedRevision:0,inputRefs:[],appliedInputs:[],pending:[],ready:true,inFlight:null,round:0,finalized:false,receipts:{}};});
  },
  read(identity){const data=read(identity);return data?receipt(data):null;},
  checkpoint(identity){const data=read(identity);return data?{messages:data.messages,round:data.control.round,inFlight:data.control.inFlight,task:data.control.task,phase:data.control.phase||null,response:data.control.response||null,resumeState:data.control.resumeState||null,finalIntent:data.control.finalIntent||null,deliveries:data.control.deliveries||{},nextAt:data.control.nextAt||null,...receipt(data)}:null;},
  request(identity,request){
   const data=read(identity);if(!data)throw fail('NATIVE_TASK_CONTROL_UNAVAILABLE');const c=data.control;
   if(request.workId!==c.workId||typeof request.opId!=='string'||!Array.isArray(request.inputRefs)||!Array.isArray(request.inputs))throw fail('INVALID_NATIVE_TASK_CONTROL');
   const hash=digest(request),prior=c.receipts[request.opId];if(prior){if(prior.hash!==hash)throw fail('IDEMPOTENCY_KEY_REUSED');return prior.receipt;}
   if(c.finalized)return {...receipt(data),alreadyFinalized:true};
   if(request.expectedRevision!==c.revision||!Number.isSafeInteger(request.controlRevision)||request.controlRevision<c.revision||request.controlRevision===c.revision&&(c.ready||!request.ready||JSON.stringify(c.inputRefs)!==JSON.stringify(request.inputRefs)))throw fail('NATIVE_TASK_CONTROL_REVISION_CHANGED');
   if(request.inputs.length!==request.inputRefs.length||request.inputs.some((input,i)=>input.inputId!==request.inputRefs[i]))throw fail('NATIVE_TASK_CONTROL_INPUT_CHANGED');
   const saved=store.update(key(identity),next=>{
    next.control.revision=request.controlRevision;next.control.inputRefs=[...request.inputRefs];next.control.pending=request.inputs;next.control.ready=request.ready===true;
    next.control.receipts[request.opId]={hash,receipt:{...receipt(next),state:'accepted'}};
   });return saved.control.receipts[request.opId].receipt;
  },
  save(identity,{messages,round,inFlight,phase,response,resumeState,nextAt}){
   const data=read(identity);if(!data)throw fail('NATIVE_TASK_CONTROL_UNAVAILABLE');
   return receipt(store.update(key(identity),next=>{if(messages!==undefined)next.messages=messages;if(round!==undefined)next.control.round=round;if(inFlight!==undefined)next.control.inFlight=inFlight;if(phase!==undefined)next.control.phase=phase;if(response!==undefined)next.control.response=response;if(resumeState!==undefined)next.control.resumeState=resumeState;if(nextAt!==undefined)next.control.nextAt=nextAt;}));
  },
  apply(identity,messages){
   const data=read(identity);if(!data||data.control.finalized)throw fail('NATIVE_TASK_CONTROL_UNAVAILABLE');
   if(data.control.inFlight)throw fail('NATIVE_TASK_SAFE_BOUNDARY_PENDING');if(!data.control.ready)return {ready:false,...receipt(data)};
   const pending=data.control.pending.filter(input=>!data.control.appliedInputs.includes(input.inputId));
   const nextMessages=[...messages,...pending.map(input=>{const prefix='[用户对当前工作的最新补充；保留已完成成果，在原任务范围内据此调整，勿重复已执行动作]\n';if(input.message.attachments?.length){if(!Array.isArray(input.modelContent))throw fail('NATIVE_TASK_ATTACHMENTS_NOT_READY');return {role:'user',content:[{type:'text',text:prefix},...input.modelContent]};}return {role:'user',content:prefix+input.message.content};})];
   const saved=store.update(key(identity),next=>{next.messages=nextMessages;next.control.appliedInputs.push(...pending.map(input=>input.inputId));next.control.appliedRevision=next.control.revision;next.control.pending=[];});
   return {ready:true,messages:nextMessages,...receipt(saved)};
  },
  finalIntent(identity,intent){
   const data=read(identity);if(!data||data.control.inFlight||data.control.revision!==intent.revision||data.control.appliedRevision!==intent.revision)throw fail('WORK_STEERING_PENDING');
   return receipt(store.update(key(identity),next=>{next.control.finalIntent=intent;next.control.phase='finalizing';}));
  },
  clearFinalIntent(identity){return store.update(key(identity),next=>{if(next.control.finalized)throw fail('NATIVE_TASK_CONTROL_CLOSED');next.control.finalIntent=null;});},
  claimDelivery(identity,name){
   if(!['callback','award'].includes(name))throw fail('INVALID_NATIVE_TASK_DELIVERY');const data=read(identity);if(!data?.control.finalized)throw fail('NATIVE_TASK_CONTROL_CLOSED');if(data.control.deliveries?.[name])return false;
   store.update(key(identity),next=>{next.control.deliveries||={};next.control.deliveries[name]={attemptedAt:Date.now()};});return true;
  },
  markFinal(identity,revision){
   const data=read(identity);if(!data||data.control.revision!==revision||data.control.appliedRevision!==revision||data.control.inFlight)throw fail('WORK_STEERING_PENDING');
   return receipt(store.update(key(identity),next=>{next.control.finalized=true;}));
  },
 });
}
module.exports={createDelegationControl};

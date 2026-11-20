'use strict';
const {AsyncLocalStorage}=require('node:async_hooks');
const {randomUUID}=require('node:crypto');
const {sharedEffectiveRules}=require('./contracts.generated.cjs');
const {fail}=require('./protocol');
const local=new AsyncLocalStorage();
const current=()=>local.getStore();
function groupConfig(groupId){const s=current();return s?.descriptor.itemId===groupId?s.config:null;}
function rules(fallback){return current()?.rules||fallback();}
function policy(settings){return current()?{...settings,...current().record.config.rules[0]?.config.executionPolicy}:settings;}
function speakers(){return current()?.plan.map(id=>current().members.find(m=>m.id===id));}
function contextText(history,message,text,member,currentId){
 const s=current();if(!s)return text;
 if(s.regexHistory!==history||s.regexRules!==member.stripRegexes||s.regexCurrent!==currentId){s.regexHistory=history;s.regexRules=member.stripRegexes;s.regexCurrent=currentId;s.regexTransform=require('./contracts.generated.cjs').sharedContextTransform(history,member.stripRegexes,currentId);}
 return s.regexTransform(text,message);
}
function replyId(memberId,fallback){
 const s=current();if(!s)return fallback;
 const member=s.execution.runtime.sharedMember(memberId),step=s.execution.groupStep(s.record,member);s.step={...step,localId:memberId};return 'reply_'+step.id;
}
async function history(groupId,topicId,fallback){
 const s=current();if(!s)return fallback;
 const rows=await s.execution.runtime.replica.queue.read(s.mapping.shared);
 const index=s.record.accepted.turn.kind==='regenerate'?rows.findIndex(m=>m.id===s.record.accepted.turn.targetId):null;
 if(index!==null&&index<0)throw fail('SHARED_REGENERATION_TARGET_CHANGED');
 return (index===null?rows:rows.slice(0,index)).map(m=>({...m,...(m.agentId?{agentId:s.execution.runtime.localFor(m.agentId).localId}:{}),...(m.groupId?{groupId}:{}),...(m.topicId?{topicId}:{})}));
}
async function append(groupId,topicId,message){
 const s=current();if(!s)return null;
 if(message.role==='user'){
  if(s.record.body.message?.id!==message.id)throw fail('SHARED_USER_NOT_MATERIALIZED');
  return s.execution.runtime.replica.queue.read(s.mapping.shared);
 }
 return s.execution.groupReply(s.record,message);
}
async function send(fetch,url,options){
 const s=current();if(!s)return fetch(url,options);if(!s.step)throw fail('SHARED_NATIVE_ADMISSION_REQUIRED');
 const member=s.members.find(m=>m.id===s.step.localId),packet=JSON.parse(options.body);
 packet.requestId=s.step.id;packet.max_tokens=Number(member.maxOutputTokens);packet.contextTokenLimit=Number(member.contextTokenLimit);
 packet.vcpchatExtensions={...packet.vcpchatExtensions,requestContext:{ownerType:'group',agentId:s.step.localId,groupId:s.descriptor.itemId,topicId:s.descriptor.topicId,isGroupMessage:true}};
 const prepared=await s.execution.prepareGroupNative(s.record,s.step.memberId,packet);
 return fetch(url,{...options,headers:{...options.headers,...prepared.headers},body:JSON.stringify(prepared.body)});
}
async function run(queue,descriptor,message,options,invoke){
 const execution=queue?.syncPolicy?.sharedExecution;
 if(!execution||!execution.runtime.nativeObject('group',descriptor.itemId))return invoke(null);
 const payload=message||{id:'explicit_'+randomUUID().replaceAll('-',''),role:'user',content:'',timestamp:Date.now()};
 const prepared=await execution.prepare(descriptor,payload,options),record=prepared.record;
 const config=prepared.config;config.modeSettings={...config.modeSettings,naturerandom:{memberTags:config.memberTags||{},tagMatchMode:config.tagMatchMode||'strict'}};
 const s={execution,descriptor,record,config,members:prepared.members,mapping:execution.mapping(descriptor),rules:sharedEffectiveRules([...(record.config.rules[0]?.config.tavernRules||[]),...(record.config.owner.config.tavernRules||[])],record.config.owner.config.ruleOverrides||{}),plan:record.accepted.turn.plan.map(id=>execution.runtime.localFor(id).localId)};
 execution.liveGroups.add(record.accepted.id);
 try{return await local.run(s,async()=>{const result=await invoke(s);await execution.groupDone(record);return result;});}finally{execution.liveGroups.delete(record.accepted.id);}
}
function wrap(queue,kind,original,invite){return async(...args)=>{
 const [groupId,topicId,input,emit,load]=args,execution=queue?.syncPolicy?.sharedExecution;
 if(!execution?.runtime.nativeObject('group',groupId))return original(...args);
 let memberId=kind==='invite'?input:kind==='regenerate'?args[3]:null;
 const sharedMember=memberId&&(execution.runtime.state.objects[memberId]?.kind==='agent'?memberId:execution.runtime.sharedMember(memberId));
 if(sharedMember)memberId=execution.runtime.localFor(sharedMember).localId;
 const notify=kind==='regenerate'?args[4]:emit,lookup=kind==='regenerate'?args[5]:load;
 const message=kind==='message'?{...input,role:'user',content:input.originalUserText??input.content?.text??input.content}:null;
 const options=kind==='message'?{}:{kind,...(kind==='regenerate'?{targetId:input}:{}),memberId:sharedMember};
 return run(queue,{itemType:'group',itemId:groupId,topicId},message,options,async s=>{
  const frozen=async id=>{const member=s.members.find(m=>m.id===id);if(!member)throw fail('SHARED_MEMBER_NOT_AUTHORIZED');return {...await lookup(id),...member};};
  if(kind==='regenerate')return invite(groupId,topicId,memberId,notify,frozen);
  return original(groupId,topicId,kind==='invite'?memberId:input,notify,frozen,args[5]);
 });
};}
module.exports={current,groupConfig,rules,policy,speakers,contextText,replyId,history,append,send,run,wrap};

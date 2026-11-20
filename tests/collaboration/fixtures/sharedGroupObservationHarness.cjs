'use strict';
const assert=require('node:assert/strict');
const {fixture,wait,ctx,BOX}=require('./sharedSingleHarness.cjs');
async function groupFixture(t,{two=false}={}){
 const f=await fixture(t);
 const second=two?f.shared.create(f.actor('A'),{sharedSpaceId:'sharedAB',opId:'l2-member-two',kind:'agent',localId:'l2second',config:{name:'L2 second',model:'synthetic',systemPrompt:'SYNTHETIC_SECOND',streamOutput:true}}).object:null;
 const members=two?[f.owner.id,second.id]:[f.owner.id];
 const group=f.shared.create(f.actor('A'),{sharedSpaceId:'sharedAB',opId:'l2-group',kind:'group',localId:'l2g',config:{name:'L2 native group',mode:'sequential',members,sequentialSpeakerOrder:members}}).object;
 const topic=f.shared.create(f.actor('A'),{sharedSpaceId:'sharedAB',opId:'l2-topic',kind:'topic',parentId:group.id,localId:'l2gt',localParent:'l2g',config:{name:'L2 observation'}}).object;
 const a=await f.desktop('A'),b=await f.desktop('B');
 const descriptor=d=>({itemType:'group',itemId:d.runtime.localFor(group.id).localId,topicId:d.runtime.localFor(topic.id).localId});
 return {...f,f,group,topic,a,b,descriptor};
}
async function nativeStart(g,id,{stream=false}={}){
 const {f,a,descriptor}=g,prepared=await a.runtime.prepareSharedSend({descriptor:descriptor(a),message:{id,role:'user',content:'L2 synthetic native group input',timestamp:1}}),record=prepared.record;
 const member=prepared.turn.plan[0],slot=a.runtime.execution.groupStep(record,member);
 const body={model:'synthetic',stream,requestId:slot.id,messages:[{role:'user',content:'synthetic'}],vcpchatExtensions:{requestContext:{ownerType:'group',agentId:a.runtime.localFor(member).localId,groupId:descriptor(a).itemId,topicId:descriptor(a).topicId}}};
 const native=await a.runtime.execution.prepareGroupNative(record,member,body);f.control.holdHttp=true;
 const response=fetch(f.url+'/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json',...native.headers},body:JSON.stringify(native.body)});
 response.catch(()=>{});
 await wait(()=>f.calls()===1,'native group dispatched once');
 return {record,slot,response};
}
async function finish(g,work){
 g.f.heldResponse.json({choices:[{message:{role:'assistant',content:'L2 native group result'},finish_reason:'stop'}]});
 const response=await work.response;assert.equal(response.status,200);const result=await response.json();
 await g.a.runtime.execution.groupReply(work.record,{id:'reply_'+work.slot.id,role:'assistant',agentId:g.a.runtime.localFor(g.f.owner.id).localId,content:result.choices[0].message.content,timestamp:2});
 await g.a.runtime.execution.groupDone(work.record);
}
function sse(stream,text,reason=null,extra={}){stream.write('data: '+JSON.stringify({choices:[{delta:{content:text,...extra},finish_reason:reason}]})+'\n\n');}
function installNativeStreamResponder(f,t){
 const {PassThrough}=require('node:stream'),StreamHandler=require(BOX+'/modules/handlers/streamHandler'),Parser=require(BOX+'/modules/vcpLoop/toolCallParser');
 const live=new Map();t.after(()=>{for(const input of live.values())input.destroy();});
 f.control.nativeResponder=(req,res)=>{
  res.writeHead(200,{'content-type':'text/event-stream'});const input=new PassThrough();live.set(req.body.requestId,input);
  const context={originalBody:req.body,pluginManager:{messagePreprocessors:new Map()},abortController:new AbortController(),ToolCallParser:Parser,toolExecutor:{execute:async()=>assert.fail('no synthetic tools'),executeAll:async()=>assert.fail('no synthetic tools')},fetchWithRetry:async()=>assert.fail('no second provider attempt')};
  new StreamHandler(context).handle(req,res,{ok:true,body:input}).catch(error=>{input.destroy();if(!res.destroyed)res.destroy(error);});
 };
 return live;
}

module.exports={groupFixture,nativeStart,finish,sse,installNativeStreamResponder};

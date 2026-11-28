'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
function nativeOwner(){
 const source=fs.readFileSync(path.join(__dirname,'../Groupmodules/groupchat.js'),'utf8');
 const begin=source.indexOf('async function startJevGroupChat('),end=source.indexOf('function getJevGroupChatState(',begin);assert.ok(begin>=0&&end>begin);
 const calls=[];
 const orchestrator={
  startRandomOpening(){calls.push('start');return {started:true,state:{status:'running'}};},
  async continue(){calls.push('continue');return {success:true,state:{status:'running'}};},
  enqueueAgent(){calls.push('enqueue');return {status:'running'};}
 };
 const ctx=vm.createContext({
  Error,
  getAgentGroupConfig:async()=>({mode:'jev',members:['agent']}),
  setGroupStreamCallback(){calls.push('callback');},
  ensureJevSessionOrchestrator(){calls.push('orchestrator');return orchestrator;}
 });
 vm.runInContext(source.slice(begin,end),ctx);return {calls,run:kind=>kind==='enqueue'?ctx.enqueueJevGroupAgent('group','topic','agent',()=>{}):kind==='start'?ctx.startJevGroupChat('group','topic',()=>{}):ctx.continueJevGroupChat('group','topic',()=>{})};
}
test('full native local JEV start/continue/invite remain functional without profile or mode deletion',async()=>{
 for(const kind of ['start','continue','enqueue']){const h=nativeOwner();assert.equal((await h.run(kind)).success,true);assert.deepEqual(h.calls,['callback','orchestrator',kind]);}
});

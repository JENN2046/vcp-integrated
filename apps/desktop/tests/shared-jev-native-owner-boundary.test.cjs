'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
function nativeOwner(shared){
 const file=process.env.NS_S3_GROUP_BASELINE_SOURCE||path.join(__dirname,'../Groupmodules/groupchat.js');const source=fs.readFileSync(file,'utf8');
 const helper=source.indexOf('function requireLocalJevAdmission('),begin=helper>=0?helper:source.indexOf('async function startJevGroupChat('),end=source.indexOf('function getJevGroupChatState(',begin);assert.ok(begin>=0&&end>begin);
 const calls=[];
 const orchestrator={
  startRandomOpening(){calls.push('start');return {started:true,state:{status:'running'}};},
  async continue(){calls.push('continue');return {success:true,state:{status:'running'}};},
  enqueueAgent(){calls.push('enqueue');return {status:'running'};}
 };
 const ctx=vm.createContext({
  Error,
  groupHistoryMutationQueue:{syncPolicy:{sharedExecution:{runtime:{nativeObject:()=>shared?{kind:'group'}:null}}}},
  getAgentGroupConfig:async()=>({mode:'jev',members:['agent']}),
  setGroupStreamCallback(){calls.push('callback');},
  ensureJevSessionOrchestrator(){calls.push('orchestrator');return orchestrator;}
 });
 vm.runInContext(source.slice(begin,end),ctx);return {calls,run:kind=>kind==='enqueue'?ctx.enqueueJevGroupAgent('group','topic','agent',()=>{}):kind==='start'?ctx.startJevGroupChat('group','topic',()=>{}):ctx.continueJevGroupChat('group','topic',()=>{})};
}
test('all native JEV mutation owners reject shared groups before callback or orchestrator side effects',async()=>{
 for(const kind of ['start','continue','enqueue']){const h=nativeOwner(true);await assert.rejects(h.run(kind),error=>error.code==='SHARED_NATIVE_ADMISSION_REQUIRED');assert.deepEqual(h.calls,[]);}
});
test('full native local JEV start/continue/invite remain functional without profile or mode deletion',async()=>{
 for(const kind of ['start','continue','enqueue']){const h=nativeOwner(false);assert.equal((await h.run(kind)).success,true);assert.deepEqual(h.calls,['callback','orchestrator',kind]);}
});
test('ordinary real invite IPC cannot bypass the native shared JEV owner',async()=>{
 const h=nativeOwner(true),callbacks=new Map(),module={exports:{}},source=fs.readFileSync(path.join(__dirname,'../modules/ipc/groupChatHandlers.js'),'utf8');
 const group={initializeRuntimeServices(){},getAgentGroupConfig:async()=>({mode:'jev'}),enqueueJevGroupAgent:()=>h.run('enqueue')};
 vm.runInNewContext('(function(require,module,exports){'+source+'\n})',{console:{log(){},error(){}}})(name=>{if(name==='electron')return {ipcMain:{handle:(name,fn)=>callbacks.set(name,fn)}};if(name==='path')return path;if(name==='url')return require('node:url');if(name==='fs-extra')return new Proxy({},{get(){throw Error('No filesystem access permitted in this test');}});if(name==='../../Groupmodules/groupchat')return group;if(name==='../modelTrajectory')return {};if(name==='../services/nativeSync/queries')return require('../modules/services/nativeSync/queries');if(name==='../services/historyMutationQueue')return require('../modules/services/historyMutationQueue');if(name==='../services/topicAdmissionGroup')return {createTopicAdmissionGroup:()=>()=>{}};throw Error(name);},module,module.exports);
 const main={webContents:{send(){},isDestroyed:()=>false},isDestroyed:()=>false};module.exports.initialize(main,{AGENT_DIR:'/synthetic/Agents',USER_DATA_DIR:'/synthetic/UserData',historyMutationQueue:{},topicAdmission:{}});
 const result=await callbacks.get('inviteAgentToSpeak')({sender:main.webContents},'group','topic','agent');assert.equal(result.success,false);assert.match(result.error,/共享/);assert.deepEqual(h.calls,[]);
});

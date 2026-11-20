'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
function handler({manager=true}={}) {
 const callbacks=new Map(),updates=[],files=[];let stored={name:'Synthetic agent'};
 const fakeFs=new Proxy({}, {get(_target,name){if(!['pathExists','readJson','writeJson','readFile','move','remove'].includes(name))throw Error('Unexpected filesystem method');return async(...args)=>{files.push([name,...args]);if(name==='pathExists')return true;if(name==='readJson')return {...stored};if(name==='writeJson'){stored={...args[1]};return;}if(name==='readFile')return JSON.stringify(stored);};}});
 const settingsManager={updateSettings:async updater=>{updates.push(['user',updater({})]);return {success:true};}};
 const agentConfigManager=manager?{updateAgentConfig:async(id,updater)=>{updates.push([id,updater({})]);return {success:true};}}:null;
 const module={exports:{}},body=fs.readFileSync(process.env.NS_S3_SETTINGS_BASELINE_SOURCE || path.join(__dirname,'../modules/ipc/settingsHandlers.js'),'utf8');
 vm.runInNewContext('(function(require,module,exports){'+body+'\n})',{console:{log(){},error(){}}})(name=>{if(name==='electron')return {ipcMain:{handle:(name,fn)=>callbacks.set(name,fn),on(){}},nativeTheme:{}};if(name==='path')return path;if(name==='../utils/agentConfigManager')return require('../modules/utils/agentConfigManager');if(name==='fs-extra')return fakeFs;if(name==='./themeHandlers')return {};throw Error('Unexpected dependency: '+name);},module,module.exports);
 module.exports.initialize({SETTINGS_FILE:'/synthetic/settings.json',USER_AVATAR_FILE:'/synthetic/user.png',AGENT_DIR:'/synthetic/Agents',settingsManager,agentConfigManager,mainWindow:null});
 return {updates,files,stored:()=>stored,run:payload=>callbacks.get('save-avatar-color')({},payload)};
}
test('avatar color owner rejects cross-directory IDs before manager or fallback IO',async()=>{
 for(const manager of [true,false])for(const id of ['../outside','..','.','a/b','/tmp/outside','agent\0bad',null,{}]){
  const h=handler({manager});const result=await h.run({type:'agent',id,color:'rgb(1,2,3)'});assert.deepEqual(h.updates,[]);assert.deepEqual(h.files,[]);assert.equal(result.code,'INVALID_AGENT_ID');
 }
});
test('valid user and agent styling remain functional without a release profile',async()=>{
 const agent=handler();assert.equal((await agent.run({type:'agent',id:'Agent_中文',color:'rgb(1,2,3)'})).success,true);assert.equal(agent.updates[0][0],'Agent_中文');assert.equal(agent.updates[0][1].avatarCalculatedColor,'rgb(1,2,3)');
 const user=handler();assert.equal((await user.run({type:'user',color:'#fff'})).success,true);assert.equal(user.updates[0][1].userAvatarCalculatedColor,'#fff');
 const fallback=handler({manager:false});assert.equal((await fallback.run({type:'agent',id:'Agent_valid',color:'#123456'})).success,true);assert.equal(fallback.stored().avatarCalculatedColor,'#123456');assert.ok(fallback.files.every(row=>String(row[1]).startsWith('/synthetic/Agents/Agent_valid/')));
});

test('Linux existing safe owner names keep avatar styling',async()=>{if(process.platform==='win32')return;for(const id of ['CON','legacy:name','a.','a ']){const h=handler();assert.equal((await h.run({type:'agent',id,color:'#fff'})).success,true);assert.equal(h.updates[0][0],id);}});

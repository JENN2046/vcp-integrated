'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const AgentConfigManager=require('../modules/utils/agentConfigManager');
const {actualIpcCallback,actualNamedFunction}=require('./helpers/ipc-source-fixture.cjs');
const invalid=['../outside','..','.','a/b','/tmp/outside','a\0b',null,{}];
test('actual AgentConfigManager path owner rejects invalid IDs without filesystem access',()=>{
 const manager=new AgentConfigManager('/synthetic/Agents');for(const id of invalid)assert.throws(()=>manager.getAgentPaths(id),e=>e.code==='INVALID_AGENT_ID');
});
function save(id){
 const writes=[],updates=[],manager=new AgentConfigManager('/synthetic/Agents');
 manager.updateAgentConfig=async id=>{updates.push(id);return {success:true};};
 const callback=actualIpcCallback(path.join(__dirname,'../modules/ipc/agentHandlers.js'),'save-agent-config',{
  AGENT_DIR:'/synthetic/Agents',path,AgentConfigManager,agentConfigManager:manager,invalidateCaches(){},
  fs:{writeJson:async file=>writes.push(file),pathExists:async file=>path.basename(file)==='config.json'},
  require:name=>{if(name==='../services/nativeSync/sharedHost')return {runtimeForRoot:()=>null};if(name==='../utils/agentConfigManager')return AgentConfigManager;throw Error(name);}
 });
 return {writes,updates,run:()=>callback({},id,{name:'Synthetic',stripRegexes:[{findPattern:'x'}]})};
}
test('save-agent-config rejects ID before its direct regex write and config owner',async()=>{
 for(const id of invalid){const h=save(id),result=await h.run();assert.deepEqual(h.writes,[]);assert.deepEqual(h.updates,[]);assert.match(result.error,/INVALID_AGENT_ID/);}
});
test('valid Unicode and ordinary IDs keep native paths and config write behavior',async()=>{
 const manager=new AgentConfigManager('/synthetic/Agents');for(const id of ['Agent_中文','Agent-123']){assert.equal(manager.getAgentPaths(id).configPath,path.join('/synthetic/Agents',id,'config.json'));const h=save(id);assert.equal((await h.run()).success,true);assert.equal(h.updates[0],id);assert.equal(h.writes[0],path.join('/synthetic/Agents',id,'regex_rules.json'));}
});

test('native read fallback and avatar caller reject IDs before config or listener effects',async()=>{
 const file=path.join(__dirname,'../modules/ipc/agentHandlers.js');
 for(const id of invalid){
  let calls=0;const context={AGENT_DIR_CACHE:'/synthetic/Agents',AgentConfigManager,path,agentConfigManagerInstance:{readAgentConfig:async()=>{calls++;return null;}},fs:new Proxy({},{get(){throw Error('Unexpected read');}})};
  context.resolveAgentDir=actualNamedFunction(file,'resolveAgentDir',context);const read=actualNamedFunction(file,'getAgentConfigById',context);assert.equal((await read(id)).code,'INVALID_AGENT_ID');assert.equal(calls,0);
  const avatar=actualIpcCallback(file,'save-avatar',{AgentConfigManager,context:{getSelectionListenerStatus(){calls++;return false;}},require:()=>{throw Error('Invalid ID reached native service lookup');}});assert.equal((await avatar({},id,{})).code,'INVALID_AGENT_ID');assert.equal(calls,0);
 }
});

test('Linux historical basenames stay readable; Windows-only restrictions and case policy stay native',()=>{
 const legacy=['CON','AUX','legacy:name','legacy?name','legacy*name','legacy|name','legacy<name>','a.','a ','a\\b'];
 if(process.platform!=='win32'){const manager=new AgentConfigManager('/synthetic/Agents');for(const id of legacy){assert.equal(manager.getAgentPaths(id).configPath,path.join('/synthetic/Agents',id,'config.json'));}}
 const fs=require('node:fs'),vm=require('node:vm'),module={exports:{}},body=fs.readFileSync(path.join(__dirname,'../modules/utils/agentConfigManager.js'),'utf8');
 vm.runInNewContext('(function(require,module,exports,process){'+body+'\n})')(name=>{if(name==='path')return path.win32;if(name==='events')return require('node:events');if(name==='node:crypto')return require('node:crypto');if(name==='fs-extra'||name==='./historyConfiguration'||name==='./atomicReplace')return {};throw Error(name);},module,module.exports,{platform:'win32'});
 const win=new module.exports('C:\\Synthetic\\Agents');for(const id of [...legacy,'C:outside','C:\\outside'])assert.throws(()=>win.getAgentPaths(id),e=>e.code==='INVALID_AGENT_ID');assert.equal(win.normalizeId('Agent_中文'),'agent_中文');
});

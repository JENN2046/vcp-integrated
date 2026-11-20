'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../modules/ipc/chatHandlers.js'),'utf8');
const begin=source.indexOf("    ipcMain.handle('create-new-topic-for-agent'");const end=source.indexOf("    ipcMain.handle('delete-topic'",begin);
function fixture({shared=true,tickError=false}={}) {
 let handler,bound=false,initialized=0,ticks=0,config={topics:[]};
 const runtime={assertNativeMutation(){},nativeObject:()=>shared?{id:'shared-owner'}:null,async tick(options){ticks++;assert.equal(options.forceLocal,true);assert.equal(options.skipExecution,true);assert.equal(options.skipAttachments,true);if(tickError)throw Error('OFFLINE');bound=true}};
 const queue={syncPolicy:{sharedExecution:{runtime}},async initializeIfMissing(d){initialized++;if(shared&&!bound)throw Error('SHARED_LOCAL_MAPPING_REQUIRED');assert.equal(config.topics[0].id,d.topicId)}};
 vm.runInNewContext(source.slice(begin,end),{ipcMain:{handle:(_name,fn)=>handler=fn},historyMutationQueue:queue,agentConfigManager:{readAgentConfig:async()=>structuredClone(config),updateAgentConfig:async(_id,fn)=>{config=fn(config)}},crypto:{randomUUID:()=> 'synthetic-topic'},console:{error(){}},Date});
 return{run:()=>handler({},'synthetic-owner','Synthetic Topic'),state:()=>({bound,initialized,ticks,config})};
}
test('shared new topic registers through existing discovery before guarded initialization',async()=>{const f=fixture();const result=await f.run();assert.equal(result.success,true);assert.equal(f.state().ticks,1);assert.equal(f.state().initialized,1);assert.equal(result.topicId,f.state().config.topics[0].id)});
test('failed shared registration retains topic metadata without initializing History',async()=>{const f=fixture({tickError:true});assert.equal((await f.run()).error,'OFFLINE');assert.equal(f.state().initialized,0);assert.equal(f.state().config.topics.length,1)});
test('local topic creation retains the native queue path without shared discovery',async()=>{const f=fixture({shared:false});assert.equal((await f.run()).success,true);assert.equal(f.state().ticks,0);assert.equal(f.state().initialized,1)});

'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),{pathToFileURL}=require('node:url');
const {registerNativeSyncQueries}=require('../modules/services/nativeSync/queries');
function fixture({missingWindowProvider=false}={}){
 const root=path.resolve(__dirname,'..'),url=pathToFileURL(path.join(root,'main.html')).href,handlers=new Map();let calls=0;
 const frame={url},contents={mainFrame:frame},win={webContents:contents,isDestroyed:()=>false};let current=win;
 const ipcMain={handle:(name,fn)=>handlers.set(name,fn),removeHandler:name=>handlers.delete(name)};
 const runtime=new Proxy({},{get:()=>async()=>({success:true,guarded:true})});
 const service=registerNativeSyncQueries({ipcMain,getRuntime:()=>{calls++;return runtime;},...(!missingWindowProvider?{getMainWindow:()=>current}:{})});
 const args=(name,event)=>name==='native-sync:executions'?[event,'owner','agent','topic',true]:name==='native-sync:task-result'?[event,'owner','agent','topic','work','task']:[event,{}];
 return {url,frame,contents,win,handlers,service,args,event:{sender:contents,senderFrame:frame},calls:()=>calls,setWindow:next=>{current=next;}};
}
test('every NativeSync control and sensitive query rejects auxiliary, child, old frame, wrong URL and absent sender before reading runtime',async()=>{
 const f=fixture();
 for(const event of [undefined,{}, {sender:f.contents}, {sender:{},senderFrame:f.frame},{sender:f.contents,senderFrame:{url:f.url}}, {sender:f.contents,senderFrame:{url:f.url.replace('main.html','other.html')}}]){
  for(const [name,fn]of f.handlers)assert.deepEqual(await fn(...f.args(name,event)),{success:false,error:'NATIVE_SYNC_MAIN_WINDOW_REQUIRED'},name);
 }
 assert.equal(f.calls(),0);
 for(const [name,fn]of f.handlers){const value=await fn(...f.args(name,f.event));assert.equal(value.success,true,name);}
 assert.equal(f.calls(),f.handlers.size);await f.service.close();assert.equal(f.handlers.size,0);
});
test('current main frame must still have the exact main.html URL and revoked window/frame identity never authorizes queued work',async()=>{
 const f=fixture(),call=()=>f.handlers.get('native-sync:handoff')(f.event,{}),deny={success:false,error:'NATIVE_SYNC_MAIN_WINDOW_REQUIRED'};
 f.frame.url=f.url+'?scope=kept#anchor';assert.equal((await call()).success,true);
 for(const url of [f.url.replace('main.html','main.html/other'),'https://example.invalid/main.html','',undefined]){f.frame.url=url;assert.deepEqual(await call(),deny);}
 f.frame.url=f.url;const pending=call();f.contents.mainFrame={url:f.url};assert.deepEqual(await pending,deny);
 f.contents.mainFrame=f.frame;f.setWindow({...f.win,webContents:{mainFrame:f.frame}});assert.deepEqual(await call(),deny);
 f.setWindow({...f.win,isDestroyed:()=>true});assert.deepEqual(await call(),deny);
 f.setWindow(null);assert.deepEqual(await call(),deny);await f.service.close();
});
test('missing trusted window context fails closed even with an otherwise legitimate sender',async()=>{
 const f=fixture({missingWindowProvider:true});for(const [name,fn]of f.handlers)assert.equal((await fn(...f.args(name,f.event))).error,'NATIVE_SYNC_MAIN_WINDOW_REQUIRED');assert.equal(f.calls(),0);await f.service.close();
});

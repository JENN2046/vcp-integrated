'use strict';
// Only an isolated Electron bootstrap may load this controlled-IPC probe.
const {app,BrowserWindow,ipcMain,session}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'../..'),target=pathToFileURL(path.join(root,'main.html')).href;
const {registerNativeSyncQueries}=require('../../modules/services/nativeSync/queries');
app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{
 let main,aux,current,service;let calls=0;const handlers=new Map(),results=[];
 const deny={success:false,error:'NATIVE_SYNC_MAIN_WINDOW_REQUIRED'};
 const probe='chatAPI.getNativeExecutionStatus("owner","agent","topic",true)';
 const inspect=win=>win.webContents.executeJavaScript(probe);
 try{
  const ses=session.fromPartition('native-sync-sender-isolated');
  await ses.protocol.handle('file',request=>new Response('<!doctype html><title>Controlled sender boundary</title>'+(!request.url.includes('frame=1')&&request.url.startsWith(target)?'<iframe src="'+target+'?frame=1"></iframe>':''),{headers:{'content-type':'text/html'}}));
  ipcMain.on('app-features:inactive-folders',event=>{event.returnValue=[];});
  let captured;ipcMain.on('native-sync-sender:capture',event=>{captured=event;});
  const fake={getExecutionStatus:async()=>{calls++;return {enabled:true,guarded:true};},submitSharedSteering:async()=>{calls++;return {success:true,guarded:true};}};
  const proxy={handle:(name,fn)=>{handlers.set(name,fn);ipcMain.handle(name,fn);},removeHandler:name=>{handlers.delete(name);ipcMain.removeHandler(name);}};
  service=registerNativeSyncQueries({ipcMain:proxy,getRuntime:()=>fake,getMainWindow:()=>current});
  const create=()=>new BrowserWindow({show:false,webPreferences:{preload:path.join(root,'preloads/bundled/dist/auxiliary-chat.cjs'),session:ses,sandbox:true,contextIsolation:true,nodeIntegration:false}});
  main=create();current=main;await main.loadURL(target);
  assert.equal((await inspect(main)).guarded,true);assert.equal(calls,1);results.push('actual main frame query accepted');
  assert.equal((await main.webContents.executeJavaScript('chatAPI.submitSharedSteering({})')).guarded,true);assert.equal(calls,2);results.push('actual main frame control accepted');
  const prefs=main.webContents.getLastWebPreferences();assert.equal(prefs.sandbox,true);assert.equal(prefs.contextIsolation,true);assert.equal(prefs.nodeIntegration,false);
  assert.deepEqual(await main.webContents.executeJavaScript('({require:typeof window.require,process:typeof window.process})'),{require:'undefined',process:'undefined'});
  aux=create();await aux.loadURL(target);assert.deepEqual(await inspect(aux),deny);assert.deepEqual(await aux.webContents.executeJavaScript('chatAPI.submitSharedSteering({})'),deny);assert.equal(calls,2);results.push('actual auxiliary chat-role IPC rejected');
  for(let i=0;!main.webContents.mainFrame.frames.length&&i<100;i++)await new Promise(r=>setTimeout(r,10));
  const child=main.webContents.mainFrame.frames[0];assert.ok(child);assert.equal(child.url.split('?')[0],target);
  assert.deepEqual(await handlers.get('native-sync:steer')({sender:main.webContents,senderFrame:child},{}),deny);assert.equal(calls,2);results.push('actual native child-frame object rejected with same URL');
  const previousWindow=main,previous=main.webContents.mainFrame;
  main=create();current=main;await main.loadURL(target+'?new-window=1');
  assert.notEqual(main.webContents.mainFrame,previous);
  assert.deepEqual(await inspect(previousWindow),deny);
  assert.deepEqual(await handlers.get('native-sync:steer')({sender:previousWindow.webContents,senderFrame:previous},{}),deny);
  previousWindow.destroy();results.push('actual previous main-window sender/frame rejected after recreation');
  assert.equal((await inspect(main)).guarded,true);assert.equal(calls,3);
  await main.loadURL(pathToFileURL(path.join(root,'other.html')).href);assert.deepEqual(await inspect(main),deny);assert.equal(calls,3);results.push('actual current main at wrong URL rejected');
  current=null;assert.deepEqual(await inspect(aux),deny);assert.deepEqual(await handlers.get('native-sync:steer')({},{}),deny);assert.equal(calls,3);results.push('missing current window or sender rejected');
  fs.writeFileSync(path.join(process.env.VCP_ELECTRON_TEST_DATA,'sender-verification.json'),JSON.stringify({status:'PASS',electron:process.versions.electron,sandbox:prefs.sandbox,contextIsolation:prefs.contextIsolation,nodeIntegration:prefs.nodeIntegration,results,calls,scope:'actual Electron role IPC for main/aux/wrong-URL; actual frame-object handler negatives; synthetic page/runtime, not full application'},null,2));
  console.log('NativeSync sender boundary verified: '+results.length+' checks');
 }catch(error){console.error(error);process.exitCode=1;}
 finally{await service?.close();if(aux&&!aux.isDestroyed())aux.destroy();if(main&&!main.isDestroyed())main.destroy();app.exit(process.exitCode||0);}
});

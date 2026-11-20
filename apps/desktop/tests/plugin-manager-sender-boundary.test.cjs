'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),{pathToFileURL}=require('node:url');
const {actualIpcCallback,actualNamedFunction}=require('./helpers/ipc-source-fixture.cjs');
const {createApplicationSenderGuard,isApplicationPageUrl}=require('../modules/ipc/applicationSender');
const desktop=path.join(__dirname,'../modules/ipc/desktopHandlers.js'),embedded=path.join(__dirname,'../modules/services/embeddedAppSessionManager.js'),root='/synthetic/app';
function contents(page,type='window'){const wc={isDestroyed:()=>false,getType:()=>type,getURL:()=>wc.url,url:pathToFileURL(path.join(root,page)).href};wc.mainFrame={url:wc.url,detached:false};return wc;}
function realGuard(standalone,view){
 const mainWindow={isDestroyed:()=>false},sessions=new Map(view?[['open-plugin-manager-window',{view:{webContents:view}}]]:[]);
 const owns=actualNamedFunction(embedded,'ownsRendererForAction',{mainWindow,sessions,appRoot:root,isApplicationPageUrl,embeddedAppAllowlist:require('../modules/shared/embeddedAppAllowlist')});
 const allowed=actualNamedFunction(desktop,'isPluginManagerSenderAllowed',{canUsePluginManagerWindow:createApplicationSenderGuard({projectRoot:root,pages:['PluginManagerModules/plugin-manager.html'],getWebContents:()=>standalone}),getEmbeddedAppSessions:()=>({ownsRendererForAction:owns})});
 allowed.closeEmbedded=()=>sessions.clear();return allowed;
}
function callback(channel,allow){
 const writes=[],ctx={path,PROJECT_ROOT:root,FEATURE_FOLDER_PREFIX:'feature:',isPluginManagerSenderAllowed:allow,appFeatures:{setEnabled(){writes.push('feature');return {}; }},fs:{ensureDir:async file=>writes.push(['mkdir',file]),writeFile:async file=>writes.push(['write',file]),pathExists:async file=>!file.endsWith('.block'),pathExistsSync:()=>false,move:async(a,b)=>writes.push(['move',a,b])}};
 ctx.getFeatureName=actualNamedFunction(desktop,'getFeatureName',ctx);ctx.isSafePluginFolderName=actualNamedFunction(desktop,'isSafePluginFolderName',ctx);ctx.getPluginManagerPluginDir=actualNamedFunction(desktop,'getPluginManagerPluginDir',ctx);ctx.findExistingManifestPath=actualNamedFunction(desktop,'findExistingManifestPath',ctx);
 return {writes,run:event=>actualIpcCallback(desktop,channel,ctx)(event,{folderName:'SyntheticPlugin',content:'SYNTHETIC_ONLY=1',manifest:{name:'SyntheticPlugin'},enabled:false})};
}
test('production plugin config writer rejects foreign utility before any IO',async()=>{
 const h=callback('plugin-manager-save-config-env',()=>false),notes=contents('Notemodules/notes.html');const result=await h.run({sender:notes,senderFrame:notes.mainFrame});assert.deepEqual(h.writes,[]);assert.equal(result.code,'PLUGIN_MANAGER_REQUIRED');
});
test('real plugin manager standalone and embedded owners remain legitimate while wrong role/frame/source are rejected',async()=>{
 const standalone=contents('PluginManagerModules/plugin-manager.html'),view=contents('PluginManagerModules/plugin-manager.html','browserView'),allowed=realGuard(standalone,view);
 for(const sender of [standalone,view]){const h=callback('plugin-manager-save-config-env',allowed);assert.equal((await h.run({sender,senderFrame:sender.mainFrame})).success,true);assert.equal(h.writes.filter(x=>x[0]==='write').length,1);}
 const notes=contents('Notemodules/notes.html'),spoof=contents('PluginManagerModules/plugin-manager.html');
 for(const event of [{sender:notes,senderFrame:notes.mainFrame},{sender:spoof,senderFrame:spoof.mainFrame},{sender:standalone,senderFrame:{url:standalone.url}},{sender:view,senderFrame:{url:view.url}}]){const h=callback('plugin-manager-save-manifest',allowed);assert.equal((await h.run(event)).code,'PLUGIN_MANAGER_REQUIRED');assert.deepEqual(h.writes,[]);}
 view.mainFrame.url=pathToFileURL(path.join(root,'Notemodules/notes.html')).href;assert.equal(allowed({sender:view,senderFrame:view.mainFrame}),false);
});
test('all plugin manager management handlers enforce the native owner guard',async()=>{
 for(const channel of ['plugin-manager-list-plugins','plugin-manager-save-manifest','plugin-manager-save-config-env','plugin-manager-set-plugin-enabled','plugin-manager-open-plugin-folder']){
  let io=0;const handler=actualIpcCallback(desktop,channel,{isPluginManagerSenderAllowed:()=>false,fs:new Proxy({},{get(){io++;throw Error('Unexpected IO');}})});assert.equal((await handler({})).code,'PLUGIN_MANAGER_REQUIRED');assert.equal(io,0,channel);
 }
});

test('closed/destroyed owners, stale frames, wrong documents and missing embedded owner fail closed',()=>{
 const standalone=contents('PluginManagerModules/plugin-manager.html'),view=contents('PluginManagerModules/plugin-manager.html','browserView'),allow=realGuard(standalone,view);
 const oldFrame=view.mainFrame;view.mainFrame={url:view.url,detached:false};assert.equal(allow({sender:view,senderFrame:oldFrame}),false);
 view.mainFrame.detached=true;assert.equal(allow({sender:view,senderFrame:view.mainFrame}),false);view.mainFrame.detached=false;
 view.isDestroyed=()=>true;assert.equal(allow({sender:view,senderFrame:view.mainFrame}),false);view.isDestroyed=()=>false;
 allow.closeEmbedded();assert.equal(allow({sender:view,senderFrame:view.mainFrame}),false);
 standalone.isDestroyed=()=>true;assert.equal(allow({sender:standalone,senderFrame:standalone.mainFrame}),false);
 const absent=actualNamedFunction(desktop,'isPluginManagerSenderAllowed',{canUsePluginManagerWindow:()=>false,getEmbeddedAppSessions:()=>null});assert.equal(absent({sender:view,senderFrame:view.mainFrame}),false);
});

'use strict';
const path=require('node:path'),{pathToFileURL}=require('node:url'),{fail}=require('./protocol');
function probe(scope,freeze){
 if(!scope.localIds.length&&!scope.sharedIds.length){globalThis.NativeSyncMergeFence?.set(scope);return {ready:true,dirty:false};}
 if(document.documentElement.dataset.vcpRendererReady!=='true'||!globalThis.NativeSyncMergeFence)return {ready:false};
 const ids=new Set(scope.localIds),shared=new Set(scope.sharedIds);
 let dirty=(globalThis.settingsManager?.getDirtyAgentIds?.()||[]).some(id=>ids.has(id))||(globalThis.GroupRenderer?.getDirtyGroupIds?.()||[]).some(id=>ids.has(id));
 for(let n=0;n<localStorage.length;n++){const key=localStorage.key(n);if(key.startsWith('nativesync-shared-config-v2:')&&shared.has(key.split(':').at(-1)))dirty=true;}
 const active=document.querySelector('#agentList li.active')?.dataset.itemId;if(ids.has(active)&&document.querySelector('#messageInput')?.value.trim())dirty=true;
 if(!dirty&&freeze)globalThis.NativeSyncMergeFence.set(scope);
 return {ready:true,dirty};
}
async function prepareViews(BrowserWindow,scope){
 const url=pathToFileURL(path.resolve(__dirname,'../../../main.html')).href,windows=BrowserWindow.getAllWindows().filter(w=>!w.isDestroyed()&&w.webContents.getURL()===url);
 if(!windows.length&&scope.localIds.length)throw fail('SHARED_NATIVE_VIEW_NOT_READY');
 const run=freeze=>Promise.all(windows.map(w=>w.webContents.executeJavaScript(`(${probe.toString()})(${JSON.stringify(scope)},${freeze})`)));
 for(const freeze of [false,true]){const results=await run(freeze);if(results.some(r=>!r.ready))throw fail('SHARED_NATIVE_VIEW_NOT_READY');if(results.some(r=>r.dirty))throw fail('SHARED_LOCAL_DRAFT_PENDING');}
}
module.exports={prepareViews};

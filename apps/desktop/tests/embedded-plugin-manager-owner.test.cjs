'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),Module=require('node:module'),{EventEmitter}=require('node:events');
test('actual embedded session pool owns only its current plugin-manager main frame and revokes it on close',async()=>{
 const originalLoad=Module._load,instances=[];
 class Contents extends EventEmitter {
  constructor(){super();this.id=7;this.dead=false;this.mainFrame={url:'',detached:false};}
  isDestroyed(){return this.dead;}isCrashed(){return false;}getURL(){return this.mainFrame.url;}
  async loadURL(url){this.mainFrame={url,detached:false};}setWindowOpenHandler(){}send(){}stop(){}getZoomFactor(){return 1;}
  close(){this.dead=true;queueMicrotask(()=>this.emit('destroyed'));}
 }
 class View {constructor(){this.webContents=new Contents();instances.push(this);}setBackgroundColor(){}setVisible(){}setBounds(){}}
 Module._load=function(name,parent,isMain){if(name==='electron')return {WebContentsView:View,app:{getAppPath:()=>process.cwd()},shell:{openExternal:async()=>{}},screen:{getDisplayNearestPoint:()=>({workArea:{x:0,y:0,width:1200,height:800}})}};return originalLoad.call(this,name,parent,isMain);};
 const modulePath=require.resolve('../modules/services/embeddedAppSessionManager');delete require.cache[modulePath];let manager;
 try {
  const main=new EventEmitter();main.dead=false;main.isDestroyed=()=>main.dead;main.getContentBounds=()=>({width:1200,height:800});main.webContents=new Contents();main.contentView={addChildView(){},removeChildView(){}};
  manager=require(modulePath).createEmbeddedAppSessionManager({mainWindow:main,launchStandalone:async()=>({success:true})});
  assert.equal((await manager.create('open-plugin-manager-window')).success,true);const first=instances[0].webContents,event={sender:first,senderFrame:first.mainFrame};
  assert.equal(manager.ownsRendererForAction(event,'open-plugin-manager-window'),true);assert.equal(manager.ownsRendererForAction({sender:first,senderFrame:{}},'open-plugin-manager-window'),false);
  await manager.create('open-notes-window');const notes=instances[1].webContents;assert.equal(manager.ownsRendererForAction({sender:notes,senderFrame:notes.mainFrame},'open-plugin-manager-window'),false);
  await manager.close('open-plugin-manager-window');assert.equal(manager.ownsRendererForAction(event,'open-plugin-manager-window'),false);
  await manager.create('open-plugin-manager-window');const second=instances[2].webContents;assert.equal(second.id,first.id,'deliberate ID reuse');assert.equal(manager.ownsRendererForAction(event,'open-plugin-manager-window'),false);assert.equal(manager.ownsRendererForAction({sender:second,senderFrame:second.mainFrame},'open-plugin-manager-window'),true);
  main.dead=true;assert.equal(manager.ownsRendererForAction({sender:second,senderFrame:second.mainFrame},'open-plugin-manager-window'),false);
 }finally{await manager?.closeAll();Module._load=originalLoad;delete require.cache[modulePath];}
});

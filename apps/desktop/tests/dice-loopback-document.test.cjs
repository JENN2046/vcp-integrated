'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module'),{EventEmitter}=require('node:events');
test('Dice starts only its loopback static server and keeps the privileged page on that exact document',async()=>{
 const filename=path.resolve(__dirname,'../modules/ipc/diceHandlers.js'),realRequire=createRequire(filename),listen=[];let window;
 class FakeContents extends EventEmitter{getURL(){return this.url||''}}
 class FakeWindow extends EventEmitter{constructor(options){super();this.options=options;this.webContents=new FakeContents();window=this;}isDestroyed(){return false}loadURL(url){this.webContents.url=url}setMenu(){}show(){}}
 const fakeServer={on(){return this},close(){this.closed=true}};const fakeApp={use(){},listen(...args){listen.push(args);queueMicrotask(()=>args.find(x=>typeof x==='function')());return fakeServer}};const express=()=>fakeApp;express.static=()=>()=>{};
 const module={exports:{}};vm.runInNewContext(fs.readFileSync(process.env.S2_DICE_SOURCE||filename,'utf8'),{module,exports:module.exports,__dirname:path.dirname(filename),console,process,Buffer,require:request=>request==='electron'?{BrowserWindow:FakeWindow,ipcMain:{handle(){}},dialog:{showErrorBox:()=>assert.fail('normal opening must not fail')}}:request==='express'?express:request==='../services/windowService'?{attachWindow(){},ensureReady:async()=>window}:realRequire(request)},{filename});
 await module.exports.createOrFocusDiceWindow(path.resolve(__dirname,'..'));assert.equal(listen.length,1);assert.equal(listen[0][0],6677);assert.equal(listen[0][1],'127.0.0.1','host must be explicit before any real listen is possible');assert.equal(window.webContents.getURL(),'http://127.0.0.1:6677/dice.html');
 assert.equal(window.options.webPreferences.sandbox,true);assert.equal(window.options.webPreferences.nodeIntegration,false);
 let blocked=false;window.webContents.emit('will-navigate',{preventDefault(){blocked=true}},'https://example.invalid/');assert.equal(blocked,true);
 blocked=false;window.webContents.emit('will-navigate',{preventDefault(){blocked=true}},window.webContents.getURL()+'#dice');assert.equal(blocked,false);module.exports.stopDiceServer();assert.equal(fakeServer.closed,true);
});

'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..');
function context(){const handlers=new Map(),calls=[],window={id:91,webContents:{send(){}}},openDocxWindow=async options=>{calls.push(options);return window};return {handlers,calls,window,openDocxWindow,ipcMain:{handle(channel,fn){handlers.set(channel,fn)}}};}
test('lazy main Docx open responds with a cloneable receipt rather than an Electron object',async()=>{
 const c=context(),main=fs.readFileSync(path.join(root,'main.js'),'utf8'),begin=main.indexOf('function registerDocxOpenBootstrap()'),end=main.indexOf('function configureDocxHandlers(',begin);assert(begin>=0&&end>begin);
 const scope={...c,docxOpenBootstrapRegistered:false,docxHandlersModule:null,loadDocxHandlers:async()=>({openDocxWindow:c.openDocxWindow})};vm.createContext(scope);vm.runInContext(main.slice(begin,end)+';registerDocxOpenBootstrap()',scope);
 const value=await c.handlers.get('open-docx-window')({}, {filePath:'/synthetic/local.txt'});assert.deepEqual(structuredClone(value),{success:true,windowId:91});assert.equal(c.calls.length,1);assert.equal(c.calls[0].filePath,'/synthetic/local.txt');
});
test('loaded Docx IPC has the same cloneable open receipt',async()=>{
 const c=context(),source=fs.readFileSync(path.join(root,'modules/ipc/docxHandlers.js'),'utf8'),line=source.split(/\r?\n/).find(line=>line.includes("ipcMain.handle('open-docx-window'"));assert(line);vm.runInNewContext(line,c);
 const value=await c.handlers.get('open-docx-window')({}, {filePath:'/synthetic/local.txt'});assert.deepEqual(structuredClone(value),{success:true,windowId:91});assert.equal(c.calls.length,1);
});

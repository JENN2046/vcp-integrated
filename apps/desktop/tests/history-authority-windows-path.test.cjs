'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{EventEmitter}=require('node:events');
const source=fs.readFileSync(path.join(__dirname,'../modules/services/chatDataService/lifecycle.js'),'utf8');
function fixture({proofPath,alias=false}) {
 const root='C:\\Synthetic\\NativeSync',win=path.win32;let spawned=0;
 class ServiceError extends Error{constructor(message,options){super(message);Object.assign(this,options)}}
 const context={module:{exports:{}},process:{platform:'win32'},console,setTimeout,clearTimeout,require(id){
  if(id==='path')return win;
  if(id==='fs')return{promises:{realpath:async()=>alias?'C:\\Another':root,lstat:async p=>({isDirectory:()=>p===win.join(root,'databases'),isSymbolicLink:()=>false,isFile:()=>p.endsWith('.lock'),nlink:1})}};
  if(id==='./authorityControl')return{verifyAuthorityBinary:async()=>{}};
  if(id==='./client')return{ChatDataServiceError:ServiceError};
  if(id==='child_process')return{spawn(){spawned++;const child=new EventEmitter();child.stdout=new EventEmitter();queueMicrotask(()=>{child.stdout.emit('data',JSON.stringify({type:'historyAuthorityProbe',authorityProtocol:1,settled:true,rootIdentity:{realpath:proofPath}}));child.emit('exit',0)});return child}};
  return require(id);
 }};vm.runInNewContext(source,context);
 return{run:()=>context.module.exports.verifyStoppedHistoryAuthority({appDataPath:root,binaryPath:'C:\\Synthetic\\cds.exe'}),spawned:()=>spawned};
}
test('Windows stopped-authority accepts the exact Rust extended path',async()=>{assert.equal((await fixture({proofPath:'\\\\?\\C:\\Synthetic\\NativeSync'}).run()).settled,true)});
test('Windows stopped-authority rejects another physical root',async()=>{await assert.rejects(fixture({proofPath:'\\\\?\\C:\\Another'}).run(),{code:'HISTORY_AUTHORITY_PENDING'})});
test('Windows root alias is rejected before a probe can run',async()=>{const f=fixture({alias:true,proofPath:'\\\\?\\C:\\Synthetic\\NativeSync'});await assert.rejects(f.run(),{code:'HISTORY_AUTHORITY_PENDING'});assert.equal(f.spawned(),0)});

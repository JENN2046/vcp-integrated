'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {pathToFileURL}=require('node:url'),{EventEmitter}=require('node:events');
const {protectApplicationNavigation,createApplicationSenderGuard}=require('../modules/ipc/applicationSender');
test('application window navigation keeps its local document and cannot carry a privileged bridge elsewhere',()=>{
 const root=path.resolve('/synthetic/application'),url=pathToFileURL(path.join(root,'modules/text-viewer.html')).href,contents=new EventEmitter();contents.getURL=()=>url+'?text=synthetic';protectApplicationNavigation(contents,root);
 for(const eventName of ['will-navigate','will-redirect'])for(const target of ['https://example.invalid/','http://127.0.0.1:21999/',pathToFileURL(path.join(root,'main.html')).href,'data:text/html,synthetic','javascript:void(0)','file:///synthetic/outside.html']){let blocked=false;contents.emit(eventName,{preventDefault(){blocked=true}},target);assert.equal(blocked,true,target);}
 let blocked=false;contents.emit('will-navigate',{preventDefault(){blocked=true}},url+'?text=other#section');assert.equal(blocked,false);
});
test('existing remote browser owner is unaffected by the application-file navigation fence',()=>{
 const contents=new EventEmitter();contents.getURL=()=>'https://example.invalid/';protectApplicationNavigation(contents);let blocked=false;contents.emit('will-navigate',{preventDefault(){blocked=true}},'https://example.invalid/next');assert.equal(blocked,false);
});
test('the explicit local Dice HTTP document cannot navigate to another origin, port or page',()=>{
 const contents=new EventEmitter(),url='http://127.0.0.1:6677/dice.html';contents.getURL=()=>url;protectApplicationNavigation(contents,undefined,url);
 for(const target of ['https://example.invalid/','http://127.0.0.1:6678/dice.html','http://127.0.0.1:6677/other.html','file:///synthetic/app.html']){let blocked=false;contents.emit('will-navigate',{preventDefault(){blocked=true}},target);assert.equal(blocked,true);}
 let blocked=false;contents.emit('will-navigate',{preventDefault(){blocked=true}},url+'?theme=default#dice');assert.equal(blocked,false);
 assert.throws(()=>protectApplicationNavigation(new EventEmitter(),undefined,'https://example.invalid/'),/explicit loopback/);
});
test('Python viewer guard requires its exact current top-level application page',()=>{
 const root=path.resolve('/synthetic/application'),url=pathToFileURL(path.join(root,'modules/text-viewer.html')).href,frame={url,detached:false},sender={mainFrame:frame,isDestroyed:()=>false,getType:()=>'window',getURL:()=>url},event={sender,senderFrame:frame},allowed=createApplicationSenderGuard({projectRoot:root,pages:['modules/text-viewer.html']});
 assert.equal(allowed(event),true);assert.equal(allowed({sender,senderFrame:{...frame}}),false);frame.url='https://example.invalid/';assert.equal(allowed(event),false);frame.url=url;sender.getURL=()=>pathToFileURL(path.join(root,'main.html')).href;assert.equal(allowed(event),false);assert.equal(allowed({}),false);
});

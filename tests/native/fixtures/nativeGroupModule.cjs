'use strict';
// Execute the real native group module. Only unrelated chat/UI imports are inert.
// Configuration, normalization, atomic filesystem operations and the History queue stay real.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module');
module.exports=function loadGroup(host){
 const file=path.join(host,'Groupmodules/groupchat.js'),real=createRequire(file),module={exports:{}};
 const actual=new Set(['../modules/services/topicGenerationLease','../modules/services/historyAuthority','../modules/services/nativeSync/sharedGroup','../modules/services/nativeSync/sharedHost','fs-extra','path','crypto','node:fs/promises','node:process','../modules/utils/atomicReplace','../modules/utils/historyConfiguration','./modes/jevDecisionMode','./groupContextWindow']);
 const unrelated=new Set(['../modules/contextSanitizer','../modules/modelTrajectory','../modules/fileManager','../modules/ipc/canvasHandlers','../modules/ipc/tavernHandlers','../modules/tavernRulesEngine','./modes/sequentialMode','./modes/natureRandomMode','./modes/inviteOnlyMode','./jevGroupSessionOrchestrator','./topicTitleManager','./streamWatchdog','./groupChatUrl']);
 const dependency=name=>{if(actual.has(name))return real(name);if(name==='electron')return{ipcMain:{}};if(unrelated.has(name))return new Proxy({},{get:(_target,key)=>()=>{throw Error('UNRELATED_CHAT_IMPORT_CALLED '+name+':'+String(key));}});throw Error('UNREVIEWED_GROUP_DEPENDENCY '+name);};
 vm.runInThisContext('(function(require,module,exports,__filename,__dirname,console){'+fs.readFileSync(file,'utf8')+'\n})',{filename:file})(dependency,module,module.exports,file,path.dirname(file),{log(){},warn(){},error(){}});
 return module.exports;
};

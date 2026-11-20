'use strict';
const fs=require('node:fs'),{parse}=require('@babel/parser'),vm=require('node:vm');
function actualIpcCallback(file,channel,context){
 const source=fs.readFileSync(file,'utf8'),tree=parse(source,{sourceType:'unambiguous'}),pending=[tree];let callback;
 while(pending.length){const node=pending.pop();if(!node||typeof node!=='object')continue;
  if(node.type==='CallExpression'&&node.callee?.object?.name==='ipcMain'&&node.callee?.property?.name==='handle'&&node.arguments?.[0]?.value===channel){callback=node.arguments[1];break;}
  for(const value of Object.values(node)){if(Array.isArray(value))pending.push(...value);else if(value&&typeof value==='object')pending.push(value);}
 }
 if(!callback)throw Error('Missing production handler: '+channel);
 return vm.runInNewContext('('+source.slice(callback.start,callback.end)+')',{console:{log(){},error(){}},...context});
}
module.exports={actualIpcCallback};
function actualNamedFunction(file,name,context){
 const source=fs.readFileSync(file,'utf8'),tree=parse(source,{sourceType:'unambiguous'}),pending=[tree];
 while(pending.length){const node=pending.pop();if(!node||typeof node!=='object')continue;if(node.type==='FunctionDeclaration'&&node.id?.name===name)return vm.runInNewContext('('+source.slice(node.start,node.end)+')',context);
 for(const value of Object.values(node)){if(Array.isArray(value))pending.push(...value);else if(value&&typeof value==='object')pending.push(value);}}
 throw Error('Missing production function: '+name);
}
module.exports.actualNamedFunction=actualNamedFunction;

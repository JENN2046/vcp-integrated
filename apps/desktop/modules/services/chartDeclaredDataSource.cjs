'use strict';
// Native chart declarations own data-source authority. Runtime requests name a
// declaration; they cannot add a file/URL, headers or a different operation.
const TYPES=new Set(['json','csv','text','sqlite','http-json']);
const sourceType=value=>({http:'http-json',sqlite3:'sqlite'}[String(value||'').trim().toLowerCase()]||String(value||'').trim().toLowerCase());
const REF=/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
function denied(message,code='CHART_DATA_SOURCE_UNDECLARED'){return Object.assign(new Error(message),{code});}
function publicManifest(manifest){return {...manifest,dataSources:(Array.isArray(manifest.dataSources)?manifest.dataSources:[]).filter(row=>row&&typeof row==='object'&&REF.test(row.id||'')&&TYPES.has(sourceType(row.type))).map(row=>({id:row.id,type:sourceType(row.type)}))};}
function resolveDeclaredDataSource(manifest,request={}){
 if(!request||typeof request!=='object'||Array.isArray(request))throw denied('无效图表数据源引用。');
 if(request.expectedCodeRevision!==undefined&&Number(request.expectedCodeRevision)!==manifest.codeRevision)throw denied('图表数据源声明版本已更新。','CHART_DATA_SOURCE_STALE_SCOPE');
 const ref=request.sourceId||request.source;
 if(typeof ref!=='string'||!REF.test(ref)||request.path!==undefined||request.url!==undefined||request.headers!==undefined||request.method!==undefined||request.operation!==undefined)throw denied('运行时只能请求已声明的数据源引用。');
 const declarations=(Array.isArray(manifest.dataSources)?manifest.dataSources:[]).filter(row=>row&&typeof row==='object'&&row.id===ref);
 if(declarations.length!==1)throw denied('数据源尚未在当前图表中唯一声明。');
 const declared=declarations[0];if(!TYPES.has(sourceType(declared.type))||request.type&&sourceType(request.type)!==sourceType(declared.type))throw denied('数据源类型与声明不符。');
 const result={type:sourceType(declared.type)};for(const key of ['source','path','url','headers','timeoutMs','encoding','delimiter','header','sql'])if(Object.hasOwn(declared,key))result[key]=declared[key];
 if(request.sql!==undefined&&request.sql!==declared.sql)throw denied('SQL必须匹配已声明的只读查询。');
 if(request.params!==undefined){if(!Array.isArray(request.params)||request.params.length>1000||request.params.some(v=>v!==null&&!['string','number','boolean'].includes(typeof v))||JSON.stringify(request.params).length>65536)throw denied('数据源查询参数超出限制。');result.params=request.params;}
 else if(Object.hasOwn(declared,'params'))result.params=declared.params;
 return result;
}
module.exports={publicManifest,resolveDeclaredDataSource};

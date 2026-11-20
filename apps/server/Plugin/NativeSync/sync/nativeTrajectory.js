'use strict';
// Reuse the native diagnostic recorder; no execution scheduling or message facts.
const fs=require('node:fs'),path=require('node:path');
const {createModelTrajectoryRecorder}=require('../nativeRules/modules/modelTrajectory');
const recorders=new WeakMap();
const sessionKey=row=>row.topic_key+'__'+require('./protocol').sha256(row.session_id).slice(0,24);
const fail=code=>Object.assign(Error(code),{code,status:403});
function recorder(engine){
 if(recorders.has(engine))return recorders.get(engine);
 const file=engine.db.prepare('PRAGMA database_list').all().find(v=>v.name==='main')?.file;
 if(!file||!path.isAbsolute(file))return null;
 const root=path.join(path.dirname(file),'execution-traces');fs.mkdirSync(root,{recursive:true,mode:0o700});
 const stat=fs.lstatSync(root);if(stat.isSymbolicLink()||!stat.isDirectory()||process.platform!=='win32'&&(stat.uid!==process.getuid()||(stat.mode&0o077)!==0))throw fail('TRACE_STORAGE_UNVERIFIED');
 const value=createModelTrajectoryRecorder({rootDir:root,maxRecords:200,recordPending:true,maxFileBytes:16*1024*1024});recorders.set(engine,value);return value;
}
function start(engine,row,body){
 try{
  if(row.kind!=='shared_session')return null;
  const actor=require('./sharedSession').acceptedActor(engine,row);if(actor.kind!=='desktop')return null;
  const value=recorder(engine);if(!value)return null;
  const key=sessionKey(row),file=value.fileOf(key);if(fs.existsSync(file)&&fs.lstatSync(file).isSymbolicLink())return null;
  const keys=['model','temperature','top_p','max_tokens','stream','presence_penalty','frequency_penalty','seed'];
  const params=Object.fromEntries(keys.filter(k=>['string','number','boolean'].includes(typeof body[k])).map(k=>[k,body[k]]));
  return value.begin({sessionKey:key,requestId:body.requestId,model:body.model,params,messages:body.messages,source:{kind:'shared-server',executionId:row.id,nativeRequestId:body.requestId}});
 }catch{return null;}
}
function authorized(shared,actor,query,denial='TRACE_INITIATOR_REQUIRED'){
 shared.authorize(actor,query.sharedSpaceId,'read');
 const work=shared.admission(actor,query.sharedSpaceId,query.workId),engine=shared.native?.engine,row=engine?.get(work.id);
 if(!row||row.kind!=='shared_session'||actor.kind!=='desktop'||work.principal!==actor.principal)throw fail(denial);
 const accepted=require('./sharedSession').acceptedActor(engine,row);
 if(accepted.principal!==actor.principal||accepted.sourceId!==actor.sourceId||accepted.deviceId!==actor.deviceId)throw fail(denial);
 return {engine,row,work};
}
async function list(shared,actor,query){
 const {engine,row,work}=authorized(shared,actor,query),limit=Math.min(100,Math.max(1,Number(query.limit)||20));
 const value=recorder(engine);if(!value)return {records:[],total:0,truncated:false,available:false};
 const result=await value.list(sessionKey(row),{limit:200});result.records=result.records.filter(v=>v.source?.executionId===row.id).slice(-limit);result.total=result.records.length;let bytes=0;const records=[];
 for(const item of result.records){const size=Buffer.byteLength(JSON.stringify(item));if(bytes+size>4*1024*1024)break;bytes+=size;records.push({...item,id:'shared_'+row.id+'_'+item.requestId,source:{...item.source,executionId:row.id,nativeRequestId:item.requestId,workState:work.state,executionState:row.state},...(item.status==='running'&&!['queued','running','cancelling','waiting_approval'].includes(row.state)?{status:'error',error:{name:'Interrupted',message:'原始轨迹未记录完成；执行状态以权威账本为准。'}}:{})});}
 authorized(shared,actor,query);
 return {...result,records,truncated:result.truncated||records.length!==result.records.length,available:records.length>0};
}
function cancel(shared,actor,body){
 shared.authorize(actor,body.sharedSpaceId,'execute');
 if(shared.readOnly)throw fail('SHARED_READ_ONLY');
 const {engine,row,work}=authorized(shared,actor,body,'SHARED_REQUEST_OWNER_REQUIRED');
 return shared.receipt(actor,body,'session-cancel',()=>{
  const current=engine.get(row.id);
  if(['completed','failed','cancelled','review_required','publishing'].includes(current.state))return {success:true,submitted:false,execution:engine.public(current,row.session_id),workState:shared.admission(actor,body.sharedSpaceId,work.id).state};
  const execution=engine.cancel(row.id,row.session_id);return {success:true,submitted:true,execution,workState:shared.admission(actor,body.sharedSpaceId,work.id).state};
 });
}
module.exports={start,list,cancel};

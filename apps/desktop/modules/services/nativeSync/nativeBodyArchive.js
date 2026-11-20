'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {stable,sha256,fail}=require('./protocol');
const {ownedJson}=require('./sharedLocal');
const {assertHistoryPath}=require('./sourceDirectory');
const {durableJson}=require('./durableJson');
const terminalTasks=new Set(['completed','failed','cancelled','stopped']);
const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
function eligible(record){
 const a=record?.accepted;
 if(record?.serverSession||record?.steeringV1||record?.isSteeringInput||record?.remote)return false;
 // A server completed receipt has passed its native_terminal/tool/task gate.
 // It intentionally does not always carry the optional detailed task arrays.
 if(record?.phase!=='completed'||a?.state!=='completed'||record.config?.owner?.kind!=='agent'||a.turn?.kind&&a.turn.kind!=='message')return false;
 if(!record.nativeBody||record.nativeBodyRef||record.committedReply||record.replyProjectionPending||record.projection&&record.projection.state!=='saved')return false;
 if(typeof record.body?.requestId!=='string'||typeof a.id!=='string'||record.nativeBody.requestId!=='reply_'+a.id||record.reply?.id!=='reply_'+a.id)return false;
 for(const key of ['nativeRequests','nativeTasks','toolInvocations'])if(a[key]!==undefined&&!Array.isArray(a[key]))return false;
 if(a.nativeRequests?.some(n=>n.state!=='model_terminal')||a.nativeTasks?.some(t=>!terminalTasks.has(t.state)||(t.reviewRequired||t.review_required)&&!(t.reviewResolved||t.review_resolved))||a.toolInvocations?.some(t=>!['returned','error'].includes(t.state)))return false;
 return true;
}
class NativeBodyArchive {
 constructor(runtime){this.root=runtime.root;this.dir=runtime.dir;this.binding=()=>runtime.binding();}
 identity(record){
  if(typeof record?.body?.requestId!=='string'||typeof record.accepted?.id!=='string')throw fail('SHARED_NATIVE_BODY_ARCHIVE_INVALID');
  return {inputRequestId:record.body.requestId,nativeRequestId:'reply_'+record.accepted.id,admissionId:record.accepted.id};
 }
 fileFor(identity,bodyHash){return 'native-bodies/'+sha256(stable({binding:this.binding(),...identity,bodyHash}))+'.json';}
 validateReference(record,ref){
  const id=this.identity(record);
  if(ref?.version!==1||!(/^[a-f0-9]{64}$/.test(ref.bodyHash||''))||!Number.isSafeInteger(ref.bodyBytes)||ref.bodyBytes<1||ref.file!==this.fileFor(id,ref.bodyHash)||ref.inputRequestId!==id.inputRequestId||ref.nativeRequestId!==id.nativeRequestId||ref.admissionId!==id.admissionId)throw fail('SHARED_NATIVE_BODY_ARCHIVE_INVALID');
  return path.join(this.dir,ref.file);
 }
 validateEnvelope(record,ref,value){
  const id=this.identity(record);
  if(!value||value.version!==1||stable(value.binding)!==stable(this.binding())||Object.keys(id).some(k=>value[k]!==id[k])||value.bodyHash!==ref.bodyHash||value.bodyBytes!==ref.bodyBytes||value.body?.requestId!==id.nativeRequestId||sha256(stable(value.body))!==ref.bodyHash||Buffer.byteLength(JSON.stringify(value.body))!==ref.bodyBytes)throw fail('SHARED_NATIVE_BODY_ARCHIVE_CORRUPT');
  return value.body;
 }
 async load(record){
  if(own(record,'nativeBody')&&record.nativeBodyRef)throw fail('SHARED_NATIVE_BODY_ARCHIVE_CONFLICT');
  if(record.nativeBody)return record.nativeBody;
  if(!record.nativeBodyRef)throw fail('SHARED_NATIVE_BODY_REQUIRED');
  const ref=record.nativeBodyRef,file=this.validateReference(record,ref);
  let value;try{value=await ownedJson(this.root,file);}catch(error){if(error.code==='ENOENT')throw fail('SHARED_NATIVE_BODY_ARCHIVE_MISSING');throw error;}
  return this.validateEnvelope(record,ref,value);
 }
 async write(record){
  const id=this.identity(record),body=JSON.parse(JSON.stringify(record.nativeBody));
  if(body.requestId!==id.nativeRequestId)throw fail('SHARED_NATIVE_BODY_ARCHIVE_INVALID');
  const bodyHash=sha256(stable(body)),bodyBytes=Buffer.byteLength(JSON.stringify(body)),relative=this.fileFor(id,bodyHash),file=path.join(this.dir,relative),folder=path.dirname(file);
  await assertHistoryPath(this.root,file);await fs.mkdir(folder,{recursive:true,mode:0o700});
  const meta=await fs.lstat(folder);if(meta.isSymbolicLink()||!meta.isDirectory()||process.platform!=='win32'&&(meta.uid!==process.getuid()||(meta.mode&0o077)!==0))throw fail('SHARED_NATIVE_BODY_ARCHIVE_PATH_INVALID');
  const envelope={version:1,binding:this.binding(),...id,bodyHash,bodyBytes,archivedAt:new Date().toISOString(),body};
  const ref={version:1,file:relative,...id,bodyHash,bodyBytes,archivedAt:envelope.archivedAt,completionProof:'server-completed-receipt'};
  let exists=true;try{await fs.lstat(file);}catch(error){if(error.code==='ENOENT')exists=false;else throw error;}
  if(exists){const value=await ownedJson(this.root,file);this.validateEnvelope(record,ref,value);await durableJson(file,value);ref.archivedAt=value.archivedAt;}
  else await durableJson(file,envelope);
  return ref;
 }
 async validateAll(records){
  for(const record of Object.values(records))if(record.nativeBodyRef)await this.load(record);
 }
}
module.exports={NativeBodyArchive,eligible};

'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),{fileURLToPath}=require('node:url'),{createHash}=require('node:crypto');
const {wireTopic,fail}=require('./protocol');
const {nativeReference}=require('./metadata');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const MAX_FILE=20*1024*1024,CHUNK=65536;
const FIRST_RETRY_MS = 60_000;
const MAX_RETRY_MS = 300_000;
const MAX_MISSING = 4096;
// Native send history keeps the FileManager identity inside its UI wrapper.
// Match the existing metadata contract before constructing upload identities.
const {AttachmentWork,attachmentId}=require('./attachmentWork');
function materializedData(a,restored,frames,frameHashes){
 const data={...restored,id:a.id,createdAt:a.createdAt??null};
 // FileManager returns null defaults and fresh parser/timestamp values.
 // Only accepted metadata may enter the raw-history envelope validation path.
 for(const key of ['extractedText','imageFrames','blobHash','frameHashes'])delete data[key];
 if(typeof a.extractedText==='string')data.extractedText=a.extractedText;
 if(Array.isArray(frames))data.imageFrames=frames;
 if(a.blobHash)data.blobHash=a.blobHash;
 if(frameHashes)data.frameHashes=frameHashes;
 return data;
}
class DesktopAttachments{
 constructor({queue,appDataRoot,connection,send,download,storeAttachment,onMaterialized=()=>{},getMapping,routeBase='/api/plugins/NativeSync/attachments/',localOnly=false,now=()=>performance.now()}){
  this.queue=queue;this.root=path.resolve(appDataRoot,'UserData','attachments');this.connection=connection;this.send=send;this.download=download;this.storeAttachment=storeAttachment;this.onMaterialized=onMaterialized;this.uploaded=new Map();this.rejected=new Map();this.skipped=0;this.skippedDetails=[];
  Object.assign(this,{getMapping,routeBase,localOnly,now});
  // Session-local negative results. A new connection starts with no remembered misses.
  this.missing = new Map();
  this.inFlight = new Map();
  this.work = new AttachmentWork(this);
 }
 get missingCount() { return this.missing.size; }

 forgetReference(topic, message, id) {
  const route=this.routeBase+encodeURIComponent(topic)+'/messages/'+encodeURIComponent(message)+'/'+encodeURIComponent(id);
  for (const cache of [this.missing,this.inFlight]) for (const key of cache.keys()) {
   if (key===route || key.startsWith(route+'/frames/')) cache.delete(key);
  }
 }
 retryMissing(topicKey) {
  this.work.wake(topicKey);
  let released = 0;
  for (const [route, entry] of this.missing) {
   if (topicKey !== undefined && entry.topicKey !== topicKey) continue;
   this.missing.delete(route);
   released++;
  }
  // A response from before an explicit retry or a restored binding cannot
  // renew the old wait. Existing callers still receive their own response.
  for (const [route, entry] of this.inFlight) {
   if (topicKey === undefined || entry.topicKey === topicKey) this.inFlight.delete(route);
  }
  return released;
 }

 waiting(route, version) {
  const miss = this.missing.get(route);
  return miss?.version === version && this.now() < miss.retryAt;
 }

 async fetchAttachment(route, version, topicKey) {
  if (this.waiting(route, version)) return null;
  const active = this.inFlight.get(route);
  if (active?.version === version) return active.promise;

  const prior = this.missing.get(route);
  const entry = {topicKey, version};
  this.inFlight.set(route, entry);
  entry.promise = (async () => {
   try {
    const bytes = await this.download(route);
    if (this.inFlight.get(route) === entry) this.missing.delete(route);
    return bytes;
   } catch (error) {
    if (this.inFlight.get(route) === entry) {
     this.missing.delete(route);
     if (error.status === 404 && error.code === 'ATTACHMENT_BLOB_MISSING') {
      const delay = prior?.version === version ? Math.min(prior.delay * 2, MAX_RETRY_MS) : FIRST_RETRY_MS;
      if (this.missing.size >= MAX_MISSING) this.missing.delete(this.missing.keys().next().value);
      this.missing.set(route, {topicKey, version, delay, retryAt: this.now() + delay});
     }
    }
    if (error.code === 'ATTACHMENT_BLOB_MISSING' && (error.status === 404 || error.status === undefined)) return null;
    throw error;
   } finally {
    if (this.inFlight.get(route) === entry) this.inFlight.delete(route);
   }
  })();
  return entry.promise;
 }

 noteMissing(t, message, attachment) {
  this.skipped++;
  if (this.skippedDetails.length < 100) this.skippedDetails.push({
   topicKey: t.key, messageId: message.id, attachmentId: attachment.id, code: 'ATTACHMENT_BLOB_MISSING'
  });
 }
 async localFile(attachment){
  const raw=attachment._fileManagerData||attachment,source=raw.internalPath||attachment.internalPath||attachment.src;
  if(typeof source!=='string')throw fail('ATTACHMENT_BLOB_MISSING');
  let candidate=source;if(source.startsWith('file://')){try{candidate=fileURLToPath(source);}catch{candidate=decodeURIComponent(source.slice(7));}}
  const file=path.resolve(candidate),relative=path.relative(this.root,file);
  if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw fail('ATTACHMENT_SOURCE_OUTSIDE_ROOT');
  let current=path.parse(this.root).root;
  for(const part of file.slice(current.length).split(path.sep).filter(Boolean)){current=path.join(current,part);const s=await fs.lstat(current);if(s.isSymbolicLink()||(s.isFile()&&s.nlink!==1))throw fail('ATTACHMENT_SOURCE_ALIAS');}
  const stat=await fs.stat(file);if(!stat.isFile()||stat.size>MAX_FILE)throw fail('ATTACHMENT_FILE_TOO_LARGE');return {file,stat};
 }
 async checkOpenedFile(d, messageId, id, expectedHash) {
  if(!this.connection.topics.some(t=>JSON.stringify(wireTopic(t))===JSON.stringify(wireTopic(d))))return false;
  const {history}=await this.queue.readSnapshot(d);
  const message=history.find(m=>m.id===messageId);
  const ref=message?.attachments?.find(a=>attachmentId(a)===id);
  if(!ref || nativeReference(ref))return false;
  const data=ref._fileManagerData||ref;
  if((ref.blobHash||data.blobHash||ref.hash||data.hash)!==expectedHash)return false;
  try {await this.localFile(ref);return false;}
  catch(error){if(!['ENOENT','ATTACHMENT_BLOB_MISSING'].includes(error.code))return false;}
  this.work.missingOnOpen(d,message,ref);
  return true;
 }
 async mapping(){if(this.getMapping)return this.getMapping();const r=await this.send('/api/plugins/NativeSync/mobile/execution-configs');return r.topics;}
 find(rows,d){const id=wireTopic(d),t=rows.find(t=>t.ownerType===id.ownerType&&t.ownerId===id.ownerId&&t.topicId===id.topicId);if(!t)throw fail('TOPIC_NOT_ALLOWED');return t;}
 async uploadBytes(t,message,attachment,bytes,name,value,type,frameIndex){
  const id=attachmentId(attachment),requestId='desktop_'+digest(JSON.stringify([t.key,message.id,id,value,frameIndex??null]));
  const route=this.routeBase+encodeURIComponent(t.key);
  const started=await this.send(route+'/uploads',{body:{requestId,name,size:bytes.length,expectedHash:value,messageId:message.id,attachmentId:id,...(type&&type!=='application/octet-stream'?{type}:{}),...(frameIndex!==undefined?{frameIndex}:{})}});
  if(started.state!=='ready')for(let offset=started.offset;offset<bytes.length;offset+=CHUNK)await this.send(route+'/uploads/'+started.uploadId+'/chunks',{body:{offset,data:bytes.subarray(offset,offset+CHUNK).toString('base64')}});
  const done=await this.send(route+'/uploads/'+started.uploadId+'/finish',{body:{}});if(done.hash!==value)throw fail('ATTACHMENT_HASH_MISMATCH');
  const objectRoute=route+'/messages/'+encodeURIComponent(message.id)+'/'+encodeURIComponent(id);
  const uploadedRoute=frameIndex===undefined?objectRoute:objectRoute+'/frames/'+frameIndex;
  if (this.missing.delete(uploadedRoute)) this.work.wakeReference(t.key,message.id,id);
  this.inFlight.delete(uploadedRoute);
 }
 async uploadMessage(descriptor,message){
  // The accepted identity is persisted by the caller before any upload. Use
  // the normal uploader on a transient, not-yet-accepted native message.
  let history=[message];const view=Object.create(this);
  view.connection={...this.connection,topics:[descriptor]};
  view.queue={readSnapshot:async()=>({history}),mutate:async(_d,fn)=>{history=fn(structuredClone(history));return {history};}};
  await view.uploadLocal();if(view.skipped)throw fail(view.skippedDetails[0]?.code||'ATTACHMENT_UPLOAD_INCOMPLETE');return history[0];
 }
 async uploadLocal(selection){
  const rows=selection?.topic ? null : await this.mapping();
  if(!selection){this.skipped=0;this.skippedDetails=[];}
  for(const d of selection?[selection.descriptor]:this.connection.topics){const t=selection?.topic||this.find(rows,d),snapshot=selection?.snapshot||await this.queue.readSnapshot(d);
   for(const message of snapshot.history)for(const attachment of message.attachments||[]){
    let cache;
    try{
     if(nativeReference(attachment))continue;
     const source=attachment._fileManagerData||attachment,value=attachment.blobHash||source.blobHash||attachment.hash||source.hash;
     if(!/^[a-f0-9]{64}$/.test(value||''))throw fail('ATTACHMENT_SOURCE_HASH_REQUIRED');
     const {file,stat}=await this.localFile(attachment);cache=JSON.stringify([t.key,message.id,attachmentId(attachment),value,file,stat.size,stat.mtimeMs]);
     if(this.rejected.has(cache))throw fail(this.rejected.get(cache));
     const fresh=!this.uploaded.has(cache);
     if(fresh){const bytes=await fs.readFile(file);if(selection?.current&&!selection.current())continue;if(digest(bytes)!==value)throw fail('ATTACHMENT_SOURCE_HASH_MISMATCH');const name=path.win32.basename(path.basename(attachment.name||source.name||'attachment.txt'));await this.uploadBytes(t,message,attachment,bytes,name,value,source.type);this.uploaded.set(cache,true);}
     const frames=source.imageFrames||attachment.imageFrames;
     if(Array.isArray(frames)&&frames.length&&(fresh||!source.frameHashes?.length)){
      if(frames.length>10)throw fail('ATTACHMENT_FRAME_LIMIT');const hashes=[];
      for(let index=0;index<frames.length;index++){if(selection?.current&&!selection.current())break;const frame=Buffer.from(frames[index],'base64');if(frame.length>MAX_FILE)throw fail('ATTACHMENT_FILE_TOO_LARGE');const value=digest(frame),type=frame[0]===137?'image/png':frame[0]===255?'image/jpeg':'image/webp',ext=type.split('/')[1].replace('jpeg','jpg');await this.uploadBytes(t,message,attachment,frame,'frame_'+index+'.'+ext,value,type,index);hashes.push(value);}
      if(selection?.current&&!selection.current())continue;
      if(JSON.stringify(source.frameHashes)!==JSON.stringify(hashes))await this.queue.mutate(this.localOnly?{...d,syncSource:'attachment-materialization'}:d,history=>history.map(m=>m.id!==message.id?m:{...m,attachments:(m.attachments||[]).map(a=>{const data=a._fileManagerData||a;if(attachmentId(a)!==attachmentId(attachment)||(a.hash||data.hash)!==value||JSON.stringify(data.imageFrames||a.imageFrames)!==JSON.stringify(frames))return a;return {...a,frameHashes:hashes,...(a._fileManagerData?{_fileManagerData:{...a._fileManagerData,frameHashes:hashes}}:{})};})}),this.localOnly?{intent:{source:'native-attachment-materialization',localOnly:true,known:false}}:undefined);
     }
     if(this.uploaded.size>10000)this.uploaded.delete(this.uploaded.keys().next().value);
    }catch(e){if(['ENOENT','ATTACHMENT_BLOB_MISSING','ATTACHMENT_SOURCE_OUTSIDE_ROOT','ATTACHMENT_SOURCE_HASH_REQUIRED','ATTACHMENT_FILE_TOO_LARGE','ATTACHMENT_TYPE_REJECTED'].includes(e.code)){this.skipped++;if(this.skippedDetails.length<100)this.skippedDetails.push({topicKey:t.key,messageId:message.id,attachmentId:attachmentId(attachment),code:e.code});if(cache&&e.code==='ATTACHMENT_TYPE_REJECTED'){this.rejected.set(cache,e.code);if(this.rejected.size>10000)this.rejected.delete(this.rejected.keys().next().value);}continue;}throw e;}
   }
  }
 }
 async restoreRemote(selection){
  // Retire vanished references after a complete scan, without forgetting a
  // newer miss recorded by a concurrent targeted recovery.
  const unseen = !selection && this.missing.size ? new Map(this.missing) : null;
  const rows=selection?.topic ? null : await this.mapping();
  let retryAt;
  for(const d of selection?.descriptor?[selection.descriptor]:this.connection.topics){const t=selection?.topic||this.find(rows,d),snapshot=selection?.snapshot||await this.queue.readSnapshot(d);
   for(const message of snapshot.history.filter(m=>!selection?.messageId||m.id===selection.messageId))for(const attachment of message.attachments||[]){
    if(nativeReference(attachment))continue;
    const expected=attachment.blobHash||attachment.hash;if(!/^[a-f0-9]{64}$/.test(expected||''))continue;
    let local=false;try{const existing=await this.localFile(attachment);local=digest(await fs.readFile(existing.file))===expected;}catch(e){if(!['ENOENT','ATTACHMENT_BLOB_MISSING','ATTACHMENT_SOURCE_OUTSIDE_ROOT'].includes(e.code))throw e;}
    const data=attachment._fileManagerData||attachment,frameHashes=attachment.frameHashes||data.frameHashes;
    if(local&&(!frameHashes?.length||(data.imageFrames?.length===frameHashes.length&&data.imageFrames.every((f,i)=>digest(Buffer.from(f,'base64'))===frameHashes[i]))))continue;
    const route=this.routeBase+encodeURIComponent(t.key)+'/messages/'+encodeURIComponent(message.id)+'/'+encodeURIComponent(attachmentId(attachment));
    let restored=data,provided=false;
    const original=selection?.nativeMessage?.attachments?.find(a=>attachmentId(a)===attachment.id&&(a.blobHash||a._fileManagerData?.blobHash||a.hash||a._fileManagerData?.hash)===expected);
    if(!local&&original){try{const value=await this.localFile(original);if(digest(await fs.readFile(value.file))===expected){restored=original._fileManagerData||original;provided=true;}}catch(e){if(!['ENOENT','ATTACHMENT_BLOB_MISSING','ATTACHMENT_SOURCE_OUTSIDE_ROOT'].includes(e.code))throw e;}}
    const version = expected + ':' + (message._nativeSyncMetadata?.hash || '');
    if (unseen) {
     if (!local && !provided && unseen.get(route)?.version === version) unseen.delete(route);
     for (const [i, hash] of (frameHashes || []).entries()) {
      const frameRoute = route+'/frames/'+i;
      if (unseen.get(frameRoute)?.version === version+':'+hash) unseen.delete(frameRoute);
     }
    }
    // Don't fetch the main blob repeatedly while a required frame is known missing.
    if (!provided && frameHashes?.some((hash, i) => this.waiting(route+'/frames/'+i, version+':'+hash))) {
     retryAt=Math.min(...frameHashes.map((hash,i)=>this.waiting(route+'/frames/'+i,version+':'+hash)?this.missing.get(route+'/frames/'+i).retryAt:Infinity));
     this.noteMissing(t, message, attachment);
     continue;
    }
    if (!local && !provided) {
     if (typeof this.storeAttachment !== 'function') throw fail('NATIVE_ATTACHMENT_STORE_REQUIRED');
     const bytes = await this.fetchAttachment(route, version, t.key);
     if (bytes === null) { retryAt=this.missing.get(route)?.retryAt ?? this.now()+FIRST_RETRY_MS; this.noteMissing(t, message, attachment); continue; }
     if (bytes.length > MAX_FILE || digest(bytes) !== expected) throw fail('ATTACHMENT_HASH_MISMATCH');
     restored = await this.storeAttachment(bytes, attachment.name, d.itemId, d.topicId, attachment.type);
     if (restored.hash !== expected) throw fail('ATTACHMENT_HASH_MISMATCH');
    }
    let frames = attachment.imageFrames ?? null;
    if (frameHashes?.length) {
     frames = [];
     for (const [index, hash] of frameHashes.entries()) {
      const available = provided && restored.imageFrames?.[index];
      const localBytes = available ? Buffer.from(available, 'base64') : null;
      const bytes = localBytes && digest(localBytes) === hash ? localBytes :
       await this.fetchAttachment(route+'/frames/'+index, version+':'+hash, t.key);
      if (bytes === null) {retryAt=this.missing.get(route+'/frames/'+index)?.retryAt ?? this.now()+FIRST_RETRY_MS;break;}
      if (digest(bytes) !== hash) throw fail('ATTACHMENT_HASH_MISMATCH');
      frames.push(bytes.toString('base64'));
     }
     if (frames.length !== frameHashes.length) { this.noteMissing(t, message, attachment); continue; }
    }
    if(selection?.current && !selection.current())continue;
    this.missing.delete(route);
    // Only the native Queue may change local history. Keep synced content
    // metadata authoritative while adding device-local native file handles.
    let result;
    try {
     result=await this.queue.mutate(this.localOnly?{...d,syncSource:'attachment-materialization'}:d,history=>{
      const current=history.find(m=>m.id===message.id);
      const ref=current?.attachments?.find(a=>attachmentId(a)===attachmentId(attachment));
      const raw=ref?._fileManagerData||ref;
      if(!ref || (selection?.current && !selection.current()) ||
         (ref.blobHash||raw.blobHash||ref.hash||raw.hash)!==expected ||
         JSON.stringify(ref.frameHashes||raw.frameHashes||[])!==JSON.stringify(frameHashes||[])) {
       throw fail('ATTACHMENT_REFERENCE_CHANGED');
      }
      return history.map(m=>m!==current?m:{...m,attachments:m.attachments.map(a=>a!==ref?a:{
       ...a,src:restored.internalPath,internalPath:restored.internalPath,_fileManagerData:materializedData(a,restored,frames,frameHashes)
      })});
     },{intent:{source:'native-attachment-materialization',localOnly:true,known:false}});
    } catch(error) {
     if(error.code==='ATTACHMENT_REFERENCE_CHANGED')continue;
     throw error;
    }
    await this.onMaterialized(d,result);
   }
  }
  if (unseen) for (const [route, prior] of unseen) {
   if (this.missing.get(route) === prior) this.missing.delete(route);
  }
  return retryAt;
 }
}
module.exports={DesktopAttachments};

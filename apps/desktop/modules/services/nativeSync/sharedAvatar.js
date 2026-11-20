'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {ownedJson}=require('./sharedLocal'),{assertHistoryPath}=require('./sourceDirectory'),{fail}=require('./protocol');
const extensions=['png','jpg','jpeg','gif','webp'];
async function readAvatar(root,dir,thumbnail){for(const ext of extensions){const file=path.join(dir,'avatar.'+ext);await assertHistoryPath(root,file);let stat;try{stat=await fs.lstat(file);}catch(e){if(e.code==='ENOENT')continue;throw e;}if(stat.isSymbolicLink()||stat.nlink!==1)throw fail('AVATAR_PATH_ALIAS');const type=ext==='png'?'png':ext==='jpg'||ext==='jpeg'?'jpeg':ext==='webp'?'webp':null;if(type&&stat.size<=18000)return 'data:image/'+type+';base64,'+(await fs.readFile(file)).toString('base64');if(thumbnail)return thumbnail(file);throw fail('SHARED_AVATAR_PROJECTION_REQUIRED');}return null;}
async function writeAvatar(root,dir,value){
 await assertHistoryPath(root,path.join(dir,'avatar.png'));await fs.mkdir(dir,{recursive:true});
 if(value){const match=/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(value);if(!match||value.length>24000)throw fail('INVALID_AVATAR');const ext=match[1]==='jpeg'?'jpg':match[1],bytes=Buffer.from(match[2],'base64'),file=path.join(dir,'avatar.'+ext),temp=file+'.'+randomUUID()+'.tmp';let handle;
  try{handle=await fs.open(temp,'wx',0o600);await handle.writeFile(bytes);await handle.sync();await handle.close();handle=null;await fs.rename(temp,file);}finally{await handle?.close().catch(()=>{});await fs.rm(temp,{force:true});}
  for(const old of extensions)if(old!==ext){const other=path.join(dir,'avatar.'+old);await assertHistoryPath(root,other);await fs.rm(other,{force:true});}
 }else for(const ext of extensions){const file=path.join(dir,'avatar.'+ext);await assertHistoryPath(root,file);await fs.rm(file,{force:true});}
 if(process.platform!=='win32'){const d=await fs.open(dir,'r');try{await d.sync();}finally{await d.close();}}
}
module.exports={readAvatar,writeAvatar};

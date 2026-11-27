// Local-only durability for ordinary drafts touched by dictation.
let database;
function open() {
 if(!database)database=new Promise((resolve,reject)=>{
  const request=indexedDB.open('vcp-mobile-voice-draft',1);
  request.onupgradeneeded=()=>request.result.createObjectStore('drafts');
  request.onsuccess=()=>resolve(request.result);
  request.onerror=()=>reject(request.error);
  request.onblocked=()=>reject(Error('Voice draft storage is blocked'));
 }).catch(error=>{database=null;throw error;});
 return database;
}

export async function readVoiceDraft(scope) {
 const db=await open();
 return new Promise((resolve,reject)=>{
  const request=db.transaction('drafts').objectStore('drafts').get(scope);
  request.onsuccess=()=>resolve(request.result);
  request.onerror=()=>reject(request.error);
 });
}

export async function writeVoiceDraft(scope,record) {
 const db=await open();
 return new Promise((resolve,reject)=>{
  const transaction=db.transaction('drafts','readwrite',{durability:'strict'});
  const drafts=transaction.objectStore('drafts');
  const read=drafts.get(scope);
  read.onsuccess=()=>{if(!read.result||read.result.savedAt<=record.savedAt)drafts.put(record,scope);};
  transaction.oncomplete=()=>resolve();
  transaction.onabort=()=>reject(transaction.error);
 });
}

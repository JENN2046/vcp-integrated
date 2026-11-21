const DB_NAME = 'vcp-mobile-pair-recovery';
const STORE = 'credentials';
const SLOT = 'paired-device';
const LOCK = 'vcp-mobile-device-session';
const REJECTED_SESSION_CHANGES = new Set([
 'INVALID_PAIRING','INVALID_CONNECTION','INVALID_SERVER_ADDRESS','AUTH_FAILED',
 'AUTH_RATE_LIMIT','SERVER_NOT_APPROVED','PROTECTED_HOST_NOT_READY','HOST_DRAINING','PAIR_REQUIRED',
]);

function base64url(bytes) {
 return btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
}

function pairRequired(error) {
 return error.status===401 && error.code==='PAIR_REQUIRED';
}

function alreadyAuthenticated(error) {
 return error.status===409 && error.code==='MOBILE_SESSION_ALREADY_AUTHENTICATED';
}

export function createPairRecovery({origin, indexedDB, crypto, locks, secureContext}) {
 const supported = Boolean(secureContext && indexedDB && crypto?.subtle && locks);
 const withSessionLock = (operation) => locks ? locks.request(LOCK,operation) : operation();

 async function useStore(mode, action) {
  const db = await new Promise((resolve,reject)=>{
   const request = indexedDB.open(DB_NAME,1);
   request.onupgradeneeded = ()=>request.result.createObjectStore(STORE);
   request.onsuccess = ()=>resolve(request.result);
   request.onerror = ()=>reject(request.error);
  });
  try {
   return await new Promise((resolve,reject)=>{
    const transaction = mode==='readwrite'
     ? db.transaction(STORE,mode,{durability:'strict'})
     : db.transaction(STORE,mode);
    transaction.onabort = ()=>reject(transaction.error || Error('无法保存设备恢复设置，请检查浏览器存储后重试。'));
    if (mode==='readwrite' && transaction.durability!=='strict') {
     transaction.abort();
     return;
    }
    const request = action(transaction.objectStore(STORE));
    // A request can succeed before its transaction commits.
    transaction.oncomplete = ()=>resolve(request.result);
   });
  } finally {
   db.close();
  }
 }

 const read = ()=>useStore('readonly',store=>store.get(SLOT));
 const write = value=>useStore('readwrite',store=>store.put(value,SLOT));
 const clear = ()=>indexedDB ? useStore('readwrite',store=>store.delete(SLOT)) : Promise.resolve();

 async function readForChange() {
  if (!supported) return undefined;
  try {
   return await read();
  } catch {
   throw Error('无法核对设备恢复设置，请检查浏览器存储后重试。');
  }
 }

 async function changeSession(operation) {
  const previous = await readForChange();
  // Retire the previous proof before changing identity. On an ambiguous
  // response, this prevents signing into the previous identity.
  if (previous?.credential) await clear();
  try {
   return await operation();
  } catch (error) {
   if (previous?.credential && REJECTED_SESSION_CHANGES.has(error.code)) await write(previous);
   throw error;
  }
 }

 async function pair(api,code) {
  const previous = await readForChange();
  let key;
  if (supported) {
   try {
    const {publicKey,privateKey} = await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},false,['sign','verify']);
    key = {publicKey:base64url(await crypto.subtle.exportKey('raw',publicKey)),privateKey};
    await write({credential:key});
   } catch {
    key = undefined;
   }
  }

  if (!key) {
   await changeSession(()=>api('pair',{code}));
   return false;
  }

  let result;
  try {
   result = await api('pair',{code,recoveryPublicKey:key.publicKey});
  } catch (error) {
   if (REJECTED_SESSION_CHANGES.has(error.code)) await (previous ? write(previous) : clear());
   throw error;
  }

  if (result.recoveryEnrolled===true) return true;
  await clear().catch(()=>{});
  return false;
 }

 async function recover(api) {
  const key = (await read())?.credential;
  if (!key || key.privateKey?.extractable!==false) return false;
  const recoveryPublicKey = key.publicKey;
  const {challenge} = await api('pair/challenge',{recoveryPublicKey});
  if (typeof challenge!=='string' || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) throw Error('设备恢复校验失败。');
  const payload = new TextEncoder().encode(JSON.stringify(['vcp-mobile-pair-recovery-v1',origin,challenge]));
  const signature = base64url(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key.privateKey,payload));
  await api('pair/recover',{recoveryPublicKey,challenge,signature});
  return true;
 }

 async function openSession(api) {
  // Other tabs share the cookie jar. Read it inside the same lock used for
  // pairing, connection changes and disconnect before considering recovery.
  return withSessionLock(async()=>{
   try {
    return await api('session');
   } catch (error) {
    if (!supported || !pairRequired(error)) throw error;
    try {
     if (!await recover(api)) throw error;
    } catch (failure) {
     if (pairRequired(failure) || failure.status===404) throw error;
     if (!alreadyAuthenticated(failure)) throw failure;
    }
   }
   return api('session');
  });
 }

 return {withSessionLock,pair,changeSession,openSession};
}

'use strict';
const {randomUUID}=require('node:crypto');
const capability='shared-wait-v1', lanes=['matches','changes','pull'], zero='0';
const invalid=(code,status)=>Object.assign(Error(code),{code,status});
const hubs=new WeakMap();

// Hints belong to this SQLite writer and disappear on restart. TEMP triggers cover
// mobile, desktop, and nested transactions; rolled-back writes roll back the tokens.
class SharedWait {
 constructor(shared) {
  this.shared=shared;this.db=shared.db;this.epoch=randomUUID();this.waiters=new Set();
  this.db.exec("CREATE TEMP TABLE IF NOT EXISTS ns_wait_versions(space TEXT,source TEXT,matches TEXT DEFAULT '0',changes TEXT DEFAULT '0',pull TEXT DEFAULT '0',PRIMARY KEY(space,source))");
  this.db.function('ns_wait_changed',()=>{
   if(this.waiters.size&&!this.scheduled){
    this.scheduled=true;
    queueMicrotask(()=>{this.scheduled=false;for(const waiter of this.waiters)waiter.check(false)});
   }
   return 0;
  });
  const trigger=(table,event,fields,from,suffix='')=>{
   const values=fields.map(()=>'lower(hex(randomblob(8)))').join(',');
   const assignments=fields.map(k=>k+'=excluded.'+k).join(',');
   this.db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS ns_wait_${table}_${event}${suffix} AFTER ${event} ON main.${table}
    BEGIN INSERT INTO ns_wait_versions(space,source,${fields.join(',')})
     SELECT m.space_id,m.source_id,${values} FROM shared_members m ${from}
     ON CONFLICT(space,source) DO UPDATE SET ${assignments}; SELECT ns_wait_changed(); END`);
  };
  trigger('shared_changes','INSERT',['changes'],'WHERE m.space_id=NEW.space_id');
  // A structural directory change can make existing messages visible.
  trigger('shared_changes','INSERT',['pull'],"WHERE m.space_id=NEW.space_id AND NEW.kind<>'config'",'_visibility');
  for(const event of ['INSERT','UPDATE','DELETE']){
   const row=event==='DELETE'?'OLD':'NEW';
   trigger('shared_preparations',event,['matches'],`WHERE m.space_id=json_extract(${row}.proof_json,'$.plan.sharedSpaceId')`);
   trigger('shared_local_bindings',event,['changes','pull'],`WHERE m.space_id=${row}.space_id AND m.source_id=${row}.source_id`);
  }
  trigger('journal','INSERT',['pull'],`JOIN shared_objects t ON t.space_id=m.space_id
   JOIN shared_objects o ON o.id=t.parent_id WHERE t.owner_type=NEW.owner_type AND t.owner_id=NEW.owner_id
   AND t.topic_id=NEW.topic_id AND t.kind='topic' AND t.deleted=0 AND o.deleted=0
   AND NOT EXISTS(SELECT 1 FROM shared_local_bindings b WHERE b.source_id=m.source_id AND b.hidden=1 AND b.object_id IN(t.id,o.id)
   AND NOT EXISTS(SELECT 1 FROM shared_local_bindings a WHERE a.source_id=b.source_id AND a.object_id=b.object_id AND a.hidden=0))`);
  this.read=this.db.prepare('SELECT matches,changes,pull FROM ns_wait_versions WHERE space=? AND source=?');
 }
 wait(actor,space,since,signal,timeout=30000){
  if(actor.kind!=='desktop')throw invalid('SHARED_DEVICE_REQUIRED',403);
  this.shared.authorize(actor,space);
  if(since!==undefined&&!/^[a-f0-9-]{36}(?:\.(?:0|[a-f0-9]{16})){3}$/.test(since))throw invalid('INVALID_SHARED_WAIT_TOKEN',400);
  if(this.waiters.size>=128||[...this.waiters].filter(w=>w.source===actor.sourceId).length>=2)throw invalid('SHARED_WAIT_BUSY',429);
  const prior=since?.split('.');
  return new Promise((resolve,reject)=>{
   let timer;
   const stop=()=>{clearTimeout(timer);this.waiters.delete(waiter);signal?.removeEventListener('abort',abort)};
   const abort=()=>{stop();reject(invalid('SHARED_WAIT_CANCELLED',503))};
   const waiter={source:actor.sourceId,check:expired=>{
    try{
     this.shared.authorize(actor,space);
     const row=this.read.get(space,actor.sourceId);
     const versions=lanes.map(k=>row?.[k]||zero);
     const changed=lanes.filter((_,i)=>prior?.[0]!==this.epoch||prior[i+1]!==versions[i]);
     if(!expired&&!changed.length)return;
     stop();resolve({token:[this.epoch,...versions].join('.'),changed});
    }catch(error){stop();reject(error)}
   }};
   this.waiters.add(waiter);
   if(signal?.aborted){abort();return}
   signal?.addEventListener('abort',abort,{once:true});
   timer=setTimeout(()=>waiter.check(true),timeout);timer.unref?.();
   waiter.check(false);
  });
 }
}
function hub(shared){let value=hubs.get(shared);if(!value){value=new SharedWait(shared);hubs.set(shared,value)}return value}
module.exports={capability,hub};

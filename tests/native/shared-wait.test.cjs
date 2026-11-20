'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,CHAT,BOX}=require('./fixtures/sharedSingleHarness.cjs');
const {hub}=require(BOX+'/Plugin/NativeSync/sync/sharedWait');
const {SharedWaitClient}=require(CHAT+'/modules/services/nativeSync/sharedWaitClient');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
test('wait observes committed revisions, closes the subscribe race and respects rollback and timeout',async t=>{
 const f=await fixture(t),wait=hub(f.shared),a=f.actor('A'),space='sharedAB';
 const first=await wait.wait(a,space);assert.deepEqual(first.changed,['matches','changes','pull']);
 const edit=id=>f.store.apply({...f.topic.topic,msgId:id,deviceId:'fixture',opId:id,baseHash:null,action:'upsert',message:{id,role:'user',content:id,timestamp:1}},{sharedSpace:space});
 const pending=wait.wait(a,space,first.token,undefined,1000);
 f.shared.atomic(()=>edit('wait-one'));
 const n=await pending;assert.deepEqual(n.changed,['pull']);
 assert.throws(()=>f.shared.atomic(()=>{edit('rolled-back');throw Error('abort')}),/abort/);
 const empty=await wait.wait(a,space,n.token,undefined,15);assert.deepEqual(empty.changed,[]);assert.equal(empty.token,n.token);
 const current=f.shared.get(a,space,f.owner.id);f.shared.saveConfig(a,{sharedSpaceId:space,sharedId:f.owner.id,opId:'wait-cfg',expectedVersion:current.version,config:{...current.config,name:'Wait test'}});
 edit('wait-two');const both=await wait.wait(a,space,n.token);assert.deepEqual(both.changed,['changes','pull']);
 assert.equal(wait.waiters.size,0);assert.throws(()=>wait.wait(a,'foreign',n.token),e=>e.status===403);
});
test('match preparation signals matches, disconnect releases slots and revoked membership cannot resume',async t=>{
 const f=await fixture(t),h=hub(f.shared),a=f.actor('A'),space='sharedAB';const v=await h.wait(a,space);
 const ctrl=new AbortController(),p=h.wait(a,space,v.token,ctrl.signal);assert.equal(h.waiters.size,1);
 ctrl.abort();await assert.rejects(p,{code:'SHARED_WAIT_CANCELLED'});assert.equal(h.waiters.size,0);
 const pending=h.wait(a,space,v.token);
 f.shared.atomic(()=>f.store.db.prepare('insert into shared_preparations values(?,?,?)').run('fixture','sourceA',JSON.stringify({status:'prepared',plan:{sharedSpaceId:space}})));
 assert.deepEqual((await pending).changed,['matches']);
 const updated=await h.wait(a,space);
 const revoke=h.wait(a,space,updated.token,undefined,15);f.shared.grants.get(space).delete('sourceA');await assert.rejects(revoke,e=>e.status===403);assert.equal(h.waiters.size,0);
});
test('only one wait, reconnect triggers all lanes; an old server keeps legacy polling',async()=>{
 const pending=[];const send=(route,{signal})=>new Promise((resolve,reject)=>{pending.push({route,resolve,reject});signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true})});
 const w=new SharedWaitClient(send,'space',()=>{}),all=['matches','changes','pull'];
 try{
 w.configure(false);assert.deepEqual([...w.take()],all);assert.equal(pending.length,0);
 w.configure(true);w.configure(true);assert.equal(pending.length,1);
 const token='12345678-1234-1234-1234-123456789abc.0.0.0';
 pending[0].resolve({token,changed:all});await sleep(0);assert.deepEqual([...w.take()],all);assert.equal(w.take().size,0);
 pending[1].resolve({token:token.slice(0,-1)+'1111111111111111',changed:['pull']});await sleep(0);assert.deepEqual([...w.take()],['pull']);
 pending[2].reject(Error('offline'));await sleep(0);assert.deepEqual([...w.take()],all);await sleep(550);assert(!pending[3].route.includes('since='));
 }finally{w.close()}
});
test('a hidden topic cannot wake another source for message contents; reconnect with a stale epoch requests all three lanes',async t=>{
 const f=await fixture(t),b=await f.desktop('B'),h=hub(f.shared),space='sharedAB',a=f.actor('A'),peer=f.actor('B');
 assert(b.runtime.execution.mapping(b.descriptor).sharedId===f.topic.id);
 f.shared.remove(peer,{sharedSpaceId:space,sharedId:f.topic.id,opId:'wait-hide',mode:'device'});
 const [wa,wb]=await Promise.all([h.wait(a,space),h.wait(peer,space)]);
 const waiting=h.wait(peer,space,wb.token,undefined,25);
 f.store.apply({...f.topic.topic,msgId:'wait-visible-scope',deviceId:'fixture',opId:'wait-visible-scope',baseHash:null,action:'upsert',
  message:{id:'wait-visible-scope',role:'user',content:'fixture',timestamp:1}},{sharedSpace:space});
 assert.deepEqual((await h.wait(a,space,wa.token)).changed,['pull']);
 assert.deepEqual((await waiting).changed,[]);
 const old='00000000-0000-0000-0000-000000000000.'+wa.token.split('.').slice(1).join('.');
 assert.deepEqual((await h.wait(a,space,old)).changed,['matches','changes','pull']);
});

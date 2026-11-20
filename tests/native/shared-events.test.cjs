'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),{EventEmitter}=require('node:events');
const BOX=path.join(process.env.VCP_TEST_SERVER||path.resolve(__dirname,'../../apps/server'),'Plugin/NativeSync');
const {CentralStore}=require(BOX+'/sync/centralStore'),{SourceCatalog}=require(BOX+'/sync/sourceCatalog'),{SharedSpace}=require(BOX+'/sync/sharedSpace'),{SharedEvents}=require(BOX+'/sync/sharedEvents'),{openSharedEventStream}=require(BOX+'/sync/sharedEventHttp'),{nativeResponse}=require(BOX+'/mobile/nativeResponse');
async function fixture(t,limits={},noAdmission=false){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'ns-events-')),store=new CentralStore(root+'/central.sqlite');
 const config={NativeSyncFullSources:JSON.stringify(['A','B'].map(x=>({sourceId:'source'+x,deviceId:'device'+x,executionMode:'all-supported'}))),NativeSyncSharedSpaces:JSON.stringify([{id:'spaceAB',sources:['sourceA','sourceB']}])};
 store.sourceCatalog=new SourceCatalog(store,config);const shared=store.shared=new SharedSpace(store,config);
 const actor=x=>shared.desktop({sourceId:'source'+x,deviceId:'device'+x,spaceId:store.sourceCatalog.spaceId},'shared-space-v1');for(const x of ['A','B'])shared.join(actor(x),{sharedSpaceId:'spaceAB',opId:'join'+x});
 const owner=shared.create(actor('A'),{sharedSpaceId:'spaceAB',opId:'owner',kind:'agent',localId:'owner',config:{name:'Synthetic',model:'synthetic',systemPrompt:'PRIVATE_SYNTHETIC_PROMPT',streamOutput:true}}).object;
 const topic=shared.create(actor('A'),{sharedSpaceId:'spaceAB',opId:'topic',kind:'topic',localId:'topic',localParent:'owner',parentId:owner.id,config:{name:'Events'}}).object;
 const context=shared.executionConfig(actor('A'),{sharedSpaceId:'spaceAB',sharedId:topic.id});
 const admission=noAdmission?null:shared.admit(actor('A'),{sharedSpaceId:'spaceAB',sharedId:topic.id,requestId:'event-request',expectedHead:context.head,configHash:context.hash,message:{id:'event-user',role:'user',content:'synthetic',timestamp:1}});
 const engine={get:id=>({id,state:'running',config_snapshot:'PRIVATE_SYNTHETIC_CONFIG',response:'PRIVATE_RESPONSE'})};const events=shared.events=new SharedEvents(shared,engine,{limits});
 const query={sharedSpaceId:'spaceAB',sharedId:topic.id,executionId:admission?.id};
 t.after(async()=>{events.close();store.close();await fs.rm(root,{recursive:true,force:true});});return{store,shared,events,actor,query,admission};
}
function socket(){const req=new EventEmitter();req.url='/shared/events';const res=new EventEmitter();Object.assign(res,{frames:[],headers:null,writableEnded:false,destroyed:false,blocked:false,writeHead(status,headers){this.status=status;this.headers=headers;},write(frame){this.frames.push(frame);return!this.blocked;},end(){this.writableEnded=true;}});return{req,res};}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function admit(f,id,sharedId=f.query.sharedId){const context=f.shared.executionConfig(f.actor('A'),{sharedSpaceId:'spaceAB',sharedId});return f.shared.admit(f.actor('A'),{sharedSpaceId:'spaceAB',sharedId,requestId:id,expectedHead:context.head,configHash:context.hash,message:{id:id+'-user',role:'user',content:'PRIVATE_TOPIC_TEST_INPUT',timestamp:1}});}
function finish(f,work){f.shared.dispatch(f.actor('A'),{sharedSpaceId:'spaceAB',admissionId:work.id});f.shared.nativeTerminal(work.id);return f.shared.complete(f.actor('A'),{sharedSpaceId:'spaceAB',admissionId:work.id,opId:'finish-'+work.id,message:{id:'reply_'+work.id,role:'assistant',content:'PRIVATE_FINISHED_BODY',timestamp:2}});}
const topicQuery=f=>({scope:'topic',sharedSpaceId:f.query.sharedSpaceId,sharedId:f.query.sharedId});
test('an observer subscribed before admission discovers the committed work once without receiving body, actor or config',async t=>{
 const f=await fixture(t,{},true),seen=[];const observer=f.events.subscribeTopic(f.actor('B'),topicQuery(f),event=>seen.push(event));assert.deepEqual(seen,[{type:'topic_ready',sharedSpaceId:'spaceAB',sharedId:f.query.sharedId}]);
 let rolledBack;
 assert.throws(()=>f.shared.atomic(()=>{rolledBack=admit(f,'rolled-back-topic-work');f.events.publish(rolledBack.id,'state',{state:'queued'});throw Object.assign(Error('rollback'),{code:'SYNTHETIC_ROLLBACK'});}),{code:'SYNTHETIC_ROLLBACK'});assert.equal(seen.length,1);
 const work=admit(f,'committed-topic-work');assert.equal(seen.length,1);f.events.publish(work.id,'state',{state:'queued',actor:'PRIVATE_ACTOR',config:'PRIVATE_CONFIG'});f.events.publish(work.id,'delta',{text:'PRIVATE_STREAM_BODY'});f.events.publish(work.id,'state',{state:'running'});
 assert.deepEqual(seen[1],{type:'work',sharedSpaceId:'spaceAB',sharedId:f.query.sharedId,executionId:work.id});assert.equal(seen.length,2);assert.doesNotMatch(JSON.stringify(seen),/PRIVATE_|payload|body|principal|config|epoch|seq/);observer.close();assert.equal(f.events.subscribers,0);assert.equal(f.events.topicListeners.size,0);
});
test('topic reconnect finds active work, shares connection limits and leaves every original work stream independent',async t=>{
 const f=await fixture(t,{maxSubscribers:3,maxSubscribersPerTopic:1}),seen=[];const discovery=f.events.subscribeTopic(f.actor('B'),topicQuery(f),event=>seen.push(event));assert.deepEqual(seen.map(event=>event.type),['topic_ready','work']);
 assert.throws(()=>f.events.subscribeTopic(f.actor('B'),topicQuery(f),()=>true),{code:'SHARED_EVENT_SUBSCRIBERS_LIMIT'});
 const received=[],work=f.events.subscribe(f.actor('B'),f.query,event=>received.push(event));finish(f,f.admission);f.events.publish(f.admission.id,'completed');const next=admit(f,'next-topic-work');f.events.publish(next.id,'state',{state:'queued'});f.events.publish(f.admission.id,'delta',{text:'late-old-work'});
 assert.deepEqual(seen.filter(event=>event.type==='work').map(event=>event.executionId),[f.admission.id,next.id]);assert.equal(work.closed,false);assert.equal(received.at(-1).executionId,f.admission.id);
 const second=f.events.subscribe(f.actor('B'),{...f.query,executionId:next.id},()=>true);assert.throws(()=>f.events.subscribe(f.actor('B'),{...f.query,executionId:next.id},()=>true),{code:'SHARED_EVENT_SUBSCRIBERS_LIMIT'});discovery.close();work.close();second.close();assert.equal(f.events.subscribers,0);
});
test('read-only mobile topic discovery does not grant execution and all scopes remain isolated',async t=>{
 const f=await fixture(t,{},true),phone=f.shared.mobile({id:'topic-reader',scopes:['shared:spaceAB:read']},'spaceAB','read'),seen=[];
 const subscription=f.events.subscribeTopic(phone,topicQuery(f),event=>seen.push(event));const work=admit(f,'read-only-observer-work');f.events.publish(work.id,'state',{state:'queued'});assert.equal(seen.at(-1).executionId,work.id);
 assert.throws(()=>f.shared.admit(phone,{sharedSpaceId:'spaceAB',sharedId:f.query.sharedId}),{code:'SHARED_PERMISSION_REQUIRED'});
 assert.throws(()=>f.events.subscribeTopic(phone,{...topicQuery(f),sharedSpaceId:'foreign'},()=>true),{code:'SHARED_SPACE_NOT_APPROVED'});
 const other=f.shared.create(f.actor('A'),{sharedSpaceId:'spaceAB',opId:'private-other-topic',kind:'topic',localId:'other',localParent:'owner',parentId:f.shared.row('spaceAB',f.query.sharedId).parent_id,config:{name:'Other'}}).object;
 const otherWork=admit(f,'different-topic-work',other.id);f.events.publish(otherWork.id,'state',{state:'queued'});assert.equal(seen.length,2);subscription.close();
});
test('topic HTTP discovery reauthenticates idle and queued sends and rejects execution cursors before headers',async t=>{
 const f=await fixture(t,{},true),s=socket();s.res.blocked=true;let allowed=true,reason;const resolveActor=()=>{if(!allowed)throw Error('expired session');return f.actor('B');};
 openSharedEventStream({shared:f.shared,...s,query:topicQuery(f),resolveActor,heartbeatMs:5,onClose:value=>{reason=value;}});assert.match(s.res.frames[0],/topic_ready/);assert.equal(f.events.subscribers,1);
 const work=admit(f,'queued-discovery-work');f.events.publish(work.id,'state',{state:'queued'});allowed=false;s.res.emit('drain');assert.equal(s.res.frames.length,1);assert.equal(reason,'authorization_lost');assert.equal(f.events.subscribers,0);
 const idle=socket();allowed=true;openSharedEventStream({shared:f.shared,...idle,query:topicQuery(f),resolveActor,heartbeatMs:5});allowed=false;await sleep(20);assert.equal(idle.res.writableEnded,true);assert.equal(f.events.subscribers,0);
 for(const extra of [{executionId:work.id},{after:'0'},{epoch:'old'},{scope:'other'}]){const invalid=socket();assert.throws(()=>openSharedEventStream({shared:f.shared,...invalid,query:{...topicQuery(f),...extra},resolveActor:()=>f.actor('A')}),{code:'INVALID_SHARED_EVENT_REQUEST'});assert.equal(invalid.res.headers,null);}
});
test('topic metadata discovery survives a saturated execution-body cache and host close releases both subscription kinds',async t=>{
 const f=await fixture(t,{maxWorks:1}),first=f.events.subscribe(f.actor('B'),f.query,()=>true),topic=f.shared.create(f.actor('A'),{sharedSpaceId:'spaceAB',opId:'cache-busy-other-topic',kind:'topic',localId:'cache-other',localParent:'owner',parentId:f.shared.row('spaceAB',f.query.sharedId).parent_id,config:{name:'Other'}}).object,seen=[];
 const discovery=f.events.subscribeTopic(f.actor('B'),{sharedSpaceId:'spaceAB',sharedId:topic.id},event=>seen.push(event));const next=admit(f,'cache-saturated-work',topic.id);assert.equal(f.events.publish(next.id,'state',{state:'queued'}),null);assert.equal(seen.at(-1).executionId,next.id);assert.equal(f.shared.active(topic.id).state,'accepted');
 f.events.close();assert.equal(first.closed,true);assert.equal(discovery.closed,true);assert.equal(f.events.subscribers,0);assert.equal(f.events.topicListeners.size,0);
});
test('real HTTP topic routes discover a later admitted work for desktop and a read-only Cookie, then stop an expired Cookie', {timeout:5000},async t=>{
 const {fixture:sharedFixture,wait}=require('./fixtures/sharedSingleHarness.cjs'),f=await sharedFixture(t),query=new URLSearchParams({scope:'topic',sharedSpaceId:'sharedAB',sharedId:f.topic.id});
 const desktop=await fetch(f.url+'/api/v1/sync/shared/session-events?'+query,{headers:{'x-nativesync-source':'sourceB','x-nativesync-device':'deviceB','x-nativesync-space':f.store.sourceCatalog.spaceId,'x-nativesync-capabilities':'shared-space-v1,shared-events-v1'}});assert.equal(desktop.status,200);
 const pairing=f.portal.createPairing({scopeMode:'shared',sharedSpaceId:'sharedAB',permissions:['read']}),paired=await fetch(f.url+'/mobile/api/pair',{method:'POST',headers:{'x-forwarded-proto':'https',origin:'https://synthetic-shared.invalid','content-type':'application/json'},body:JSON.stringify({code:pairing.pairingCode})});assert.equal(paired.status,200);
 const cookie=paired.headers.get('set-cookie').split(';')[0],phoneHeaders={cookie,'x-forwarded-proto':'https','x-nativesync-capabilities':'shared-space-v1,shared-events-v1'};
 const phone=await fetch(f.url+'/mobile/api/shared/session-events?'+query,{headers:phoneHeaders});assert.equal(phone.status,200);
 const reader=response=>{const read=response.body.getReader(),decoder=new TextDecoder();let buffer='';return {close:()=>read.cancel().catch(()=>{}),async next(){for(;;){const at=buffer.indexOf('\n\n');if(at>=0){const raw=buffer.slice(0,at);buffer=buffer.slice(at+2);const data=raw.split('\n').find(line=>line.startsWith('data:'));if(data)return JSON.parse(data.slice(5));continue;}const chunk=await read.read();if(chunk.done)return null;buffer+=decoder.decode(chunk.value,{stream:true});}}};};
 const a=reader(desktop),b=reader(phone);t.after(async()=>{await a.close();await b.close();});assert.equal((await a.next()).type,'topic_ready');assert.equal((await b.next()).type,'topic_ready');
 const context=f.shared.executionConfig(f.actor('A'),{sharedSpaceId:'sharedAB',sharedId:f.topic.id}),body={sharedSpaceId:'sharedAB',sharedId:f.topic.id,requestId:'http-topic-first-work',expectedHead:context.head,configHash:context.hash,message:{id:'http-topic-first-user',role:'user',content:'synthetic HTTP discovery',timestamp:1}};
 const denied=await fetch(f.url+'/mobile/api/shared/session-send',{method:'POST',headers:{...phoneHeaders,'x-nativesync-capabilities':'shared-space-v1,shared-session-v1',origin:'https://synthetic-shared.invalid','content-type':'application/json'},body:JSON.stringify(body)});assert.equal(denied.status,403);
 const accepted=f.shared.sessionSend(f.actor('A'),body),desktopWork=await a.next(),phoneWork=await b.next();assert.deepEqual(desktopWork,phoneWork);assert.deepEqual(desktopWork,{type:'work',sharedSpaceId:'sharedAB',sharedId:f.topic.id,executionId:accepted.id});
 const session=f.portal.currentSession({headers:{cookie}});f.shared.db.prepare('UPDATE mobile_sessions SET expires=0 WHERE id=?').run(session.id);
 f.portal.engine.db.prepare('UPDATE mobile_executions SET not_before=0 WHERE id=?').run(accepted.id);f.portal.engine.setEndpoint({url:f.url+'/v1/chat/completions',key:'synthetic-only'});await wait(()=>f.portal.engine.get(accepted.id).state==='completed','HTTP discovery original completes');
 const nextContext=f.shared.executionConfig(f.actor('A'),{sharedSpaceId:'sharedAB',sharedId:f.topic.id}),next=f.shared.sessionSend(f.actor('A'),{...body,requestId:'http-topic-second-work',expectedHead:nextContext.head,message:{...body.message,id:'http-topic-second-user'}});
 assert.equal((await a.next()).executionId,next.id);assert.equal(await b.next(),null);assert.equal(f.calls(),1);await a.close();await b.close();
});
test('sequenced authorized body deltas have offsets/checksums; snapshot reveals no native configuration',async t=>{
 const f=await fixture(t),seen=[];const sub=f.events.subscribe(f.actor('B'),f.query,event=>seen.push(event));
 f.events.publish(f.admission.id,'delta',{text:'正文🌊',reasoning_content:'PRIVATE_REASONING'});f.events.publish(f.admission.id,'delta',{text:'继续'});
 assert.equal(seen[0].type,'snapshot');assert.deepEqual(seen.slice(1).map(e=>[e.seq,e.payload.offset,e.payload.endOffset]),[[1,0,4],[2,4,6]]);
 const snap=f.events.snapshot(f.actor('B'),f.query);assert.equal(snap.body.text,'正文🌊继续');assert.equal(snap.body.complete,true);assert.equal(snap.native.state,'running');assert.match(snap.body.hash,/^[a-f0-9]{64}$/);
 assert.doesNotMatch(JSON.stringify(seen)+JSON.stringify(snap),/PRIVATE_/);sub.close();assert.equal(f.events.subscribers,0);
});
test('bounded ring replay, retention gap, process epoch reset and snapshot watermarks do not dispatch',async t=>{
 const f=await fixture(t,{maxEvents:2}),work=f.admission.id;for(const text of ['a','b','c'])f.events.publish(work,'delta',{text});
 const snap=f.events.snapshot(f.actor('B'),f.query),replay=[];f.events.subscribe(f.actor('B'),f.query,e=>replay.push(e),{after:1,epoch:snap.epoch});assert.deepEqual(replay.map(e=>e.seq),[2,3]);
 const gap=[];f.events.subscribe(f.actor('B'),f.query,e=>gap.push(e),{after:0,epoch:snap.epoch});assert.deepEqual(gap.map(e=>e.type),['gap','snapshot']);assert.equal(gap[1].seq,3);assert.equal(gap[1].body.text,'abc');
 f.shared.dispatch(f.actor('A'),{sharedSpaceId:'spaceAB',admissionId:work});const fresh=new SharedEvents(f.shared,{get:()=>({state:'running'})});t.after(()=>fresh.close());const reset=[];fresh.subscribe(f.actor('B'),f.query,e=>reset.push(e),{after:3,epoch:snap.epoch});assert.deepEqual(reset.map(e=>e.type),['reset','snapshot']);assert.equal(reset[1].bodyUnavailable,true);assert.equal(f.shared.db.prepare('SELECT dispatched FROM shared_admissions WHERE id=?').get(work).dispatched,1);
});
test('scope authorization includes read-only mobile scopes, wrong topic/work and revoked desktop membership',async t=>{
 const f=await fixture(t),phone=f.shared.mobile({id:'read-phone',scopes:['shared:spaceAB:read']},'spaceAB','read');assert.equal(f.events.snapshot(phone,f.query).executionId,f.admission.id);
 assert.throws(()=>f.events.snapshot(phone,{...f.query,sharedSpaceId:'foreign'}),{code:'SHARED_SPACE_NOT_APPROVED'});
 const other=f.shared.create(f.actor('A'),{sharedSpaceId:'spaceAB',opId:'other-topic',kind:'topic',localId:'other',localParent:'owner',parentId:f.shared.row('spaceAB',f.query.sharedId).parent_id,config:{name:'Other'}}).object;
 assert.throws(()=>f.events.snapshot(f.actor('B'),{...f.query,sharedId:other.id}),{code:'SHARED_EVENT_SCOPE_MISMATCH'});
 f.shared.db.prepare('DELETE FROM shared_members WHERE source_id=?').run('sourceB');assert.throws(()=>f.events.snapshot(f.actor('B'),f.query),{code:'SHARED_MEMBERSHIP_REQUIRED'});
});
test('authoritative journal replaces evicted temporary body; premature completed hints are dropped',async t=>{
 const f=await fixture(t,{maxBodyBytes:4}),work=f.admission.id;f.events.publish(work,'delta',{text:'too long'});assert.equal(f.events.snapshot(f.actor('B'),f.query).bodyUnavailable,true);assert.equal(f.events.publish(work,'completed'),null);
 f.shared.dispatch(f.actor('A'),{sharedSpaceId:'spaceAB',admissionId:work});f.shared.nativeTerminal(work);f.shared.complete(f.actor('A'),{sharedSpaceId:'spaceAB',admissionId:work,opId:'complete-event',message:{id:'reply_'+work,role:'assistant',content:'done',timestamp:2}});
 const snap=f.events.snapshot(f.actor('B'),f.query);assert.equal(snap.request.state,'completed');assert.equal(snap.body.source,'journal');assert.equal(snap.body.text,'done');assert.equal(snap.bodyUnavailable,false);assert.equal(f.events.publish(work,'completed').type,'completed');
});
test('subscriber failure, cache saturation, oversized unicode deltas and close never affect native execution',async t=>{
 const f=await fixture(t,{maxSubscribers:2,maxSubscribersPerWork:2,maxEventBytes:8}),work=f.admission.id;
 const sub=f.events.subscribe(f.actor('B'),f.query,event=>event.type==='snapshot');f.events.publish(work,'delta',{text:'🌊🌊🌊🌊'});assert.equal(sub.closed,true);assert.equal(f.events.subscribers,0);
 assert.equal(f.events.snapshot(f.actor('A'),f.query).body.text,'🌊🌊🌊🌊');
 const a=f.events.subscribe(f.actor('B'),f.query,()=>true),b=f.events.subscribe(f.actor('B'),f.query,()=>true);assert.throws(()=>f.events.subscribe(f.actor('B'),f.query,()=>true),{code:'SHARED_EVENT_SUBSCRIBERS_LIMIT'});a.close();b.close();
 f.events.close();assert.equal(f.events.publish(work,'delta',{text:'later'}),null);assert.equal(f.shared.db.prepare('SELECT state FROM shared_admissions WHERE id=?').get(work).state,'accepted');
});
test('SSE heartbeat revokes idle sessions, drains large snapshots once, and bounds slow observers',async t=>{
 const f=await fixture(t);f.events.publish(f.admission.id,'delta',{text:'a'.repeat(100000)});const {req,res}=socket();res.blocked=true;let valid=true,reason;
 openSharedEventStream({shared:f.shared,req,res,query:f.query,resolveActor:()=>{if(!valid)throw Error('expired');return f.actor('B');},heartbeatMs:5,onClose:value=>{reason=value;}});
 assert.equal(res.frames.length,1);assert.match(res.frames[0],/snapshot/);assert.equal(res.writableEnded,false);res.blocked=false;res.emit('drain');assert.equal(res.frames.length,1);
 valid=false;await sleep(20);assert.equal(res.writableEnded,true);assert.equal(reason,'authorization_lost');assert.equal(f.events.subscribers,0);
 const slow=socket();slow.res.blocked=true;let slowReason;openSharedEventStream({shared:f.shared,...slow,query:f.query,resolveActor:()=>f.actor('B'),onClose:r=>{slowReason=r;}});
 for(let n=0;n<20;n++)f.events.publish(f.admission.id,'delta',{text:'x'.repeat(40000)});assert.equal(slow.res.writableEnded,true);assert.equal(slowReason,'slow_subscriber');assert.equal(f.events.subscribers,0);assert.equal(f.shared.active(f.query.sharedId).state,'accepted');
});
test('queued SSE data is reauthorized at drain and invalid cursors fail before headers',async t=>{
 const f=await fixture(t),s=socket();s.res.blocked=true;let valid=true;openSharedEventStream({shared:f.shared,...s,query:f.query,resolveActor:()=>{if(!valid)throw Error('revoked');return f.actor('B');}});
 f.events.publish(f.admission.id,'delta',{text:'queued'});valid=false;s.res.emit('drain');assert.equal(s.res.frames.length,1);assert.equal(s.res.writableEnded,true);assert.equal(f.events.subscribers,0);
 const invalid=socket();assert.throws(()=>openSharedEventStream({shared:f.shared,...invalid,query:{...f.query,after:'-1'},resolveActor:()=>f.actor('A')}),{code:'INVALID_SHARED_EVENT_CURSOR'});assert.equal(invalid.res.headers,null);
});
test('work cache saturation drops only observation; eviction resets identity and future cursor resets explicitly',async t=>{
 const f=await fixture(t,{maxWorks:1}),old=f.events.snapshot(f.actor('B'),f.query),sub=f.events.subscribe(f.actor('B'),f.query,()=>true);
 const topic=f.shared.create(f.actor('A'),{sharedSpaceId:'spaceAB',opId:'second-topic',kind:'topic',localId:'second',localParent:'owner',parentId:f.shared.row('spaceAB',f.query.sharedId).parent_id,config:{name:'Second'}}).object;
 const context=f.shared.executionConfig(f.actor('A'),{sharedSpaceId:'spaceAB',sharedId:topic.id});const next=f.shared.admit(f.actor('A'),{sharedSpaceId:'spaceAB',sharedId:topic.id,requestId:'second-request',expectedHead:context.head,configHash:context.hash,message:{id:'second-user',role:'user',content:'second',timestamp:2}});
 assert.equal(f.events.publish(next.id,'delta',{text:'saturated'}),null);assert.equal(f.shared.active(topic.id).state,'accepted');sub.close();assert.ok(f.events.publish(next.id,'delta',{text:'next'}));assert.equal(f.events.streams.size,1);
 const reset=[];f.events.subscribe(f.actor('B'),f.query,e=>reset.push(e),{after:0,epoch:old.epoch});assert.equal(reset[0].type,'reset');assert.equal(reset[0].reason,'epoch_changed');
 const ahead=[];f.events.subscribe(f.actor('B'),f.query,e=>ahead.push(e),{after:500,epoch:reset[0].epoch});assert.equal(ahead[0].reason,'cursor_ahead');assert.equal(f.events.publish(f.admission.id,'delta',{generation:1,text:'late'}),null);
});
test('snapshot callback handoff and synchronous refusal keep watermarks and subscriber accounting exact',async t=>{
 const f=await fixture(t),seen=[];const sub=f.events.subscribe(f.actor('B'),f.query,event=>{seen.push(event);if(event.type==='snapshot')f.events.publish(f.admission.id,'delta',{text:'concurrent'});return true;});assert.deepEqual(seen.map(e=>[e.type,e.seq]),[['snapshot',0],['delta',1]]);sub.close();
 const s=socket();s.res.destroyed=true;openSharedEventStream({shared:f.shared,...s,query:f.query,resolveActor:()=>f.actor('B')});assert.equal(f.events.subscribers,0);assert.equal(s.res.writableEnded,true);
});
async function responseFixture(t,text,{stream=true,type='text/event-stream',onDelta=()=>{}}={}){
 const bytes=typeof text==='string'?Buffer.from(text):text;t.mock.method(globalThis,'fetch',async()=>new Response(new ReadableStream({start(controller){for(let i=0;i<bytes.length;i+=3)controller.enqueue(bytes.subarray(i,i+3));controller.close();}}),{status:200,headers:{'content-type':type}}));
 return nativeResponse({endpoint:{url:'https://synthetic.invalid',key:'synthetic'},body:{stream},controller:new AbortController(),onDelta});
}
test('native parser exposes only validated display text with UTF-16 offsets and tolerates observer errors',async t=>{
 const deltas=[],text='data: {"choices":[{"delta":{"reasoning_content":"PRIVATE_REASONING","content":"正文🌊"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\r\n\r\ndata: [DONE]\r\n\r\n';
 const result=await responseFixture(t,text,{onDelta:value=>{deltas.push(value);throw Error('observer only');}});assert.equal(result.content,'正文🌊done');assert.deepEqual(deltas,[{text:'正文🌊',offset:0},{text:'done',offset:4}]);assert.doesNotMatch(JSON.stringify(deltas),/PRIVATE/);
});
test('native JSON error bodies and missing terminals never emit success in either response mode',async t=>{
 for(const text of ['{"error":"provider failed","choices":[{"message":{"content":"bad"}}]}','{"choices":[{"message":{"content":"partial"},"finish_reason":null}]}','{"choices":[{"message":{"content":"partial"}}]}']){let seen=0;await assert.rejects(responseFixture(t,text,{type:'application/json',onDelta:()=>seen++}));assert.equal(seen,0);}
 const deltas=[];await assert.rejects(responseFixture(t,'{"choices":[{"message":{"content":"legacy"}}]}',{stream:false,type:'application/json',onDelta:value=>deltas.push(value)}),{code:'STREAM_INCOMPLETE_REVIEW_REQUIRED'});assert.deepEqual(deltas,[]);
 const failed=await responseFixture(t,'{"error":{"status":429},"choices":[{"message":{"content":"not success"},"finish_reason":"stop"}]}',{stream:false,type:'application/json'});assert.equal(failed.modelError,true);assert.equal(failed.httpStatus,429);
});
test('truncated/malformed SSE and invalid UTF-8 preserve review-required semantics',async t=>{
 for(const bytes of ['data: {"choices":[{"delta":{"content":"partial"}}]}\n\n','data: {bad}\n\ndata: [DONE]\n\n',Buffer.from([0xff])])await assert.rejects(responseFixture(t,bytes),error=>/REVIEW_REQUIRED$/.test(error.code));
});
test('late group-capable observers recover only safe current activity from snapshots and reject malformed activity',async t=>{
 const f=await fixture(t),query=f.query;
 f.events.publish(f.admission.id,'approval',{state:'waiting_approval',prompt:'PRIVATE_APPROVAL_ARGUMENTS',result:'PRIVATE_TOOL_RESULT'});
 const snapshot={type:'snapshot',...f.events.snapshot(f.actor('B'),query)};
 assert.deepEqual(snapshot.activity,{type:'approval',state:'waiting_approval'});
 assert.doesNotMatch(JSON.stringify(snapshot),/PRIVATE_/);
 const {SharedEventProjection}=await import(require('node:url').pathToFileURL(path.resolve(__dirname,'../../apps/desktop/modules/services/nativeSync/sharedEventClient.mjs')));
 const observer=new SharedEventProjection(query);await observer.apply(snapshot);assert.deepEqual(observer.value().activity,snapshot.activity);
 const invalid=new SharedEventProjection(query),before=invalid.value();await assert.rejects(invalid.apply({...snapshot,activity:{type:'approval',state:'execute_arbitrary'}}),{code:'SHARED_EVENT_SNAPSHOT_INVALID'});assert.deepEqual(invalid.value(),before);
 f.events.publish(f.admission.id,'state',{state:'running'});assert.equal(f.events.snapshot(f.actor('B'),query).activity,undefined);
 f.events.publish(f.admission.id,'tool',{state:'started'});assert.deepEqual(f.events.snapshot(f.actor('B'),query).activity,{type:'tool',state:'started'});
 finish(f,f.admission);assert.equal(f.events.snapshot(f.actor('B'),query).activity,undefined);
});

test('report discovery is scoped to opted-in desktops, and quiet when its contents do not change', async t => {
 const f=await fixture(t),q=topicQuery(f),desktop={...f.actor('B'),capabilities:'shared-space-v1,shared-events-v1,shared-report-list-v1'};
 const mobile={kind:'mobile',principal:'mobile:reader',spaceId:q.sharedSpaceId,permissions:['read']};
 const sample={id:'report-work',requestId:'input',attempts:1,tasks:[{nativeTaskId:'task',invocationId:'inv',agentBaseName:'test'}]};
 let rows=[sample],reads=0;
 f.events.engine.nativeTasks={recentReports(space,topic){assert.deepEqual([space,topic],[q.sharedSpaceId,q.sharedId]);reads++;return rows;}};
 const observe=actor=>{const seen=[];const subscription=f.events.subscribeTopic(actor,q,event=>seen.push(event));t.after(()=>subscription.close());return seen;};
 const legacy=observe(f.actor('A')),phone=observe(mobile),first=observe(desktop),second=observe(desktop);
 assert.equal(legacy[0].reports,undefined);assert.equal(phone[0].reports,undefined);assert.deepEqual(first[0].reports,[sample]);
 // Isolated metadata fixture: exercise notification ordering without dispatch.
 f.shared.db.prepare("UPDATE shared_admissions SET state='completed' WHERE id=?").run(f.admission.id);
 const prior=reads;f.events.publish(f.admission.id,'completed');
 assert.equal(reads,prior+1);assert.equal(first.length,2);assert.equal(second.length,2);
 rows=[];f.events.publish(f.admission.id,'completed');
 assert.deepEqual(first.at(-1).reports,[]);assert.deepEqual(second.at(-1).reports,[]);
 assert.equal(legacy.filter(e=>e.type==='topic_ready').length,1);assert.equal(phone.filter(e=>e.type==='topic_ready').length,1);
});

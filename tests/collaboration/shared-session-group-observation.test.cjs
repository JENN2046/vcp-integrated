'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,wait,ctx,BOX}=require('./fixtures/sharedSingleHarness.cjs');
const {groupFixture,nativeStart,finish,sse,installNativeStreamResponder}=require('./fixtures/sharedGroupObservationHarness.cjs');
test('group observer sees native work without creating a local execution, then terminal History converges through Queue',async t=>{
 const g=await groupFixture(t),{f,b,descriptor}=g,d=descriptor(b),mapping=b.runtime.execution.mapping(d);
 await b.runtime.getExecutionStatus(d,{refresh:true});
 await g.a.runtime.getExecutionStatus(descriptor(g.a),{refresh:true});
 await wait(()=>b.runtime.sessions.topicObservers.get(mapping.sharedId)?.ready,'group topic observer subscribed');
 const before=JSON.stringify(b.runtime.execution.state.requests),work=await nativeStart(g,'l2-group-live');
 await wait(()=>b.runtime.sessions.values(d).some(value=>value.executionId===work.record.accepted.id&&value.request?.state==='dispatched'),'remote native group state');
 const query={sharedSpaceId:'sharedAB',sharedId:g.topic.id,executionId:work.record.accepted.id};
 const phone=f.shared.mobile({id:'l2-readonly',scopes:['shared:sharedAB:read']},'sharedAB','read');
 assert.equal(f.shared.events.snapshot(phone,query).executionId,work.record.accepted.id);
 assert.throws(()=>f.shared.admit(phone,{sharedSpaceId:'sharedAB',sharedId:g.topic.id}),{code:'SHARED_PERMISSION_REQUIRED'});
 assert.throws(()=>f.shared.events.snapshot(phone,{...query,sharedId:f.topic.id}),{code:'SHARED_EVENT_SCOPE_MISMATCH'});
 assert.throws(()=>f.shared.events.snapshot(phone,{...query,sharedSpaceId:'foreign'}),{code:'SHARED_SPACE_NOT_APPROVED'});
 assert.equal(JSON.stringify(b.runtime.execution.state.requests),before);assert.equal(f.calls(),1);assert.equal(f.store.metrics().journalRows,1);
 assert.equal(g.a.runtime.sessions.values(descriptor(g.a)).length,0,'submitting native group has no duplicate observation preview');
 await finish(g,work);
 await wait(async()=>{const history=await b.queue.readSerialized(d);return history.length===2&&history[1].content==='L2 native group result';},'remote terminal queue projection without tick or refresh');
 assert.equal(f.calls(),1);assert.equal(JSON.stringify(b.runtime.execution.state.requests),before);
 await wait(()=>b.runtime.adapter.state.outbox.length===0&&b.runtime.adapter.state.inbox.length===0,'final projection receipt cleanup');assert.equal(f.store.metrics().journalRows,2);
});
test('group selection returns and a disconnected observer recovers the original active identity without redispatch',async t=>{
 const g=await groupFixture(t),{f,b,descriptor}=g,d=descriptor(b),mapping=b.runtime.execution.mapping(d);
 await b.runtime.getExecutionStatus(d,{refresh:true});await wait(()=>b.runtime.sessions.topicObservers.get(mapping.sharedId)?.ready,'initial group observer');
 const work=await nativeStart(g,'l2-group-reconnect');await wait(()=>b.runtime.sessions.values(d).some(value=>value.executionId===work.record.accepted.id),'original discovered');
 // Selecting another native topic and returning retains the same read-only work.
 await b.runtime.getExecutionStatus(b.descriptor,{refresh:true});await b.runtime.getExecutionStatus(d,{refresh:true});
 assert.ok(b.runtime.sessions.values(d).some(value=>value.executionId===work.record.accepted.id));
 const topicEntry=b.runtime.sessions.topicObservers.get(mapping.sharedId);topicEntry.controller.abort();
 for(const entry of b.runtime.sessions.observers.values())entry.controller.abort();
 await wait(()=>!b.runtime.sessions.topicObservers.has(mapping.sharedId)&&b.runtime.sessions.observers.size===0,'observer connections closed');
 await b.runtime.getExecutionStatus(d,{refresh:true});
 await wait(()=>b.runtime.sessions.values(d).some(value=>value.executionId===work.record.accepted.id&&value.request?.state==='dispatched'),'same work after reconnect');
 assert.equal(f.calls(),1);assert.equal(Object.keys(b.runtime.execution.state.requests).length,0);
 await finish(g,work);await wait(async()=>(await b.queue.readSerialized(d)).length===2,'reconnected final History');
 assert.equal(f.calls(),1);assert.equal(f.shared.db.prepare('SELECT count(*) n FROM shared_admissions').get().n,1);
});

test('group observes native approval and a disconnected native outcome stays review-required without replay',async t=>{
 const g=await groupFixture(t),{f,b,descriptor}=g,d=descriptor(b),mapping=b.runtime.execution.mapping(d);
 await b.runtime.getExecutionStatus(d,{refresh:true});await wait(()=>b.runtime.sessions.topicObservers.get(mapping.sharedId)?.ready,'group approval observer');
 let release;const gate=new Promise(resolve=>{release=resolve;});t.after(()=>release());
 f.control.nativeResponder=async(_req,res)=>{try{await ctx.waitForApproval(gate);if(!res.destroyed)res.json({choices:[{message:{role:'assistant',content:'synthetic'},finish_reason:'stop'}]});}catch{if(!res.destroyed)res.destroy();}};
 const work=await nativeStart(g,'l2-group-approval');
 await wait(()=>b.runtime.sessions.values(d).some(value=>value.activity?.type==='approval'&&value.activity.state==='waiting_approval'),'remote native approval hint');
 // Abort only this synthetic native HTTP request. No persisted facts are edited.
 const request=f.shared.db.prepare('SELECT id FROM shared_native_requests WHERE admission_id=?').get(work.record.accepted.id);
 ctx.interruptWork(work.record.accepted.id);release();
 // A transport disconnect uses the existing native unknown-result boundary.
 f.control.nativeResponder=undefined;
 const nativeResponse=await work.response.catch(()=>null);
 if(nativeResponse)await nativeResponse.body?.cancel().catch(()=>{});
 await wait(()=>f.shared.db.prepare('SELECT state FROM shared_native_requests WHERE id=?').get(request.id).state==='unknown','native outcome unknown');
 await wait(()=>b.runtime.sessions.values(d).some(value=>value.request?.state==='review_required'),'remote authoritative review snapshot');
 assert.equal(f.calls(),1);assert.equal(Object.keys(b.runtime.execution.state.requests).length,0);assert.equal(f.store.metrics().journalRows,1);
 assert.equal(f.shared.db.prepare('SELECT state FROM shared_admissions WHERE id=?').get(work.record.accepted.id).state,'review_required');
});

test('actual native StreamHandler exposes separate member deltas before completion and reconnects without dispatch',async t=>{
 const g=await groupFixture(t,{two:true}),{f,a,b,descriptor}=g,d=descriptor(b),mapping=b.runtime.execution.mapping(d),live=installNativeStreamResponder(f,t);
 await b.runtime.getExecutionStatus(d,{refresh:true});await wait(()=>b.runtime.sessions.topicObservers.get(mapping.sharedId)?.ready,'native stream observer');
 const first=await nativeStart(g,'l2-native-two-speakers',{stream:true}),workId=first.record.accepted.id,input=live.get(first.slot.id);
 sse(input,'成员一🌱',null,{reasoning_content:'PRIVATE_REASONING_NEVER_PREVIEWED'});
 await wait(()=>b.runtime.sessions.values(d).some(work=>work.nativeBodies?.some(body=>body.nativeRequestId===first.slot.id&&body.text==='成员一🌱')),'first member live parsed body');
 assert.equal(f.calls(),1);assert.equal(f.store.metrics().journalRows,1);
 const query={sharedSpaceId:'sharedAB',sharedId:g.topic.id,executionId:workId};
 const snapshot=f.shared.events.snapshot(f.actor('B'),query);assert.doesNotMatch(JSON.stringify(snapshot),/PRIVATE_REASONING/);assert.equal(snapshot.nativeBodies.length,1);
 const topicEntry=b.runtime.sessions.topicObservers.get(mapping.sharedId);topicEntry.controller.abort();for(const entry of b.runtime.sessions.observers.values())entry.controller.abort();
 await wait(()=>!b.runtime.sessions.topicObservers.has(mapping.sharedId)&&!b.runtime.sessions.observers.size,'native observer disconnected');
 await b.runtime.getExecutionStatus(d,{refresh:true});await wait(()=>b.runtime.sessions.values(d).some(work=>work.nativeBodies?.[0]?.text==='成员一🌱'),'same first member prefix from authenticated snapshot');assert.equal(f.calls(),1);
 sse(input,'完成','stop');input.end('data: [DONE]\n\n');const firstResponse=await first.response;assert.equal(firstResponse.status,200);await firstResponse.text();
 await a.runtime.execution.groupReply(first.record,{id:'reply_'+first.slot.id,role:'assistant',agentId:a.runtime.localFor(first.slot.memberId).localId,content:'成员一🌱完成',timestamp:2});
 const member=first.record.accepted.turn.plan[1],slot=a.runtime.execution.groupStep(first.record,member),body={model:'synthetic',stream:true,requestId:slot.id,messages:[{role:'user',content:'synthetic second speaker'}],vcpchatExtensions:{requestContext:{ownerType:'group',agentId:a.runtime.localFor(member).localId,groupId:descriptor(a).itemId,topicId:descriptor(a).topicId}}};
 const native=await a.runtime.execution.prepareGroupNative(first.record,member,body),secondResponse=fetch(f.url+'/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json',...native.headers},body:JSON.stringify(native.body)});secondResponse.catch(()=>{});
 await wait(()=>live.has(slot.id),'second native member handler');const secondInput=live.get(slot.id);sse(secondInput,'成员二独立');
 await wait(()=>b.runtime.sessions.values(d).some(work=>work.nativeBodies?.length===2&&work.nativeBodies[0].text==='成员一🌱完成'&&work.nativeBodies[1].text==='成员二独立'),'two independently identified member bodies');
 assert.equal(f.calls(),2);assert.equal(Object.keys(b.runtime.execution.state.requests).length,0);assert.equal(f.store.metrics().journalRows,2);
 sse(secondInput,'结果','stop');secondInput.end('data: [DONE]\n\n');assert.equal((await secondResponse).status,200);await (await secondResponse).text();
 await a.runtime.execution.groupReply(first.record,{id:'reply_'+slot.id,role:'assistant',agentId:a.runtime.localFor(member).localId,content:'成员二独立结果',timestamp:3});await a.runtime.execution.groupDone(first.record);
 await wait(async()=>(await b.queue.readSerialized(d)).length===3,'native multi-member terminal Queue history');
 assert.deepEqual((await b.queue.readSerialized(d)).map(message=>message.content),['L2 synthetic native group input','成员一🌱完成','成员二独立结果']);assert.equal(f.calls(),2);assert.equal(f.store.metrics().journalRows,3);
});
test('native parsed content stops before the first markup marker while legacy unshared requests have no observation callback',async t=>{
 const g=await groupFixture(t),{f,b,descriptor}=g,d=descriptor(b),mapping=b.runtime.execution.mapping(d),live=installNativeStreamResponder(f,t);
 await b.runtime.getExecutionStatus(d,{refresh:true});await wait(()=>b.runtime.sessions.topicObservers.get(mapping.sharedId)?.ready,'redacted native observer');
 const work=await nativeStart(g,'l2-native-redacted',{stream:true}),input=live.get(work.slot.id);
 sse(input,'可见前缀');sse(input,'<');sse(input,'think>PRIVATE_INLINE_REASONING</think>');sse(input,'<<<[TOOL_REQUEST]>>>PRIVATE_TOOL_ARGUMENTS');
 await wait(()=>b.runtime.sessions.values(d).some(value=>value.nativeBodies?.[0]?.gap===true),'explicit native preview gap');
 const snapshot=f.shared.events.snapshot(f.actor('B'),{sharedSpaceId:'sharedAB',sharedId:g.topic.id,executionId:work.record.accepted.id});
 assert.equal(snapshot.nativeBodies[0].text,'可见前缀');assert.doesNotMatch(JSON.stringify(snapshot),/PRIVATE_|<think|TOOL_REQUEST/);assert.equal(f.calls(),1);
 sse(input,'','length');input.end('data: [DONE]\n\n');const response=await work.response;await response.text();
 // No action is retried when the temporary body deliberately stopped.
 assert.equal(Object.keys(b.runtime.execution.state.requests).length,0);assert.equal(f.calls(),1);
 const plain=await fetch(f.url+'/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'synthetic',stream:true,requestId:'unshared-observation-must-be-absent',messages:[]})});
 await wait(()=>live.has('unshared-observation-must-be-absent'),'unshared native handler');const plainInput=live.get('unshared-observation-must-be-absent');sse(plainInput,'normal unshared body','stop');plainInput.end('data: [DONE]\n\n');assert.equal(plain.status,200);assert.match(await plain.text(),/normal unshared body/);
 assert.equal(f.shared.events.streams.has('unshared-observation-must-be-absent'),false);
});
test('native observation shares a bounded work cache, rejects foreign children, and observer exceptions never affect native response',async t=>{
 const g=await groupFixture(t),{f}=g,live=installNativeStreamResponder(f,t),events=f.shared.events;
 const original=events.publishNative.bind(events);events.publishNative=()=>{throw Error('synthetic observer unavailable');};
 const work=await nativeStart(g,'l2-native-observer-failure',{stream:true}),input=live.get(work.slot.id);
 sse(input,'execution survives observer failure','stop');input.end('data: [DONE]\n\n');const response=await work.response;assert.equal(response.status,200);assert.match(await response.text(),/execution survives observer failure/);assert.equal(f.calls(),1);
 assert.equal(f.shared.db.prepare('SELECT state FROM shared_native_requests WHERE id=?').get(work.slot.id).state,'model_terminal');
 events.publishNative=original;
 const before=JSON.stringify(events.snapshot(f.actor('B'),{sharedSpaceId:'sharedAB',sharedId:g.topic.id,executionId:work.record.accepted.id}));
 assert.equal(events.publishNative(work.record.accepted.id,'foreign_native_request','native_delta','forged'),null);
 assert.equal(events.publishNative(work.record.accepted.id,work.slot.id,'native_delta','late-after-native-terminal'),null);
 assert.equal(JSON.stringify(events.snapshot(f.actor('B'),{sharedSpaceId:'sharedAB',sharedId:g.topic.id,executionId:work.record.accepted.id})),before);
});
test('all native speakers share one work byte budget rather than receiving a fresh budget per member',async t=>{
 const g=await groupFixture(t,{two:true}),{f,a,descriptor}=g,live=installNativeStreamResponder(f,t);f.shared.events.limits.maxBodyBytes=8;
 const first=await nativeStart(g,'l2-native-shared-budget',{stream:true}),firstInput=live.get(first.slot.id);
 sse(firstInput,'12345','stop');firstInput.end('data: [DONE]\n\n');await (await first.response).text();
 await a.runtime.execution.groupReply(first.record,{id:'reply_'+first.slot.id,role:'assistant',agentId:a.runtime.localFor(first.slot.memberId).localId,content:'12345',timestamp:2});
 const member=first.record.accepted.turn.plan[1],slot=a.runtime.execution.groupStep(first.record,member),body={model:'synthetic',stream:true,requestId:slot.id,messages:[{role:'user',content:'second budget member'}],vcpchatExtensions:{requestContext:{ownerType:'group',agentId:a.runtime.localFor(member).localId,groupId:descriptor(a).itemId,topicId:descriptor(a).topicId}}};
 const native=await a.runtime.execution.prepareGroupNative(first.record,member,body),pending=fetch(f.url+'/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json',...native.headers},body:JSON.stringify(native.body)});pending.catch(()=>{});
 await wait(()=>live.has(slot.id),'second budget native handler');const input=live.get(slot.id);sse(input,'abcde');
 const query={sharedSpaceId:'sharedAB',sharedId:g.topic.id,executionId:first.record.accepted.id};
 await wait(()=>f.shared.events.snapshot(f.actor('B'),query).nativeBodies[1]?.gap,'shared aggregate budget gap');
 const snapshot=f.shared.events.snapshot(f.actor('B'),query);assert.deepEqual(snapshot.nativeBodies.map(value=>[value.text,value.gap]),[['12345',false],['',true]]);
 assert.ok(snapshot.nativeBodies.reduce((n,value)=>n+Buffer.byteLength(value.text),0)<=8);assert.equal(f.shared.events.stream(first.record.accepted.id).nativeBytes,5);
 sse(input,'','stop');input.end('data: [DONE]\n\n');await (await pending).text();assert.equal(f.calls(),2);
});
test('evicting a disposable native preview cache never fabricates the lost prefix or repeats execution',async t=>{
 const g=await groupFixture(t),{f}=g,live=installNativeStreamResponder(f,t),work=await nativeStart(g,'l2-native-cache-evicted',{stream:true}),input=live.get(work.slot.id);
 sse(input,'original prefix');const query={sharedSpaceId:'sharedAB',sharedId:g.topic.id,executionId:work.record.accepted.id};
 await wait(()=>f.shared.events.snapshot(f.actor('B'),query).nativeBodies[0]?.text==='original prefix','initial native prefix');
 // No body observer is connected in this fixture; remove only disposable cache.
 assert.equal(f.shared.events.stream(work.record.accepted.id).listeners.size,0);f.shared.events.streams.delete(work.record.accepted.id);
 sse(input,'later fragment');await wait(()=>f.shared.events.snapshot(f.actor('B'),query).nativeBodies[0]?.gap,'lost cache is explicitly incomplete');
 const snapshot=f.shared.events.snapshot(f.actor('B'),query);assert.equal(snapshot.nativeBodies[0].text,'');assert.equal(snapshot.nativeBodies[0].gap,true);
 sse(input,'','stop');input.end('data: [DONE]\n\n');await (await work.response).text();assert.equal(f.calls(),1);assert.equal(f.store.metrics().journalRows,1);
});

test('a review snapshot finishing async validation cannot overwrite an explicit owner abandonment',async t=>{
 const f=await fixture(t),a=await f.desktop('A');f.portal.engine.startDelayMs=0;f.portal.engine.setEndpoint({url:f.url+'/v1/chat/completions',key:'synthetic-only'});f.control.holdHttp=true;
 const {SharedEventProjection}=await import(require('node:url').pathToFileURL(require('node:path').resolve(__dirname,'../../apps/desktop/modules/services/nativeSync/sharedEventClient.mjs')));
 const original=SharedEventProjection.prototype.apply;let release,entered=false,target;const gate=new Promise(resolve=>{release=resolve;});
 SharedEventProjection.prototype.apply=async function(event){const value=await original.call(this,event);if(event.type==='snapshot'&&event.executionId===target&&event.request?.state==='review_required'){entered=true;await gate;}return value;};
 t.after(()=>{release();SharedEventProjection.prototype.apply=original;});
 await a.runtime.getExecutionStatus(a.descriptor,{refresh:true});
 const message={id:'l2-review-abandon-race',role:'user',content:'synthetic review race',timestamp:1,attachments:[]},accepted=await a.runtime.prepareSharedSend({serverSession:true,descriptor:a.descriptor,message});target=accepted.admissionId;
 await wait(()=>f.calls()===1,'race native dispatch');f.heldResponse.destroy();await wait(()=>entered,'review snapshot awaiting validation completion');
 await a.runtime.abandonSharedSend({descriptor:a.descriptor,requestId:message.id,confirmed:true});
 const record=a.runtime.execution.state.requests[message.id];assert.equal(record.phase,'abandoned');assert.equal(record.accepted.state,'abandoned');release();
 await wait(()=>!a.runtime.sessions.observers.has(target),'stale review observer retired');
 assert.equal(record.phase,'abandoned');assert.equal(record.accepted.state,'abandoned');assert.equal(f.shared.db.prepare('SELECT state FROM shared_admissions WHERE id=?').get(target).state,'abandoned');assert.equal(f.calls(),1);
});

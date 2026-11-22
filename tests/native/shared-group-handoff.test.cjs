'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {fixture,wait,BOX,rejects} = require('./fixtures/sharedSingleHarness.cjs');
const {SharedSpace} = require(BOX+'/Plugin/NativeSync/sync/sharedSpace');
const {stable,sha256} = require(BOX+'/Plugin/NativeSync/sync/protocol');

const sharedSpaceId = 'sharedAB';
const mode = 'group-member-handoff-v1';

async function groupFixture(t) {
 const f = await fixture(t), {shared} = f;
 const actors = ['A','B'].map(x=>shared.desktop({sourceId:'source'+x,deviceId:'device'+x,spaceId:f.store.sourceCatalog.spaceId},'shared-space-v1,'+mode));
 const [a,b] = actors;
 const second = shared.create(a,{sharedSpaceId,opId:'handoff-member',kind:'agent',localId:'memberB',config:{name:'Member B',model:'synthetic',systemPrompt:'Second member'}}).object;
 const members = [f.owner.id,second.id];
 const owner = shared.create(a,{sharedSpaceId,opId:'handoff-group',kind:'group',localId:'handoffGroup',config:{name:'Handoff group',mode:'sequential',members}}).object;
 const topic = shared.create(a,{sharedSpaceId,opId:'handoff-topic',kind:'topic',parentId:owner.id,localParent:'handoffGroup',localId:'handoffTopic',config:{name:'Handoff topic'}}).object;
 const sharedId = topic.id;
 const context = shared.executionConfig(a,{sharedSpaceId,sharedId});
 const input = {sharedSpaceId,sharedId,requestId:'handoff-input',expectedHead:context.head,configHash:context.hash,controlMode:mode,message:{id:'handoff-user',role:'user',content:'Turn input',timestamp:1}};
 assert.throws(()=>shared.admit(f.actor('A'),input));
 const admitted = shared.admit(a,input), workId = admitted.id;
 const state = (actor=a)=>shared.workState(actor,{sharedSpaceId,workId}).request;
 const requestId = n=>'group_'+workId+'_'+n;
 const packet = n=>({
  model:'synthetic',requestId:requestId(n),messages:[
   {role:'user',content:'Turn input'},...(n?[{role:'assistant',content:'Member A answer'}]:[]),
  ],
  vcpchatExtensions:{
   requestContext:{ownerType:'group',topicId:topic.topic.topicId,agentId:members[n]},
   ...(n?{messageTimestampBindings:[{messageId:'reply_'+requestId(0),sentMessageIndex:1,role:'assistant',source:'client_history',timestamp:2,timestampIso:new Date(2).toISOString(),sentMessageHash:'sha256:'+sha256('Member A answer')}]}:{}),
  },
 });
 const prepare = (actor,n,body=packet(n))=>shared.prepareNative(actor,{sharedSpaceId,admissionId:workId,requestId:requestId(n),memberId:members[n],bodyHash:sha256(stable(body))});
 const enter = (actor,n,body=packet(n))=>shared.native.enter({
  method:'POST',body,
  headers:{
   'x-nativesync-admission':workId,'x-nativesync-source':actor.sourceId,'x-nativesync-device':actor.deviceId,
   'x-nativesync-space':f.store.sourceCatalog.spaceId,'x-nativesync-capabilities':'shared-space-v1,'+mode,
  },
 });
 const complete = (actor,n,fields={})=>shared.complete(actor,{sharedSpaceId,admissionId:workId,opId:'handoff-publish-'+n,nativeRequestId:requestId(n),
  message:{id:'reply_'+requestId(n),role:'assistant',agentId:members[n],content:n?'Member B answer':'Member A answer',timestamp:n+2,...fields},
 });
 const transition = (actor,action,values)=>shared[action==='group-handoff'?'groupHandoff':'groupContinue'](actor,{sharedSpaceId,workId,opId:action,...values});
 const version = actor=>({expectedExecutor:actor.principal,expectedExecutorVersion:actor===a?0:1});
 return {f,shared,a,b,sharedId,workId,state,requestId,packet,prepare,enter,complete,transition,version};
}

test('group handoff is fenced by the committed first reply, expected executor and explicit continuation',async t=>{
 const {f,shared,a,b,workId,state,packet,prepare,enter,complete,transition,version} = await groupFixture(t);
 assert.equal(state().groupHandoff.state,'first_member');
 assert.equal(f.store.db.prepare('SELECT MAX(version) AS version FROM shared_schema').get().version,3);
 assert.throws(()=>transition(b,'group-handoff',version(a)));
 assert.throws(()=>prepare(a,1));
 prepare(a,0);
 enter(a,0).finish(true);
 assert.throws(()=>prepare(a,1),'model terminal A by itself is not a published boundary');
 assert.throws(()=>complete(a,0,{finishReason:'interrupted'}),rejects('INVALID_SHARED_REPLY'));
 assert.throws(()=>complete(a,0,{interrupted:true}),rejects('INVALID_SHARED_REPLY'));
 assert.equal(f.store.metrics().journalRows,1);
 assert.equal(state().groupHandoff.state,'first_member');
 const published = complete(a,0,{finishReason:'length'});
 assert.equal(published.request.groupHandoff.state,'awaiting_handoff');
 assert.equal(published.request.groupHandoff.firstReplySeq,published.receipt.seq);
 assert.throws(()=>transition(a,'group-handoff',version(a)));
 assert.throws(()=>transition(b,'group-handoff',{...version(a),expectedExecutorVersion:12}));
 assert.throws(()=>transition({kind:'mobile',spaceId:sharedSpaceId,principal:'mobile:reader',permissions:['read']},'group-handoff',version(a)),rejects('SHARED_PERMISSION_REQUIRED'));
 new SharedSpace(f.store);
 await f.reopenBackend();
 assert.equal(state(b).groupHandoff.state,'awaiting_handoff');
 assert.equal(transition(b,'group-handoff',version(a)).request.groupHandoff.state,'awaiting_continue');
 assert.equal(transition(b,'group-handoff',version(a)).replayed,true);
 assert.throws(()=>prepare(b,1));
 assert.throws(()=>transition(a,'group-continue',version(b)));
 assert.equal(transition(b,'group-continue',version(b)).request.groupHandoff.state,'continuing');
 assert.equal(transition(b,'group-continue',version(b)).replayed,true);
 assert.throws(()=>prepare(a,1));
 const body = packet(1);
 body.messages.push({...body.messages[1]});
 body.vcpchatExtensions.messageTimestampBindings.push({
  ...body.vcpchatExtensions.messageTimestampBindings[0],messageId:'a-different-historical-message',sentMessageIndex:2,
 });
 prepare(b,1,body);
 const native = enter(b,1,body);
 assert.equal(native.textOnly,true);
 assert.equal(native.sponsorAuthority,null);
 assert.throws(()=>native.bridge.onToolDispatch({pluginName:'Synthetic'}),rejects('CONTROLLED_TEXT_TOOLS_FORBIDDEN'));
 assert.throws(()=>enter(b,1,body));
 native.finish(true);
 complete(b,1);
 assert.equal(shared.complete(b,{sharedSpaceId,admissionId:workId,opId:'handoff-finish',finish:true}).request.state,'completed');
 assert.deepEqual(state(b).nativeRequests.map(row=>row.state),['model_terminal','model_terminal']);
 assert.equal(f.store.metrics().journalRows,3);
});

test('already dispatched second member becomes unknown after restart and stays fenced',async t=>{
 const {f,a,b,state,prepare,enter,complete,transition,version} = await groupFixture(t);
 prepare(a,0);
 enter(a,0).finish(true);
 complete(a,0);
 transition(b,'group-handoff',version(a));
 transition(b,'group-continue',version(b));
 prepare(b,1);
 enter(b,1);
 new SharedSpace(f.store);
 await f.reopenBackend();
 await wait(()=>state(b).groupHandoff.state==='review_required','recovered group Work review');
 assert.deepEqual(state(b).nativeRequests.map(row=>row.state),['model_terminal','unknown']);
 assert.throws(()=>prepare(b,1));
 assert.throws(()=>enter(b,1));
 assert.equal(f.store.metrics().journalRows,2);
});


test('rejects invalid first-reply bindings before the second member can dispatch',async t=>{
 const cases={
  'wrong message ID':(bindings)=>{bindings[0].messageId='wrong-first-reply';},
  'duplicate message ID':(bindings,body)=>{
   body.messages.push({...body.messages[1]});
   bindings.push({...bindings[0],sentMessageIndex:2});
  },
  'duplicate packet index':(bindings,body)=>{
   body.messages.push({...body.messages[1]});
   bindings.push({...bindings[0],messageId:'wrong-first-reply'});
  },
  'wrong canonical timestamp':(bindings)=>{bindings[0].timestamp=4;bindings[0].timestampIso=new Date(4).toISOString();},
  'mismatched timestamp ISO':(bindings)=>{bindings[0].timestampIso=new Date(8).toISOString();},
  'wrong role':(bindings)=>{bindings[0].role='user';},
  'wrong source':(bindings)=>{bindings[0].source='client';},
  'wrong payload hash':(bindings)=>{bindings[0].sentMessageHash='sha256:'+sha256('modified');},
 };
 for(const [name,mutate] of Object.entries(cases))await t.test(name,async t=>{
  const {f,a,b,state,packet,prepare,enter,complete,transition,version} = await groupFixture(t);
  prepare(a,0);
  enter(a,0).finish(true);
  complete(a,0);
  transition(b,'group-handoff',version(a));
  transition(b,'group-continue',version(b));
  const body = packet(1);
  mutate(body.vcpchatExtensions.messageTimestampBindings,body);
  prepare(b,1,body);
  assert.throws(()=>enter(b,1,body),rejects('SHARED_GROUP_HANDOFF_CONTEXT_CHANGED'));
  assert.deepEqual(state(b).nativeRequests.map(row=>row.state),['model_terminal','prepared']);
  assert.equal(f.store.metrics().journalRows,2);
 });
});

test('the recipient continues the saved plan after the group changes its order', async t => {
 const {shared,a,b,sharedId,workId,state,prepare,enter,complete,transition,version} = await groupFixture(t);
 const original = state();
 const config = shared.requestConfig(a,{sharedSpaceId,admissionId:workId}).config;
 prepare(a,0);
 enter(a,0).finish(true);
 complete(a,0);
 const owner = config.owner;
 const reversed = original.turn.plan.slice().reverse();
 shared.saveConfig(a,{
  sharedSpaceId, sharedId:owner.id, opId:'reorder-future-turns', expectedVersion:owner.version,
  config:{...owner.config, members:reversed, sequentialSpeakerOrder:reversed},
 });
 assert.deepEqual(shared.executionConfig(a,{sharedSpaceId,sharedId}).owner.config.members,reversed);
 transition(b,'group-handoff',version(a));
 assert.deepEqual(state(b).turn.plan,original.turn.plan);
 assert.deepEqual(shared.requestConfig(b,{sharedSpaceId,admissionId:workId}).config,config);
 transition(b,'group-continue',version(b));
 prepare(b,1);
 enter(b,1).finish(true);
 complete(b,1);
 assert.equal(shared.complete(b,{sharedSpaceId,admissionId:workId,opId:'finish-frozen-plan',finish:true}).request.state,'completed');
});

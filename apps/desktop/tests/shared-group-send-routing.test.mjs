import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const source = fs.readFileSync(new URL('../modules/chatManager.js', import.meta.url), 'utf8');
const start = source.indexOf('        let sendAuthority;', source.indexOf('async function handleSendMessage('));
const end = source.indexOf('        // --- Standard Agent Message Sending ---', start);
assert.ok(start > 0 && end > start);
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const run = new AsyncFunction('itemType', 'request', `
 const calls=[], errors=[];
 const currentSelectedItem={id:'synthetic-owner',type:itemType};const currentTopicId='synthetic-topic';
 const sendContext={itemType,agentId:currentSelectedItem.id,topicId:currentTopicId};
 const executionAuthority=async()=>({kind:'shared'});
 const electronAPI={prepareSharedSend(){throw Error('Renderer must not create a second group admission');}};
 const uiHelper={showToastNotification:message=>errors.push(message),openModal(){}};
 const isSendContextCurrent=()=>true;
 const globalSettings={vcpServerUrl:'http://127.0.0.1:18445',userName:'Synthetic'};
 const groupRenderer={handleSendGroupMessage:async(...args)=>calls.push(args)};
 const setNextUiEmptyStateActive=()=>{};const content='synthetic draft';const attachedFiles=[];
 async function preflight(){${source.slice(start,end)}return 'agent';}
 try{return {result:await preflight(),calls,errors};}catch(e){return {code:e.code,calls,errors};}
`);
test('ordinary shared Group send routes to the original renderer; its native backend owns admission', async () => {
 const value=await run('group',null);assert.equal(value.calls.length,1);assert.equal(value.errors.length,0);
 assert.equal(value.calls[0][0],'synthetic-owner');assert.equal(value.calls[0][1],'synthetic-topic');assert.equal(value.calls[0][2].text,'synthetic draft');
});
test('ordinary shared Agent send retains the agent admission path',async()=>{
 const value=await run('agent',null);assert.equal(value.result,'agent');assert.equal(value.calls.length,0);
});
for(const [kind,request] of [['group',{conversation:{},propagateError:true}],['group',{checkpointMessageId:'checkpoint',propagateError:true}],['agent',{checkpointMessageId:'checkpoint',propagateError:true}],['unexpected',{propagateError:true}]])test('unsupported local advancement stays fenced: '+kind+' '+JSON.stringify(request),async()=>{
 const value=await run(kind,request);assert.equal(value.code,'SHARED_LOCAL_ADVANCE_UNSUPPORTED');assert.equal(value.calls.length,0);
});

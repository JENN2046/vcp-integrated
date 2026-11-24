'use strict';

const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {contract}=require('../../integration/service.cjs');
module.exports=async ({clients:{A,B},out,result,service,picture,click,evalJs,waitUntil,start,stop,trace})=>{
 const db=new DatabaseSync(path.join(service.data,'central.sqlite'),{readOnly:true});
 const mode=process.env.NS_FIRST_SEND_MODE;
 const subject='preSubmit';
 const d=service.descriptors.A[subject];
 const sharedId=service.topics[subject].id;
 const history=()=>JSON.parse(fs.readFileSync(path.join(out,'profile-A/UserData',d.itemId,'topics',d.topicId,'history.json'),'utf8'));
 const journal=()=>db.prepare('SELECT seq,msg_id,action FROM journal WHERE topic_id=? ORDER BY seq').all(sharedId);
 const jobs=()=>db.prepare('SELECT id,request_id,state,attempts,user_message_id,reply_message_id FROM mobile_executions WHERE topic_key=? ORDER BY rowid').all(sharedId);
 const selection=c=>evalJs(c,'window.VCPStateChannels.get("conversation.current").get()');
 async function select(c){
    const before=await selection(c);trace('before-selection',before);
    await waitUntil(async()=> (await selection(c)).itemId===d.itemId,'default synthetic agent');
    await waitUntil(async()=> (await selection(c)).topicId===d.topicId,'default shared topic auto-selected');
 }
 const content='Synthetic default cold first click.';
 const collect=c=>evalJs(c,`({input:document.querySelector('#messageInput').value,reason:[...document.querySelectorAll('[role=alert],.toast-notification,.toast,#toast-notification')].map(x=>x.innerText),body:document.body.innerText})`);
 try{
   assert.deepEqual({journal:journal(),jobs:jobs(),history:history()},{journal:[],jobs:[],history:[]});
   result.coverage = db.prepare('SELECT seq,topic_id,msg_id FROM journal ORDER BY seq').all();
   {
      assert.equal(result.coverage.length,1);
      assert.notEqual(result.coverage[0].topic_id,sharedId);
      const readState=file=>JSON.parse(fs.readFileSync(path.join(out,'seed/desktopA/.native-sync/shared/sharedAB',file),'utf8'));
      result.priorTopicCoverage={baselineWatermark:readState('registry.json').baselines[sharedId].remote.watermark,topicCursor:readState('messages.json').topicCursors[sharedId]};
      assert.deepEqual(result.priorTopicCoverage,{baselineWatermark:result.coverage[0].seq,topicCursor:result.coverage[0].seq});
   }
   await select(A);
   await evalJs(A,`(()=>{const x=document.querySelector('#messageInput');x.focus();x.value=${JSON.stringify(content)};x.dispatchEvent(new Event('input',{bubbles:true}))})()`);
   await click(A,'#sendMessageBtn');
   const ipc=await waitUntil(()=>A.events.find(e=>e.event==='first-send-ipc'&&e.data.serverSession),'server session IPC');
   const outcome=await waitUntil(()=>A.events.filter(e=>e.event==='ipc-result'&&e.data.channel==='native-sync:prepare-send')[1],'server session result');
   result.firstSend={id:ipc.data.id,descriptor:d,sharedId,outcome,ipc:A.events.filter(e=>e.event==='first-send-ipc'&&e.data.id===ipc.data.id)};
   assert.equal(result.firstSend.ipc.filter(e=>e.data.localOnly).length,1);
   assert.equal(outcome.data.success,mode==='fixed');
   if(outcome.data.success===false){
     assert.equal(outcome.data.error,mode==='baseline'?'SHARED_CONTEXT_CHANGED':'SHARED_CONFIG_CONFLICT');
     const reasonMatches = ui => mode==='baseline'||ui.body.includes('共享配置有冲突，请确认模型或配置后重试。');
     const inputFile=path.join(out,'profile-A','.native-sync','shared','sharedAB','local-inputs.json');
     const ledgerRow=()=>JSON.parse(fs.readFileSync(inputFile)).localInputs[ipc.data.id];
     result.firstSend.savedInput=ledgerRow();
     assert.equal(result.firstSend.savedInput.message.id,ipc.data.id);
     assert.equal(result.firstSend.savedInput.message.content,content);
     result.firstSend.ui=await waitUntil(async()=>{const ui=await collect(A);return ui.body.includes('消息已保存在本机')&&reasonMatches(ui)&&ui;},'retained first input with visible refusal');
     await picture(A,'send-rejected');
     await stop('A');
     const reopened=await start('A-reopened','A');
     await select(reopened);
     if (mode==='rejection') result.firstSend.reopen=await waitUntil(async()=>{const ui=await collect(reopened);return reasonMatches(ui)&&(ui.body.includes(content)||ui.input===content)&&ui;},'reopened first input and reason');
     else result.firstSend.reopen=await collect(reopened);
     assert.deepEqual(ledgerRow(),result.firstSend.savedInput);
     assert.deepEqual({journal:journal(),jobs:jobs(),history:history()},{journal:[],jobs:[],history:[]});
     assert.equal(service.requests.filter(x=>x.route.endsWith('/session-send')&&x.body?.requestId===ipc.data.id).length,0);
     assert.equal(service.calls.length,0);
     if(mode==='rejection'){
       fs.writeFileSync(path.join(out,'allow-first-send-context'),'allow');
       await click(reopened,'button','按原编号重试提交');
       await waitUntil(()=>jobs().length===1&&jobs()[0].state==='completed'&&history().length===2,'explicit retry completes original request');
       const retryPosts=service.requests.filter(x=>x.route.endsWith('/session-send'));
       result.firstSend.explicitRetry={jobs:jobs(),journal:journal(),requests:retryPosts.map(x=>({id:x.body?.requestId,status:x.status})),calls:service.calls.length};
       assert.equal(retryPosts.length,1);
       assert.equal(retryPosts[0].body.requestId,ipc.data.id);
       assert.equal(service.calls.length,1);
       assert.equal(jobs()[0].attempts,1);
       assert.equal(history()[0].id,ipc.data.id);
     }
   }else{
     await waitUntil(()=>jobs().length===1&&jobs()[0].state==='completed'&&history().length===2,'one complete server turn and physical History');
     result.firstSend.ui=await waitUntil(async()=>{const ui=await collect(A);return ui.body.includes(contract.completeText)&&!ui.body.includes('正在恢复本机记录')&&ui;},'reply and settled recovery indicator visible');
     await picture(A,'first-click-completed');
     result.firstSend.journal=journal();result.firstSend.jobs=jobs();result.firstSend.history=history().map(m=>({id:m.id,role:m.role}));
     assert.equal(result.firstSend.jobs[0].attempts,1);
     assert.equal(result.firstSend.jobs[0].request_id,ipc.data.id);
     assert.deepEqual(result.firstSend.history.map(m=>m.id),result.firstSend.journal.map(m=>m.msg_id));
     assert.equal(service.calls.length,1);
     assert.equal(service.requests.filter(x=>x.route.endsWith('/session-send')&&x.body?.requestId===ipc.data.id).length,1);
     const b=service.descriptors.B[subject];
     const bHistory=()=>JSON.parse(fs.readFileSync(path.join(out,'profile-B/UserData',b.itemId,'topics',b.topicId,'history.json'),'utf8'));
     await waitUntil(()=>bHistory().length===2,'other desktop has same History');
     result.firstSend.observerHistory=bHistory().map(m=>({id:m.id,role:m.role}));
     assert.deepEqual(result.firstSend.observerHistory,result.firstSend.history);
     await stop('A');
     const reopened=await start('A-reopened','A');
     await select(reopened);
     result.firstSend.reopen=await waitUntil(async()=>{const ui=await collect(reopened);return ui.body.includes(contract.completeText)&&ui;},'original reply still displayed after reopen');
     assert.deepEqual(history().map(m=>m.id),result.firstSend.journal.map(m=>m.msg_id));
     assert.deepEqual(jobs(),result.firstSend.jobs);
     const old=db.prepare('SELECT seq,topic_id,msg_id FROM journal WHERE topic_id<>? ORDER BY seq').all(sharedId);
     assert.deepEqual(old,result.coverage);
     if(result.priorTopicCoverage){
       const registry=JSON.parse(fs.readFileSync(path.join(out,'profile-A/.native-sync/shared/sharedAB/registry.json'),'utf8'));
       result.remainingBaselineWatermark=registry.baselines[sharedId].remote.watermark;
       assert.equal(result.remainingBaselineWatermark,result.priorTopicCoverage.baselineWatermark);
     }
     const localStart=A.events.find(e=>e.event==='first-send-stageLocal:start'&&e.data.id===ipc.data.id).t;
     const local=A.events.find(e=>e.event==='first-send-stageLocal:end'&&e.data.id===ipc.data.id).t;
     const enter=A.events.find(e=>e.event==='first-send-prepare:start'&&e.data.id===ipc.data.id).t;
     result.firstSend.durationsMs={stageLocal:local-localStart,localSavedToSessionEntry:enter-local,localSavedToProvider:service.calls[0].at-local};

     assert.equal(service.calls.length,1);
     assert.equal(service.requests.filter(x=>x.route.endsWith('/session-send')&&x.body?.requestId===ipc.data.id).length,1);
   }
 }finally{db.close();}
};

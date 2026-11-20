'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {contract}=require('./service.cjs');
const names={preSubmit:'Synthetic shared',lostAck:'Synthetic lost receipt',interrupted:'Synthetic interrupted single'};
module.exports=async ({clients:{A,B},out,result,service,picture,click,evalJs,waitUntil,start,stop,sha})=>{
 const db=new DatabaseSync(path.join(service.data,'central.sqlite'),{readOnly:true});
 const j=JSON.stringify, send='#sendMessageBtn';
 const history=(role,subject)=>{
  const {itemId,topicId}=service.descriptors[role][subject];
  const file=path.join(out,'profile-'+role,'UserData',itemId,'topics',topicId,'history.json');
  return fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):[];
 };
 const journal=subject=>db.prepare('SELECT seq,msg_id,action,device_id,message_json FROM journal WHERE topic_id=? ORDER BY seq')
  .all(service.topics[subject].id).map(({message_json,...row})=>({...row,message:JSON.parse(message_json)}));
 const jobs=subject=>db.prepare('SELECT id,request_id,topic_key,state,attempts,request_dispatched,cancel_requested,error_code,user_message_id,user_seq,reply_message_id FROM mobile_executions WHERE topic_key=? ORDER BY rowid').all(service.topics[subject].id);
 const native=id=>db.prepare('SELECT id,admission_id,state FROM shared_native_requests WHERE admission_id=? ORDER BY ordinal').all(id);
 const posts=subject=>service.requests.filter(row=>row.route.endsWith('/session-send')&&row.body?.message?.content===contract.cases[subject]);
 const calls=subject=>service.calls.filter(row=>row.case===subject);
 const doc=c=>evalJs(c,'document.body.innerText');
 const messageArea=c=>evalJs(c,'document.querySelector("#chatMessages")?.innerText||""');
 const composer=c=>evalJs(c,`(()=>{const b=document.querySelector('#sendMessageBtn');return {mode:b?.dataset.composerMode||b?.dataset.mode,label:b?.getAttribute('aria-label'),disabled:b?.disabled,text:document.querySelector('#messageInput')?.value}})()`);
 const selection=c=>evalJs(c,'window.VCPStateChannels.get("conversation.current").get()');
 async function select(c,role,subject){
    const d=service.descriptors[role][subject];
    if (!await evalJs(c,"document.querySelector('#tabContentAgents').classList.contains('active')")) await click(c,'.sidebar-tab-button[data-tab="agents"]');
    await click(c,'#agentList > li .agent-name',names[subject]);
    await waitUntil(async()=> (await selection(c)).itemId===d.itemId,'agent '+names[subject]);
    await click(c,'.sidebar-tab-button[data-tab="topics"]');
    if((await selection(c)).topicId!==d.topicId) await click(c,'#topicList [data-topic-id="'+d.topicId+'"] .topic-title-display');
    await waitUntil(async()=> (await selection(c)).topicId===d.topicId,'selected '+subject);
    await waitUntil(async()=> (await evalJs(c,'window.chatAPI.getNativeDeletionContext('+j(d)+')'))?.kind==='shared','shared '+subject);
 }
 async function enter(c,content){
    await evalJs(c,`(()=>{const x=document.querySelector('#messageInput');x.focus();x.value=${j(content)};x.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
    await waitUntil(async()=>!(await composer(c)).disabled,'native send enabled');
    await click(c,send);
 }
 function localLedger(id){
   const dir=path.join(out,'profile-A','.native-sync','shared','sharedAB');
   const side=path.join(dir,'session-records',require('node:crypto').createHash('sha256').update(id).digest('hex')+'.json');
   const file=path.join(dir,'executions.json');
   const v=fs.existsSync(side)?JSON.parse(fs.readFileSync(side,'utf8')).record:fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')).requests?.[id]:null;
   if(!v)return null;
   return {phase:v.phase,rejected:v.rejected,bodyId:v.body?.requestId,admitStarted:v.admitStarted,acceptedId:v.accepted?.id,content:v.localMessage?.content,projectionPending:v.serverProjectionPending};
 }
 function proveSources(c){
    return c.command('loaded-sources',{
     main:['apps/desktop/modules/ipc/chatHandlers.js','apps/desktop/modules/services/nativeSync/sharedSessionClient.js','apps/desktop/modules/services/topicExecutionAuthority.js'],
     renderer:['apps/desktop/modules/renderer/mainChatSendOwner.js','apps/desktop/modules/renderer/nativeExecutionStatus.js','apps/desktop/modules/event-listeners.js'],
    });
 }
 try {
  result.initial=Object.fromEntries(Object.keys(names).map(k=>[k,{journal:journal(k),jobs:jobs(k),A:history('A',k),B:history('B',k)}]));
  assert.ok(Object.values(result.initial).every(x=>Object.values(x).every(v=>v.length===0)));
  result.loaded=await proveSources(A);
  for(const level of ['main','renderer']) {
    assert.equal(result.loaded[level].length,result.mode==='local-only'&&level==='main'?2:3);
    for(const x of result.loaded[level])assert.equal(x.sha256,sha(path.join(result.candidate,x.file)),x.file);
  }
  if(result.mode==='local-only'){
    service.releaseLost();
    await click(A,'#agentList > li .agent-name','Synthetic local');
    await waitUntil(async()=>(await selection(A)).topicId==='local-topic','ordinary local topic selected');
    await enter(A,contract.cases.lostAck);
    const file=path.join(out,'profile-A/UserData/local-agent/topics/local-topic/history.json');
    const rows=await waitUntil(()=>{const rows=JSON.parse(fs.readFileSync(file));return rows.length===2&&rows[1].content===contract.completeText&&rows;},'local pair in History');
    await waitUntil(async()=>(await messageArea(A)).includes(contract.completeText),'local reply painted');
    await picture(A,'local-complete');
    result.local={history:rows,provider:calls('lostAck').length,localPosts:service.requests.filter(x=>x.route==='/v1/local-chat/completions').length,sharedPosts:posts('lostAck').length,workCount:db.prepare('SELECT count(*) n FROM mobile_executions').get().n,journalCount:db.prepare('SELECT count(*) n FROM journal').get().n};
    assert.equal(result.local.provider,1);assert.equal(result.local.localPosts,1);assert.equal(result.local.sharedPosts,0);assert.equal(result.local.workCount,0);assert.equal(result.local.journalCount,0);
    return;
  }
  if(result.mode==='pre-only'){
  await select(A,'A','preSubmit');
  await enter(A,contract.cases.preSubmit);
  const refused=await waitUntil(()=>posts('preSubmit').find(r=>r.status===409),'known refusal before forward');
  const preState=await waitUntil(async()=>{
    const input=await composer(A),ledger=localLedger(refused.body.requestId),text=await doc(A);
    return ledger?.content===contract.cases.preSubmit&&ledger.phase==='local_pending'&&input.mode==='send'&&text.includes(contract.cases.preSubmit)&&{input,ledger,showsTyped:true};
  },'pre-submit draft or persisted UI body');
  assert.equal(refused.injected,true);
  assert.equal(calls('preSubmit').length,0);
  assert.deepEqual(journal('preSubmit'),[]);
  assert.deepEqual(jobs('preSubmit'),[]);
  assert.deepEqual(history('A','preSubmit'),[]);
  result.preSubmit={request:refused,preservation:preState,work:jobs('preSubmit'),journal:journal('preSubmit'),providerAttempts:calls('preSubmit').length};
  await picture(A,'single-pre-submit');
  await stop('A');
  const preReopened=await start('A-pre-reopened','A');
  await select(preReopened,'A','preSubmit');
  result.preSubmit.reopened=await waitUntil(async()=>{
    const input=await composer(preReopened),ledger=localLedger(refused.body.requestId),text=await doc(preReopened);
    return ledger?.content===contract.cases.preSubmit&&(text.includes(contract.cases.preSubmit)||input.text===contract.cases.preSubmit)&&{input,ledger,visible:text.includes(contract.cases.preSubmit)};
  },'reopened pre-submit body');
  assert.deepEqual(journal('preSubmit'),[]);
  assert.deepEqual(jobs('preSubmit'),[]);
  assert.equal(calls('preSubmit').length,0);
  return;
  }
  if(result.mode==='lost-only'){
  await select(A,'A','lostAck');
  await enter(A,contract.cases.lostAck);
  const lost=await waitUntil(()=>posts('lostAck').find(x=>x.dropped),'actual accepted response dropped');
  await waitUntil(()=>calls('lostAck').length===1,'original lost-receipt worker dispatched');
  const lostId=lost.body.requestId, work=lost.response.workId;
  const pending=await waitUntil(()=>{const row=localLedger(lostId);return row?.admitStarted&&!row.acceptedId&&row;},'durable unconfirmed local input');
  assert.equal(pending.bodyId,lostId);
  assert.equal(pending.content,contract.cases.lostAck);
  const seenFailure=await waitUntil(()=>A.events.find(x=>x.event==='ipc-result'&&x.data.channel==='native-sync:prepare-send'&&x.data.error==='NETWORK_UNAVAILABLE'),'transport loss reached real composer',12000);
  await picture(A,'single-lost-ack');
  await stop('A');
  service.disarmDrop();
  const A2=await start('A-reopened','A');
  assert.equal(result.A.profileDigest,result['A-reopened'].profileDigest);
  await select(A2,'A','lostAck');
  const recovered=await waitUntil(()=>{const row=localLedger(lostId);return row?.acceptedId===work&&row;},'reopened profile recovers original ID',18000);
  const recoveryGET=service.requests.find(r=>r.route.endsWith('/shared/request')&&r.query?.requestId===lostId&&!r.injected&&r.status===200);
  assert.ok(recoveryGET);
  service.releaseLost();
  await waitUntil(()=>jobs('lostAck').find(x=>x.id===work&&x.state==='completed'),'original lost receipt completed',20000);
  await waitUntil(async()=> (await messageArea(A2)).includes(contract.completeText),'A sees one recovered reply',16000);
  await select(B,'B','lostAck');
  await waitUntil(async()=> (await messageArea(B)).includes(contract.completeText),'B sees one recovered reply',16000);
  const received=journal('lostAck'), recoveredWork=jobs('lostAck');
  assert.equal(recoveredWork.length,1);
  assert.equal(recoveredWork[0].attempts,1);
  assert.equal(received.length,2);
  assert.equal(calls('lostAck').length,1);
  assert.equal(posts('lostAck').length,1);
  for(const role of ['A','B']) {
    await waitUntil(()=>history(role,'lostAck').length===2,'recovered persisted history '+role);
    assert.deepEqual(history(role,'lostAck').map(x=>x.id),received.map(x=>x.msg_id));
  }
  const desktopInput=A.events.filter(x=>x.event==='desktop-input').map(x=>x.data);
  const trail=id=>db.prepare('SELECT stage,request_id,work_id,at FROM shared_request_phases WHERE work_id=? ORDER BY at,rowid').all(id);
  const admission=id=>db.prepare('SELECT id,request_id,principal,state,dispatched,native_terminal FROM shared_admissions WHERE id=?').get(id);
  assert.ok(desktopInput.some(x=>x.id===lostId&&x.serverSession));
  result.original={desktopInput,phases:trail(work),admission:admission(work),A:history('A','lostAck'),B:history('B','lostAck')};
  result.lostAck={first:lost,seenFailure:seenFailure.data,pending,recovered,recoveryGET,work:recoveredWork,journal:received,native:native(work),providerAttempts:1};
  await picture(B,'single-recovered');
  await enter(A2,contract.cases.lostAck);
  await waitUntil(()=>jobs('lostAck').length===2&&jobs('lostAck').every(w=>w.state==='completed'),'explicit second send completes');
  const second=posts('lostAck')[1];
  assert.notEqual(second.body.requestId,lostId); assert.notEqual(second.response.workId,work);
  await waitUntil(()=>['A','B'].every(role=>history(role,'lostAck').length===4),'two independent turns project');
  result.newSend={requestId:second.body.requestId,workId:second.response.workId,totalProvider:calls('lostAck').length,totalPosts:posts('lostAck').length,journalIds:journal('lostAck').map(x=>x.msg_id)};
  return;
  }
  const A2=A;
  await select(A2,'A','interrupted');
  await enter(A2,contract.cases.interrupted);
  const partialRequest=await waitUntil(()=>posts('interrupted').find(r=>r.status===200),'partial work admitted');
  const stopWork=partialRequest.response.workId;
  await waitUntil(async()=> (await messageArea(A2)).includes(contract.partialText),'actual nonempty partial rendered',20000);
  const active=await composer(A2);
  assert.ok(!active.disabled&&(/停|中断/.test(active.label||'')||active.mode==='interrupt'));
  assert.equal(calls('interrupted').length,1);
  await picture(A2,'single-partial-live');
  assert.equal(result.mode, 'transport-only');
    service.cutPartial();
    await waitUntil(()=>service.gates.partialClosed,'provider closed after nonempty prefix',12000);
    const work=await waitUntil(()=>jobs('interrupted').find(w=>w.id===stopWork&&w.state === 'review_required'),'terminal state after provider TCP cut',25000);
    const capture=async c=>({ui:{partialShown:(await messageArea(c)).includes(contract.partialText),
        finalShown:(await messageArea(c)).includes(contract.completeText),reviewShown:/核对|中断/.test(await doc(c)),composer:await composer(c)},
        ledger:localLedger(partialRequest.body.requestId),work:jobs('interrupted'),native:native(stopWork),journal:journal('interrupted'),history:history('A','interrupted')});
    await waitUntil(async()=>/发送/.test((await composer(A2)).label||''),'native terminal composer after provider cut',15000);
    const afterCut=await capture(A2);
    await picture(A2,'single-socket-cut-terminal');
    await stop('A');
    const reopened=await start('A-final','A');
    await select(reopened,'A','interrupted');
    await waitUntil(async()=> (await messageArea(reopened)).includes(contract.cases.interrupted),'native input survives cut and reopen');
    await new Promise(r=>setTimeout(r,1200));
    const reopenedState=await capture(reopened);
    await picture(reopened,'single-socket-cut-reopened');
    const counts={sessionPosts:posts('interrupted').length,cancelPosts:service.requests.filter(x=>x.route.endsWith('/session-cancel')).length,providerAttempts:calls('interrupted').length};
    result.transportInterrupt={workId:work.id,beforeCut:active,afterCut,reopened:reopenedState,gates:service.gates,
       providerTranscript:calls('interrupted'),counts};
    assert.ok(service.gates.providerTransportCut);
    assert.equal(counts.sessionPosts,1);
    assert.equal(counts.cancelPosts,0);
    assert.ok(calls('interrupted').every(x=>x.providerFrames.length===1&&x.providerFrames[0].type==='delta'));
    assert.deepEqual(afterCut.journal,reopenedState.journal);
    assert.deepEqual(afterCut.work,reopenedState.work);
    assert.deepEqual(afterCut.native,reopenedState.native);
    assert.deepEqual(afterCut.history,reopenedState.history);
    assert.equal(counts.providerAttempts, 1);
    assert.equal(work.state, 'review_required');
    assert.equal(work.error_code, 'MODEL_STREAM_ERROR_REVIEW_REQUIRED');
    assert.equal(work.reply_message_id, null);
    assert.equal(afterCut.ledger.phase, 'review_required');
    assert.deepEqual(reopenedState.ledger, afterCut.ledger);
    for (const state of [afterCut, reopenedState]) {
        assert.equal(state.ui.partialShown, true);
        assert.equal(state.ui.finalShown, false);
        assert.equal(state.ui.reviewShown, true);
        assert.equal(state.ui.composer.disabled, false);
    }
    assert.deepEqual(afterCut.journal.map(row => row.message.role), ['user']);
    assert.deepEqual(afterCut.history.map(row => row.role), ['user']);
 }finally{db.close();}
};

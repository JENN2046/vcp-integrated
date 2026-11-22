'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {fixture, BOX, ctx} = require('./fixtures/sharedSingleHarness.cjs');
const {sha256, stable} = require(BOX + '/Plugin/NativeSync/sync/protocol');
const {createDelegationContinuity} = require(BOX + '/Plugin/AgentAssistant/delegationContinuity');
const {createNativeContinuationStore} = require(BOX + '/modules/nativeContinuationStore.cjs');

async function workFixture(t) {
    const f = await fixture(t);
    t.after(() => fs.rmSync(f.root, {recursive:true,force:true}));
    const shared = f.shared, native = shared.native;
    const scope = {sharedSpaceId:'sharedAB',sharedId:f.topic.id};
    const alias = 'Approved delegate';
    const report = 'Verified synthetic native report';
    const capabilities = 'shared-space-v1,shared-context-v1,shared-steering-v1,shared-controlled-aa-v1';
    const actor = device => shared.desktop({
        sourceId:'source'+device,deviceId:'device'+device,spaceId:f.store.sourceCatalog.spaceId,
    },capabilities);
    const a = actor('A'), b = actor('B');
    const initial = shared.executionConfig(a,scope);
    const submission = {...scope, requestId:'aa-request', expectedHead:initial.head, configHash:initial.hash,
        controlMode:'agent-assistant-v1', delegation:{agentName:alias},
        message:{id:'aa-user',role:'user',content:'Sealed synthetic task',timestamp:1}};
    assert.throws(() => shared.admit(a,submission), {code:'CONTROLLED_TEXT_UNAVAILABLE'});
    shared.delegationAgents.add(alias);
    const archive = createDelegationContinuity(f.root);
    let archiveAvailable = false;
    let archiveReadFailure = null;
    const readArchive = (identity, includeResult) => {
        if (archiveReadFailure) throw archiveReadFailure;
        return archive.read(identity, {includeResult});
    };
    const provider = {
        read: identity => archiveAvailable ? readArchive(identity, identity.includeResult) :
            {...identity,state:'running',revision:0},
        readArchive: identity => readArchive(identity, true),
    };
    let unregister = ctx.registerNativeTaskProvider('AgentAssistant', provider);
    const stopProvider = () => unregister();
    const startProvider = () => { unregister = ctx.registerNativeTaskProvider('AgentAssistant', provider); };
    t.after(stopProvider);
    assert.throws(() => shared.admit(f.actor('A'),submission), {code:'CONTROLLED_TEXT_UNAVAILABLE'});
    assert.throws(() => shared.admit(a,{...submission,delegation:{agentName:alias,prompt:'spoofed'}}), {code:'INVALID_SHARED_AA_DELEGATION'});
    assert.throws(() => shared.admit(a,{...submission,delegation:{agentName:'Unapproved'}}), {code:'INVALID_SHARED_AA_DELEGATION'});
    native.continuations = createNativeContinuationStore(path.join(f.root,'native-continuations'));
    const accepted = shared.admit(a,submission);
    assert.equal(shared.admit(a,submission).id,accepted.id);
    assert.throws(() => shared.admit(a,{...submission,delegation:{agentName:'Unapproved'}}), {code:'REQUEST_ID_REUSED'});
    const workId=accepted.id;
    const generation = number => shared.steering.generation(workId,number);
    const parentRequestId = generation(0).request_id;
    const body = requestId => ({
        requestId,model:'synthetic',messages:[{role:'system',content:'fixture'},{role:'user',content:submission.message.content}],
        vcpchatExtensions:{requestContext:{ownerType:'agent',agentId:f.owner.id,topicId:shared.row(scope.sharedSpaceId,scope.sharedId).topic_id}},
    });
    const enter = (executor,number,packet) => {
        const step = generation(number);
        native.prepare(executor,{sharedSpaceId:scope.sharedSpaceId, admissionId:workId,requestId:step.request_id,
            generation:number,consumedInputSeq:0,bodyHash:sha256(stable(packet))});
        const entered = native.enter({body:packet,headers:{
            'x-nativesync-admission':workId,'x-nativesync-generation':String(number),'x-nativesync-consumed-input-seq':'0',
            'x-nativesync-source':executor.sourceId,'x-nativesync-device':executor.deviceId,
            'x-nativesync-space':f.store.sourceCatalog.spaceId,'x-nativesync-capabilities':capabilities,
        }});
        entered.applied();
        return entered;
    };
    const parent = enter(a,0,body(parentRequestId));
    assert.deepEqual(parent.delegation,{agentName:alias,prompt:submission.message.content});
    const names = ['AgentAssistant'];
    const call = {pluginName:names[0],nativeRequestId:parentRequestId,invocationId:'aa-call',recordId:'aa-record',
        batchNames:names,batchSize:1,batchOrdinal:0};
    parent.checkpoint.assistant('Delegating the task.\n<<<[TOOL_REQUEST]>>>\nprivate tool payload\n<<<[END_TOOL_REQUEST]>>>');
    parent.beginToolBatch(names);
    parent.bridge.onToolDispatch(call);
    const identity = {pluginName:call.pluginName,nativeRequestId:parentRequestId,invocationId:call.invocationId,
        recordId:call.recordId,nativeTaskId:'aa-delegation-1234-0123abcd',agentBaseName:'SyntheticDelegate'};
    parent.bridge.onTaskAccepted(identity);
    parent.bridge.onTaskObserved({...identity,state:'running',revision:0});
    const binding = native.taskRequests.binding(workId,identity,a);
    const childId = identity.nativeTaskId+'-round-1';
    const childBody = body(childId);
    const remove = binding.registerRequest(childBody,0);
    const child = native.taskRequests.enter({body:childBody},{admissionId:workId,identity,controlRevision:0,actor:a});
    t.after(() => { if (typeof remove === 'function') remove(); });
    assert.equal(child.textOnly,true);
    assert.throws(() => child.bridge.onToolDispatch({}), {code:'CONTROLLED_TEXT_TOOLS_FORBIDDEN'});
    child.checkpoint.assistant(report);
    const status = () => shared.workState(b,{sharedSpaceId:scope.sharedSpaceId,workId}).request;
    const handoffBody = {sharedSpaceId:scope.sharedSpaceId,workId,opId:'aa-handoff',expectedRevision:0,expectedGeneration:0,expectedExecutor:a.principal};
    const handoff = () => shared.steerHandoff(b,handoffBody);
    const http = async (route, payload) => {
        const response = await fetch(f.url+'/api/v1/sync/shared/'+route,{
            headers:{'content-type':'application/json','x-nativesync-source':b.sourceId,'x-nativesync-device':b.deviceId,
                'x-nativesync-space':f.store.sourceCatalog.spaceId,'x-nativesync-capabilities':capabilities},
            ...(payload?{method:'POST',body:JSON.stringify(payload)}:{}),
        });
        return {status:response.status,value:await response.json()};
    };
    const httpHandoff = () => http('steer-handoff',handoffBody);
    const httpReport = () => http('task-result?'+new URLSearchParams({
        sharedSpaceId:scope.sharedSpaceId, workId, nativeTaskId:identity.nativeTaskId,
    }));
    const prepareCompaction = (actor, opId='aa-compact') => shared.compactPrepare(actor,{...scope,opId,expectedHead:shared.executionConfig(actor,scope).head});
    const settleParent = () => {
        parent.checkpoint.result(call,'synthetic submission acknowledgement');
        parent.bridge.onToolSettled({...call,outcome:'returned'});
        assert.throws(() => parent.fence(), {code:'WORK_SAFE_TOOL_BOUNDARY'});
        return parent.settleToolPause();
    };
    const archiveRef = 'file/document/AgentTask/'+identity.agentBaseName+'_'+identity.nativeTaskId+'.md';
    const archivePath = path.join(f.root,archiveRef);
    const finishChild = ({project=true}={}) => {
        child.finish(true);
        binding.claimFinal(0);
        fs.mkdirSync(path.dirname(archivePath),{recursive:true});
        fs.writeFileSync(archivePath, '# 委托任务归档报告: '+identity.nativeTaskId+'\n\n## 最终执行结果\n\n'+report+'\n');
        const proof = archive.persist(identity,{nativeStatus:'Succeed',endTime:1,archivePath:archiveRef,report,controlRevision:0});
        archiveAvailable = true;
        if(project)parent.bridge.onTaskObserved(proof);
        return proof;
    };
    const reopen=async()=>{
        await f.reopenBackend();
        shared.native.continuations=native.continuations;
        await shared.native.engine.nativeTasks.reconcile(true);
    };
    const setArchiveReadFailure = error => { archiveReadFailure = error; };
    return {f,shared,scope,a,b,report,status,handoff,httpHandoff,httpReport,prepareCompaction,parentRequestId,workId,
        identity,archivePath,settleParent,finishChild,generation,enter,body,reopen,setArchiveReadFailure,stopProvider,startProvider};
}


function compactForContinuation(w, receipt) {
    const compact = w.prepareCompaction(w.b);
    const input = w.shared.compactInput(w.b,{...w.scope,id:compact.id});
    assert.equal(input.history.filter(message => message.content.includes(w.report)).length,1);
    assert.ok(input.history.some(message => message.content.includes(receipt.resultHash)));
    assert.ok(input.history.every(message => !message.content.includes('synthetic submission acknowledgement') &&
        !message.content.includes('private tool payload')));
    const summary = 'Checkpoint with the verified key finding';
    w.shared.compactCommit(w.b,{...w.scope,id:compact.id,opId:'aa-compact-commit',sourceHash:compact.sourceHash,
        message:{id:compact.messageId,role:'user',content:summary,timestamp:5,contextCompaction:{kind:'vchat-context-checkpoint',version:1,checkpoint:summary}}});
    const now = w.shared.steering.now;
    w.shared.steering.now = () => now() + 1000;
    const config = w.shared.executionConfig(w.b,w.scope);
    const prepare = () => w.shared.steerPrepare(w.b,{...w.scope,workId:w.workId,opId:'aa-prepare-continuation',
        expectedHead:config.head,configHash:config.hash,expectedRevision:0,expectedGeneration:0});
    return {compact, summary, prepare};
}

test('AA parent waits for the signed-off child, then B can hand off, compact and continue the same Work', async t => {
    const w = await workFixture(t);
    assert.equal(w.settleParent(),'awaiting_native_task');
    assert.equal(w.status().nativeTasks[0].nativeTaskId,w.identity.nativeTaskId);
    assert.equal(w.status().steering.delegationReceipt,undefined);
    assert.throws(w.handoff,{code:'WORK_SAFE_BOUNDARY_PENDING'});
    assert.throws(() => w.prepareCompaction(w.a),{code:'WORK_SAFE_BOUNDARY_PENDING'});
    const archiveProof=w.finishChild(),receipt=w.status().steering.delegationReceipt;
    assert.equal(receipt.kind,'AgentAssistantReport');
    assert.equal(receipt.resultHash,archiveProof.resultHash);
    assert.equal(receipt.archiveHash,archiveProof.archiveHash);
    assert.equal(receipt.nativeTaskId,w.identity.nativeTaskId);
    assert.equal(receipt.parentRequestId,w.parentRequestId);
    assert.equal(w.status().steering.applicationState,'awaiting_handoff');
    assert.equal(w.handoff().applicationState,'awaiting_compaction');
    assert.equal(w.handoff().replayed,true);
    const {compact, summary, prepare} = compactForContinuation(w, receipt);
    const preparation = prepare();
    const packet=w.body(preparation.requestId);
    packet.messages[1].content=summary;
    packet.vcpchatExtensions.messageTimestampBindings=[{messageId:compact.messageId,sentMessageIndex:1}];
    const continuation=w.enter(w.b,1,packet);
    assert.equal(continuation.textOnly,true);
    assert.equal(continuation.delegation,null);
    const effective=continuation.continuation(packet);
    assert.equal(effective.messages.filter(message=>message.content===summary).length,1);
    assert.ok(effective.messages.every(message=>!message.content.includes(w.report)));
    continuation.checkpoint.finalReply({content:'Text-only continuation',finishReason:'stop'});
    continuation.finish(true);
    assert.equal(w.status().state,'completed');
    assert.equal(w.status().nativeTasks.length,1);
    assert.equal(w.status().toolInvocations.length,1);
    assert.equal(w.status().steering.generations.length,2);
});

test('a child-first archive stays unavailable for handoff until native parent acknowledgement, and archive changes block reuse', async t => {
    const w = await workFixture(t);
    const archiveProof=w.finishChild();
    assert.equal(w.status().steering.delegationReceipt,undefined);
    assert.throws(w.handoff,{code:'WORK_SAFE_BOUNDARY_PENDING'});
    assert.equal(w.settleParent(),'paused');
    const receipt=w.status().steering.delegationReceipt;
    assert.equal(receipt.archiveHash,archiveProof.archiveHash);
    fs.appendFileSync(w.archivePath,'tampered');
    assert.throws(w.handoff,{code:'NATIVE_RESULT_HASH_MISMATCH'});
    assert.throws(() => w.prepareCompaction(w.a),{code:'NATIVE_RESULT_HASH_MISMATCH'});
    assert.equal(w.generation(0).state,'paused');
    assert.deepEqual(w.status().steering.delegationReceipt,receipt);
    for (const result of [await w.httpHandoff(), await w.httpReport()]) {
        assert.equal(result.status,409);
        assert.equal(result.value.error.code,'NATIVE_RESULT_HASH_MISMATCH');
    }
    await w.reopen();
    assert.equal(w.status().state,'review_required');
    assert.equal(w.status().steering.applicationState,'blocked');
    assert.equal(w.status().steering.delegationReceipt,undefined);
    assert.throws(w.handoff,{code:'WORK_SAFE_BOUNDARY_PENDING'});
    assert.equal(w.f.store.metrics().journalRows,2);
});

test('transient archive reads are retryable through restart without marking a known child result unknown', async t => {
    const w = await workFixture(t);
    w.finishChild();
    assert.equal(w.settleParent(),'paused');
    w.setArchiveReadFailure(Object.assign(Error('synthetic storage outage'),{code:'EIO'}));
    for (const result of [await w.httpHandoff(), await w.httpReport()]) {
        assert.equal(result.status,503);
        assert.equal(result.value.error.code,'NATIVE_ARCHIVE_STORAGE_UNAVAILABLE');
        assert.equal(result.value.error.message,'Sync service failed');
    }
    await w.reopen();
    assert.equal(w.status().state,'dispatched');
    assert.equal(w.status().nativeTasks[0].state,'completed');
    w.setArchiveReadFailure(null);
    assert.equal((await w.httpHandoff()).status,200);
});

test('restart recovers a durable child report projection without reissuing the child or parent', async t => {
    const w = await workFixture(t);
    assert.equal(w.settleParent(),'awaiting_native_task');
    const proof = w.finishChild({project:false});
    assert.equal(w.status().steering.delegationReceipt,undefined);
    await w.reopen();
    assert.equal(w.status().steering.delegationReceipt.resultHash,proof.resultHash);
    assert.equal(w.status().steering.applicationState,'awaiting_handoff');
    assert.equal(w.status().nativeTasks.length,1);
    assert.equal(w.status().nativeRequests.length,2);
    assert.equal(w.status().toolInvocations.length,1);
    assert.equal(w.f.calls(),0);
    assert.equal(w.f.store.metrics().journalRows,2);
});

test('an unreadable unprojected report waits on restart while storage recovers', async t => {
    const w = await workFixture(t);
    assert.equal(w.settleParent(),'awaiting_native_task');
    const proof = w.finishChild({project:false});
    w.setArchiveReadFailure(Object.assign(Error('synthetic storage outage'),{code:'EIO'}));
    await w.reopen();
    assert.equal(w.status().state,'dispatched');
    assert.equal(w.generation(0).state,'awaiting_native_task');
    assert.equal(w.status().steering.delegationReceipt,undefined);
    w.setArchiveReadFailure(null);
    await w.shared.native.engine.nativeTasks.reconcile(true);
    assert.equal(w.status().steering.delegationReceipt.resultHash,proof.resultHash);
    assert.equal(w.status().steering.applicationState,'awaiting_handoff');
});

test('a missing original report prevents generation 1 after B already took over and compacted', async t => {
    const w = await workFixture(t);
    w.finishChild();
    assert.equal(w.settleParent(),'paused');
    w.handoff();
    const {prepare} = compactForContinuation(w, w.status().steering.delegationReceipt);
    fs.unlinkSync(w.archivePath);
    assert.throws(prepare,{status:409,code:'NATIVE_RESULT_ARCHIVE_MISSING'});
    const report = await w.httpReport();
    assert.equal(report.status,409);
    assert.equal(report.value.error.code,'NATIVE_RESULT_ARCHIVE_MISSING');
    await w.reopen();
    assert.equal(w.status().state,'review_required');
    assert.equal(w.status().steering.executor,w.b.principal);
    assert.equal(w.status().steering.generation,0);
    assert.equal(w.status().toolInvocations.length,1);
    assert.equal(w.generation(1),undefined);
    assert.equal(w.f.store.metrics().journalRows,3);
});

test('legacy admissions without a mode keep the ordinary restart review fence', async t => {
    const {shared, store, owner, actor, root} = await fixture(t);
    t.after(() => fs.rmSync(root, {recursive:true,force:true}));
    const sharedSpaceId = 'sharedAB';
    const a = actor('A');
    const db = store.db;
    const workIds = [];
    for (const state of ['paused','running','awaiting_native_task']) {
        const topic = shared.create(a,{sharedSpaceId,opId:'make-'+state,kind:'topic',parentId:owner.id,
            localId:state,localParent:'origin',config:{name:state}}).object;
        const context = shared.executionConfig(a,{sharedSpaceId,sharedId:topic.id});
        const accepted = shared.admit(a,{sharedSpaceId,sharedId:topic.id,requestId:'request-'+state,
            expectedHead:context.head,configHash:context.hash,message:{id:'input-'+state,role:'user',content:'Legacy Work',timestamp:1}});
        const work = db.prepare("UPDATE shared_admissions SET state='dispatched',dispatched=1 WHERE id=? RETURNING *").get(accepted.id);
        shared.steering.control(work);
        const number = state === 'running' ? 1 : 0;
        const generation = shared.steering.generation(work.id,0);
        db.prepare('UPDATE shared_work_controls SET generation=? WHERE work_id=?').run(number,work.id);
        db.prepare('UPDATE shared_work_generations SET state=?,generation=?,checkpoint_json=? WHERE work_id=?')
            .run(state,number,state==='paused'?'{}':null,work.id);
        db.prepare('INSERT INTO shared_native_requests VALUES(?,?,?,?,?,?,?)')
            .run(generation.request_id,work.id,a.principal,null,'a'.repeat(64),state==='running'?'dispatched':'model_terminal',number);
        if (state === 'paused') db.prepare('INSERT INTO shared_native_checkpoints VALUES(?,?,?)').run(work.id,0,'{}');
        assert.equal(db.prepare("SELECT json_extract(user_op,'$.sharedTurn.controlMode') mode FROM shared_admissions WHERE id=?").get(work.id).mode,null);
        workIds.push(work.id);
    }
    const {SharedSpace} = require(BOX + '/Plugin/NativeSync/sync/sharedSpace');
    new SharedSpace(store,{NativeSyncSharedSpaces:JSON.stringify([{id:sharedSpaceId,sources:['sourceA','sourceB']}])});
    const readState = db.prepare('SELECT state FROM shared_admissions WHERE id=?');
    assert.deepEqual(workIds.map(id => readState.get(id).state),Array(3).fill('review_required'));
});

test('idle native task reconciliation runs no AA queries, even when the provider is registered', async t => {
    const {shared, store, root} = await fixture(t);
    t.after(() => fs.rmSync(root, {recursive:true,force:true}));
    const prepare = t.mock.method(store.db, 'prepare');
    const reconcile = () => shared.native.engine.nativeTasks.reconcile(true);
    await reconcile();
    t.after(ctx.registerNativeTaskProvider('AgentAssistant', {read:() => null,readArchive:() => null}));
    await reconcile();
    assert.deepEqual(prepare.mock.calls.map(call => call.arguments[0]),Array(2).fill(
        "SELECT * FROM mobile_native_tasks WHERE state NOT IN ('completed','failed','cancelled','stopped')"));
});

test('late AA provider registration restores pending and already paused boundaries', async t => {
    for (const project of [false,true]) {
        await t.test(project?'paused':'awaiting projection',async t => {
            const w = await workFixture(t);
            assert.equal(w.settleParent(),'awaiting_native_task');
            const proof = w.finishChild({project});
            w.stopProvider();
            await w.reopen();
            assert.equal(w.status().state,'dispatched');
            assert.equal(w.generation(0).state,project?'paused':'awaiting_native_task');
            w.startProvider();
            await w.shared.native.engine.nativeTasks.reconcile(true);
            assert.equal(w.status().steering.delegationReceipt.resultHash,proof.resultHash);
            assert.equal(w.status().steering.applicationState,'awaiting_handoff');
            assert.equal(w.status().toolInvocations.length,1);
            assert.equal(w.f.calls(),0);
        });
    }
});

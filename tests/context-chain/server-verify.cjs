'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { fileURLToPath } = require('node:url');
const [run, mode, baseline] = process.argv.slice(2);
const packet = mode === 'request-envelope';
const metadata = mode === 'request-metadata';
const depth = mode === 'tavern-depth';
const spec = depth ? require('./tavern-depth.cjs') : require('./input.json');
if (!run) throw Error('Specify the isolated fixture run path.');
const nativeSignal = JSON.parse(fs.readFileSync(path.join(run,'native.json')));
const nativeHistory = JSON.parse(fs.readFileSync(path.join(run, 'native.json.history.json')));
const evidence = JSON.parse(fs.readFileSync(path.join(run,'snapshot.json')));
const [work] = evidence.work;
assert.equal(evidence.work.length,1);
assert.equal(work.state,'completed');
assert.equal(work.attempts,1);
assert.equal(work.request_dispatched,1);
assert.equal(work.user_seq,spec.history.length + 1);
assert.deepEqual(evidence.journal.map(row=>row.msg_id),[
    ...spec.history.map(row => row.id),work.user_message_id,work.reply_message_id,
]);
assert.equal(evidence.journal.at(-1).message.content,'CTX_COMPLETE');
assert.equal(evidence.attachment.finishState,'ready');
assert.equal(evidence.attachment.digest,evidence.attachment.boundBlobHash);
assert.equal(evidence.attachment.digest,evidence.attachment.claimHash);
assert.equal(evidence.attachment.bytes,evidence.attachment.chunkOffset);

const capture = evidence.handler.filter(item=>item.kind==='handler-input');
const [shared] = capture.filter(item=>item.workId===work.id);
const [native] = capture.filter(item=>item.workId===null);
assert.equal(capture.length,2);
assert.ok(shared && native);
assert.equal(evidence.provider.length,2);
const historyText = ({content}) => typeof content === 'string' ? content : content.filter(part => part.type === 'text').map(part => part.text).join('\n');
const token = row => historyText(row).match(/CTX_[A-Z0-9_]+/)?.[0];
const originalOrder = ['CTX_SYSTEM_V1', 'CTX_CHECKPOINT_V1', 'CTX_RETAINED_INPUT', 'CTX_RETAINED_REPLY', 'CTX_DEPTH_ONE', 'CTX_CURRENT'];
const nativeDepthOrder = ['CTX_SYSTEM_V1', 'CTX_RETAINED_SYSTEM', 'CTX_DEPTH_FOUR', 'CTX_CHECKPOINT_V1', 'CTX_RETAINED_INPUT', 'CTX_RETAINED_REPLY', 'CTX_CURRENT'];
const baselineSharedDepthOrder = ['CTX_SYSTEM_V1', 'CTX_CHECKPOINT_V1', 'CTX_DEPTH_FOUR', 'CTX_RETAINED_INPUT', 'CTX_RETAINED_SYSTEM', 'CTX_RETAINED_REPLY', 'CTX_CURRENT'];
const sha = text => createHash('sha256').update(text).digest('hex');
const check = (item, history) => {
    const arrivals = evidence.provider.filter(row=>row.requestId===item.requestId);
    assert.equal(arrivals.length,1);
    const roleContent = ({role,content}) => ({role,content});
    assert.deepEqual(arrivals[0].messages.map(roleContent),item.messages.map(roleContent));
    const order = !depth ? originalOrder : (item.workId && baseline ? baselineSharedDepthOrder : nativeDepthOrder);
    const roleByToken = {
        CTX_SYSTEM_V1: 'system', CTX_RETAINED_SYSTEM: 'system', CTX_RETAINED_REPLY: 'assistant',
    };
    assert.deepEqual(item.messages.map(token), order);
    assert.deepEqual(item.messages.map(row=>row.role), order.map(marker=>roleByToken[marker] || 'user'));
    const text = item.messages.map(historyText);
    const indexOf = marker => order.indexOf(marker);
    assert.ok(text[0].includes('CTX_SYSTEM_SUFFIX'));
    assert.equal(text[indexOf('CTX_CHECKPOINT_V1')], 'CTX_CHECKPOINT_V1');
    assert.ok(text[indexOf('CTX_RETAINED_INPUT')].includes(spec.attachment.text));
    assert.equal(text[indexOf('CTX_RETAINED_REPLY')], 'CTX_RETAINED_REPLY');
    const injection = depth ? 'CTX_DEPTH_FOUR' : 'CTX_DEPTH_ONE';
    assert.equal(text[indexOf(injection)], injection);
    assert.ok(text.at(-1).startsWith(spec.input) && text.at(-1).endsWith('CTX_USER_SUFFIX'));
    assert.ok(!text.some(line=>line.includes('CTX_BEFORE_CHECKPOINT')));
    assert.deepEqual(history.slice(0,-2).map(row=>row.id), spec.history.map(row=>row.id));
    for (const [i, row] of spec.history.entries()) {
        for (const key of Object.keys(row)) assert.deepEqual(history[i][key], row[key]);
    }
    assert.equal(history.at(-2).content, spec.input);
    assert.equal(history.at(-1).content, spec.reply);
    const bindings = item.body?.vcpchatExtensions.messageTimestampBindings;
    assert.equal(item.timestampBindingCount, spec.history.length);
    if (item.body) {
        assert.deepEqual(item.body.messages,item.messages);
        assert.ok(arrivals[0].body);
        assert.equal(item.body.vcpchatExtensions.schemaVersion, 1);
        assert.equal(item.body.vcpchatExtensions.messageMetadataMode, 'hash_only');
        assert.ok(item.messages.every(row => !Object.hasOwn(row, '__vcpchatTimestampMeta') &&
            !Object.hasOwn(row, '__vcpContextCheckpoint')));
        assert.equal(item.body.vcpchatExtensions.requestContext.ownerType, 'agent');
        assert.equal(item.body.vcpchatExtensions.requestContext.isGroupMessage, false);
        const expected = history.slice(1,-1).map(row => [indexOf(token(row)), row.id]).sort((a,b)=>a[0]-b[0]);
        assert.deepEqual(bindings.map(binding=>[binding.sentMessageIndex,binding.messageId]), expected);
        for (const binding of bindings) {
            const row = history.find(message=>message.id===binding.messageId);
            assert.equal(binding.timestamp,row.timestamp);
            assert.equal(binding.timestampIso, new Date(row.timestamp).toISOString());
            assert.equal(binding.sentMessageHash, 'sha256:' + sha(text[binding.sentMessageIndex]));
        }
    }
    return { text, order };
};
const nativeProof = check(native, nativeHistory);
const sharedProof = check(shared, evidence.journal.map(row=>row.message));
const nativeText = nativeProof.text;
const sharedText = sharedProof.text;
const selections=evidence.handler.filter(row=>row.kind==='checkpoint-selection');
const historicalTavernBaseline = depth && baseline === '--baseline';
assert.equal(selections.length, historicalTavernBaseline ? 1 : 2);
const [selection]=selections;
const expectedHistoryIds=evidence.journal.slice(0,historicalTavernBaseline ? -1 : -2).map(row=>row.msg_id);
for (const visit of selections) {
    assert.deepEqual(visit, selection);
    assert.deepEqual(visit.beforeIds,expectedHistoryIds);
    assert.deepEqual(visit.afterIds,expectedHistoryIds.slice(1));
}
const meterInput = () => createHash('sha256').update(fs.readFileSync(path.join(run, 'input.json'))).digest('hex');
const metered = rel => createHash('sha256').update(fs.readFileSync(path.join(run,'runtime-box',rel))).digest('hex');
assert.equal(nativeSignal.attachment.sha256, evidence.attachment.digest);
assert.ok(nativeSignal.terminalVisible && nativeSignal.renderer.sandbox);
let tavernDepth;
if (depth) {
    const nativePath = baseline ? 'chatContextPipeline.js' : 'historyWindow/tavernContext.mjs';
    const calls = nativeSignal.coverage.filter(script =>
        script.url.endsWith('/' + nativePath) && script.hitFunctions.some(fn =>
            fn.name === 'applyContextRules' && fn.count === 1));
    assert.equal(calls.length, 1);
    const nativeSha256 = sha(fs.readFileSync(fileURLToPath(calls[0].url)));
    const workerCalls = evidence.handler.filter(row => row.kind === 'tavern-context');
    const expectedWorkerCalls = baseline ? ['applyContextInject'] : ['applyContextInject', 'applyContextRules'];
    assert.deepEqual(workerCalls.map(row => row.method), expectedWorkerCalls);
    if (!baseline) assert.equal(workerCalls.at(-1).sha256, nativeSha256);
    tavernDepth = {
        orders: { native: nativeProof.order, shared: sharedProof.order },
        renderer: {
            module: 'apps/desktop/modules/chat/' + nativePath,
            method: 'applyContextRules', calls: 1, sha256: nativeSha256,
        },
        worker: workerCalls,
    };
}
let requestEnvelope;
if (packet) {
    const [desktop] = nativeSignal.packetCoverage;
    assert.equal(nativeSignal.packetCoverage.length, 1);
    const methods = ['buildVcpChatExtensionsFromMessages', 'stripInternalMessageMetadata'];
    assert.deepEqual(desktop.calls, Object.fromEntries(methods.map(method => [method, 1])));
    const core = 'packages/core-rules/requestEnvelope.cjs';
    assert.equal(desktop.module, baseline ? 'apps/desktop/modules/ipc/chatHandlers.js' : core);
    const worker = evidence.handler.filter(row => row.kind === 'request-envelope');
    assert.deepEqual(worker.map(row => row.method), methods);
    assert.ok(worker.every(row => row.sha256 === worker[0].sha256));
    if (baseline) {
        assert.ok(worker.every(row => row.module === 'Plugin/NativeSync/nativeRules/modules/chat/requestEnvelope.js'));
        assert.notEqual(worker[0].sha256, desktop.sha256);
    } else {
        assert.ok(worker.every(row => row.module.endsWith('/' + core) && row.sha256 === desktop.sha256));
    }
    requestEnvelope = { desktop, worker };
}
let requestMetadata;
if (metadata) {
    const root = path.resolve(__dirname,'../..');
    const method = 'attachTimestampMetadata';
    const core = 'apps/desktop/modules/chat/historyWindow/requestMetadata.mjs';
    const rendererSources = nativeSignal.coverage.filter(script =>
        script.hitFunctions.some(fn => fn.name === method));
    assert.equal(rendererSources.length, 1);
    const [renderer] = rendererSources;
    const source = fileURLToPath(renderer.url);
    const module = path.relative(root, source);
    assert.equal(module, baseline ? 'apps/desktop/modules/chat/chatContextPipeline.js' : core);
    const sha256 = sha(fs.readFileSync(source));
    const calls = renderer.hitFunctions.find(fn => fn.name === method).count;
    const bindingRows = item => item.body.vcpchatExtensions.messageTimestampBindings
        .map(({messageId,role,timestamp}) => ({messageId,role,timestamp}));
    const desktopMetadata = JSON.parse(fs.readFileSync(path.join(run,'native.json.handler.jsonl'),'utf8'))
        .messages.map(row => row.__vcpchatTimestampMeta).filter(Boolean);
    assert.equal(calls, desktopMetadata.length);
    assert.deepEqual(desktopMetadata, bindingRows(native));
    const worker = evidence.handler.filter(row => row.kind === mode);
    assert.deepEqual(worker.map(row => row.metadata), bindingRows(shared));
    assert.ok(worker.every(row => baseline
        ? row.module === 'Plugin/NativeSync/nativeRules/modules/chat/requestMetadata.js' && row.sha256 !== sha256
        : row.module.endsWith('/' + core) && row.sha256 === sha256));
    requestMetadata = { desktop: { module, method, calls, sha256, metadata:desktopMetadata }, worker };
}
const selectedPath = path.resolve(run,'runtime-box',selection.module);
const hashes = {
    handler:metered('modules/chatCompletionHandler.js'),
    worker:metered('Plugin/NativeSync/mobile/effectiveContext.js'),
    selector: selection.sha256 || (fs.existsSync(selectedPath) ? createHash('sha256').update(fs.readFileSync(selectedPath)).digest('hex') : null),
};
const replayPath=path.join(run,'shared-replay.json');
let replay=null;
if(fs.existsSync(replayPath)){
    const receipt=JSON.parse(fs.readFileSync(replayPath));
    assert.deepEqual(receipt,{requestId:work.request_id,workId:work.id,replayed:true,state:'completed'});
    assert.equal(evidence.submissions.length,2);
    assert.ok(evidence.submissions.every(row=>row.status===200&&row.requestId===work.request_id&&row.workId===work.id));
    const beforePath=path.join(run,'before-replay.json');
    if(fs.existsSync(beforePath)){
        const before=JSON.parse(fs.readFileSync(beforePath));
        for (const key of ['work','journal','handler','provider']) assert.deepEqual(evidence[key],before[key]);
    }
    replay={...receipt,sameWork:true,totalWorks:evidence.work.length,totalJournalRows:evidence.journal.length,
        providerCallsForWork:evidence.provider.filter(row=>row.requestId===work.id).length};
}
console.log(JSON.stringify({
    status:'PASS',work, nativeRequestId:native.requestId, handlerPackets:2, providerPackets:2, eachHandlerRoleAndContentMatchesProvider:true,
    attachment:evidence.attachment, selection, hashes, replay,
    ...(tavernDepth ? { tavernDepth } : {}),
    ...(requestEnvelope ? { requestEnvelope } : {}),
    ...(requestMetadata ? { requestMetadata } : {}),
    ...(packet || metadata ? {
        scenario:mode, inputSha256:meterInput(),
        paths:{
            native:{handler:native, provider:evidence.provider.find(row => row.requestId === native.requestId), persistedHistory:nativeHistory},
            shared:{handler:shared, provider:evidence.provider.find(row => row.requestId === shared.requestId),
                persistedJournalMessages:evidence.journal.map(row => row.message)},
        },
    } : {}),
    fullSyntheticBodies:capture.every(row=>Boolean(row.body))&&evidence.provider.every(row=>Boolean(row.body)), remainingWireDifferences:{
        system:nativeText[0]!==sharedText[0], historicalAttachmentLabel:nativeText[nativeProof.order.indexOf('CTX_RETAINED_INPUT')]!==sharedText[sharedProof.order.indexOf('CTX_RETAINED_INPUT')],
        handlerCurrentUserName:[native.messages.at(-1).name??null,shared.messages.at(-1).name??null],
        providerCurrentUserName:[native,shared].map(row=>evidence.provider.find(call=>call.requestId===row.requestId).messages.at(-1).name??null),
        messageBodyTypes:[typeof native.messages[1].content,typeof shared.messages[1].content],
        temperature:[native.temperature??null,shared.temperature??null],maxTokens:[native.max_tokens??null,shared.max_tokens??null],
    },
},null,2));

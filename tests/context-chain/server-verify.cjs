'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const run = process.argv[2];
if (!run) throw Error('Specify the isolated fixture run path.');
const evidence = JSON.parse(fs.readFileSync(path.join(run,'snapshot.json')));
const [work] = evidence.work;
assert.equal(evidence.work.length,1);
assert.equal(work.state,'completed');
assert.equal(work.attempts,1);
assert.equal(work.request_dispatched,1);
assert.equal(work.user_seq,5);
assert.deepEqual(evidence.journal.map(row=>row.msg_id),[
    'ctx-before-checkpoint','ctx-checkpoint','ctx-retained-user','ctx-retained-answer',work.user_message_id,work.reply_message_id,
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
const check = item => {
    const arrivals = evidence.provider.filter(row=>row.requestId===item.requestId);
    assert.equal(arrivals.length,1);
    const roleContent = ({role,content}) => ({role,content});
    assert.deepEqual(arrivals[0].messages.map(roleContent),item.messages.map(roleContent));
    const text = item.messages.map(row=>typeof row.content==='string'?row.content:row.content.map(part=>part.text).join(''));
    assert.equal(item.timestampBindingCount,4);
    if (item.body) {
        assert.deepEqual(item.body.messages,item.messages);
        assert.equal(item.body.vcpchatExtensions.messageTimestampBindings.length,4);
        assert.ok(arrivals[0].body);
    }
    assert.deepEqual(item.messages.map(row=>row.role),['system','user','user','assistant','user','user']);
    assert.ok(text[0].includes('CTX_SYSTEM_V1')&&text[0].includes('CTX_SYSTEM_SUFFIX'));
    assert.equal(text[1],'CTX_CHECKPOINT_V1');
    assert.ok(text[2].startsWith('CTX_RETAINED_INPUT')&&text[2].includes('CTX_ATTACHMENT_BODY_V1'));
    assert.equal(text[3],'CTX_RETAINED_REPLY');
    assert.equal(text[4],'CTX_DEPTH_ONE');
    assert.ok(text[5].startsWith('CTX_CURRENT:')&&text[5].endsWith('CTX_USER_SUFFIX'));
    assert.ok(!text.some(line=>line.includes('CTX_BEFORE_CHECKPOINT')));
    return text;
};
const nativeText=check(native),sharedText=check(shared);
const selections=evidence.handler.filter(row=>row.kind==='checkpoint-selection');
assert.equal(selections.length,1);
const [selection]=selections;
assert.deepEqual(selection.beforeIds,evidence.journal.slice(0,-1).map(row=>row.msg_id));
assert.deepEqual(selection.afterIds,selection.beforeIds.slice(1));
const metered = rel => createHash('sha256').update(fs.readFileSync(path.join(run,'runtime-box',rel))).digest('hex');
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
        for(const key of ['work','journal']) assert.deepEqual(evidence[key],before[key]);
        const measured=rows=>rows.filter(row=>row.requestId===work.id);
        for(const key of ['handler','provider'])assert.deepEqual(measured(evidence[key]),measured(before[key]));
    }
    replay={...receipt,sameWork:true,totalWorks:evidence.work.length,totalJournalRows:evidence.journal.length,
        providerCallsForWork:evidence.provider.filter(row=>row.requestId===work.id).length};
}
console.log(JSON.stringify({
    status:'PASS',work, nativeRequestId:native.requestId, handlerPackets:2, providerPackets:2, eachHandlerRoleAndContentMatchesProvider:true,
    attachment:evidence.attachment, selection, hashes, replay,
    fullSyntheticBodies:capture.every(row=>Boolean(row.body))&&evidence.provider.every(row=>Boolean(row.body)), remainingWireDifferences:{
        system:nativeText[0]!==sharedText[0], historicalAttachmentLabel:nativeText[2]!==sharedText[2],
        handlerCurrentUserName:[native.messages.at(-1).name??null,shared.messages.at(-1).name??null],
        providerCurrentUserName:[native,shared].map(row=>evidence.provider.find(call=>call.requestId===row.requestId).messages.at(-1).name??null),
        messageBodyTypes:[typeof native.messages[1].content,typeof shared.messages[1].content],
        temperature:[native.temperature??null,shared.temperature??null],maxTokens:[native.max_tokens??null,shared.max_tokens??null],
    },
},null,2));

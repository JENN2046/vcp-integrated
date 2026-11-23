'use strict';

const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const run = path.resolve(process.argv[2]);
const load = name => JSON.parse(fs.readFileSync(path.join(run,name + '.json')));
const ready = load('ready');
const first = load('group-first');
const second = load('group-second');
const lose = load('group-lost');
const reopen = load('group-reopened');
const groupCompleted = load('group-completed');
const initial502 = load('single-review');
const settled502 = load('single-settled');
const deleted502 = load('single-deleted');
const final = load('final-status');
const restored = ready.restoredDbSha256 && load('restored-central');
if (restored) {
    assert.match(ready.restoredDbSha256,/^[a-f0-9]{64}$/);
    assert.ok(restored.retained.length > 0);
    assert.deepEqual(final.retained,restored.retained);
    assert.equal(final.schemaVersion,4);
    assert.deepEqual(restored.mobileScopes,[['shared:sharedAB:read']]);
}
const count = state => state.calls.map(row => row.member || row.input);

assert.deepEqual(count(first), ['A']);
assert.deepEqual(count(second), ['A','B']);
assert.deepEqual(count(lose), ['A','B']);
assert.deepEqual(count(reopen), ['A','B']);
assert.deepEqual(count(groupCompleted), ['A','B','C']);
assert.deepEqual(lose.group, reopen.group);
assert.deepEqual(first.group.journal, second.group.journal.slice(0,2));
assert.deepEqual(second.group.journal, lose.group.journal);

const group = final.group;
const workId = first.group.admissions[0].id;
for (const stage of [first,second,lose,reopen,groupCompleted,final]) {
    assert.deepEqual(stage.group.admissions.map(row => row.id),[workId]);
}
assert.deepEqual(group.journal.slice(0,3),second.group.journal);
assert.equal(group.admissions[0].state,'completed');
assert.equal(lose.group.handoff[0].state,'continuing');
assert.equal(second.group.handoff[0].state,'awaiting_handoff');
assert.ok(lose.group.native.every(step => step.ordinal !== 2 || step.state === 'prepared'));
assert.equal(group.handoff[0].executor_version,2);
assert.equal(group.handoff[0].state,'completed');
assert.deepEqual(group.journal.map(row => row.message.content),[ready.groupInput,...ready.groupReplies]);
assert.deepEqual(group.journal.map(row => row.action),Array(4).fill('upsert'));
assert.equal(new Set(group.journal.map(row => row.msg_id)).size,4);
assert.deepEqual(group.native.map(row => row.principal),['desktop:deviceA','desktop:deviceB','desktop:deviceA']);
assert.deepEqual(group.native.map(row => row.state),Array(3).fill('model_terminal'));
assert.deepEqual(group.slots.map(row => row.reply_seq),group.journal.slice(1).map(row => row.seq));
for (const [index,native] of group.native.entries()) {
    const row = group.journal[index+1];
    assert.equal(row.msg_id,'reply_' + native.id);
    assert.equal(row.device_id,native.principal);
    assert.equal(row.message.agentId,native.member_id);
    assert.equal(row.message.name,['A','B','C'][index]);
}
const continues = final.wires.filter(row => row.route.endsWith('/group-continue'));
assert.equal(continues.length,3);
assert.deepEqual(continues.map(row => [row.device,row.status,Boolean(row.dropped)]),[
    ['deviceB',200,false],['deviceA',200,true],['deviceA',200,false],
]);
assert.deepEqual(continues[1].body,continues[2].body);
assert.equal(continues[1].response.request.id,workId);
assert.equal(continues[1].response.request.groupHandoff.nextOrdinal,2);
assert.equal(continues[1].response.request.groupHandoff.executorVersion,2);
assert.deepEqual(continues[1].response.request.groupHandoff.confirmedReplies,
    second.group.journal.slice(1).map(row => row.seq));
const takeovers = final.wires.filter(row => row.route.endsWith('/group-handoff'));
assert.deepEqual(takeovers.map(row => [row.device,row.status,row.response.request.id,row.response.request.groupHandoff.executorVersion]),[
    ['deviceB',200,workId,1],['deviceA',200,workId,2],
]);
const handler = fs.readFileSync(path.join(run,'group-handler.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
const provider = load('provider-context');
assert.deepEqual(handler.map(row => [row.workId,row.member,row.device]),[
    [workId,'A','deviceA'],[workId,'B','deviceB'],[workId,'C','deviceA'],
]);
assert.deepEqual(provider.map(row => row.packet.requestId),group.native.map(row => row.id));
const packet = handler[2].body;
const textOf = message => typeof message.content === 'string' ? message.content :
    message.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
const context = group.journal.slice(1,3).map(({msg_id,message}) => {
    const bindings = packet.vcpchatExtensions.messageTimestampBindings.filter(row => row.messageId === msg_id);
    assert.equal(bindings.length,1);
    const [binding] = bindings;
    const displayed = '[' + message.name + '的发言]: ' + message.content;
    const handlerOccurrences = packet.messages.filter(row => row.role === 'assistant' && textOf(row).includes(message.content));
    assert.deepEqual(handlerOccurrences,[packet.messages[binding.sentMessageIndex]]);
    assert.equal(textOf(handlerOccurrences[0]),displayed);
    assert.equal(binding.timestamp,message.timestamp);
    assert.equal(binding.sentMessageHash,'sha256:' + createHash('sha256').update(displayed).digest('hex'));
    const positions = provider[2].packet.messages.flatMap((row, index) =>
        row.role === 'assistant' && textOf(row).includes(message.content) ? [index] : []);
    assert.equal(positions.length,1);
    return {id:msg_id, bindingIndex:binding.sentMessageIndex, providerIndex:positions[0], sha256:binding.sentMessageHash};
});
assert.ok(context[0].bindingIndex < context[1].bindingIndex && context[0].providerIndex < context[1].providerIndex);

const original = initial502.single.work[0];
const single = final.single;
assert.equal(original.state,'review_required');
assert.equal(original.attempts,1);
assert.equal(original.pending_operation,null);
assert.equal(original.native_final_operation,null);
assert.equal(initial502.single.admissions[0].state,'review_required');
assert.equal(initial502.single.native[0].state,'unknown');
assert.equal(initial502.single.journal.length,1);
assert.equal(initial502.single.journal[0].message.content,ready.singleInputs[0]);
assert.equal(settled502.single.work[0].state,'cancelled');
assert.equal(settled502.single.work[0].review_resolved,1);
assert.equal(settled502.single.admissions[0].state,'abandoned');
assert.deepEqual(settled502.single.journal,initial502.single.journal);
assert.deepEqual(settled502.single.native,initial502.single.native);
assert.deepEqual(count(initial502),count(settled502));
assert.deepEqual(count(settled502),count(deleted502));
assert.deepEqual(deleted502.single.journal.map(row => [row.msg_id,row.action]),[
    [original.user_message_id,'upsert'],[original.user_message_id,'delete'],
]);
assert.deepEqual(single.journal.slice(0,2),deleted502.single.journal);
assert.deepEqual(single.work[0],settled502.single.work[0]);
assert.deepEqual(single.native[0],initial502.single.native[0]);
assert.equal(single.work[1].state,'completed');
assert.equal(single.work[1].attempts,1);
const abandons = final.wires.filter(row => row.route.endsWith('/shared/abandon'));
assert.deepEqual(abandons.map(row => [row.device,row.status,row.body.admissionId,row.body.confirm]),[
    ['deviceA',200,original.id,true],
]);
const deletes = final.wires.filter(row => row.route.endsWith('/shared/message') &&
    row.body.operation?.action === 'delete');
assert.deepEqual(deletes.map(row => [row.device,row.status,row.body.operation.msgId,row.response.seq]),[
    ['deviceA',200,original.user_message_id,deleted502.single.journal[1].seq],
]);
assert.deepEqual(single.journal.slice(2).map(row => row.message.content),[ready.singleInputs[1],ready.singleFinal]);
assert.deepEqual(count(final),['A','B','C',...ready.singleInputs]);
assert.deepEqual(final.calls.slice(3).map(row => row.httpStatus),[502,200]);
assert.ok(final.pairings >= 1);
assert.ok(final.mobileScopes.length >= 1);
for (const scopes of final.mobileScopes) assert.deepEqual(scopes,['shared:sharedAB:read']);

const linuxGroup = load('linux-group-complete');
const linuxSingle = load('linux-single-next');
const linuxReopened = load('linux-group-ack-reopened');
const history = data => data.history.map(({id,content}) => [id,content]);
const journal = rows => rows.map(row => [row.msg_id,row.message.content]);
assert.deepEqual(history(linuxReopened),journal(second.group.journal));
assert.deepEqual(history(linuxGroup),journal(final.group.journal));
assert.deepEqual(history(linuxSingle),journal(final.single.journal.slice(2)));
assert.match(linuxReopened.view.controlledWork,/等待本端执行/);
assert.equal(load('linux-single-deleted').history.length,0);
assert.equal(load('linux-single-deleted-reopened').history.length,0);

console.log(JSON.stringify({revision:ready.revision,workId,groupTopic:ready.groupTopicId,singleTopic:ready.singleTopicId,
    groupJournal:group.journal.map(row=>row.seq), context, singleWork:single.work.map(row=>({id:row.id,state:row.state})),
    singleJournal:single.journal.map(row=>[row.seq,row.action]), providerOrder:count(final),
    pairings:final.pairings, linuxHistoryMatched:true,
    ...(restored && {restoredDbSha256:ready.restoredDbSha256,retainedWorkIds:final.retained.flatMap(topic => topic.admissions.map(row => row.id))}),
},null,2));

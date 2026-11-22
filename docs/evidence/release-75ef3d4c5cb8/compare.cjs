'use strict';
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const read = file => JSON.parse(fs.readFileSync(path.join(__dirname,file),'utf8'));
const digest = text => createHash('sha256').update(text,'utf8').digest('hex');

const fixed = '75ef3d4c5cb8a880772342209841a40104127ba3';
const central = read('central/post-all-reopens.json');
assert.deepEqual(central,read('central/work-completed.json'));
assert.equal(central.providerCalls,1);
assert.equal(central.totalProviderRequests,1);
assert.equal(central.work.length,1);
const [work] = central.work;
assert.equal(work.state,'completed');
assert.equal(work.attempts,1);
assert.equal(work.request_dispatched,1);
const journal = read('central/post-all-reopens-message-hashes.json');
assert.deepEqual(journal,read('central/message-hashes.json'));
assert.deepEqual(journal.work,work);
assert.deepEqual(journal.sequences,[1,2]);
const rows = journal.journal;
assert.deepEqual(rows.map(row=>row.id),[work.user_message_id,work.reply_message_id]);
assert.deepEqual(rows.map(row=>row.role),['user','assistant']);
const linux = read('linux/reopened-readback.json').value;
const win = read('windows/reopened.json');
const phone = read('android/04-cold.json');
assert.equal(win.candidate,fixed);
assert.equal(win.sendAttempts,0);
assert.equal(win.sharedTopicId,journal.sharedTopicId);
assert.equal(phone.observed.topicKey,journal.sharedTopicId);
assert.equal(linux.work.id,work.id);
assert.equal(linux.work.requestId,work.request_id);
assert.equal(linux.work.state,work.state);
assert.equal(win.work.id,work.id);
assert.equal(win.work.state,work.state);
assert.deepEqual(phone.observed.executions,[{id:work.id,state:work.state}]);
assert(phone.secure && phone.visible && phone.standalone && phone.workerControlled && !phone.isPrivate);
const paired = read('android/02-paired.json');
assert.equal(phone.readback.status,200);
assert.equal(phone.readback.sessionMarker,paired.readback.sessionMarker);
assert.deepEqual(phone.observed,read('android/03-terminal.json').observed);
assert.notEqual(phone.pid,read('android/03-terminal.json').pid);
assert.notEqual(win.electron.pid,read('windows/first.json').electron.pid);
const lifecycle = fs.readFileSync(path.join(__dirname,'linux/initial-lifecycle.ndjson'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
assert.equal(lifecycle.filter(e=>e.event==='linux-submitted').length,1);
assert.notEqual(linux.pid,lifecycle.find(e=>e.event==='linux-exited').value.pid);
for (const collection of [win.dom,win.history,linux.messages,phone.observed.messages]) {
    assert.deepEqual(collection.map(row=>row.id),rows.map(row=>row.id));
}
for (const [i,row] of rows.entries()) {
    const body = win.dom[i].text;
    assert.equal(win.dom[i].visible,true);
    assert.equal(Buffer.byteLength(body,'utf8'),row.utf8Bytes);
    assert.equal(digest(body),row.contentSha256);
    for (const copy of [win.history[i],linux.messages[i],phone.observed.messages[i]]) assert.equal(copy.role,row.role);
    for (const sha of [win.dom[i].sha256,win.history[i].sha256,linux.messages[i].history.sha256,phone.observed.messages[i].sha256]) {
        assert.equal(sha,row.contentSha256);
    }
    assert.deepEqual(linux.messages[i].dom,{utf8Bytes:row.utf8Bytes+1,sha256:digest(body+'\n')});
}
console.log(JSON.stringify({result:'PASS',fixed,sharedTopicId:journal.sharedTopicId,workId:work.id,
    requestId:work.request_id,state:work.state,workCount:1,attempts:work.attempts,dispatched:work.request_dispatched,
    totalProviderRequests:central.totalProviderRequests,journal:rows.map((row,i)=>({seq:i+1,...row})),
    reopened:{linuxPid:linux.pid,windowsPid:win.electron.pid,androidFirefoxPid:phone.pid},
    linuxDomSuffix:'one verified Markdown LF per message'},null,2));

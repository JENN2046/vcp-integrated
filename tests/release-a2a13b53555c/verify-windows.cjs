'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const [windowsDir, centralDir] = process.argv.slice(2);
const load = (dir, file) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
const build = load(windowsDir, 'build-and-vm.json');
const central = load(centralDir, 'final-status.json');
const fixture = load(centralDir, 'ready.json');
const raw = fs.readFileSync(path.join(windowsDir, 'windows-events.jsonl'), 'utf8');
const events = raw.trim().split('\n').map(JSON.parse);
const snapshots = events.filter(row => row.event === 'window');
const active = snapshots.filter(row => row.data.connection === 'online');
const windowsLoaded = events.filter(row => row.event === 'windows-loaded');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

const row = ({ msg_id, message }) => ({ id: msg_id, text: message.content });
const assertSnapshot = (event, rows) => assert.deepEqual(event.data.messages, rows.map(row));
const groupRows = central.group.journal;
const work = central.group.admissions[0];
const groupTopic = fixture.groupBindings.B.topicId;
const group = active.filter(event => event.data.topicId === groupTopic);
const started = group.find(event => !event.data.remote && event.data.messages.length === 0);
const interim = group.find(event => event.data.remote?.id === work.id && event.data.messages.some(m => m.text === 'RELAY_B_FINAL'));
const finished = group.filter(event => event.data.remote?.id === work.id && event.data.remote.state === 'completed'
    && event.data.messages.some(m => m.text === 'RELAY_C_FINAL'));
assert.ok(started && interim, 'initial and in-progress group snapshots');
assert.equal(interim.pid, started.pid);
assert.ok(finished.length > 1, 'final group visible live and after restart');
const online = finished[0];
const reopened = finished.find(event => event.pid !== started.pid);
assert.equal(online.pid, started.pid);
assert.ok(reopened && online.pid !== reopened.pid);
for (const state of [online, reopened]) {
    assert.equal(state.data.remote.fresh, true);
    assert.equal(state.data.remote.confirmedCount, 3);
    assertSnapshot(state, groupRows);
}
assert.ok(events.some(event => event.event === 'electron-quit' && event.pid === online.pid && event.data.code === 0));
const actionEvents = events.filter(event => event.event === 'group-ui-ipc');
assert.deepEqual(actionEvents.map(event => [event.pid, event.data.action, event.data.workId,
    event.data.expectedExecutorVersion, event.data.expectedNextOrdinal]), [
    [online.pid, 'handoff', work.id, 0, 1], [online.pid, 'continue', work.id, 1, 1]
]);
assert.deepEqual(events.filter(event => event.event === 'group-ui-result').map(event => event.data.success), [true, true]);

const single = active.filter(event => event.data.topicId === fixture.singleDescriptors.B.topicId);
const original = central.single.journal[0];
assert.equal(central.single.journal[1].msg_id, original.msg_id);
assert.equal(central.single.journal[1].action, 'delete');
const review = single.find(event => event.data.messages.some(message => message.id === original.msg_id));
assert.ok(review && review.data.messages.length === 1);
const deleted = single.find(event => event.time > review.time && event.data.messages.length === 0);
assert.ok(deleted, 'Windows observes original input removal before next submission');
const singleRows = central.single.journal.slice(-2);
const finalSingle = single.find(event => event.data.messages.some(message => message.id === singleRows[1].msg_id));
assert.ok(finalSingle);
assertSnapshot(finalSingle, singleRows);
for (const [name, kind, rows] of [
    ['history-live.json', 'group', groupRows],
    ['history-reopened.json', 'group', groupRows],
    ['history-review.json', 'single', [original]],
    ['history-deleted.json', 'single', []],
    ['history-single.json', 'single', singleRows]
]) {
    const history = load(windowsDir, name).histories[kind];
    assert.ok(history.sha256 && !history.missing);
    assert.deepEqual(history.rows, rows.map(({ msg_id, message }) => ({
        id: msg_id, role: message.role, content: message.content
    })));
}
const firstHistory = load(windowsDir, 'history-live.json').histories.group;
const secondHistory = load(windowsDir, 'history-reopened.json').histories.group;
assert.equal(firstHistory.sha256, secondHistory.sha256);
for (const pid of [online.pid, reopened.pid]) {
    const { data } = windowsLoaded.find(event => event.pid === pid);
    assert.equal(data.platform, 'win32');
    assert.equal(data.account, 'R16Limited');
    assert.equal(data.electron, '44.9.3');
    assert.equal(data.arch, 'x64');
    assert.equal(data.sandbox, true);
    assert.equal(data.cdsSha256, build.windowsCDS.binarySha256);
    assert.ok(data.main.every(file => file.loaded));
    for (const file of [...data.main, data.renderer]) {
        const bytes = execFileSync('git', ['show', build.candidate + ':apps/desktop/' + file.file]);
        assert.equal(file.sha256, sha(bytes), file.file);
    }
}
console.log(JSON.stringify({
    status: 'PASS', workId: work.id, onlinePid: online.pid, reopenedPid: reopened.pid,
    groupMessages: groupRows.map(row), singleMessages: singleRows.map(row)
}, null, 2));

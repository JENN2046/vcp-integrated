'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {fixture, wait} = require('./fixtures/sharedSingleHarness.cjs');
const {setTimeout: pause} = require('node:timers/promises');

function addMessage(f, id) {
    f.store.apply({
        ...f.topic.topic, msgId: id, deviceId: 'fixture', opId: id, baseHash: null,
        action: 'upsert', message: {id, role: 'user', content: id, timestamp: 1}
    }, {sharedSpace: 'sharedAB'});
}

test('desktop watch keeps idle quiet and catches up across a dropped stream', async t => {
    const f = await fixture(t);
    f.control.trace = [];
    let stream;
    f.control.beforeRequest = (req, res, next) => {
        if (req.path.endsWith('/shared/watch')) stream = res;
        next();
    };
    const d = await f.desktop('B', {intervalMs: 20, watch: true});
    await wait(() => d.runtime.waitClient.online && !d.runtime.running && !d.runtime.tickRequested, 'initial watch catch-up');
    f.control.trace.length = 0;
    await pause(180);
    assert.deepEqual(f.control.trace, []);
    addMessage(f, 'observed-via-watch');
    await wait(async () => (await d.queue.readSerialized(d.descriptor)).some(row => row.id === 'observed-via-watch'), 'watch pull');
    assert.deepEqual(f.control.trace.map(row => row.route), ['/api/v1/sync/shared/pull']);

    stream.destroy();
    await wait(() => !d.runtime.waitClient.online, 'disconnected watch');
    addMessage(f, 'between-watch-connections');
    await wait(async () => d.runtime.waitClient.online && (await d.queue.readSerialized(d.descriptor)).some(row => row.id === 'between-watch-connections'), 'reconnected watch catch-up');
    assert.equal(f.control.trace.filter(row => row.route.endsWith('/shared/watch')).length, 1);
    await wait(() => !d.runtime.running && !d.runtime.tickRequested, 'reconnected catch-up settled');

    f.control.trace.length = 0;
    d.runtime.scheduleTick();
    await pause(80);
    assert.deepEqual(f.control.trace, []);
    assert(d.runtime.nextAudit > Date.now() + 14 * 60 * 1000);
    d.runtime.nextAudit = Date.now() - 1;
    d.runtime.scheduleTick();
    await wait(() => f.control.trace.some(row => row.route.endsWith('/shared/pull')) && !d.runtime.running, 'repair audit');
    assert.equal(f.control.trace.filter(row => row.route.endsWith('/shared/info')).length, 1);
    assert.equal(f.control.trace.filter(row => row.route.endsWith('/shared/pull')).length, 1);
    assert.equal(f.calls(), 0);
});

test('joined read-only desktop uses the same watch and never makes a background POST', async t => {
    const f = await fixture(t);
    const initial = await f.desktop('B');
    await initial.close();
    f.shared.readOnly = true;
    f.control.trace = [];
    const d = await f.desktop('B', {intervalMs: 20, watch: true});
    await wait(() => d.runtime.waitClient.online && !d.runtime.running && !d.runtime.tickRequested, 'read-only watch catch-up');
    assert(d.runtime.readOnly);
    const fs=require('node:fs/promises');
    const registry=d.runtime.file;
    const before=await fs.stat(registry), bytes=await fs.readFile(registry);
    f.control.trace.length=0;
    for(let n=1;n<=2;n++){
        d.runtime.nextAudit=Date.now()-1;
        d.runtime.scheduleTick();
        await wait(()=>f.control.trace.filter(row=>row.route.endsWith('/shared/info')).length===n&&!d.runtime.running,'settled read-only audit');
        const after=await fs.stat(registry);
        assert.equal(after.ino,before.ino);
        assert.equal(after.mtimeMs,before.mtimeMs);
        assert.deepEqual(await fs.readFile(registry),bytes);
    }
    addMessage(f, 'observed-in-read-only');
    await wait(async () => (await d.queue.readSerialized(d.descriptor)).some(row => row.id === 'observed-in-read-only'), 'read-only watch pull');
    assert(!f.control.trace.some(row => row.method === 'POST'));
});

test('desktop retains legacy wait recovery when the host offers no watch capability', async t => {
    const f = await fixture(t);
    f.control.trace = [];
    const d = await f.desktop('B', {intervalMs: 20, watch: true, legacyServer: true});
    await wait(() => d.runtime.waitClient.mode === 'wait' && d.runtime.waitClient.online, 'legacy wait negotiated');
    addMessage(f, 'observed-on-legacy-wait');
    await wait(async () => (await d.queue.readSerialized(d.descriptor)).some(row => row.id === 'observed-on-legacy-wait'), 'legacy wait pull');
    assert(f.control.trace.some(row => row.route.endsWith('/shared/wait')));
    assert(!f.control.trace.some(row => row.route.endsWith('/shared/watch')));
});

test('selected History notification and the missed-notification audit record drift without publishing a write', async t => {
    const fs = require('node:fs/promises');
    const f = await fixture(t);
    const d = await f.desktop('B', {intervalMs: 20, watch: true});
    const r = d.runtime;
    await wait(() => r.waitClient.online && !r.running && !r.tickRequested, 'settled watch');
    const file = d.queue.getHistoryPath(d.descriptor.itemId, d.descriptor.topicId);
    addMessage(f, 'committed-before-external-edit');
    await wait(async () => (await d.queue.readSerialized(d.descriptor)).length === 1 && !r.running, 'original History projected');
    const original = await fs.readFile(file, 'utf8');
    await fs.writeFile(file, JSON.stringify([{id:'external',role:'user',content:'unconfirmed change',timestamp:1}]));
    const metrics = f.store.metrics();
    r.adapter.externalHistoryChanged(file);
    await wait(() => Object.values(r.adapter.state.drift).some(row => row.code === 'UNKNOWN_HISTORY_DRIFT'), 'selected file drift');
    assert.equal(r.adapter.state.outbox.length, 0);
    assert.equal(f.store.metrics().journalRows, metrics.journalRows);

    await fs.writeFile(file, original);
    r.nextAudit = Date.now() - 1;
    r.scheduleTick();
    await wait(() => !Object.keys(r.adapter.state.drift).length && !r.running, 'missed filesystem event repaired by audit');
    assert.equal(r.adapter.state.outbox.length, 0);
    assert.equal(f.store.metrics().journalRows, metrics.journalRows);
    assert.equal(f.calls(), 0);
});

test('confirmed watch denial fences foreground and background until membership is verified', async t => {
    const f = await fixture(t);
    f.control.trace = [];
    let stream;
    f.control.beforeRequest = (req, res, next) => {
        if (req.path.endsWith('/shared/watch')) stream = res;
        next();
    };
    const d = await f.desktop('B', {intervalMs: 20, watch: true});
    await wait(() => d.runtime.waitClient.online && !d.runtime.running && !d.runtime.tickRequested, 'watch catch-up before denial');
    const message = {id:'accepted-before-denial',role:'user',content:'synthetic receipt retained',timestamp:1};
    const request = {descriptor:d.descriptor,message,serverSession:true};
    const first = await d.runtime.prepareSharedSend(request);
    assert(first.success);
    f.store.db.prepare('DELETE FROM shared_members WHERE space_id=? AND source_id=?').run('sharedAB','sourceB');
    stream.destroy();
    await wait(() => d.runtime.backgroundDenied && !d.runtime.running, 'confirmed denial');

    f.control.trace.length = 0;
    d.runtime.scheduleTick('pull');
    d.runtime.scheduleTick('changes');
    d.runtime.scheduleTick('attachments');
    await assert.rejects(d.runtime.prepareSharedSend(request),{code:'SHARED_WATCH_PERMISSION_REQUIRED'});
    await assert.rejects(d.runtime.sharedConfigRequest({route:'shared/directory-view?sharedSpaceId=sharedAB'}),{code:'SHARED_WATCH_PERMISSION_REQUIRED'});
    const status = await d.runtime.getExecutionStatus(d.descriptor,{refresh:false});
    assert(status.readOnly);
    assert.deepEqual(status.executions,[]);
    await pause(200);
    assert.deepEqual(f.control.trace, []);

    // /info still lists the configured grant. The removed membership must
    // prevent resume until the independent /bindings verification succeeds.
    const audit = () => { d.runtime.nextAudit = Date.now() - 1; d.runtime.scheduleTick(); };
    audit();
    await wait(() => f.control.trace.some(row=>row.route.endsWith('/shared/bindings'))&&!d.runtime.running, 'membership check while denied');
    assert(d.runtime.backgroundDenied);
    assert.deepEqual(f.control.trace.map(row=>row.route), ['/api/v1/sync/shared/info','/api/v1/sync/shared/bindings']);

    f.shared.join(f.actor('B'),{sharedSpaceId:'sharedAB',opId:'watch-test-membership-restored'});
    audit();
    await wait(() => !d.runtime.backgroundDenied&&d.runtime.waitClient.online&&!d.runtime.running, 'reverified membership');
    const replay = await d.runtime.prepareSharedSend(request);
    assert.equal(replay.admissionId,first.admissionId);
    assert.equal(f.calls(), 0);
});

test('online read-only downgrade rechecks capability and retains pull access', async t => {
    const f = await fixture(t);
    f.control.trace = [];
    const d = await f.desktop('B', {intervalMs: 20, watch: true});
    await wait(() => d.runtime.waitClient.online && !d.runtime.running && !d.runtime.tickRequested, 'watch catch-up before downgrade');
    f.control.trace.length = 0;
    f.shared.readOnly = true;
    addMessage(f, 'broadcast-after-readonly-downgrade');
    await wait(async () => d.runtime.readOnly && (await d.queue.read(d.descriptor)).some(row => row.id === 'broadcast-after-readonly-downgrade'), 'read-only downgrade pull');
    const status = await d.runtime.getExecutionStatus(d.descriptor,{refresh:false});
    assert(status.readOnly);
    assert(f.control.trace.some(row => row.route.endsWith('/shared/info')));
    assert(!f.control.trace.some(row => row.method === 'POST'));
});

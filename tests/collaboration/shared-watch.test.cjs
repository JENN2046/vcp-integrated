'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { BOX } = require('./fixtures/paths.cjs');
const sync = BOX + '/Plugin/NativeSync/sync';
const { CentralStore } = require(sync + '/centralStore');
const { SourceCatalog } = require(sync + '/sourceCatalog');
const { SharedSpace } = require(sync + '/sharedSpace');
const { createSyncHttpService } = require(sync + '/httpService');
const { openSharedWatch } = require(sync + '/sharedHttp');

const space = 'watchSpace';
const route = '/shared/watch?sharedSpaceId=' + space;
const lanes = ['matches', 'changes', 'pull'];

async function fixture(t, { heartbeatMs } = {}) {
    const store = new CentralStore(':memory:');
    const config = {
        NativeSyncFullSources: JSON.stringify([
            { sourceId: 'sourceA', deviceId: 'deviceA' },
            { sourceId: 'sourceB', deviceId: 'deviceB' },
        ]),
        NativeSyncSharedSpaces: JSON.stringify([{ id: space, sources: ['sourceA', 'sourceB'] }]),
    };
    store.sourceCatalog = new SourceCatalog(store, config);
    const shared = store.shared = new SharedSpace(store, config);
    const binding = { sourceId: 'sourceA', deviceId: 'deviceA', spaceId: store.sourceCatalog.spaceId };
    const actor = shared.desktop(binding, 'shared-space-v1');
    shared.join(actor, { sharedSpaceId: space, opId: 'joinA' });
    const service = createSyncHttpService(store);
    const server = http.createServer((req, res) => {
        if (heartbeatMs && req.url === route) {
            openSharedWatch(store, req, res, new URL(req.url, 'http://localhost'), () => {}, heartbeatMs);
        } else {
            service.handle(req, res);
        }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        await service.close();
    });
    const request = (pathname, { headers, ...options } = {}) => fetch(
        'http://127.0.0.1:' + server.address().port + pathname,
        {
            signal: AbortSignal.timeout(2500),
            ...options,
            headers: {
                'x-nativesync-source': binding.sourceId,
                'x-nativesync-device': binding.deviceId,
                'x-nativesync-space': binding.spaceId,
                'x-nativesync-capabilities': 'shared-space-v1,shared-watch-v1',
                ...headers,
            },
        },
    );
    const change = () => store.db.prepare('INSERT INTO shared_changes(space_id,object_id,version,kind) VALUES(?,?,1,?)')
        .run(space, 'synthetic', 'config');
    return { store, shared, actor, service, request, change };
}

async function frames(response) {
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/event-stream/);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    return {
        async next() {
            while (!buffer.includes('\n\n')) {
                const { done, value } = await reader.read();
                if (done) {
                    assert.equal(buffer, '');
                    return null;
                }
                buffer += decoder.decode(value, { stream: true });
            }
            const end = buffer.indexOf('\n\n');
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            if (frame === ': heartbeat') return { event: 'heartbeat' };
            const [event, data] = frame.split('\n');
            assert.match(event, /^event: /);
            assert.match(data, /^data: /);
            return { event: event.slice(7), data: JSON.parse(data.slice(6)) };
        },
        async nextEvent() {
            let frame;
            do { frame = await this.next(); } while (frame?.event === 'heartbeat');
            return frame;
        },
        close: () => reader.cancel(),
    };
}

test('watch sends commit-only hints and reuses wait tokens on reconnect', async t => {
    const f = await fixture(t);
    const info = await (await f.request('/shared/info')).json();
    assert.ok(info.features.includes('shared-wait-v1'));
    assert.ok(info.features.includes('shared-watch-v1'));
    const stream = await frames(await f.request(route));
    const first = await stream.next();
    assert.equal(first.event, 'hint');
    assert.deepEqual(first.data.changed, lanes);
    f.store.db.exec('BEGIN');
    f.change();
    f.store.db.exec('ROLLBACK');
    const resumed = await frames(await f.request(route + '&since=' + first.data.token));
    assert.deepEqual(await resumed.next(), { event: 'heartbeat' });
    const busy = await f.request(route);
    assert.equal(busy.status, 429);
    await busy.body.cancel();
    const wait = f.request('/shared/wait?sharedSpaceId=' + space + '&since=' + first.data.token);
    f.change();
    const next = await stream.next();
    assert.equal(next.event, 'hint');
    assert.deepEqual(next.data.changed, ['changes']);
    assert.deepEqual(await resumed.next(), next);
    assert.deepEqual(await (await wait).json(), next.data);
    assert.notEqual(next.data.token, first.data.token);
    await stream.close();
    f.service.beginDrain();
    assert.equal(await resumed.next(), null);
    assert.equal((await f.request(route)).status, 503);
});

test('watch rejects unjoined or mismatched sources and closes on revoked membership', async t => {
    const f = await fixture(t);
    const rejected = await f.request(route, { headers: { 'x-nativesync-source': 'sourceB', 'x-nativesync-device': 'deviceB' } });
    assert.equal(rejected.status, 403);
    assert.equal((await rejected.json()).error.code, 'SHARED_MEMBERSHIP_REQUIRED');
    const mismatched = await f.request(route, { headers: { 'x-nativesync-device': 'deviceB' } });
    assert.equal(mismatched.status, 403);
    assert.equal((await f.request(route + '&since=invalid')).status, 400);
    assert.equal((await f.request(route + '&sharedSpaceId=' + space)).status, 400);
    const stream = await frames(await f.request(route));
    assert.equal((await stream.next()).event, 'hint');
    f.store.db.prepare('DELETE FROM shared_members WHERE space_id=? AND source_id=?').run(space, 'sourceA');
    assert.deepEqual(await stream.next(), { event: 'invalidate', data: { reason: 'authorization_lost' } });
    assert.equal(await stream.next(), null);
    assert.equal((await f.request(route)).status, 403);
});

test('watch heartbeat invalidates read-only changes and revalidates in-memory grants', async t => {
    const f = await fixture(t, { heartbeatMs: 10 });
    const stream = await frames(await f.request(route));
    assert.equal((await stream.next()).event, 'hint');
    assert.equal((await stream.next()).event, 'heartbeat');
    f.shared.readOnly = true;
    assert.deepEqual(await stream.nextEvent(), { event: 'invalidate', data: { reason: 'capabilities_changed' } });
    assert.equal(await stream.next(), null);
    assert.equal((await (await f.request('/shared/info')).json()).readOnly, true);
    const readOnly = await frames(await f.request(route));
    assert.equal((await readOnly.next()).event, 'hint');
    f.shared.grants.get(space).delete('sourceA');
    assert.deepEqual(await readOnly.nextEvent(), { event: 'invalidate', data: { reason: 'authorization_lost' } });
    assert.equal(await readOnly.next(), null);
});


test('watch independently hints match preparations and committed shared History', async t => {
    const f = await fixture(t);
    const owner = f.shared.create(f.actor, {
        sharedSpaceId: space, opId: 'createOwner', kind: 'agent', localId: 'localAgent',
        config: {
            name: 'Synthetic', model: 'synthetic', systemPrompt: 'Synthetic',
            temperature: 0.5, contextTokenLimit: 32000, maxOutputTokens: 128,
            streamOutput: false, stripRegexes: [], tavernRules: [],
        },
    }).object;
    const topic = f.shared.create(f.actor, {
        sharedSpaceId: space, opId: 'createTopic', kind: 'topic', parentId: owner.id,
        localId: 'localTopic', localParent: 'localAgent', config: { name: 'Synthetic' },
    }).object;
    const stream = await frames(await f.request(route));
    assert.equal((await stream.next()).event, 'hint');
    f.store.apply({
        ownerType: 'agent', ownerId: 'privateOwner', topicId: 'privateTopic', msgId: 'privateMessage',
        deviceId: 'deviceA', opId: 'publishPrivate', baseHash: null, action: 'upsert',
        message: { id: 'privateMessage', role: 'user', content: 'Synthetic private History', timestamp: 1 },
    });
    f.store.db.prepare('INSERT INTO shared_preparations VALUES(?,?,?)')
        .run('syntheticPlan', 'sourceA', JSON.stringify({ plan: { sharedSpaceId: space } }));
    const match = await stream.next();
    assert.equal(match.event, 'hint');
    assert.deepEqual(match.data.changed, ['matches']);
    const identity = f.shared.row(space, topic.id);
    const message = { id: 'message', role: 'user', content: 'Synthetic History', timestamp: 1 };
    f.store.apply({
        ownerType: identity.owner_type, ownerId: identity.owner_id, topicId: identity.topic_id,
        msgId: message.id, deviceId: 'deviceA', opId: 'publishMessage', baseHash: null, action: 'upsert', message,
    }, { sharedSpace: true });
    const pull = await stream.next();
    assert.equal(pull.event, 'hint');
    assert.deepEqual(pull.data.changed, ['pull']);
    assert.deepEqual(Object.keys(pull.data).sort(), ['changed', 'token']);
    await stream.close();
});

test('quiet space heartbeats check authority and change tokens without reading conversation rows', async t => {
    const f = await fixture(t, { heartbeatMs: 100 });
    const stream = await frames(await f.request(route));
    assert.equal((await stream.next()).event, 'hint');

    const prototype = Object.getPrototypeOf(f.store.db.prepare('SELECT 1'));
    const reads = {};
    const writes = [];
    for (const method of ['get', 'all', 'iterate', 'run']) {
        const original = prototype[method];
        t.mock.method(prototype, method, function (...args) {
            const sql = this.sourceSQL;
            if (!/^\s*SELECT\b/i.test(sql)) writes.push(method);
            for (const match of sql.matchAll(/\b(?:FROM|JOIN)\s+(\w+)/gi)) {
                const table = match[1];
                reads[table] = (reads[table] || 0) + 1;
            }
            return original.apply(this, args);
        });
    }
    for (let i = 0; i < 2; i++) assert.equal((await stream.next()).event, 'heartbeat');
    await stream.close();
    assert.equal(writes.length, 0);
    assert(reads.shared_members >= 2);
    assert(reads.ns_wait_versions >= 2);
    assert.equal(reads.journal, undefined);
    assert.equal(reads.messages, undefined);
    t.diagnostic(JSON.stringify({heartbeatComments:2, tableReads:reads, writes:writes.length}));
});

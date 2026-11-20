'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const { CHAT, fixture } = require('./fixtures/sharedSingleHarness.cjs');
const { createAgentNameOwner } = require(CHAT + '/modules/nativeSyncDesktopRuntime/agentNameOwner.cjs');

test('a missing name receipt can be replayed on its original binding, and a later edit stays intact', async t => {
    const f = await fixture(t);
    const desktop = await f.desktop('A');
    const root = desktop.data;
    const agentId = desktop.descriptor.itemId;
    await desktop.close();
    const host = { appDataRoot: root, readSettings: async () => ({
        vcpServerUrl: 'https://synthetic-shared.invalid/v1/chat/completions', vcpApiKey: 'synthetic-only',
    }) };
    const owner = createAgentNameOwner(host);
    const originalFetch = globalThis.fetch;
    const opIds = [];
    let drops = 2;
    t.mock.method(globalThis, 'fetch', async (url, opts) => {
        const parsed = new URL(url);
        assert.equal(parsed.origin, 'https://synthetic-shared.invalid');
        const response = await originalFetch(f.url + parsed.pathname + parsed.search, opts);
        if (opts.method === 'POST') {
            assert.equal(parsed.pathname, '/api/v1/sync/shared/config');
            opIds.push(JSON.parse(opts.body).opId);
            if (drops) {
                drops--;
                assert.equal(response.status, 200);
                await response.arrayBuffer();
                throw Error('synthetic receipt loss');
            }
        }
        return response;
    });
    const input = { agentId };
    const first = await owner.read(input);
    const attempt = { ...input, editToken: first.editToken, name: 'Renamed' };
    assert.match((await owner.save(attempt)).error, /暂未确认/);
    assert.equal(opIds.length, 2, 'one silent receipt retry');
    const reopened = createAgentNameOwner(host);
    const reopenedEdit = await reopened.read(input);
    const replay = await reopened.save({ ...attempt, editToken: reopenedEdit.editToken });
    assert.equal(replay.success, true);
    assert.equal(replay.name, 'Renamed');
    assert.equal(opIds.length, 3);
    assert.equal(new Set(opIds).size, 1);
    const version = JSON.parse(first.editToken).version;
    assert.equal(JSON.parse(replay.editToken).version, version + 1);
    assert.equal((await owner.save({ ...attempt, name: 'Stale draft' })).success, false);
    const later = await owner.save({ ...input, editToken: replay.editToken, name: 'Later version' });
    assert.equal(later.success, true);
    assert.equal((await owner.save(attempt)).success, false);
    assert.equal((await owner.read(input)).name, 'Later version');
    assert.equal(f.shared.get(f.actor('A'), 'sharedAB', f.owner.id).version, version + 2);

    const file = path.join(root, '.native-sync/connection.json');
    const binding = JSON.parse(await fs.readFile(file));
    await fs.writeFile(file, JSON.stringify({ ...binding, enabled: false }));
    const writes = opIds.length;
    assert.equal((await owner.save({ ...input, editToken: later.editToken, name: 'Detached' })).success, false);
    assert.equal(opIds.length, writes);
});

test('both readers reject rollback and divergent history before another config POST', async t => {
    const f = await fixture(t);
    const sharedSpaceId = 'sharedAB', sharedId = f.owner.id;
    const first = f.shared.get(f.actor('A'), sharedSpaceId, sharedId);
    const change = (object, name, opId) => f.shared.saveConfig(f.actor('A'), {
        sharedSpaceId, sharedId, expectedVersion: object.version, opId, config: { ...object.config, name },
    }).object;
    const second = change(first, 'Version two', 'version-two');
    const a = await f.desktop('A'), b = await f.desktop('B');
    await b.close();
    const rawFetch = globalThis.fetch;
    t.mock.method(globalThis, 'fetch', (url, opts) =>
        rawFetch(String(url).replace('https://synthetic-shared.invalid', f.url), opts));
    const owner = createAgentNameOwner({ appDataRoot: b.data,
        readSettings: async () => ({ vcpServerUrl: 'https://synthetic-shared.invalid', vcpApiKey: 'synthetic-only' }) });
    const input = { agentId: b.descriptor.itemId };
    const route = 'shared/config?' + new URLSearchParams({ sharedSpaceId, sharedId });
    let served, posts = 0;
    f.control.beforeRequest = (req, res, next) => {
        if (req.path.endsWith('/shared/config')) {
            if (req.method === 'POST') posts++;
            if (req.method === 'GET' && req.query.sharedId === sharedId && served) return res.json({ object: served });
        }
        return next();
    };
    const ticket = await owner.read(input);
    for (const [label, object, code] of [
        ['lower', first, 'SHARED_CONFIG_VERSION_REWIND'],
        ['divergent', { ...first, version: second.version }, 'SHARED_CONFIG_RESPONSE_INVALID'],
        ['same', second, null],
        ['higher', change(second, 'Version three', 'version-three'), null],
    ]) {
        served = object;
        if (code) {
            await assert.rejects(a.runtime.sharedConfigRequest({ route }), { code });
            await assert.rejects(owner.read(input), { code });
            const denied = await owner.save({ ...input, editToken: ticket.editToken, name: 'Old ticket' });
            assert.equal(denied.success, false);
        } else {
            assert.deepEqual((await a.runtime.sharedConfigRequest({ route })).object, object);
            assert.equal(JSON.parse((await owner.read(input)).editToken).version, object.version);
        }
        assert.equal(posts, 0, label);
    }
    // A later read must honor the newest successful read on this profile,
    // even when the older full replica has never materialized that config.
    served = second;
    await assert.rejects(owner.read(input), { code: 'SHARED_CONFIG_VERSION_REWIND' });
    assert.equal(posts, 0);
});

test('a v3 save receipt alone prevents a reopened owner from reading v2', async t => {
    const f = await fixture(t);
    const space = 'sharedAB', actor = f.actor('A'), sharedId = f.owner.id;
    const initial = f.shared.get(actor, space, sharedId);
    if (initial.version === 1) f.shared.saveConfig(actor, { sharedSpaceId: space, sharedId, opId: 'seed-second',
        expectedVersion: 1, config: { ...initial.config, name: 'Second' } });
    const v2 = f.shared.get(actor, space, sharedId);
    assert.equal(v2.version, 2);
    const desktop = await f.desktop('A');
    await desktop.close();
    const input = { agentId: desktop.descriptor.itemId };
    const host = { appDataRoot: desktop.data, readSettings: async () => ({
        vcpServerUrl: 'https://synthetic-shared.invalid', vcpApiKey: 'synthetic-only',
    }) };
    const rawFetch = globalThis.fetch;
    let posts = 0;
    t.mock.method(globalThis, 'fetch', (url, opts) => {
        if (new URL(url).pathname.endsWith('/shared/config')) {
            if (opts.method === 'GET') return Response.json({ object: v2 });
            posts++;
        }
        return rawFetch(String(url).replace('https://synthetic-shared.invalid', f.url), opts);
    });
    const owner = createAgentNameOwner(host);
    const first = await owner.read(input);
    const saved = await owner.save({ ...input, editToken: first.editToken, name: 'Third' });
    assert.equal(saved.success, true);
    assert.equal(JSON.parse(saved.editToken).version, 3);
    const reopened = createAgentNameOwner(host);
    await assert.rejects(reopened.read(input), { code: 'SHARED_CONFIG_VERSION_REWIND' });
    assert.equal(posts, 1);
});

test('name-only saves merge unrelated fields, converge without a write and use the displayed conflict', async t => {
    const f = await fixture(t);
    const desktop = await f.desktop('A');
    await desktop.close();
    const host = { appDataRoot: desktop.data, readSettings: async () => ({
        vcpServerUrl: 'https://synthetic-shared.invalid', vcpApiKey: 'synthetic-only',
    }) };
    const rawFetch = globalThis.fetch;
    const bodies = [];
    let beforePost;
    t.mock.method(globalThis, 'fetch', (url, opts) => {
        if (opts.method === 'POST') {
            bodies.push(JSON.parse(opts.body));
            beforePost?.();
        }
        return rawFetch(String(url).replace('https://synthetic-shared.invalid', f.url), opts);
    });
    const owner = createAgentNameOwner(host);
    const input = { agentId: desktop.descriptor.itemId };
    const head = () => f.shared.get(f.actor('B'), 'sharedAB', f.owner.id);
    let seq = 0;
    const peer = fields => {
        const current = head();
        return f.shared.saveConfig(f.actor('B'), { sharedSpaceId: 'sharedAB', sharedId: current.id,
            expectedVersion: current.version, opId: 'peer-' + ++seq, config: { ...current.config, ...fields } }).object;
    };
    const save = (edit, name, choice) => owner.save({ ...input, editToken: edit.editToken, name, choice });
    const first = await owner.read(input);
    peer({ temperature: 0.75, systemPrompt: 'Keep this synthetic prompt' });
    const renamed = await save(first, 'Mine');
    assert.equal(renamed.success, true);
    assert.equal(bodies.length, 1);
    assert.equal(head().config.temperature, 0.75);
    assert.equal(head().config.systemPrompt, 'Keep this synthetic prompt');
    const initialCount = bodies.length;
    assert.equal((await save(first, 'Mine')).name, 'Mine');
    assert.equal((await save(first, first.name)).name, 'Mine');
    const both = await save(first, 'Proposed');
    assert.equal(both.conflict.name, 'Mine');
    peer({ name: 'Third name' });
    const newer = await save(both.conflict, 'Proposed', 'keep-mine');
    assert.equal(newer.conflict.name, 'Third name');
    assert.equal((await save(both.conflict, 'Proposed', 'use-current')).conflict.name, 'Third name');
    assert.equal((await save(newer.conflict, 'Proposed', 'use-current')).name, 'Third name');
    assert.equal(bodies.length, initialCount);
    assert.equal((await save(newer.conflict, 'Proposed', 'keep-mine')).name, 'Proposed');
    assert.equal(bodies.length, initialCount + 1);
    assert.equal(head().config.name, 'Proposed');

    const edit = await owner.read(input);
    beforePost = () => { beforePost = null; peer({ temperature: 0.25 }); };
    const beforeRace = bodies.length;
    assert.equal((await save(edit, 'Retry merge')).success, true);
    assert.equal(bodies.length - beforeRace, 2);
    assert.equal(bodies.at(-1).expectedVersion, bodies.at(-2).expectedVersion + 1);
    assert.equal(bodies.at(-1).config.temperature, 0.25);
    assert.equal(head().config.temperature, 0.25);

    const again = await owner.read(input);
    beforePost = () => { beforePost = null; peer({ name: 'Race winner' }); };
    const beforeClash = bodies.length;
    assert.equal((await save(again, 'Other draft')).conflict.name, 'Race winner');
    assert.equal(bodies.length - beforeClash, 1);

    const busy = await owner.read(input);
    beforePost = () => peer({ systemPrompt: 'Concurrent field ' + seq });
    const beforeBusy = bodies.length;
    assert.equal((await save(busy, 'Busy draft')).success, false);
    assert.equal(bodies.length - beforeBusy, 2, 'continuous changes get at most one rebase');
    assert.equal(head().config.name, 'Race winner');
});

test('a lost reply after a merge silently verifies the exact request even if the peer renames again', async t => {
    const f = await fixture(t);
    const desktop = await f.desktop('A');
    await desktop.close();
    const owner = createAgentNameOwner({ appDataRoot: desktop.data, readSettings: async () => ({
        vcpServerUrl: 'https://synthetic-shared.invalid', vcpApiKey: 'synthetic-only' }) });
    const rawFetch = globalThis.fetch, bodies = [];
    const actor = f.actor('B');
    const head = () => f.shared.get(actor, 'sharedAB', f.owner.id);
    const peer = (fields, opId) => f.shared.saveConfig(actor, { sharedSpaceId: 'sharedAB', sharedId: f.owner.id,
        expectedVersion: head().version, config: { ...head().config, ...fields }, opId });
    t.mock.method(globalThis, 'fetch', async (url, opts) => {
        const res = await rawFetch(String(url).replace('https://synthetic-shared.invalid', f.url), opts);
        if (opts.method === 'POST') {
            bodies.push(opts.body);
            if (bodies.length === 1) {
                assert.equal(res.status, 200);
                await res.arrayBuffer();
                peer({ name: 'After receipt' }, 'after-receipt');
                throw Error('synthetic lost response');
            }
        }
        return res;
    });
    const agentId = desktop.descriptor.itemId;
    const edit = await owner.read({ agentId });
    peer({ systemPrompt: 'Peer prompt' }, 'before-merge');
    const result = await owner.save({ agentId, editToken: edit.editToken, name: 'Mine' });
    assert.equal(result.conflict.name, 'After receipt');
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0], bodies[1]);
    assert.equal(head().config.name, 'After receipt');
    assert.equal(head().config.systemPrompt, 'Peer prompt');
    assert.equal(head().version, JSON.parse(edit.editToken).version + 3);
});

'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const realFs = require('fs-extra');
const engine = require('../modules/tavernRulesEngine');
const handlerFile = require.resolve('../modules/ipc/tavernHandlers');
const handlerRequire = require('node:module').createRequire(handlerFile);
const source = require('node:fs').readFileSync(handlerFile, 'utf8');
async function fixture(t, extraFs = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tavern-shared-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const handlers = new Map(), context = { module: { exports: {} }, structuredClone, console: { log() {}, error() {} }, require(id) {
        if (id === 'electron') return { ipcMain: { handle: (name, cb) => handlers.set(name, cb) } };
        if (id === 'fs-extra') return { ...realFs, ...extraFs };
        if (id === 'path') return path;
        if (id === '../tavernRulesEngine') return engine;
        return handlerRequire(id);
    } };
    vm.runInNewContext(source, context, { filename: handlerFile }); const api = context.module.exports;
    api.initialize({ APP_DATA_ROOT_IN_PROJECT: root });
    return { root, api, handlers };
}
const rule = (id, source = 'user') => ({ id, source, name: id, type: 'system_suffix', enabled: true, content: 'synthetic ' + id, scope: 'global' });
test('shared reads and ordinary IPC use the same version-3 official/user store', { timeout: 3000 }, async t => {
    const x = await fixture(t);
    const result = await x.api.writeStore({ version: 3, rules: [rule('official', 'official'), rule('user')] });
    assert.equal(result.success, true); assert.equal(result.store.version, 3);
    const shared = await x.api.readSharedRules(), normal = await x.handlers.get('tavern:get-rules')();
    assert.deepEqual(shared, normal.store.rules); assert.deepEqual(shared, x.api.getActiveRules());
    assert.equal(shared[0].source, 'official'); assert.equal(shared[1].source, 'user');
    for (const [name, id] of [['VCPChatTarven.json', 'user'], ['VCPChatTarven.official.json', 'official']]) {
        const stored = JSON.parse(await fs.readFile(path.join(x.root, name)));
        assert.equal(stored.version, 3);
        assert.deepEqual(stored.rules.map(rule => rule.id), [id]);
    }
    await assertSharedRuleAdmission(t);
});
test('shared replacement and concurrent ordinary mutation serialize on the original queue', async t => {
    const x = await fixture(t);
    const first = x.api.writeStore({ version: 3, rules: [rule('one')] });
    const second = x.handlers.get('tavern:set-rule-enabled')(null, 'one', false);
    const third = x.handlers.get('tavern:toggle-rule-enabled')(null, 'user:one');
    const results = await Promise.all([first, second, third]); assert.ok(results.every(r => r.success), JSON.stringify(results));
    assert.equal((await x.api.readSharedRules())[0].enabled, true);
    assert.equal(JSON.parse(await fs.readFile(path.join(x.root, 'VCPChatTarven.json'))).rules[0].enabled, true);
});
test('ordinary save remains compatible and unknown rule rejection leaves the shared store intact', async t => {
    const x = await fixture(t); assert.equal((await x.handlers.get('tavern:save-rules')(null, { version: 3, rules: [rule('one')] })).success, true);
    const before = JSON.stringify(await x.api.readSharedRules());
    assert.equal((await x.handlers.get('tavern:set-rule-enabled')(null, 'absent', false)).success, false);
    assert.equal(JSON.stringify(await x.api.readSharedRules()), before);
});
test('failed write reports failure and does not poison subsequent queued changes', { timeout: 3000 }, async t => {
    const officialStarted = Promise.withResolvers(), releaseOfficial = Promise.withResolvers();
    const officialFinished = Promise.withResolvers();
    const attempts = new Map();
    const x = await fixture(t, { async writeJson(file, ...args) {
        const count = (attempts.get(file) || 0) + 1;
        attempts.set(file, count);
        if (count !== 1) return realFs.writeJson(file, ...args);
        if (path.basename(file) === 'VCPChatTarven.json') throw Error('synthetic write fault');
        officialStarted.resolve();
        await releaseOfficial.promise;
        try { return await realFs.writeJson(file, ...args); }
        finally { officialFinished.resolve(); }
    } });
    const store = id => ({ version: 3, rules: [rule(id), rule(id + '-official', 'official')] });
    let firstFinished = false;
    const first = x.api.writeStore(store('one')).then(result => {
        firstFinished = true;
        return result;
    });
    const second = x.api.writeStore(store('two'));
    await officialStarted.promise;
    await new Promise(resolve => setImmediate(resolve));
    const releasedEarly = firstFinished;
    // If a regression releases the queue early, let the second save finish before the late write.
    if (releasedEarly) await second;
    releaseOfficial.resolve();
    const [failed, recovered] = await Promise.all([first, second, officialFinished.promise]);
    assert.equal(failed.success, false);
    assert.equal(failed.error, 'synthetic write fault');
    assert.equal(recovered.success, true);
    assert.equal((await x.api.readSharedRules())[0].id, 'two');
    const official = JSON.parse(await fs.readFile(path.join(x.root, 'VCPChatTarven.official.json')));
    assert.deepEqual(official.rules.map(rule => rule.id), ['two-official'], 'a late write must never overwrite a later save');
    assert.equal(releasedEarly, false, 'the failed write must wait for the other store to settle');
});

async function assertSharedRuleAdmission(t) {
    const x = await fixture(t);
    const { createSharedHost, runtimeForRoot } = handlerRequire('../services/nativeSync/sharedHost');
    const { SharedRuntime } = handlerRequire('../services/nativeSync/sharedRuntime');
    const host = createSharedHost({
        appDataRoot: x.root,
        tavernHandlers: x.api,
        agentConfigManager: {
            readAgentConfig: assert.fail,
            updateAgentConfig: assert.fail,
            writeAgentConfig: assert.fail,
        },
    });
    const read = x.handlers.get('tavern:get-rules');
    const save = x.handlers.get('tavern:save-rules');
    const toggle = x.handlers.get('tavern:toggle-rule-enabled');
    const setEnabled = x.handlers.get('tavern:set-rule-enabled');
    assert.equal((await save(null, { version: 3, rules: [rule('official', 'official'), rule('user')] })).success, true);
    const files = ['VCPChatTarven.json', 'VCPChatTarven.official.json'].map(name => path.join(x.root, name));
    const readFiles = () => Promise.all(files.map(file => fs.readFile(file, 'utf8')));
    const before = await readFiles();

    const published = [];
    const config = { name: 'Synthetic rules', tavernRules: await host.readRules(), executionPolicy: {} };
    const rules = { id: 'rules', kind: 'rules', version: 1, config };
    // Use the real admission methods with a controlled transport and replica.
    const runtime = Object.assign(Object.create(SharedRuntime.prototype), {
        host, readOnly: true, connection: { sharedSpaceId: 'space' },
        state: { objects: { rules } },
        async send(url) {
            assert.equal(url, '/api/v1/sync/shared/config?sharedSpaceId=space&sharedId=rules');
            published.push('read');
            return { object: rules };
        },
        configs: {
            state: { objects: { rules } },
            serial: action => action(),
            async submit(id, kind, value, { expectedVersion }) {
                assert.equal(id, 'rules');
                assert.equal(kind, 'rules');
                assert.equal(expectedVersion, rules.version);
                published.push('submit');
                await host.writeRules(value.tavernRules);
                rules.version++;
            },
        },
    });
    t.after(host.activate(runtime));
    assert.equal(runtimeForRoot(x.root), runtime);
    const { __nativeSyncSharedBase: base } = (await read()).store;
    assert.deepEqual(base, { sharedId: 'rules', version: 1 });
    assert.equal((await toggle(null, 'official:official', { __nativeSyncSharedBase: base })).error, 'SHARED_READ_ONLY');
    runtime.readOnly = false;
    assert.equal((await setEnabled(null, 'user', false)).error, 'SHARED_CONFIG_BASE_REQUIRED');
    assert.equal((await setEnabled(null, 'missing', false, { __nativeSyncSharedBase: base })).error, 'Rule not found.');
    assert.deepEqual(published, []);
    assert.deepEqual(await readFiles(), before);

    const result = await toggle(null, 'official:official', { __nativeSyncSharedBase: base });
    assert.equal(result.success, true, result.error);
    assert.deepEqual(published, ['read', 'submit']);
    assert.deepEqual(result.store.__nativeSyncSharedBase, { sharedId: 'rules', version: 2 });
    const [user, official] = await readFiles();
    assert.deepEqual(JSON.parse(user), JSON.parse(before[0]));
    assert.equal(JSON.parse(official).rules[0].enabled, false);
    assert.equal((await host.readRules()).find(rule => rule.source === 'official').enabled, false);
}

test('a provider write-back waits for an older local write and never publishes itself', { timeout: 3000 }, async t => {
    const entered = Promise.withResolvers(), finish = Promise.withResolvers();
    const x = await fixture(t, { async writeJson(file, value, options) {
        entered.resolve();
        await finish.promise;
        return realFs.writeJson(file, value, options);
    } });
    const older = x.api.writeStore({version:3, rules:[rule('local')]});
    await entered.promise;
    const writes = [];
    const apply = x.api.setRuleProvider(x.root, {
        async writeJson(file, value) {
            writes.push(path.basename(file));
            return realFs.writeJson(file, value, {spaces:2});
        },
        saveRules: assert.fail,
    });
    const newer = apply({version:3, rules:[rule('accepted')]});
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(writes, []);
    finish.resolve();
    assert.equal((await older).success, true);
    assert.equal((await newer).success, true);
    assert.equal(writes.length, 2);
    assert.equal((await x.api.readStore()).rules[0].id, 'accepted');

    x.api.setRuleProvider(x.root, null);
    await assert.rejects(apply({version:3, rules:[]}), /disconnected/);
    assert.equal((await x.api.writeStore({version:3, rules:[rule('local-again')]})).success, true);
    assert.equal((await x.api.readStore()).rules[0].id, 'local-again');
});

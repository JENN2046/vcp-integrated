'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');
const { fixture, CHAT } = require('./fixtures/sharedSingleHarness.cjs');
const loadGroup = require('./fixtures/nativeGroupModule.cjs');
const { saveNativeOwnerConfig } = require(CHAT + '/modules/services/nativeSync/nativeConfigSave');
const ipcPath = CHAT + '/modules/ipc/groupChatHandlers.js';
const hostRequire = createRequire(ipcPath);
const groupFs = hostRequire('fs-extra');

async function installGroupIpc(desktop) {
    const group = loadGroup(CHAT);
    const paths = {
        APP_DATA_ROOT_IN_PROJECT: desktop.data,
        AGENT_DIR: desktop.data + '/Agents',
        USER_DATA_DIR: desktop.data + '/UserData',
    };
    group.initializePaths(paths);
    const handlers = new Map();
    const module = { exports: {} };
    // Register the actual main-process handlers without starting Electron.
    new Function('require', 'module', await fs.readFile(ipcPath, 'utf8'))(name => {
        if (name === 'electron') {
            return { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } };
        }
        if (name === '../../Groupmodules/groupchat') return group;
        return hostRequire(name);
    }, module);
    module.exports.initialize({}, {
        ...paths,
        historyMutationQueue: desktop.queue,
        saveOwnerConfig: request => saveNativeOwnerConfig({ root: desktop.data, ...request }),
    });
    return {
        group,
        read: id => handlers.get('get-agent-group-config')({}, id),
        save: (id, payload) => handlers.get('save-agent-group-config')({}, id, payload),
    };
}

async function createGroup(t) {
    const service = await fixture(t);
    const desktop = await service.desktop('A');
    const object = service.shared.create(service.actor('A'), {
        sharedSpaceId: 'sharedAB',
        opId: 'create-receipt-test-group',
        kind: 'group',
        localId: 'receipt-test-group',
        config: { name: 'Original', mode: 'invite_only', members: [service.owner.id] },
    }).object;
    await desktop.runtime.tick();
    const id = desktop.runtime.localFor(object.id).localId;
    const file = path.join(desktop.data, 'AgentGroups', id, 'config.json');
    const ipc = await installGroupIpc(desktop);
    t.after(() => assert.equal(service.calls(), 0));
    return { service, desktop, object, id, file, ipc, initial: await ipc.read(id) };
}

function observeConfigPosts(runtime, sharedId, posts, dropFirstReceipt = false) {
    const send = runtime.configs.send;
    runtime.configs.send = async (route, options) => {
        const response = await send(route, options);
        if (route.endsWith('/config') && options?.body?.sharedId === sharedId) {
            posts.push({
                body: structuredClone(options.body),
                version: response.object.version,
                replayed: response.replayed === true,
            });
            if (dropFirstReceipt && posts.length === 1) {
                throw Object.assign(new Error('Lost accepted configuration receipt'), { code: 'NETWORK_UNAVAILABLE' });
            }
        }
        return response;
    };
}

async function readJson(file) {
    return JSON.parse(await fs.readFile(file, 'utf8'));
}

test('a lost group receipt keeps the original request and rejects a new edit until replay', async t => {
    const { service, desktop, object, id, file, ipc, initial } = await createGroup(t);
    const runtime = desktop.runtime;
    const posts = [];
    observeConfigPosts(runtime, object.id, posts, true);
    // The native form omits the portable rules field. Its retry may not fill it
    // from a newer remote configuration.
    const { nativeSyncSharedRules, ...fields } = initial;
    const payload = { ...fields, name: 'Saved first', localOnlyPreference: 'Device only' };
    const first = await ipc.save(id, payload);
    assert.deepEqual(first, { success: false, error: 'SHARED_CONFIG_PENDING_CONFIRMATION' });
    const pending = (await readJson(runtime.configs.statePath)).drafts[object.id];
    assert.equal(pending.opId, posts[0].body.opId);
    assert.equal(pending.expectedVersion, object.version);
    assert.equal(pending.submitted, true);
    assert.equal(pending.config.name, payload.name);
    assert.equal(Object.hasOwn(posts[0].body.config, 'localOnlyPreference'), false);
    assert.equal((await readJson(file)).name, initial.name);

    const accepted = service.shared.get(service.actor('A'), 'sharedAB', object.id);
    assert.equal(accepted.version, object.version + 1);
    assert.equal(accepted.config.name, payload.name);
    const rule = {
        id: 'remote-rule', name: 'Remote edit', enabled: true, type: 'system_suffix',
        scope: 'group', source: 'user', content: 'Synthetic rule',
    };
    await desktop.close();
    service.shared.saveConfig(service.actor('B'), {
        sharedSpaceId: 'sharedAB', sharedId: object.id, expectedVersion: accepted.version,
        opId: 'another-device-edit', config: { ...accepted.config, tavernRules: [rule] },
    });
    const reopened = await service.desktop('A');
    const resumedIpc = await installGroupIpc(reopened);
    observeConfigPosts(reopened.runtime, object.id, posts);
    assert.deepEqual((await readJson(reopened.runtime.configs.statePath)).drafts[object.id], pending);

    const attemptedEdit = await resumedIpc.save(id, { ...payload, name: 'Newer unsent edit' });
    assert.deepEqual(attemptedEdit, { success: false, error: 'SHARED_CONFIG_PENDING_CONFIRMATION' });
    assert.equal(posts.length, 1);
    assert.deepEqual((await readJson(reopened.runtime.configs.statePath)).drafts[object.id], pending);

    const repeated = await resumedIpc.save(id, payload);
    assert.equal(repeated.success, true);
    assert.equal(repeated.sharedVersion, accepted.version);
    assert.equal(posts.length, 2);
    assert.deepEqual(posts[1].body, posts[0].body);
    assert.equal(posts[1].replayed, true);

    await reopened.runtime.tick({ forceLocal: true });
    const local = await readJson(file);
    const replica = await readJson(reopened.runtime.configs.statePath);
    const latest = service.shared.get(service.actor('A'), 'sharedAB', object.id);
    assert.equal(latest.version, accepted.version + 1);
    assert.equal(latest.config.name, payload.name);
    assert.equal(replica.objects[object.id].version, latest.version);
    assert.equal(replica.drafts[object.id], undefined);
    assert.equal(local.localOnlyPreference, payload.localOnlyPreference);
    assert.deepEqual(local.nativeSyncSharedRules.map(({ id }) => id), [rule.id]);
    assert.equal(Object.hasOwn(local, '__nativeSyncSharedBase'), false);
});

for (const readFailure of ['throws', 'returns null after EIO']) {
    test('a confirmed group save stays successful when its refresh ' + readFailure, async t => {
        const { desktop, object, id, file, ipc, initial } = await createGroup(t);
        const posts = [];
        observeConfigPosts(desktop.runtime, object.id, posts);
        const get = ipc.group.getAgentGroupConfig;
        ipc.group.getAgentGroupConfig = async (...args) => {
            if (readFailure === 'throws') throw new Error('Synthetic post-save read failure');
            const original = groupFs.readJson;
            groupFs.readJson = async filename => {
                if (filename !== file) return original(filename);
                throw Object.assign(new Error('Synthetic config read failure'), { code: 'EIO' });
            };
            try { return await get(...args); }
            finally { groupFs.readJson = original; }
        };
        const saved = await ipc.save(id, { ...initial, name: 'Edited', localOnlyPreference: 'Device only' });
        assert.equal(saved.success, true);
        assert.equal(saved.sharedVersion, object.version + 1);
        assert.equal(saved.refreshError, 'SHARED_CONFIG_REFRESH_FAILED');
        assert.equal(saved.extrasError, undefined);
        assert.equal(saved.agentGroup, undefined);
        assert.equal(posts.length, 1);
        const local = await readJson(file);
        assert.equal(local.name, 'Edited');
        assert.equal(local.localOnlyPreference, 'Device only');
    });
}

for (const changeSharedName of [true, false]) {
    test(`an extras write failure is separate from ${changeSharedName ? 'a confirmed shared save' : 'an unchanged shared configuration'}`, async t => {
        const { desktop, object, id, file, ipc, initial } = await createGroup(t);
        const posts = [];
        const runtime = desktop.runtime;
        observeConfigPosts(runtime, object.id, posts);
        const writeExtras = runtime.host.writeNativeExtras;
        let failures = 0;
        runtime.host.writeNativeExtras = async (...args) => {
            if (failures) return writeExtras(...args);
            const rename = fs.rename;
            fs.rename = async (from, to) => {
                if (to !== file) return rename(from, to);
                failures++;
                throw Object.assign(new Error('Synthetic extras rename failure'), { code: 'EIO' });
            };
            try { return await writeExtras(...args); }
            finally { fs.rename = rename; }
        };
        const name = changeSharedName ? 'Edited' : initial.name;
        const payload = { ...initial, name, localOnlyPreference: 'Device only' };
        const saved = await ipc.save(id, payload);
        assert.equal(failures, 1);
        assert.equal(saved.refreshError, undefined);
        assert.equal(posts.length, changeSharedName ? 1 : 0);
        const local = await readJson(file);
        assert.equal(local.name, name);
        assert.equal(local.localOnlyPreference, undefined);
        if (changeSharedName) {
            assert.equal(saved.success, true);
            assert.equal(saved.sharedVersion, object.version + 1);
            assert.equal(saved.extrasError, 'SHARED_CONFIG_EXTRAS_FAILED');
            assert.equal(saved.agentGroup.name, name);
        } else {
            assert.deepEqual(saved, { success: false, error: 'SHARED_CONFIG_EXTRAS_FAILED' });
        }

        const version = saved.sharedVersion ?? object.version;
        const retry = await ipc.save(id, {
            ...payload, __nativeSyncSharedBase: { sharedId: object.id, version },
        });
        assert.equal(retry.success, true);
        assert.equal(retry.sharedVersion, version);
        assert.equal(retry.extrasError, undefined);
        assert.equal(posts.length, changeSharedName ? 1 : 0);
        assert.equal((await readJson(file)).localOnlyPreference, payload.localOnlyPreference);
    });
}

test('keeping an advanced conflict draft commits a fresh operation on the rebased version', async t => {
    const { service, desktop, object, id, file, ipc, initial } = await createGroup(t);
    const { runtime } = desktop;
    const posts = [];
    observeConfigPosts(runtime, object.id, posts);
    const readDraft = async () => (await readJson(runtime.configs.statePath)).drafts[object.id];
    const currentServer = () => service.shared.get(service.actor('A'), 'sharedAB', object.id);
    const original = await ipc.save(id, { ...initial, name: 'Original committed operation' });
    assert.equal(original.success, true);
    assert.equal(posts.length, 1);
    const originalReceipt = posts[0];

    const staleForm = { ...original.agentGroup, name: 'Keep this native draft' };
    const accepted = currentServer();
    const remote = service.shared.saveConfig(service.actor('B'), {
        sharedSpaceId: 'sharedAB', sharedId: object.id, expectedVersion: accepted.version,
        opId: 'conflicting-device-operation', config: { ...accepted.config, name: 'Conflicting remote name' },
    }).object;
    const staleSave = await ipc.save(id, staleForm);
    assert.equal(staleSave.success, false);
    assert.equal(staleSave.error, 'SHARED_CONFIG_CONFLICT');
    const conflicting = await readDraft();
    assert.equal(conflicting.conflict, true);
    assert.equal(conflicting.submitted, false);
    assert.equal(conflicting.config.name, staleForm.name);
    assert.notEqual(conflicting.opId, originalReceipt.body.opId);

    // Run the same advanced conflict action as the native form. Confirming
    // "keep local" updates the form base and requires a separate save click.
    const { offerNativeConfigurationRebase } = await import(CHAT + '/modules/chat/nativeConfigurationActions.mjs');
    let rebasedMarker;
    assert.equal(await offerNativeConfigurationRebase({
        api: {
            sharedConfigContext: () => runtime.sharedConfigContext(),
            sharedConfigRequest: request => runtime.sharedConfigRequest(request),
        },
        base: staleForm.__nativeSyncSharedBase,
        uiHelper: { showConfirmDialog: async () => true },
        onVersion: marker => { rebasedMarker = marker; },
    }), true);
    assert.deepEqual(rebasedMarker, { sharedId: object.id, version: remote.version });
    const rebased = await readDraft();
    assert.equal(rebased.conflict, false);
    assert.equal(rebased.expectedVersion, remote.version);
    assert.deepEqual(rebased.config, conflicting.config);
    assert.notEqual(rebased.opId, conflicting.opId);
    assert.notEqual(rebased.opId, originalReceipt.body.opId);
    assert.equal(posts.length, 1);
    assert.equal(currentServer().version, remote.version);

    const committed = await ipc.save(id, { ...staleForm, __nativeSyncSharedBase: rebasedMarker });
    assert.equal(committed.success, true);
    assert.equal(committed.sharedVersion, remote.version + 1);
    assert.equal(posts.length, 2);
    assert.notEqual(posts[1].body.opId, originalReceipt.body.opId);
    assert.notEqual(posts[1].body.opId, conflicting.opId);
    assert.equal(posts[1].body.expectedVersion, remote.version);
    assert.equal(posts[1].replayed, false);
    assert.equal(currentServer().config.name, staleForm.name);
    assert.equal((await readJson(file)).name, staleForm.name);
    assert.equal(await readDraft(), undefined);
});

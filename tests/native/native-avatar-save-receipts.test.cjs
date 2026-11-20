'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { createRequire } = require('node:module');
const { fixture, CHAT } = require('./fixtures/sharedSingleHarness.cjs');
const loadGroup = require('./fixtures/nativeGroupModule.cjs');
const AgentConfigManager = require(CHAT + '/modules/utils/agentConfigManager');
const { saveNativeOwnerConfig, saveNativeOwnerAvatar } = require(CHAT + '/modules/services/nativeSync/nativeConfigSave');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const projectedAvatar = 'data:image/png;base64,' + png.toString('base64');
const avatar = { name: 'synthetic.png', type: 'image/png', buffer: png };
const failure = (code, message) => Object.assign(new Error(message), { code });
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));

async function installIpc(desktop, kind, id) {
    const group = kind === 'group' ? loadGroup(CHAT) : undefined;
    const ipcPath = CHAT + '/modules/ipc/' + (group ? 'groupChatHandlers' : 'agentHandlers') + '.js';
    const hostRequire = createRequire(ipcPath);
    const handlers = new Map();
    const module = { exports: {} };
    const context = {
        APP_DATA_ROOT_IN_PROJECT: desktop.data,
        AGENT_DIR: desktop.data + '/Agents',
        USER_DATA_DIR: desktop.data + '/UserData',
        historyMutationQueue: desktop.queue,
        getSelectionListenerStatus: () => false,
        saveOwnerConfig: request => saveNativeOwnerConfig({ root: desktop.data, ...request }),
        saveOwnerAvatar: request => saveNativeOwnerAvatar({ root: desktop.data, ...request }),
    };
    context.agentConfigManager = new AgentConfigManager(context.AGENT_DIR);
    new Function('require', 'module', await fs.readFile(ipcPath, 'utf8'))(name => {
        if (name === 'electron') {
            return { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } };
        }
        if (name === '../../Groupmodules/groupchat') return group;
        return hostRequire(name);
    }, module);
    if (group) {
        group.initializePaths(context);
        module.exports.initialize({}, context);
    } else {
        module.exports.initialize(context);
    }
    return {
        group,
        read: () => handlers.get(group ? 'get-agent-group-config' : 'get-agent-config')({}, id),
        save: payload => handlers.get(group ? 'save-agent-group-config' : 'save-agent-config')({}, id, payload),
        saveAvatar: payload => handlers.get(group ? 'save-agent-group-avatar' : 'save-avatar')({}, id, payload),
    };
}

async function setup(t, kind) {
    const service = await fixture(t);
    const desktop = await service.desktop('A');
    const object = kind === 'agent' ? service.owner : service.shared.create(service.actor('A'), {
        sharedSpaceId: 'sharedAB',
        opId: 'create-avatar-test-group',
        kind,
        localId: 'avatar-test-group',
        config: { name: 'Original group', mode: 'invite_only', members: [service.owner.id] },
    }).object;
    await desktop.runtime.tick();
    const id = desktop.runtime.localFor(object.id).localId;
    const dir = path.join(desktop.data, kind === 'group' ? 'AgentGroups' : 'Agents', id);
    const ipc = await installIpc(desktop, kind, id);
    const initial = await ipc.read();
    assert.deepEqual(initial.__nativeSyncSharedBase, { sharedId: object.id, version: object.version });
    const config = { ...initial, name: 'Edited ' + kind, __nativeSyncAvatar: avatar };
    const server = () => service.shared.get(service.actor('A'), 'sharedAB', object.id);
    const state = () => readJson(desktop.runtime.configs.statePath);
    const configPath = path.join(dir, 'config.json');
    const local = () => readJson(configPath);
    const avatarPath = path.join(dir, 'avatar.png');
    const posts = [];
    const observe = (runtime, dropFirst = false) => {
        const send = runtime.configs.send;
        runtime.configs.send = async (route, options) => {
            const response = await send(route, options);
            if (route.endsWith('/config') && options?.body?.sharedId === object.id) {
                posts.push({ body: structuredClone(options.body), version: response.object.version, replayed: response.replayed === true });
                if (dropFirst && posts.length === 1) throw failure('NETWORK_UNAVAILABLE', 'Synthetic accepted response lost');
            }
            return response;
        };
    };
    t.after(() => assert.equal(service.calls(), 0));
    return { service, desktop, object, id, ipc, initial, config, server, state, local, configPath, avatarPath, posts, observe };
}

async function injectRenameFailure(file, run) {
    const rename = fs.rename;
    let failures = 0;
    fs.rename = async (from, to) => {
        if (to !== file || failures) return rename(from, to);
        failures++;
        throw failure('EIO', 'Synthetic atomic native file replacement failure');
    };
    try {
        const result = await run();
        assert.equal(failures, 1);
        return result;
    } finally {
        fs.rename = rename;
    }
}

function recordReceipt(t, kind, scenario, fixture, retry) {
    t.diagnostic('avatar-receipt ' + JSON.stringify({
        kind, scenario, before: fixture.object.version, after: fixture.server().version, retry,
        requests: fixture.posts.map(({body, version, replayed}) => ({
            opId: body.opId, expectedVersion: body.expectedVersion, version, replayed,
        })),
    }));
}

for (const kind of ['agent', 'group']) {
    test(kind + ' preserves native name-save behavior on invalid staged avatar', async t => {
        const f = await setup(t, kind);
        f.observe(f.desktop.runtime);
        const result = await f.ipc.save({ ...f.config, __nativeSyncAvatar: { ...avatar, type: 'application/octet-stream' } });
        assert.deepEqual(result.avatarResult, { success: false, error: 'INVALID_AVATAR' }, JSON.stringify(result));
        assert.equal(result.success, kind === 'group');
        assert.equal(f.posts.length, kind === 'group' ? 1 : 0);
        const expected = kind === 'group' ? f.config.name : f.initial.name;
        assert.equal(f.server().config.name, expected);
        assert.equal((await f.local()).name, expected);
        assert.equal(f.server().config.avatar ?? null, null);
        await assert.rejects(fs.access(f.avatarPath), { code: 'ENOENT' });
        recordReceipt(t, kind, 'invalid-avatar', f, null);
    });

    test(kind + ' replays the frozen avatar and name when the accepted response disappears', async t => {
        const f = await setup(t, kind);
        f.observe(f.desktop.runtime, true);
        const result = await f.ipc.save(f.config);
        assert.equal(result.success, false);
        assert.equal(result.error, 'SHARED_CONFIG_PENDING_CONFIRMATION');
        assert.equal(f.server().version, f.object.version + 1);
        assert.equal(f.server().config.name, f.config.name);
        assert.equal(f.server().config.avatar, projectedAvatar);
        assert.equal((await f.local()).name, f.initial.name);
        await assert.rejects(fs.access(f.avatarPath), { code: 'ENOENT' });
        const pending = (await f.state()).drafts[f.object.id];
        assert.equal(pending.opId, f.posts[0].body.opId);
        assert.equal(pending.submitted, true);
        await f.desktop.close();
        const reopened = await f.service.desktop('A');
        f.observe(reopened.runtime);
        const ipc = await installIpc(reopened, kind, f.id);
        const different = await ipc.save({ ...f.config, name: 'A different draft' });
        assert.equal(different.error, 'SHARED_CONFIG_PENDING_CONFIRMATION');
        assert.equal(f.posts.length, 1);
        assert.deepEqual((await f.state()).drafts[f.object.id], pending);
        const replay = await ipc.save(f.config);
        assert.equal(replay.success, true);
        assert.equal(replay.sharedVersion, f.object.version + 1);
        assert.equal(replay.avatarResult.success, true);
        assert.equal(fileURLToPath(replay.avatarResult.avatarUrl), f.avatarPath);
        assert.equal(f.posts.length, 2);
        assert.deepEqual(f.posts[0].body, f.posts[1].body);
        assert.equal(f.posts[1].replayed, true);
        assert.equal(f.server().version, f.object.version + 1);
        assert.equal((await f.state()).drafts[f.object.id], undefined);
        assert.deepEqual(await fs.readFile(f.avatarPath), png);
        const confirmedBase = (await ipc.read()).__nativeSyncSharedBase;
        const unchanged = await ipc.save({ ...f.config, __nativeSyncSharedBase: confirmedBase });
        assert.equal(unchanged.success, true);
        assert.equal(unchanged.sharedVersion, replay.sharedVersion);
        assert.equal(f.posts.length, 2);
        assert.equal(f.server().version, replay.sharedVersion);
        const other = await f.service.desktop('B');
        await other.runtime.tick({ forceLocal: true });
        const otherId = other.runtime.localFor(f.object.id).localId;
        const otherIpc = await installIpc(other, kind, otherId);
        const otherConfig = await otherIpc.read();
        assert.equal(otherConfig.name, f.config.name);
        assert.deepEqual(await fs.readFile(fileURLToPath(otherConfig.avatarUrl)), png);
        recordReceipt(t, kind, 'lost-receipt', f, { success: replay.success, sharedVersion: replay.sharedVersion, repeatVersion: unchanged.sharedVersion });
    });

    test(kind + ' confirms the shared save while native avatar materialization is interrupted', async t => {
        const f = await setup(t, kind);
        f.observe(f.desktop.runtime);
        const result = await injectRenameFailure(f.avatarPath, () => f.ipc.save(f.config));
        assert.equal(result.success, true);
        assert.equal(result.sharedVersion, f.object.version + 1);
        assert.equal(result.refreshError, 'SHARED_CONFIG_REFRESH_FAILED');
        assert.equal(f.posts.length, 1);
        assert.equal(f.server().config.name, f.config.name);
        assert.equal(f.server().config.avatar, projectedAvatar);
        await assert.rejects(fs.access(f.avatarPath), { code: 'ENOENT' });
        const pending = await f.state();
        assert.equal(pending.intent.object.version, result.sharedVersion);
        assert.equal(pending.drafts[f.object.id].nativeSave.receipt.opId, f.posts[0].body.opId);
        const retry = await f.ipc.save(f.config);
        assert.equal(retry.success, true);
        assert.equal(retry.sharedVersion, result.sharedVersion);
        assert.equal(retry.refreshError, undefined);
        assert.equal(f.posts.length, 1);
        assert.equal(f.server().version, result.sharedVersion);
        assert.equal((await f.state()).intent, null);
        assert.equal((await f.state()).drafts[f.object.id], undefined);
        assert.deepEqual(await fs.readFile(f.avatarPath), png);
        assert.equal((await f.local()).name, f.config.name);
        recordReceipt(t, kind, 'avatar-materialization-eio', f, { success: retry.success, sharedVersion: retry.sharedVersion });
    });

    test(kind + ' preserves confirmed avatar and name through local extras and refresh failures', async t => {
        const f = await setup(t, kind);
        const { runtime } = f.desktop;
        f.observe(runtime);
        const writeExtras = runtime.host.writeNativeExtras;
        runtime.host.writeNativeExtras = (...args) => injectRenameFailure(f.configPath, () => writeExtras(...args));
        const readAvatarUrl = runtime.host.nativeAvatarUrl;
        runtime.host.nativeAvatarUrl = async () => {
            await fs.access(f.avatarPath);
            throw failure('EIO', 'Synthetic post-commit avatar URL read failure');
        };
        const config = { ...f.config, localOnlyPreference: 'Device only' };
        const saved = await f.ipc.save(config);
        assert.equal(saved.success, true);
        assert.equal(saved.sharedVersion, f.object.version + 1);
        assert.equal(saved.extrasError, 'SHARED_CONFIG_EXTRAS_FAILED');
        assert.equal(saved.refreshError, 'SHARED_CONFIG_REFRESH_FAILED');
        assert.equal(saved.avatarResult.avatarUrl, undefined);
        assert.equal(f.posts.length, 1);
        assert.equal(f.server().config.name, config.name);
        assert.equal(f.server().config.avatar, projectedAvatar);
        assert.equal((await f.local()).name, config.name);
        assert.equal((await f.local()).localOnlyPreference, undefined);
        assert.equal(Object.hasOwn(await f.local(), '__nativeSyncAvatar'), false);
        assert.deepEqual(await fs.readFile(f.avatarPath), png);
        runtime.host.writeNativeExtras = writeExtras;
        runtime.host.nativeAvatarUrl = readAvatarUrl;
        const retry = await f.ipc.save({
            ...config, __nativeSyncSharedBase: { sharedId: f.object.id, version: saved.sharedVersion },
        });
        assert.equal(retry.success, true);
        assert.equal(retry.sharedVersion, saved.sharedVersion);
        assert.equal(retry.extrasError, undefined);
        assert.equal(retry.refreshError, undefined);
        assert.equal(f.posts.length, 1);
        assert.equal(f.server().version, saved.sharedVersion);
        assert.equal((await f.local()).localOnlyPreference, config.localOnlyPreference);
        assert.equal(Object.hasOwn(await f.local(), '__nativeSyncAvatar'), false);
        assert.equal(fileURLToPath(retry.avatarResult.avatarUrl), f.avatarPath);
        recordReceipt(t, kind, 'extras-and-refresh-eio', f, { success: retry.success, sharedVersion: retry.sharedVersion });
    });

    test(kind + ' standalone avatar replays acceptance without a duplicate version', async t => {
        const f = await setup(t, kind);
        f.observe(f.desktop.runtime, true);
        const payload = { ...avatar, __nativeSyncSharedBase: f.initial.__nativeSyncSharedBase };
        const first = await f.ipc.saveAvatar(payload);
        assert.equal(first.error, 'SHARED_CONFIG_PENDING_CONFIRMATION');
        assert.equal(f.server().config.avatar, projectedAvatar);
        assert.equal(f.server().config.name, f.initial.name);
        assert.equal(f.server().version, f.object.version + 1);
        const retry = await f.ipc.saveAvatar(payload);
        assert.equal(retry.success, true);
        assert.equal(retry.sharedVersion, f.object.version + 1);
        assert.equal(f.posts.length, 2);
        assert.deepEqual(f.posts[0].body, f.posts[1].body);
        assert.equal(f.posts[1].replayed, true);
        assert.equal(f.server().version, f.object.version + 1);
        assert.deepEqual(await fs.readFile(f.avatarPath), png);
        recordReceipt(t, kind, 'standalone-lost-receipt', f, { success: retry.success, sharedVersion: retry.sharedVersion });
    });
}

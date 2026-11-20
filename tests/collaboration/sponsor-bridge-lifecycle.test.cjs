'use strict';
const {BOX}=require('./fixtures/paths.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const toolbox = BOX;
const { createDefaultExecutionBridgeRegistry } = require(toolbox + '/modules/pluginBridgeRegistry');
const nativeSync = require(toolbox + '/Plugin/NativeSync/native-sync');
const sponsorBridge = require(toolbox + '/Plugin/NativeSync/sync/sponsorExecutionBridge');
const bridgeName = 'nativesync-topic-sponsor';
const bridgeRegistration = { name: bridgeName, priority: 401 };

function harness() {
    const registry = createDefaultExecutionBridgeRegistry();
    const calls = [];
    const wireReply = { status: 'success', result: 'synthetic ordinary result' };
    const webSocketServer = {
        async executeDistributedTool(serverId, toolName, args) {
            calls.push({ serverId, toolName, args });
            return wireReply;
        },
        bindDistributedTool() {
            assert.fail('ordinary distributed tool used a scoped binding');
        },
    };
    const execute = (name, args) => registry.execute({ name, isDistributed: true, serverId: 'ordinary-peer' }, args, {
        toolName: name,
        executionOptions: {},
        webSocketServer,
        debugMode: false,
        debugLog() {},
    });
    return { registry, calls, wireReply, execute };
}

async function legacySponsor(h) {
    const args = {
        command: 'ReplyToTopic',
        topic_id: 'native-topic',
        message: 'ordinary synthesis',
        river_context: [{ role: 'assistant', content: 'legacy context' }],
        _nativeSyncTopicSponsor: { operationId: 'forged-at-caller' },
    };
    const { _nativeSyncTopicSponsor: spoof, ...expected } = args;
    const prior = h.calls.length;
    assert.deepEqual(await h.execute('TopicSponsor', args), { result: h.wireReply });
    assert.equal(h.calls.length, prior + 1);
    assert.deepEqual(h.calls.at(-1), { serverId: 'ordinary-peer', toolName: 'TopicSponsor', args: expected });
    assert.deepEqual(args._nativeSyncTopicSponsor, spoof, 'bridge must not modify caller arguments');
}

test('the NativeSync bridge installs once through the stock registry and leaves other tools on their original path', async () => {
    const h = harness();
    const defaultBridges = h.registry.list();
    sponsorBridge.register(h.registry);
    sponsorBridge.register(h.registry);
    assert.deepEqual(h.registry.list().filter(row => row.name === bridgeName), [bridgeRegistration]);
    assert.deepEqual(h.registry.list().filter(row => row.name !== bridgeName), defaultBridges);
    assert.ok(h.registry.list().findIndex(row => row.name === bridgeName) <
        h.registry.list().findIndex(row => row.name === 'distributed'));

    await legacySponsor(h);

    const otherArgs = { command: 'Synthetic', _nativeSyncTopicSponsor: { opaque: 'unrelated to this tool' } };
    assert.deepEqual(await h.execute('SecondTool', otherArgs), { result: h.wireReply });
    assert.deepEqual(h.calls.at(-1), { serverId: 'ordinary-peer', toolName: 'SecondTool', args: otherArgs });
});

test('real NativeSync service initialization is idempotent through disabled, configuration-only and shutdown states', async t => {
    const h = harness();
    const pluginManager = { executionBridgeRegistry: h.registry };
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ns-sponsor-bridge-'));
    t.after(async () => {
        await nativeSync.shutdown();
        await fs.rm(dir, { recursive: true, force: true });
    });
    const config = {
        NativeSyncEnabled: true,
        NativeMobileEnabled: false,
        PROJECT_BASE_PATH: path.dirname(dir),
        NativeSyncDataDir: dir,
        NativeSyncFullSources: JSON.stringify([{ sourceId: 'source-a', deviceId: 'device-a', executionMode: 'all-supported' }]),
        NativeSyncSharedSpaces: JSON.stringify([{ id: 'shared-a', sources: ['source-a'] }]),
    };

    await nativeSync.initialize({ NativeSyncEnabled: false }, { pluginManager });
    assert.equal(nativeSync.snapshot().ready, false);
    assert.deepEqual(h.registry.list().filter(row => row.name === bridgeName), [bridgeRegistration]);
    await legacySponsor(h);

    await nativeSync.initialize(config, { pluginManager });
    assert.equal(nativeSync.snapshot().ready, true);
    assert.equal(nativeSync.snapshot().mobile, null);
    assert.deepEqual(h.registry.list().filter(row => row.name === bridgeName), [bridgeRegistration]);
    await legacySponsor(h);

    await assert.rejects(
        nativeSync.initialize({ ...config, NativeSyncSharedSpaces: 'invalid synthetic config' }, { pluginManager }),
        { code: 'INVALID_SHARED_GRANTS' }
    );
    assert.equal(nativeSync.snapshot().ready, false);
    assert.deepEqual(h.registry.list().filter(row => row.name === bridgeName), [bridgeRegistration]);
    await legacySponsor(h);

    await nativeSync.initialize(config, { pluginManager });
    assert.equal(nativeSync.snapshot().ready, true);
    assert.deepEqual(h.registry.list().filter(row => row.name === bridgeName), [bridgeRegistration]);
    await legacySponsor(h);

    await nativeSync.shutdown();
    assert.equal(nativeSync.snapshot().ready, false);
    await legacySponsor(h);
});

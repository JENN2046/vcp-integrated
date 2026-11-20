'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const chat = path.resolve(__dirname, '../../apps/desktop');
const { SharedTopicSponsor, createSharedTopicSponsorDelivery } = require(chat + '/modules/services/nativeSync/sharedTopicSponsor');
const { PluginAgentOperationService } = require(chat + '/modules/services/pluginAgentOperationService');
const operationId = 'sponsor_' + '1'.repeat(32);
const proof = 'aedf3797-db35-45e6-8796-f78d161f8542';
const args = {
    command: 'ReplyToTopic', source_topic_id: 'source', topic_id: 'target', message: 'Synthetic delivery',
    river_context: [{ role: 'user', content: 'First' }, { role: 'assistant', content: 'Second' }],
};
const context = { requestId: 'real-transport-fixture', vcpContext: { agentId: 'origin', topicId: 'source' } };

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ns-topic-sponsor-desktop-'));
    t.after(() => fs.rm(root, { force: true, recursive: true }));
    const source = { itemType: 'agent', itemId: 'origin', topicId: 'source' };
    const target = { itemType: 'agent', itemId: 'destination', topicId: 'target' };
    const receipt = {
        operationId, sourceSharedId: 's_source', targetSharedId: 's_target', seq: 5, workId: 'work',
        message_id: 'message', topic_id: 'target', target_id: 'destination', target_type: 'agent', sender_id: 'origin',
    };
    const requests = [];
    let committed = false;
    function open() {
        const runtime = {
            root, dir: path.join(root, '.native-sync/shared/sharedAB'), ready: true, isStopping: () => false,
            readOnly: false, capabilities: { features: ['shared-topic-sponsor-v1'] },
            binding: () => ({ sharedSpaceId: 'sharedAB', sourceId: 'sourceA', deviceId: 'deviceA', sourceRoot: root }),
            state: { objects: {
                s_source: { kind: 'topic', parentId: 's_origin' }, s_target: { kind: 'topic', parentId: 's_destination' },
                s_origin: { kind: 'agent', id: 's_origin' }, s_destination: { kind: 'agent', id: 's_destination' },
            } },
            isLocalVisible: () => true, matching: { assert() {} }, scheduleTick() {},
            mappings: () => [
                { sharedId: 's_source', local: source, shared: { ...source, topicId: 'canonical_source' } },
                { sharedId: 's_target', local: target, shared: { ...target, topicId: 'canonical_target' } },
            ],
            execution: {
                mapping: descriptor => ({ sharedId: 's_' + descriptor.topicId }),
                run: (_key, task) => task(),
            },
            async send(route, { body }) {
                assert.equal(route, '/api/v1/sync/shared/topic-sponsor');
                const durable = JSON.parse(await fs.readFile(runtime.topicSponsor.file(operationId)));
                assert.deepEqual(durable.body, body);
                requests.push(structuredClone(body));
                if (!committed) {
                    committed = true;
                    throw Object.assign(Error('Synthetic response loss'), { code: 'NETWORK_UNAVAILABLE' });
                }
                return { ...receipt, replayed: true };
            },
        };
        runtime.topicSponsor = new SharedTopicSponsor(runtime);
        const authority = { classify: async scope => ({ success: true, kind: 'shared', sharedId: 's_' + scope.topicId }) };
        const sharedTopicDelivery = createSharedTopicSponsorDelivery({ authority, getRuntime: () => runtime });
        const service = new PluginAgentOperationService({
            agentDir: root, userDataDir: root, historyMutationQueue: {}, agentConfigManager: {},
            sharedTopicDelivery,
            topicDelivery() { throw Error('Local delivery should not run'); },
        });
        const invoke = (toolArgs = args, transport = context) => service.processToolCall(
            'TopicSponsor', { ...toolArgs, _nativeSyncTopicSponsor: {
                operationId, proof, sourceSharedId: 's_source', targetSharedId: 's_target',
            } }, transport,
        );
        return { runtime, invoke, authority };
    }
    return { open, requests, receipt };
}

test('TopicSponsor recovers the original durable operation after a lost receipt and rejects changed arguments', async t => {
    const { open, requests, receipt } = await fixture(t);
    const first = open();
    await assert.rejects(first.invoke(), { code: 'NETWORK_UNAVAILABLE' });
    const file = first.runtime.topicSponsor.file(operationId);
    assert.equal(JSON.parse(await fs.readFile(file)).receipt, undefined);

    const reopened = open();
    await reopened.runtime.topicSponsor.recover();
    assert.deepEqual(requests, [{ operationId, proof, args }, { operationId, proof, args }]);
    assert.deepEqual(JSON.parse(await fs.readFile(file)).receipt, { ...receipt, replayed: true });
    await assert.rejects(reopened.invoke({ ...args, message: 'Changed' }), { code: 'SHARED_TOPIC_SPONSOR_OPERATION_CHANGED' });
    assert.equal(requests.length, 2);
});

test('TopicSponsor fails before submission for an unbound source or unavailable server capability', async t => {
    const { open, requests } = await fixture(t);
    const { runtime, invoke, authority } = open();
    await assert.rejects(invoke(args, { ...context, vcpContext: { topicId: 'different' } }), {
        code: 'SHARED_TOPIC_SPONSOR_SOURCE_CHANGED',
    });
    authority.classify = async () => ({ success: true, kind: 'local' });
    await assert.rejects(invoke(), { code: 'SHARED_TOPIC_SPONSOR_MAPPING_REQUIRED' });
    runtime.capabilities.features = [];
    await assert.rejects(invoke(), { code: 'SHARED_TOPIC_SPONSOR_UPGRADE_REQUIRED' });
    assert.deepEqual(requests, []);
    await assert.rejects(fs.access(runtime.topicSponsor.file(operationId)), { code: 'ENOENT' });
});

test('TopicSponsor accepts a canonical target and an omitted optional source address', async t => {
    const { open, requests } = await fixture(t);
    const { invoke } = open();
    const { source_topic_id, ...withoutSource } = args;
    const canonical = { ...withoutSource, topic_id: 'canonical_target' };
    await assert.rejects(invoke(canonical), { code: 'NETWORK_UNAVAILABLE' });
    assert.deepEqual(requests, [{ operationId, proof, args: canonical }]);
});

test('authenticated shared admission binding matches the nonce advertised by the desktop tool host', t => {
    const { createHash } = require('node:crypto');
    const { nativeSyncRouteId, topicSponsorRouteBinding } = require(chat + '/modules/services/nativeSync/sharedTopicSponsor');
    const DistributedServer = require(chat + '/VCPDistributedServer/VCPDistributedServer');
    const plugins = require(chat + '/VCPDistributedServer/Plugin');
    const getAllPluginManifests = plugins.getAllPluginManifests;
    t.after(() => { plugins.getAllPluginManifests = getAllPluginManifests; });
    plugins.getAllPluginManifests = () => [{ name: 'TopicSponsor' }];

    const packets = [];
    const host = new DistributedServer({ nativeSyncRouteId });
    host.sendMessage = packet => packets.push(packet);
    host.registerTools();
    host.registerTools();
    assert.equal(packets.length, 2);
    assert.equal(packets[0].type, 'register_tools');
    assert.equal(packets[0].data.nativeSyncRouteId, packets[1].data.nativeSyncRouteId);
    const routeId = packets[0].data.nativeSyncRouteId;
    assert.match(routeId, /^[0-9a-f-]{36}$/);
    const runtime = { capabilities: { features: ['shared-topic-sponsor-v1'] } };
    const binding = topicSponsorRouteBinding(runtime, { shared: { itemType: 'agent' } });
    assert.deepEqual(binding, { sponsorRouteHash: createHash('sha256').update(routeId).digest('hex') });
    assert.deepEqual(topicSponsorRouteBinding(runtime, { shared: { itemType: 'group' } }), {});
    assert.deepEqual(topicSponsorRouteBinding(runtime, { shared: { itemType: 'agent' } }, 'continuation'), {});
    assert.deepEqual(topicSponsorRouteBinding({ capabilities: {} }, { shared: { itemType: 'agent' } }), {});
});

'use strict';

const path = require('node:path');
const { ownedJson } = require('./sharedLocal');
const { fail } = require('./protocol');

function createCoreMemory(root, getLocalCore) {
    async function checkOfflineAuthority() {
        if (await ownedJson(root, path.join(root, '.vcp-core', 'profile.json'), { optional: true })) {
            throw fail('CORE_HISTORY_OFFLINE_UNAVAILABLE');
        }
        const connection = await ownedJson(root, path.join(root, '.native-sync', 'connection.json'), { optional: true });
        if (connection) throw fail('SHARED_AUTHORITY_UNAVAILABLE');
    }

    async function resolve(ownerType, ownerId, topicId) {
        if (!topicId) return null;
        const local = getLocalCore?.()?.runtime;
        if (local?.enabled) {
            const client = local.coreSingle;
            const known = local.localTopics.get(topicId);
            if (known) return { client, runtime: local, mapping: known };
            const descriptor = { itemType: ownerType, itemId: ownerId, topicId };
            await local.define(descriptor);
            return { client, runtime: local, mapping: client.mapping(descriptor) };
        }
        await checkOfflineAuthority();
        return null;
    }

    return {
        root,
        async findAgent(name) {
            const runtime = getLocalCore?.()?.runtime;
            if (runtime?.enabled) {
                const { agent } = await runtime.send(runtime.base + '/' + encodeURIComponent(runtime.workspace) +
                    '/memo-agent?' + new URLSearchParams({ name }));
                return agent;
            }
            await checkOfflineAuthority();
            return undefined;
        },
        async search(request) {
            const target = await resolve(request.ownerType, request.ownerId, request.currentTopicId);
            if (!target) return null;
            const { client, runtime, mapping } = target;
            return runtime.send(client.route(mapping, 'memories'), { body: request });
        },

        async history({ agentId, topicId }) {
            const target = await resolve('agent', agentId, topicId);
            if (!target) return null;
            const { client, runtime, mapping } = target;
            const rows = [];
            let before, seq;
            for (;;) {
                const query = new URLSearchParams({ limit: '500', ...(before && { before: String(before) }) });
                const page = await runtime.send(client.route(mapping, 'messages?' + query));
                if (seq !== undefined && seq !== page.seq) throw Object.assign(Error('CORE_SNAPSHOT_CHANGED'), { code: 'CORE_SNAPSHOT_CHANGED' });
                seq = page.seq;
                rows.unshift(...page.messages);
                if (!page.hasMore || !page.nextBefore) return rows;
                before = page.nextBefore;
            }
        }
    };
}

module.exports = { createCoreMemory };

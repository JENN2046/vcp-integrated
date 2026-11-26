'use strict';

const path = require('node:path');
const { ownedJson } = require('./sharedLocal');
const { fail } = require('./protocol');
const { runtimeForRoot } = require('./sharedHost');

function createCoreMemory(root, getLocalCore) {
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
        if (await ownedJson(root, path.join(root, '.vcp-core', 'profile.json'), { optional: true })) {
            throw fail('CORE_HISTORY_OFFLINE_UNAVAILABLE');
        }
        const runtime = runtimeForRoot(root);
        const client = runtime?.coreSingle;
        if (!client) {
            const directory = path.join(root, '.native-sync');
            const connection = await ownedJson(root, path.join(directory, 'connection.json'), { optional: true });
            const workspace = connection?.sharedSpaceId;
            if (!/^[a-zA-Z0-9_-]{1,96}$/.test(workspace || '')) return null;
            const state = await ownedJson(root, path.join(directory, 'shared', workspace, 'registry.json'), { optional: true });
            if (!state?.coreSingle) return null;
            for (const [key, binding] of Object.entries(state.locals)) {
                const object = state.objects[key];
                const parent = object && state.locals[object.parentId];
                if (binding.kind !== 'topic' || !parent || parent.kind !== ownerType) continue;
                if (ownerType === 'group' && !object.coreGroup) continue;
                if (key === topicId || binding.localId === topicId && parent.localId === ownerId) {
                    throw fail('CORE_HISTORY_OFFLINE_UNAVAILABLE');
                }
            }
            return null;
        }
        const mapping = runtime.mappings().find(({ local, shared, sharedId }) =>
            local.itemType === ownerType && (
                local.itemId === ownerId && local.topicId === topicId ||
                (shared.itemId === ownerId || ownerType === 'group') && sharedId === topicId
            ));
        return mapping && client.owns(mapping.local) ? { client, runtime, mapping: client.mapping(mapping.local) } : null;
    }

    return {
        root,
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

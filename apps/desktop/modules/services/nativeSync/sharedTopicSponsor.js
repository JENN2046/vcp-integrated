'use strict';

const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fail, sha256, stable } = require('./protocol');
const { ownedJson } = require('./sharedLocal');
const { durableJson } = require('./durableJson');
const { assertHistoryPath } = require('./sourceDirectory');

const endpoint = '/api/v1/sync/shared/topic-sponsor';
const capability = 'shared-topic-sponsor-v1';
const envelopeKey = '_nativeSyncTopicSponsor';
const nativeSyncRouteId = randomUUID();
const sponsorRouteHash = sha256(nativeSyncRouteId);
const validId = value => typeof value === 'string' && /^sponsor_[a-f0-9]{32}$/.test(value);

class SharedTopicSponsor {
    constructor(runtime) {
        this.runtime = runtime;
        this.dir = path.join(runtime.dir, 'topic-sponsor');
    }

    assertReady() {
        const runtime = this.runtime;
        if (!runtime.ready || runtime.closed || runtime.isStopping() || runtime.directoryPaused) {
            throw fail('SHARED_AUTHORITY_UNAVAILABLE');
        }
        if (runtime.readOnly) throw fail('SHARED_READ_ONLY');
        if (!runtime.capabilities.features?.includes(capability)) {
            throw fail('SHARED_TOPIC_SPONSOR_UPGRADE_REQUIRED');
        }
    }

    mapping(descriptor, sharedId) {
        if (descriptor.itemType !== 'agent') throw fail('SHARED_TOPIC_SPONSOR_SINGLE_REQUIRED');
        const runtime = this.runtime;
        const mapping = runtime.execution.mapping(descriptor);
        const topic = runtime.state.objects[sharedId];
        const owner = runtime.state.objects[topic?.parentId];
        if (mapping.sharedId !== sharedId || topic?.kind !== 'topic' || owner?.kind !== 'agent'
            || !runtime.isLocalVisible(sharedId) || !runtime.isLocalVisible(owner.id)) {
            throw fail('SHARED_LOCAL_MAPPING_PENDING');
        }
        runtime.matching.assert([sharedId, owner.id]);
        return mapping;
    }

    file(operationId) {
        if (!validId(operationId)) throw fail('INVALID_TOPIC_SPONSOR_OPERATION');
        return path.join(this.dir, operationId + '.json');
    }

    async submit({ body, source, target }) {
        this.assertReady();
        const { operationId, proof } = body;
        if (typeof proof !== 'string' || proof.length !== 36) {
            throw fail('SHARED_TOPIC_SPONSOR_AUTHORIZATION_REQUIRED');
        }
        const file = this.file(operationId);
        const next = {
            version: 1, binding: this.runtime.binding(), body: structuredClone(body), source, target,
        };
        return this.runtime.execution.run('topic-sponsor:' + operationId, async () => {
            const prior = await ownedJson(this.runtime.root, file, { optional: true });
            if (prior) {
                const { receipt, ...identity } = prior;
                if (stable(identity) !== stable(next)) throw fail('SHARED_TOPIC_SPONSOR_OPERATION_CHANGED');
            } else {
                this.mapping(source.descriptor, source.sharedId);
                this.mapping(target.descriptor, target.sharedId);
                await durableJson(file, next);
            }
            return this.accept(file, prior || next);
        });
    }

    async accept(file, intent) {
        this.assertReady();
        if (intent.version !== 1 || stable(intent.binding) !== stable(this.runtime.binding())
            || file !== this.file(intent.body.operationId)) {
            throw fail('SHARED_TOPIC_SPONSOR_STATE_INVALID');
        }
        this.mapping(intent.source.descriptor, intent.source.sharedId);
        this.mapping(intent.target.descriptor, intent.target.sharedId);
        const result = await this.runtime.send(endpoint, { body: intent.body });
        if (result?.operationId !== intent.body.operationId || result.sourceSharedId !== intent.source.sharedId
            || result.targetSharedId !== intent.target.sharedId || result.target_type !== 'agent'
            || result.topic_id !== intent.target.descriptor.topicId || result.target_id !== intent.target.descriptor.itemId
            || result.sender_id !== intent.source.descriptor.itemId || !Number.isSafeInteger(result.seq) || result.seq < 1
            || typeof result.message_id !== 'string' || typeof result.workId !== 'string') {
            throw fail('SHARED_TOPIC_SPONSOR_RECEIPT_INVALID');
        }
        if (intent.receipt) {
            const { replayed: previousReplay, ...previous } = intent.receipt;
            const { replayed: currentReplay, ...current } = result;
            if (stable(previous) !== stable(current)) throw fail('SHARED_TOPIC_SPONSOR_RECEIPT_CHANGED');
        } else {
            await durableJson(file, { ...intent, receipt: result });
        }
        this.runtime.scheduleTick();
        return result;
    }

    async recover() {
        if (this.runtime.readOnly || !this.runtime.capabilities.features?.includes(capability)) return;
        await assertHistoryPath(this.runtime.root, path.join(this.dir, '_check'));
        let names;
        try { names = await fs.readdir(this.dir); }
        catch (error) { if (error.code === 'ENOENT') return; throw error; }
        for (const name of names) {
            const operationId = name.endsWith('.json') && name.slice(0, -5);
            if (!validId(operationId) || this.runtime.closed || this.runtime.isStopping()) continue;
            await this.runtime.execution.run('topic-sponsor:' + operationId, async () => {
                const file = this.file(operationId);
                const intent = await ownedJson(this.runtime.root, file);
                if (!intent.receipt) await this.accept(file, intent);
            }).catch(error => {
                console.warn('[NativeSync] TopicSponsor recovery pending:', error.code || 'UNKNOWN');
            });
        }
    }
}

function createSharedTopicSponsorDelivery({ authority, getRuntime }) {
    return async (input, context = {}) => {
        const { [envelopeKey]: envelope, ...args } = input;
        if (!envelope || !validId(envelope.operationId) || !context.requestId
            || typeof envelope.sourceSharedId !== 'string' || typeof envelope.targetSharedId !== 'string') {
            throw fail('SHARED_TOPIC_SPONSOR_AUTHORIZATION_REQUIRED');
        }
        if (args.mode !== undefined || typeof args.topic_id !== 'string'
            || typeof args.message !== 'string' || !args.message.trim()) {
            throw fail('INVALID_TOPIC_SPONSOR_OPERATION');
        }
        const runtime = getRuntime();
        if (!runtime?.topicSponsor) throw fail('SHARED_AUTHORITY_UNAVAILABLE');
        runtime.topicSponsor.assertReady();
        const mapped = async (sharedId, topicId) => {
            const mapping = runtime.mappings().find(row => row.sharedId === sharedId);
            if (!mapping || (topicId !== undefined && ![sharedId, mapping.local.topicId, mapping.shared.topicId].includes(topicId))) {
                throw fail('SHARED_TOPIC_SPONSOR_MAPPING_REQUIRED');
            }
            const result = await authority.classify(mapping.local);
            if (!result.success) throw fail(result.code);
            if (result.kind !== 'shared' || result.sharedId !== sharedId) throw fail('SHARED_TOPIC_SPONSOR_MAPPING_REQUIRED');
            return mapping;
        };
        const source = await mapped(envelope.sourceSharedId, args.source_topic_id);
        const target = await mapped(envelope.targetSharedId, args.topic_id);
        if (source.sharedId === target.sharedId) throw fail('SHARED_TOPIC_SPONSOR_SELF_TARGET');
        const trusted = context.vcpContext;
        const sourceOwner = runtime.state.objects[source.sharedId]?.parentId;
        if ((trusted?.agentId && ![source.local.itemId, source.shared.itemId, sourceOwner].includes(trusted.agentId))
            || (trusted?.topicId && ![source.local.topicId, source.shared.topicId, source.sharedId].includes(trusted.topicId))
            || (trusted?.ownerType && trusted.ownerType !== source.local.itemType)
            || runtime !== getRuntime()) {
            throw fail('SHARED_TOPIC_SPONSOR_SOURCE_CHANGED');
        }
        return runtime.topicSponsor.submit({
            body: { operationId: envelope.operationId, proof: envelope.proof, args },
            source: { descriptor: source.local, sharedId: source.sharedId },
            target: { descriptor: target.local, sharedId: target.sharedId },
        });
    };
}

// The desktop WebSocket presents the nonce. An authenticated shared admission
// carries its hash so another registered desktop cannot receive this tool call.
function topicSponsorRouteBinding(runtime, mapping, kind = 'message') {
    if (kind !== 'message' || mapping.shared.itemType !== 'agent' || !runtime.capabilities.features?.includes(capability)) return {};
    return { sponsorRouteHash };
}

module.exports = { SharedTopicSponsor, createSharedTopicSponsorDelivery, nativeSyncRouteId, topicSponsorRouteBinding };

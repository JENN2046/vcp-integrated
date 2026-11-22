'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const test = require('node:test');
const { fixture } = require('./fixtures/sharedSingleHarness.cjs');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2S8AAAAASUVORK5CYII=', 'base64');
const hash = createHash('sha256').update(png).digest('hex');
const sharedSpaceId = 'sharedAB';

test('shared group image admission checks the planned members against granted model IDs', async t => {
    const f = await fixture(t, { attachments: true });
    const actor = f.actor('A');
    assert.deepEqual(f.store.sourceCatalog.grants.get(actor.sourceId).imageModels, ['synthetic']);

    async function wire(route, body) {
        const response = await fetch(f.url + route, {
            method: body ? 'POST' : 'GET',
            headers: {
                'content-type': 'application/json',
                'x-nativesync-source': actor.sourceId,
                'x-nativesync-device': actor.deviceId,
                'x-nativesync-space': f.store.sourceCatalog.spaceId,
                'x-nativesync-capabilities': 'shared-space-v1,shared-context-v1,attachments-v1',
            },
            ...(body && { body: JSON.stringify(body) }),
        });
        return { status: response.status, data: await response.json() };
    }

    const results = [];
    for (const useUnifiedModel of [true, false]) {
        for (const [label, model] of [['granted', 'synthetic'], ['padded', ' synthetic '], ['ungranted', 'other-model']]) {
            const name = (useUnifiedModel ? 'unified-' : 'member-') + label;
            const create = (kind, localId, config, extra) => f.shared.create(actor, {
                sharedSpaceId, opId: localId, kind, localId, config, ...extra,
            }).object;
            const peer = create('agent', name + '-agent', {
                ...f.owner.config, name, model: useUnifiedModel ? 'other-member-model' : model,
            });
            const members = [f.owner.id, peer.id];
            const order = [...members].reverse();
            const group = create('group', name + '-group', {
                name, mode: 'sequential', members, sequentialSpeakerOrder: order, useUnifiedModel,
                unifiedModel: useUnifiedModel ? model : 'other-unified-model',
            });
            const topic = create('topic', name + '-topic', { name }, { parentId: group.id, localParent: name + '-group' });
            const attachment = { id: 'attachment_' + hash, name: 'pixel.png', type: 'image/png', hash, size: png.length };
            const message = { id: name + '-message', role: 'user', content: 'synthetic pixel', timestamp: 1, attachments: [attachment] };

            const endpoint = '/api/plugins/NativeSync/shared-attachments/' + topic.id;
            const started = await wire(endpoint + '/uploads', {
                requestId: name + '-upload', messageId: message.id, attachmentId: attachment.id,
                name: attachment.name, size: png.length, type: attachment.type, expectedHash: hash,
            });
            assert.equal(started.status, 201, JSON.stringify(started.data));
            const upload = endpoint + '/uploads/' + started.data.uploadId;
            const chunk = await wire(upload + '/chunks', { offset: 0, data: png.toString('base64') });
            assert.equal(chunk.status, 200, JSON.stringify(chunk.data));
            assert.equal(chunk.data.offset, png.length);
            const finished = await wire(upload + '/finish', {});
            assert.deepEqual([finished.status, finished.data.state, finished.data.hash], [200, 'ready', hash]);

            const binding = { sharedSpaceId, sharedId: topic.id };
            const frozen = f.shared.executionConfig(actor, binding);
            assert.deepEqual(frozen.owner.config.sequentialSpeakerOrder, order);
            assert.equal(useUnifiedModel ? frozen.owner.config.unifiedModel : frozen.members.find(m => m.id === peer.id).config.model, model);
            const response = await wire('/api/v1/sync/shared/admit', {
                ...binding, requestId: name + '-request', expectedHead: frozen.head, configHash: frozen.hash, message,
            });
            const result = { name, model, upload: finished.data.state, status: response.status };
            if (response.status === 200) {
                const row = f.store.db.prepare('SELECT user_op FROM shared_admissions WHERE id=?').get(response.data.id);
                assert.deepEqual(JSON.parse(row.user_op).sharedTurn.plan, order);
                assert.equal(response.data.state, 'accepted');
                const linked = f.portal.attachments.locate(topic.id, message.id, attachment.id);
                assert.deepEqual(linked.bytes, png);
                result.planPersisted = true;
                result.boundBlobHash = linked.blob.hash;
            } else {
                assert.equal(f.shared.active(topic.id), undefined);
                assert.equal(f.shared.executionConfig(actor, binding).head, frozen.head);
                result.error = response.data.error?.code;
            }
            results.push(result);
        }
    }

    t.diagnostic(JSON.stringify({ imageModels: ['synthetic'], pngBytes: png.length, pngHash: hash, results }));
    assert.deepEqual(results.map(({ status, error }) => [status, error ?? null]), [
        [200, null], [200, null], [409, 'MODEL_IMAGE_UNSUPPORTED'],
        [200, null], [200, null], [409, 'MODEL_IMAGE_UNSUPPORTED'],
    ]);
    assert.equal(f.calls(), 0, 'admission test sends no model requests');
});

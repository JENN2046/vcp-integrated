'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { createHash } = require('node:crypto');

const defaultSpec = require('./input.json');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const names = ['A', 'B'];

function makeFixture({ server, out, spec = defaultSpec, onProvider }) {
    const { AttachmentStore } = require(path.join(server, 'Plugin/NativeSync/mobile/attachments'));
    const { envelopeFor } = require(path.join(server, 'Plugin/NativeSync/sync/metadata'));
    let group, groupTopic, memberIds, attachment;

    function seed(f) {
        const actor = f.actor('C');
        function create(kind, localId, config, parent) {
            return f.shared.create(actor, { sharedSpaceId: 'sharedAB', opId: localId, kind, localId, config,
                ...(parent && { parentId: parent.id, localParent: 'gc-group' }) }).object;
        }
        memberIds = Object.fromEntries(spec.speakers.map(({ id, ...config }) => [id, create('agent', id, config).id]));
        const members = spec.plan.map(id => memberIds[id]);
        group = create('group', 'gc-group', { ...spec.group, members, sequentialSpeakerOrder: members, tavernRules: spec.rules });
        groupTopic = create('topic', 'gc-topic', { name: 'Synthetic group context' }, group);
        return { groupTopic };
    }

    async function seedHistory(f) {
        const actor = f.actor('C');
        const topic = { ...groupTopic.topic, key: groupTopic.id };
        const storage = new AttachmentStore({ store: f.store, root: path.join(out, 'data'), topics: [topic] });
        const { messageId, name, type, text } = spec.attachment;
        const bytes = Buffer.from(text);
        const hash = sha256(bytes);
        const attachmentId = 'attachment_' + hash;
        const upload = storage.begin(actor.principal, topic.key, { requestId: 'gc-history-attachment', name, type,
            size: bytes.length, expectedHash: hash, messageId, attachmentId });
        const chunked = storage.chunk(actor.principal, topic.key, upload.uploadId, { offset: 0, data: bytes.toString('base64') });
        const finished = await storage.finish(actor.principal, topic.key, upload.uploadId);
        const claimed = storage.claim(actor.principal, topic.key, [upload.uploadId]);
        assert.equal(claimed[0].id, attachmentId);
        for (const entry of spec.history) {
            const message = { ...entry, ...(entry.agentId && { agentId: memberIds[entry.agentId] }),
                ...(entry.id === messageId && { attachments: claimed }) };
            const metadata = envelopeFor(message, 1);
            f.store.apply({ ...groupTopic.topic, msgId: message.id, deviceId: actor.principal, opId: message.id,
                baseHash: null, action: 'upsert', message, ...(metadata && { metadata }) },
            { sharedSpace: 'sharedAB', metadataPublisher: true, attachmentPrincipal: actor.principal });
        }
        const linked = storage.locate(topic.key, messageId, attachmentId);
        assert.equal(sha256(linked.bytes), hash);
        assert.equal(chunked.offset, bytes.length);
        assert.equal(finished.state, 'ready');
        assert.equal(linked.blob.hash, hash);
        assert.equal(claimed[0].hash, hash);
        attachment = { messageId, attachmentId, sha256: hash, bytes: bytes.length, boundBlobHash: linked.blob.hash,
            claimHash: claimed[0].hash, finishState: finished.state };
    }

    function respond(body, row, res) {
        const member = JSON.stringify(body.messages?.[0]?.content || '').match(/GC_MEMBER_([AB])/)?.[1];
        if (!member) return false;
        assert.ok(names.includes(member));
        row.member = member;
        onProvider({ member, route: '/v1/chat/completions', body });
        const content = spec['reply' + member];
        assert.equal(body.stream, true);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        function frame(delta, finish_reason) {
            res.write('data: ' + JSON.stringify({ id: 'gc-fixture-' + member, object: 'chat.completion.chunk',
                created: 1, model: 'synthetic', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
        }
        if (spec.streamFrames) {
            for (const payload of spec.streamFrames) {
                res.write('data: ' + JSON.stringify(payload).replaceAll('{{member}}', member) + '\n\n');
            }
        } else {
            frame({ role: 'assistant', content }, null);
        }
        frame({}, 'stop');
        res.end('data: [DONE]\n\n');
        return true;
    }

    return { seed, seedHistory, respond, get attachment() { return attachment; }, get memberIds() { return memberIds; },
        get savedOrder() { return group.config.sequentialSpeakerOrder; } };
}

module.exports = { makeFixture, sha256 };

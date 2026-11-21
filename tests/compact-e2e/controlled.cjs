'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { stable, sha256 } = require('../../apps/server/Plugin/NativeSync/sync/protocol');
const { createNativeContinuationStore } = require('../../apps/server/modules/nativeContinuationStore.cjs');

const inputs = ['SYNTHETIC CONTROLLED EDIT TURN', 'SYNTHETIC CONTROLLED DELETE TURN'];
const replies = ['SYNTHETIC ARCHIVED ORIGINAL EDIT', 'SYNTHETIC ARCHIVED ORIGINAL DELETE'];
const edited = 'SYNTHETIC UPDATED EDIT TEXT';

async function stage(service, out) {
    const sharedSpaceId = 'sharedAB';
    const sharedId = service.topics.preSubmit.id;
    const scope = { sharedSpaceId, sharedId };
    const descriptor = service.descriptors.A.preSubmit;
    const connection = JSON.parse(fs.readFileSync(path.join(out, 'seed/desktopA/.native-sync/connection.json'), 'utf8'));
    const origin = service.wsOrigin;
    const headers = {
        'content-type':'application/json', authorization:'Bearer synthetic-only',
        'x-nativesync-space':connection.spaceId, 'x-nativesync-source':'sourceA', 'x-nativesync-device':'deviceA',
        'x-nativesync-capabilities':'shared-space-v1,shared-context-v1,shared-controlled-text-v1,shared-steering-v1',
    };
    async function call(route, body, moreHeaders) {
        const response = await fetch(origin + route, {
            method:body ? 'POST' : 'GET', headers:{ ...headers, ...moreHeaders },
            body: body && JSON.stringify(body),
        });
        const value = await response.json();
        assert.ok(response.ok, route + ' ' + response.status + ' ' + JSON.stringify(value));
        return value;
    }
    const api = (route, packet) => call('/api/v1/sync/shared/' + route, packet);
    const continuation = createNativeContinuationStore(path.join(out, 'runtime-box/.state/native-continuations'));
    const db = new DatabaseSync(path.join(service.data, 'central.sqlite'), { readOnly:true });
    const current = db.prepare('SELECT hash, deleted FROM messages WHERE topic_id=? AND msg_id=?');
    const turns = [];
    try {
        for (const [index, content] of inputs.entries()) {
            const message = { id:'compact-controlled-user-' + index, role:'user', content, timestamp:1700000000010 + index * 2 };
            const initial = await api('context?' + new URLSearchParams(scope));
            const work = await api('admit', {
                ...scope, requestId:message.id, expectedHead:initial.head, configHash:initial.hash, message, controlMode:'text-only-v1',
            });
            const requestId = 'reply_' + work.id;
            const packet = {
                requestId, model:'synthetic', stream:false, messages:[{role:'user', content}],
                vcpchatExtensions:{requestContext:{ownerType:'agent', agentId:descriptor.itemId, topicId:descriptor.topicId}},
            };
            await api('native-request', {
                sharedSpaceId, admissionId:work.id, requestId, bodyHash:sha256(stable(packet)), generation:0, consumedInputSeq:0,
            });
            const response = await call('/v1/chat/completions', packet, {
                'x-nativesync-admission':work.id, 'x-nativesync-generation':'0', 'x-nativesync-consumed-input-seq':'0',
            });
            const reply = response.choices[0].message.content;
            assert.equal(reply, replies[index]);
            const assistant = {id:requestId, role:'assistant', timestamp:message.timestamp + 1, content:reply, finishReason:'completed'};
            const completion = await api('steer-turn-complete', {
                sharedSpaceId, workId:work.id, opId:'desktop-controlled-turn-' + index, generation:0, message:assistant,
            });
            assert.equal(completion.workState, 'completed');
            const proofHash = continuation.proof(requestId, work.id).hash;
            const row = db.prepare('SELECT proof_json FROM shared_native_checkpoints WHERE work_id=? AND generation=0').get(work.id);
            assert.equal(JSON.parse(row.proof_json).hash, proofHash);
            assert.deepEqual(continuation.read(requestId).events.map(event => [event.kind,event.content]), [['assistant',reply]]);
            const baseHash = current.get(sharedId, requestId).hash;
            const operation = index === 0
                ? {action:'upsert', message:{ ...assistant, content:edited }}
                : {action:'delete'};
            await api('message', { ...scope, operation:{
                ...operation, opId:'desktop-controlled-mutation-' + index, msgId:requestId, baseHash, deviceId:'desktop:deviceA',
            } });
            const projected = current.get(sharedId, requestId);
            assert.equal(projected.deleted, Number(operation.action === 'delete'));
            if (!projected.deleted) assert.notEqual(projected.hash, baseHash);
            assert.equal(continuation.proof(requestId, work.id).hash, proofHash);
            turns.push({userId:message.id, requestId, workId:work.id, state:completion.workState, archivedText:reply, proofHash, operation:operation.action});
        }
        return turns;
    } finally {
        db.close();
    }
}
module.exports = { stage, inputs, replies, edited };

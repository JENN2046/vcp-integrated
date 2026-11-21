'use strict';

const assert = require('node:assert/strict');

function createFixture() {
    let mode = 'hold';
    let stream;
    let closed = false;
    let drop = false;
    function seed(f) {
        function create(kind, localId, config, parent = null) {
            return f.shared.create(f.actor('C'), {
                sharedSpaceId: 'sharedAB', opId: localId, kind, localId, config,
                ...(parent && { parentId: parent.id, localParent: 'relay-group' }),
            }).object;
        }
        const members = ['A', 'B', 'C'].map(name => create('agent', 'relay-agent-' + name, {
            ...f.owner.config, name, systemPrompt: 'GROUP_RELAY_MEMBER_' + name, streamOutput: true,
        }).id);
        const group = create('group', 'relay-group', {
            name: 'Relay fixture A B C', mode: 'sequential', members, sequentialSpeakerOrder: members,
        });
        const groupTopic = create('topic', 'relay-topic', { name: 'Relay round' }, group);
        return { groupTopic };
    }
    function frame(res, delta, finish = null) {
        res.write('data: ' + JSON.stringify({
            id: 'synthetic-relay', object: 'chat.completion.chunk', created: 1, model: 'synthetic',
            choices: [{ index: 0, delta, finish_reason: finish }],
        }) + '\n\n');
    }
    function final(res, content) {
        frame(res, { role: 'assistant', content });
        frame(res, {}, 'stop');
        res.end('data: [DONE]\n\n');
    }
    function respond(body, row, res) {
        const prompt = body.messages.find(item => item.role === 'system');
        const member = JSON.stringify(prompt || {}).match(/GROUP_RELAY_MEMBER_([ABC])/)?.[1];
        if (!member) return false;
        row.member = member;
        assert.equal(body.stream, true);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (member === 'B' && mode === 'hold') {
            stream = res;
            res.once('close', () => { closed = true; });
            frame(res, { role: 'assistant', content: 'RELAY_B_PARTIAL' });
        } else {
            final(res, 'RELAY_' + member + '_FINAL');
        }
        return true;
    }
    return {
        seed, respond,
        get closed() { return closed; },
        completeB() {
            assert.ok(stream && !stream.destroyed);
            final(stream, ' RELAY_B_FINAL');
        },
        cutB() {
            assert.ok(stream && !stream.destroyed);
            stream.destroy();
        },
        finishFutureRounds() { mode = 'finish'; },
        dropNextAck() { drop = true; },
        dropResponse(row) {
            if (!drop || !row.route.endsWith('/cancel-remaining') || row.status < 200 || row.status >= 300) return false;
            drop = false;
            return true;
        },
    };
}
module.exports = { createFixture };

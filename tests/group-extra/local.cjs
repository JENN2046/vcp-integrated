'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const agents = ['A', 'B', 'C'];
const marker = speaker => 'GROUP_QUEUE_LOCAL_MEMBER_' + speaker;
const reply = speaker => 'Synthetic local group reply ' + speaker + '.';

function createProvider() {
    let release;
    const held = new Promise(resolve => { release = resolve; });
    return {
        release,
        async respond(body, row, res) {
            const speaker = agents.find(name => body.messages.some(message =>
                message.role === 'system' && JSON.stringify(message.content).includes(marker(name))));
            if (!speaker) return false;
            row.localGroupSpeaker = speaker;
            if (speaker === 'B') {
                await held;
                row.connectedAtRelease = !res.destroyed;
            }
            res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
                id: 'local-group-' + speaker, object: 'chat.completion', created: 1, model: 'synthetic',
                choices: [{ index: 0, message: { role: 'assistant', content: reply(speaker) }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }));
            return true;
        },
    };
}

async function scenario({ clients: { A }, result, service, evalJs, waitUntil, sha, groupRelay }) {
    const api = (name, ...args) => evalJs(A, `window.chatAPI.${name}(...${JSON.stringify(args)})`);
    const create = await api('createAgentGroup', 'Synthetic native queue', {
        members: agents.map(speaker => 'local-group-' + speaker.toLowerCase()),
        mode: 'sequential',
    });
    assert.equal(create.success, true, create.error);
    const { id, topics: [{ id: topicId }] } = create.agentGroup;
    const userId = randomUUID();
    const userText = 'Synthetic local group queue test.';
    const admission = await api('sendGroupChatMessage', id, topicId, {
        id: userId, role: 'user', name: '用户', content: { text: userText },
    });
    assert.notEqual(admission.success, false, admission.error);
    const providerCalls = () => service.calls.filter(row => row.localGroupSpeaker);
    const readHistory = () => api('getGroupChatHistory', id, topicId);
    const readRows = async () => {
        const value = await readHistory();
        return Array.isArray(value) ? value : value.history;
    };
    const sources = await A.command('loaded-sources', {
        main: ['apps/desktop/Groupmodules/groupchat.js', 'apps/desktop/modules/ipc/groupChatHandlers.js'], renderer: [],
    });
    assert.equal(sources.main.length, 2);
    for (const row of sources.main) assert.equal(row.sha256, sha(require('node:path').join(result.candidate, row.file)));
    try {
        await waitUntil(() => providerCalls().some(row => row.localGroupSpeaker === 'B'), 'local second speaker reaches real provider');
        assert.deepEqual(providerCalls().map(row => row.localGroupSpeaker), ['A', 'B']);
        const cancel = await api('interruptGroupChatQueue', id, topicId);
        assert.equal(cancel.success, true);
        assert.equal(cancel.currentReplyContinues, true);
        assert.equal(cancel.interruptedRequests, 0);
        assert.equal(cancel.continuingRequests, 1);
        groupRelay.release();
        const history = await waitUntil(async () => {
            const rows = await readRows();
            return rows.find(row => row.role === 'assistant' && row.content === reply('B')) && rows;
        }, 'original local group commits its current reply');
        assert.deepEqual(history.map(row => [row.role, row.content]), [
            ['user', userText], ['assistant', reply('A')], ['assistant', reply('B')],
        ]);
        assert.equal(history[0].id, userId);
        assert.equal(history[2].id, cancel.continuingMessageIds[0]);
        assert.deepEqual(providerCalls().map(row => row.localGroupSpeaker), ['A', 'B']);
        assert.equal(providerCalls()[1].connectedAtRelease, true);
        result.nativeLocalGroup = { sources, cancel, history, provider: providerCalls() };
    } finally {
        groupRelay.release();
    }
}

module.exports = { agents, marker, createProvider, scenario };

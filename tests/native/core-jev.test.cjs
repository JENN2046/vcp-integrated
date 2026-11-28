'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { coreFixture, host, localProvider, wait } = require('./fixtures/coreSingleHarness.cjs');

test('native JEV arbitration and manual queue insertions dispatch and commit through Core', async t => {
    const provider = await localProvider(t);
    const { chat } = host(provider);
    const decisions = [];
    const stop = { answers: { speaker_routing: { probabilities: { agent_0: 0, agent_1: 0, end_conversation: 1 } },
        continue_discussion: { noul: 0 } } };
    const f = await coreFixture(t, chat, { jevService: {
        async decide(state) {
            decisions.push(state);
            if (decisions.length !== 1) return stop;
            return { answers: { speaker_routing: { probabilities: { agent_0: 0.95, agent_1: 0, end_conversation: 0.05 } },
                continue_discussion: { noul: 0.95 } } };
        }
    } });
    const { core } = f;
    const members = [
        { id: 'memberA', name: 'First member', model: 'synthetic', systemPrompt: 'First prompt' },
        { id: 'memberB', name: 'Manual member', model: 'synthetic', systemPrompt: 'Manual prompt' }
    ];
    const groupId = 'jevOwner';
    const { key, route, descriptor } = await f.define({ ownerType: 'group', ownerId: groupId, name: 'JEV topic',
        config: { group: { name: 'Dynamic JEV', mode: 'jev', members: members.map(member => member.id) }, agents: members } });
    const desktop = await f.desktop();
    let release;
    provider.setReply((_body, res) => {
        const answer = () => res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Native member answer' }, finish_reason: 'stop' }] }));
        if (!release) release = answer;
        else answer();
    });
    const accepted = await desktop.runtime.coreSingle.send(descriptor, { id: 'jev-user', role: 'user', content: '讨论红外仪器' });
    await wait(() => release, 'first dynamically selected member');
    const state = await desktop.runtime.coreSingle.jev(descriptor, 'invite', members[1].id);
    assert.ok(state.state.manualQueue.length);
    const phone = await f.mobile();
    await desktop.close();
    release();
    await wait(() => core.jev.native.getState(groupId, key).running === false, 'JEV session settles');
    const history = await phone.call(route + '/messages');
    assert.equal(history.messages[0].id, accepted.userMessage.id);
    assert.deepEqual(history.messages.slice(1).map(message => message.agentId), members.map(member => member.id));
    assert.match(JSON.stringify(provider.calls[1].messages), /Native member answer/);
    assert.equal(provider.calls.length, 2);
    assert.ok(decisions.length >= 2);
});

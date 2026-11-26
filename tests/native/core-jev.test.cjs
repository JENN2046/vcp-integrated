'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, wait } = require('./fixtures/sharedSingleHarness.cjs');
const { host, localProvider, mountCore } = require('./fixtures/coreSingleHarness.cjs');

test('native JEV arbitration and manual queue insertions dispatch and commit through Core', async t => {
    const f = await fixture(t);
    const provider = await localProvider(t);
    const { chat } = host(provider);
    const decisions = [];
    const stop = { answers: { speaker_routing: { probabilities: { agent_0: 0, agent_1: 0, end_conversation: 1 } },
        continue_discussion: { noul: 0 } } };
    const { core } = await mountCore(f, chat, { jevService: {
        async decide(state) {
            decisions.push(state);
            if (decisions.length !== 1) return stop;
            return { answers: { speaker_routing: { probabilities: { agent_0: 0.95, agent_1: 0, end_conversation: 0.05 } },
                continue_discussion: { noul: 0.95 } } };
        }
    } });
    t.after(() => core.close());
    const actor = f.actor('A');
    const create = (opId, kind, localId, config, extra = {}) => f.shared.create(actor,
        { sharedSpaceId: 'sharedAB', opId, kind, localId, config, ...extra }).object;
    const second = create('jev-member', 'agent', 'jevMember', { name: 'Manual member', model: 'synthetic', systemPrompt: 'Manual prompt' });
    const group = create('jev-owner', 'group', 'jevOwner', { name: 'Dynamic JEV', mode: 'jev', members: [f.owner.id, second.id] });
    const opened = create('jev-topic', 'topic', 'jevTopic', { name: 'JEV topic' }, { parentId: group.id, localParent: 'jevOwner' });
    assert.equal(opened.coreGroup, true);

    const desktop = await f.desktop('A');
    const local = desktop.runtime.localFor(opened.id);
    const descriptor = { itemType: 'group', itemId: local.localParent, topicId: local.localId };
    let release;
    provider.setReply((_body, res) => {
        const answer = () => res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Native member answer' }, finish_reason: 'stop' }] }));
        if (!release) release = answer;
        else answer();
    });
    const accepted = await desktop.runtime.coreSingle.send(descriptor, { id: 'jev-user', role: 'user', content: '讨论红外仪器' });
    await wait(() => release, 'first dynamically selected member');
    const state = await desktop.runtime.coreSingle.jev(descriptor, 'invite', desktop.runtime.localFor(second.id).localId);
    assert.ok(state.state.manualQueue.length);
    const phone = await f.phone();
    const route = '/core/sharedAB/' + opened.id;
    await desktop.close();
    release();
    await wait(() => core.jev.native.getState(group.id, opened.id).running === false, 'JEV session settles');
    const history = await phone.call(route + '/messages');
    assert.equal(history.messages[0].id, accepted.userMessage.id);
    assert.deepEqual(history.messages.slice(1).map(message => message.agentId), [f.owner.id, second.id]);
    assert.match(JSON.stringify(provider.calls[1].messages), /Native member answer/);
    assert.equal(provider.calls.length, 2);
    assert.ok(decisions.length >= 2);
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM journal').get().n, 0);
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM shared_admissions').get().n, 0);
});

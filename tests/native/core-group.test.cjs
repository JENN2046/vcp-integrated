'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CHAT, coreFixture, host, localProvider, wait } = require('./fixtures/coreSingleHarness.cjs');

const members = [
    { id: 'memberA', name: 'Member A', model: 'synthetic', systemPrompt: 'First speaker' },
    { id: 'memberB', name: 'Member B', model: 'synthetic', systemPrompt: 'Second speaker' }
];
const ids = members.map(member => member.id);
const group = (f, mode) => f.define({ ownerType: 'group', ownerId: mode, name: mode,
    config: { group: { name: mode, mode, members: ids }, agents: members } });

test('Core regular groups share native scheduling, context and official history across clients', async t => {
    const provider = await localProvider(t);
    const f = await coreFixture(t, host(provider).chat);
    const sequential = await group(f, 'sequential');
    const natural = await group(f, 'naturerandom');
    const inviteOnly = await group(f, 'invite_only');
    for (const mode of ['jev','game']) await assert.rejects(group(f, mode), { code: 'CORE_GROUP_MODE_NOT_MIGRATED' });
    const reader = await f.mobile(['read']);
    const phone = await f.mobile();
    const desktop = await f.desktop();
    const observer = new AbortController();
    const events = [];
    const { consumeSharedEvents } = await import(CHAT + '/modules/services/nativeSync/sharedEventClient.mjs');
    const stream = consumeSharedEvents(await reader.observe(sequential.route + '/observe', observer.signal),
        (payload, type) => events.push({ payload, type }), { signal: observer.signal, envelope: true }).catch(error => { if (!observer.signal.aborted) throw error; });
    const settled = id => wait(() => f.core.store.work(id)?.status === 'completed', 'group completion');
    try {
        const sent = await desktop.runtime.coreSingle.send(sequential.descriptor,
            { id: 'native-group-user', role: 'user', content: 'Group fixture prompt' });
        const id = sent.serverSession.executionId;
        await settled(id);
        const snapshot = await reader.call(sequential.route + '/messages');
        assert.deepEqual(snapshot.messages.map(row => row.role), ['user','assistant','assistant']);
        assert.deepEqual(snapshot.messages.slice(1).map(row => row.agentId), ids);
        assert.equal(snapshot.messages[1].sourceWorkId, id);
        assert.match(JSON.stringify(provider.calls[1].messages), /core reply/);
        await wait(() => events.some(row => row.type === 'work_state' && row.payload.status === 'completed'), 'group observation final');
        await t.test('nonstream group previews carry both speaker identities', () => {
            const previews = events.filter(row => row.type === 'work_preview' && row.payload.speaker);
            assert.deepEqual(previews.map(({ payload }) => [payload.step, payload.speaker, payload.speakerName, payload.text]),
                members.map((member, step) => [step, member.id, member.name, '']));
            assert.deepEqual(snapshot.messages.slice(1).map(row => row.name), members.map(member => member.name));
        });
        assert.deepEqual((await desktop.runtime.coreSingle.history(sequential.descriptor)).history.map(row => row.id),
            snapshot.messages.map(row => row.id));
    } finally {
        observer.abort();
        await stream;
    }
    const input = { requestId: 'natural-fixture-request', text: '@Member B Natural prompt' };
    await settled((await phone.call(natural.route + '/send', input, 202)).id);
    assert.ok((await reader.call(natural.route + '/messages')).messages.length >= 2);
    await settled((await phone.call(inviteOnly.route + '/send', { ...input, requestId: 'invite-only-fixture' }, 202)).id);
    const calls = provider.calls.length;
    const invitation = { agentId: ids[1], requestId: 'invite-second' };
    const invited = await phone.call(inviteOnly.route + '/invitations', invitation, 202);
    assert.equal(invited.recovery.kind, 'invitation');
    assert.equal((await phone.call(inviteOnly.route + '/invitations', invitation, 202)).id, invited.id);
    await settled(invited.id);
    assert.equal(provider.calls.length, calls + 1);
    const history = (await reader.call(inviteOnly.route + '/messages')).messages;
    assert.deepEqual(history.map(row => row.role), ['user','assistant']);
    assert.equal(history.at(-1).agentId, ids[1]);
});

test('Core settles a recovered group final and runs only the next undispatched member', async t => {
    const provider = await localProvider(t);
    const f = await coreFixture(t, host(provider).chat);
    const { key } = await group(f, 'sequential');
    const { core, workspace } = f;
    core.runner.draining = true;
    const actor = core.local.actor;
    const topic = core.topic(actor, workspace, key, 'execute');
    const { workId } = core.store.admit(topic, actor.principal, 'group-recover-id', { text: 'Original request' }, () => ({
        config: { ...core.configuration(topic), groupId: topic.ownerId, topicId: topic.topicId }, attachments: []
    }));
    core.store.db.prepare("UPDATE works SET status='running',dispatched=1,group_plan_json=? WHERE id=?")
        .run(JSON.stringify(ids), workId);
    core.store.saveFinal(core.store.work(workId), 'saved member final');
    const reopened = await f.restart();
    await wait(() => reopened.store.work(workId)?.status === 'completed', 'next speaker after restart');
    assert.equal(provider.calls.length, 1);
    assert.match(JSON.stringify(provider.calls[0].messages), /saved member final/);
    assert.deepEqual(reopened.store.snapshot(key, Number.MAX_SAFE_INTEGER, 100).slice(1).map(row => row.agentId), ids);
});

test('an empty-topic invitation and redo use Core without placeholder messages', async t => {
    const provider = await localProvider(t);
    const f = await coreFixture(t, host(provider).chat);
    const { key, descriptor } = await group(f, 'invite_only');
    const { runtime } = await f.desktop();
    const client = runtime.coreSingle;
    const invitation = await client.invite(descriptor, ids[0]);
    await wait(() => f.core.store.work(invitation.id)?.status === 'completed', 'empty invitation');
    assert.equal(f.core.store.work(invitation.id).user_message_id, null);
    const first = (await client.history(descriptor)).history;
    assert.deepEqual(first.map(row => row.role), ['assistant']);
    const original = first[0].id;
    const redo = await client.invite(descriptor, ids[0], { id: original });
    await wait(() => f.core.store.work(redo.id)?.status === 'completed', 'redo');
    const history = (await client.history(descriptor)).history;
    assert.equal(history.length, 1);
    assert.notEqual(history[0].id, original);
    assert.equal(provider.calls.length, 2);
    assert.equal(f.core.store.changes(key, 0, 10).find(event => event.action === 'delete').messageId, original);
});

for (const action of ['cancel', 'incomplete']) {
    test('a late group observer sees the current member and no partial final on ' + action, async t => {
        const provider = await localProvider(t);
        const f = await coreFixture(t, host(provider).chat);
        const { route } = await f.define({ ownerType: 'group', ownerId: 'group-preview', config: {
            group: { name: 'Observed group', mode: 'sequential', members: ids },
            agents: members.map(member => ({ ...member, streamOutput: true }))
        } });
        let unfinished;
        provider.setReply((_body, res) => {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            if (provider.calls.length === 1) {
                res.end('data: {"choices":[{"index":0,"delta":{"content":"first final"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
            } else {
                unfinished = res;
                res.write('data: {"choices":[{"index":0,"delta":{"content":"second partial"},"finish_reason":null}]}\n\n');
            }
        });
        const phone = await f.mobile();
        const reader = await f.mobile(['read']);
        const { consumeSharedEvents } = await import(CHAT + '/modules/services/nativeSync/sharedEventClient.mjs');
        const observer = new AbortController();
        const events = [];
        let live;
        try {
            const work = await phone.call(route + '/send', { requestId:'preview-' + action, text:'start' }, 202);
            await wait(() => unfinished && [...f.core.runner.running.values()].some(turn=>turn.text==='second partial'), 'streaming second member');
            live = consumeSharedEvents(await reader.observe(route + '/observe', observer.signal),
                (payload, type) => events.push({ payload, type }), { signal:observer.signal, envelope:true })
                .catch(error=>{ if (!observer.signal.aborted) throw error; });
            await wait(() => events.some(e=>e.type==='work_preview'), 'reconnected Work preview');
            assert.deepEqual(events.find(e=>e.type==='work_preview').payload, {
                workId:work.id, text:'second partial', speaker:ids[1], speakerName:members[1].name, step:1
            });
            if (action === 'cancel') await phone.call(route + '/works/' + work.id + '/cancel', { requestId:'preview-cancel-turn' });
            else unfinished.end('data: {"choices":[{"index":0,"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n');
            const terminal = action === 'cancel' ? 'cancelled' : 'review_required';
            await wait(() => events.some(e=>e.type==='work_state' && e.payload.status===terminal), 'group stopped with '+terminal);
            const history = (await reader.call(route + '/messages')).messages;
            assert.deepEqual(history.map(row=>row.content), ['start','first final']);
            assert.equal(history[1].agentId, ids[0]);
            assert.equal(provider.calls.length, 2);
        } finally {
            observer.abort();
            unfinished?.destroy();
            await live;
        }
    });
}

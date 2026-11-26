'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { BOX, CHAT, fixture, wait } = require('./fixtures/sharedSingleHarness.cjs');
const { localProvider, host, mountCore } = require('./fixtures/coreSingleHarness.cjs');

test('Core regular groups share native scheduling, context and official history across clients', async t => {
    const f = await fixture(t);
    const provider = await localProvider(t);
    const { chat } = host(provider);
    const { core } = await mountCore(f, chat);
    t.after(() => core.close());
    const actor = f.actor('A');
    const create = (opId, kind, localId, config, extra = {}) => f.shared.create(actor,
        { sharedSpaceId: 'sharedAB', opId, kind, localId, config, ...extra }).object;
    const second = create('core-group-member', 'agent', 'memberB', { name: 'Member B', model: 'synthetic', systemPrompt: 'Member B prompt' });
    const members = [f.owner.id, second.id];
    const topicFor = mode => {
        const group = create(mode + '-owner', 'group', mode, { name: mode, mode, members });
        return create(mode + '-topic', 'topic', mode + '-topic', { name: mode },
            { parentId: group.id, localParent: mode });
    };
    const phone = await f.phone();
    const desktop = await f.desktop('A');
    const submit = async (context, text) => {
        const result = await core.send(context, actor.principal, { requestId: 'send-' + context.key, text }, () => {}, actor);
        await wait(() => ['completed','failed','review_required'].includes(core.store.work(result.workId)?.status), 'group completion');
        assert.equal(core.store.work(result.workId).status, 'completed', core.store.work(result.workId).error_code);
        return result;
    };
    const sequential = topicFor('sequential');
    const natural = topicFor('naturerandom');
    const inviteOnly = topicFor('invite_only');
    const jev = topicFor('jev');
    const game = topicFor('game');
    assert.equal(jev.coreGroup, undefined);
    assert.equal(game.coreGroup, undefined);
    for (const topic of [sequential, natural, inviteOnly]) assert.equal(topic.coreGroup, true);
    await desktop.runtime.pollDirectory();
    const binding = desktop.runtime.localFor(sequential.id);
    const descriptor = { itemType: 'group', itemId: binding.localParent, topicId: binding.localId };
    assert.equal(desktop.runtime.coreSingle.owns(descriptor), true);
    const seqRoute = '/core/sharedAB/' + sequential.id;
    const context = core.topic(actor, 'sharedAB', sequential.id, 'execute');
    const observer = new AbortController();
    t.after(() => observer.abort());
    const events = [];
    const { consumeSharedEvents } = await import(CHAT + '/modules/services/nativeSync/sharedEventClient.mjs');
    const stream = consumeSharedEvents(await phone.observe(seqRoute + '/observe', observer.signal),
        (payload, type) => events.push({ payload, type }), { signal: observer.signal, envelope: true })
        .catch(error => { if (!observer.signal.aborted) throw error; });
    const result = await desktop.runtime.coreSingle.send(descriptor, { id: 'native-group-user', role: 'user', content: 'Shared group prompt' });
    await wait(() => ['completed','failed','review_required'].includes(core.store.work(result.serverSession.executionId)?.status), 'sequential final');
    assert.equal(core.store.work(result.serverSession.executionId).status, 'completed', core.store.work(result.serverSession.executionId).error_code);
    const snapshot = await phone.call(seqRoute + '/messages');
    assert.deepEqual(snapshot.messages.map(m => m.role), ['user','assistant','assistant']);
    assert.deepEqual(snapshot.messages.slice(1).map(m => m.agentId), members);
    assert.equal(snapshot.messages[1].sourceWorkId, result.serverSession.executionId);
    assert.match(JSON.stringify(provider.calls[1].messages), /core reply/);
    await wait(() => events.some(event => event.type === 'work_state' && event.payload.status === 'completed'), 'group observation final');
    assert.deepEqual(events.filter(event => event.type === 'work_preview' && event.payload.speaker)
        .map(event => event.payload.speaker), members);
    observer.abort();
    await stream;
    assert.equal((await desktop.runtime.coreSingle.history(descriptor)).history.length, 3);

    await submit(core.topic(actor, 'sharedAB', natural.id, 'execute'), '@Member B Natural prompt');
    assert.ok((await phone.call('/core/sharedAB/' + natural.id + '/messages')).messages.length >= 2);
    const inviteTopic = core.topic(actor, 'sharedAB', inviteOnly.id, 'execute');
    await submit(inviteTopic, 'Invite only prompt');
    const calls = provider.calls.length;
    const invitePath = '/core/sharedAB/' + inviteOnly.id;
    const invitation = { agentId: second.id, requestId: 'invite-second' };
    const invited = await phone.call(invitePath + '/invitations', invitation, 202);
    assert.equal(invited.recovery.kind, 'invitation');
    assert.equal((await phone.call(invitePath + '/invitations', invitation, 202)).id, invited.id);
    await wait(() => core.store.work(invited.id)?.status === 'completed', 'explicit invitation');
    assert.equal(provider.calls.length, calls + 1);
    const invitationMessages = await phone.call('/core/sharedAB/' + inviteOnly.id + '/messages');
    assert.deepEqual(invitationMessages.messages.map(m => m.role), ['user','assistant']);
    assert.equal(invitationMessages.messages.at(-1).agentId, second.id);
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM journal').get().n, 0);
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM shared_admissions').get().n, 0);
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM mobile_executions').get().n, 0);
    await phone.call('/conversations/' + sequential.id + '/messages', { requestId: 'legacy-group-send', text: 'denied' }, 409);
    await phone.call('/core/sharedAB/' + jev.id + '/messages', undefined, 409);
    assert.equal(core.resolveAcceptedTopic(core.store.work(result.serverSession.executionId)).key, context.key);
});

test('Core settles a recovered group final and runs only the next undispatched member', async t => {
    const f = await fixture(t);
    const provider = await localProvider(t);
    const { chat } = host(provider);
    const { core, options } = await mountCore(f, chat);
    core.runner.draining = true;
    const actor = f.actor('A');
    const create = (opId, kind, localId, config, extra = {}) => f.shared.create(actor,
        { sharedSpaceId: 'sharedAB', opId, kind, localId, config, ...extra }).object;
    const member = create('recover-member', 'agent', 'recoverMember', { name: 'Next speaker', model: 'synthetic', systemPrompt: 'Next prompt' });
    const members = [f.owner.id, member.id];
    const group = create('recover-owner', 'group', 'recoverGroup', { name: 'Recover', mode: 'sequential', members });
    const created = create('recover-topic', 'topic', 'recoverTopic', { name: 'Recovery' },
        { parentId: group.id, localParent: 'recoverGroup' });
    const topic = core.topic(actor, 'sharedAB', created.id, 'execute');
    const { prepareSharedConfiguration } = require(BOX + '/Plugin/NativeSync/mobile/sharedConfiguration');
    const config = await prepareSharedConfiguration(f.portal.engine.configs, topic, { persist: false });
    const { workId } = core.store.admit(topic, actor.principal, 'group-recover-id', { text: 'Original request' }, () => ({
        config: { ...config, groupId: topic.ownerId, topicId: topic.topicId }, attachments: []
    }));
    core.store.db.prepare("UPDATE works SET status='running',dispatched=1,group_plan_json=? WHERE id=?")
        .run(JSON.stringify(members), workId);
    core.store.saveFinal(core.store.work(workId), 'saved member final');
    await core.close();

    const reopened = new core.constructor(options);
    f.shared.core = reopened;
    t.after(() => reopened.close());
    await wait(() => reopened.store.work(workId)?.status === 'completed', 'next speaker after restart');
    assert.equal(provider.calls.length, 1);
    assert.match(JSON.stringify(provider.calls[0].messages), /saved member final/);
    assert.deepEqual(reopened.store.snapshot(created.id, Number.MAX_SAFE_INTEGER, 100).slice(1).map(m => m.agentId), members);
});

test('an empty-topic invitation and redo use Core without placeholder messages', async t => {
    const f = await fixture(t);
    const provider = await localProvider(t);
    const { chat } = host(provider);
    const { core } = await mountCore(f, chat);
    t.after(() => core.close());
    const actor = f.actor('A');
    const group = f.shared.create(actor, { sharedSpaceId: 'sharedAB', opId: 'empty-invite-owner',
        kind: 'group', localId: 'emptyInvite', config: { name: 'Empty', mode: 'invite_only', members: [f.owner.id] } }).object;
    const topic = f.shared.create(actor, { sharedSpaceId: 'sharedAB', opId: 'empty-invite-topic',
        kind: 'topic', parentId: group.id, localParent: 'emptyInvite', localId: 'emptyTopic', config: { name: 'Empty' } }).object;
    const desktop = await f.desktop('A');
    const binding = desktop.runtime.localFor(topic.id);
    const descriptor = { itemType: 'group', itemId: binding.localParent, topicId: binding.localId };
    const memberId = desktop.runtime.localFor(f.owner.id).localId;
    const invite = await desktop.runtime.coreSingle.invite(descriptor, memberId);
    await wait(() => core.store.work(invite.id)?.status === 'completed', 'empty invitation');
    assert.equal(core.store.work(invite.id).user_message_id, null);
    let { history } = await desktop.runtime.coreSingle.history(descriptor);
    assert.deepEqual(history.map(message => message.role), ['assistant']);
    const original = history[0].id;
    const redo = await desktop.runtime.coreSingle.invite(descriptor, memberId, { id: original });
    await wait(() => core.store.work(redo.id)?.status === 'completed', 'redo');
    ({ history } = await desktop.runtime.coreSingle.history(descriptor));
    assert.equal(history.length, 1);
    assert.notEqual(history[0].id, original);
    assert.equal(provider.calls.length, 2);
    assert.equal(core.store.changes(topic.id, 0, 10).filter(event => event.action === 'delete')[0].messageId, original);
});

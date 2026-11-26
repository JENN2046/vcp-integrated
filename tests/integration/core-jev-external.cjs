'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { BOX, fixture } = require('../native/fixtures/sharedSingleHarness.cjs');
const { host, localProvider, mountCore } = require('../native/fixtures/coreSingleHarness.cjs');

test('authorized JEV provider arbitrates one synthetic Core conversation', { timeout: 60000 }, async t => {
    const native = require(BOX + '/core/jev').configuredJev();
    assert.ok(native, 'isolated JEV credentials are required');
    const status = await native.getStatus();
    assert.equal(status.configured, true, 'isolated JEV provider is not configured');
    assert.equal(new URL(status.url).protocol, 'https:', 'external JEV requires HTTPS');
    const fixtureState = await fixture(t);
    const provider = await localProvider(t);
    const { chat } = host(provider);
    let decisions = 0, received = false, failureCode;
    let decisionInputs;
    const suppressed = { log() {}, warn() {}, error() {}, info() {} };
    const { core } = await mountCore(fixtureState, chat, { jevService: {
        async decide(state, questions, { signal }) {
            assert.equal(++decisions, 1, 'the external check may make only one decision');
            try {
                const result = await native.decide(state, questions, { signal, timeoutMs: 25000, maxRetries: 0 });
                received = true;
                const route = result.answers.speaker_routing?.probabilities;
                const continuation = result.answers.continue_discussion?.noul;
                decisionInputs = {
                    speakerProbability: typeof route?.agent_0 === 'number' ? route.agent_0 : null,
                    endProbability: typeof route?.end_conversation === 'number' ? route.end_conversation : null,
                    continueProbability: typeof continuation === 'number' ? continuation : null
                };
                return result;
            } catch (error) {
                failureCode = typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'PROVIDER_REQUEST_FAILED';
                throw Object.assign(Error(failureCode), { code: failureCode });
            }
        }
    } });
    t.after(() => core.close());
    core.jev.native.logger = suppressed;
    core.jev.native.decisionMode.logger = suppressed;
    const actor = fixtureState.actor('A');
    const create = (opId, kind, localId, config, fields = {}) => fixtureState.shared.create(actor,
        { sharedSpaceId: 'sharedAB', opId, kind, localId, config, ...fields }).object;
    const group = create('external-group', 'group', 'externalGroup', {
        name: 'Synthetic arbitration check', mode: 'jev', members: [fixtureState.owner.id],
        modeSettings: { jev: { maxAutonomousRounds: 1 } }
    });
    const topic = create('external-topic', 'topic', 'externalTopic', { name: 'Synthetic topic' },
        { parentId: group.id, localParent: 'externalGroup' });
    const desktop = await fixtureState.desktop('A');
    const local = desktop.runtime.localFor(topic.id);
    const descriptor = { itemType: 'group', itemId: local.localParent, topicId: local.localId };
    const text = '这是合成联验。请 Synthetic shared 直接回答还未解决的问题：天空为什么通常看起来是蓝色的？请给出一句解释。';
    const accepted = await desktop.runtime.coreSingle.send(descriptor, { id: 'synthetic-external-jev', role: 'user', content: text });
    for (let index = 0; index < 420 && (core.jev.native.getState(group.id, topic.id).running || !decisions); index++) await delay(100);
    const state = core.jev.native.getState(group.id, topic.id);
    const stopReason = /^[A-Za-z0-9_-]+$/.test(state.stopReason || '') ? state.stopReason : null;
    const works = core.store.db.prepare('SELECT id, status, reply_message_id FROM works WHERE conversation_id=? ORDER BY rowid').all(topic.id);
    const inputWork = works.find(work => work.id === accepted.serverSession.executionId);
    const speakerWorks = works.filter(work => work.id !== inputWork?.id);
    const phone = await fixtureState.phone();
    const history = await phone.call('/core/sharedAB/' + topic.id + '/messages');
    const committedSpeakers = speakerWorks.filter(work => history.messages.some(message =>
        message.role === 'assistant' && message.id === work.reply_message_id &&
        message.sourceWorkId === work.id && message.agentId === fixtureState.owner.id && message.content.trim()));
    console.log('RC01_JEV ' + JSON.stringify({ provider: status.provider, decisions, received,
        decisionInputs, stopReason, failureCode: failureCode || null, workStates: works.map(row => row.status),
        localModelCalls: provider.calls.length, committedSpeakers: committedSpeakers.length,
        active: state.running }));
    assert.equal(received, true, failureCode || 'no external decision');
    assert.equal(state.running, false);
    assert.equal(decisions, 1);
    assert.equal(inputWork?.status, 'completed');
    assert.equal(history.messages[0]?.content, text);
    assert.equal(history.messages[0]?.id, accepted.userMessage.id);
    assert.ok(speakerWorks.length > 0, 'JEV did not select a member for the synthetic request');
    assert.ok(speakerWorks.every(work => work.status === 'completed'));
    assert.equal(committedSpeakers.length, speakerWorks.length);
    assert.equal(provider.calls.length, speakerWorks.length);
});

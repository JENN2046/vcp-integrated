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
    const suppressed = { log() {}, warn() {}, error() {}, info() {} };
    const { core } = await mountCore(fixtureState, chat, { jevService: {
        async decide(state, questions, { signal }) {
            assert.equal(++decisions, 1, 'the external check may make only one decision');
            try {
                const result = await native.decide(state, questions, { signal, timeoutMs: 25000, maxRetries: 0 });
                received = true;
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
    await desktop.runtime.coreSingle.send(descriptor, { id: 'synthetic-external-jev', role: 'user',
        content: 'Synthetic test only. Which of the sample participants should explain why the sky appears blue?' });
    for (let index = 0; index < 420 && (core.jev.native.getState(group.id, topic.id).running || !decisions); index++) await delay(100);
    const state = core.jev.native.getState(group.id, topic.id);
    const stopReason = /^[A-Za-z0-9_-]+$/.test(state.stopReason || '') ? state.stopReason : null;
    const works = core.store.db.prepare('SELECT status FROM works WHERE conversation_id=? ORDER BY rowid').all(topic.id);
    console.log('RC01_JEV ' + JSON.stringify({ provider: status.provider, decisions, received,
        stopReason, failureCode: failureCode || null, workStates: works.map(row => row.status), localModelCalls: provider.calls.length,
        active: state.running }));
    assert.equal(received, true, failureCode || 'no external decision');
    assert.equal(state.running, false);
    assert.equal(decisions, 1);
    assert.ok(!failureCode && works.length >= 1 && works.every(row => row.status === 'completed'));
});

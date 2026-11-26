'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { CHAT, fixture } = require('./fixtures/sharedSingleHarness.cjs');

test('Core takeover retains unresolved legacy intents and refuses to retire their subscriptions', async t => {
    const f = await fixture(t);
    const desktop = await f.desktop('A');
    await desktop.close();
    const statePath = path.join(desktop.data, '.native-sync', 'shared', 'sharedAB', 'messages.json');
    const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    const [descriptor] = state.topics;
    assert.ok(descriptor);
    const { wireTopic } = require(CHAT + '/modules/services/nativeSync/protocol');
    const identity = wireTopic(descriptor);
    state.localCommits[JSON.stringify(identity)] = { id: 'fixture-unresolved' };
    const before = JSON.stringify(state);
    await fs.writeFile(statePath, before);
    const { openSharedReplica } = require(CHAT + '/modules/services/nativeSync/sharedReplica');
    await assert.rejects(openSharedReplica({
        queue: desktop.queue, statePath, connection: { sharedSpaceId: 'sharedAB', deviceId: 'deviceA' },
        mappings: [], coreMappings: [{ shared: descriptor, sharedId: f.topic.id }],
        send: () => { throw Error('retired topic unexpectedly made a network request'); }
    }), { code: 'CORE_LEGACY_PROJECTION_UNSETTLED' });
    assert.equal(await fs.readFile(statePath, 'utf8'), before);
});

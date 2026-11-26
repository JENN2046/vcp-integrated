'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { coreInput, contract } = require('./service.cjs');

module.exports = async ({ clients: { A }, out, result, service, click, evalJs, waitUntil, start, stop, picture }) => {
    const topic = service.topics.preSubmit.id;
    const local = result.mode === 'core-local';
    const selection = client => evalJs(client, 'window.VCPStateChannels.get("conversation.current").get()');
    async function select(client, role) {
        const descriptor = service.descriptors[role].preSubmit;
        if (!await evalJs(client, "document.querySelector('#tabContentAgents').classList.contains('active')")) {
            await click(client, '.sidebar-tab-button[data-tab="agents"]');
        }
        await click(client, '#agentList > li .agent-name', local ? 'Synthetic local' : 'Synthetic shared');
        await waitUntil(async () => (await selection(client)).itemId === descriptor.itemId, role + ' selected Core agent');
        await click(client, '.sidebar-tab-button[data-tab="topics"]');
        if ((await selection(client)).topicId !== descriptor.topicId) {
            await click(client, '#topicList [data-topic-id="' + descriptor.topicId + '"] .topic-title-display');
        }
        await waitUntil(async () => (await selection(client)).topicId === descriptor.topicId, role + ' selected Core topic');
    }
    await select(A, 'A');
    await evalJs(A, `(() => {
        const input = document.querySelector('#messageInput');
        input.value = ${JSON.stringify(coreInput)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
    })()`);
    await waitUntil(() => evalJs(A, "!document.querySelector('#sendMessageBtn').disabled"), 'enabled Core composer');
    await click(A, '#sendMessageBtn');
    await waitUntil(() => service.calls.some(call => call.case === 'coreRC'), 'real ToolBox dispatched Core Work');

    await waitUntil(() => A.events.some(({event,data}) => event === 'ipc-result' &&
        data?.channel === 'native-sync:prepare-send' && data.success === true), 'desktop admission receipt returned');

    const database = new DatabaseSync(path.join(out, 'core', 'core.sqlite'), { readOnly: true });
    let work;
    try {
        work = database.prepare('SELECT id,status FROM works WHERE conversation_id=?').get(topic);
        assert.equal(work.status, 'running');
        await stop('A');
        await stop('B');
        service.releaseLost();
        await waitUntil(() => database.prepare('SELECT status FROM works WHERE id=?').get(work.id)?.status === 'completed',
            'Core settles without a desktop observer');
        const messages = database.prepare('SELECT id,role,content FROM messages WHERE conversation_id=? ORDER BY ordinal').all(topic);
        assert.deepEqual(messages.map(row => row.content), [coreInput, contract.completeText]);
        result.core = { id: work.id, completedWithoutDesktop: true, messages };
    } finally {
        database.close();
    }
    if (local) {
        assert.equal(fs.existsSync(path.join(out, 'data', 'central.sqlite')), false);
        assert.equal(fs.existsSync(path.join(out, 'profile-A', '.native-sync', 'shared')), false);
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'profile-A', 'UserData', 'local-agent', 'topics', 'local-topic', 'history.json'), 'utf8')), []);
        result.core.legacyDatabaseCreated = false;
        result.core.nativeHistoryWrites = 0;
    } else {
    const legacy = new DatabaseSync(path.join(out, 'data', 'central.sqlite'), { readOnly: true });
    try {
        result.core.legacyWrites = Object.fromEntries(['journal','shared_admissions','mobile_executions']
            .map(table => [table, legacy.prepare('SELECT count(*) AS n FROM ' + table).get().n]));
        assert.ok(Object.values(result.core.legacyWrites).every(count => count === 0));
    } finally {
        legacy.close();
    }
    }
    result.core.backendRestart = await service.restartWithUpgrade();
    assert.deepEqual(result.core.backendRestart, { code: 0, signal: null });
    const reopened = await start('B');
    await select(reopened, 'B');
    const text = () => evalJs(reopened, 'document.querySelector("#chatMessages")?.innerText || ""');
    await waitUntil(async () => {
        const visible = await text();
        return visible.includes(coreInput) && visible.includes(contract.completeText);
    }, 'cold desktop renders the persisted Core history');
    assert.equal(service.calls.filter(call => call.case === 'coreRC').length, 1);
    result.core.coldReadback = true;
    await picture(reopened, 'core-cold-readback');
};

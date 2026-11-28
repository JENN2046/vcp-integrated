'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async function desktopLifecycle({ clients, profiles, evalJs, stop, start, waitUntil, result }) {
    let client = clients.A;
    const invoke = (method, ...args) => evalJs(client, 'window.electronAPI.' + method + '(...' + JSON.stringify(args) + ')');
    const success = async reply => {
        const value = await reply;
        assert.equal(value.success, true, JSON.stringify(value));
        return value;
    };
    async function verifyWriterReady(label) {
        const kept = path.join(profiles.A, 'UserData/local-agent/topics/local-topic/history.json');
        const before = JSON.parse(await fs.readFile(kept, 'utf8'));
        const after = [...before, {id:label,role:'user',content:label}];
        await waitUntil(async () => {
            const value = await invoke('saveChatHistory', 'local-agent', 'local-topic', after, {expectedHistory:before});
            if (value.error === 'HISTORY_AUTHORITY_PENDING') return false;
            await success(value);
            return true;
        }, 'active native writer after cold start');
        assert.ok(JSON.parse(await fs.readFile(kept, 'utf8')).some(m => m.id === label));
    }
    const owner = (await success(invoke('createAgentGroup', 'Synthetic lifecycle group'))).agentGroup;
    const group = owner.id;
    const first = owner.topics[0].id;
    const second = (await success(invoke('createNewTopicForGroup', group, 'second'))).topicId;
    const third = (await success(invoke('createNewTopicForGroup', group, 'third'))).topicId;
    const configPath = path.join(profiles.A, 'AgentGroups', group, 'config.json');
    const config = async () => JSON.parse(await fs.readFile(configPath, 'utf8'));
    const topics = value => value.topics.map(topic => topic.id);
    const history = topic => path.join(profiles.A, 'UserData', group, 'topics', topic, 'history.json');
    const stale = await config();
    const order = ids => invoke('saveGroupTopicOrder', group, ids);

    const agent = 'local-agent';
    const removedTopic = (await success(invoke('createNewTopicForAgent', agent, 'Disposable agent topic'))).topicId;
    const historyFile = path.join(profiles.A, 'UserData', agent, 'topics', removedTopic, 'history.json');
    const message = { id: 'disposable-message', role: 'user', content: 'Synthetic history before removal' };
    await success(invoke('saveChatHistory', agent, removedTopic, [message], { expectedHistory: [] }));
    assert.equal(JSON.parse(await fs.readFile(historyFile, 'utf8'))[0].id, message.id);
    await success(invoke('deleteTopic', agent, removedTopic));
    await assert.rejects(fs.stat(historyFile), { code: 'ENOENT' });

    await success(order([second, first, third]));
    await stop('A');
    client = await start('A');
    await verifyWriterReady('first-restart');
    await success(invoke('deleteTopic', agent, removedTopic));
    const agentConfig = JSON.parse(await fs.readFile(path.join(profiles.A, 'Agents', agent, 'config.json'), 'utf8'));
    assert.ok(agentConfig._historyDeletedTopics.includes(removedTopic));
    assert.ok(agentConfig.topics.some(topic => topic.id === 'local-topic'));
    const lateAgent = await invoke('saveChatHistory', agent, removedTopic, [message], {expectedHistory:[]});
    assert.match(lateAgent.error, /^HISTORY_(TOPIC_DELETED|DELETION_FENCED)$/);
    await assert.rejects(fs.stat(historyFile), { code: 'ENOENT' });
    const cold = await invoke('getAgentGroupConfig', group);
    assert.deepEqual(topics(cold), [second, first, third]);

    const [reordered, removed] = await Promise.all([order([third, second, first]), invoke('deleteGroupTopic', group, second)]);
    await success(reordered);
    await success(removed);
    await success(order([second, third, first]));
    await success(invoke('saveAgentGroupConfig', group, stale));
    assert.deepEqual(topics(await config()), [third, first]);
    assert.ok((await config())._historyDeletedTopics.includes(second));
    const lateHistory = async topic => {
        const reply = await invoke('saveGroupChatHistory', group, topic, [{id:'late-message',role:'assistant',content:'late'}], {expectedHistory:[]});
        assert.equal(reply.success, false);
        assert.match(reply.code, /^HISTORY_(TOPIC_DELETED|DELETION_FENCED|OWNER_UNVERIFIED)$/);
        await assert.rejects(fs.stat(history(topic)), {code:'ENOENT'});
    };
    await lateHistory(second);

    const [lastOrder, removedGroup] = await Promise.all([order([first, third]), invoke('deleteAgentGroup', group)]);
    assert.equal(typeof lastOrder.success, 'boolean');
    await success(removedGroup);
    await stop('A');
    client = await start('A');
    await verifyWriterReady('second-restart');
    const deleted = await config();
    assert.equal(deleted._historyDeleting, true);
    assert.deepEqual(deleted.topics, []);
    assert.equal((await order([first, second, third])).success, false);
    assert.equal((await invoke('saveAgentGroupConfig', group, stale)).success, false);
    await lateHistory(first);
    await lateHistory(third);
    await verifyWriterReady('after-stale-order');
    assert.deepEqual(await config(), deleted);
    result.lifecycle = { coldOrder: [second,first,third], deletedTopic: second,
        agentTopicDeletionReplayedAfterRestart: true, ownerTombstoneAfterRestart: true, staleOrderRejected: true, lateHistoriesRejected: 3 };
};

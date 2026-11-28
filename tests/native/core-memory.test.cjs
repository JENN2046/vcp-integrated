'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { BOX, CHAT, coreFixture, host, localProvider, wait } = require('./fixtures/coreSingleHarness.cjs');

test('authorized Core memory reads project inserts, edits and deletes into the native CDS', {
    skip: !process.env.VCP_CORE_CDS_BINARY
}, async t => {
    const provider = await localProvider(t);
    const { chat, pluginManager } = host(provider);
    const f = await coreFixture(t, chat);
    const { core, workspace } = f;
    const { key, route, descriptor } = await f.define({ config: { name: 'Fixture Agent', model: 'synthetic', systemPrompt: 'Isolated input' } });
    const desktop = await f.desktop();
    const mobile = await f.mobile(['read']);
    const actor = core.local.actor;
    const topic = core.topic(actor, workspace, key, 'execute');
    core.store.transaction(() => {
        core.store.ensureConversation(topic);
        core.store.insertMessage({ id: 'bridge_before', key: topic.key, role: 'user', content: '昨天的青铜器笔记' });
        core.store.insertMessage({ id: 'bridge_target', key: topic.key, role: 'assistant', content: '今天查阅了红外光谱和长江大桥' });
        core.store.insertMessage({ id: 'bridge_after', key: topic.key, role: 'user', content: '明天继续记录' });
    });
    const search = (query, options = {}) => mobile.call(route + '/memories', { query, windowBefore: 1, windowAfter: 1, ...options });
    const first = await search('{红外光谱|长江大桥:2},[晚霞]');
    assert.deepEqual(first.windows[0].messages.map(message => message.msgId), ['bridge_before', 'bridge_target', 'bridge_after']);
    assert.equal((await search('红外光谱', { excludeCurrentTopic: true })).windows.length, 0);
    await mobile.call(route.replace('/personal/', '/foreign/') + '/memories', { query: '红外光谱' }, 403);

    const { createCoreMemory } = require(CHAT + '/modules/services/nativeSync/coreMemory');
    let attached = true;
    const adapter = createCoreMemory(desktop.data, () => attached ? desktop : null);
    const memo = require(CHAT + '/VCPDistributedServer/Plugin/TopicMemo/TopicMemo');
    memo.initialize({ services: { coreMemory: adapter } });
    const input = { maid: 'Fixture Agent', command: 'GetTopicContent', topic_id: key };
    assert.match(await memo.processToolCall(input), /红外光谱/);
    const deep = require(CHAT + '/VCPDistributedServer/Plugin/DeepMemo/DeepMemoService');
    deep.initialize({ config: { DeepMemoExcludeCurrentTopic: false }, services: { coreMemory: adapter } });
    const context = { vcpContext: { agentId: descriptor.itemId, topicId: descriptor.topicId } };
    assert.match(await deep.processToolCall({ keyword: '红外光谱' }, context), /桥/);
    const manifest = require(CHAT + '/VCPDistributedServer/Plugin/TopicMemo/plugin-manifest.json');
    pluginManager.plugins.set(manifest.name, { ...manifest, pluginType: 'distributed' });
    t.after(() => pluginManager.plugins.delete(manifest.name));
    const toolBlock = [
        '<<<[TOOL_REQUEST]>>>', 'tool_name:「始」TopicMemo「末」,', 'command:「始」GetTopicContent「末」,',
        'maid:「始」Fixture Agent「末」,', 'topic_id:「始」' + topic.key + '「末」', '<<<[END_TOOL_REQUEST]>>>'
    ].join('\n');
    provider.setReply((body, res) => {
        const content = provider.calls.length === 1 ? toolBlock : 'Scoped native memory result';
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] }));
    });
    const execute = await f.mobile();
    const accepted = await execute.call(route + '/send', { text: 'Use the authorized history tool.', requestId: 'memo-native-work' }, 202);
    await wait(() => ['completed','failed','review_required'].includes(core.store.work(accepted.id)?.status), 'Core memory tool settles');
    assert.equal(core.store.work(accepted.id).status, 'completed');
    assert.equal(core.store.db.prepare("SELECT status FROM work_invocations WHERE work_id=? AND plugin_name='TopicMemo'").get(accepted.id).status, 'returned');
    assert.match(JSON.stringify(provider.calls[1].messages), /话题：One history|话题.*One history/);
    const mapping = desktop.runtime.coreSingle.mapping(descriptor);
    const messageRoute = desktop.runtime.coreSingle.route(mapping, 'messages/bridge_target');
    await desktop.runtime.send(messageRoute, { body: { requestId: 'cds-edit-target', revision: 1, text: '修改为自然语言处理' } });
    assert.equal((await search('红外光谱')).windows.length, 0);
    assert.equal((await search('自然语言处理')).windows.length, 1);
    assert.match(await memo.processToolCall(input), /自然语言处理/);
    await desktop.runtime.send(messageRoute, { body: { requestId: 'cds-remove-target', revision: 2, remove: true } });
    assert.equal((await search('自然语言处理')).windows.length, 0);
    assert.doesNotMatch(await memo.processToolCall(input), /自然语言处理/);
    const filename = path.join(desktop.data, 'UserData', descriptor.itemId,
        'topics', descriptor.topicId, 'history.json');
    const fs = require('node:fs');
    if (fs.existsSync(filename)) assert.deepEqual(JSON.parse(fs.readFileSync(filename, 'utf8')), []);
    await desktop.close();
    attached = false;
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, JSON.stringify([{ role: 'user', content: 'obsolete legacy history' }]));
    await assert.rejects(memo.processToolCall(input), { code: 'CORE_HISTORY_OFFLINE_UNAVAILABLE' });
});

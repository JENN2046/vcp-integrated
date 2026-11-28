'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { CHAT, fixture, wait } = require('./fixtures/sharedSingleHarness.cjs');
const { host, localProvider, mountCore } = require('./fixtures/coreSingleHarness.cjs');

test('authorized Core memory reads project inserts, edits and deletes into the native CDS', {
    skip: !process.env.VCP_CORE_CDS_BINARY
}, async t => {
    const f = await fixture(t, { attachments: true });
    const provider = await localProvider(t);
    const { chat } = host(provider);
    const { core, route, options } = await mountCore(f, chat);
    await require('node:fs/promises').writeFile(path.join(options.directory, 'native-capability-grants.json'),
        JSON.stringify({ version: 1, workspace: 'sharedAB', agents: { [f.owner.id]: { TopicMemo: [f.owner.id] } } }), { mode: 0o600 });
    t.after(() => core.close());
    const desktop = await f.desktop('A');
    const mobile = await f.phone({ permissions: ['read'] });
    const actor = f.actor('A');
    const topic = core.topic(actor, 'sharedAB', f.topic.id, 'execute');
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
    const forbidden = await f.phone({ space: 'foreignSpace' });
    await forbidden.call(route + '/memories', { query: '红外光谱' }, 403);

    const { createCoreMemory } = require(CHAT + '/modules/services/nativeSync/coreMemory');
    const adapter = createCoreMemory(desktop.data);
    const memo = require(CHAT + '/VCPDistributedServer/Plugin/TopicMemo/TopicMemo');
    memo.initialize({ services: { coreMemory: adapter } });
    const input = { maid: 'Synthetic shared', command: 'GetTopicContent', topic_id: desktop.descriptor.topicId };
    assert.match(await memo.processToolCall(input), /红外光谱/);
    const deep = require(CHAT + '/VCPDistributedServer/Plugin/DeepMemo/DeepMemoService');
    deep.initialize({ config: { DeepMemoExcludeCurrentTopic: false }, services: { coreMemory: adapter } });
    const context = { vcpContext: { agentId: desktop.descriptor.itemId, topicId: desktop.descriptor.topicId } };
    assert.match(await deep.processToolCall({ keyword: '红外光谱' }, context), /桥/);
    const toolBlock = [
        '<<<[TOOL_REQUEST]>>>', 'tool_name:「始」TopicMemo「末」,', 'command:「始」GetTopicContent「末」,',
        'maid:「始」Synthetic shared「末」,', 'topic_id:「始」' + topic.key + '「末」', '<<<[END_TOOL_REQUEST]>>>'
    ].join('\n');
    provider.setReply((body, res) => {
        const content = provider.calls.length === 1 ? toolBlock : 'Scoped native memory result';
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] }));
    });
    const execute = await f.phone();
    const accepted = await execute.call(route + '/send', { text: 'Use the authorized history tool.', requestId: 'memo-native-work' }, 202);
    await wait(() => ['completed','failed','review_required'].includes(core.store.work(accepted.id)?.status), 'Core memory tool settles');
    assert.equal(core.store.work(accepted.id).status, 'completed');
    assert.equal(core.store.db.prepare("SELECT status FROM work_invocations WHERE work_id=? AND plugin_name='TopicMemo'").get(accepted.id).status, 'returned');
    assert.match(JSON.stringify(provider.calls[1].messages), /话题：One history|话题.*One history/);
    const mapping = desktop.runtime.coreSingle.mapping(desktop.descriptor);
    const messageRoute = desktop.runtime.coreSingle.route(mapping, 'messages/bridge_target');
    await desktop.runtime.send(messageRoute, { body: { requestId: 'cds-edit-target', revision: 1, text: '修改为自然语言处理' } });
    assert.equal((await search('红外光谱')).windows.length, 0);
    assert.equal((await search('自然语言处理')).windows.length, 1);
    assert.match(await memo.processToolCall(input), /自然语言处理/);
    await desktop.runtime.send(messageRoute, { body: { requestId: 'cds-remove-target', revision: 2, remove: true } });
    assert.equal((await search('自然语言处理')).windows.length, 0);
    assert.doesNotMatch(await memo.processToolCall(input), /自然语言处理/);
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM journal').get().n, 0);
    const filename = path.join(desktop.data, 'UserData', desktop.descriptor.itemId,
        'topics', desktop.descriptor.topicId, 'history.json');
    const fs = require('node:fs');
    if (fs.existsSync(filename)) assert.deepEqual(JSON.parse(fs.readFileSync(filename, 'utf8')), []);
    await desktop.close();
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, JSON.stringify([{ role: 'user', content: 'obsolete legacy history' }]));
    await assert.rejects(memo.processToolCall(input), { code: 'CORE_HISTORY_OFFLINE_UNAVAILABLE' });
});

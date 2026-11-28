'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const test = require('node:test');
const os = require('node:os');
const { host, localProvider } = require('./fixtures/coreSingleHarness.cjs');
const BOX = process.env.VCP_TEST_SERVER || path.resolve(__dirname, '../../apps/server');
const express = require(BOX + '/node_modules/express');
const { startCoreHost } = require(BOX + '/core/host');
const { localTopicKey } = require(BOX + '/core/localWorkspace');

async function wait(predicate, label) {
    for (let i = 0; i < 250; i++) {
        if (await predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw Error('TIMEOUT ' + label);
}

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'core-exec-fixture-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return { root, t };
}

async function mountCore(f, chat) {
    const app = express();
    app.use(express.json());
    const key = 'isolated-core-key';
    const core = startCoreHost({ app, chat, listenHost: '127.0.0.1', serverKey: key,
        env: { VCP_CORE_DATA_DIR: path.join(f.root, 'core') } });
    const definition = { ownerType: 'agent', ownerId: 'fixture', topicId: 'default', name: 'Fixture',
        config: { name: 'Fixture', model: 'synthetic', systemPrompt: 'Isolated fixture.', streamOutput: false } };
    const topic = localTopicKey(definition.ownerType, definition.ownerId, definition.topicId);
    await core.local.define(topic, definition, config => core.supportsGroup(config));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    f.t.after(async () => {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    });
    f.call = async (requestPath, body, expected = 200) => {
        const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/core' + requestPath, {
            headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
            method: body === undefined ? 'GET' : 'POST',
            ...(body !== undefined && { body: JSON.stringify(body) })
        });
        const data = await response.json();
        assert.equal(response.status, expected, JSON.stringify(data));
        return data;
    };
    return { core, route: '/personal/' + topic };
}


const command = (name, archery = '') => [
    'Visible reply from the isolated provider.',
    '<<<[TOOL_REQUEST]>>>',
    'tool_name:「始」' + name + '「末」,',
    ...(archery ? ['archery:「始」' + archery + '「末」,'] : []),
    '<<<[END_TOOL_REQUEST]>>>'
].join('\n');
const reply = (res, content) => res.end(JSON.stringify({
    choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }]
}));

test('Core records native distributed WebSocket receipts and holds a disconnected attempt', async t => {
    const f = await fixture(t);
    const provider = await localProvider(t);
    const { chat, pluginManager } = host(provider);
    const hub = require(BOX + '/WebSocketServer');
    const Ws = require(BOX + '/node_modules/ws');
    const server = http.createServer();
    hub.setPluginManager(pluginManager);
    hub.initialize(server, { vcpKey: 'isolated-core-tool-fixture' });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const ws = new Ws('ws://127.0.0.1:' + server.address().port +
        '/vcp-distributed-server/VCP_Key=isolated-core-tool-fixture');
    t.after(async () => {
        ws.terminate();
        await hub.shutdown();
        await new Promise(resolve => server.close(resolve));
    });
    chat.config.webSocketServer = hub;
    pluginManager.setWebSocketServer(hub);
    const { core, route } = await mountCore(f, chat);
    t.after(() => core.close());
    await once(ws, 'open');
    const tool = 'CoreExecutionWireFixture';
    ws.send(JSON.stringify({ type: 'register_tools', data: {
        capabilities: { cancelTool: true },
        tools: [{ name: tool, displayName: tool, pluginType: 'synchronous', entryPoint: { command: 'fixture' }, description: 'Local fixture' }]
    } }));
    await wait(() => pluginManager.getPlugin(tool)?.isDistributed, 'native tool registration');
    let delivered = 0;
    let pendingCancelId;
    let acknowledgedCancelId;
    ws.on('message', frame => {
        const { type, data } = JSON.parse(frame);
        if (type === 'cancel_tool') acknowledgedCancelId = data.requestId;
        if (type !== 'execute_tool') return;
        assert.equal(data.toolName, tool);
        if (data.toolArgs.cancellationProbe) {
            pendingCancelId = data.requestId;
            return;
        }
        if (++delivered === 2) ws.terminate();
        else ws.send(JSON.stringify({ type: 'tool_result', data: {
            requestId: data.requestId, status: 'success', result: 'distributed wire receipt'
        } }));
    });
    const abort = new AbortController();
    const pending = hub.executeDistributedTool(pluginManager.getPlugin(tool).serverId, tool,
        { cancellationProbe: true }, undefined, undefined, abort.signal);
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    await wait(() => pendingCancelId, 'native node receives cancellable request');
    abort.abort();
    await rejected;
    await wait(() => acknowledgedCancelId === pendingCancelId, 'native node receives cancellation message');
    provider.setReply((body, res) => reply(res, JSON.stringify(body.messages).includes('distributed wire receipt') &&
        !JSON.stringify(body.messages.at(-1)).includes('second work') ? 'completed fixture reply' : command(tool)));
    const first = await f.call(route + '/send', { requestId: 'wire-first', text: 'first work' }, 202);
    await wait(() => core.store.work(first.workId)?.status === 'completed', 'distributed Work completes');
    assert.equal(core.store.db.prepare('SELECT status FROM work_invocations WHERE work_id=?').get(first.workId).status, 'returned');
    const second = await f.call(route + '/send', { requestId: 'wire-second', text: 'second work' }, 202);
    await wait(() => core.store.work(second.workId)?.status === 'review_required', 'lost distributed result stays unknown');
    assert.equal(core.store.work(second.workId).error_code, 'TOOL_EXECUTION_UNCONFIRMED');
    assert.equal(core.store.db.prepare('SELECT status FROM work_invocations WHERE work_id=?').get(second.workId).status, 'unknown');
    assert.equal(delivered, 2);
});

test('Core Archery waits for a native stdio acceptance and leaves the background task with the plugin', async t => {
    const f = await fixture(t);
    const provider = await localProvider(t);
    const { chat, pluginManager } = host(provider);
    const { core, route } = await mountCore(f, chat);
    t.after(() => core.close());
    const tool = 'CoreExecutionAsyncFixture';
    const marker = path.join(f.root, 'async-completed');
    const script = path.join(f.root, 'async-fixture.cjs');
    await fs.writeFile(script, [
        "console.log(JSON.stringify({ status: 'success', result: 'independently accepted' }));",
        `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'finished'), 900);`
    ].join('\n'));
    pluginManager.plugins.set(tool, {
        name: tool, pluginType: 'asynchronous', basePath: f.root,
        communication: { protocol: 'stdio', timeout: 2000 },
        entryPoint: { command: process.execPath + ' ' + script }
    });
    try {
        provider.setReply((_body, res) => reply(res, command(tool, 'no_reply')));
            const work = await f.call(route + '/send', { requestId: 'async-first', text: 'Start isolated local task' }, 202);
        await wait(() => core.store.work(work.workId)?.status === 'completed', 'parent Work completes on accepted handoff');
        assert.equal(core.store.db.prepare('SELECT status FROM work_invocations WHERE work_id=?').get(work.workId).status, 'returned');
        assert.equal(JSON.parse(core.store.db.prepare('SELECT result_json FROM work_invocations WHERE work_id=?')
            .get(work.workId).result_json).asyncAcceptance.state, 'accepted');
        assert.equal(provider.calls.length, 1);
        assert.equal(await fs.stat(marker).then(() => true, () => false), false);
        await wait(() => fs.readFile(marker, 'utf8').then(value => value === 'finished', () => false), 'background plugin continues after Work');
    } finally { pluginManager.plugins.delete(tool); }
});

test('silent asynchronous Archery keeps legacy grace without producing a Core acceptance receipt', async t => {
    const f = await fixture(t);
    const { pluginManager } = host(await localProvider(t));
    const native = require(BOX + '/modules/requestExecutionContext');
    const tool = 'CoreSilentAsyncFixture';
    const script = path.join(f.root, 'silent-fixture.cjs');
    await fs.writeFile(script, "setTimeout(() => {}, 260);");
    pluginManager.plugins.set(tool, {
        name: tool, pluginType: 'asynchronous', basePath: f.root,
        communication: { protocol: 'stdio', timeout: 150 },
        entryPoint: { command: process.execPath + ' ' + script }
    });
    try {
        const invoke = () => pluginManager.executePlugin(tool, '', null, { archeryNoReply: true, archeryNoReplyGraceMs: 5 });
        await assert.rejects(native.runCoreTurn({ workId: 'silent-fixture', signal: new AbortController().signal }, invoke),
            /initial response timed out/);
        assert.equal((await invoke()).__vcpArcheryNoReplySilent, true);
    } finally { pluginManager.plugins.delete(tool); }
});

test('Core starts each native group member with a fresh sink', async t => {
    const f = await fixture(t);
    const { chat } = host(await localProvider(t));
    const execute = chat.executeTurn.bind(chat);
    const sinks = [];
    chat.executeTurn = (request, sink) => {
        assert.equal(sink.committed, undefined);
        assert.equal(sink.errorCode, undefined);
        sinks.push(sink);
        if (sinks.length === 1) sink.errorCode = 'FIRST_TURN_DIAGNOSTIC';
        return execute(request, sink);
    };
    const { core } = await mountCore(f, chat);
    t.after(() => core.close());
    const workspace = core.workspace;
    const actor = core.local.actor;
    const members = ['member-one', 'member-two'];
    const config = {
        group: { name: 'Fixture', mode: 'sequential', members },
        agents: members.map(id => ({ id, name: id, model: 'synthetic', systemPrompt: 'Isolated group member.', streamOutput: false }))
    };
    const topic = localTopicKey('group', 'group-fresh', 'topic-fresh');
    await core.local.define(topic, { ownerType: 'group', ownerId: 'group-fresh', topicId: 'topic-fresh', name: 'Fixture', config },
        group => core.supportsGroup(group));
    const resolved = core.topic(actor, workspace, topic, 'execute');
    const work = await core.send(resolved, actor.principal, { requestId: 'fresh-sinks', text: 'Fixture group turn' }, () => {}, actor);
    await wait(() => core.store.work(work.workId)?.status === 'completed', 'both group members committed');
    assert.equal(sinks.length, 2);
    assert.notEqual(sinks[0], sinks[1]);
});

test('Core uses native ordinary approval for approve, deny, expiry and Work cancellation', async t => {
    const f = await fixture(t);
    const provider = await localProvider(t);
    const { chat, pluginManager } = host(provider);
    const hub = require(BOX + '/WebSocketServer');
    const Ws = require(BOX + '/node_modules/ws');
    const server = http.createServer();
    const key = 'isolated-core-approval-fixture';
    hub.setPluginManager(pluginManager);
    hub.initialize(server, { vcpKey: key });
    pluginManager.setWebSocketServer(hub);
    chat.config.webSocketServer = hub;
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const ws = new Ws('ws://127.0.0.1:' + server.address().port + '/VCPlog/VCP_Key=' + key);
    t.after(async () => {
        ws.terminate();
        await hub.shutdown();
        await new Promise(resolve => server.close(resolve));
    });
    await once(ws, 'open');

    const tool = 'CoreOrdinaryApprovalFixture';
    const settings = pluginManager.toolApprovalManager;
    const originalConfig = settings.configPath;
    settings.configPath = path.join(f.root, 'ordinary-approval.json');
    const configure = async timeoutMinutes => {
        await fs.writeFile(settings.configPath, JSON.stringify({ enabled: true, timeoutMinutes, approvalList: [tool] }));
        settings.loadConfig();
    };
    await configure(0.1);
    let invokes = 0;
    pluginManager.plugins.set(tool, { name: tool, pluginType: 'hybridservice', communication: { protocol: 'direct' } });
    pluginManager.serviceModules.set(tool, { module: { async processToolCall() { invokes++; return 'ordinary tool ran'; } } });
    t.after(() => {
        settings.configPath = originalConfig;
        settings.loadConfig();
        pluginManager.plugins.delete(tool);
        pluginManager.serviceModules.delete(tool);
    });
    const frames = [];
    ws.on('message', bytes => {
        const frame = JSON.parse(bytes);
        if (frame.type === 'tool_approval_request' && frame.data.toolName === tool) frames.push(frame.data);
    });
    const { core, route } = await mountCore(f, chat);
    t.after(() => core.close());
    let modelCalls = 0;
    provider.setReply((_body, res) => reply(res, modelCalls++ === 0 ? command(tool) : 'Ordinary Work settled.'));
    const decide = (id, approved) => ws.send(JSON.stringify({
        type: 'tool_approval_response', data: { requestId: id, approved }
    }));
    const ledger = workId => core.store.db.prepare('SELECT status FROM work_invocations WHERE work_id=?').all(workId);
    const cases = ['approve', 'deny', 'expire', 'cancel'];
    for (const action of cases) {
        if (action === 'expire') await configure(0.02);
        if (action === 'cancel') await configure(0.1);
        modelCalls = 0;
        const beforeInvokes = invokes;
        const previousFrames = frames.length;
        const admitted = await f.call(route + '/send', { requestId: 'ordinary-' + action, text: action }, 202);
        const id = admitted.workId;
        await wait(() => frames.length === previousFrames + 1 && core.store.work(id)?.status === 'waiting_approval',
            'published and durably waiting ' + action);
        const challenge = frames.at(-1);
        assert.equal(challenge.workId, id);
        assert.deepEqual(ledger(id), []);
        assert.equal(invokes, beforeInvokes);
        if (action === 'approve' || action === 'deny') decide(challenge.requestId, action === 'approve');
        if (action === 'cancel') await f.call(route + '/works/' + id + '/cancel', { requestId: 'cancel-waiting-tool' });
        await wait(() => core.store.work(id)?.status === (action === 'cancel' ? 'cancelled' : 'completed'), action + ' terminal');
        assert.equal(pluginManager.pendingApprovals.has(challenge.requestId), false);
        if (action === 'expire' || action === 'cancel') decide(challenge.requestId, true);
        assert.deepEqual(ledger(id).map(row => row.status), action === 'approve' ? ['returned'] : []);
        assert.equal(invokes, action === 'approve' ? beforeInvokes + 1 : beforeInvokes);
    }
    assert.equal(invokes, 1);
});

test('Core rejects the retired Shared mode and foreign database before writing schema', async t => {
    const { root } = await fixture(t);
    const env = { VCP_CORE_MODE: 'shared', VCP_CORE_DATA_DIR: path.join(root, 'retired') };
    assert.throws(() => startCoreHost({ env }), /CORE_DEVELOPMENT_CONFIGURATION_REQUIRED/);
    await assert.rejects(fs.stat(env.VCP_CORE_DATA_DIR), { code: 'ENOENT' });
    const { DatabaseSync } = require('node:sqlite');
    const filename = path.join(root, 'core.sqlite');
    const old = new DatabaseSync(filename);
    old.exec("CREATE TABLE legacy_messages (content TEXT); INSERT INTO legacy_messages VALUES ('kept');");
    old.close();
    const before = await fs.readFile(filename);
    assert.throws(() => startCoreHost({ app: express(), chat: {}, listenHost: '127.0.0.1',
        serverKey: 'fixture-key', env: { VCP_CORE_DATA_DIR: root } }), { code: 'CORE_EXISTING_AUTHORITY_REQUIRED' });
    assert.deepEqual(await fs.readFile(filename), before);
    assert.deepEqual(await fs.readdir(root), ['core.sqlite']);
});

test('Core runs a native AgentAssistant child tool in the standalone task ledger', async t => {
    assert.ok(process.env.VCP_TEST_SERVER, 'Use an isolated host code directory for the plugin fixture');
    const f = await fixture(t);
    const provider = await localProvider(t);
    const { chat, pluginManager } = host(provider);
    const name = 'CoreStandaloneDelegate', childModel = 'child-model';
    const aaDir = path.join(BOX, 'Plugin', 'AgentAssistant');
    await fs.writeFile(path.join(aaDir, 'config.json'), JSON.stringify({
        delegationMaxRounds: 2, delegationTimeout: 60000,
        agents: [{ baseName: 'FIXTURE', modelId: childModel, chineseName: name, systemPrompt: 'Isolated delegation.' }]
    }), { flag: 'wx' });
    const assistant = require(aaDir + '/AgentAssistant');
    assistant.initialize({ PORT: '1', Key: 'fixture-key' }, {});
    t.after(() => assistant.shutdown());
    const childTool = 'CoreStandaloneChildTool';
    pluginManager.plugins.set('AgentAssistant', { name: 'AgentAssistant', pluginType: 'hybridservice', communication: { protocol: 'direct' } });
    pluginManager.serviceModules.set('AgentAssistant', { module: assistant });
    pluginManager.plugins.set(childTool, { name: childTool, pluginType: 'hybridservice', communication: { protocol: 'direct' } });
    let childInvocations = 0;
    pluginManager.serviceModules.set(childTool, { module: { async processToolCall() {
        childInvocations++;
        return 'standalone child tool result';
    } } });
    const { core, route } = await mountCore(f, chat);
    t.after(() => core.close());
    core.local.delegationAgents.add(name);
    let parentCalls = 0;
    provider.setReply((body, res) => {
        if (body.model === childModel) {
            return reply(res, JSON.stringify(body.messages).includes('standalone child tool result')
                ? '[[Flowlock::Complete]]\nStandalone native task result.'
                : command(childTool));
        }
        return reply(res, parentCalls++ ? 'Parent Work completed.' : [
            '<<<[TOOL_REQUEST]>>>', 'tool_name:「始」AgentAssistant「末」,',
            'agent_name:「始」' + name + '「末」,', 'task_delegation:「始」true「末」,',
            'prompt:「始」Use the isolated tool before completing.「末」', '<<<[END_TOOL_REQUEST]>>>'
        ].join('\n'));
    });
    const work = await f.call(route + '/send', { requestId: 'child-standalone-work', text: 'Native delegation' }, 202);
    let task;
    await wait(async () => {
        if (core.store.work(work.workId)?.status !== 'completed') return false;
        task = (await f.call(route + '/works/' + work.workId + '/tasks')).tasks[0];
        return task?.state === 'completed';
    }, 'parent Work and native child are separately completed');
    assert.equal(childInvocations, 1);
    assert.equal(core.store.db.prepare("SELECT count(*) AS n FROM work_invocations WHERE plugin_name=?").get(childTool).n, 0);
    assert.equal(core.store.db.prepare("SELECT count(*) AS n FROM core_aa_attempts WHERE task_id=? AND state='settled'").get(task.id).n, 2);
    assert.match((await f.call(route + '/works/' + work.workId + '/tasks/' + task.id)).content, /Standalone native task result/);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const fse = require('fs-extra');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { HistoryMutationQueue } = require('../modules/services/historyMutationQueue');
const AgentConfigManager = require('../modules/utils/agentConfigManager');
const { PluginAgentOperationService } = require('../modules/services/pluginAgentOperationService');
const project = path.resolve(__dirname, '..');
const quiet = { log() {}, warn() {}, error() {} };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const d = (topicId = 'old_topic', itemId = 'agent_a') => ({ itemId, itemType: 'agent', topicId });
function exitAfterConfigPublication(root, topicId) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(__dirname, 'f06-history-crash-worker.cjs'), root, 'config-published', 'delete-config', topicId],
            { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'], cwd: root });
        let stderr = '';
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('config-publication worker timeout')); }, 10000);
        child.stderr.on('data', bytes => { stderr += bytes; });
        child.on('error', reject); child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stderr }); });
    });
}

// Execute actual handler source with a minimal Electron/UI shell. Persistence,
// configuration manager, queue, IDs, filesystem and PluginAgentOperationService
// are real. No live app, provider, config, History or IPC endpoint is contacted.
function loadHandler(relative, dependencies) {
    const file = path.join(project, relative), module = { exports: {} };
    const reviewedRequire = name => {
        if (['../modules/services/topicGenerationLease', '../modules/services/historyAuthority', '../services/historyAuthority'].includes(name)) return require('node:module').createRequire(file)(name);
        assert.ok(dependencies.has(name), `unreviewed handler dependency: ${name}`);
        return dependencies.get(name);
    };
    new Function('require', 'module', 'exports', '__dirname', '__filename', 'console',
        fsSync.readFileSync(file, 'utf8'))(reviewedRequire, module, module.exports, path.dirname(file), file, quiet);
    return module.exports;
}

async function fixture(t, { topics = [{ id: 'old_topic', name: 'Old topic' }], commitFault = () => {} } = {}) {
    const root = await fs.mkdtemp(path.join(__dirname, '.f06-host-'));
    const agentDir = path.join(root, 'Agents'), userDataDir = path.join(root, 'UserData');
    await fs.mkdir(path.join(agentDir, 'agent_a'), { recursive: true }); await fs.mkdir(userDataDir);
    const manager = new AgentConfigManager(agentDir);
    await manager.writeAgentConfig('agent_a', { id: 'agent_a', name: 'Synthetic Agent', topics });
    const queue = new HistoryMutationQueue({ userDataDir, logger: quiet, commitFault });
    t.after(async () => { await queue.dispose(); await fs.rm(root, { recursive: true, force: true }); });
    const handlers = new Map();
    const frame = { url: pathToFileURL(path.join(project, 'main.html')).href, detached: false };
    const sender = { mainFrame: frame, isDestroyed: () => false, getType: () => 'window', getURL: () => frame.url };
    const mainWindow = { isDestroyed: () => false, webContents: sender };
    const ipcMain = { handle(name, fn) { handlers.set(name, fn); }, removeHandler(name) { handlers.delete(name); }, on() {},
        invoke(name, ...args) { return handlers.get(name)({ sender, senderFrame: frame }, ...args); } };
    const hostHooks = { emitAsync: async () => {}, emit() {} };
    const modelTrajectory = { clearTrajectoryOf: async () => {}, clearTrajectoriesOfOwner: async () => {} };
    const shared = new Map([
        ['electron', { ipcMain, dialog: {}, BrowserWindow: {} }], ['fs-extra', fse], ['path', path], ['crypto', crypto],
        ['url', require('node:url')], ['../services/historyMutationQueue', { HistoryMutationQueue, conversationKey: require('../modules/services/historyMutationQueue').conversationKey }],
        ['../utils/agentConfigManager', AgentConfigManager],
        ['../utils/atomicReplace', require('../modules/utils/atomicReplace')],
        ['../services/syncWriterBoundary', require('../modules/services/syncWriterBoundary')],
        ['@vcp/core-rules/request-envelope', require('@vcp/core-rules/request-envelope')],
        ['../modelTrajectory', modelTrajectory], ['../agentMood', { getAgentMoodStore: () => null }], ['../hostHooks', { hostHooks }],
    ]);
    const side = loadHandler('modules/ipc/sideChatHandlers.js', new Map([...shared,
        ['./applicationSender', require('../modules/ipc/applicationSender')],
    ]));
    side.initialize({ USER_DATA_DIR: userDataDir, AGENT_DIR: agentDir, historyMutationQueue: queue, ipcMain, mainWindow });
    const group = loadHandler('Groupmodules/groupchat.js', new Map([
        ['@vcp/core-rules/group/streamDelta', require('@vcp/core-rules/group/streamDelta')],
        ['@vcp/core-rules/group/speaker', require('@vcp/core-rules/group/speaker')],
        ['@vcp/core-rules/group/modelSelection', require('@vcp/core-rules/group/modelSelection')],
        ['electron', { ipcMain }], ['fs-extra', fse], ['node:fs/promises', fs], ['node:process', process], ['path', path], ['crypto', crypto],
        ['../modules/utils/atomicReplace', require('../modules/utils/atomicReplace')],
        ['../modules/utils/historyConfiguration', require('../modules/utils/historyConfiguration')],
        ['../modules/contextSanitizer', {}], ['../modules/modelTrajectory', modelTrajectory], ['../modules/fileManager', {}],
        ['../modules/ipc/canvasHandlers', {}], ['../modules/ipc/tavernHandlers', {}], ['../modules/tavernRulesEngine', {}],
        ['./modes/sequentialMode', require('../Groupmodules/modes/sequentialMode')],
        ['./modes/natureRandomMode', require('../Groupmodules/modes/natureRandomMode')],
        ['./modes/inviteOnlyMode', require('../Groupmodules/modes/inviteOnlyMode')],
        ['./modes/jevDecisionMode', require('../Groupmodules/modes/jevDecisionMode')],
        ['./jevGroupSessionOrchestrator', {}], ['./groupContextWindow', require('../Groupmodules/groupContextWindow')],
        ['./topicTitleManager', {}], ['./streamWatchdog', require('../Groupmodules/streamWatchdog')], ['./groupChatUrl', require('../Groupmodules/groupChatUrl')],
    ]));
    group.initializePaths({ APP_DATA_ROOT_IN_PROJECT: root, AGENT_DIR: agentDir, USER_DATA_DIR: userDataDir });
    group.initializeRuntimeServices({ historyMutationQueue: queue });
    const chat = loadHandler('modules/ipc/chatHandlers.js', new Map([...shared,
        ['../contextSanitizer', {}], ['../vcpClient', {}], ['../services/senderTaskRegistry', require('../modules/services/senderTaskRegistry')],
        ['../services/attachmentDialogState', {}], ['../../Groupmodules/topicTitleManager', {}], ['../../Groupmodules/groupchat', group], ['./workspaceHandlers', {}], ['./sideChatHandlers', side],
    ]));
    const context = { AGENT_DIR: agentDir, USER_DATA_DIR: userDataDir, APP_DATA_ROOT_IN_PROJECT: root,
        SETTINGS_FILE: path.join(root, 'settings.json'), USER_AVATAR_FILE: path.join(root, 'user.png'),
        agentConfigManager: manager, historyMutationQueue: queue };
    chat.initialize(mainWindow, context);
    const agent = loadHandler('modules/ipc/agentHandlers.js', new Map([...shared,
        ['../services/agentPortraitImages', { forgetPortraitDisplayImages: async () => {} }],
        ['../services/portraitOptimizer', { withPortraitLock: async (_dir, fn) => fn() }],
    ]));
    agent.initialize(context);
    const service = new PluginAgentOperationService({ agentDir, userDataDir, agentConfigManager: manager, historyMutationQueue: queue, appDataRoot: root, logger: quiet });
    return { root, agentDir, userDataDir, manager, queue, service, group, call: (name, ...args) => ipcMain.invoke(name, ...args),
        config: () => fs.readFile(path.join(agentDir, 'agent_a', 'config.json'), 'utf8').then(JSON.parse) };
}

test('T01 native topic caller preserves a legitimate message accepted between config and initialize', async t => {
    const f = await fixture(t), update = f.manager.updateAgentConfig.bind(f.manager); let accepted;
    f.manager.updateAgentConfig = async (id, updater) => {
        const result = await update(id, updater);
        accepted = d(result.config.topics[0].id, id);
        await f.queue.write(accepted, [{ id: 'accepted-before-empty-init', content: 'must survive' }]);
        return result;
    };
    const result = await f.call('create-new-topic-for-agent', 'agent_a', 'New topic');
    assert.equal(result.success, true, JSON.stringify(result)); assert.equal(result.topicId, accepted.topicId);
    assert.deepEqual(await f.queue.read(accepted), [{ id: 'accepted-before-empty-init', content: 'must survive' }]);
});

test('T03 new-Agent caller preserves a legitimate write accepted after config publication', async t => {
    const f = await fixture(t), initialize = f.queue.initializeIfMissing.bind(f.queue);
    f.queue.initializeIfMissing = async (target, initial) => {
        await f.queue.write(target, [{ id: 'new-agent-accepted-message' }]); return initialize(target, initial);
    };
    const result = await f.call('create-agent', 'Synthetic New Agent');
    assert.equal(result.success, true, JSON.stringify(result));
    assert.deepEqual(await f.queue.read(d('default', result.agentId)), [{ id: 'new-agent-accepted-message' }]);
});

test('T05 same-millisecond concurrent native topic IDs are unique and configuration loses none', async t => {
    const f = await fixture(t), realNow = Date.now; let results;
    Date.now = () => 1794480000123;
    try { results = await Promise.all(Array.from({ length: 10 }, (_, i) => f.call('create-new-topic-for-agent', 'agent_a', `Topic ${i}`))); }
    finally { Date.now = realNow; }
    assert.ok(results.every(r => r.success), JSON.stringify(results));
    const ids = results.map(r => r.topicId); assert.equal(new Set(ids).size, 10);
    const config = await f.config(); assert.equal(config.topics.length, 11);
    assert.ok(ids.every(id => config.topics.filter(topic => topic.id === id).length === 1));
    for (const id of ids) assert.deepEqual(await f.queue.read(d(id)), []);
});

test('same-millisecond concurrent Agent IDs are unique and all owner identities initialize', async t => {
    const f = await fixture(t), realNow = Date.now; let results;
    Date.now = () => 1794480000123;
    try { results = await Promise.all(Array.from({ length: 10 }, () => f.call('create-agent', 'Same Agent Name'))); }
    finally { Date.now = realNow; }
    assert.ok(results.every(r => r.success), JSON.stringify(results));
    assert.equal(new Set(results.map(r => r.agentId)).size, 10);
    for (const result of results) {
        assert.deepEqual(await f.queue.read(d('default', result.agentId)), []);
        const config = JSON.parse(await fs.readFile(path.join(f.agentDir, result.agentId, 'config.json'), 'utf8'));
        assert.equal(config.name, 'Same Agent Name');
    }
});

test('T07 sequential topic creation and ordinary saves retain each topic independently', async t => {
    const f = await fixture(t);
    const first = await f.call('create-new-topic-for-agent', 'agent_a', 'First'); assert.equal(first.success, true);
    assert.equal((await f.call('save-chat-history', 'agent_a', first.topicId, [{ id: 'first-message' }])).success, true);
    const second = await f.call('create-new-topic-for-agent', 'agent_a', 'Second'); assert.equal(second.success, true);
    assert.notEqual(first.topicId, second.topicId);
    assert.deepEqual(await f.queue.read(d(first.topicId)), [{ id: 'first-message' }]);
    assert.deepEqual(await f.queue.read(d(second.topicId)), []);
});

test('T08 last-topic replacement preserves accepted data and durably denies deleted identity', async t => {
    const f = await fixture(t); await f.queue.write(d(), [{ id: 'old' }]);
    const update = f.manager.updateAgentConfig.bind(f.manager); let replacement;
    f.manager.updateAgentConfig = async (id, updater) => {
        const result = await update(id, updater);
        replacement = d(result.config.topics[0].id, id);
        await f.queue.write(replacement, [{ id: 'replacement-accepted' }]);
        return result;
    };
    const result = await f.call('delete-topic', 'agent_a', 'old_topic'); assert.equal(result.success, true, JSON.stringify(result));
    assert.notEqual(replacement.topicId, 'old_topic');
    assert.deepEqual(await f.queue.read(replacement), [{ id: 'replacement-accepted' }]);
    const config = await f.config(); assert.ok(config._historyDeletedTopics.includes('old_topic'));
    await assert.rejects(fs.lstat(f.queue.getHistoryPath('agent_a', 'old_topic')), { code: 'ENOENT' });
});

test('T09 actual delete-topic IPC fences already queued late save and prevents orphan directory', async t => {
    const fenced = deferred(), entered = deferred(), release = deferred();
    const f = await fixture(t, { topics: [{ id: 'old_topic' }, { id: 'retained_topic' }], commitFault: point => { if (point === 'deletion-fenced') fenced.resolve(); } });
    await f.queue.write(d(), [{ id: 'old' }]);
    const blocker = f.queue.run(d(), async () => { entered.resolve(); await release.promise; }); await entered.promise;
    const deletion = f.call('delete-topic', 'agent_a', 'old_topic'); await fenced.promise;
    const late = f.call('save-chat-history', 'agent_a', 'old_topic', [{ id: 'late-finish' }]); release.resolve();
    await blocker; assert.equal((await deletion).success, true); assert.equal((await late).success, false);
    await assert.rejects(fs.lstat(path.dirname(f.queue.getHistoryPath('agent_a', 'old_topic'))), { code: 'ENOENT' });
    const q = new HistoryMutationQueue({ userDataDir: f.userDataDir });
    try { await assert.rejects(q.write(d(), [{ id: 'restart-old-callback' }])); } finally { await q.dispose(); }
});

test('native side-chat creates marked hidden History and deleted child cannot be recreated by late save', async t => {
    const f = await fixture(t);
    const created = await f.call('side-chat:create-child', 'agent_a'); assert.equal(created.success, true, JSON.stringify(created));
    const target = d(created.topicId), file = f.queue.getHistoryPath('agent_a', created.topicId);
    assert.deepEqual(await f.queue.read(target), []); assert.equal((await f.config()).topics.some(topic => topic.id === created.topicId), false);
    const marker = JSON.parse(await fs.readFile(path.join(path.dirname(file), 'sidechat-child.json'), 'utf8'));
    assert.equal(marker.agentId, 'agent_a'); assert.equal(marker.topicId, created.topicId);
    await f.queue.write(target, [{ id: 'side-message' }]);
    const removed = await f.call('side-chat:delete-child', 'agent_a', created.topicId); assert.equal(removed.success, true, JSON.stringify(removed));
    assert.equal((await f.call('save-chat-history', 'agent_a', created.topicId, [{ id: 'late-side-callback' }])).success, false);
    await assert.rejects(fs.lstat(path.dirname(file)), { code: 'ENOENT' });
});

test('TopicSponsor publishes native config before initialization and preserves initial message/idempotency', async t => {
    const f = await fixture(t), initialize = f.queue.initializeIfMissing.bind(f.queue); let checked = 0;
    f.queue.initializeIfMissing = async (target, initial) => {
        assert.ok((await f.config()).topics.some(topic => topic.id === target.topicId)); checked++;
        return initialize(target, initial);
    };
    const args = { command: 'CreateFlowlockTopic', maid: 'agent_a', topic_name: 'Plugin topic', initial_message: 'First accepted plugin message' };
    const results = await Promise.all([f.service.processTopicCommand(args, { requestId: 'synthetic-idempotency' }), f.service.processTopicCommand(args, { requestId: 'synthetic-idempotency' })]);
    assert.deepEqual(results[0], results[1]);
    assert.equal(results[0].topic_id, results[1].topic_id); assert.equal(checked, 1);
    const history = await f.queue.read(d(results[0].topic_id));
    assert.equal(history.length, 1); assert.equal(history[0].content, args.initial_message);
    assert.equal(results[0].flowlock_status, 'pending');
    assert.equal((await f.config()).topics.filter(topic => topic.id === results[0].topic_id).length, 1);
});

test('TopicSponsor concurrent accepted content cannot silently drop the requested first message', async t => {
    const f = await fixture(t), update = f.manager.updateAgentConfig.bind(f.manager);
    f.manager.updateAgentConfig = async (id, updater) => {
        const result = await update(id, updater), target = d(result.config.topics[0].id, id);
        await f.queue.mutate(target, history => [...history, { id: 'concurrent-legitimate', role: 'assistant', content: 'Other accepted message' }]);
        return result;
    };
    const args = { command: 'CreateTopic', maid: 'agent_a', topic_name: 'Concurrent plugin topic', initial_message: 'Requested first plugin message' };
    const result = await f.service.processTopicCommand(args, { requestId: 'synthetic-concurrent-create' });
    const history = await f.queue.read(d(result.topic_id));
    assert.ok(history.some(message => message.id === 'concurrent-legitimate'));
    assert.ok(history.some(message => message.content === args.initial_message), 'plugin reports creation success but requested initial message is missing');
});

test('TopicSponsor initialization failure preserves config and already accepted content', async t => {
    const f = await fixture(t); let target;
    f.queue.initializeIfMissing = async descriptor => {
        target = descriptor; await f.queue.write(target, [{ id: 'accepted-before-plugin-failure' }]);
        throw Object.assign(new Error('synthetic-pending'), { code: 'SYNTHETIC_PENDING', status: 'pending' });
    };
    await assert.rejects(f.service.processTopicCommand({ command: 'CreateTopic', maid: 'agent_a', topic_name: 'Pending plugin topic', initial_message: 'First' }, { requestId: 'synthetic-failure' }), { code: 'SYNTHETIC_PENDING' });
    assert.ok((await f.config()).topics.some(topic => topic.id === target.topicId));
    assert.deepEqual(await f.queue.read(target), [{ id: 'accepted-before-plugin-failure' }]);
});

test('new Agent rejects repeated initial topic identities without publishing configuration', async t => {
    const f = await fixture(t);
    const result = await f.call('create-agent', 'Duplicate Topics Agent', { topics: [{ id: 'same' }, { id: 'same' }] });
    assert.equal(result.error, 'HISTORY_DUPLICATE_TOPIC');
    const matching = (await fs.readdir(f.agentDir)).filter(name => name.startsWith('Duplicate_Topics_Agent_'));
    for (const owner of matching) await assert.rejects(fs.lstat(path.join(f.agentDir, owner, 'config.json')), { code: 'ENOENT' });
});

test('late group reorder cannot erase owner deletion authority after its old config read', async t => {
    const f = await fixture(t), owner = await f.group.createAgentGroup('Reorder race');
    assert.equal(owner.success, true, JSON.stringify(owner));
    const groupId = owner.agentGroup.id, topicId = owner.agentGroup.topics[0].id;
    const configPath = path.join(f.root, 'AgentGroups', groupId, 'config.json');
    const read = fse.readJson, entered = deferred(), release = deferred(); let paused = false;
    fse.readJson = async function(file, ...args) {
        const result = await read.call(this, file, ...args);
        if (file === configPath && !paused) { paused = true; entered.resolve(); await release.promise; }
        return result;
    };
    let ordering, deleting;
    try {
        ordering = f.call('save-group-topic-order', groupId, [topicId]); await entered.promise;
        deleting = f.group.deleteAgentGroup(groupId);
        // The corrected shared config queue holds deletion behind this read.
        // A raw old-snapshot writer instead lets deletion finish first and then
        // restores old authority when released. Both actual paths are exercised.
        await Promise.race([deleting, new Promise(resolve => setTimeout(resolve, 40))]);
        release.resolve(); await Promise.all([ordering, deleting]);
    } finally { release.resolve(); fse.readJson = read; }
    assert.equal((await deleting).success, true);
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
    assert.equal(config._historyDeleting, true); assert.deepEqual(config.topics, []);
    const q = new HistoryMutationQueue({ userDataDir: f.userDataDir });
    try { await assert.rejects(q.write({ itemId: groupId, itemType: 'group', topicId }, [{ id: 'old-group-callback' }])); }
    finally { await q.dispose(); }
});

test('real process exit after deletion config update retains History and native delete-topic resumes cleanup', async t => {
    const f = await fixture(t, { topics: [{ id: 'old_topic' }, { id: 'retained_topic' }] });
    const oldBytes = '[ { "id": "committed-before-delete-exit", "content": "unknown physical deletion" } ]\n';
    const oldFile = f.queue.getHistoryPath('agent_a', 'old_topic');
    await fs.mkdir(path.dirname(oldFile), { recursive: true }); await fs.writeFile(oldFile, oldBytes);
    const child = await exitAfterConfigPublication(f.root, 'old_topic');
    assert.equal(child.code, 72, JSON.stringify(child));
    const config = await f.config();
    assert.equal(config.topics.some(topic => topic.id === 'old_topic'), false);
    assert.ok(config._historyDeletedTopics.includes('old_topic'));
    assert.equal(await fs.readFile(oldFile, 'utf8'), oldBytes, 'process exit must leave physical facts for continuation');
    const restarted = new HistoryMutationQueue({ userDataDir: f.userDataDir });
    try {
        await assert.rejects(restarted.initializeIfMissing(d()), { code: 'HISTORY_TOPIC_DELETED' });
        await assert.rejects(restarted.write(d(), [{ id: 'late-after-restart' }]), { code: 'HISTORY_TOPIC_DELETED' });
        assert.equal(await fs.readFile(oldFile, 'utf8'), oldBytes);
    } finally { await restarted.dispose(); }
    const result = await f.call('delete-topic', 'agent_a', 'old_topic');
    assert.equal(result.success, true, JSON.stringify(result));
    await assert.rejects(fs.lstat(path.dirname(oldFile)), { code: 'ENOENT' });
    const after = await f.config(); assert.ok(after._historyDeletedTopics.includes('old_topic'));
    assert.deepEqual(after.topics.map(topic => topic.id), ['retained_topic']);
});

for (const mode of ['pending-result', 'pending-throw']) {
    test(`TopicSponsor ${mode} retries and a new Service reuse one durable topic and first message`, async t => {
        const f = await fixture(t), initialize = f.queue.initializeIfMissing.bind(f.queue);
        let attempts = 0, target, mutations = 0;
        const mutate = f.queue.mutate.bind(f.queue);
        f.queue.mutate = (...args) => { mutations++; return mutate(...args); };
        f.queue.initializeIfMissing = async (descriptor, initial) => {
            target = descriptor;
            const result = await initialize(descriptor, initial);
            if (++attempts === 1) {
                if (mode === 'pending-throw') throw Object.assign(new Error('synthetic observer pending after persistence'), { code: 'SYNTHETIC_PENDING', status: 'pending' });
                return { ...result, success: false, status: 'pending', initializationStatus: 'pending' };
            }
            return result;
        };
        const args = { command: 'CreateFlowlockTopic', maid: 'agent_a', topic_name: 'Durable pending creation', initial_message: 'Exactly one durable initial message', flowlock_heartbeat: 7, flowlock_prompt: 'Preserve this request' };
        const context = { requestId: `synthetic-durable-${mode}` };
        await assert.rejects(f.service.processTopicCommand(args, context));
        const firstBytes = await fs.readFile(f.queue.getHistoryPath(target.itemId, target.topicId));
        const firstHistory = JSON.parse(firstBytes); assert.equal(firstHistory.length, 1);
        const retried = await f.service.processTopicCommand(args, context);
        assert.equal(retried.topic_id, target.topicId); assert.equal(mutations, 0, 'already persisted initial message must not be mutated again');
        assert.deepEqual(await fs.readFile(f.queue.getHistoryPath(target.itemId, target.topicId)), firstBytes);
        const nextManager = new AgentConfigManager(f.agentDir), nextQueue = new HistoryMutationQueue({ userDataDir: f.userDataDir });
        t.after(() => nextQueue.dispose());
        const restarted = new PluginAgentOperationService({ agentDir: f.agentDir, userDataDir: f.userDataDir, agentConfigManager: nextManager, historyMutationQueue: nextQueue, appDataRoot: f.root, logger: quiet });
        const resumed = await restarted.processTopicCommand(args, context);
        assert.equal(resumed.topic_id, retried.topic_id);
        const config = await f.config(); assert.equal(config.topics.filter(topic => topic.id === resumed.topic_id).length, 1); assert.equal(config.topics.length, 2);
        assert.deepEqual(await fs.readFile(f.queue.getHistoryPath(target.itemId, target.topicId)), firstBytes);
        assert.equal((await nextQueue.read(d(resumed.topic_id))).length, 1);
    });
}

test('TopicSponsor same request with changed parameters rejects before and after Service restart', async t => {
    const f = await fixture(t);
    const args = { command: 'CreateTopic', maid: 'agent_a', topic_name: 'Original request', initial_message: 'Original first message' };
    const context = { requestId: 'synthetic-parameter-conflict' };
    const created = await f.service.processTopicCommand(args, context);
    const changed = { ...args, initial_message: 'Changed request must be rejected' };
    const nextManager = new AgentConfigManager(f.agentDir), nextQueue = new HistoryMutationQueue({ userDataDir: f.userDataDir }); t.after(() => nextQueue.dispose());
    const restarted = new PluginAgentOperationService({ agentDir: f.agentDir, userDataDir: f.userDataDir, agentConfigManager: nextManager, historyMutationQueue: nextQueue, appDataRoot: f.root, logger: quiet });
    const outcomes = await Promise.allSettled([f.service.processTopicCommand(changed, context), restarted.processTopicCommand(changed, context)]);
    assert.ok(outcomes.every(outcome => outcome.status === 'rejected' && /TOPIC_CREATION_REQUEST_CONFLICT/.test(outcome.reason.message)), 'memory cache must not bypass native request parameter proof');
    assert.equal((await f.config()).topics.length, 2);
    const history = await f.queue.read(d(created.topic_id)); assert.equal(history.length, 1); assert.equal(history[0].content, args.initial_message);
});

test('TopicSponsor in-flight same request cannot adopt different parameters', async t => {
    const f = await fixture(t), initialize = f.queue.initializeIfMissing.bind(f.queue), entered = deferred(), release = deferred();
    f.queue.initializeIfMissing = async (...args) => { entered.resolve(); await release.promise; return initialize(...args); };
    const args = { command: 'CreateTopic', maid: 'agent_a', topic_name: 'In-flight original', initial_message: 'Original first message' }, context = { requestId: 'synthetic-inflight-conflict' };
    const first = f.service.processTopicCommand(args, context); await entered.promise;
    const conflicting = f.service.processTopicCommand({ ...args, topic_name: 'Changed while in flight' }, context).then(result => ({ result }), error => ({ error }));
    release.resolve(); const created = await first;
    assert.match((await conflicting).error?.message || '', /TOPIC_CREATION_REQUEST_CONFLICT/);
    assert.equal((await f.config()).topics.filter(topic => topic.id === created.topic_id).length, 1);
    assert.equal((await f.queue.read(d(created.topic_id))).length, 1);
});

test('TopicSponsor deleted request is denied in the same Service and after restart without recreation', async t => {
    const f = await fixture(t);
    const args = { command: 'CreateTopic', maid: 'agent_a', topic_name: 'Delete then retry', initial_message: 'Original first message' }, context = { requestId: 'synthetic-deleted-request' };
    const created = await f.service.processTopicCommand(args, context);
    assert.equal((await f.call('delete-topic', 'agent_a', created.topic_id)).success, true);
    const nextManager = new AgentConfigManager(f.agentDir), nextQueue = new HistoryMutationQueue({ userDataDir: f.userDataDir }); t.after(() => nextQueue.dispose());
    const restarted = new PluginAgentOperationService({ agentDir: f.agentDir, userDataDir: f.userDataDir, agentConfigManager: nextManager, historyMutationQueue: nextQueue, appDataRoot: f.root, logger: quiet });
    const outcomes = await Promise.allSettled([f.service.processTopicCommand(args, context), restarted.processTopicCommand(args, context)]);
    const evidence = {
        replay: outcomes.map(outcome => outcome.status === 'fulfilled' ? 'accepted' : outcome.reason.message),
        topicPublishedAfterReplay: (await f.config()).topics.some(topic => topic.id === created.topic_id),
        historyExistsAfterReplay: fsSync.existsSync(path.join(f.userDataDir, 'agent_a', 'topics', created.topic_id, 'history.json')),
    };
    assert.ok(outcomes.every(outcome => outcome.status === 'rejected' && /HISTORY_TOPIC_DELETED/.test(outcome.reason.message)), JSON.stringify(evidence));
    const config = await f.config(); assert.ok(config._historyDeletedTopics.includes(created.topic_id)); assert.equal(config.topics.some(topic => topic.id === created.topic_id), false);
    await assert.rejects(fs.lstat(path.dirname(f.queue.getHistoryPath('agent_a', created.topic_id))), { code: 'ENOENT' });
});

test('TopicSponsor requests without request IDs still create distinct fresh topics', async t => {
    const f = await fixture(t);
    const args = { command: 'CreateTopic', maid: 'agent_a', topic_name: 'Fresh unkeyed creation', initial_message: 'Fresh first message' };
    const [first, second] = await Promise.all([f.service.processTopicCommand(args), f.service.processTopicCommand(args)]);
    assert.notEqual(first.topic_id, second.topic_id); assert.equal((await f.config()).topics.length, 3);
    for (const topicId of [first.topic_id, second.topic_id]) assert.equal((await f.queue.read(d(topicId))).length, 1);
});

test('TopicSponsor in-flight coalescing never returns another requested owner as a success', async t => {
    const f = await fixture(t), createdOwner = await f.call('create-agent', 'Synthetic Second Owner');
    assert.equal(createdOwner.success, true, JSON.stringify(createdOwner));
    const initialize = f.queue.initializeIfMissing.bind(f.queue), entered = deferred(), release = deferred(); let paused = false;
    f.queue.initializeIfMissing = async (...args) => {
        if (!paused) { paused = true; entered.resolve(); await release.promise; }
        return initialize(...args);
    };
    const args = { command: 'CreateTopic', maid: 'agent_a', topic_name: 'Owner-specific operation', initial_message: 'Owner-specific first message' }, context = { requestId: 'synthetic-owner-scope' };
    const first = f.service.processTopicCommand(args, context); await entered.promise;
    const second = f.service.processTopicCommand({ ...args, maid: createdOwner.agentId }, context).then(result => ({ result }), error => ({ error }));
    release.resolve(); assert.equal((await first).agent_id, 'agent_a');
    const outcome = await second;
    if (outcome.result) assert.equal(outcome.result.agent_id, createdOwner.agentId, 'a successful response must belong to the requested owner');
    else assert.match(outcome.error?.message || '', /CONFLICT|DENIED/);
});

test('Agent deletion preserves owned and unknown lock/temp files until the real manager releases its lock', async t => {
    const f = await fixture(t); await f.queue.write(d(), [{ id: 'accepted-before-owner-delete' }]);
    const ownerDir = path.join(f.agentDir, 'agent_a'), ownedLock = path.join(ownerDir, 'config.json.lock');
    const unknownLock = path.join(ownerDir, 'unknown-operation.lock'), unknownTemp = path.join(ownerDir, 'unknown-operation.tmp');
    const unknownLockBytes = 'synthetic unknown operation; preserve all bytes\n';
    const unknownTempBytes = 'synthetic unfinished temporary output; preserve all bytes\n';
    await fs.writeFile(unknownLock, unknownLockBytes); await fs.writeFile(unknownTemp, unknownTempBytes);
    const originalRelease = f.manager.releaseLock.bind(f.manager), entered = deferred(), allowRelease = deferred(), released = deferred();
    let releaseStarted = false, entryTimer;
    t.after(() => allowRelease.resolve());
    f.manager.releaseLock = async (...args) => {
        releaseStarted = true;
        entered.resolve(args[0]); await allowRelease.promise;
        try { return await originalRelease(...args); } finally { released.resolve(); }
    };
    let deleting;
    try {
        deleting = f.call('delete-agent', 'agent_a');
        assert.equal(await Promise.race([entered.promise, new Promise((_, reject) => {
            entryTimer = setTimeout(() => reject(new Error('real manager releaseLock was not reached within 2 seconds')), 2000);
        })]), 'agent_a');
        clearTimeout(entryTimer);
        // Do not read or parse the manager's ownership token. Stable inode,
        // size and nanosecond timestamps establish that cleanup neither
        // removed/replaced the owned lock nor rewrote its bytes.
        const identity = stat => ({ dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs });
        const ownedBefore = identity(await fs.lstat(ownedLock, { bigint: true }));
        const result = await deleting; assert.equal(result.success, true, JSON.stringify(result));
        assert.deepEqual(identity(await fs.lstat(ownedLock, { bigint: true })), ownedBefore);
        assert.equal(await fs.readFile(unknownLock, 'utf8'), unknownLockBytes);
        assert.equal(await fs.readFile(unknownTemp, 'utf8'), unknownTempBytes);
        const tombstone = await f.config(); assert.equal(tombstone._historyDeleting, true); assert.deepEqual(tombstone.topics, []);
    } finally {
        clearTimeout(entryTimer);
        allowRelease.resolve();
        if (releaseStarted) await released.promise;
        f.manager.releaseLock = originalRelease;
        if (deleting) await deleting;
    }
    // The real manager, using its own ownership checks, is the only remover.
    await assert.rejects(fs.lstat(ownedLock), { code: 'ENOENT' });
    assert.equal(await fs.readFile(unknownLock, 'utf8'), unknownLockBytes);
    assert.equal(await fs.readFile(unknownTemp, 'utf8'), unknownTempBytes);
});

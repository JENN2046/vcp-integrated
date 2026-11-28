'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const fse = require('fs-extra');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { HistoryMutationQueue } = require('../modules/services/historyMutationQueue');
const AgentConfigManager = require('../modules/utils/agentConfigManager');
const { PluginAgentOperationService } = require('../modules/services/pluginAgentOperationService');
const project = path.resolve(__dirname, '..');
const quiet = { log() {}, warn() {}, error() {} };

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

async function fixture(t, { topics = [{ id: 'old_topic', name: 'Old topic' }], commitFault } = {}) {
    const root = await fs.mkdtemp(path.join(__dirname, '.f06-host-'));
    const agentDir = path.join(root, 'Agents');
    await fs.mkdir(path.join(agentDir, 'agent_a'), { recursive: true });
    await fs.mkdir(path.join(root, 'UserData'));
    await new AgentConfigManager(agentDir).writeAgentConfig('agent_a', { id: 'agent_a', name: 'Synthetic Agent', topics });
    const host = openFixture(root, { commitFault });
    t.after(async () => { await host.queue.dispose(); await fs.rm(root, { recursive: true, force: true }); });
    return host;
}

function openFixture(root, { commitFault } = {}) {
    const agentDir = path.join(root, 'Agents'), userDataDir = path.join(root, 'UserData');
    const manager = new AgentConfigManager(agentDir);
    const queue = new HistoryMutationQueue({ userDataDir, logger: quiet, commitFault });
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

module.exports = { fixture, openFixture };

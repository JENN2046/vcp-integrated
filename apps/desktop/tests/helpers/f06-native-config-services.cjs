'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const AgentConfigManager = require('../../modules/utils/agentConfigManager');

function createNativeConfigServices(root, queue) {
    const filename = path.resolve(__dirname, '../../Groupmodules/groupchat.js');
    const localRequire = createRequire(filename), module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        module, exports: module.exports, console: { log() {}, error() {}, warn() {} },
        require(name) {
            if (name === 'electron') return { ipcMain: {} };
            if (['../modules/modelTrajectory', '../modules/contextSanitizer', '../modules/fileManager', '../modules/ipc/canvasHandlers', '../modules/ipc/tavernHandlers', '../modules/tavernRulesEngine', './topicTitleManager', './jevGroupSessionOrchestrator'].includes(name)) return {};
            return localRequire(name);
        },
    }, { filename });
    const group = module.exports;
    group.initializePaths({ APP_DATA_ROOT_IN_PROJECT: root, USER_DATA_DIR: path.join(root, 'UserData'), AGENT_DIR: path.join(root, 'Agents') });
    group.initializeRuntimeServices({ historyMutationQueue: queue });
    return { agentConfigManager: new AgentConfigManager(path.join(root, 'Agents')), groupConfigMutator: group.mutateGroupConfig, group };
}
module.exports = { createNativeConfigServices };

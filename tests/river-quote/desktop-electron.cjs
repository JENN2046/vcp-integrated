'use strict';

const path = require('node:path');
const { install } = require('../integration/electron-fixture-hooks.cjs');
const { PluginAgentOperationService } = require(path.join(process.env.NS_HOST, 'modules/services/pluginAgentOperationService.js'));
const { initialize, processToolCall } = require(path.join(process.env.NS_HOST, 'VCPDistributedServer/Plugin/TopicSponsor/topicsponsor-service.js'));
let operations;

// Capture the instance constructed by the host even when no real model is configured.
const Module = require('node:module');
const load = Module._load;
const instrumented = { PluginAgentOperationService: class extends PluginAgentOperationService {
    constructor(...args) {
        super(...args);
        operations = this;
    }
} };
Module._load = function (...args) {
    const result = load.apply(this, args);
    return result?.PluginAgentOperationService === PluginAgentOperationService ? { ...result, ...instrumented } : result;
};

install({ commands: {
    async 'topic-sponsor-deliver'(_window, args) {
        if (!operations) throw Error('Native TopicSponsor operations have not started');
        await initialize({ services: { pluginAgentOperationService: operations } });
        return processToolCall(args, { requestId: 'fixture-river-delivery' });
    },
} });
require('../integration/electron.cjs');

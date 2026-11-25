'use strict';

const { createServer } = require('node:http');
const fs = require('node:fs/promises');
const { BOX } = require('./sharedSingleHarness.cjs');

async function localProvider(t) {
    const calls = [];
    let reply = (_body, res) => res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'core reply' }, finish_reason: 'stop' }]
    }));
    const server = createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks));
        calls.push(body);
        reply(body, res);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
    return { calls, url: 'http://127.0.0.1:' + server.address().port, setReply: fn => { reply = fn; } };
}

function host(provider) {
    const ChatCompletionHandler = require(BOX + '/modules/chatCompletionHandler');
    const pluginManager = require(BOX + '/Plugin');
    const events = [];
    const meta = { turnId: 'core-fixture' };
    pluginManager.messagePreprocessors.set('OneRing', {
        extractMetaFromMessages: () => meta,
        recordAIResponseWithMeta(_meta, text) { events.push(['one-ring', text]); },
        markAIResponseAborted() { events.push(['aborted']); }
    });
    pluginManager.messagePreprocessors.set('VCPTavern', {
        processMessages(messages, config) {
            config.tavernInteraction.commit = () => events.push(['tavern']);
            return messages;
        }
    });
    pluginManager.plugins.set('VCPTavern', { name: 'VCPTavern' });
    pluginManager.preprocessorOrder = ['OneRing'];
    const preprocessor = pluginManager.executeMessagePreprocessor.bind(pluginManager);
    pluginManager.executeMessagePreprocessor = (name, messages, config) => name === 'OneRing'
        ? messages : preprocessor(name, messages, config);
    const webSocketServer = { broadcast() {}, cancelVcpLogApprovalCache() {} };
    const chat = new ChatCompletionHandler({
        apiUrl: provider.url, apiKey: 'fixture', pluginManager, webSocketServer, activeRequests: new Map(),
        writeDebugLog: async () => {}, apiRetries: 1, apiRetryDelay: 1,
        maxVCPLoopStream: 5, maxVCPLoopNonStream: 5, modelRedirectHandler: { redirectModelForBackend: model => model },
        detectors: [], superDetectors: [], cachedEmojiLists: {},
        enableRoleDivider: false, VCPToolCode: false
    });
    return { chat, events, pluginManager };
}

async function mountCore(f, chat) {
    const directory = f.root + '-core';
    await fs.mkdir(f.root + '/files', { recursive: true });
    const { CoreService } = require(BOX + '/core/service');
    const options = { directory, legacyDirectory: f.root, workspace: 'sharedAB', shared: f.shared, mobile: f.portal, chat };
    const core = new CoreService(options);
    f.shared.core = core;
    f.app.use(['/api/plugins/NativeSync/source/core', '/api/plugins/NativeSync/core'], core.router(req => f.shared.desktop({
        sourceId: req.headers['x-nativesync-source'], deviceId: req.headers['x-nativesync-device'],
        spaceId: req.headers['x-nativesync-space']
    }, req.headers['x-nativesync-capabilities'])));
    f.portal.coreRouter = core.router((req, workspace, permission) => f.shared.mobile(req.mobileSession, workspace, permission));
    return { core, options, route: '/core/sharedAB/' + f.topic.id };
}

function setStream(f, enabled) {
    const owner = f.shared.get(f.actor('A'), 'sharedAB', f.owner.id);
    f.shared.saveConfig(f.actor('A'), { sharedSpaceId: 'sharedAB', sharedId: owner.id, opId: 'core-config',
        expectedVersion: owner.version, config: { ...owner.config, streamOutput: enabled } });
}

module.exports = { localProvider, host, mountCore, setStream };

'use strict';

const { createServer } = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const CHAT = path.resolve(__dirname, "../../../apps/desktop");
const BOX = process.env.VCP_TEST_SERVER || path.resolve(__dirname, '../../../apps/server');

async function localProvider(t) {
    const calls = [];
    let modelRows = [];
    let reply = (_body, res) => res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'core reply' }, finish_reason: 'stop' }]
    }));
    const server = createServer(async (req, res) => {
        if (req.method === 'GET' && req.url === '/v1/models') {
            return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data:modelRows }));
        }
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks));
        calls.push(body);
        reply(body, res);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
    return { calls, url: 'http://127.0.0.1:' + server.address().port, setReply: fn => { reply = fn; }, setModels: rows => { modelRows = rows; } };
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

async function coreFixture(t, chat, { root, origin, proxyCertificate, ...extensions } = {}) {
    const assert = require('node:assert/strict');
    const { execFileSync } = require('node:child_process');
    const { once } = require('node:events');
    const { createServer } = require('node:https');
    const tls = require('node:tls');
    const express = require(BOX + '/node_modules/express');
    const { CoreService } = require(BOX + '/core/service');
    const { localTopicKey } = require(BOX + '/core/localWorkspace');
    root ||= await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'core-remote-test-'));
    const directory = path.join(root, 'core');
    const certFile = path.join(root, 'fixture-cert.pem');
    const keyFile = path.join(root, 'fixture-key.pem');
    execFileSync('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-keyout',keyFile,'-out',certFile,
        '-days','1','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
    const certificate = await fs.readFile(certFile);
    const trusted = tls.getCACertificates('default');
    tls.setDefaultCACertificates([...trusted, certificate.toString(), ...(proxyCertificate ? [proxyCertificate.toString()] : [])]);
    const app = express();
    const server = createServer({ key: await fs.readFile(keyFile), cert: certificate }, app);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const endpoint = 'https://127.0.0.1:' + server.address().port;
    const workspace = 'personal';
    const options = { directory, workspace, chat, remoteConfig: { origin: origin || endpoint, hours: 1 }, ...extensions };
    let core;
    const clients = new Set();
    t.after(async () => {
        tls.setDefaultCACertificates(trusted);
        await Promise.all([...clients].map(client => client.close()));
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        await core?.close();
        await fs.rm(root, { recursive: true, force: true });
    });
    core = new CoreService(options);
    app.use('/core/api', (req, res, next) => core.remoteDesktopRouter(req, res, next));
    app.use('/mobile', (req, res, next) => core.remoteMobileRouter(req, res, next));
    function bindRouters() {
        core.remoteDesktopRouter = core.remote.router('desktop');
        core.remoteMobileRouter = core.remote.router('mobile');
    }
    bindRouters();
    app.post('/v1/chat/completions', express.json(), (req, res) => chat.handle(req, res));
    const request = (route, { body, headers, method, signal } = {}) => fetch((origin || endpoint) + route, {
        method: method || (body === undefined ? 'GET' : 'POST'), signal,
        headers: { ...(origin && { 'x-fixture-command': '1' }), ...(body !== undefined && { 'content-type': 'application/json', origin: options.remoteConfig.origin }), ...headers },
        ...(body !== undefined && { body: JSON.stringify(body) })
    });
    async function pair(kind, permissions, proof) {
        const scopes = permissions.map(permission => 'shared:' + workspace + ':' + permission);
        if (kind === 'desktop') scopes.push('desktop');
        const grant = core.remote.sessions.createCode(scopes);
        const isDesktop = kind === 'desktop';
        const response = await request(isDesktop ? '/core/api/pair' : '/mobile/api/pair',
            { body: { code: grant.pairingCode, ...proof } });
        assert.equal(response.status, 200);
        if (isDesktop) return response.json();
        const cookie = response.headers.get('set-cookie').split(';')[0];
        const session = await request('/mobile/api/session', { headers: { cookie } });
        const identity = (await session.json()).recovery;
        return { cookie, identity };
    }
    async function mobile(permissions = ['read','execute']) {
        const { cookie, identity } = await pair('mobile', permissions);
        const headers = { cookie, 'x-nativesync-entry-id': identity.entryId, 'x-nativesync-session-marker': identity.sessionMarker };
        const observe = (route, signal) => request('/mobile/api' + route, { headers, signal });
        return {
            cookie, identity, observe,
            async call(route, body, expected = 200) {
                const response = await request('/mobile/api' + route, { body, headers });
                const data = await response.json();
                assert.equal(response.status, expected, JSON.stringify(data));
                return data;
            },
            async download(route) {
                const response = await observe(route);
                assert.equal(response.status, 200);
                return Buffer.from(await response.arrayBuffer());
            }
        };
    }
    async function define({ ownerType = 'agent', ownerId = 'fixture', topicId = 'default', name = 'One history', config, actor }) {
        const key = localTopicKey(ownerType, ownerId, topicId);
        if (!config) config = { name: 'Fixture', model: 'synthetic', systemPrompt: 'Isolated fixture.' };
        await core.local.define(key, { ownerType, ownerId, topicId, name, config }, value => core.supportsGroup(value), actor);
        return { key, route: '/core/' + workspace + '/' + key, descriptor: { itemType: ownerType, itemId: ownerId, topicId } };
    }
    const desktopCredentials = new Map();
    async function desktop(profile = 'A', enrollment) {
        const { HistoryMutationQueue } = require(CHAT + '/modules/services/historyMutationQueue');
        const { openLocalCore } = require(CHAT + '/modules/services/localCoreRuntime');
        const data = path.join(root, 'desktop-' + profile);
        const queue = new HistoryMutationQueue({ userDataDir: path.join(data, 'UserData') });
        const ownerFile = (kind, id) => path.join(data, kind === 'group' ? 'AgentGroups' : 'Agents', id, 'config.json');
        const readOwner = async (kind, id) => JSON.parse(await fs.readFile(ownerFile(kind, id), 'utf8'));
        const writeOwner = async (kind, id, config) => {
            const file = ownerFile(kind, id);
            await fs.mkdir(path.dirname(file), { recursive: true });
            await fs.writeFile(file, JSON.stringify(config));
        };
        const grant = enrollment || desktopCredentials.get(profile) || await pair('desktop', ['read','execute','config']);
        desktopCredentials.set(profile, grant);
        const { token } = grant;
        const runtime = await openLocalCore({ queue, appDataRoot: data, workspace, readSettings: async () => ({}),
            remoteOrigin: endpoint, remoteToken: token, writeOwner,
            notify() {}, notifyExecutionStatus() {}, notifyGroupEvent() {},
            readAgent: id => readOwner('agent', id), readGroup: id => readOwner('group', id), readRules: async () => [],
            storeAttachment: async (bytes, name, id, topic) => {
                const file = path.join(data, 'UserData', id, 'topics', topic, 'files', name);
                await fs.mkdir(path.dirname(file), { recursive: true });
                await fs.writeFile(file, bytes);
                return { internalPath: require('node:url').pathToFileURL(file).href };
            }
        });
        const client = { data, queue, runtime, async close() {
            if (clients.delete(client)) await runtime.close();
        } };
        clients.add(client);
        return client;
    }
    return { root, directory, workspace, endpoint, certificate, certFile, keyFile, request, options,
        get core() { return core; }, pair, mobile, define, desktop, async restart() {
            await core.close();
            core = new CoreService(options);
            bindRouters();
            return core;
        } };
}

async function wait(predicate, label) {
    for (let i = 0; i < 250; i++) {
        if (await predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw Error('TIMEOUT ' + label);
}

module.exports = { BOX, CHAT, wait, localProvider, host, coreFixture };

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');

const desktop = path.resolve(__dirname, '../../apps/desktop');
const load = createRequire(path.join(desktop, 'package.json'));
const distributed = path.join(desktop, 'VCPDistributedServer');
const mobileSync = path.join(distributed, 'Plugin/VCPMobileSync');
const { HistoryMutationQueue } = load('./modules/services/historyMutationQueue');
const { negotiateVersionCheck, WIRE_PROTOCOL_VERSION } = require(path.join(mobileSync, 'protocol'));
const { initDb, getDb } = require(path.join(mobileSync, 'core/db'));
const { configureHistoryLifecycle } = require(path.join(mobileSync, 'sync/historyLifecycle'));
const { messageContentHash } = require(path.join(mobileSync, 'sync/canonical'));
const { registerRoutes } = require(path.join(mobileSync, 'transport/routes'));

const claim = version => ({
    type: 'VERSION_CHECK',
    versions: [{ component: 'mobile_app', version: '1.1.6' }, { component: 'wire', version }],
});
const options = { desktopPluginVersion: '2.0.0', backendMode: 'legacy' };

async function main() {
    const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-mobile-wire-'));
    const fixture = path.join(sandbox, 'AppData');
    const userDataDir = path.join(fixture, 'UserData');
    const queue = new HistoryMutationQueue({
        userDataDir, agentDir: path.join(fixture, 'Agents'), groupDir: path.join(fixture, 'AgentGroups'),
    });
    const app = load('express')();
    let server;
    let upstreamWireRejected = false;
    try {
        const historyFile = queue.getHistoryPath('synthetic-agent', 'synthetic-topic');
        const configFile = path.join(fixture, 'Agents/synthetic-agent/config.json');
        await fs.mkdir(path.dirname(historyFile), { recursive: true });
        await fs.mkdir(path.dirname(configFile), { recursive: true });
        const initial = [{ id: 'seed', role: 'user', content: 'synthetic existing message', timestamp: 1 }];
        await fs.writeFile(historyFile, JSON.stringify(initial));
        await fs.writeFile(configFile, JSON.stringify({ id: 'synthetic-agent', name: 'Synthetic agent', topics: [{ id: 'synthetic-topic' }] }));

        const upstream = process.env.VCP_MOBILE_WIRE16_PLUGIN;
        if (upstream) {
            const upstreamRoot = path.resolve(upstream);
            // Original lioensky/VCPChat files from 68b43992eec626713857f7e4e375b6ae23f3eb26.
            for (const [file, expected] of Object.entries({
                'index.js': '763752030cac1a11f1d4e6fec757766d4279a042f9c6163fb9948073d53b950b',
                'protocol.js': 'd653019bbcc48ab509eece6a893d1602f50a875716592191121a63a399242c42',
            })) {
                const contents = await fs.readFile(path.join(upstreamRoot, file));
                assert.equal(createHash('sha256').update(contents).digest('hex'), expected, file);
            }
            assert.equal(require(path.join(upstreamRoot, 'protocol')).WIRE_PROTOCOL_VERSION, '1.6');
            const manager = require(path.join(distributed, 'Plugin.js'));
            const entry = require(path.join(upstreamRoot, 'plugin-manifest.json'));
            manager.plugins.set(entry.name, { ...entry, basePath: upstreamRoot });
            const reports = [];
            const report = console.error;
            try {
                console.error = (...args) => reports.push(args);
                await manager.initializeServices(app, null, path.join(sandbox, 'VCPDistributedServer'), {
                    pluginAgentOperationService: { historyMutationQueue: queue },
                });
            } finally {
                console.error = report;
            }
            assert.equal(manager.serviceModules.has(entry.name), false, 'incompatible module must not enter service registration');
            assert(reports.some(args => args.some(value => value?.code === 'MOBILE_SYNC_HISTORY_WRITER_INCOMPATIBLE')),
                'production loader emits the writer incompatibility reason');
            assert.deepEqual(JSON.parse(await fs.readFile(historyFile, 'utf8')), initial);
            upstreamWireRejected = true;
        }
        assert.equal(WIRE_PROTOCOL_VERSION, '1.5');
        assert.equal(negotiateVersionCheck(claim('1.5'), options).ack.versions[1].version, '1.5');
        assert.throws(() => negotiateVersionCheck(claim('1.6'), options), { code: 'WIRE_VERSION_MISMATCH' });
        configureHistoryLifecycle(queue, fixture);
        initDb(':memory:', { includeAvatarIndex: false });
        getDb().prepare('INSERT INTO owners (owner_type, owner_id, config_path, config_hash, updated_at) VALUES (?, ?, ?, ?, ?)')
            .run('agent', 'synthetic-agent', configFile, 'a'.repeat(64), 1);
        getDb().prepare('INSERT INTO topics (owner_type, owner_id, topic_id, config_hash, content_hash, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run('agent', 'synthetic-agent', 'synthetic-topic', 'b'.repeat(64), '', 1);

        const token = 'fixture-wire-only';
        registerRoutes(app, { syncToken: token, appDataPath: fixture });
        server = await new Promise((resolve, reject) => {
            const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
            listener.once('error', reject);
        });
        const url = 'http://127.0.0.1:' + server.address().port + '/api/mobile-sync/messages/push';
        const push = async (id, timestamp) => {
            const message = { id, role: 'user', content: 'synthetic push', timestamp, topicId: 'synthetic-topic', updatedAt: timestamp, attachments: [] };
            message.contentHash = messageContentHash(message);
            const response = await fetch(url, {
                method: 'POST',
                headers: { authorization: 'Bearer ' + token, 'content-type': 'application/x-ndjson' },
                body: JSON.stringify({ kind: 'topic', topicId: 'synthetic-topic', ownerType: 'agent', ownerId: 'synthetic-agent', messages: [message], deletedMessages: [] }) + '\n',
            });
            assert.equal(response.status, 200);
            return (await response.text()).trim().split('\n').map(line => JSON.parse(line));
        };
        const descriptor = { itemType: 'agent', itemId: 'synthetic-agent', topicId: 'synthetic-topic' };
        const localFrames = await push('wire-legacy-local', 2);
        assert.equal(localFrames.find(row => row.kind === 'topic')?.ok, true, JSON.stringify(localFrames));
        const local = await queue.read(descriptor);
        assert.deepEqual(local.map(message => message.id), ['seed', 'wire-legacy-local']);
        const before = await fs.readFile(historyFile);

        queue.configureSync({ topics: [descriptor] });
        const protectedFrames = await push('wire-protected-refused', 3);
        const denied = protectedFrames.find(row => row.kind === 'topic');
        assert.equal(denied?.ok, false, JSON.stringify(protectedFrames));
        assert.equal(denied.error.code, 'SYNC_WRITER_EXCLUDED');
        assert.deepEqual(await fs.readFile(historyFile), before, 'protected route must preserve physical bytes');
        assert.deepEqual((await queue.read(descriptor)).map(message => message.id), ['seed', 'wire-legacy-local']);
        console.log(JSON.stringify({ oldWire: '1.5', localLegacyCommitted: true, protectedBytesUnchanged: true,
            denied: denied.error.code, handshake16: 'WIRE_VERSION_MISMATCH', upstreamWireRejected }));
    } finally {
        configureHistoryLifecycle(null, fixture);
        if (server) {
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
        }
        getDb()?.close();
        await queue.dispose();
        await fs.rm(sandbox, { recursive: true, force: true });
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });

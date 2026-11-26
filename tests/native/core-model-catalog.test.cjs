'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { BOX } = require('./fixtures/sharedSingleHarness.cjs');

function catalog(fetchImpl, virtual = [{ id: 'VCPModelAuto' }]) {
    return require(BOX + '/modules/modelCatalog').createModelCatalog({
        apiUrl: 'http://127.0.0.1:1', apiKey: 'fixture-provider-key',
        modelRedirectHandler: { isEnabled: () => true, redirectModelForClient: id => id === 'internal' ? 'public-model' : id },
        semanticModelRouter: { getVirtualModels: () => virtual }, fetchImpl
    });
}
test('native model catalog preserves redirect, virtual models, metadata and upstream fallback', async () => {
    const query = catalog(async (url, options) => {
        assert.equal(url, 'http://127.0.0.1:1/v1/models');
        assert.equal(options.headers.Authorization, 'Bearer fixture-provider-key');
        assert.equal(options.headers.Accept, 'application/json');
        return Response.json({ object: 'list', data: [{ id: 'internal', owned_by: 'fixture' }, { id: 'VCPModelAuto' }] });
    });
    assert.deepEqual((await query()).data.data, [{ id: 'public-model', owned_by: 'fixture' }, { id: 'VCPModelAuto' }]);
    assert.deepEqual((await catalog(async () => new Response('provider unavailable', { status: 503 }))()).data.data, [{ id: 'VCPModelAuto' }]);
    assert.equal((await catalog(async () => new Response('bad response', { status: 502 }), [])()).status, 502);
    assert.equal((await catalog(async () => new Response('invalid json'), [])()).status, 502);
    assert.deepEqual((await catalog(async () => Response.json({ data: [] }), [])()).data.data, []);
});

test('remote Core catalog uses the existing device read authority and returns only public IDs', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'core-model-catalog-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const express = require(BOX + '/node_modules/express');
    const { startCoreHost } = require(BOX + '/core/host');
    const origin = 'https://core.example.invalid';
    const app = express();
    app.set('trust proxy', 'loopback');
    let queries = 0, failProvider = false, revokeDuringQuery = null;
    const provider = catalog(async () => {
        queries++;
        if (revokeDuringQuery) revokeDuringQuery();
        if (failProvider) throw Error('upstream confidential error');
        return Response.json({ data: [{ id: 'internal', private_field: 'never expose' }, { id: 'public-model' }] });
    });
    const core = startCoreHost({ app, chat: { config: {} }, modelCatalog: provider, listenHost: '127.0.0.1',
        serverKey: 'fixture-toolbox-key', env: { VCP_CORE_DATA_DIR: path.join(root, 'db'), VCP_CORE_MODE: 'remote', VCP_CORE_REMOTE_ORIGIN: origin } });
    app.use('/core/api', core.remoteDesktopRouter);
    app.use('/mobile', core.remoteMobileRouter);
    app.use((error, _req, res, _next) => res.status(error.status || 503).json({ error: { code: error.code || 'UNAVAILABLE' } }));
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await core.close(); });
    const base = 'http://127.0.0.1:' + server.address().port;
    // Exercise the actual proxy host contract; undici can normalize Host to the socket URL.
    const call = (route, headers = {}) => new Promise((resolve, reject) => {
        const req = require('node:http').get(base + route, {
            headers: { Host: 'core.example.invalid', 'X-Forwarded-Proto': 'https', ...headers }
        }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
            res.on('error', reject);
        });
        req.on('error', reject);
    });
    const grant = (role, execute = false) => {
        const scopes = ['shared:personal:read', ...(execute ? ['shared:personal:execute'] : []), ...(role === 'desktop' ? ['desktop'] : [])];
        const code = core.remote.sessions.createCode(scopes).pairingCode;
        return core.remote.sessions.redeem({ code }, null, role);
    };
    const desktop = grant('desktop'), mobile = grant('mobile');
    const auth = { Authorization: 'Bearer ' + desktop.token, 'X-VCP-Core-Storage-Id': core.store.storageId };
    const route = '/core/api/personal/models';
    assert.equal((await call(route)).status, 401);
    assert.equal((await call(route, { Authorization: 'Bearer fixture-toolbox-key' })).status, 401);
    assert.equal((await call('/core/api/other/models', auth)).status, 403);
    assert.equal((await call(route, { ...auth, 'X-VCP-Core-Storage-Id': 'wrong' })).status, 409);
    assert.equal((await call('/mobile/api/core/personal/models', { Cookie: '__Secure-vcp_mobile=' + mobile.token })).status, 403);
    assert.equal(queries, 0);
    const ok = await call(route, auth);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await ok.json(), { object: 'list', data: [{ id: 'public-model' }, { id: 'VCPModelAuto' }] });
    assert.equal(queries, 1);
    failProvider = true;
    const unavailable = await call(route, auth);
    assert.equal(unavailable.status, 502);
    assert.deepEqual(await unavailable.json(), { error: { code: 'CORE_MODEL_CATALOG_UNAVAILABLE' } });
    failProvider = false;
    revokeDuringQuery = () => core.store.db.prepare('DELETE FROM mobile_sessions WHERE id=?').run(desktop.id);
    assert.equal((await call(route, auth)).status, 401);
    const last = queries;
    assert.equal((await call(route, auth)).status, 401);
    assert.equal(queries, last);
    const { localTopicKey } = require(BOX + '/core/localWorkspace');
    const key = localTopicKey('agent', 'fixture', 'models');
    await core.local.define(key, { ownerType:'agent', ownerId:'fixture', topicId:'models', name:'Models',
        config:{ name:'Fixture', model:'public-model', systemPrompt:'Fixture only' } }, () => true);
    revokeDuringQuery = null;
    const mobileRoute = '/mobile/api/core/personal/' + key + '/models';
    assert.equal((await call(mobileRoute)).status, 401);
    assert.equal((await call(mobileRoute, { Cookie: '__Secure-vcp_mobile=' + mobile.token })).status, 403);
    assert.equal(queries, last);
    const mobileExecutor = grant('mobile', true);
    const mobileCatalog = await call(mobileRoute, { Cookie:'__Secure-vcp_mobile=' + mobileExecutor.token });
    assert.equal(mobileCatalog.status, 200);
    assert.deepEqual(await mobileCatalog.json(), { models:['public-model','VCPModelAuto'] });
    assert.equal(core.store.db.prepare('SELECT count(*) n FROM works').get().n, 0);
    assert.equal(core.store.db.prepare('SELECT count(*) n FROM messages').get().n, 0);
});

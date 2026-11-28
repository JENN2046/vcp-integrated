'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash, X509Certificate, randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { BOX, localProvider, host } = require('../native/fixtures/coreSingleHarness.cjs');


test('Core Agent creation from mobile PWA preserves device scopes and a single creation receipt', { timeout: 95000 }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'core-agent-creation-'));
    const provider = await localProvider(t);
    provider.setModels([{ id: 'first-chat' }, { id: 'second-chat' }, { id: 'vec', mode: 'embedding' }]);
    provider.setReply((_body, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end('data: {"choices":[{"delta":{"content":"隔离模型回复"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    });
    const { chat } = host(provider);
    const express = require(BOX + '/node_modules/express');
    const { startCoreHost } = require(BOX + '/core/host');
    const { administer } = require(BOX + '/core/pairDevice');
    const { createModelCatalog } = require(BOX + '/modules/modelCatalog');
    const modelCatalog = createModelCatalog({ apiUrl: provider.url, apiKey: 'fixture',
        modelRedirectHandler: { isEnabled: () => false }, semanticModelRouter: { getVirtualModels: () => [] } });
    const certFile = path.join(root, 'fixture-cert.pem'), keyFile = path.join(root, 'fixture-key.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
        '-subj', '/CN=Core Agent creation fixture', '-addext', 'subjectAltName=IP:127.0.0.1',
        '-keyout', keyFile, '-out', certFile], { stdio: 'ignore' });
    const cert = new X509Certificate(await fs.readFile(certFile));
    const spki = createHash('sha256').update(cert.publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
    const app = express();
    const server = https.createServer({ cert: await fs.readFile(certFile), key: await fs.readFile(keyFile) }, app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'https://127.0.0.1:' + server.address().port, directory = path.join(root, 'core');
    const operator = (...command) => administer({ VCP_CORE_DATA_DIR: directory, VCP_CORE_REMOTE_ORIGIN: origin }, command);
    const core = startCoreHost({ app, chat, modelCatalog, listenHost: '127.0.0.1', serverKey: 'fixture', env: {
        VCP_CORE_MODE: 'remote', VCP_CORE_DATA_DIR: directory, VCP_CORE_REMOTE_ORIGIN: origin,
        VCP_CORE_REMOTE_SESSION_HOURS: '1', VCP_CORE_DEFAULT_AGENT_MODEL: 'second-chat'
    } });
    const repository = core.store.db;
    let loseReceipt = false, browser;
    const creations = [];
    app.use((req, res, next) => {
        if (req.method === 'POST' && req.path.endsWith('/agent-creation')) {
            const original = res.json.bind(res);
            res.json = result => {
                if (result.key) creations.push(result.key);
                if (!result.key || !loseReceipt) return original(result);
                loseReceipt = false;
                // Truncate the receipt after headers to expose the lost body
                // instead of allowing Chromium's connection recovery to hide it.
                res.set('Content-Type', 'application/json').set('Content-Length', '100');
                res.write('{');
                setTimeout(() => res.destroy(), 30);
            };
        }
        next();
    });
    app.use('/core/api', core.remoteDesktopRouter);
    app.use('/mobile', core.remoteMobileRouter);
    const endpoint = '/mobile/api/core/personal/agent-creation';
    try {
        browser = await require(BOX + '/node_modules/puppeteer').launch({
            executablePath: process.env.CHROME_BIN || '/opt/google/chrome/chrome',
            headless: true, userDataDir: path.join(root, 'browser'),
            args: ['--ignore-certificate-errors-spki-list=' + spki, '--disable-background-networking', '--no-first-run',
                '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1']
        });
        const page = await browser.newPage();
        page.setDefaultTimeout(10000);
        await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
        const pageErrors = [];
        page.on('pageerror', error => pageErrors.push(error.message));
        await page.goto(origin + '/mobile/#pair=' + operator('pair', 'mobile').pairingCode);
        await page.waitForSelector('#pair-submit:not([disabled])');
        await page.$eval('#pair-submit', button => button.click());
        await page.waitForSelector('#conversation-navigation');
        const attempt = (path, method, body, wrongBinding = false) => page.evaluate(async (path, method, body, wrongBinding) => {
            const { recovery } = await fetch('/mobile/api/session').then(response => response.json());
            const res = await fetch(path, { method, headers: { 'Content-Type': 'application/json',
                'X-NativeSync-Entry-Id': recovery.entryId, 'X-NativeSync-Session-Marker': wrongBinding ? 'wrong' : recovery.sessionMarker
            }, body: JSON.stringify(body) });
            return { status: res.status, body: await res.json() };
        }, path, method, body, wrongBinding);
        const rejected = { name: 'Rejected Agent', requestId: randomUUID() };
        assert.equal((await attempt(endpoint, 'POST', rejected)).status, 403);
        assert.equal(await page.$('.agent-heading button'), null);
        assert.equal(repository.prepare('SELECT count(*) n FROM core_owners').get().n, 0);

        const mobile = operator('list').find(device => !JSON.parse(device.scopes).includes('desktop'));
        assert.equal(operator('agent-create', mobile.id, 'on').createAgent, true);
        assert.equal((await attempt('/mobile/api/core/personal/agents/forbidden', 'PUT', { config: {} })).status, 403);
        assert.equal((await attempt(endpoint, 'POST', rejected, true)).body.error.code, 'SUBMISSION_CONTEXT_CHANGED');
        assert.equal((await attempt(endpoint, 'POST', rejected)).body.error.code, 'CORE_AGENT_MODEL_REQUIRED');
        assert.equal((await attempt(endpoint, 'POST', { ...rejected, model: 'vec' })).body.error.code, 'CORE_MODEL_NOT_ALLOWED');
        assert.equal((await attempt(endpoint, 'POST', { ...rejected, executionPolicy: {} })).status, 400);
        const openList = async () => {
            const open = await page.$eval('#conversation-navigation', nav => nav.checkVisibility());
            if (!open) await page.click('[aria-label="切换话题"][aria-controls="conversation-navigation"]');
        };
        await openList();
        await page.waitForSelector('.agent-heading button', { visible: true });
        await page.click('.agent-heading button');
        await page.waitForFunction(() => document.querySelector('#agent-creation-model').options.length === 3);
        assert.deepEqual(await page.$$eval('#agent-creation-model option', options => options.map(option => option.value)),
            ['', 'first-chat', 'second-chat']);
        assert.equal(await page.$eval('#agent-creation-model', el => el.value), 'second-chat');
        assert.match(await page.$eval('#agent-creation-model', el => el.selectedOptions[0].textContent), /Core 默认/);
        await page.type('#agent-creation-name', 'Mobile Agent');
        await page.type('#agent-creation-instructions', 'Keep replies short.');
        // Retire the displayed default after the form loads. The new first row
        // must never be substituted on submission.
        provider.setModels([{ id: 'replacement-chat' }, { id: 'first-chat' }]);
        await page.click('.agent-creation-dialog button[type=submit]');
        await page.waitForFunction(() => document.querySelector('#agent-creation-model')?.options[1]?.value === 'replacement-chat');
        assert.equal(await page.$eval('#agent-creation-model', el => el.value), '');
        assert.equal(await page.$eval('#agent-creation-name', el => el.value), 'Mobile Agent');
        assert.equal(await page.$eval('#agent-creation-instructions', el => el.value), 'Keep replies short.');
        assert.equal(await page.$eval('.agent-creation-dialog button[type=submit]', el => el.disabled), true);
        assert.match(await page.$eval('.agent-creation-dialog [role=alert]', el => el.textContent), /重新选择/);
        for (const table of ['core_owners', 'core_topics', 'conversations', 'works', 'idempotency_receipts']) {
            assert.equal(repository.prepare('SELECT count(*) n FROM ' + table).get().n, 0, table);
        }
        await page.select('#agent-creation-model', 'first-chat');
        loseReceipt = true;
        await page.$eval('.agent-creation-dialog form', form => { form.requestSubmit(); form.requestSubmit(); });
        await page.waitForSelector('.agent-creation-dialog [role=alert]', { visible: true }).catch(async error => {
            const form = await page.$eval('.agent-creation-dialog', dialog => ({
                open: dialog.open, text: dialog.innerText, nameValue: dialog.querySelector('input').value
            }));
            throw Error(JSON.stringify({ form, creations: creations.length, pageErrors }), { cause: error });
        });
        assert.match(await page.$eval('.agent-creation-dialog [role=alert]', el => el.textContent), /待确认/);
        assert.equal(creations.length, 1);
        assert.equal(provider.calls.length, 0);

        await page.reload();
        await page.waitForSelector('#conversation-navigation');
        await openList();
        await page.waitForFunction(() => document.querySelector('.agent-heading button')?.textContent.includes('重试创建'));
        assert.equal(creations.length, 1);
        // A replay uses the original receipt even if that model is no longer advertised.
        provider.setModels([{ id: 'second-chat' }]);
        await page.click('.agent-heading button');
        await page.click('.agent-creation-dialog button[type=submit]');
        await page.waitForFunction(() => document.querySelector('.conversation-title .context-name')?.textContent === 'Mobile Agent');
        assert.deepEqual(creations, [creations[0], creations[0]]);
        const createdKey = creations[0];
        const row = repository.prepare('SELECT owner_id,native_topic FROM core_topics WHERE id=?').get(createdKey);
        assert.equal(row.native_topic, 'default');
        assert.equal(repository.prepare('SELECT count(*) n FROM core_owners').get().n, 1);
        assert.equal(repository.prepare('SELECT count(*) n FROM works').get().n, 0);
        await page.reload();
        await page.waitForFunction(() => document.querySelector('.conversation-title .context-name')?.textContent === 'Mobile Agent');
        await page.waitForSelector('#message-text:not([disabled])');
        await page.type('#message-text', 'First manual message');
        await page.click('#send');
        await page.waitForFunction(() => document.querySelector('#history')?.textContent.includes('隔离模型回复'));
        assert.equal(provider.calls.length, 1);
        assert.equal(provider.calls[0].model, 'first-chat');
        assert.equal(provider.calls[0].messages.some(message => JSON.stringify(message).includes('Keep replies short.')), true);

        const defaults = { name: 'Concurrent Agent', model: 'second-chat', requestId: randomUUID() };
        const [first, duplicate] = await Promise.all([attempt(endpoint, 'POST', defaults), attempt(endpoint, 'POST', defaults)]);
        assert.equal(first.status, 200);
        assert.deepEqual(duplicate, first);
        assert.equal(core.local.configuration({ workspace: 'personal', key: first.body.key }).model, 'second-chat');
        assert.equal(repository.prepare('SELECT count(*) n FROM core_owners').get().n, 2);
        assert.equal(provider.calls.length, 1);
        assert.equal((await attempt(endpoint, 'POST', { ...defaults, name: 'Reused ID' })).body.error.code, 'REQUEST_ID_REUSED');
        assert.equal(operator('agent-create', mobile.id, 'off').createAgent, false);
        assert.equal((await attempt(endpoint, 'POST', rejected)).status, 403);
        assert.equal(JSON.parse(operator('list').find(device => device.id === mobile.id).scopes).includes('shared:personal:execute'), true);
        assert.deepEqual(pageErrors, []);

        t.diagnostic('Mobile PWA creation checks ungranted and granted device scopes, same-request receipt replay, and one isolated model turn.');
    } finally {
        await browser?.close();
        if (server.listening) {
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
        }
        await core.close();
        await fs.rm(root, { recursive: true, force: true });
    }
});

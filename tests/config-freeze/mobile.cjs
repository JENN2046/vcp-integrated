'use strict';

const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const path = require('node:path');
const { launch } = require('../group-relay/pwa.cjs');
const { sha256, stable } = require('../../apps/server/Plugin/NativeSync/sync/protocol');

const viewport = { width: 390, height: 844, isMobile: true, hasTouch: true };
const configRoute = '/mobile/api/shared/config';
const configHeaders = { 'X-NativeSync-Capabilities': 'desktop-references-v1,source-data-v2,shared-space-v1' };
const prompt = '#shared-config-prompt';
const save = '#shared-config-save';

async function openSession(browser, { service, request, sharedSpaceId, sharedOwnerId, topicKey }, permissions) {
    const { pairingCode } = await request('/api/plugins/NativeSync/mobile/pairing', {
        scopeMode: 'shared', sharedSpaceId, permissions,
    });
    assert.ok(/^[A-Za-z0-9_-]{32}$/.test(pairingCode), 'Expected a one-time fixture pairing code');
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    const errors = [];
    const bundles = [];
    page.on('response', response => {
        const url = new URL(response.url());
        if (url.origin !== service.origin || !/^\/mobile\/assets\/index-[\w-]+\.js$/.test(url.pathname) ||
            response.status() !== 200 || response.request().resourceType() !== 'script') return;
        bundles.push(response.buffer().then(bytes => ({
            path: url.pathname, sha256: createHash('sha256').update(bytes).digest('hex'),
        }), () => null));
    });
    page.on('pageerror', error => errors.push(error.name));
    await page.setViewport(viewport);
    try {
        await page.goto(service.origin + '/mobile/#pair=' + pairingCode, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#pair-submit', { visible: true });
        await page.waitForFunction(() => Boolean(document.querySelector('#pair-code')?.value));
        await page.click('#pair-submit');
        await page.waitForSelector('#agent-select', { visible: true });
    } catch {
        throw Error('The isolated PWA could not pair with scopes: ' + permissions.join(', '));
    }
    const agent = JSON.stringify(['agent', sharedOwnerId]);
    await page.waitForFunction(value => [...document.querySelectorAll('#agent-select option')]
        .some(option => option.value === value), {}, agent);
    await page.select('#agent-select', agent);
    await page.waitForFunction(value => [...document.querySelectorAll('#topic-select option')]
        .some(option => option.value === value && !option.disabled), {}, topicKey);
    await page.select('#topic-select', topicKey);
    await page.waitForFunction(value => document.querySelector('#topic-select')?.value === value &&
        !document.querySelector('.history-progress'), {}, topicKey);
    assert.ok(!new URL(page.url()).hash, 'Paired UI removed the entry fragment');
    assert.ok(!await page.$('#pair-code'), 'Paired UI removed the code input');
    await page.click('.shared-tools > summary');
    await page.waitForSelector('.shared-tools[open]', { timeout: 5000 });
    const entry = await page.evaluate(() => {
        const script = document.querySelector('script[type=module][src]');
        return script && performance.getEntriesByName(script.src).length ? new URL(script.src).pathname : null;
    });
    const loaded = await Promise.all(bundles);
    assert.equal(loaded.length, 1, 'Expected one executed PWA entry bundle response');
    const [bundle] = loaded;
    assert.ok(bundle && bundle.path === entry, 'Expected actual PWA entry resource bytes');
    return { page, errors, bundle };
}

async function editorScreenshot(page, out, name) {
    await page.$eval('.shared-config .shared-config [role=status]', node => {
        node.scrollIntoView({ block: 'end', inline: 'nearest' });
    });
    await page.screenshot({ path: path.join(out, name + '.png') });
}

async function writePrompt(page, { service, sharedSpaceId, sharedOwnerId, snapshot, assertHeld, updatedPrompt, out }) {
    const responses = [];
    page.on('response', response => {
        const route = new URL(response.url()).pathname;
        if (route.startsWith('/mobile/api/shared/') && !route.endsWith('/events')) {
            responses.push({ route, status: response.status() });
        }
    });
    await page.waitForSelector('#shared-config-open', { visible: true, timeout: 5000 });
    await page.click('#shared-config-open');
    try {
        await page.waitForSelector(prompt + ':not([disabled])', { timeout: 5000 });
    } catch {
        const controls = await page.evaluate(() => ({
            open: Boolean(document.querySelector('#shared-config-open')),
            editor: Boolean(document.querySelector('.shared-config .shared-config')),
            choiceCount: document.querySelector('#shared-config-object')?.options.length,
            promptDisabled: document.querySelector('#shared-config-prompt')?.disabled,
            status: document.querySelector('.shared-config [role=status]')?.textContent,
        }));
        await page.screenshot({ path: path.join(out, 'mobile-config-open-failure.png') });
        throw Error('Isolated PWA editor unavailable: ' + JSON.stringify({ controls, responses }));
    }
    const before = await snapshot({});
    assert.equal(await page.$eval(prompt, node => node.value), before.object.config.systemPrompt);
    assert.notEqual(before.object.config.systemPrompt, updatedPrompt);
    const client = await page.createCDPSession();
    await client.send('Network.enable');
    await client.send('Fetch.enable', {
        patterns: [{ urlPattern: service.origin + configRoute, requestStage: 'Response' }],
    });

    const attempts = [];
    let committed;
    let failure;
    async function intercept(event) {
        const { request, requestId, networkId, responseStatusCode } = event;
        assert.equal(request.method, 'POST');
        assert.equal(responseStatusCode, 200);
        const rawBody = request.postData ?? (await client.send('Network.getRequestPostData', { requestId: networkId })).postData;
        const body = JSON.parse(rawBody);
        assert.deepEqual(body, {
            sharedSpaceId, sharedId: sharedOwnerId, opId: body.opId, expectedVersion: before.object.version, config: body.config,
        });
        assert.equal(body.config.systemPrompt, updatedPrompt);
        const bodyHash = sha256(stable({ action: 'config', body }));
        const response = await client.send('Fetch.getResponseBody', { requestId });
        const payload = JSON.parse(response.base64Encoded ? Buffer.from(response.body, 'base64').toString('utf8') : response.body);
        assert.ok(attempts.length < 2, 'Expected the first save and one explicit retry');
        const retry = attempts.length === 1;
        assert.equal(payload.replayed, retry);
        assert.equal(payload.object.version, before.object.version + 1);
        if (retry) {
            assert.equal(rawBody, attempts[0].rawBody);
            assert.equal(body.opId, attempts[0].opId);
            assert.equal(bodyHash, attempts[0].bodyHash);
        }
        attempts.push({ rawBody, opId: body.opId, bodyHash, responseStatusCode, replayed: retry });
        const state = await snapshot({ opId: body.opId });
        assert.deepEqual(state.object, payload.object);
        assert.deepEqual(state.object.config, body.config);
        assert.equal(state.configRows, before.configRows + 1);
        assert.equal(state.changeRows, before.changeRows + 1);
        assert.equal(state.receipts.length, 1);
        assert.equal(state.receipts[0].request_hash, bodyHash);
        await assertHeld(retry ? 'after original PWA save replay' : 'after first PWA commit before receipt loss');
        if (retry) {
            assert.deepEqual(state, committed);
            await client.send('Fetch.continueRequest', { requestId });
        } else {
            committed = state;
            await client.send('Fetch.failRequest', { requestId, errorReason: 'ConnectionClosed' });
        }
    }
    client.on('Fetch.requestPaused', event => {
        intercept(event).catch(async error => {
            failure = error;
            await client.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'Failed' }).catch(() => {});
        });
    });

    try {
        await page.focus(prompt);
        await page.keyboard.down('Control');
        await page.keyboard.press('A');
        await page.keyboard.up('Control');
        await page.keyboard.type(updatedPrompt);
        await page.click(save);
        await page.waitForFunction(id => {
            const button = document.querySelector(id);
            return button?.textContent === '重试原保存并核对' && !button.disabled;
        }, {}, save);
        if (failure) throw failure;
        assert.equal(attempts.length, 1);
        assert.equal(await page.$eval(prompt, node => node.value), updatedPrompt);
        const pending = await page.evaluate(opId => {
            const key = Object.keys(localStorage).find(name => name.startsWith('nativesync-shared-config-v2:'));
            if (!key) return false;
            return JSON.parse(localStorage.getItem(key)).pending?.opId === opId;
        }, attempts[0].opId);
        assert.equal(pending, true);
        await editorScreenshot(page, out, 'mobile-config-retry');
        await page.click(save);
        await page.waitForFunction(() => {
            const editor = document.querySelector('.shared-config .shared-config');
            return editor?.querySelector('[role=status]')?.textContent.includes('共享配置已保存');
        }).catch(error => { throw failure || error; });
        assert.equal(attempts.length, 2);
        assert.equal(await page.$eval(prompt, node => node.value), updatedPrompt);
        assert.equal(await page.evaluate(() => Object.keys(localStorage).some(key =>
            key.startsWith('nativesync-shared-config-v2:'))), false);
        await editorScreenshot(page, out, 'mobile-config-saved');
        const prior = before.object.config;
        const current = committed.object.config;
        const changedFields = [...new Set([...Object.keys(prior), ...Object.keys(current)])].sort()
            .filter(key => stable({ value: prior[key] }) !== stable({ value: current[key] }));
        return {
            committed, bodyHash: attempts[0].bodyHash, opId: attempts[0].opId,
            initialVersion: before.object.version, changedFields, pendingOperationRetained: pending,
            changedOtherFields: Object.fromEntries(changedFields.filter(key => key !== 'systemPrompt')
                .map(key => [key, { before: prior[key] ?? null, after: current[key] ?? null,
                    beforePresent: Object.hasOwn(prior, key), afterPresent: Object.hasOwn(current, key) }])),
            attempts: attempts.map(({ opId, bodyHash, responseStatusCode, replayed }, index) => ({
                opId, bodyHash, responseStatusCode, replayed, deliveredToBrowser: index === 1,
            })),
        };
    } finally {
        await client.detach();
    }
}

async function checkReadOnly(page, { sharedSpaceId, sharedOwnerId, snapshot, assertHeld, out }, write) {
    const { committed, opId } = write;
    const check = await page.evaluate(async ({ sharedSpaceId, configHeaders }) => {
        const session = await fetch('/mobile/api/session', { headers: configHeaders }).then(response => response.json());
        return {
            authenticated: session.authenticated,
            permissions: session.sharedPermissions.filter(scope => scope.startsWith('shared:' + sharedSpaceId + ':')),
            editorControls: document.querySelectorAll('#shared-config-open,#shared-config-save,#shared-config-prompt').length,
        };
    }, { sharedSpaceId, configHeaders });
    assert.deepEqual(check, {
        authenticated: true, permissions: ['shared:' + sharedSpaceId + ':read'], editorControls: 0,
    });
    await page.screenshot({ path: path.join(out, 'mobile-config-read-only.png') });
    const blockedOp = randomUUID();
    const response = await page.evaluate(async ({ configRoute, configHeaders, body }) => {
        const response = await fetch(configRoute, {
            method: 'POST', credentials: 'same-origin', headers: { ...configHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        return { status: response.status, code: (await response.json()).error?.code };
    }, {
        configRoute, configHeaders, body: {
            sharedSpaceId, sharedId: sharedOwnerId, opId: blockedOp, expectedVersion: committed.object.version,
            config: { ...committed.object.config, systemPrompt: 'SYNTHETIC_UNAUTHORIZED_CONFIG_SHOULD_NOT_PERSIST' },
        },
    });
    assert.deepEqual(response, { status: 403, code: 'SHARED_PERMISSION_REQUIRED' });
    assert.deepEqual(await snapshot({ opId }), committed);
    assert.deepEqual((await snapshot({ opId: blockedOp })).receipts, []);
    await assertHeld('after read-only PWA permission and storage checks');
    return { ...check, post: response, centralUnchanged: true };
}

module.exports = async function runMobileConfig(options) {
    const { puppet, cert, service } = options;
    assert.equal(new URL(service.origin).protocol, 'https:');
    assert.equal(new URL(service.origin).hostname, '127.0.0.1');
    const browser = await launch(puppet, cert);
    try {
        const config = await openSession(browser, options, ['read', 'config']);
        const write = await writePrompt(config.page, options);
        const read = await openSession(browser, options, ['read']);
        const readOnly = await checkReadOnly(read.page, options, write);
        assert.deepEqual([...config.errors, ...read.errors], []);
        const { committed, ...evidence } = write;
        assert.deepEqual(config.bundle, read.bundle);
        return { browser: await browser.version(), viewport, ...evidence, readOnly,
            loadedBundles: { readConfig: config.bundle, readOnly: read.bundle },
            finalVersion: committed.object.version, configHash: committed.object.configHash };
    } finally {
        await browser.close();
    }
};

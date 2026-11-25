'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { createHash, X509Certificate } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { fixture, wait, BOX } = require('../native/fixtures/sharedSingleHarness.cjs');
const { localProvider, host, mountCore, setStream } = require('../native/fixtures/coreSingleHarness.cjs');

test('Core single chat PWA shows live output, accepts a follow-up, and reloads history', { timeout: 45000 }, async t => {
    const f = await fixture(t);
    const provider = await localProvider(t);
    setStream(f, true);
    const { core } = await mountCore(f, host(provider).chat);
    const upstream = [];
    provider.setReply((_body, res) => {
        upstream.push(res);
        res.setHeader('Content-Type', 'text/event-stream');
        res.write('data: {"choices":[{"delta":{"content":"Core live "}}]}\n\n');
    });
    const close = async server => {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    };
    const finish = (res, content) => res.end('data: ' + JSON.stringify({
        choices: [{ delta: { content }, finish_reason: 'stop' }]
    }) + '\n\ndata: [DONE]\n\n');
    let proxy, browser;
    try {
        const grant = f.portal.createPairing({ scopeMode: 'shared', sharedSpaceId: 'sharedAB', permissions: ['read','execute'] });
        const paired = await fetch(f.url + '/mobile/api/pair', { method: 'POST',
            headers: { 'x-forwarded-proto': 'https', origin: 'https://synthetic-shared.invalid', 'content-type': 'application/json' },
            body: JSON.stringify({ code: grant.pairingCode }) });
        assert.equal(paired.status, 200);
        const cookie = paired.headers.get('set-cookie').split(';')[0];
        const cert = path.join(f.root, 'core-pwa-cert.pem');
        const key = path.join(f.root, 'core-pwa-key.pem');
        execFileSync('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost'], { stdio: 'ignore' });
        const certificate = await fs.readFile(cert);
        const spki = createHash('sha256').update(new X509Certificate(certificate).publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
        proxy = https.createServer({ cert: certificate, key: await fs.readFile(key) }, (req, res) => {
            const forward = http.request(f.url + req.url, { method: req.method, headers: {
                ...req.headers, 'x-forwarded-proto': 'https', origin: 'https://synthetic-shared.invalid'
            } }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
            forward.on('error', () => { if (!res.headersSent && !res.destroyed) { res.statusCode = 502; res.end(); } });
            res.on('close', () => { if (!res.writableEnded) forward.destroy(); });
            req.pipe(forward);
        });
        await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
        browser = await require(BOX + '/node_modules/puppeteer').launch({
            executablePath: process.env.CHROME_BIN || '/opt/google/chrome/chrome', headless: true,
            userDataDir: path.join(f.root, 'core-pwa-browser'),
            args: ['--ignore-certificate-errors-spki-list=' + spki, '--disable-background-networking', '--no-first-run',
                '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1']
        });
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
        const [name, ...value] = cookie.split('=');
        await page.setCookie({ name, value: value.join('='), domain: '127.0.0.1', path: '/mobile', secure: true, httpOnly: true, sameSite: 'Strict' });
        const entry = 'https://127.0.0.1:' + proxy.address().port + '/mobile/';
        await page.goto(entry, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#topic-select');
        await page.select('#topic-select', f.topic.id);
        await page.waitForFunction(key => document.querySelector('#topic-select')?.value === key &&
            !document.querySelector('#message-text')?.disabled, {}, f.topic.id);
        const desktop = await f.desktop('A');
        const first = await desktop.runtime.prepareSharedSend({ descriptor: desktop.descriptor, serverSession: true,
            message: { id: 'from-desktop', role: 'user', content: 'desktop left', attachments: [] } });
        await desktop.close();
        await page.waitForFunction(() => [...document.querySelectorAll('.message.assistant .bubble')].some(node => node.textContent === 'Core live '));
        finish(upstream[0], 'first');
        await page.waitForFunction(id => document.querySelector('[data-message-id="' + id + '"] .bubble')?.textContent === 'Core live first', {}, first.replyId);
        await page.type('#message-text', 'mobile follow-up');
        await page.waitForSelector('#send:not([disabled])');
        await page.click('#send');
        await wait(() => upstream.length === 2, 'PWA continuation reached native provider');
        assert.match(JSON.stringify(provider.calls[1].messages), /Core live first/);
        finish(upstream[1], 'second');
        await page.waitForFunction(() => [...document.querySelectorAll('[data-message-id] .bubble')].some(node => node.textContent === 'Core live second'));
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => [...document.querySelectorAll('[data-message-id] .bubble')].some(node => node.textContent === 'Core live second'));
        assert.deepEqual(errors, []);
    } finally {
        await browser?.close();
        if (proxy) await close(proxy);
        await core.close();
        await fs.rm(f.root + '-core', { recursive: true, force: true });
    }
});

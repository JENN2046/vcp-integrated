'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const https = require('node:https');
const { createHash, X509Certificate } = require('node:crypto');

function mobileControl(service, cert, out) {
    const { spaceId } = JSON.parse(fs.readFileSync(out + '/seed/desktopA/.native-sync/connection.json'));
    return (route, body) => new Promise((resolve, reject) => {
        const req = https.request(service.origin + route, {
            method: body ? 'POST' : 'GET',
            ca: fs.readFileSync(cert),
            headers: {
                authorization: 'Bearer synthetic-only',
                'content-type': 'application/json',
                'x-nativesync-source': 'sourceA',
                'x-nativesync-device': 'deviceA',
                'x-nativesync-space': spaceId,
                'x-nativesync-protocol': '2',
                'x-nativesync-capabilities': 'shared-space-v1,shared-context-v1,shared-session-v1,shared-session-cancel-v1',
            },
        }, async response => {
            try {
                const chunks = [];
                for await (const chunk of response) chunks.push(chunk);
                const value = JSON.parse(Buffer.concat(chunks));
                assert.equal(response.statusCode, 200, route + ': ' + JSON.stringify(value));
                resolve(value);
            } catch (error) { reject(error); }
        });
        req.on('error', reject);
        req.setTimeout(4500, () => req.destroy(Error('Timed out requesting ' + route)));
        req.end(body && JSON.stringify(body));
    });
}

async function launch(puppet, cert) {
    const spki = createHash('sha256').update(new X509Certificate(fs.readFileSync(cert)).publicKey.export({
        type: 'spki', format: 'der',
    })).digest('base64');
    return puppet.launch({
        executablePath: process.env.CHROME_BIN || '/opt/google/chrome/chrome',
        headless: true,
        args: ['--ignore-certificate-errors-spki-list=' + spki, '--disable-background-networking', '--no-first-run',
            '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1'],
    });
}

async function openPwa({ browser, service, request, topic = service.topics.groupTopic.id, execute = false, groupName = 'Relay fixture A B C' }) {
    const { pairingCode } = await request('/api/plugins/NativeSync/mobile/pairing', {
        scopeMode: 'shared', sharedSpaceId: 'sharedAB', permissions: execute ? ['read', 'execute'] : ['read'],
    });
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    const writes = [];
    const errors = [];
    page.on('request', req => {
        if (req.method() === 'POST' && /\/(?:messages|invitations|cancel(?:-remaining)?|resolve)(?:\?|$)/.test(req.url())) {
            writes.push(new URL(req.url()).pathname);
        }
    });
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewport({ width: 390, height: 1120, isMobile: true, hasTouch: true });
    await page.goto(service.origin + '/mobile/#pair=' + pairingCode, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#pair-submit', { visible: true });
    await page.waitForFunction(() => Boolean(document.querySelector('#pair-code')?.value));
    await page.click('#pair-submit');
    await page.waitForSelector('#agent-select');
    const agent = await page.$eval('#agent-select', (element, name) => [...element.options]
        .find(option => option.textContent.includes(name))?.value, groupName);
    assert.ok(agent, 'paired PWA can see the shared group');
    await page.select('#agent-select', agent);
    await page.waitForFunction(topicId => [...document.querySelectorAll('#topic-select option')]
        .some(option => option.value === topicId), {}, topic);
    await page.select('#topic-select', topic);
    await page.waitForFunction(topicId => document.querySelector('#topic-select')?.value === topicId &&
        !document.querySelector('.history-progress'), {}, topic);

    return {
        page, topic, writes, errors, close: () => context.close(),
        async message(content) {
            await page.waitForSelector('#message-text:not([disabled])');
            await page.type('#message-text', content);
            await page.waitForSelector('#send:not([disabled])');
            await page.click('#send');
        },
        async text(content) {
            await page.waitForFunction(text => document.body.innerText.includes(text), {}, content);
        },
        async request(route, body) {
            return page.evaluate(async (route, body) => {
                const headers = { 'X-NativeSync-Capabilities': 'desktop-references-v1,source-data-v2,shared-space-v1' };
                if (body !== undefined) {
                    const session = await fetch('/mobile/api/session', { headers }).then(response => response.json());
                    headers['Content-Type'] = 'application/json';
                    headers['X-NativeSync-Entry-Id'] = session.recovery.entryId;
                    headers['X-NativeSync-Session-Marker'] = session.recovery.sessionMarker;
                }
                const response = await fetch('/mobile/api/' + route, {
                    headers, ...(body !== undefined && { method: 'POST', body: JSON.stringify(body) }),
                });
                return { status: response.status, data: await response.json() };
            }, route, body);
        },
        async controls() {
            return page.evaluate(() => ({
                composerDisabled: document.querySelector('#message-text')?.disabled,
                cancelButtons: document.querySelectorAll('[data-cancel-id], [data-cancel-remaining-id]').length,
            }));
        },
    };
}
module.exports = { launch, mobileControl, openPwa };

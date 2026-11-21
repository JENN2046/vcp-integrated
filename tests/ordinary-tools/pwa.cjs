'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createHash, X509Certificate } = require('node:crypto');
const path = require('node:path');

module.exports = async function openReadOnlyPwa({ service, out, cert, request, puppet }) {
    const { pairingCode } = await request('/api/plugins/NativeSync/mobile/pairing', {
        scopeMode: 'shared', sharedSpaceId: 'sharedAB', permissions: ['read'],
    });
    assert.match(pairingCode, /^[A-Za-z0-9_-]{32}$/);
    const spki = createHash('sha256').update(new X509Certificate(fs.readFileSync(cert)).publicKey.export({
        type: 'spki', format: 'der',
    })).digest('base64');
    const browser = await puppet.launch({
        executablePath: process.env.CHROME_BIN || '/opt/google/chrome/chrome',
        headless: true,
        userDataDir: path.join(out, 'pwa-browser'),
        args: ['--ignore-certificate-errors-spki-list=' + spki, '--disable-background-networking', '--no-first-run',
            '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1'],
    });
    try {
        const page = await browser.newPage();
        const writes = [];
        const errors = [];
        page.on('request', req => {
            if (req.method() === 'POST' && /\/(?:session-send|messages|invitations|cancel|abandon|resume|steer|approval)(?:\?|$)/.test(req.url())) {
                writes.push(new URL(req.url()).pathname);
            }
        });
        page.on('pageerror', error => errors.push(error.message));
        await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
        await page.goto(service.origin + '/mobile/#pair=' + pairingCode, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#pair-submit', { visible: true });
        await page.waitForFunction(() => Boolean(document.querySelector('#pair-code')?.value));
        await page.click('#pair-submit');
        await page.waitForSelector('#agent-select');
        const agent = await page.$eval('#agent-select', element => [...element.options]
            .find(option => option.textContent.includes('Synthetic shared'))?.value);
        assert.ok(agent, 'paired PWA can see the shared agent');
        await page.select('#agent-select', agent);
        const topic = service.topics.preSubmit.id;
        await page.waitForFunction(topicId => [...document.querySelectorAll('#topic-select option')]
            .some(option => option.value === topicId), {}, topic);
        await page.select('#topic-select', topic);
        await page.waitForFunction(topicId => document.querySelector('#topic-select')?.value === topicId &&
            !document.querySelector('.history-progress'), {}, topic);
        const readOnlyControls = async () => page.evaluate(() => ({
            composerDisabled: document.querySelector('textarea')?.disabled,
            executionButtons: [...document.querySelectorAll('button:not([disabled])')].map(button => button.innerText)
                .filter(text => /送出|发送|批准|拒绝|允许|取消本次回复/.test(text)),
        }));
        assert.deepEqual(await readOnlyControls(), { composerDisabled: true, executionButtons: [] });
        return {
            async duringApproval() {
                await page.waitForFunction(() => document.body.innerText.includes('ORDINARY_TOOL_APPROVE'));
                const controls = await readOnlyControls();
                assert.deepEqual(controls, { composerDisabled: true, executionButtons: [] });
                assert.doesNotMatch(await page.evaluate(() => document.body.innerText), /OrdinaryToolCounter|Synthetic ordinary tool denial/);
                await page.screenshot({ path: path.join(out, 'read-only-pwa-pending.png') });
                return controls;
            },
            async afterApproval(finalText) {
                await page.waitForFunction(content => document.body.innerText.includes(content), {}, finalText);
                assert.deepEqual(writes, []);
                assert.deepEqual(errors, []);
                assert.deepEqual(await readOnlyControls(), { composerDisabled: true, executionButtons: [] });
                await page.screenshot({ path: path.join(out, 'read-only-pwa-final.png') });
                return { viewport: { width: 390, height: 844 }, browser: await browser.version(),
                    observedTerminalResult: true, normalUiExecutionWrites: writes.length, pageErrors: errors };
            },
            close: () => browser.close(),
        };
    } catch (error) {
        await browser.close();
        throw error;
    }
};

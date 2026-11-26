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

test('Core single chat PWA shows live output, steers the current work, accepts a new message, and recovers on reconnect', { timeout: 45000 }, async t => {
    const f = await fixture(t, {attachments:true});
    const evidence = process.env.VCP_MOBILE_UI_EVIDENCE;
    if (evidence) await fs.mkdir(evidence, {recursive:true});
    const shot = async (page, name) => {
        if (evidence) await page.screenshot({path:path.join(evidence, name + '.png')});
    };
    const provider = await localProvider(t);
    setStream(f, true);
    const { chat, pluginManager } = host(provider);
    const toolName = 'FixtureLightingNotes';
    let toolRuns = 0;
    pluginManager.plugins.set(toolName, { name:toolName, pluginType:'hybridservice', communication:{protocol:'direct'} });
    pluginManager.serviceModules.set(toolName, {module:{
        processToolCall: async () => { toolRuns++; return {status:'success', result:'fixture lighting notes returned'}; }
    }});
    t.after(() => { pluginManager.serviceModules.delete(toolName); pluginManager.plugins.delete(toolName); });
    const { core } = await mountCore(f, chat);
    const upstream = [];
    provider.setReply((_body, res) => {
        upstream.push(res);
        res.setHeader('Content-Type', 'text/event-stream');
        res.write('data: {"choices":[{"delta":{"content":"我会按换景成本来排。产品主图和细节可以共用布光，先把这两组拍完。"}}]}\n\n');
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
        const entry = 'https://127.0.0.1:' + proxy.address().port + '/mobile/';
        await page.goto(entry, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#pair-code',{visible:true});
        await shot(page,'00-pairing');
        await page.type('#pair-code',grant.pairingCode);
        await page.waitForSelector('#pair-submit:not([disabled])');
        await page.click('#pair-submit');
        await page.waitForSelector('#topic-select');
        await page.select('#topic-select', f.topic.id);
        await page.waitForFunction(key => document.querySelector('#topic-select')?.value === key &&
            !document.querySelector('#message-text')?.disabled, {}, f.topic.id);
        const desktop = await f.desktop('A');
        const first = await desktop.runtime.prepareSharedSend({ descriptor: desktop.descriptor, serverSession: true,
            message: { id: 'from-desktop', role: 'user', content: '把明天的拍摄安排整理一下：先拍产品主图，再拍细节，最后试一组上身图。', attachments: [] } });
        await desktop.close();
        await page.waitForFunction(() => document.querySelector('.live-message .bubble')?.textContent.includes('共用布光'));
        await page.type('#message-text', '请把白底主图放在第一组。');
        const steering = await page.waitForSelector('.steering button:not([disabled])');
        await shot(page, '02-core-live-steering');
        await steering.click();
        await page.waitForFunction(() => !document.querySelector('#message-text').value);
        finish(upstream[0], '按原计划整理。');
        await wait(() => upstream.length === 2, 'steering reached provider for same work');
        assert.match(JSON.stringify(provider.calls[1].messages), /请把白底主图放在第一组/);
        const finalText = '\n\n第一组｜白底产品主图\n先固定机位、白平衡和产品朝向，再补正面与侧面。\n\n第二组｜细节与功能\n保留原布光，拉近拍材质与缝线。两组都拍完后，再切换到上身布景。';
        finish(upstream[1], finalText);
        await page.waitForFunction(id => Boolean(document.querySelector('[data-message-id="' + id + '"] .bubble')?.textContent.includes('第二组')), {}, first.replyId);
        await shot(page, '01-core-light-chat');
        await page.click('#topic-toggle');
        await page.waitForSelector('.topic-list button[aria-current="true"]',{visible:true});
        await shot(page,'03-core-topics');
        await page.click('#topic-toggle');
        await page.click('#open-settings');
        await page.click('label:has(input[value="dark"])');
        assert.equal(await page.$eval('html',el=>el.dataset.theme),'dark');
        await page.click('#close-settings');
        await page.waitForFunction(()=>document.querySelector('[data-message-id]'));
        await shot(page,'04-core-dark-chat');
        await page.type('#message-text', '附上现场灯光记录。');
        const notes = path.join(f.root, '灯光记录.txt');
        await fs.writeFile(notes, '现场灯光记录：主灯柔光箱，左侧 45 度。');
        const fileInput = await page.waitForSelector('.attachment-picker input');
        await fileInput.uploadFile(notes);
        await page.waitForSelector('#send:not([disabled])');
        await page.click('#send');
        await wait(() => upstream.length === 3, 'new message reached provider');
        assert.match(JSON.stringify(provider.calls[2].messages), /第二组/);
        finish(upstream[2], '\n<<<[TOOL_REQUEST]>>>\ntool_name:「始」' + toolName + '「末」,\ncommand:「始」ReadFixture「末」\n<<<[END_TOOL_REQUEST]>>>');
        await wait(() => upstream.length === 4, 'returned tool result reached the provider');
        assert.equal(toolRuns,1);
        finish(upstream[3], '\n拍摄安排已更新。');
        await page.waitForFunction(() => [...document.querySelectorAll('[data-message-id] .bubble')].some(node => node.textContent.includes('拍摄安排已更新')));
        const fileButton = await page.waitForSelector('.attachment-open',{visible:true});
        await fileButton.click();
        await page.waitForFunction(()=>document.querySelector('#attachment-viewer')?.textContent.includes('主灯柔光箱'));
        await shot(page,'05-core-attachment');
        await page.click('#attachment-close');
        await page.click('#work-toggle');
        await page.waitForSelector('#conversation-work [data-state="completed"]',{visible:true});
        const tools = await page.waitForSelector('#conversation-work .native-tools summary',{visible:true});
        await tools.click();
        await page.waitForFunction(()=>document.querySelector('#conversation-work .native-tools li')?.textContent.includes('工具调用已返回'));
        await shot(page,'06-core-work');
        await page.click('#work-toggle');
        await page.setOfflineMode(true);
        await page.waitForSelector('.connection-banner', {visible:true});
        await shot(page,'07-core-offline');
        await page.setOfflineMode(false);
        await page.waitForSelector('.connection-banner', {hidden:true});
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => [...document.querySelectorAll('[data-message-id] .bubble')].some(node => node.textContent.includes('拍摄安排已更新')));
        assert.equal(await page.$eval('html',el=>el.dataset.theme),'dark');
        assert.equal(upstream.length,4,'reconnect and reload must not create another execution');
        assert.deepEqual(errors, []);
    } finally {
        await browser?.close();
        if (proxy) await close(proxy);
        await core.close();
        await fs.rm(f.root + '-core', { recursive: true, force: true });
    }
});

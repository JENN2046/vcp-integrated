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
    const composerPosts = [];
    let proxy, browser, steeringFault, holdSteeringReceipt = false;
    let steeringReads = 0, heldSteering, issuedRejection;
    try {
        const grant = f.portal.createPairing({ scopeMode: 'shared', sharedSpaceId: 'sharedAB', permissions: ['read','execute'] });
        const cert = path.join(f.root, 'core-pwa-cert.pem');
        const key = path.join(f.root, 'core-pwa-key.pem');
        execFileSync('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost'], { stdio: 'ignore' });
        const certificate = await fs.readFile(cert);
        const spki = createHash('sha256').update(new X509Certificate(certificate).publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
        proxy = https.createServer({ cert: certificate, key: await fs.readFile(key) }, (req, res) => {
            let fault;
            if (req.method === 'POST' && /\/(?:send|steer)$/.test(req.url)) {
                composerPosts.push(req.url);
                if (req.url.endsWith('/steer')) {
                    fault = steeringFault;
                    steeringFault = null;
                }
            }
            if (fault === 'before') {
                // Send headers before breaking the response so Chromium does
                // not retry a stale keep-alive connection at the transport layer.
                res.writeHead(503, { 'Content-Type':'application/json', 'Content-Length':100 });
                res.write('{');
                setTimeout(() => res.destroy(), 30);
                return;
            }
            if (req.method === 'GET' && req.url.includes('/steering-receipt?')) {
                steeringReads++;
                if (holdSteeringReceipt) return res.writeHead(503, { 'Content-Type':'application/json' }).end('{}');
            }
            const forward = http.request(f.url + req.url, { method: req.method, headers: {
                ...req.headers, 'x-forwarded-proto': 'https', origin: 'https://synthetic-shared.invalid'
            } }, response => {
                res.writeHead(response.statusCode, response.headers);
                if (fault !== 'after') return response.pipe(res);
                assert.equal(response.statusCode, 202);
                response.resume();
                res.write('{');
                setTimeout(() => res.destroy(), 30);
            });
            forward.on('error', () => { if (!res.headersSent && !res.destroyed) { res.statusCode = 502; res.end(); } });
            res.on('close', () => { if (!res.writableEnded) forward.destroy(); });
            if (fault === 'closed') {
                // Keep the browser's original POST in flight until Core closes Work.
                req.pause();
                heldSteering = () => { req.pipe(forward); req.resume(); };
                forward.once('response', response => { issuedRejection = response.statusCode; });
            } else req.pipe(forward);
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
        await page.waitForSelector('#quote-task',{visible:true});
        assert.equal(await page.$eval('#send', button=>button.getAttribute('aria-label')),'发送新消息');
        assert.equal(await page.$$eval('#quote-task', rows=>rows.length),1);
        assert.ok(await page.$eval('footer #quote-task', button=>{
            const entry=button.getBoundingClientRect();
            const editor=document.querySelector('#message-text').getBoundingClientRect();
            return entry.height>=44 && entry.bottom<=editor.top && editor.top-entry.bottom<=12;
        }), 'the one-tap control should be directly above the composer');
        await shot(page, '02a-quote-entry');
        await page.tap('#quote-task');
        assert.equal(await page.evaluate(()=>document.activeElement?.id),'message-text');
        assert.equal(await page.$eval('#send', button=>button.getAttribute('aria-label')),'发送追加指令');
        assert.equal(await page.$eval('.message-composer', form=>form.querySelectorAll('button[type="submit"]').length),1);
        await page.type('#message-text', '请把白底主图放在第一组。');
        await shot(page, '02b-quoted-composer');
        await page.click('#quote-clear');
        assert.equal(await page.$eval('#message-text', el=>el.value),'请把白底主图放在第一组。');
        assert.equal(await page.$eval('#send', button=>button.getAttribute('aria-label')),'发送新消息');
        assert.deepEqual(composerPosts,[]);
        await page.click('#quote-task');
        await page.type('#message-text', '再确认。');
        const quotedDraft = '请把白底主图放在第一组。再确认。';
        await page.reload({waitUntil:'domcontentloaded'});
        await page.waitForSelector('#message-text:not([disabled])');
        assert.equal(await page.$eval('#message-text',el=>el.value),quotedDraft);
        await page.waitForSelector('#task-quote',{visible:true});
        assert.equal(await page.$eval('#send',el=>el.getAttribute('aria-label')),'发送追加指令');
        assert.deepEqual(composerPosts,[]);
        steeringFault = 'after';
        holdSteeringReceipt = true;
        await page.click('#send');
        await page.waitForFunction(() => document.querySelector('#task-quote')?.textContent.includes('尚未确认'));
        assert.equal(core.store.work(first.serverSession.executionId).steering_count, 1);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(text => document.querySelector('#message-text')?.value === text,{},quotedDraft);
        holdSteeringReceipt = false;
        await page.waitForFunction(() => !document.querySelector('#message-text').value &&
            document.querySelector('#steering-delivery')?.textContent.includes('已送达'));
        assert.ok(steeringReads >= 1);
        assert.equal(composerPosts.length, 1);
        await page.waitForSelector('#quote-task', { visible:true });
        await page.click('#quote-task');
        await page.type('#message-text', '这次追加仍需确认。');
        steeringFault = 'after';
        holdSteeringReceipt = true;
        await page.$eval('.message-composer', form => form.requestSubmit());
        await page.waitForFunction(() => document.querySelector('#task-quote')?.textContent.includes('尚未确认'));
        const editor = await browser.newPage();
        try {
            await editor.goto(entry,{waitUntil:'domcontentloaded'});
            await editor.waitForFunction(()=>document.querySelector('#task-quote')?.textContent.includes('尚未确认'));
            await editor.type('#message-text','这是另一个标签页后来编辑的内容。');
            assert.equal(await editor.$eval('#message-text',el=>el.value),'这次追加仍需确认。这是另一个标签页后来编辑的内容。');
        } finally {
            await editor.close();
        }
        await page.bringToFront();
        holdSteeringReceipt = false;
        await page.waitForFunction(() => !document.querySelector('#task-quote') &&
            document.querySelector('#steering-delivery')?.textContent.includes('已送达'));
        const reopened = await browser.newPage();
        try {
            await reopened.goto(entry,{waitUntil:'domcontentloaded'});
            await reopened.waitForSelector('#message-text:not([disabled])');
            assert.equal(await reopened.$eval('#message-text',el=>el.value),'这次追加仍需确认。这是另一个标签页后来编辑的内容。');
            await reopened.waitForSelector('#task-quote',{visible:true});
            assert.equal(composerPosts.length,2);
            await reopened.$eval('#message-text',el=>{el.value='';el.dispatchEvent(new Event('input',{bubbles:true}));});
            await reopened.click('#quote-clear');
        } finally {
            await reopened.close();
        }
        await page.bringToFront();
        finish(upstream[0], '按原计划整理。');
        await wait(() => upstream.length === 2, 'steering reached provider for same work');
        assert.match(JSON.stringify(provider.calls[1].messages), /请把白底主图放在第一组/);
        assert.equal(composerPosts.length,2);
        assert.ok(composerPosts[0].endsWith('/works/'+first.serverSession.executionId+'/steer'));
        await page.waitForSelector('#quote-task',{visible:true});
        await page.click('#quote-task');
        const preservedDraft = '附上现场灯光记录。';
        await page.type('#message-text', preservedDraft);
        const finalText = '\n\n第一组｜白底产品主图\n先固定机位、白平衡和产品朝向，再补正面与侧面。\n\n第二组｜细节与功能\n保留原布光，拉近拍材质与缝线。两组都拍完后，再切换到上身布景。';
        finish(upstream[1], finalText);
        await page.waitForFunction(id => Boolean(document.querySelector('[data-message-id="' + id + '"] .bubble')?.textContent.includes('第二组')), {}, first.replyId);
        await page.reload({waitUntil:'domcontentloaded'});
        await page.waitForSelector('#task-quote[data-closed="true"]');
        assert.equal(await page.$eval('#message-text', el=>el.value),preservedDraft);
        assert.equal(await page.$eval('#send', button=>button.disabled),true);
        await shot(page, '02c-completed-keeps-draft');
        await page.$eval('.message-composer', form=>form.requestSubmit());
        await page.evaluate(() => new Promise(requestAnimationFrame));
        assert.equal(composerPosts.length,2,'a stale quote never falls through to a new message');
        await page.click('#quote-new-message');
        assert.equal(await page.$eval('#message-text', el=>el.value),preservedDraft);
        assert.equal(await page.$eval('#send', button=>button.getAttribute('aria-label')),'发送新消息');
        assert.equal(composerPosts.length,2,'conversion changes only the draft, not the server');
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
        assert.equal(await page.$eval('#message-text', el=>el.value),preservedDraft);
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
        assert.equal(composerPosts.length,3);
        assert.ok(composerPosts[2].endsWith('/send'));
        assert.equal(upstream.length,4,'reconnect and reload must not create another execution');
        const nextDesktop = await f.desktop('A');
        const startWork = async (id, content) => nextDesktop.runtime.prepareSharedSend({
            descriptor: nextDesktop.descriptor, serverSession: true,
            message: { id, role:'user', content, attachments:[] }
        });
        const ending = await startWork('ending-between-click-and-core', 'Work ending during steering POST');
        await wait(() => upstream.length === 5, 'Work for explicit rejection running');
        await page.waitForSelector('#quote-task', { visible:true });
        await page.click('#quote-task');
        await page.type('#message-text', '应保留的追加草稿');
        steeringFault = 'closed';
        await page.waitForSelector('#send:not([disabled])');
        await page.$eval('.message-composer', form => form.requestSubmit());
        await wait(() => heldSteering, 'hold original PWA POST before Core reads it');
        await page.type('#message-text', '，后来编辑保留');
        const retained = '应保留的追加草稿，后来编辑保留';
        finish(upstream[4], 'Work closed before processing steering');
        await wait(() => core.store.work(ending.serverSession.executionId).status === 'completed', 'Work closed');
        heldSteering();
        await page.waitForFunction(() => document.querySelector('#steering-delivery')?.textContent.includes('已拒绝'), {timeout:5000});
        assert.equal(issuedRejection,409);
        assert.equal(core.store.work(ending.serverSession.executionId).steering_count,0);
        assert.equal(await page.$eval('#message-text', el=>el.value),retained);
        assert.ok(await page.evaluate(text=>Object.keys(localStorage).some(key=>
            key.startsWith('vcp.mobile.draft.v1:')&&JSON.parse(localStorage.getItem(key))?.text===text),retained));
        assert.equal(composerPosts.length,4,'the rejection must not send or replay anything');
        await page.click('#quote-exit-rejected');
        assert.equal(await page.$eval('#message-text', el=>el.value),retained);
        await page.reload({waitUntil:'domcontentloaded'});
        await page.waitForFunction(text => document.querySelector('#message-text')?.value===text, {}, retained);
        await page.waitForSelector('#send:not([disabled])');
        await page.$eval('.message-composer', form => form.requestSubmit());
        await wait(() => upstream.length === 6, 'explicit new PWA message after unlocking');
        assert.equal(composerPosts.length,5);
        assert.ok(composerPosts[4].endsWith('/send'));
        finish(upstream[5], 'New message reply');
        await page.waitForFunction(() => [...document.querySelectorAll('#history .bubble')].some(row=>row.textContent.includes('New message reply')));

        const limited = await startWork('steering-limit-mobile', 'Work for the ninth steering attempt');
        const limitedWork = limited.serverSession.executionId;
        await wait(() => upstream.length === 7, 'Work for steering limit running');
        const phone = await f.phone();
        const steer = '/core/sharedAB/' + f.topic.id + '/works/' + limitedWork + '/steer';
        for (let i = 1; i <= 8; i++) {
            await phone.call(steer, { requestId:'limit-fixture-000'+i, text:'Existing steering '+i }, 202);
        }
        await page.waitForSelector('#quote-task', {visible:true});
        await page.click('#quote-task');
        await page.type('#message-text','第九次追加草稿');
        await page.waitForSelector('#send:not([disabled])');
        const limitResponse = page.waitForResponse(response=>response.url().endsWith('/works/'+limitedWork+'/steer') &&
            response.request().method()==='POST');
        await page.$eval('.message-composer',form=>form.requestSubmit());
        const denied = await limitResponse;
        assert.equal(denied.status(),429);
        assert.equal((await denied.json()).error.code,'WORK_STEERING_LIMIT');
        await page.waitForSelector('#quote-exit-rejected',{visible:true,timeout:5000});
        assert.equal(await page.$eval('#message-text', el=>el.value),'第九次追加草稿');
        assert.equal(core.store.work(limitedWork).steering_count,8);
        assert.equal(composerPosts.length,6,'the ninth attempt must not be replayed');
        t.diagnostic('Core WORK_STEERING_LIMIT HTTP 429 on the ninth attempt released the quote lock; eight additions and one denied PWA POST.');
        await page.click('#quote-exit-rejected');
        await page.$eval('#message-text', el=>{el.value='';el.dispatchEvent(new Event('input',{bubbles:true}));});
        finish(upstream[6],'First limited turn');
        await wait(() => upstream.length === 8, 'the original eight steering inputs reach Core provider');
        finish(upstream[7],'Limited work finished');
        await wait(() => core.store.work(limitedWork).status==='completed','Limited work completed');

        const before = await startWork('before-steering-disconnect', 'Work A for unsent steering');
        await wait(() => upstream.length === 9, 'Work A running');
        await page.waitForSelector('#quote-task', { visible:true });
        await page.click('#quote-task');
        await page.type('#message-text', '未到达 Core 的追加');
        steeringFault = 'before';
        await page.waitForSelector('#task-quote');
        await page.waitForSelector('#send:not([disabled])');
        await page.$eval('.message-composer', form => form.requestSubmit());
        await wait(() => composerPosts.length === 7, 'steering POST interrupted before reaching Core');
        await page.waitForFunction(() => document.querySelector('#task-quote')?.textContent.includes('尚未确认'), { timeout: 5000 });
        assert.equal(core.store.work(before.serverSession.executionId).steering_count, 0);
        await page.reload({ waitUntil:'domcontentloaded' });
        await page.waitForFunction(() => document.querySelector('#message-text')?.value === '未到达 Core 的追加');
        await page.type('#message-text', '，后来编辑');
        await page.setOfflineMode(true);
        await page.waitForSelector('.connection-banner', { visible:true });
        await page.setOfflineMode(false);
        finish(upstream[8], 'Work A finished');
        await wait(() => core.store.work(before.serverSession.executionId).status === 'completed', 'Work A completed');
        const next = await startWork('replacement-work-b', 'Work B in same topic');
        await wait(() => upstream.length === 10, 'Work B running');
        await page.waitForFunction(() => document.querySelector('#task-quote')?.textContent.includes('尚未确认') &&
            document.querySelector('#message-text')?.value === '未到达 Core 的追加，后来编辑' &&
            document.querySelector('#send')?.disabled);
        assert.equal(await page.$('#quote-new-message'), null);
        assert.equal(await page.$('#quote-task'), null);
        assert.equal(await page.$('#steering-remove-local'), null, 'a valid unknown intent is never offered as a corrupt record');
        await page.$eval('.message-composer', form => form.requestSubmit());
        assert.equal(composerPosts.length, 7, 'recovery never POSTs, including after the task ends and a new one starts');
        assert.ok(composerPosts[6].endsWith('/works/' + before.serverSession.executionId + '/steer'));
        assert.equal(core.store.work(next.serverSession.executionId).steering_count, 0);
        finish(upstream[9], 'Work B finished');
        await nextDesktop.close();
        assert.deepEqual(errors, []);
    } finally {
        await browser?.close();
        if (proxy) await close(proxy);
        await core.close();
        await fs.rm(f.root + '-core', { recursive: true, force: true });
    }
});

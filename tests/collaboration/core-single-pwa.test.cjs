'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { createHash, X509Certificate } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const { wait, BOX, localProvider, host } = require('../native/fixtures/coreSingleHarness.cjs');
const { CoreService } = require(BOX + '/core/service');
const { localTopicKey } = require(BOX + '/core/localWorkspace');
const express = require(BOX + '/node_modules/express');

test('Core single chat PWA shows live output, steers the current work, accepts a new message, and recovers on reconnect', { timeout: 45000 }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'core-steering-pwa-'));
    const evidence = process.env.VCP_MOBILE_UI_EVIDENCE;
    if (evidence) await fs.mkdir(evidence, {recursive:true});
    const shot = async (page, name) => {
        if (evidence) await page.screenshot({path:path.join(evidence, name + '.png')});
    };
    const provider = await localProvider(t);
    const { chat, pluginManager } = host(provider);
    const toolName = 'FixtureLightingNotes';
    let toolRuns = 0;
    pluginManager.plugins.set(toolName, { name:toolName, pluginType:'hybridservice', communication:{protocol:'direct'} });
    pluginManager.serviceModules.set(toolName, {module:{
        processToolCall: async () => { toolRuns++; return {status:'success', result:'fixture lighting notes returned'}; }
    }});
    t.after(() => { pluginManager.serviceModules.delete(toolName); pluginManager.plugins.delete(toolName); });
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
    let core, backend, backendUrl, origin, proxy, browser, steeringFault, holdSteeringReceipt = false;
    let steeringReads = 0, heldSteering, issuedRejection;
    let holdObserverReceipt = true, holdStaleReceipt = true, holdNewRequestId;
    try {
        const cert = path.join(root, 'core-pwa-cert.pem');
        const key = path.join(root, 'core-pwa-key.pem');
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
                const tab = req.headers['x-fixture-tab'];
                const id = new URL(req.url,'https://fixture.invalid').searchParams.get('requestId');
                if (holdSteeringReceipt || id === holdNewRequestId || (holdObserverReceipt && tab === 'observer') ||
                    (holdStaleReceipt && tab === 'stale')) {
                    return res.writeHead(503, { 'Content-Type':'application/json' }).end('{}');
                }
            }
            const forward = http.request(backendUrl + req.url, { method: req.method, headers: {
                ...req.headers, 'x-forwarded-proto': 'https', origin
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
        origin = 'https://127.0.0.1:' + proxy.address().port;
        core = new CoreService({ directory: path.join(root, 'core'), workspace: 'personal', chat,
            remoteConfig: { origin, hours: 8 } });
        const definition = { ownerType: 'agent', ownerId: 'fixture', topicId: 'lighting', name: 'Lighting',
            config: { name: 'Fixture', systemPrompt: 'Isolated fixture.', model: 'synthetic', streamOutput: true } };
        const topicId = localTopicKey(definition.ownerType, definition.ownerId, definition.topicId);
        await core.local.define(topicId, definition, () => true);
        const actor = core.local.actor;
        const topic = core.topic(actor, 'personal', topicId, 'execute');
        const startWork = async (requestId, text) => {
            const work = await core.send(topic, actor.principal, { requestId, text }, () => {}, actor);
            return work.workId;
        };
        const app = express();
        app.set('trust proxy', 'loopback');
        app.use('/mobile', core.remote.router('mobile'));
        backend = http.createServer(app);
        await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
        backendUrl = 'http://127.0.0.1:' + backend.address().port;
        const grant = core.remote.sessions.createCode(['shared:personal:read', 'shared:personal:execute']);
        browser = await require(BOX + '/node_modules/puppeteer').launch({
            executablePath: process.env.CHROME_BIN || '/opt/google/chrome/chrome', headless: true,
            userDataDir: path.join(root, 'core-pwa-browser'),
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
        await page.select('#topic-select', topicId);
        await page.waitForFunction(key => document.querySelector('#topic-select')?.value === key &&
            !document.querySelector('#message-text')?.disabled, {}, topicId);
        const firstWork = await startWork('from-desktop', '把明天的拍摄安排整理一下：先拍产品主图，再拍细节，最后试一组上身图。');
        await page.waitForFunction(() => document.querySelector('.live-message .bubble')?.textContent.includes('共用布光'));
        const firstRun = '[data-reply-work-id="' + firstWork + '"]';
        assert.equal(await page.$('[data-run-id="'+firstWork+'"]'),null);
        // The SSE preview can arrive before /works ties the Work to its original message.
        await page.waitForSelector('[data-exec-id="'+firstWork+'"][data-state="running"]');
        await page.setOfflineMode(true);
        await page.waitForSelector('.connection-banner', {visible:true});
        await page.waitForFunction(sel=>document.querySelector(sel)?.textContent.includes('核对任务'),{},firstRun);
        await page.setOfflineMode(false);
        await page.waitForSelector('.connection-banner', {hidden:true});
        await page.waitForSelector('[data-live-work-id="'+firstWork+'"] .bubble');
        assert.deepEqual(composerPosts, []);
        await shot(page, '02a-reconnected-same-run');
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
        assert.equal(core.store.work(firstWork).steering_count, 1);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(text => document.querySelector('#message-text')?.value === text,{},quotedDraft);
        const observer=await browser.newPage();
        await observer.setExtraHTTPHeaders({'x-fixture-tab':'observer'});
        await observer.goto(entry,{waitUntil:'domcontentloaded'});
        await observer.waitForFunction(()=>document.querySelector('#task-quote')?.textContent.includes('尚未确认'));
        const stale = await browser.newPage();
        await stale.setExtraHTTPHeaders({'x-fixture-tab':'stale'});
        await stale.goto(entry,{waitUntil:'domcontentloaded'});
        await stale.waitForFunction(()=>document.querySelector('#task-quote')?.textContent.includes('尚未确认'));
        const snapshot = await stale.evaluate(()=>{
            const key = Object.keys(localStorage).find(name=>name.startsWith('vcp.mobile.steering.v1:'));
            return { key, raw:localStorage.getItem(key) };
        });
        await page.bringToFront();
        holdSteeringReceipt = false;
        await page.waitForFunction(() => !document.querySelector('#message-text').value &&
            document.querySelector('#steering-delivery')?.textContent.includes('Core 已收到追加指令'));
        assert.ok(steeringReads >= 1);
        assert.equal(composerPosts.length, 1);
        await page.waitForSelector('#quote-task', { visible:true });
        await page.click('#quote-task');
        await page.type('#message-text', '这次追加仍需确认。');
        steeringFault = 'after';
        holdSteeringReceipt = true;
        await page.$eval('.message-composer', form => form.requestSubmit());
        await page.waitForFunction(() => document.querySelector('#task-quote')?.textContent.includes('尚未确认'));
        await wait(()=>composerPosts.length===2 && core.store.work(firstWork).steering_count===2,
            'second request accepted with its receipt withheld');
        const newer = await page.evaluate(key=>localStorage.getItem(key),snapshot.key);
        holdNewRequestId = JSON.parse(newer).intent.requestId;
        assert.notEqual(newer,snapshot.raw);
        await stale.evaluate(({key,raw})=>{
            const request = navigator.locks.request.bind(navigator.locks);
            const get = Storage.prototype.getItem;
            let armed = true;
            navigator.locks.request=(name,...args)=>{
                if(name!==key||!armed||args.length!==1||typeof args[0]!=='function')return request(name,...args);
                return request(name,async lock=>{
                    armed=false;
                    // Reproduce the stale localStorage read observed after a
                    // real cross-tab lock handoff, for this slot only.
                    Storage.prototype.getItem=function(name){
                        return this===localStorage&&name===key?raw:get.call(this,name);
                    };
                    try{return await args[0](lock);}
                    finally{Storage.prototype.getItem=get;window.staleReceiptSettled=true;}
                });
            };
        },snapshot);
        holdSteeringReceipt=false;
        holdStaleReceipt=false;
        await stale.bringToFront();
        await stale.waitForFunction(()=>window.staleReceiptSettled===true,{polling:50,timeout:5000});

        const verifier=await browser.newPage();
        try {
            await verifier.goto(entry,{waitUntil:'domcontentloaded'});
            assert.equal(await verifier.evaluate(key=>localStorage.getItem(key),snapshot.key),newer,
                'an old receipt on a stale tab cannot erase the newer durable intent');
            await verifier.waitForFunction(()=>document.querySelector('#task-quote')?.textContent.includes('尚未确认'));
            assert.equal(composerPosts.length,2);
        } finally {
            await verifier.close();
            await stale.close();
        }

        holdNewRequestId=undefined;
        await page.bringToFront();
        await page.waitForFunction(()=>!document.querySelector('#message-text').value &&
            document.querySelector('#steering-delivery')?.textContent.includes('Core 已收到追加指令'));
        t.diagnostic('A delayed first receipt with a stale read preserved the newer pending request after reopening; two POSTs.');
        assert.equal(core.store.work(firstWork).steering_count,2);
        assert.equal(await observer.$eval('#message-text',el=>el.value),quotedDraft);
        holdObserverReceipt=false;
        await observer.bringToFront();
        await observer.waitForFunction(()=>!document.querySelector('#message-text').value &&
            document.querySelector('#steering-delivery')?.textContent.includes('Core 已收到追加指令'));

        const readAfterReload = async tab => {
            await tab.bringToFront();
            await tab.reload({waitUntil:'domcontentloaded'});
            await tab.waitForSelector('#message-text:not([disabled])');
            return tab.$eval('#message-text',el=>el.value);
        };
        assert.equal(await readAfterReload(page),'','delayed first receipt must not revive either delivered text in A');
        assert.equal(await readAfterReload(observer),'','delayed first receipt must not revive either delivered text in B');
        await observer.waitForSelector('#quote-task',{visible:true});
        await observer.click('#quote-task');
        const unsent='真正还没发的下一段草稿';
        await observer.type('#message-text',unsent);
        assert.equal(await readAfterReload(page),unsent);
        assert.equal(await readAfterReload(observer),unsent);
        assert.equal(composerPosts.length,2);
        t.diagnostic('Second receipt settled before delayed first receipt; neither delivered edit revived in either tab; unsent text survived; two POSTs.');
        await observer.$eval('#message-text',el=>{el.value='';el.dispatchEvent(new Event('input',{bubbles:true}));});
        await observer.click('#quote-clear');
        await observer.close();
        await page.bringToFront();
        await page.reload({waitUntil:'domcontentloaded'});
        await page.waitForFunction(()=>!document.querySelector('#message-text')?.value);
        finish(upstream[0], '按原计划整理。');
        await wait(() => upstream.length === 2, 'steering reached provider for same work');
        assert.match(JSON.stringify(provider.calls[1].messages), /请把白底主图放在第一组/);
        assert.equal(composerPosts.length,2);
        assert.ok(composerPosts[0].endsWith('/works/'+firstWork+'/steer'));
        await page.waitForSelector('#quote-task',{visible:true});
        await page.click('#quote-task');
        const preservedDraft = '附上现场灯光记录。';
        await page.type('#message-text', preservedDraft);
        const finalText = '\n\n第一组｜白底产品主图\n先固定机位、白平衡和产品朝向，再补正面与侧面。\n\n第二组｜细节与功能\n保留原布光，拉近拍材质与缝线。两组都拍完后，再切换到上身布景。';
        finish(upstream[1], finalText);
        await wait(() => core.store.work(firstWork).status === 'completed', 'steered Work completed');
        const firstReplyId = core.store.work(firstWork).reply_message_id;
        await page.waitForFunction(id => Boolean(document.querySelector('[data-message-id="' + id + '"] .bubble')?.textContent.includes('第二组')), {}, firstReplyId);
        assert.equal(await page.$('[data-run-id="'+firstWork+'"]'),null);
        await page.evaluate((replyId)=>{
            const reply=document.querySelector('[data-message-id="'+replyId+'"]');
            reply.style.marginTop='1200px';
            document.getElementById('history').scrollTop=0;
        },firstReplyId);
        await page.waitForFunction(sel=>document.querySelector(sel)?.textContent.includes('查看原回复'),{},firstRun);
        await page.click(firstRun + ' .work-reply');
        assert.equal(await page.evaluate(() => document.activeElement?.dataset.messageId), firstReplyId);
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
        const notes = path.join(root, '灯光记录.txt');
        await fs.writeFile(notes, '现场灯光记录：主灯柔光箱，左侧 45 度。');
        const fileInput = await page.waitForSelector('#composer-file-picker');
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
        const endingWork = await startWork('ending-between-click-and-core', 'Work ending during steering POST');
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
        await wait(() => core.store.work(endingWork).status === 'completed', 'Work closed');
        heldSteering();
        await page.waitForFunction(() => document.querySelector('#steering-delivery')?.textContent.includes('已拒绝'), {timeout:5000});
        assert.equal(issuedRejection,409);
        assert.equal(core.store.work(endingWork).steering_count,0);
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

        const limitedWork = await startWork('steering-limit-mobile', 'Work for the ninth steering attempt');
        await wait(() => upstream.length === 7, 'Work for steering limit running');
        const steer = '/mobile/api/core/personal/' + topicId + '/works/' + limitedWork + '/steer';
        for (let i = 1; i <= 8; i++) {
            const status = await page.evaluate(async (route, body) => (await fetch(route, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
            })).status, steer, { requestId:'limit-fixture-000'+i, text:'Existing steering '+i });
            assert.equal(status, 202);
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
        assert.equal(composerPosts.length,14,'the ninth attempt must not be replayed');
        t.diagnostic('Core WORK_STEERING_LIMIT HTTP 429 on the ninth attempt released the quote lock; eight additions and one denied PWA POST.');
        await page.click('#quote-exit-rejected');
        await page.$eval('#message-text', el=>{el.value='';el.dispatchEvent(new Event('input',{bubbles:true}));});
        finish(upstream[6],'First limited turn');
        await wait(() => upstream.length === 8, 'the original eight steering inputs reach Core provider');
        finish(upstream[7],'Limited work finished');
        await wait(() => core.store.work(limitedWork).status==='completed','Limited work completed');

        const beforeWork = await startWork('before-steering-disconnect', 'Work A for unsent steering');
        await wait(() => upstream.length === 9, 'Work A running');
        await page.waitForSelector('#quote-task', { visible:true });
        await page.click('#quote-task');
        await page.type('#message-text', '未到达 Core 的追加');
        steeringFault = 'before';
        await page.waitForSelector('#task-quote');
        await page.waitForSelector('#send:not([disabled])');
        await page.$eval('.message-composer', form => form.requestSubmit());
        await wait(() => composerPosts.length === 15, 'steering POST interrupted before reaching Core');
        await page.waitForFunction(() => document.querySelector('#task-quote')?.textContent.includes('尚未确认'), { timeout: 5000 });
        assert.equal(core.store.work(beforeWork).steering_count, 0);
        await page.reload({ waitUntil:'domcontentloaded' });
        await page.waitForFunction(() => document.querySelector('#message-text')?.value === '未到达 Core 的追加');
        await page.type('#message-text', '，后来编辑');
        await page.setOfflineMode(true);
        await page.waitForSelector('.connection-banner', { visible:true });
        await page.setOfflineMode(false);
        finish(upstream[8], 'Work A finished');
        await wait(() => core.store.work(beforeWork).status === 'completed', 'Work A completed');
        const nextWork = await startWork('replacement-work-b', 'Work B in same topic');
        await wait(() => upstream.length === 10, 'Work B running');
        await page.waitForFunction(() => document.querySelector('#task-quote')?.textContent.includes('尚未确认') &&
            document.querySelector('#message-text')?.value === '未到达 Core 的追加，后来编辑' &&
            document.querySelector('#send')?.disabled);
        assert.equal(await page.$('#quote-new-message'), null);
        assert.equal(await page.$('#quote-task'), null);
        assert.equal(await page.$('#steering-remove-local'), null, 'a valid unknown intent is never offered as a corrupt record');
        await page.$eval('.message-composer', form => form.requestSubmit());
        assert.equal(composerPosts.length, 15, 'recovery never POSTs, including after the task ends and a new one starts');
        assert.ok(composerPosts[14].endsWith('/works/' + beforeWork + '/steer'));
        assert.equal(core.store.work(nextWork).steering_count, 0);
        finish(upstream[9], 'Work B finished');
        assert.deepEqual(errors, []);
    } finally {
        await browser?.close();
        if (proxy) await close(proxy);
        if (backend) await close(backend);
        await core?.close();
        await fs.rm(root, { recursive: true, force: true });
    }
});

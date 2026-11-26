'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { createHash, X509Certificate } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { wait, BOX } = require('../native/fixtures/sharedSingleHarness.cjs');
const { localProvider, host } = require('../native/fixtures/coreSingleHarness.cjs');

test('Pilot mobile PWA handles attachments, failed Work, reconnect, drafts, scroll, pairing and one-message model selection', { timeout: 65000 }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'core-mobile-daily-'));
    const provider = await localProvider(t);
    const { chat } = host(provider);
    const express = require(BOX + '/node_modules/express');
    const { CoreService } = require(BOX + '/core/service');
    const { localTopicKey } = require(BOX + '/core/localWorkspace');
    const { administer } = require(BOX + '/core/pairDevice');
    const { createModelCatalog } = require(BOX + '/modules/modelCatalog');
    const baseModel = 'synthetic', nextModel = 'model-b';
    provider.setModels([{id:baseModel, owned_by:'fixture-private'}, {id:nextModel}, {id:nextModel}, {id:''}]);
    const modelCatalog = createModelCatalog({
        apiUrl:provider.url, apiKey:'fixture', modelRedirectHandler:{isEnabled:()=>false},
        semanticModelRouter:{getVirtualModels:()=>[]}
    });
    const certPath = path.join(root, 'cert.pem'), keyPath = path.join(root, 'key.pem');
    execFileSync('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-keyout',keyPath,'-out',certPath,
        '-days','1','-subj','/CN=localhost'], { stdio:'ignore' });
    const cert = await fs.readFile(certPath);
    const spki = createHash('sha256').update(new X509Certificate(cert).publicKey.export({ type:'spki', format:'der' })).digest('base64');
    const app = express(), server = https.createServer({ cert, key:await fs.readFile(keyPath) }, app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'https://127.0.0.1:' + server.address().port;
    const directory = path.join(root, 'core');
    const core = new CoreService({ directory, workspace:'personal', chat, modelCatalog, remoteConfig:{origin, hours:1} });
    const posts = [];
    let truncateSend = false, holdReceipt = false;
    app.use((req, res, next) => {
        if (req.method === 'GET' && req.path.endsWith('/receipt') && holdReceipt) {
            return res.status(503).json({ error:{code:'FIXTURE_RECEIPT_UNAVAILABLE'} });
        }
        if (req.method === 'POST' && /\/(?:send|steer)$/.test(req.path)) {
            posts.push(req.path);
            if (truncateSend && req.path.endsWith('/send')) {
                truncateSend = false;
                const send = res.json.bind(res);
                res.json = value => {
                    if (res.statusCode !== 202) return send(value);
                    res.set('Content-Type','application/json').set('Content-Length','100');
                    res.write('{');
                    setTimeout(() => res.destroy(),30);
                };
            }
        }
        next();
    });
    app.use('/mobile', core.remote.router('mobile'));
    const pair = () => administer({ VCP_CORE_DATA_DIR: directory, VCP_CORE_REMOTE_ORIGIN: origin }, ['pair','mobile']).pairingCode;
    const define = async topicId => {
        const id = localTopicKey('agent','fixture',topicId);
        await core.local.define(id, { ownerType:'agent', ownerId:'fixture', topicId, name:topicId,
            config:{name:'Fixture',model:'synthetic',systemPrompt:'Synthetic test only',streamOutput:true} }, () => true);
        return id;
    };
    let browser;
    const results = {};
    try {
        const topic = await define('main'), other = await define('other');
        core.store.ensureConversation({ workspace:'personal', key:topic, ownerId:'fixture' });
        core.store.transaction(() => {
            for (let i = 0; i < 18; i++) core.store.insertMessage({ id:'seed-'+i, key:topic,
                role:i % 2 ? 'assistant':'user', content:'历史段落 '+i+('，用于移动端滚动验证。'.repeat(12)) });
        });
        browser = await require(BOX+'/node_modules/puppeteer').launch({ executablePath:process.env.CHROME_BIN || '/opt/google/chrome/chrome',
            headless:true, userDataDir:path.join(root,'browser'), args:['--ignore-certificate-errors-spki-list='+spki,
                '--disable-background-networking','--no-first-run','--no-proxy-server',
                '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1'] });
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.setViewport({ width:390, height:844, isMobile:true, hasTouch:true, deviceScaleFactor:1 });
        await page.goto(origin+'/mobile/', { waitUntil:'domcontentloaded' });
        const enter = async code => {
            await page.waitForSelector('#pair-submit:not([disabled])');
            await page.$eval('#pair-code', el => { el.value=''; el.dispatchEvent(new Event('input',{bubbles:true})); });
            await page.type('#pair-code', code);
            await page.$eval('#pair-submit', el => el.click());
        };
        const value = () => page.$eval('#message-text', el => el.value);
        const fill = text => page.$eval('#message-text', (el, text) => { el.value=text; el.dispatchEvent(new Event('input',{bubbles:true})); }, text);
        const chooseTopic = async key => {
            await page.select('#topic-select', key);
            await page.waitForFunction(key => document.querySelector('#topic-select')?.value===key &&
                !document.querySelector('#message-text')?.disabled, {}, key);
        };
        await enter('invalid-code');
        await page.waitForSelector('#pair-submit:not([disabled])');
        results.inlinePairError = await page.evaluate(() => document.querySelector('#pair-code')?.form?.querySelector('[role="alert"]')?.textContent.includes('配对码') || false);
        await enter(pair());
        await page.waitForSelector('#topic-select');
        await chooseTopic(topic);
        await page.click('#open-settings');
        results.pairErrorCleared = await page.evaluate(() => !/请求未完成|配对码无效/.test(document.querySelector('.settings').textContent));
        results.singleDisconnect = await page.$$eval('.device-actions #disconnect,.device-actions #clear-session', buttons => buttons.length===1);
        await page.click('#close-settings');

        const selectFiles = entries => page.$eval('.attachment-picker input', (input, entries) => {
            const selection = new DataTransfer();
            for (const [name, content] of entries) selection.items.add(new File([content], name, { type:'text/plain', lastModified:42 }));
            input.files = selection.files;
            input.dispatchEvent(new Event('change', { bubbles:true }));
        }, entries);
        const removeFiles = async () => {
            while (await page.$('.pending-file button')) await page.$eval('.pending-file button', button=>button.click());
        };
        await selectFiles(Array.from({length:9}, (_v, i)=>['file-'+(i+1)+'.txt', 'x']));
        assert.equal(await page.$$eval('.pending-file', rows => rows.length),8);
        results.ninthReported = await page.evaluate(() => document.querySelector('#attachment-selection-notice')?.textContent.includes('file-9.txt') || false);
        await removeFiles();
        await selectFiles([['same.txt','A'],['same.txt','B']]);
        results.sameMetadataBothAdded = await page.$$eval('.pending-file', rows => rows.length===2);
        await removeFiles();

        await fill('本机话题草稿');
        await chooseTopic(other);
        await fill('另一个话题草稿');
        await page.reload({ waitUntil:'domcontentloaded' });
        await page.waitForSelector('#topic-select');
        await chooseTopic(other);
        results.otherDraftRestored = (await value())==='另一个话题草稿';
        await chooseTopic(topic);
        results.mainDraftRestored = (await value())==='本机话题草稿';
        assert.equal(posts.length,0);

        provider.setReply((_body, res) => res.writeHead(503).end('fixture model unavailable'));
        await fill('模型 503 用例');
        await selectFiles([['same.txt','A'],['same.txt','B']]);
        await page.waitForSelector('#send:not([disabled])');
        await page.$eval('#send', button => button.click());
        await wait(() => core.store.db.prepare("SELECT id FROM works WHERE status='failed'").get(), 'Core work failed');
        const failed = core.store.db.prepare("SELECT id FROM works WHERE status='failed'").get().id;
        const attached = core.store.db.prepare('SELECT attachments_json FROM messages WHERE id=?')
            .get(core.store.work(failed).user_message_id);
        const attachments = JSON.parse(attached.attachments_json);
        results.sameMetadataBothUploaded = attachments.length===2 && attachments[0].hash!==attachments[1].hash;
        await page.waitForFunction(() => document.querySelector('[data-state=failed]'));
        const failedInline = () => page.evaluate(id => document.querySelector('#history [data-failed-work="'+id+'"]')?.textContent.includes('执行失败') || false, failed);
        results.failureInHistory = await failedInline();
        await page.setOfflineMode(true);
        await page.waitForSelector('.connection-banner', {visible:true});
        // Let the scheduled history poll fail while offline.
        await new Promise(resolve => setTimeout(resolve, 2200));
        await page.setOfflineMode(false);
        await page.waitForSelector('.connection-banner', {hidden:true});
        results.noStaleFetchError = await page.evaluate(() => !/Failed to fetch|暂未连上服务端/.test(document.querySelector('footer').textContent));
        results.failureSurvivedReconnect = await failedInline();

        let stream;
        const delta = text => stream.write('data: '+JSON.stringify({choices:[{delta:{content:text}}]})+'\n\n');
        provider.setReply((_body, res) => {
            stream=res;res.setHeader('Content-Type','text/event-stream');delta('流式开始');
        });
        await fill('滚动用例');
        await page.waitForSelector('#send:not([disabled])');
        await page.$eval('#send', button => button.click());
        await wait(() => stream, 'synthetic stream opened');
        await page.waitForSelector('.live-message .bubble');
        const readScroll = () => page.$eval('#history', el=>({ top:el.scrollTop, gap:el.scrollHeight-el.clientHeight-el.scrollTop }));
        await page.$eval('#history', el => { el.scrollTop=el.scrollHeight; });
        await page.waitForFunction(() => { const e=document.querySelector('#history');return e.scrollHeight-e.clientHeight-e.scrollTop<3; });
        delta('跟随段落'.repeat(400)+'底部跟随标记');
        await page.waitForFunction(()=>document.querySelector('.live-message .bubble')?.textContent.includes('底部跟随标记'));
        results.followedAtBottom = (await readScroll()).gap < 24;
        await page.$eval('#history', el => { el.scrollTop=100; });
        await page.waitForFunction(()=>document.querySelector('#history').scrollTop<=105);
        delta('下一段'.repeat(400)+'上翻标记');
        await page.waitForFunction(()=>document.querySelector('.live-message .bubble')?.textContent.includes('上翻标记'));
        results.stayedScrolledUp = (await readScroll()).top <= 105;
        const returnLatest = await page.$('#return-latest');
        if (returnLatest) await returnLatest.click();
        results.returnedToLatest = Boolean(returnLatest) && (await readScroll()).gap < 24;
        stream.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
        await wait(() => core.store.db.prepare("SELECT id FROM works WHERE status='completed'").get(), 'synthetic stream completed');
        assert.equal(posts.length,2);

        provider.setReply((_body, res) => res.writeHead(503).end('fixture model unavailable'));
        await fill('普通发送丢失回执');
        truncateSend = true;
        holdReceipt = true;
        await page.waitForSelector('#send:not([disabled])');
        await page.$eval('#send', button => button.click());
        await page.waitForSelector('#pending-submission');
        await wait(() => core.store.db.prepare("SELECT id FROM messages WHERE content='普通发送丢失回执'").get(),
            'ordinary message durable after lost response');
        await page.setOfflineMode(true);
        await page.waitForSelector('.connection-banner',{visible:true});
        await page.setOfflineMode(false);
        await page.waitForSelector('#pending-submission');
        await page.reload({waitUntil:'domcontentloaded'});
        await page.waitForSelector('#pending-submission');
        assert.equal(await value(),'普通发送丢失回执');
        holdReceipt = false;
        await page.waitForFunction(() => !document.querySelector('#pending-submission') && !document.querySelector('#message-text').value);
        await page.reload({waitUntil:'domcontentloaded'});
        await page.waitForSelector('#message-text:not([disabled])');
        assert.equal(await value(),'');
        assert.equal(posts.length,3,'receipt reads do not resend the ordinary message');

        await fill('仅原配对身份可见');
        await page.click('#open-settings');
        await page.$eval('#disconnect', button => button.click());
        await page.waitForSelector('#pair-code');
        await enter(pair());
        await page.waitForSelector('#topic-select');
        await chooseTopic(topic);
        assert.equal(await value(),'','a new pairing does not inherit an old identity’s draft');
        await chooseTopic(other);
        assert.equal(await value(),'','a new pairing does not inherit another topic’s draft either');
        assert.equal(posts.length,3);

        await chooseTopic(topic);
        const initialConfig = core.local.configuration({ workspace:'personal', key:topic });
        const firstModelCall = provider.calls.length;
        const activeStreams = [];
        provider.setReply((_body, res) => {
            activeStreams.push(res);
            res.writeHead(200, {'Content-Type':'text/event-stream'});
            res.write('data: {"choices":[{"delta":{"content":"模型回复"}}]}\n\n');
        });
        const finishModelTurn = res => res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
        const sendText = async text => {
            await fill(text);
            await page.waitForSelector('#send:not([disabled])');
            await page.$eval('#send', button => button.click());
        };
        const readModelLabel = () => page.$eval('#composer-model-current', el=>el.textContent.trim());
        const selectB = async () => {
            await page.waitForSelector('#composer-model-current:not([disabled])');
            await page.click('#composer-model-current');
            await page.waitForSelector('#composer-model-options button');
            const ids = await page.$$eval('#composer-model-options button', buttons=>buttons.map(button=>button.textContent.trim()));
            assert.deepEqual(ids, [baseModel, nextModel]);
            await page.$$eval('#composer-model-options button', (buttons,id)=>buttons.find(button=>button.textContent.trim()===id).click(), nextModel);
        };
        const workFor = text => core.store.db.prepare(`SELECT works.id,works.status,works.frozen_config_json
            FROM works JOIN messages ON works.user_message_id=messages.id WHERE messages.content=?`).get(text);

        assert.match(await readModelLabel(), /当前模型.*synthetic/);
        await sendText('模型 A 的旧任务');
        await wait(() => activeStreams.length===1, 'old task reached provider with A');
        const oldWork = workFor('模型 A 的旧任务');
        assert.equal(provider.calls[firstModelCall].model, baseModel);
        await selectB();
        assert.match(await readModelLabel(), /下一条.*model-b/);
        await page.waitForSelector('#quote-task', { visible:true });
        await page.click('#quote-task');
        assert.match(await readModelLabel(), /追加沿用.*synthetic/);
        await sendText('追加到 A 任务');
        await page.waitForSelector('#task-quote', { hidden:true });
        assert.match(await readModelLabel(), /下一条.*model-b/);
        finishModelTurn(activeStreams[0]);
        await wait(() => activeStreams.length===2, 'steered turn reached provider');
        assert.equal(provider.calls[firstModelCall+1].model, baseModel);
        assert.match(JSON.stringify(provider.calls[firstModelCall+1].messages), /追加到 A 任务/);
        assert.equal(JSON.parse(core.store.work(oldWork.id).frozen_config_json).model, baseModel);
        finishModelTurn(activeStreams[1]);
        await wait(() => workFor('模型 A 的旧任务').status==='completed', 'old A work completed');

        truncateSend = true;
        holdReceipt = true;
        await sendText('选择 B 后的新消息');
        await wait(() => activeStreams.length===3, 'B work reached provider');
        const selectedWork = workFor('选择 B 后的新消息');
        assert.notEqual(selectedWork.id,oldWork.id);
        assert.equal(provider.calls[firstModelCall+2].model,nextModel);
        assert.equal(JSON.parse(selectedWork.frozen_config_json).model,nextModel);
        await page.waitForSelector('#pending-submission');
        assert.match(await readModelLabel(), /待确认.*model-b/);
        holdReceipt = false;
        finishModelTurn(activeStreams[2]);
        await wait(() => workFor('选择 B 后的新消息').status==='completed', 'B work completed');
        await page.waitForFunction(() => document.querySelector('#composer-model-current')?.textContent.includes('当前模型') &&
            document.querySelector('#message-text')?.value==='');
        await sendText('下一条使用默认 A');
        await wait(() => activeStreams.length===4, 'one-shot selection returned to A');
        assert.equal(provider.calls[firstModelCall+3].model,baseModel);
        finishModelTurn(activeStreams[3]);
        await wait(() => workFor('下一条使用默认 A').status==='completed', 'default A work completed');
        assert.deepEqual(core.local.configuration({ workspace:'personal', key:topic }), initialConfig);

        await selectB();
        provider.setModels([{id:baseModel}]);
        await sendText('目录移除后保留这个草稿');
        await page.waitForFunction(() => document.querySelector('#send-state')?.textContent.includes('不在 Core 允许的目录'));
        assert.equal(await value(),'目录移除后保留这个草稿');
        assert.equal(workFor('目录移除后保留这个草稿'),undefined);
        assert.equal(provider.calls.length,firstModelCall+4);
        assert.equal(posts.length,8,'receipt recovery does not resubmit B; removed model reaches no provider');

        const storageKeys = await page.evaluate(async () => {
            const {recovery,topics}=await (await fetch('/mobile/api/session')).json();
            return Object.fromEntries(topics.map(topic=>{
                const owner=JSON.stringify([topic.ownerType,topic.sharedOwnerId||topic.ownerId||topic.agentName]);
                const scope=JSON.stringify([recovery.entryId,recovery.sessionMarker,owner,topic.topicId,topic.key]);
                const key='vcp.mobile.steering.v1:'+scope;
                localStorage.setItem(key,topic.topicId==='main'?'{truncated':JSON.stringify({intent:{requestId:'incomplete'}}));
                return [topic.key,key];
            }));
        });
        await page.reload({waitUntil:'domcontentloaded'});
        await page.waitForSelector('#topic-select');
        await chooseTopic(topic);
        await page.waitForSelector('#steering-remove-local',{visible:true,timeout:5000});
        assert.equal(await page.$eval('#send', button=>button.disabled),true);
        await page.$eval('.message-composer', form=>form.requestSubmit());
        assert.equal(posts.length,8);
        await page.click('#steering-remove-local');
        assert.match(await page.$eval('#steering-remove-warning',el=>el.textContent),/不会撤回已发内容，也不能证明未送达/);
        await page.click('#steering-cancel-remove');
        assert.notEqual(await page.evaluate(key=>localStorage.getItem(key),storageKeys[topic]),null);
        await page.click('#steering-remove-local');
        await page.click('#steering-confirm-remove');
        await page.waitForSelector('#send:not([disabled])');
        assert.equal(await value(),'目录移除后保留这个草稿');
        assert.equal(await page.evaluate(key=>localStorage.getItem(key),storageKeys[topic]),null);
        assert.notEqual(await page.evaluate(key=>localStorage.getItem(key),storageKeys[other]),null);
        await chooseTopic(other);
        await page.waitForSelector('#steering-remove-local',{visible:true});
        await chooseTopic(topic);
        assert.equal(await value(),'目录移除后保留这个草稿');
        assert.equal(posts.length,8);
        assert.deepEqual(errors, []);
        assert.deepEqual(Object.entries(results).filter(([,passed])=>!passed).map(([name])=>name), [], JSON.stringify(results));
    } finally {
        await browser?.close();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        await core.close();
        await fs.rm(root,{recursive:true,force:true});
    }
});

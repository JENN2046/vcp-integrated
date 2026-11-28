'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const https = require('node:https');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, X509Certificate } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { BOX, coreFixture, localProvider, host, wait } = require('../native/fixtures/coreSingleHarness.cjs');

test('Core PWA retires each finished preview across a missed or late event', {timeout:30000}, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'core-preview-'));
    const provider = await localProvider(t);
    const streams = [];
    provider.setReply((_body,res) => {
        res.writeHead(200,{'Content-Type':'text/event-stream'});
        res.write('data: {"choices":[{"delta":{"content":"Fixture preview"}}]}\n\n');
        streams.push(res);
    });
    const finish = (index,text) => streams[index].end('data: '+JSON.stringify({
        choices:[{delta:{content:text},finish_reason:'stop'}]
    })+'\n\ndata: [DONE]\n\n');
    const key = path.join(root,'preview.key'), cert = path.join(root,'preview.pem');
    execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
    const certificate = await fs.readFile(cert);
    const spki = createHash('sha256').update(new X509Certificate(certificate).publicKey.export({type:'spki',format:'der'})).digest('base64');
    let feed, holdChanges = false, holdWorks = false, worksBeforeSecondFinal, writes = 0;
    const proxy = https.createServer({key:await fs.readFile(key),cert:certificate},(req,res) => {
        const request = new URL(req.url,'https://localhost');
        if (!req.headers['x-fixture-command'] && req.method==='POST' && /\/(?:send|steer)$/.test(request.pathname)) writes++;
        if (request.pathname.endsWith('/observe')) {
            // The real snapshots advance independently of this controlled SSE feed.
            feed = res;
            res.writeHead(200,{'Content-Type':'text/event-stream'}).flushHeaders();
            return;
        }
        if (holdChanges && request.pathname.endsWith('/changes')) {
            const after = Number(request.searchParams.get('after'));
            return res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({changes:[],next:after,head:after}));
        }
        if (holdWorks && request.pathname.endsWith('/works')) {
            return res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(worksBeforeSecondFinal));
        }
        const forward = https.request(f.endpoint + req.url, { ca: f.certificate, method: req.method, headers: {
            ...req.headers, origin
        }}, response => {
            res.writeHead(response.statusCode,response.headers);
            response.pipe(res);
        });
        forward.on('error',() => { if(!res.headersSent&&!res.destroyed)res.writeHead(502).end(); });
        res.on('close',() => { if(!res.writableEnded)forward.destroy(); });
        req.pipe(forward);
    });
    await new Promise(resolve => proxy.listen(0,'127.0.0.1',resolve));
    const push = (event,data) => feed.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const origin = 'https://127.0.0.1:'+proxy.address().port;
    const f = await coreFixture(t, host(provider).chat, { root, origin, proxyCertificate: certificate });
    const { core } = f;
    const { route, key: topicId } = await f.define({ config: { name: 'Fixture Agent', model: 'synthetic',
        systemPrompt: 'Isolated fixture.', streamOutput: true } });
    const grant = core.remote.sessions.createCode(['shared:personal:read']);
    let browser;
    try {
        browser = await require(BOX+'/node_modules/puppeteer').launch({
            executablePath:process.env.CHROME_BIN||'/opt/google/chrome/chrome',headless:true,
            userDataDir:path.join(root,'preview-browser'),
            args:['--ignore-certificate-errors-spki-list='+spki,'--disable-background-networking','--no-first-run',
                '--no-proxy-server','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1']
        });
        const page = await browser.newPage();
        page.setDefaultTimeout(10000);
        const errors = [];
        page.on('pageerror',error => errors.push(error.message));
        await page.goto(origin+'/mobile/',{waitUntil:'domcontentloaded'});
        await page.waitForSelector('#pair-code',{visible:true});
        await page.type('#pair-code',grant.pairingCode);
        await page.waitForSelector('#pair-submit:not([disabled])');
        const paired = page.waitForResponse(response => response.url().endsWith('/api/pair'));
        await page.click('#pair-submit');
        const pairReply = await paired;
        assert.equal(pairReply.status(), 200, await pairReply.text());
        await page.waitForSelector('#topic-select');
        await page.select('#topic-select',topicId);
        await wait(() => feed,'PWA observation feed');
        const sender = await f.mobile();
        const send = requestId => sender.call(route+'/send',{requestId,text:requestId},202);
        const first = await send('fixture-preview-first');
        await wait(() => streams.length===1,'first Work running');
        const firstRun = '[data-reply-work-id="'+first.id+'"]';
        const secondLabel = 'SECOND_WORK_LIVE';
        const liveText = text => page.waitForFunction(text =>
            Array.from(document.querySelectorAll('.live-message')).some(el=>el.textContent.includes(text)),{},text);
        const live = () => page.$$eval('.live-message',rows=>rows.map(row=>row.textContent));
        const settled = workId => core.store.work(workId).status==='completed';
        await page.waitForFunction(sel=>document.querySelector(sel)?.textContent.includes('正在回复'),{},firstRun);
        push('tool',{workId:first.id,pluginName:'Fixture tool',status:'dispatched'});
        assert.equal(await page.$('.inline-agent-run'),null);
        push('work_preview',{workId:first.id,text:'FIRST_WORK_OLD_PREVIEW'});
        await liveText('FIRST_WORK_OLD_PREVIEW');
        await page.waitForSelector(firstRun,{hidden:true});
        // Match the handset: the observer misses the terminal event. The /works
        // snapshot sees completion before the message delta reaches this page.
        holdChanges=true;
        finish(0,'Original first reply.');
        await wait(() => settled(first.id),'first Work committed without terminal SSE');
        const firstReply = core.store.work(first.id).reply_message_id;
        const second = await send('fixture-preview-second');
        await wait(() => streams.length===2,'another Work remains in flight');
        push('work_preview',{workId:second.id,text:secondLabel});
        await liveText(secondLabel);
        await page.waitForFunction(sel=>document.querySelector(sel)?.textContent.includes('核对任务'),{},firstRun);
        assert.deepEqual((await live()).map(text=>text.includes(secondLabel)),[true],
            'a completed snapshot must retire only that Work preview');
        assert.equal(await page.$('.inline-agent-run'),null);
        await page.click(firstRun+' .work-reply');

        push('work_preview',{workId:first.id,text:'FIRST_WORK_LATE_PREVIEW'});
        push('delta',{workId:first.id,text:'FIRST_WORK_LATE_DELTA'});
        push('delta',{workId:second.id,text:'_AFTER_LATE_EVENT'});
        await liveText(secondLabel+'_AFTER_LATE_EVENT');
        assert.deepEqual((await live()).map(text=>text.includes(secondLabel)),[true],
            'late preview and delta must not resurrect the first Work');

        holdChanges=false;
        await page.waitForSelector('[data-message-id="'+firstReply+'"]');
        await page.evaluate((reply,message)=>{
            document.querySelector('[data-message-id="'+reply+'"]').style.marginTop='1200px';
            document.querySelector('[data-message-id="'+message+'"]').scrollIntoView({block:'start',behavior:'instant'});
        },firstReply,core.store.work(first.id).user_message_id);
        await page.waitForFunction(sel=>document.querySelector(sel)?.textContent.includes('查看原回复'),{},firstRun);
        await page.waitForSelector(firstRun+' .work-reply',{visible:true});
        await page.click(firstRun+' .work-reply');
        assert.equal(await page.evaluate(()=>document.activeElement?.dataset.messageId),firstReply);
        assert.equal(await page.$eval('[data-message-id="'+firstReply+'"] .bubble',el=>el.textContent),'Fixture previewOriginal first reply.');
        assert.deepEqual((await live()).map(text=>text.includes(secondLabel)),[true]);

        // Invert the order for the second Work: the terminal event now arrives
        // while the /works snapshot still reports running.
        const action='[data-run-id="'+second.id+'"]';
        push('approval_requested',{workId:second.id,toolName:'Fixture approval'});
        await page.waitForFunction(sel=>document.querySelector(sel)?.textContent.includes('等待桌面审批'),{},action);
        push('approval_settled',{workId:second.id});
        await page.waitForSelector(action,{hidden:true});
        worksBeforeSecondFinal = await sender.call(route+'/works');
        const task='fixture-native-task';
        worksBeforeSecondFinal.works.find(work=>work.id===second.id).tasks=[{id:task,agent:'Fixture Agent',state:'running'}];
        holdWorks=true;
        push('native_task',{workId:second.id,taskId:task,state:'running'});
        await page.waitForFunction(sel=>document.querySelector(sel)?.textContent.includes('后台任务进行中'),{},action);
        holdWorks=false;
        push('native_task',{workId:second.id,taskId:task,state:'completed'});
        await page.waitForSelector(action,{hidden:true});
        worksBeforeSecondFinal = await sender.call(route+'/works');
        holdChanges=holdWorks=true;
        finish(1,'Original second reply.');
        await wait(() => settled(second.id),'second Work completed in Core');
        const secondReply = core.store.work(second.id).reply_message_id;
        const secondRun = '[data-reply-work-id="'+second.id+'"]';
        push('work_state',{workId:second.id,status:'completed',replyId:secondReply});
        push('work_preview',{workId:second.id,text:'SECOND_WORK_LATE_PREVIEW'});
        await page.waitForFunction(sel=>document.querySelector(sel)?.textContent.includes('核对任务'),{},secondRun);
        assert.deepEqual(await live(),[]);
        holdChanges=holdWorks=false;
        await page.waitForSelector('[data-message-id="'+secondReply+'"]');
        assert.equal(await page.$$eval('.live-message,.inline-agent-run',rows=>rows.length),0);
        assert.equal(writes,0);
        assert.deepEqual(errors,[]);
    } finally {
        await browser?.close();
        proxy.closeAllConnections();
        await new Promise(resolve => proxy.close(resolve));
    }
});

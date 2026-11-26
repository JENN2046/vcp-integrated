'use strict';

const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {mkdir, readFile, writeFile} = require('node:fs/promises');
const {createServer} = require('node:http');
const path = require('node:path');
const {pathToFileURL} = require('node:url');

const repo = path.resolve(__dirname, '../..');
const puppeteer = require(path.join(repo, 'apps/server/node_modules/puppeteer'));
const dist = process.argv[2];
const evidence = process.argv[3];
const baseline = process.env.BASELINE === '1';

const space = 'synthetic-space';
const recovery = {version:1, entryId:'1'.repeat(64), sessionMarker:'2'.repeat(64)};
const members = Array.from({length:24}, (_, i) => ({id:'fixture-member-'+i, name:'测试成员 '+i+' · 共享工作台成员', unavailable:i===0}));
const topics = [
    ['group-main', 'group', 'synthetic-group', '共享群聊 · 产品开发协作与设计评审长期工作小组', '移动端回归会话 · 第三期产品设计和多端交互验收讨论', 'source-alpha', '测试来源甲'],
    ['group-alt', 'group', 'synthetic-group', '共享群聊 · 产品开发协作', '第二个回归话题', 'source-alpha', '测试来源甲'],
    ['agent-main', 'agent', 'synthetic-agent', '独立测试 Agent', '单聊回归话题', 'source-beta', '测试来源乙'],
].map(([key, ownerType, ownerId, agentName, topicName, sourceId, sourceLabel]) => ({
    key, ownerType, ownerId, sharedOwnerId:ownerId, agentName, topicName, sourceId, sourceLabel,
    topicId:key, sharedSpaceId:space, model:'synthetic-model', configVersion:3, historyReady:true,
    historyProtocol:2, executionProtocol:2, messageCount:12, updatedAt:1795305600000,
    members:ownerType==='group'?members:[],
}));
const job = {id:'previous-group-step', topicKey:'group-main', state:'completed', own:false, kind:'group_message', stepCount:2,
    toolInvocations:[{invocationId:'fixture-call',pluginName:'AgentAssistant',stepId:'a',state:'returned'}],
    nativeTasks:[{nativeTaskId:'fixture-aa',executionId:'previous-group-step',pluginName:'AgentAssistant',stepId:'a',
        invocationId:'fixture-call',agentBaseName:'测试群成员甲',state:'completed',revision:1,observedAt:1795305600000,
        reviewRequired:false,reviewResolved:false,summary:'测试原生任务状态可展开。'}],
    steps:[{id:'a',name:'测试群成员甲',state:'completed'}, {id:'b',name:'测试群成员乙',state:'completed'}]};
const progress = ['甲','乙'].map((label, i) => ({sourceId:'source-'+i, sourceLabel:'测试来源'+label, directoryErrors:0, pendingImports:0,
    pendingOperations:0, conflicts:0, attachmentsPending:0, configurationPending:0, configurationErrors:0}));
const eventsFor = key => Array.from({length:12}, (_, i) => {
    const id = key+'-'+i;
    return {action:'upsert', position:i+1, seq:i+1, msgId:id,
        message:{id, role:i%2?'assistant':'user', timestamp:1795305600000+i, name:'测试群成员甲',
            content:i===11?'隔离验证 · 最新历史 · '+key:'隔离验证消息 '+i+'。用于验证聊天记录在移动屏幕和短视口中的可阅读性。'}};
});

async function fixture(executable) {
    const {submissionText} = await import(pathToFileURL(path.join(repo, 'apps/mobile/src/contracts.generated.js')));
    const posts = [];
    const accepted = [];
    const errors = [];
    const server = createServer(async (request, response) => {
        const url = new URL(request.url, 'http://127.0.0.1');
        const body = async () => {const chunks=[]; for await(const chunk of request) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks));};
        const json = value => {response.setHeader('Content-Type','application/json'); response.end(JSON.stringify(value));};
        const route = url.pathname.replace(/^\/mobile\/api\//, '');
        try {
            if (!url.pathname.startsWith('/mobile/api/')) {
                const name = url.pathname === '/mobile/' ? 'index.html' : url.pathname.slice('/mobile/'.length);
                const filename = path.resolve(dist, name);
                assert.ok(filename.startsWith(path.resolve(dist)+path.sep));
                const mime = {'.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.png':'image/png', '.webmanifest':'application/manifest+json'};
                response.setHeader('Content-Type', mime[path.extname(name)] || 'application/octet-stream');
                response.end(await readFile(filename));
                return;
            }
            if (route === 'connection') return json({credentialExchangeAllowed:false, service:'Synthetic fixture'});
            if (route === 'session') return json({authenticated:true, recovery, selectedTopic:'group-main', directory:{paged:true},
                sharedPermissions:['shared:'+space+':read', ...(executable?['shared:'+space+':execute']:[])]});
            if (route === 'directory') {
                const kind = url.searchParams.get('kind');
                if (kind === 'revision') return json({revision:'fixture-revision', sourceProgress:progress});
                const values = kind==='agents'
                    ? topics.filter(t => t.key !== 'group-alt').map(t => ({id:t.ownerId, name:t.agentName, ownerType:t.ownerType, sourceId:t.sourceId, sourceLabel:t.sourceLabel}))
                    : topics.map(t => ({...t, executable}));
                return json({revision:'fixture-revision', [kind]:values, hasMore:false});
            }
            if (route === 'selection') { await body(); return json({ok:true}); }
            const [, key, part, snapshotId] = route.split('/');
            const topic = topics.find(t => t.key === key);
            assert.ok(topic, 'Unknown fixture route '+route);
            if (part === 'baseline') {
                const snapshot = {id:'snapshot-'+key, watermark:12, total:12};
                return json(snapshotId?{...snapshot, events:eventsFor(key), next:12, hasMore:false}:snapshot);
            }
            if (part === 'events') return json({topic, events:[], nextSeq:12, headSeq:12, hasMore:false});
            if (part === 'executions') {
                const mode = url.searchParams.get('mode');
                const executions = mode==='recent'?[...(key==='group-main'?[job]:[]), ...accepted.filter(j=>j.topicKey===key)]:[];
                return json({version:2, topicKey:key, mode, executions, total:executions.length, hasMore:false});
            }
            if (part === 'execution-request') return json({executions:accepted.filter(j=>j.requestId===url.searchParams.get('requestId'))});
            if (part === 'invitations' || part === 'messages') {
                posts.push({key, part, payload:await body()});
                assert.ok(executable, 'Unexpected write from read-only session');
                assert.equal(request.headers['x-nativesync-entry-id'], recovery.entryId);
                assert.equal(request.headers['x-nativesync-session-marker'], recovery.sessionMarker);
                const {payload} = posts.at(-1);
                const kind = part==='invitations'?'invitation':'message';
                const payloadHash = createHash('sha256').update(submissionText({topicKey:key, kind, payload})).digest('hex');
                const receipt = {topicKey:key, id:'post-'+posts.length, requestId:payload.requestId, state:'completed',
                    recovery:{version:1, sessionMarker:recovery.sessionMarker, payloadHash, kind}};
                accepted.push(receipt);
                return json(receipt);
            }
            throw Error('Unexpected fixture route '+route);
        } catch (error) { errors.push(error.message); response.statusCode=500; response.end('Synthetic fixture error'); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return {posts, errors, url:'http://127.0.0.1:'+server.address().port+'/mobile/',
        close:() => new Promise(resolve => {server.close(resolve); server.closeAllConnections();})};
}

async function layout(page) {
    return page.evaluate(() => {
        const viewport = window.visualViewport;
        const rect = selector => {
            const el = document.querySelector(selector);
            if(!el) return null;
            const {x,y,width,height,bottom,right} = el.getBoundingClientRect();
            let visibleTop=Math.max(0,y), visibleBottom=Math.min(bottom,viewport.height);
            for(let parent=el.parentElement;parent;parent=parent.parentElement){
                if(getComputedStyle(parent).overflowY==='visible') continue;
                const clip=parent.getBoundingClientRect();
                visibleTop=Math.max(visibleTop,clip.top);
                visibleBottom=Math.min(visibleBottom,clip.bottom);
            }
            return {x,y,width,height,bottom,right,clientHeight:el.clientHeight,scrollHeight:el.scrollHeight,
                visibleHeight:Math.max(0,visibleBottom-visibleTop)};
        };
        return {viewport:{width:viewport.width,height:viewport.height}, scrollWidth:document.documentElement.scrollWidth,
            header:rect('header'), topicToggle:rect('#topic-toggle'), settings:rect('#open-settings'), nav:rect('nav'), history:rect('#history'), footer:rect('footer'), message:rect('#message-text'),
            latest:rect('#history article:last-of-type'), invite:rect('#group-invite'), send:rect('#send')};
    });
}

async function click(page, selector) {
    await page.waitForSelector(selector,{visible:true});
    await page.tap(selector);
}

async function reach(page, selector) {
    await page.waitForSelector(selector,{visible:true});
    const result = await page.$eval(selector, async element => {
        element.scrollIntoView({block:'center'});
        await new Promise(resolve=>requestAnimationFrame(resolve));
        const rects=[...element.getClientRects()].map(({x,y,width,height})=>({x,y,width,height}));
        const hits=rects.map(({x,y,width,height})=>document.elementFromPoint(x+width/2,y+height/2));
        return {reachable:hits.some(hit=>element.contains(hit)), rects,
            hits:hits.map(hit=>hit?.id||hit?.className||hit?.tagName)};
    });
    assert.ok(result.reachable, selector+' cannot be reached by touch '+JSON.stringify(result));
}

async function togglePanel(page, id, open) {
    const toggle = await page.$('#'+id+'-toggle');
    if(!toggle) return;
    const expanded = await toggle.evaluate(el=>el.getAttribute('aria-expanded')==='true');
    if (expanded !== open) await click(page,'#'+id+'-toggle');
}

async function reveal(page, selector) {
    const panel = /execution|data-exec|accepted-submission|native-aa-task|native-tools/.test(selector)?'work'
        : /topic|source|shared-directory|agent-select/.test(selector)?'topic':null;
    if (panel) await togglePanel(page,panel,true);
    const state = await page.$eval(selector, el => ({
        summaries: [...document.querySelectorAll('summary')].map((summary,index)=>({summary,index}))
            .filter(({summary})=>summary.parentElement.contains(el) && summary.parentElement!==el.closest('summary')?.parentElement && !summary.parentElement.open)
            .map(({index})=>index),
    }));
    const handles=await page.$$('summary');
    for (const index of state.summaries) await handles[index].click();
    await reach(page,selector);
}

async function check(browser, scenario){
    const {name,width,height,executable} = scenario;
    const service = await fixture(executable);
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    const requestsOutsideFixture = [];
    await page.setRequestInterception(true);
    page.on('request', request => {
        if (request.url().startsWith(new URL(service.url).origin+'/') || request.url().startsWith('data:')) return request.continue();
        requestsOutsideFixture.push(request.url());
        return request.abort();
    });
    try {
        await page.setViewport({width,height,isMobile:true,hasTouch:true,deviceScaleFactor:1,isLandscape:width>height});
        await page.goto(service.url);
        await page.waitForFunction(() => document.querySelector('#history article:last-of-type')?.textContent.includes('group-main'));
        await page.waitForFunction(() => Boolean(document.querySelector('#agent-select'))
            ? !document.querySelector('#agent-select').disabled
            : !document.querySelector('#topic-toggle')?.disabled);
        if (baseline) await page.waitForSelector('[data-exec-id="previous-group-step"]');
        const initial = await layout(page);
        await page.screenshot({path:path.join(evidence,name+'-initial.png')});
        if (baseline) return {initial};
        assert.ok(initial.header.height <= 64);
        assert.ok(initial.topicToggle.width >= 44 && initial.topicToggle.height >= 44);
        assert.ok(initial.settings.width >= 44 && initial.settings.height >= 44 && initial.settings.right <= width);
        await click(page,'#open-settings');
        await click(page,'#close-settings');
        assert.ok(initial.history.visibleHeight >= 84, name+' history collapsed: '+JSON.stringify(initial));
        assert.ok(initial.scrollWidth <= width+1, name+' overflowed horizontally');
        assert.ok(initial.latest.visibleHeight >= 20, name+' newest message starts offscreen');

        await reveal(page,'#topic-search');
        await page.type('#topic-search','第二个');
        assert.deepEqual(await page.$$eval('#topic-select option', options=>options.filter(option=>!option.disabled).map(option=>option.value)), ['group-alt']);
        await page.$eval('#topic-search', el => {el.value=''; el.dispatchEvent(new Event('input',{bubbles:true}));});
        await reveal(page,'[data-topic-key="group-alt"]');
        await click(page,'[data-topic-key="group-alt"]');
        await page.waitForFunction(() => document.querySelector('#history article:last-of-type')?.textContent.includes('group-alt'));
        await reveal(page,'#agent-select');
        await page.select('#agent-select',JSON.stringify(['agent','synthetic-agent']));
        await page.waitForFunction(() => document.querySelector('#history article:last-of-type')?.textContent.includes('agent-main'));
        await reveal(page,'#source-select');
        await page.select('#source-select','source-beta');
        await page.waitForFunction(() => document.querySelector('#history article:last-of-type')?.textContent.includes('agent-main'));
        await reveal(page,'#source-select');
        await page.select('#source-select','source-alpha');
        await page.waitForFunction(() => document.querySelector('#history article:last-of-type')?.textContent.includes('group-main'));
        await reveal(page,'.topic-detail');
        await reveal(page,'.source-progress');
        await reveal(page,'#shared-directory-open');
        await page.screenshot({path:path.join(evidence,name+'-navigation.png')});
        await togglePanel(page,'topic',false);
        await reveal(page,'[data-exec-id="previous-group-step"] .execution-row');
        await reveal(page,'.native-tools summary');
        await click(page,'.native-tools summary');
        await reveal(page,'.native-tools li');
        await reveal(page,'.native-aa-task summary');
        await click(page,'.native-aa-task summary');
        await reveal(page,'.native-aa-task p');
        await page.screenshot({path:path.join(evidence,name+'-execution.png')});

        await togglePanel(page,'work',false);
        await togglePanel(page,'topic',false);
        const modes = await page.evaluate(() => ['#message-text','#send','#group-invite'].map(selector => document.querySelector(selector)?.disabled ?? null));
        if (!executable) {
            assert.ok(modes.every(mode=>mode===true || mode===null), 'Read-only submission control enabled');
            assert.deepEqual(service.posts, []);
        } else {
            await reveal(page,'#group-invite');
            assert.equal(await page.select('#group-invite','fixture-member-20').then(values=>values[0]),'fixture-member-20');
            const inviteButton = '.group-invitation button:last-child';
            await reveal(page,inviteButton);
            await click(page,inviteButton);
            await page.waitForFunction(() => document.querySelector('#accepted-submission'));
            assert.equal(service.posts[0].payload.agentId,'fixture-member-20');

            await reveal(page,'#message-text');
            await page.type('#message-text','移动端回归：验证输入与发送。');
            let keyboard;
            if(name==='portrait-390') {
                await page.setViewport({width,height:330,isMobile:true,hasTouch:true,deviceScaleFactor:1});
                await reach(page,'#send');
                keyboard = await layout(page);
                assert.ok(keyboard.latest.visibleHeight>=20,'bottom-pinned latest message lost after resize');
                assert.ok(keyboard.history.visibleHeight>=42,'history lost in reduced-height viewport');
                await page.screenshot({path:path.join(evidence,name+'-keyboard.png')});
            }
            await reach(page,'#send');
            await click(page,'#send');
            await page.waitForFunction(() => document.querySelector('#message-text')?.value==='');
            assert.equal(service.posts[1].payload.text,'移动端回归：验证输入与发送。');
            assert.deepEqual(service.posts.map(row=>row.part),['invitations','messages']);
            assert.deepEqual(pageErrors, []);
            assert.deepEqual(requestsOutsideFixture, []);
            assert.deepEqual(service.errors, []);
            return {initial, keyboard, posted:service.posts.map(row=>row.part)};
        }
        assert.deepEqual(pageErrors, []);
        assert.deepEqual(requestsOutsideFixture, []);
        assert.deepEqual(service.errors, []);
        return {initial, posted:[]};
    } finally {await page.close(); await service.close();}
}

(async () => {
    assert.ok(dist && evidence, 'Usage: node tests/mobile-chat-layout/browser.cjs DIST EVIDENCE_DIR');
    await mkdir(evidence,{recursive:true});
    const browser = await puppeteer.launch({executablePath:process.env.CHROME_BIN||'/opt/google/chrome/chrome',headless:true});
    const result = {};
    try {
        for (const scenario of [
            {name:'portrait-320',width:320,height:568,executable:true},
            {name:'portrait-360',width:360,height:640,executable:true},
            {name:'portrait-390',width:390,height:844,executable:true},
            {name:'landscape-640',width:640,height:360,executable:true},
            {name:'readonly-360',width:360,height:640,executable:false},
        ]) {
            try {result[scenario.name]=await check(browser,scenario);}
            catch(error) {result[scenario.name]={error:error.stack}; process.exitCode=1;}
            console.log(scenario.name, JSON.stringify(result[scenario.name]));
        }
    } finally {await browser.close(); await writeFile(path.join(evidence,'geometry.json'),JSON.stringify(result,null,2)+'\n');}
})().catch(error=>{console.error(error);process.exitCode=1;});

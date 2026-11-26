'use strict';
const fs = require('node:fs');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { fixture } = require('./seedFixture.cjs');

const contract=require('./seed-contract.json');
const auth='synthetic-only';
const coreInput='RC-01 local Core checkout';

function listen(server, port = 0) {
    return new Promise((resolve, reject) => server.once('error', reject).listen(port, '127.0.0.1', () => resolve(server.address().port)));
}
function closeServer(server) {
    return new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); });
}
async function jsonBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function start({out, candidate, cert, key, ca = cert, trace, waitUntil, mode, httpsPort = 0, handleFixtureRequest, hardwareStream, observedContext, ordinaryTools, delegation, serverRevision, mobileBuild, groupRelay, serverDependencies, restoreSyntheticState, expectedStartupError, streamInterrupt, toolHandoff, coreRemote}) {
    const independentCore = ['core-local', 'core-remote'].includes(mode);
    const sourceApp = path.join(candidate, 'apps/server');
    const box = path.join(out, 'runtime-box');
    fs.mkdirSync(box);
    fs.mkdirSync(path.join(box, 'Plugin'));
    fs.mkdirSync(path.join(out, 'empty-diaries'));

    // Stage only versioned server files. The synthetic DB and plugin config live in this run.
    const sourceListing = serverRevision
        ? ['ls-tree', '-r', '--name-only', '-z', serverRevision, '--', 'apps/server/']
        : ['ls-files', '-z', '--', 'apps/server/'];
    const tracked = execFileSync('git', sourceListing, { cwd: candidate });
    const excluded = /(?:^|\/)(?:node_modules|DebugLog|logs|TVDaily|dailynote|file|image|Agent|VectorStore|\.file_cache)(?:\/|$)|(?:^|\/)(?:config\.env|\.env(?:\..*)?)(?:$|\/)|\.(?:pem|key|p12|pfx)$/i;
    for (const entry of tracked.toString().split('\0').filter(Boolean)) {
        const rel = entry.slice('apps/server/'.length);
        if (excluded.test(rel) || (independentCore && rel === 'Plugin/NativeSync/plugin-manifest.json')) continue;
        if (rel.startsWith('Plugin/') && !rel.startsWith('Plugin/NativeSync/') &&
            !/^Plugin\/(?:VCPSleep|AgentAssistant)\/(?!plugin-manifest)/.test(rel) &&
            !(delegation && rel === 'Plugin/AgentAssistant/plugin-manifest.json.example')) continue;
        const file = path.join(sourceApp, rel);
        if (!serverRevision && (!fs.existsSync(file) || !fs.lstatSync(file).isFile())) continue;
        const staged = path.join(box, rel);
        fs.mkdirSync(path.dirname(staged), { recursive: true });
        if (serverRevision) {
            fs.writeFileSync(staged, execFileSync('git', ['show', serverRevision + ':' + entry], { cwd: candidate, maxBuffer: 32 * 1024 * 1024 }));
        } else fs.copyFileSync(file, staged);
    }
    const nativeAddon = 'rust-vexus-lite/vexus-lite.linux-x64-gnu.node';
    const builtAddon = path.join(sourceApp, nativeAddon);
    if (!fs.existsSync(builtAddon)) {
        throw Error('Vexus addon missing. Build the server native addon before integration.');
    }
    fs.copyFileSync(builtAddon, path.join(box, nativeAddon));
    const pluginPath = 'Plugin/NativeSync';
    const builtMobile = mobileBuild || path.join(sourceApp, pluginPath, 'mobile-dist');
    if (!fs.existsSync(path.join(builtMobile, 'index.html'))) {
        throw Error('Mobile build missing. Run the repository build before integration.');
    }
    fs.cpSync(builtMobile, path.join(box, pluginPath, 'mobile-dist'), { recursive: true });
    for (const [from, to] of [[serverDependencies || path.join(sourceApp, 'node_modules'), path.join(box, 'node_modules')],
        [path.join(candidate, 'node_modules'), path.join(out, 'node_modules')]]) {
        if (fs.existsSync(from)) fs.symlinkSync(from, to, 'dir');
    }
    fs.mkdirSync(path.join(box, 'config'), { recursive: true });
    fs.writeFileSync(path.join(box, 'config/tool-call-records.config.json'), JSON.stringify({
        enabled: true, captureMultimodal: false, autoCleanupEnabled: false
    }));

    if (coreRemote?.risk) {
        fs.mkdirSync(path.join(box, 'Agent'), { recursive: true });
        fs.writeFileSync(path.join(box, 'Agent', 'pilot-fixture.txt'), 'Frozen native prompt from the server fixture.');
        fs.writeFileSync(path.join(box, 'agent_map.json'), JSON.stringify({ 'PilotFixture': 'pilot-fixture.txt' }));
    }
    ordinaryTools?.stage(box);
    toolHandoff?.stage?.(box);
    streamInterrupt?.stage(box);
    delegation?.stage(box);

    const cleanup = [];
    const seed = path.join(out, 'seed');
    fs.mkdirSync(seed);
    fs.writeFileSync(path.join(seed, 'L4-SYNTHETIC-ONLY'), 'NativeSync L4 synthetic process fixture\n');
    let source, target, stopTopic, ordinaryTopics;
    const descriptors = {};
    const missingCase = mode === 'idle' && process.env.NS_IDLE_SCENARIOS === 'attachment';
    const idleScale = mode === 'idle' && process.env.NS_IDLE_SCALE === 'large';
    if (independentCore) {
        const descriptor = { itemType: 'agent', itemId: 'local-agent', topicId: 'local-topic' };
        const { mapTopic } = require('../../apps/desktop/modules/services/localCoreRuntime');
        source = { id: mapTopic(descriptor).sharedId };
        for (const role of ['A', 'B']) descriptors[role] = { preSubmit: descriptor };
    } else try {
        const f = await fixture({ after: fn => cleanup.push(fn) }, { syntheticRoot: seed, agentConfig: toolHandoff?.agentConfig });
        source = f.topic;
        const actor = f.actor('C');
        const targetAgent = f.shared.create(actor, {sharedSpaceId:'sharedAB',opId:'sponsor-target-agent',kind:'agent',localId:'sponsor-target-agent',config:{...f.owner.config,name:'Synthetic lost receipt',systemPrompt:'SYNTHETIC_LOST_RECEIPT',model:'synthetic',streamOutput:false}}).object;
        target = f.shared.create(actor, {sharedSpaceId:'sharedAB',opId:'sponsor-target-topic',kind:'topic',parentId:targetAgent.id,localId:'sponsor-target-topic',localParent:'sponsor-target-agent',config:{name:'Sponsor target existing topic'}}).object;
        const stopAgent = f.shared.create(actor,{sharedSpaceId:'sharedAB',opId:'stop-agent',kind:'agent',localId:'stop-agent',config:{...f.owner.config,name:'Synthetic interrupted single',systemPrompt:'SYNTHETIC_PARTIAL',streamOutput:true}}).object;
        stopTopic = f.shared.create(actor,{sharedSpaceId:'sharedAB',opId:'stop-topic',kind:'topic',parentId:stopAgent.id,localId:'stop-topic',localParent:'stop-agent',config:{name:'Partial single existing topic'}}).object;
        if (missingCase) require('./idle-attachment.cjs').seed(f,source);
        if (idleScale) require('./idle-scale.cjs').seedScale(f, [source,target,stopTopic]);
        ordinaryTopics = { ...ordinaryTools?.seed?.(f), ...groupRelay?.seed?.(f) };
        if (hardwareStream) hardwareStream.seedHistory(f.store, stopTopic.topic);
        if (observedContext) await observedContext.seed(f, source, out);
        const idleDesktops = [];
        for (const p of ['A','B']) {
            const desktop = await f.desktop(p);
            if (mode === 'idle') idleDesktops.push(desktop);
            const boundTarget = desktop.runtime.localFor(target.id);
            const boundTargetAgent = desktop.runtime.localFor(targetAgent.id);
            descriptors[p] = {preSubmit:desktop.descriptor,
                lostAck:{itemType:'agent',itemId:boundTargetAgent.localId,topicId:boundTarget.localId},
                interrupted:{itemType:'agent',itemId:desktop.runtime.localFor(stopAgent.id).localId,topicId:desktop.runtime.localFor(stopTopic.id).localId}};
            for (const [subject, descriptor] of Object.entries(descriptors[p])) {
                await desktop.queue.initializeIfMissing(descriptor, []);
                const seeded=await desktop.queue.read(descriptor);
                const idleMessages = idleScale || (missingCase && subject === 'preSubmit') ? 1 : 0;
                const expected = observedContext && subject === 'preSubmit' ? observedContext.seedCount
                    : hardwareStream && subject === 'interrupted' ? hardwareStream.seedCount : idleMessages;
                assert.equal(seeded.length, expected, 'seeded synthetic History count');
            }
        }
        for (const desktop of idleDesktops) await desktop.runtime.tick();
    } finally {
        for (const fn of cleanup.reverse()) await fn();
    }
    fs.writeFileSync(path.join(out,'fixture-descriptors.json'), JSON.stringify({source,target,stopTopic,descriptors},null,2));
    const data = path.join(out, 'data');
    fs.mkdirSync(data, {recursive:Boolean(observedContext)});
    if (restoreSyntheticState) await restoreSyntheticState({ box, data });
    else if (!independentCore) fs.copyFileSync(path.join(seed,'central.sqlite'), path.join(data,'central.sqlite'));
    const calls=[], requests=[];
    const gates={partialClosed:false};
    let releaseLost,activePartial;
    const lostGate=new Promise(r=>{releaseLost=r;});
    const provider=http.createServer(async(req,res)=>{
        try {
            if(req.url==='/v1/models' && coreRemote?.provider) {
                const response = await fetch(coreRemote.provider + req.url);
                return res.writeHead(response.status).end(await response.text());
            }
            if(req.url==='/v1/models')return res.end(JSON.stringify({data:[{id:'synthetic'}]}));
            if(req.method!=='POST'||req.url!=='/v1/chat/completions')throw Error('Unexpected fixture provider route '+req.url);
            const body=await jsonBody(req);
            const last=body.messages.findLast(row=>row.role==='user')?.content;
            const input=Array.isArray(last)?last.filter(x=>x.type==='text').map(x=>x.text).join(''):last;
            const which=input===(coreRemote?.input || coreInput)&&(mode==='core-rc'||independentCore)?'coreRC':Object.entries(contract.cases).find(([,content])=>input===content)?.[0];
            const row={case:which,id:body.requestId,stream:Boolean(body.stream),at:Date.now()};
            const ordinaryReply = ordinaryTools?.reply(body, row, calls);
            if (delegation?.classify(body, row)) {
                calls.push(row);
                trace('provider', row);
                return await delegation.reply(body, row, res);
            }
            calls.push(row);trace('provider',row);
            if (await streamInterrupt?.respond(body, row, res, calls)) return;
            if (groupRelay && await groupRelay.respond(body, row, res)) return;
            if (await observedContext?.respond?.(body, row, res)) return;
            observedContext?.recordProvider?.(req.url, body);
            if(which==='lostAck'||which==='coreRC')await lostGate;
            if (coreRemote?.provider) {
                row.imageParts = body.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
                    .filter(item => item.type === 'image_url').length;
                const response = await fetch(coreRemote.provider + req.url, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body), signal: AbortSignal.timeout(80000)
                });
                row.status = response.status;
                res.writeHead(response.status, { 'Content-Type': response.headers.get('content-type') });
                const { Readable } = require('node:stream');
                await require('node:stream/promises').pipeline(Readable.fromWeb(response.body), res);
                return;
            }
            if(which==='interrupted'){
                if(!body.stream)throw Error('Partial fixture expected streaming provider input');
                if (hardwareStream) { hardwareStream.provider.accept(res); return; }
                res.writeHead(200,{'content-type':'text/event-stream'});
                res.once('close',()=>{gates.partialClosed=true;trace('partial-provider-closed',{});});
                row.providerFrames=[{type:'delta',content:contract.partialText}];
                activePartial=res;
                res.write('data: '+JSON.stringify({choices:[{index:0,delta:{role:'assistant',content:contract.partialText},finish_reason:null}]})+'\n\n');
                return;
            }
            const payload={id:'fixture-'+calls.length,object:'chat.completion',created:1,model:'synthetic',choices:[{index:0,message:{role:'assistant',content:ordinaryReply ?? observedContext?.reply ?? contract.completeText},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}};
            res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(payload));
        } catch(e) { calls.push({case:'fixtureError',error:e.message}); if(!res.headersSent)res.writeHead(500);res.end(); }
    });
    const providerPort = await listen(provider);
    const dummy = net.createServer();
    const backendPort = await listen(dummy);
    await closeServer(dummy);
    let drop=true, lostRequestId=null, dropConfigName=null;
    const proxy = https.createServer({key:fs.readFileSync(key),cert:fs.readFileSync(cert)},async (req,res) => {
        const url=new URL(req.url,'https://127.0.0.1');
        const route=url.pathname;
        const nativeBFinal = req.method === 'POST' && route === '/v1/chat/completions' &&
            req.headers['x-nativesync-device'] === 'deviceB' && Number(req.headers['x-nativesync-generation']) > 0;
        const detachFinal = toolHandoff?.finalReceipt && nativeBFinal;
        if (handleFixtureRequest && await handleFixtureRequest(req, res, route)) return;
        if (hardwareStream && req.method === 'POST' && route.endsWith('/session-send') &&
            req.headers['x-nativesync-device'] !== 'deviceA') {
            requests.push({route,method:req.method,status:403,injected:true,observerSendRejected:true});
            return res.writeHead(403,{'content-type':'application/json'}).end(JSON.stringify({error:{code:'OBSERVATION_ONLY'}}));
        }
        if (mode!=='local-only' && req.method==='POST' && route==='/v1/local-chat/completions') {
            calls.push({phase:'unexpected-desktop-local-provider'});
            req.resume();
            return res.writeHead(500).end(JSON.stringify({error:{code:'UNEXPECTED_DESKTOP_LOCAL_EXECUTION'}}));
        }
        const relayAction = groupRelay && req.method === 'POST' && /\/mobile\/api\/executions\/[^/]+\/cancel(?:-remaining)?$/.test(route);
        const compactionRequest = (mode === 'compact-history-identity' || observedContext?.observeCompaction) && req.method === 'POST' &&
            /\/shared\/compact-(prepare|commit|cancel)$/.test(route);
        const compactionTransport = observedContext?.summaryModels && req.method === 'POST' && route === '/v1/chat/completions';
        const relevant = compactionRequest || (streamInterrupt && route === '/v1/interrupt') || relayAction || toolHandoff?.observeRequest(req.method, route) || req.method==='POST' && /\/shared\/(session-send|session-cancel|task-stop|admit|complete|config)$/.test(route);
        const row = {route,method:req.method,at:Date.now(),device:req.headers['x-nativesync-device'],capabilities:req.headers['x-nativesync-capabilities']};
        let body;
        if (relevant || compactionTransport) {
            const chunks=[];
            for await (const chunk of req) chunks.push(chunk);
            body=Buffer.concat(chunks);
            row.bodySha256=require('node:crypto').createHash('sha256').update(body).digest('hex');
            row.body=body.length ? JSON.parse(body) : {};
            if (req.method === 'GET') row.query = Object.fromEntries(url.searchParams);
            for (const key of ['proof','authorization','capability','ticket']) if (typeof row.body[key]==='string') {
                row.body[key+'Sha256']=require('node:crypto').createHash('sha256').update(row.body[key]).digest('hex');
                delete row.body[key];
            }
            if (relevant) requests.push(row);
            if (compactionTransport && observedContext.summaryModels.includes(row.body.model)) {
                requests.push(Object.assign(row, {summaryTransport:true, requestId:row.body.requestId, model:row.body.model}));
            }
            if(route.endsWith('/session-send') && row.body.message?.content===contract.cases.preSubmit) {
                row.status=409;row.injected=true;row.response={error:{code:'SHARED_CONTEXT_CHANGED'}};
                return res.writeHead(409,{'content-type':'application/json'}).end(JSON.stringify(row.response));
            }
            if (route.endsWith('/session-send') && (row.body.message?.content === contract.cases.lostAck ||
                ordinaryTools?.lostReceiptMarker && row.body.message?.content === ordinaryTools.lostReceiptMarker)) {
                lostRequestId = row.body.requestId;
            }
        }
        const requestLookup = req.method === 'GET' && route.endsWith('/shared/request');
        if(requestLookup){
            row.query=Object.fromEntries(url.searchParams);requests.push(row);
            if(drop&&lostRequestId&&url.searchParams.get('requestId')===lostRequestId){
                row.status=503;row.injected=true;
                return res.writeHead(503,{'content-type':'application/json'}).end(JSON.stringify({error:{code:'FIXTURE_RECONCILE_HELD'}}));
            }
        }
        if (mode === 'local-only' && route === '/v1/local-chat/completions') {
            requests.push(row);
            streamInterrupt?.observeSummaryRequest(row);
        }
        if (streamInterrupt && route === '/v1/chatvcp/completions') requests.push(row);
        const observeRecoveredRequest = ['compact-cross-device', 'compact-history-identity'].includes(mode) && requestLookup &&
            lostRequestId && row.query.requestId === lostRequestId;
        const isLocalChat = route === '/v1/local-chat/completions';
        const upstreamHeaders = { ...req.headers, 'x-forwarded-proto': 'https' };
        if (['tool-handoff', 'tool-handoff-stream'].includes(mode) && typeof row.capabilities === 'string') {
            upstreamHeaders['x-nativesync-capabilities'] = row.capabilities.split(',')
                .filter(capability => capability !== 'shared-controlled-tool-pair-v1').join(',');
        }
        const upstream = http.request({host:'127.0.0.1',port:backendPort,path:isLocalChat?'/v1/chat/completions':req.url,method:req.method,headers:upstreamHeaders},async response => {
            if (relevant || observeRecoveredRequest) {
                const chunks=[];
                for await (const chunk of response) chunks.push(chunk);
                const payload=Buffer.concat(chunks);
                row.status=response.statusCode;
                try {
                    const value = JSON.parse(payload);
                    if (observeRecoveredRequest) {
                        const request = value.request;
                        row.response = { request:request && { id:request.id, requestId:request.requestId, state:request.state } };
                    } else row.response = value;
                } catch {}
                if ((relayAction && groupRelay.dropResponse?.(row)) || toolHandoff?.dropResponse(row)) {
                    row.dropped = true;
                    // Send only a prefix of the accepted response so the client cannot
                    // decode the ACK. A pre-header disconnect permits Chrome auto-retry.
                    const headers = { ...response.headers, 'content-length': payload.length };
                    delete headers['transfer-encoding'];
                    res.writeHead(response.statusCode, headers);
                    res.write(payload.subarray(0, 1), () => res.destroy());
                    return;
                }
                if (drop && route.endsWith('/session-send') && row.body?.requestId===lostRequestId && lostRequestId && response.statusCode>=200 && response.statusCode<300) {
                    row.dropped=true;
                    res.destroy();
                    return;
                }
                if (dropConfigName && route.endsWith('/shared/config') &&
                    row.body?.config?.name === dropConfigName && response.statusCode >= 200 && response.statusCode < 300) {
                    dropConfigName = null;
                    row.dropped = true;
                    res.destroy();
                    return;
                }
                return res.writeHead(response.statusCode,response.headers).end(payload);
            }
            row.status=response.statusCode;
            if (row.summaryTransport) {
                row.upstreamStatus = response.headers['x-vcp-upstream-status'];
                const chunks = [];
                response.on('data', chunk => chunks.push(chunk));
                response.on('close', () => {
                    row.summaryWire = Buffer.concat(chunks).subarray(0, 16384).toString('utf8');
                    row.complete = response.complete;
                });
            }
            if ((missingCase || observedContext?.observeAttachments) && route.includes('/shared-attachments/')) requests.push(row);
            if (mode === 'idle' && process.env.NS_IDLE_OBSERVE_TOPIC === 'yes' && route.endsWith('/shared/session-events')) {
                requests.push({ ...row, scope: url.searchParams.get('scope') });
            }
            if (detachFinal) {
                toolHandoff.observeFinalNativeResponse(response, row);
                return;
            }
            if (streamInterrupt && route === '/v1/chatvcp/completions') streamInterrupt.inspect(response, row);
            if (toolHandoff?.observeNativeResponse && req.headers['x-nativesync-admission'] && route === '/v1/chat/completions') {
                toolHandoff.observeNativeResponse(response, row);
                if (nativeBFinal && toolHandoff.readback) toolHandoff.observeFinalNativeResponse(response, row);
                res.once('finish', () => { row.downstreamFinished = true; });
                requests.push(row);
            }
            if (nativeBFinal && toolHandoff?.finalMutation) {
                const deliver = Promise.withResolvers();
                toolHandoff.receipt.deliverFinalResponse = deliver.resolve;
                res.once('close', () => deliver.resolve());
                const chunks = [];
                for await (const chunk of response) chunks.push(chunk);
                await deliver.promise;
                if (!res.destroyed) res.writeHead(response.statusCode, response.headers).end(Buffer.concat(chunks));
                return;
            }
            if (coreRemote && route === '/mobile/api/pair') trace('mobile-pair-http', {
                status: response.statusCode, sameOrigin: req.headers.origin === 'https://' + req.headers.host,
                originPresent: Boolean(req.headers.origin), nullOrigin: req.headers.origin === 'null',
                firefox: /Firefox/.test(req.headers['user-agent'] || '')
            });
            res.writeHead(response.statusCode,response.headers);
            response.pipe(res);
        });
        upstream.on('error',() => { if (!res.headersSent) res.writeHead(502); res.end(); });
        res.on('close',() => {
            if (detachFinal) toolHandoff.downstreamClosed(res, row);
            if (!detachFinal || toolHandoff.finalReceipt !== 'terminal') upstream.destroy();
        });
        if (body) upstream.end(body); else req.pipe(upstream);
    });
    let proxyPort;
    try { proxyPort = await listen(proxy, httpsPort); }
    catch (error) {
        await closeServer(provider);
        throw error;
    }
    const node = process.execPath;
    let backend, exit;
    function launchBackend() {
        const log=fs.openSync(path.join(out,'backend.log'),'a');
        backend = spawn(node, ['--require',path.join(__dirname,'loopback.cjs'),
            ...(observedContext ? ['--require',observedContext.preload] : []),'server.js'], {
            cwd:box,stdio:['ignore',log,log],env:{
                ...(process.env.NS_FIXTURE_POLL_WATCHERS === '1' && { CHOKIDAR_USEPOLLING:'true', NS_FIXTURE_POLL_WATCHERS:'1' }),
                ...(mode==='core-local'&&{ VCP_CORE_DATA_DIR:path.join(out,'core'), VCP_CORE_MODE:'local' }),
                ...(coreRemote&&{ VCP_CORE_DATA_DIR:path.join(out,'core'), VCP_CORE_MODE:'remote',
                    VCP_CORE_REMOTE_ORIGIN:'https://127.0.0.1:'+proxyPort, VCP_CORE_IMAGE_MODELS:JSON.stringify([coreRemote.model]) }),
                ...(mode==='core-rc'&&{ VCP_CORE_DATA_DIR:path.join(out,'core'), VCP_CORE_WORKSPACE:'sharedAB', VCP_CORE_MODE:'shared' }),
                PATH:'/usr/bin:/bin',HOME:out,LANG:'C.UTF-8',TZ:'UTC',NS_LOADED_REPORT:path.join(out,'backend-loaded.json'),
                ...(mode === 'idle' && process.env.NS_IDLE_METER !== 'off' ? { NS_METER_BACKEND:'1', NS_METER_PREFIX:path.join(out,'backend') } : {}),
                ...(observedContext ? { NS_CONTEXT_HANDLER_LOG: observedContext.handlerLog, NS_CONTEXT_INPUT: observedContext.input } : {}),
                PORT:String(backendPort),VCP_LOCAL_LISTEN_HOST:'127.0.0.1',Key:auth,API_Key:'synthetic-provider',VCP_Key:'synthetic-sponsor-ws',
                API_URL:'http://127.0.0.1:'+providerPort,...(mode==='transport-only'?{}:{ApiRetries:'1'}),MaxVCPLoopNonStream:'4',MaxVCPLoopStream:'4',
                KNOWLEDGEBASE_ROOT_PATH:path.join(out,'empty-diaries'),KNOWLEDGEBASE_STORE_PATH:path.join(data,'vectors'),
                KNOWLEDGEBASE_FULL_SCAN_ON_STARTUP:'false',TDB_KNOWLEDGE_ENABLED:'false',
                NativeSyncEnabled:independentCore?'false':'true',NativeSyncDataDir:data,NativeMobileEnabled:independentCore?'false':'true',
                NativeMobileOrigin:'https://127.0.0.1:'+proxyPort,NativeMobileStartDelayMs:'0',
                ...(delegation ? { AdminUsername:'synthetic-admin', AdminPassword:'synthetic-admin-only' } : {}),
                ...(mode === 'idle' ? { NativeMobileConfigSync:'true', NativeMobileAttachments:'true' } : {}),
                ...(observedContext ? { NativeMobileConfigSync:'true', NativeMobileAttachments:'true' } : {}),
                ...toolHandoff?.env,
                ...(streamInterrupt ? { EnableRoleDivider:String(streamInterrupt.roleDivider) } : {}),
                ...(hardwareStream ? { NativeMobileExecutionTimeoutMs:'300000', NativeMobileGroupIdleTimeoutMs:'300000' } : {}),
                NativeSyncFullSources:JSON.stringify(['A','B','C','D'].map(x=>({sourceId:'source'+x,deviceId:'device'+x,executionMode:'all-supported'}))),
                NativeSyncSharedSpaces:JSON.stringify([{id:'sharedAB',sources:['sourceA','sourceB','sourceC']},{id:'foreignSpace',sources:['sourceD']}])
            }
        });
        fs.closeSync(log);
        backendError = null;
        exit = new Promise(resolve => {
            backend.once('exit', (code, signal) => resolve({ code, signal }));
            backend.once('error', error => { backendError = error; resolve({ error: error.message }); });
        });
    }
    let backendError;
    async function stopBackend(signal) {
        if (backend.exitCode === null && backend.signalCode === null) backend.kill(signal);
        let timer;
        let outcome;
        try { outcome = await Promise.race([exit, new Promise(resolve => { timer = setTimeout(resolve,4500); })]); }
        finally { clearTimeout(timer); }
        if (!outcome) backend.kill('SIGKILL');
        const stopped = outcome || await exit;
        trace('backend-exit',stopped);
        return stopped;
    }
    async function close() {
        releaseLost();
        toolHandoff?.receipt?.releaseProvider?.();
        hardwareStream?.provider.close();
        if (activePartial && !activePartial.destroyed) activePartial.destroy();
        const stopped = await stopBackend('SIGTERM');
        await closeServer(proxy);
        await closeServer(provider);
        return stopped;
    }
    async function startBackend() {
        const log = path.join(out, 'backend.log');
        const offset = fs.existsSync(log) ? fs.statSync(log).size : 0;
        launchBackend();
        await waitUntil(() => {
            if (backendError) throw backendError;
            if (backend.exitCode!==null) throw Error('Backend exited '+backend.exitCode);
            const startup = fs.readFileSync(log).subarray(offset).toString('utf8');
            if (startup.includes('Error initializing module for NativeSync')) {
                throw Error('ToolBox failed to initialize NativeSync. See backend.log in the run evidence directory.');
            }
            return startup.includes('中间层服务器正在监听端口 ' + backendPort);
        },'real backend listening',25000);
    }
    let startupError;
    try {
        try { await startBackend(); }
        catch (error) { startupError = error; }
        if (expectedStartupError) assert.match(startupError?.message || '', expectedStartupError);
        else if (startupError) throw startupError;
    } catch (error) { await close(); throw error; }
    const origin = 'https://127.0.0.1:' + proxyPort;
    const requestMobile = route => new Promise((resolve, reject) => {
        const request = https.get(origin + route, { ca: fs.readFileSync(ca), timeout: 2000 }, response => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('error', reject);
            response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }));
        });
        request.on('timeout', () => request.destroy(Error('Mobile request timed out')));
        request.on('error', reject);
    });
    async function checkMobile() {
        const page = await waitUntil(async () => {
            const value = await requestMobile('/mobile/');
            return value.status === 200 && value;
        }, 'HTTPS mobile page', 15000);
        const script = page.body.match(/<script[^>]+src="([^"]+\.js)"/)?.[1];
        assert.ok(script, 'mobile HTML loads its built frontend');
        const scriptUrl = new URL(script, origin + '/mobile/');
        assert.equal(scriptUrl.origin, origin);
        const bundle = await requestMobile(scriptUrl.pathname);
        assert.equal(bundle.status, 200);
        assert.ok(bundle.body.length > 1000, 'mobile JavaScript bundle is served');
        const connection = await requestMobile('/mobile/api/connection');
        assert.equal(connection.status, 200);
        assert.equal(typeof JSON.parse(connection.body), 'object');
        return { htmlStatus: page.status, bundleStatus: bundle.status, connectionStatus: connection.status };
    }
    return { checkMobile, startupError, get backendPid(){return backend.pid;},
        ...((mode==='core-rc' || independentCore || ordinaryTools || delegation || groupRelay || toolHandoff?.finalReceipt || toolHandoff?.duo) && { async restartAfterCrash() {
            const crashed = await stopBackend('SIGKILL');
            assert.deepEqual(crashed, {code:null,signal:'SIGKILL'});
            await startBackend();
            return crashed;
        }, async restartWithUpgrade(beforeStart) {
            const stopped = await stopBackend('SIGTERM');
            await beforeStart?.();
            await startBackend();
            return stopped;
        }}), origin:'https://127.0.0.1:'+proxyPort,wsOrigin:'http://127.0.0.1:'+backendPort,calls,requests,topics:{preSubmit:source,lostAck:target,interrupted:stopTopic,...ordinaryTopics},descriptors,data,gates,streamInterrupt,
        disarmDrop(){drop=false;}, dropConfigOnce(name) { dropConfigName = name; }, releaseLost,
        cutPartial(){assert.ok(activePartial&&!activePartial.destroyed);gates.providerTransportCut=true;
            trace('actual-provider-socket-cut',{hadPrefix:true});activePartial.destroy();}, close};
}
module.exports={start,contract,coreInput};

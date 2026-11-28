'use strict';
const fs = require('node:fs');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');

const completeText = '合成回复完成。';
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
async function start({ out, candidate, cert, key, trace, waitUntil, mode, httpsPort = 0, handleFixtureRequest, coreRemote, enforceBudget = false }) {
    const sourceApp = path.join(candidate, 'apps/server');
    const box = path.join(out, 'runtime-box');
    fs.mkdirSync(box);
    fs.mkdirSync(path.join(box, 'Plugin'));
    fs.mkdirSync(path.join(out, 'empty-diaries'));

    // Stage only versioned server files. The synthetic DB and plugin config live in this run.
    const tracked = execFileSync('git', ['ls-files','-z','--','apps/server/'], { cwd: candidate });
    const excluded = /(?:^|\/)(?:node_modules|DebugLog|logs|TVDaily|dailynote|file|image|Agent|VectorStore|\.file_cache)(?:\/|$)|(?:^|\/)(?:config\.env|\.env(?:\..*)?)(?:$|\/)|\.(?:pem|key|p12|pfx)$/i;
    for (const entry of tracked.toString().split('\0').filter(Boolean)) {
        const rel = entry.slice('apps/server/'.length);
        if (excluded.test(rel)) continue;
        if (rel.startsWith('Plugin/') && !rel.startsWith('Plugin/NativeSync/') &&
            rel !== 'Plugin/RAGDiaryPlugin/MessageContentUtils.js' &&
            !/^Plugin\/(?:VCPSleep|AgentAssistant)\/(?!plugin-manifest)/.test(rel)) continue;
        const file = path.join(sourceApp, rel);
        if (!fs.existsSync(file) || !fs.lstatSync(file).isFile()) continue;
        const staged = path.join(box, rel);
        fs.mkdirSync(path.dirname(staged), { recursive: true });
        fs.copyFileSync(file, staged);
    }
    const nativeAddon = 'rust-vexus-lite/vexus-lite.linux-x64-gnu.node';
    const builtAddon = path.join(sourceApp, nativeAddon);
    if (!fs.existsSync(builtAddon)) {
        throw Error('Vexus addon missing. Build the server native addon before integration.');
    }
    fs.copyFileSync(builtAddon, path.join(box, nativeAddon));
    const pluginPath = 'Plugin/NativeSync';
    const builtMobile = path.join(sourceApp, pluginPath, 'mobile-dist');
    if (!fs.existsSync(path.join(builtMobile, 'index.html'))) {
        throw Error('Mobile build missing. Run the repository build before integration.');
    }
    fs.cpSync(builtMobile, path.join(box, pluginPath, 'mobile-dist'), { recursive: true });
    for (const [from, to] of [[path.join(sourceApp, 'node_modules'), path.join(box, 'node_modules')],
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
    const descriptor = { itemType: 'agent', itemId: 'local-agent', topicId: 'local-topic' };
    const { mapTopic } = require('../../apps/desktop/modules/services/localCoreRuntime');
    const source = { id: mapTopic(descriptor).sharedId };
    const descriptors = { A: { preSubmit: descriptor }, B: { preSubmit: descriptor } };
    const data = path.join(out, 'data');
    fs.mkdirSync(data);
    const calls = [], requests = [];
    let releaseLost;
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
            const which = input === (coreRemote?.input || coreInput) ? 'coreRC' : undefined;
            const row = { case: which, id: body.requestId, stream: Boolean(body.stream), at: Date.now() };
            calls.push(row);
            trace('provider', row);
            if (coreRemote?.groupPreviewReply) return coreRemote.groupPreviewReply(body, res);
            if (which === 'coreRC') await lostGate;
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
            const payload={id:'fixture-'+calls.length,object:'chat.completion',created:1,model:'synthetic',choices:[{index:0,message:{role:'assistant',content:completeText},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}};
            res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(payload));
        } catch(e) { calls.push({case:'fixtureError',error:e.message}); if(!res.headersSent)res.writeHead(500);res.end(); }
    });
    const providerPort = await listen(provider);
    const dummy = net.createServer();
    const backendPort = await listen(dummy);
    await closeServer(dummy);
    const proxy = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, async (req, res) => {
        const route = new URL(req.url, 'https://127.0.0.1').pathname;
        if (handleFixtureRequest && await handleFixtureRequest(req, res, route)) return;
        const upstream = http.request({
            host: '127.0.0.1', port: backendPort, path: req.url, method: req.method,
            headers: { ...req.headers, 'x-forwarded-proto': 'https' }
        }, response => {
            if (route === '/mobile/api/pair') trace('mobile-pair-http', {
                status: response.statusCode, sameOrigin: req.headers.origin === 'https://' + req.headers.host,
                originPresent: Boolean(req.headers.origin), nullOrigin: req.headers.origin === 'null',
                firefox: /Firefox/.test(req.headers['user-agent'] || '')
            });
            requests.push({ route, method: req.method, status: response.statusCode });
            res.writeHead(response.statusCode, response.headers);
            response.pipe(res);
        });
        upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
        res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
        req.pipe(upstream);
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
        backend = spawn(node, ['--require', path.join(__dirname, 'loopback.cjs'), 'server.js'], {
            cwd: box, stdio: ['ignore',log,log], env: {
                ...(process.env.NS_FIXTURE_POLL_WATCHERS === '1' && { CHOKIDAR_USEPOLLING:'true', NS_FIXTURE_POLL_WATCHERS:'1' }),
                VCP_CORE_DATA_DIR: path.join(out, 'core'), VCP_CORE_MODE: mode === 'core-remote' ? 'remote' : 'local',
                ...(coreRemote && { VCP_CORE_REMOTE_ORIGIN: 'https://127.0.0.1:' + proxyPort,
                    VCP_CORE_IMAGE_MODELS: JSON.stringify([coreRemote.model]) }),
                ...(enforceBudget && { ContextBudgetGuard: 'enforce' }),
                PATH:'/usr/bin:/bin',HOME:out,LANG:'C.UTF-8',TZ:'UTC',NS_LOADED_REPORT:path.join(out,'backend-loaded.json'),
                PORT:String(backendPort),VCP_LOCAL_LISTEN_HOST:'127.0.0.1',Key:auth,API_Key:'synthetic-provider',VCP_Key:'synthetic-sponsor-ws',
                API_URL:'http://127.0.0.1:'+providerPort,ApiRetries:'1',MaxVCPLoopNonStream:'4',MaxVCPLoopStream:'4',
                KNOWLEDGEBASE_ROOT_PATH:path.join(out,'empty-diaries'),KNOWLEDGEBASE_STORE_PATH:path.join(data,'vectors'),
                KNOWLEDGEBASE_FULL_SCAN_ON_STARTUP:'false',TDB_KNOWLEDGE_ENABLED:'false'
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
            return startup.includes('中间层服务器正在监听端口 ' + backendPort);
        },'real backend listening',25000);
    }
    try { await startBackend(); }
    catch (error) { await close(); throw error; }
    const origin = 'https://127.0.0.1:' + proxyPort;
    const requestMobile = route => new Promise((resolve, reject) => {
        const request = https.get(origin + route, { ca: fs.readFileSync(cert), timeout: 2000 }, response => {
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
    return {
        checkMobile, origin, wsOrigin: 'http://127.0.0.1:' + backendPort, calls, requests,
        topics: { preSubmit: source }, descriptors, data, releaseLost, close,
        async restartWithUpgrade(beforeStart) {
            const stopped = await stopBackend('SIGTERM');
            await beforeStart?.();
            await startBackend();
            return stopped;
        }
    };
}
module.exports = { start, coreInput, completeText };

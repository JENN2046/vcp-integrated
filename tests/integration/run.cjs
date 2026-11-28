'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { X509Certificate } = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');
const path = require('node:path');
const readline = require('node:readline');
const { once } = require('node:events');
const os = require('node:os');
const { setTimeout: delay } = require('node:timers/promises');

const here = __dirname;
const candidate = path.resolve(here, '../..');
const host = path.join(candidate, 'apps/desktop');
const { createRequire } = require('node:module');
const requested = process.argv[2] || 'all';
if (process.platform !== 'linux' || process.arch !== 'x64' || process.versions.node.split('.')[0] !== '24') {
    throw Error('Integration requires Linux x64 and Node 24');
}
if (!['all', 'core-local', 'core-remote', 'desktop-stream-close'].includes(requested) || process.argv.length > 3) {
    throw Error('Usage: node tests/integration/run.cjs [core-local|core-remote|desktop-stream-close]');
}
let out, cert, fingerprint, display, remoteFixture;
const desktopRequire = createRequire(path.join(host, 'package.json'));
const executable = process.env.ELECTRON_BIN || desktopRequire('electron');

async function isolatedDisplay(root) {
    const binary = process.env.XVFB_BIN || 'Xvfb';
    const server = spawn(binary, ['-displayfd', '1', '-screen', '0', '1600x1100x24', '-nolisten', 'tcp'], {
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stderr.pipe(fs.createWriteStream(path.join(root, 'xvfb.log')));
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.once('exit', code => reject(Error('Xvfb exited (' + code + ')')));
        readline.createInterface({ input: server.stdout }).once('line', line => {
            if (!/^\d+$/.test(line)) reject(Error('Invalid display number from Xvfb'));
            else { display = ':' + line; resolve(); }
        });
    });
    return server;
}

function trace(event, data) {
    fs.appendFileSync(path.join(out, 'events.jsonl'), JSON.stringify({ event, t: Date.now(), data }) + '\n');
}
function launch(profile, role, mode) {
    const home = path.join(out, 'home-' + path.basename(profile));
    fs.mkdirSync(home, { recursive: true });
    const env = { HOME:home, XDG_CONFIG_HOME:home+'/config', XDG_CACHE_HOME:home+'/cache',
        PATH:'/usr/bin:/bin', LANG:'C.UTF-8', DISPLAY:display,
        NS_HOST: host, VCPCHAT_APP_DATA_DIR: profile, VCPCHAT_E2E_TEST: '1',
        NODE_EXTRA_CA_CERTS: cert, NS_CERT_FINGERPRINT: fingerprint,
        ...(mode === 'core-local' && { VCPCHAT_LOCAL_CORE_WORKSPACE: 'personal' }),
        ...(mode === 'desktop-stream-close' && { NS_DESKTOP_STREAM_CLOSE: '1' }),
        ...(mode === 'core-remote' && { VCPCHAT_CORE_REMOTE_ORIGIN: remoteFixture.origin,
            VCPCHAT_CORE_DEVICE_TOKEN: remoteFixture.tokens[role], NS_CORE_TEST_IMAGE: remoteFixture.image })
    };
    const args = ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1', '--disable-background-networking', '--ozone-platform=x11', '--disable-gpu', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', path.join(here, './electron.cjs')];
    const proc = spawn(executable, args, { cwd: host, env, detached: true, stdio: ['pipe','pipe','pipe'] });
    const log = fs.createWriteStream(path.join(out, role + '.log'));
    const calls = new Map();
    const events = [];
    let ended;
    const exit = new Promise(resolve => {
      proc.once('error', error => { trace(role + ':spawn-error', {message:error.message}); resolve(ended = {code:null,signal:null,error:error.message}); });
      proc.once('exit', (code, signal) => {
        trace(role + ':process-exit', { code, signal });
        for (const answer of calls.values()) answer.reject(Error('Electron exited'));
        calls.clear();
        resolve(ended = { code, signal });
      });
    });
    proc.stdin.on('error', () => {});
    proc.stderr.pipe(log, { end: false });
    readline.createInterface({ input: proc.stdout }).on('line', line => {
        log.write(line + '\n');
        if (!line.startsWith('NS_MEASURE ')) return;
        const value = JSON.parse(line.slice('NS_MEASURE '.length));
        events.push(value);
        if (value.event !== 'answer') trace(role + ':' + value.event, { ...value.data, sourceMs: value.t });
        if (value.event === 'answer') {
            const answer = calls.get(value.data.id);
            calls.delete(value.data.id);
            if (value.data.error) answer?.reject(Error(value.data.error));
            else answer?.resolve(value.data.result);
        }
    }).on('close', () => log.end());
    let sequence = 0;
    return { events, proc, exit, get ended() { return ended; }, command(action, script) {
        return new Promise((resolve, reject) => {
            const id = ++sequence;
            const timer = setTimeout(() => { calls.delete(id); reject(Error('Electron command timed out: ' + action)); }, action === 'picture' ? 20000 : 7000);
            calls.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
            proc.stdin.write(JSON.stringify({ id, action, script }) + '\n');
        });
    }};
}

async function waitUntil(fn, name, ms = 30000) {
    const end = Date.now() + ms;
    do {
        const result = await fn();
        if (result) return result;
        await delay(30);
    } while (Date.now() < end);
    throw Error('Timed out: ' + name);
}

const assert = require('node:assert/strict');
const json = JSON.stringify;
const read = f => JSON.parse(fs.readFileSync(f, 'utf8'));
function evalJs(client, script) { return client.command('eval', script); }
async function click(client, selector, name) {
    const point = await waitUntil(() => evalJs(client,`(() => {
        const el=[...document.querySelectorAll(${json(selector)})].find(node=> node.checkVisibility() && ${name === undefined ? 'true' : `node.innerText.trim() === ${json(name)}`});
        if (!el) return false;
        el.scrollIntoView({block:'center', behavior:'instant'});
        const r=el.getBoundingClientRect();
        const x=Math.round(r.midX ?? (r.left + r.width/2)), y=Math.round(r.top+r.height/2);
        const hit=document.elementFromPoint(x,y);
        return el.contains(hit) ? {x,y} : false;
    })()`), [selector,name].join(' '), 5500);
    return client.command('mouse', point);
}
const { createHash } = require('node:crypto');
const picture = (client, file) => client.command('picture', path.join(out, file+'.png'));
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function runCase(root, mode) {
    out = path.join(root, mode);
    fs.mkdirSync(out, { mode: 0o700 });
    const coreRemote = mode === 'core-remote';
    const nativeDesktop = mode === 'desktop-stream-close' ? require('../desktop-stream-close/fixture.cjs').create() : null;
    cert = path.join(out, 'loopback-cert.pem');
    const key = path.join(out, 'loopback-key.pem');
    execFileSync('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-days','1',
        '-subj','/CN=Core isolated fixture','-addext','subjectAltName=IP:127.0.0.1',
        '-keyout',key,'-out',cert], { env: { PATH: '/usr/bin:/bin' }, stdio: 'ignore' });
    let service;
    try {
        remoteFixture = coreRemote ? await require('./core-remote.cjs').create(out, cert) : null;
        service = await (nativeDesktop || require('./service.cjs')).start({
            out, candidate, cert, key, trace, waitUntil, mode, ...remoteFixture?.serviceOptions
        });
    } finally { fs.rmSync(key, { force: true }); }
    fingerprint = new X509Certificate(fs.readFileSync(cert)).fingerprint256;
    if (remoteFixture) await remoteFixture.pairDesktops(service);
    const clients = {};
    const profiles = {};
    const result = { candidate, mode, origin: service.origin, exits:{}, failures:[] };
    const start = async (role, profileRole = role) => {
        const client = clients[role] = launch(profiles[profileRole], role, mode);
        await waitUntil(() => {
            if (client.ended) throw Error(role + ' Electron exited during startup: ' + JSON.stringify(client.ended));
            return client.events.some(e => e.event === 'renderer-ready');
        }, role + ' renderer ready');
        assert(client.events.some(e=>e.event==='electron-ready' && e.data.sandbox && e.data.version===desktopRequire('electron/package.json').version));
        const cds = await waitUntil(async () => {
            try {
                const lock=read(path.join(profiles[profileRole],'databases/chat_data_service.lock'));
                const exe=await fsp.readlink('/proc/'+lock.pid+'/exe');
                if (exe.endsWith('/vcp_chat_data_service')) return {pid:lock.pid,sha256:sha(exe)};
            } catch(e) { if(e.code!=='ENOENT') throw e; }
        }, role+' C1 CDS', 9000);
        assert.equal(cds.sha256, sha(path.join(host, 'modules/services/chatDataService/bin/linux-x64/vcp_chat_data_service')));
        result[role]={electron:desktopRequire('electron/package.json').version,sandbox:true,cds,profileDigest:createHash('sha256').update(profiles[profileRole]).digest('hex')};
        await client.command('trace');
        return client;
    };
    const stop = async role => {
        const client = clients[role];
        if (!client.ended) await client.command('quit').catch(()=>{});
        let value = client.ended || await Promise.race([client.exit, delay(6000, null, { ref:false })]);
        if (!value) {
            process.kill(-client.proc.pid, 'SIGTERM');
            value = await Promise.race([client.exit, delay(3000, null, { ref:false })]);
        }
        if (!value) {
            process.kill(-client.proc.pid, 'SIGKILL');
            value = await client.exit;
        }
        result.exits[role] = value;
        delete clients[role];
        assert(client.events.some(event=>event.event==='electron-quit'),'Electron normal quit hook');
        if (result[role]?.cds) assert.equal(fs.existsSync(path.join('/proc',String(result[role].cds.pid))),false,'C1 CDS child exited');
        assert.deepEqual(result.exits[role],{code:0,signal:null});
    };
    try {
        const roles = nativeDesktop ? ['A','B','C'] : ['A','B'];
        for (const role of roles) {
            const profile = profiles[role] = path.join(out, 'profile-' + role);
            const write = (rel, obj) => {
                const file = path.join(profile, rel);
                fs.mkdirSync(path.dirname(file), { recursive: true });
                fs.writeFileSync(file, json(obj));
            };
            write('settings.json', {
                vcpApiKey: 'synthetic-only', disableAsana: true, disableUpdateCheck: true,
                ChatDataServiceEnabled: true, ChatDataServiceNotifyEnabled: false, ChatDataServiceTantivyEnabled: false,
                vcpServerUrl: service.origin + (nativeDesktop ? '/v1/local-chat/completions' : '/v1/chat/completions'),
                ...(nativeDesktop && { enableVcpToolInjection: false, enableContextCompaction: false }),
                userName: '用户', voiceMode: 'local', voiceLocalSettings: { sovitsUrl: service.origin },
                enableDistributedServer: false, vcpLogUrl: service.wsOrigin, vcpLogKey: 'synthetic-sponsor-ws'
            });
            if (!coreRemote || role === 'A') {
                write('Agents/local-agent/config.json', {
                    id: 'local-agent', name: 'Synthetic local', model: remoteFixture?.model || 'synthetic',
                    systemPrompt: coreRemote ? 'Reply in one short sentence.' : 'Synthetic test', streamOutput: Boolean(nativeDesktop || coreRemote),
                    topics: [{ id: 'local-topic', name: 'Local topic', createdAt: 1 }], current_topic_id: 'local-topic'
                });
                write('UserData/local-agent/topics/local-topic/history.json', []);
            }
        }
        await Promise.all(roles.map(role => start(role)));
        const runScenario = nativeDesktop ? require('../desktop-stream-close/scenario.cjs') :
            remoteFixture?.run || require('./core-rc.cjs');
        await runScenario({ clients: { ...clients }, cert, out, result, picture, click, evalJs, waitUntil, sha, trace,
            service, stop, start, profiles, desktopStreamClose: nativeDesktop });
    } catch(error) {
        result.failures.push(error.stack);
        for (const [role,client] of Object.entries(clients)) {
            try {
                await picture(client,'failure-'+role);
            } catch {}
        }
    } finally {
        for (const role of Object.keys(clients)) {
            try { await stop(role); } catch(error) { result.failures.push(error.stack); }
        }
        if (nativeDesktop) {
            await service.close();
            result.failures.push(...service.errors);
        } else {
            result.provider = service.calls;
            result.requests = service.requests;
            result.exits.backend = await service.close();
            try {
                assert.deepEqual(result.exits.backend, { code: 0, signal: null });
                const loaded = read(path.join(out, 'backend-loaded.json'));
                for (const row of loaded) assert.equal(row.sha256, sha(path.join(candidate, row.file)), row.file);
                assert.ok(loaded.length >= 9, 'required loaded backend source files');
                assert.ok(loaded.some(row => row.file === 'apps/server/core/localWorkspace.js'));
                assert.ok(!loaded.some(row => row.file === 'apps/server/Plugin/NativeSync/native-sync.js'));
                (result.core ||= {}).nativeSyncLoaded = false;
                result.backendSources = loaded;
                assert.equal(result.provider.filter(call => call.case === 'fixtureError').length, 0);
            } catch (error) { result.failures.push(error.stack); }
        }
        fs.writeFileSync(path.join(out,'evidence.json'),JSON.stringify(result,null,2)+'\n');
        for (const name of ['runtime-box','node_modules']) fs.rmSync(path.join(out, name), { recursive: true, force: true });
        assert.deepEqual(result.failures,[]);
        console.log(mode + ' PASS ' + path.join(out, 'evidence.json'));
    }
}

async function main() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-integration-'));
    console.log('Isolated integration evidence ' + root);
    const xvfb = await isolatedDisplay(root);
    try {
        for (const mode of requested === 'all' ? ['core-local','core-remote'] : [requested]) await runCase(root, mode);
    } finally {
        if (xvfb && xvfb.exitCode === null && xvfb.signalCode === null) {
            const exited = once(xvfb, 'exit');
            xvfb.kill();
            await exited;
        }
    }
}
main().catch(error=>{console.error(error);process.exitCode=1;});

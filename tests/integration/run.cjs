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
const modes = ['lost-only', 'transport-only', 'pre-only', 'local-only', 'config-only', 'shutdown-only'];
const requested = process.argv[2] || 'all';
const ordinaryModes = { 'ordinary-shared': 'pre-only', 'ordinary-local': 'local-only' };
const ordinaryMode = Object.hasOwn(ordinaryModes, requested) ? ordinaryModes[requested] : undefined;
const nativeQueue = requested === 'native-local-queue' ? require('../group-extra/local.cjs') : undefined;
const aaDesktop = requested === 'aa-desktop';
const desktopStreamClose = requested === 'desktop-stream-close' ? require('../desktop-stream-close/fixture.cjs').create() : undefined;
const streamInterrupt = requested === 'local-stream-interrupt' ? require('../local-stream-interrupt/fixture.cjs') : undefined;
const finalReceiptModes = { 'tool-final-receipt-lost': 'terminal', 'tool-final-receipt-unknown': 'unknown', 'tool-final-readback-terminal-lost': 'terminal' };
const readbackModes = ['tool-final-readback-json', 'tool-final-readback-stream',
    'tool-final-readback-terminal-lost', 'tool-final-readback-query-lost',
    'tool-final-readback-json-delete', 'tool-final-readback-stream-edit'];
const legacyReadbackMode = 'tool-final-readback-legacy';
const beforeFinalReadback = 'aa19a637831c1a7fabd3ec0de858d08084097ef7';
const duoModes = ['tool-duo-baseline-returned', 'tool-duo-baseline-unknown', 'tool-duo-returned', 'tool-duo-returned-stream', 'tool-duo-unknown'];
const compactionAckMode = 'compact-fallback-ack';
const toolHandoffModes = [...duoModes, compactionAckMode, 'tool-handoff-baseline', 'tool-handoff', 'tool-handoff-unknown', 'tool-handoff-stream',
    'tool-final-publication-ack', legacyReadbackMode, ...new Set([...readbackModes, ...Object.keys(finalReceiptModes)])];
const toolHandoffMode = toolHandoffModes.includes(requested) ? requested : undefined;
const toolHandoffFixture = toolHandoffMode && require('../tool-work-handoff/fixture.cjs');
const compactionRetryMode = 'compact-history-identity';
const crossDeviceCompaction = ['compact-cross-device', compactionRetryMode].includes(requested);
const compactionFallbackModes = ['compact-fallback-404', 'compact-fallback-401', 'compact-fallback-403',
    'compact-fallback-unknown', 'compact-fallback-history'];
const compactionFallbackMode = compactionFallbackModes.includes(requested);
const compaction = requested === 'compact-e2e' || crossDeviceCompaction || compactionFallbackMode
    ? require('../compact-e2e/fixture.cjs') : undefined;
const compactionFallback = compactionFallbackMode ? require('../compact-e2e/fallback.cjs').create(requested, compaction) : undefined;
const approvalRestoreModes = { 'approval-restore': 'desktop', 'approval-restore-stale': 'stale' };
const approvalRestore = Object.hasOwn(approvalRestoreModes, requested) ? approvalRestoreModes[requested] : undefined;
const serverRevision = requested === legacyReadbackMode ? beforeFinalReadback :
    requested === 'tool-final-publication-ack' ? process.env.NS_BASELINE_SERVER_REVISION || beforeFinalReadback :
    ordinaryMode || approvalRestore || toolHandoffMode ? process.env.NS_BASELINE_SERVER_REVISION : undefined;
if (serverRevision && !/^[a-f0-9]{40}$/.test(serverRevision)) throw Error('Expected full Git revision for baseline server');
const ordinaryTools = require('../ordinary-tools/fixture.cjs');
const ordinaryFixture = ordinaryMode || approvalRestore ? {
    ...ordinaryTools,
    ...(approvalRestore === 'stale' && process.env.NS_EXPIRE_APPROVAL === '1' && { stage(box) {
        ordinaryTools.stage(box);
        const file = path.join(box, 'toolApprovalConfig.json');
        fs.writeFileSync(file, JSON.stringify({ ...read(file), timeoutMinutes: 0.3 }));
    } }),
    ...(process.env.NS_DROP_APPROVAL_RECEIPT === '1' && { lostReceiptMarker: 'ORDINARY_TOOL_APPROVE' }),
} : crossDeviceCompaction ? {
    stage: ordinaryTools.stage, reply: ordinaryTools.reply, lostReceiptMarker: compaction.toolInput,
} : undefined;
if (process.platform !== 'linux' || process.arch !== 'x64' || process.versions.node.split('.')[0] !== '24') {
    throw Error('Integration requires Linux x64 and Node 24');
}
if (![...modes, ...toolHandoffModes, ...Object.keys(ordinaryModes), ...Object.keys(approvalRestoreModes), 'all', 'ready', 'core-rc', 'core-local', '--dev', 'idle', 'aa-desktop', 'native-local-queue', 'compact-e2e', 'compact-cross-device', compactionRetryMode, ...compactionFallbackModes, 'local-stream-interrupt', 'desktop-stream-close'].includes(requested) || process.argv.length > 3) {
    throw Error('Usage: node tests/integration/run.cjs [all|lost-only|transport-only|pre-only|local-only|ready|--dev|idle|config-only|shutdown-only|ordinary-shared|ordinary-local|approval-restore|approval-restore-stale|aa-desktop|native-local-queue|compact-e2e|compact-cross-device|compact-history-identity|' + duoModes.join('|') + '|' + [compactionAckMode, ...compactionFallbackModes].join('|') + '|tool-handoff-baseline|tool-handoff|tool-handoff-unknown|tool-handoff-stream|tool-final-receipt-lost|tool-final-receipt-unknown|tool-final-publication-ack|' + [...readbackModes, legacyReadbackMode].join('|') + '|local-stream-interrupt|desktop-stream-close]');
}
let out, cert, fingerprint, display;
const desktopRequire = createRequire(path.join(host, 'package.json'));
const executable = process.env.ELECTRON_BIN || desktopRequire('electron');
// An interactive developer can opt into a local X11 display while both
// Electron instances keep their disposable profiles and loopback-only network.
const devDisplay = requested === '--dev' ? process.env.VCP_DEV_DISPLAY : undefined;
if (devDisplay && !/^:\d+(?:\.\d+)?$/.test(devDisplay)) throw Error('VCP_DEV_DISPLAY must name a local X11 display');

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
        ...(devDisplay && process.env.XAUTHORITY ? { XAUTHORITY: process.env.XAUTHORITY } : {}),
        NS_HOST: host, VCPCHAT_APP_DATA_DIR: profile, VCPCHAT_E2E_TEST: '1',
        NODE_EXTRA_CA_CERTS: cert, NS_CERT_FINGERPRINT: fingerprint,
        ...(mode === compactionRetryMode && role === 'A' ? { NS_COMPACTION_HISTORY_RACE: '1' } : {}),
        ...((compactionFallbackMode || mode === compactionAckMode) && { NS_COMPACTION_FALLBACK_FIXTURE:'1' }),
        ...(mode === 'idle' && process.env.NS_IDLE_METER !== 'off' ? { NS_METER_PREFIX: path.join(out, role) } : {}),
        ...(mode === 'core-local' ? { VCPCHAT_LOCAL_CORE_WORKSPACE: 'personal' } : {}),
        ...(mode === 'shutdown-only' ? { NS_CHECK_QUIT_ADMISSION: '1' } : {}),
        ...(desktopStreamClose ? { NS_DESKTOP_STREAM_CLOSE: '1' } : {}) };
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
const scenario=require('./scenario.cjs');
const { restoreProfile }=require('./profile.cjs');
async function runCase(root, mode) {
    out = path.join(root, mode);
    fs.mkdirSync(out, { mode: 0o700 });
    let service, aa;
    const toolHandoff = toolHandoffFixture?.create(out, {
        duo: duoModes.includes(mode),
        loseCompactionAck: mode === compactionAckMode,
        duoBaseline: mode.startsWith('tool-duo-baseline-'),
        unknown: ['tool-duo-baseline-unknown', 'tool-duo-unknown', 'tool-handoff-unknown'].includes(mode),
        loseHandoff: [compactionAckMode, 'tool-duo-returned', 'tool-duo-returned-stream', 'tool-handoff', 'tool-handoff-stream', 'tool-final-publication-ack', legacyReadbackMode].includes(mode) ||
            readbackModes.includes(mode) || Boolean(finalReceiptModes[mode]),
        losePublication: mode === 'tool-final-publication-ack',
        readback: readbackModes.includes(mode),
        loseReadback: mode === 'tool-final-readback-query-lost',
        legacyReadback: mode === legacyReadbackMode,
        finalMutation: { 'tool-final-readback-json-delete': 'delete', 'tool-final-readback-stream-edit': 'upsert' }[mode],
        stream: ['tool-duo-returned-stream', 'tool-handoff-stream', 'tool-final-readback-stream', 'tool-final-readback-stream-edit'].includes(mode) ||
            (finalReceiptModes[mode] === 'terminal' && process.env.VCP_TEST_FINAL_STREAM === '1'),
        finalReceipt: finalReceiptModes[mode],
    });
    const groupRelay = nativeQueue?.createProvider();
    if (aaDesktop) {
        aa = await require('../aa-delegation/fixture.cjs').startFixture({out, candidate, trace, mode: 'pre-only'});
        ({service, cert} = aa);
    } else {
        cert = path.join(out, 'loopback-cert.pem');
        const key = path.join(out, 'loopback-key.pem');
        execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
            '-subj', '/CN=NativeSync isolated fixture', '-addext', 'subjectAltName=IP:127.0.0.1',
            '-keyout', key, '-out', cert], { env: { PATH: '/usr/bin:/bin' }, stdio: 'ignore' });
        try {
            service = await (desktopStreamClose || require('./service.cjs')).start({
                out, candidate, cert, key, trace, waitUntil, mode, ordinaryTools: ordinaryFixture, serverRevision, groupRelay, toolHandoff,
                observedContext: toolHandoff?.observed || compactionFallback?.observe(out) || compaction?.observe(out, crossDeviceCompaction), streamInterrupt: streamInterrupt?.observe(out),
            });
        } finally { fs.rmSync(key, { force: true }); }
    }
    fingerprint = new X509Certificate(fs.readFileSync(cert)).fingerprint256;
    const clients = {};
    const profiles = {};
    const result = { candidate, mode, ...(serverRevision && {serverRevision}), origin: service.origin, exits:{}, failures:[] };
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
    const groupMembers = pgid => execFileSync('ps', ['-e', '-o', 'pid=,pgid=,stat='], { encoding: 'utf8' })
        .trim().split('\n').map(row => row.trim().split(/\s+/))
        .filter(([, group, stat]) => Number(group) === pgid && !stat.startsWith('Z'));
    const isLive = pid => {
        try {
            const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
            return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            return false;
        }
    };
    const crash = async role => {
        const client = clients[role];
        const cdsPid = result[role].cds.pid;
        client.proc.kill('SIGKILL');
        result.exits[role] = await client.exit;
        delete clients[role];
        assert.deepEqual(result.exits[role], { code:null, signal:'SIGKILL' });
        assert.equal(client.events.some(event => event.event === 'runtime-close-end'), false);
        try {
            await waitUntil(() => !isLive(cdsPid) && !groupMembers(client.proc.pid).length,
                'crashed Electron group and CDS exit', 10000);
        } finally {
            if (groupMembers(client.proc.pid).length) process.kill(-client.proc.pid, 'SIGKILL');
        }
        return { electronPid:client.proc.pid, cdsPid, liveGroupMembers:groupMembers(client.proc.pid).length };
    };
    const quitBeforeFinalReceipt = async role => {
        const client = clients[role];
        const electronPid = client.proc.pid;
        const cdsPid = result[role].cds.pid;
        void client.command('quit').catch(() => {});
        const exited = await Promise.race([client.exit, delay(7500, null, { ref:false })]);
        if (!exited) return { normalExit: false, ...await crash(role) };
        result.exits[role] = exited;
        delete clients[role];
        assert.deepEqual(exited, { code:0, signal:null });
        assert.ok(client.events.some(event => event.event === 'runtime-close-end'));
        assert.ok(client.events.some(event => event.event === 'electron-quit'));
        await waitUntil(() => !isLive(cdsPid) && !groupMembers(electronPid).length, 'Electron and CDS exit after normal quit');
        return { normalExit: true, electronPid, cdsPid, liveGroupMembers: 0 };
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
        if(!desktopStreamClose && mode !== 'core-local' && !(mode === 'idle' && result.disabledBeforeMeasurement) && (mode!=='local-only'||role==='B')) assert(client.events.some(event=>event.event==='runtime-close-end'),'NativeSync normal close');
        assert(client.events.some(event=>event.event==='electron-quit'),'Electron normal quit hook');
        if (result[role]?.cds) assert.equal(fs.existsSync(path.join('/proc',String(result[role].cds.pid))),false,'C1 CDS child exited');
        assert.deepEqual(result.exits[role],{code:0,signal:null});
        if (mode === 'shutdown-only') {
            assert.ok(client.events.some(event => event.event === 'runtime-close-start' &&
                event.data?.admissionCode === 'APPLICATION_SHUTTING_DOWN'), 'new work rejected during runtime drain');
            await waitUntil(() => !groupMembers(client.proc.pid).length, role + ' process group drained', 10000);
        }
    };
    try {
        if (compaction) result.controlledTurns = await compaction.stage(service, out, crossDeviceCompaction);
        const roles = desktopStreamClose ? ['A', 'B', 'C'] : approvalRestore || aaDesktop || nativeQueue || (compaction && !crossDeviceCompaction) || streamInterrupt ? ['A'] : ['A', 'B'];
        for(const role of roles){
            const profile=profiles[role]=path.join(out,'profile-'+role);
            if (desktopStreamClose || mode==='core-local' || mode==='local-only' && role==='A') {
                const write=(rel,obj)=>{const file=path.join(profile,rel);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,json(obj));};
                write('settings.json',{vcpApiKey:'synthetic-only',disableAsana:true,disableUpdateCheck:true});
                write('Agents/local-agent/config.json',{id:'local-agent',name:'Synthetic local',model:'synthetic',systemPrompt:'Synthetic test',streamOutput:Boolean(desktopStreamClose),...streamInterrupt?.agent,topics:[{id:'local-topic',name:'Local topic',createdAt:1}],current_topic_id:'local-topic'});
                write('UserData/local-agent/topics/local-topic/history.json',[]);
                for (const speaker of nativeQueue?.agents || []) {
                    const id = 'local-group-' + speaker.toLowerCase();
                    write('Agents/' + id + '/config.json', {
                        id, name: 'Synthetic group ' + speaker, model: 'synthetic',
                        systemPrompt: nativeQueue.marker(speaker), streamOutput: false, topics: [],
                    });
                }
            } else await restoreProfile(path.join(out,'seed','desktop'+role),profile,service.origin,role);
            if (mode === 'idle') {
                const connectionFile = path.join(profile, '.native-sync/connection.json');
                fs.writeFileSync(connectionFile, json({ ...read(connectionFile), syncAttachments: true }));
            }
            const settingsFile=path.join(profile,'settings.json');
            fs.writeFileSync(settingsFile,json({...read(settingsFile),ChatDataServiceEnabled:true,ChatDataServiceNotifyEnabled:false,ChatDataServiceTantivyEnabled:false,vcpServerUrl:service.origin+((mode==='core-local'||compaction || toolHandoff)?'/v1/chat/completions':'/v1/local-chat/completions'),
                ...compaction?.settings,...compactionFallback?.settings,...toolHandoffFixture?.settings,...streamInterrupt?.settings,...(desktopStreamClose && { enableVcpToolInjection:false, enableContextCompaction:false }),userName:'用户',voiceMode:'local',voiceLocalSettings:{sovitsUrl:service.origin},enableDistributedServer:false,vcpLogUrl:service.wsOrigin,vcpLogKey:'synthetic-sponsor-ws'}));
        }
        const [A,B] = await Promise.all(roles.map(role => start(role)));
        if (mode!=='core-local' && !approvalRestore && !compaction && !streamInterrupt && !toolHandoff && !desktopStreamClose) {
            result.mobile = await service.checkMobile();
            if (mode !== 'idle') result.mobile.chromium = await A.command('mobile', service.origin + '/mobile/');
        }
        if (mode === '--dev' || mode === 'ready') {
            console.log('Isolated VCP ready at ' + service.origin + '/mobile/');
        }
        if (mode === '--dev') {
            await new Promise(resolve => {
                process.once('SIGINT', resolve);
                process.once('SIGTERM', resolve);
                A.exit.then(resolve);
                B.exit.then(resolve);
            });
        } else if (mode === 'idle') {
            await require('./idle.cjs').run({
                out, candidate, profiles, desktops: { A, B }, service, cert, result,
                start, stop, click, evalJs, waitUntil, sha,
            });
        } else if (mode !== 'ready') {
            const runScenario = ['core-rc','core-local'].includes(mode) ? require('./core-rc.cjs') : desktopStreamClose ? require('../desktop-stream-close/scenario.cjs') : toolHandoff ? require('../tool-work-handoff/scenario.cjs')
                : compaction ? require('../compact-e2e/scenario.cjs')
                : streamInterrupt ? require('../local-stream-interrupt/scenario.cjs')
                : aaDesktop ? require('../aa-desktop/scenario.cjs')
                : approvalRestore ? require('../approval-restore/' + approvalRestore + '.cjs')
                : nativeQueue ? nativeQueue.scenario
                : ordinaryMode ? require('../ordinary-desktop/scenario.cjs')
                : mode === 'config-only' ? require('./configuration.cjs') : scenario;
            await runScenario({clients:{...clients},cert,out,result,picture,click,evalJs,waitUntil,sha,trace,service,stop,start,profiles,crash,quitBeforeFinalReceipt,aa,groupRelay,toolHandoff,desktopStreamClose,compactionFallback});
        }
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
        if (desktopStreamClose) {
            await service.close();
            result.failures.push(...service.errors);
        } else {
            result.provider=service.calls;
            result.requests=service.requests;
            result.exits.backend = await (aa ? aa.close() : service.close());
            try { assert.deepEqual(result.exits.backend, {code:0,signal:null}); }
            catch (error) { result.failures.push(error.stack); }
            try {
                const loaded=read(path.join(out,'backend-loaded.json'));
                for (const row of loaded) {
                    const expectedSha = serverRevision
                        ? createHash('sha256').update(execFileSync('git', ['show', serverRevision + ':' + row.file], { cwd: candidate })).digest('hex')
                        : sha(path.join(candidate, row.file));
                    assert.equal(row.sha256, expectedSha, row.file);
                }
                assert.ok(loaded.length >= 9, 'required loaded backend source files');
                if (mode === 'core-local') {
                    assert.ok(loaded.some(row => row.file === 'apps/server/core/localWorkspace.js'));
                    assert.ok(!loaded.some(row => row.file === 'apps/server/Plugin/NativeSync/native-sync.js'));
                    result.core.nativeSyncLoaded = false;
                }
                result.backendSources=loaded;
            } catch(error) { result.failures.push(error.stack); }
            try {
                assert.equal(result.provider.filter(call => call.case === 'fixtureError' ||
                    call.phase === 'unexpected-desktop-local-provider').length, 0);
            } catch (error) { result.failures.push(error.stack); }
        }
        fs.writeFileSync(path.join(out,'evidence.json'),JSON.stringify(result,null,2)+'\n');
        const disposable = mode === 'idle'
            ? fs.readdirSync(out).filter(name => name !== 'evidence.json')
            : ['runtime-box', 'node_modules'];
        for (const name of disposable) fs.rmSync(path.join(out, name), { recursive: true, force: true });
        assert.deepEqual(result.failures,[]);
        console.log(mode + ' PASS ' + path.join(out, 'evidence.json'));
    }
}

async function main() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-integration-'));
    console.log('Isolated integration evidence ' + root);
    const xvfb = devDisplay ? null : await isolatedDisplay(root);
    if (devDisplay) display = devDisplay;
    try {
        for (const mode of requested === 'all' ? modes : [nativeQueue || streamInterrupt ? 'local-only' : ordinaryMode || requested]) await runCase(root, mode);
    } finally {
        if (xvfb && xvfb.exitCode === null && xvfb.signalCode === null) {
            const exited = once(xvfb, 'exit');
            xvfb.kill();
            await exited;
        }
    }
}
main().catch(error=>{console.error(error);process.exitCode=1;});

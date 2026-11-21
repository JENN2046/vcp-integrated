'use strict';

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { DatabaseSync } = require('node:sqlite');
const { execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const readline = require('node:readline');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '../..');
const integration = path.join(root, 'tests/integration');
const { start, contract } = require(path.join(integration, 'service.cjs'));
const args = process.argv.slice(2);
const hardware = args[0] === '--stream' ? (args.shift(), require('./stream.cjs')) : null;
const portText = args[0] === '--port' && args.length === 2 ? args[1] : null;
if ((args.length && !portText) || (portText && (!/^\d{4,5}$/.test(portText) || Number(portText) > 65535))) {
    throw Error('Usage: node tests/hardware/coordinator.cjs [--stream] [--port <loopback port>]');
}
const httpsPort = Number(portText || 18443);
const hardwareStream = hardware ? { seedCount:hardware.seedCount, seedHistory:hardware.seedHistory, provider:hardware.createStream() } : null;
const subject = hardware ? 'interrupted' : 'lostAck';
const runs = path.join(root, '.runs', 'hardware');
fs.mkdirSync(runs, { recursive:true, mode:0o700 });
const out = fs.mkdtempSync(path.join(runs, 'run-'));
const cert = path.join(out, 'loopback-cert.pem');
const key = path.join(out, 'loopback-key.pem');
const ca = path.join(out, 'hardware-ca.pem');
const caKey = path.join(out, 'hardware-ca.key');
const pairRoute = '/__hardware/pair';
const expectedHost = '127.0.0.1:' + httpsPort;
const pairWindowMs = 90000;

function say(event, details={}) { console.log(JSON.stringify({ event, ...details })); }
async function waitUntil(fn, description, timeout=30000) {
    const deadline = Date.now() + timeout;
    do {
        const value = await fn();
        if (value) return value;
        await delay(35);
    } while (Date.now() < deadline);
    throw new Error('Timed out waiting for ' + description);
}
function request(service, route, options={}) {
    return new Promise((resolve, reject) => {
        const req = https.request(service.origin + route, { ca:fs.readFileSync(ca), timeout:3000, ...options }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('error', reject);
            res.on('end', () => {
                if (res.statusCode !== 200) return reject(new Error('Fixture request rejected (' + res.statusCode + ')'));
                try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
                catch { reject(new Error('Fixture response was not JSON')); }
            });
        });
        req.on('timeout', () => req.destroy(new Error('Fixture request timed out')));
        req.on('error', reject);
        req.end(options.body);
    });
}

async function main() {
    let service, database, statusTimer;
    let pairUntil = 0;
    let released = false;
    const linuxPidFile = path.join(out, 'linux-supervisor.pid');
    const linuxAlive = () => {
        if (!fs.existsSync(linuxPidFile)) return false;
        const pid = Number(fs.readFileSync(linuxPidFile, 'utf8'));
        if (!Number.isSafeInteger(pid) || pid <= 0) return true;
        try { process.kill(pid, 0); return true; }
        catch (error) { if (error.code === 'ESRCH') return false; throw error; }
    };
    try {
        const csr = path.join(out,'leaf.csr');
        const extent = path.join(out,'leaf.ext');
        fs.writeFileSync(extent,'basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1,DNS:localhost\n');
        const opensslDate = milliseconds => new Date(milliseconds).toISOString().slice(0,19).replace(/[^0-9]/g,'') + 'Z';
        const now = Date.now();
        const dates = hardware
            ? ['-not_before',opensslDate(now-24*3600000),'-not_after',opensslDate(now+48*3600000)]
            : ['-days','1'];
        const openssl = args => execFileSync('openssl', args, { stdio:'ignore' });
        openssl(['req','-x509','-newkey','rsa:2048','-nodes',...dates,'-subj','/CN=VCP hardware test CA',
            '-addext','basicConstraints=critical,CA:TRUE,pathlen:0','-addext','keyUsage=critical,keyCertSign,cRLSign','-out',ca,'-keyout',caKey]);
        openssl(['req','-new','-newkey','rsa:2048','-nodes','-subj','/CN=VCP hardware fixture','-out',csr,'-keyout',key]);
        openssl(['x509','-req','-in',csr,'-CA',ca,'-CAkey',caKey,'-set_serial','1',...dates,'-out',cert,'-extfile',extent]);
        openssl(['x509','-in',ca,'-outform','der','-out',path.join(out,'hardware-ca.der')]);
        fs.rmSync(caKey);
        say('trust-ready',{ publicCa:ca, publicCaDer:path.join(out,'hardware-ca.der'), publicLeaf:cert });
        const handleFixtureRequest = async (req, response, route) => {
            if (route !== pairRoute) return false;
            if (req.method !== 'GET' || req.headers.host !== expectedHost ||
                req.url !== pairRoute || Date.now() >= pairUntil) {
                response.writeHead(404).end();
                return true;
            }
            pairUntil = 0;
            try {
                const { pairingCode } = await request(service, '/api/plugins/NativeSync/mobile/pairing', {
                    method:'POST',
                    headers:{ authorization:'Bearer synthetic-only', 'content-type':'application/json' },
                    body:JSON.stringify({ scopeMode:'shared', sharedSpaceId:'sharedAB', permissions:['read'] }),
                });
                assert.match(pairingCode, /^[A-Za-z0-9_-]{32}$/);
                response.writeHead(302, {
                    'cache-control':'no-store', 'referrer-policy':'no-referrer',
                    location:'/mobile/#pair=' + pairingCode,
                }).end();
            } catch {
                response.writeHead(502).end();
                say('pair-command-failed');
            }
            return true;
        };
        service = await start({ out, candidate:root, cert, key, ca, trace(){}, waitUntil, mode:'hardware', httpsPort, handleFixtureRequest, hardwareStream });
        fs.rmSync(key);
        service.disarmDrop();
        database = new DatabaseSync(path.join(service.data,'central.sqlite'), { readOnly:true });
        const descriptor = service.descriptors.A[subject];
        const snapshot = () => {
            const work = database.prepare('SELECT id,request_id,state,attempts,request_dispatched,user_message_id,user_seq,reply_message_id FROM mobile_executions WHERE topic_key=? ORDER BY rowid')
                .all(service.topics[subject].id);
            const journal = database.prepare('SELECT seq,msg_id,action FROM journal WHERE topic_id=? ORDER BY seq').all(service.topics[subject].id);
            const paired = database.prepare('SELECT count(*) AS count FROM mobile_pairings WHERE used=1').get().count;
            const providerCalls = service.calls.filter(call=>call.case===subject).length;
            return { work, journal, paired, providerCalls, totalProviderRequests:service.calls.filter(row=>Object.hasOwn(row,'stream') && Number.isFinite(row.at)).length, observerSendRejections:service.requests.filter(row=>row.observerSendRejected).length, released, ...(hardwareStream ? { stream:hardwareStream.provider.view(), seedCount:hardware.seedCount } : {}) };
        };
        await service.checkMobile();
        assert.equal(database.prepare('SELECT count(*) AS n FROM mobile_executions').get().n,0);
        assert.equal(snapshot().journal.length, hardware?.seedCount || 0);
        assert.equal(snapshot().providerCalls,0);
        const statusFile = path.join(out, 'status.json');
        let recordedCompletion = false;
        function writeSnapshot(file, value) {
            const temporary = file + '.tmp';
            fs.writeFileSync(temporary, JSON.stringify(value) + '\n', { mode:0o600 });
            fs.renameSync(temporary, file);
        }
        function writeStatus() {
            const value = snapshot();
            writeSnapshot(statusFile, value);
            if (!recordedCompletion && value.work.length === 1 && value.work[0].state === 'completed') {
                writeSnapshot(path.join(out,'work-completed.json'), value);
                recordedCompletion = true;
            }
        }
        statusTimer = setInterval(writeStatus, 300).unref();
        const ready = { url:service.origin + '/mobile/', pairUrl:service.origin + pairRoute, publicLeaf:cert,
            publicCa:ca, publicCaDer:path.join(out,'hardware-ca.der'), status:path.join(out,'status.json'),
            windowsSeed:path.join(out,'seed','desktopB'), agent:hardware ? 'Synthetic interrupted single' : 'Synthetic lost receipt',
            topic:hardware ? 'Partial single existing topic' : 'Sponsor target existing topic', desktopDescriptor:descriptor,
            windowsDescriptor:service.descriptors.B[subject], sharedTopicId:service.topics[subject].id,
            input:contract.cases[subject], ...(hardware ? { stageCommands:hardware.stages, seedCount:hardware.seedCount } : {}) };
        fs.writeFileSync(path.join(out,'ready.json'), JSON.stringify(ready)+'\n', { mode:0o600 });
        writeStatus();
        say('ready', ready);
        await new Promise(resolve => {
            const input = readline.createInterface({ input:process.stdin, terminal:false });
            input.on('line', async line => {
                try {
                    if (line === 'status') say('status', snapshot());
                    if (line === 'arm-pair') {
                        pairUntil = Date.now() + pairWindowMs;
                        say('pair-armed', { expiresInSeconds:pairWindowMs/1000 });
                    }
                    if (hardware && hardware.stages.includes(line)) {
                        const before = snapshot();
                        assert.equal(before.work.length,1);
                        assert.equal(before.providerCalls,1);
                        assert.equal(before.work[0].state,'running');
                        const view = await hardwareStream.provider.advance(line);
                        writeSnapshot(path.join(out,'work-before-'+line+'.json'),before);
                        if (line === 'finish') released = true;
                        writeSnapshot(path.join(out,'work-after-'+line+'.json'),snapshot());
                        say('stage-advanced',view);
                    }
                    if (!hardware && line === 'release') {
                        const view = snapshot();
                        assert.equal(released,false);
                        assert.equal(view.providerCalls,1);
                        assert.equal(view.work.length,1);
                        assert.equal(view.work[0].state,'running');
                        writeSnapshot(path.join(out,'work-held.json'), view);
                        released=true;
                        service.releaseLost();
                        say('provider-released');
                    }
                    if (line === 'stop') {
                        if (linuxAlive()) return say('stop-linux-first');
                        input.close();
                    }
                } catch { say('command-refused'); }
            });
            input.on('close', resolve);
            process.once('SIGINT', () => input.close());
            process.once('SIGTERM', () => input.close());
        });
    } finally {
        clearInterval(statusTimer);
        pairUntil = 0;
        database?.close();
        if (service) await service.close();
        if (linuxAlive()) say('run-retained-while-linux-active', { out });
        else fs.rmSync(out, { recursive:true, force:true });
    }
}
main().catch(error => { console.error(error.message); process.exitCode=1; });

'use strict';
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { X509Certificate } = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');
const fixture = __dirname;
const root = path.dirname(fixture);
const checkout = path.join(root,'checkout');
const desktop = path.join(checkout,'apps','desktop');
const profile = path.join(root,'profile');
const caFile = path.join(fixture,'ca.pem');
const leaf = new X509Certificate(fs.readFileSync(path.join(fixture,'leaf.pem')));
const port = 18443;
const origin = 'https://127.0.0.1:' + port;
const evidenceDrive = process.env.NS_WIN_EVIDENCE_DRIVE;
const events = path.join(evidenceDrive || fixture, 'windows-events.jsonl');

async function main() {
    assert.equal(process.platform, 'win32');
    assert.equal(process.arch, 'x64');
    assert.equal(process.env.USERNAME.toLowerCase(), 'r16limited');
    assert(Date.now() >= Date.parse(leaf.validFrom) && Date.now() <= Date.parse(leaf.validTo),
        'Windows clock is outside the synthetic leaf certificate validity period');
    if (!fs.existsSync(profile)) {
        const seed = path.join(fixture,'desktopB');
        const connection = JSON.parse(fs.readFileSync(path.join(seed,'.native-sync','connection.json'),'utf8'));
        assert.equal(connection.sourceId, 'sourceB');
        assert.equal(connection.deviceId, 'deviceB');
        assert.equal(connection.sharedSpaceId, 'sharedAB');
        assert.equal(connection.serverUrl, 'https://synthetic-shared.invalid');
        const { restoreProfile } = require(path.join(checkout,'tests','integration','profile.cjs'));
        await restoreProfile(seed, profile, origin, 'B');
        const settings = path.join(profile,'settings.json');
        fs.writeFileSync(settings, JSON.stringify({
            ...JSON.parse(fs.readFileSync(settings,'utf8')),
            ChatDataServiceEnabled: true,
            ChatDataServiceNotifyEnabled: false,
            ChatDataServiceTantivyEnabled: false,
            disableUpdateCheck: true
        }));
    }
    const relaySockets = new Set();
    const relay = net.createServer(client => {
        const upstream = net.connect(port,'10.0.2.100');
        for (const socket of [client,upstream]) {
            relaySockets.add(socket);
            socket.on('close', () => relaySockets.delete(socket));
        }
        client.pipe(upstream).pipe(client);
        client.on('error', () => upstream.destroy());
        upstream.on('error', () => client.destroy());
        client.on('close', () => upstream.destroy());
        upstream.on('close', () => client.destroy());
    });
    await new Promise((resolve,reject) => { relay.on('error',reject); relay.listen(port,'127.0.0.1',resolve); });
    try {
        await new Promise((resolve,reject) => {
            const req = https.get(origin + '/mobile/', { ca: fs.readFileSync(caFile), timeout: 12000 }, response => {
                response.resume();
                response.on('end', () => response.statusCode === 200
                    ? resolve() : reject(Error('HTTPS preflight status ' + response.statusCode)));
                response.on('error', reject);
            });
            req.on('timeout', () => req.destroy(Error('HTTPS preflight timed out')));
            req.on('error', reject);
        });
        console.log('Synthetic TLS preflight validated ' + origin);
        const electron = path.join(root, 'electron', 'electron.exe');
        const child = spawn(electron, [
            '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
            '--disable-background-networking',
            path.join(checkout, 'tests', 'release-a2a13b53555c', 'windows-observe.cjs')
        ], { cwd: desktop, env: {
            ...process.env,
            NS_HOST: desktop,
            VCPCHAT_APP_DATA_DIR: profile,
            VCPCHAT_E2E_TEST: '1',
            NODE_EXTRA_CA_CERTS: caFile,
            NS_CERT_FINGERPRINT: leaf.fingerprint256,
            NS_WIN_EVENTS: events
        }, stdio: ['ignore','inherit','inherit'] });
        await new Promise((resolve,reject) => {
            child.on('exit', code => code === 0 ? resolve() : reject(Error('Electron exit code ' + code)));
            child.on('error', reject);
        });
    } finally {
        for (const socket of relaySockets) socket.destroy();
        await new Promise(resolve => relay.close(resolve));
    }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });

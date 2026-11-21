'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { setTimeout: delay } = require('node:timers/promises');
const { start } = require('../integration/service.cjs');
const counter = require('../ordinary-tools/fixture.cjs');

const root = path.resolve(__dirname, '../..');
if (!process.argv[2]) throw Error('Usage: node tests/mobile-physical/run.cjs CONTROL_DIRECTORY [MOBILE_BUILD]');
const control = path.resolve(process.argv[2]);
const mobileBuild = process.argv[3] && path.resolve(process.argv[3]);
const out = fs.mkdtempSync(path.join(control, 'run-'));
const cert = path.join(control, 'loopback-cert.pem');
const key = path.join(control, 'loopback-key.pem');
const ca = path.join(control, 'hardware-ca.pem');
const markers = {
    PHYSICAL_ATTACHMENT: 'ORDINARY_TOOL_APPROVE',
    PHYSICAL_LOST_ACK: 'ORDINARY_TOOL_DENY',
};
const finalReplies = {
    PHYSICAL_ATTACHMENT: 'Physical attachment turn completed.',
    PHYSICAL_LOST_ACK: 'Physical receipt recovery turn completed.',
};
const attachmentMarker = 'VCP physical attachment fixture 2026';
const pairPath = '/__hardware/pair';
const messages = /^\/mobile\/api\/conversations\/[^/]+\/messages$/;
const exactLookup = /^\/mobile\/api\/conversations\/[^/]+\/execution-request$/;
const uploads = /^\/mobile\/api\/conversations\/[^/]+\/attachments\/uploads(?:\/[^/]+\/(?:chunks|finish))?$/;
const attachmentReads = /^\/mobile\/api\/conversations\/[^/]+\/attachments\/messages\//;
const reads = [];
const controls = name => path.join(control, name);
const writeJson = (name, value) => {
    const target = controls(name);
    fs.writeFileSync(target + '.tmp', JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(target + '.tmp', target);
};
function take(name) {
    try { fs.unlinkSync(controls(name)); return true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; return false; }
}
async function waitUntil(fn, name, timeout = 30000) {
    const until = Date.now() + timeout;
    do {
        const result = await fn();
        if (result) return result;
        await delay(40);
    } while (Date.now() < until);
    throw Error('Timed out waiting for ' + name);
}
const ordinaryTools = {
    stage(box) {
        counter.stage(box);
        fs.writeFileSync(path.join(box, 'toolApprovalConfig.json'), JSON.stringify({ enabled: false }));
    },
    reply(body, row, calls) {
        let marker;
        for (const message of body.messages.toReversed()) {
            if (message.role !== 'user') continue;
            const text = Array.isArray(message.content) ? message.content.filter(part => part.type === 'text')
                .map(part => part.text).join('\n') : message.content;
            if (typeof text !== 'string') continue;
            marker = Object.keys(markers).find(value => text.includes(value));
            if (marker) break;
        }
        if (!marker) return;
        row.marker = marker;
        row.phase = calls.some(call => call.marker === marker) ? 'tool-result' : 'tool-request';
        const serialized = JSON.stringify(body.messages);
        row.attachmentSeen = serialized.includes(attachmentMarker);
        row.toolResultSeen = serialized.includes('ordinary tool invocation recorded for ' + markers[marker]);
        if (row.phase === 'tool-result') return finalReplies[marker];
        return [
            '<<<[TOOL_REQUEST]>>>',
            'tool_name:「始」' + counter.name + '「末」,',
            'command:「始」Count「末」,',
            'marker:「始」' + markers[marker] + '「末」',
            '<<<[END_TOOL_REQUEST]>>>',
        ].join('\n');
    },
};
let lostRequestId;
const toolHandoff = {
    env: { NativeMobileAttachments: 'true', NativeMobileConfigSync: 'true', CHOKIDAR_USEPOLLING: 'true', NODE_OPTIONS: '--require=' + path.join(__dirname, 'knowledge-watcher.cjs') },
    observeRequest(method, route) {
        return method === 'POST' && (messages.test(route) || uploads.test(route)) ||
            method === 'GET' && (exactLookup.test(route) || attachmentReads.test(route));
    },
    dropResponse(row) {
        if (!messages.test(row.route) || row.body?.text !== 'PHYSICAL_LOST_ACK' || row.status !== 202 || lostRequestId) return false;
        lostRequestId = row.body.requestId;
        return true;
    },
};
async function pair(origin) {
    return new Promise((resolve, reject) => {
        const request = https.request(origin + '/api/plugins/NativeSync/mobile/pairing', {
            method: 'POST', ca: fs.readFileSync(ca), timeout: 3500,
            headers: { authorization: 'Bearer synthetic-only', 'content-type': 'application/json' },
        }, async response => {
            try {
                const chunks = [];
                for await (const chunk of response) chunks.push(chunk);
                assert.equal(response.statusCode, 200);
                const { pairingCode } = JSON.parse(Buffer.concat(chunks));
                assert.match(pairingCode, /^[A-Za-z0-9_-]{32}$/);
                resolve(pairingCode);
            } catch (error) { reject(error); }
        });
        request.on('error', reject);
        request.on('timeout', () => request.destroy(Error('Pairing timed out')));
        request.end(JSON.stringify({ scopeMode: 'shared', sharedSpaceId: 'sharedAB', permissions: ['read', 'execute'] }));
    });
}
function summarizedRequest(row) {
    const response = row.response;
    return { method: row.method, route: row.route, at: row.at, status: row.status, dropped: row.dropped,
        requestId: row.body?.requestId, text: row.body?.text, workId: response?.id ?? response?.execution?.id,
        matchedExecutions: response?.executions?.map(({ id, requestId, state }) => ({ id, requestId, state })),
        sha256: row.body?.expectedHash ?? response?.hash, attachments: row.body?.attachments,
        code: response?.error?.code };
}
async function main() {
    let service;
    let db;
    try {
        service = await start({ out, candidate: root, cert, key, ca, trace() {}, waitUntil,
            mode: 'physical-mobile', mobileBuild, httpsPort: Number(process.env.NS_PHYSICAL_PORT || 18443), ordinaryTools, toolHandoff,
            handleFixtureRequest: async (req, res, route) => {
                const query = new URL(req.url, 'https://127.0.0.1').searchParams;
                if (exactLookup.test(route)) {
                    const requestId = query.get('requestId');
                    const held = requestId && lostRequestId === requestId && !fs.existsSync(controls('allow-lookup'));
                    reads.push({ method: req.method, route, requestId, at: Date.now(), held });
                    if (!held) return false;
                    res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' })
                        .end(JSON.stringify({ error: { code: 'FIXTURE_LOOKUP_HELD' } }));
                    return true;
                }
                if (route !== pairPath) return false;
                if (req.method !== 'GET' || !take('arm-pair')) {
                    res.writeHead(404).end();
                    return true;
                }
                try {
                    const code = await pair(service.origin);
                    res.writeHead(302, { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
                        location: '/mobile/#pair=' + code }).end();
                } catch (error) {
                    res.writeHead(502).end();
                    console.error('Pairing failed: ' + error.message);
                }
                return true;
            } });
        service.disarmDrop();
        const mobile = await service.checkMobile();
        db = new DatabaseSync(path.join(service.data, 'central.sqlite'), { readOnly: true });
        const statement = {
            work: db.prepare('SELECT id,request_id,state,attempts,request_dispatched,user_message_id,user_seq,reply_message_id FROM mobile_executions WHERE topic_key=? ORDER BY rowid'),
            journal: db.prepare('SELECT seq,msg_id,action FROM journal WHERE topic_id=? ORDER BY seq'),
            links: db.prepare('SELECT msg_id,attachment_id,hash FROM attachment_links ORDER BY rowid'),
            pairing: db.prepare('SELECT count(*) AS count FROM mobile_pairings WHERE used=1'),
        };
        const topic = service.topics.lostAck;
        const ready = { url: service.origin + '/mobile/', pairUrl: service.origin + pairPath,
            publicCa: ca, publicCaDer: controls('hardware-ca.der'), file: controls('fixture-note.txt'),
            agent: 'Synthetic lost receipt', topic: 'Sponsor target existing topic', topicKey: topic.id,
            markers: Object.keys(markers), finalReplies, mobile, backendPid: service.backendPid, out };
        const snapshot = () => ({
            bundleSha256: createHash('sha256').update(fs.readFileSync(path.join(out,
                'runtime-box/Plugin/NativeSync/mobile-dist/index.html'))).digest('hex'),
            provider: service.calls,
            tools: counter.counts(out),
            requests: service.requests.map(summarizedRequest),
            exactLookups: reads,
            lostRequestId,
            work: statement.work.all(topic.id),
            journal: statement.journal.all(topic.id),
            links: statement.links.all(),
            paired: statement.pairing.get().count,
            attachmentFixture: { name: 'fixture-note.txt', sha256: createHash('sha256').update(fs.readFileSync(ready.file)).digest('hex') },
        });
        writeJson('ready.json', ready);
        console.log('Ready at ' + ready.url);
        let ending = false;
        process.once('SIGTERM', () => { ending = true; });
        process.once('SIGINT', () => { ending = true; });
        while (!ending && !take('stop')) {
            writeJson('status.json', snapshot());
            await delay(350);
        }
        writeJson('status.json', snapshot());
    } finally {
        db?.close();
        if (service) await service.close();
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

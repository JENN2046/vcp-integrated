'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { DatabaseSync } = require('node:sqlite');
const { createRequire } = require('node:module');
const { createHash, randomUUID } = require('node:crypto');
const fixture = require('./fixture.cjs');
const { start } = require('../integration/service.cjs');
const { canonicalSourceMessage } = require('../../apps/desktop/modules/services/nativeSync/sourceSnapshot');

const candidate = path.resolve(__dirname, '../..');
const requireServer = createRequire(path.join(candidate, 'apps/server/package.json'));
const WebSocket = requireServer('ws');
const args = process.argv.slice(2);
const withPwa = args.includes('--pwa');
const revisionArgs = args.filter(argument => argument !== '--pwa');
const [baselineRevision] = revisionArgs;
assert.ok(revisionArgs.length <= 1 && (!baselineRevision || /^[a-f0-9]{40}$/.test(baselineRevision)),
    'Usage: node tests/ordinary-tools/run.cjs [complete baseline Git commit hash] [--pwa]');

async function waitUntil(fn, label, timeout = 8000) {
    const until = Date.now() + timeout;
    do {
        const result = await fn();
        if (result) return result;
        await delay(25);
    } while (Date.now() < until);
    throw Error('Timed out waiting for ' + label);
}

async function main() {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-ordinary-tools-'));
    console.log('Synthetic ordinary tool evidence ' + out);
    const cert = path.join(out, 'loopback-cert.pem');
    const key = path.join(out, 'loopback-key.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
        '-subj', '/CN=Synthetic ordinary tool fixture', '-addext', 'subjectAltName=IP:127.0.0.1',
        '-keyout', key, '-out', cert], { stdio: 'ignore' });
    const evidence = { baselineRevision: baselineRevision || null, cases: {} };
    const trace = (event, data) => fs.appendFileSync(path.join(out, 'events.jsonl'), JSON.stringify({ event, data }) + '\n');
    let service;
    let socket;
    let db;
    let audit;
    let pwa;
    try {
        try {
            service = await start({ out, candidate, cert, key, trace, waitUntil, serverRevision: baselineRevision,
                ordinaryTools: fixture });
        } finally {
            fs.rmSync(key, { force: true });
        }
        db = new DatabaseSync(path.join(service.data, 'central.sqlite'), { readOnly: true });
        const { spaceId } = JSON.parse(fs.readFileSync(path.join(out, 'seed/desktopA/.native-sync/connection.json')));
        const request = (route, body) => new Promise((resolve, reject) => {
            const req = https.request(service.origin + (route.startsWith('/') ? route : '/api/v1/sync/shared/' + route), {
                method: body ? 'POST' : 'GET',
                ca: fs.readFileSync(cert),
                headers: {
                    authorization: 'Bearer synthetic-only',
                    'content-type': 'application/json',
                    'x-nativesync-source': 'sourceA',
                    'x-nativesync-device': 'deviceA',
                    'x-nativesync-space': spaceId,
                    'x-nativesync-protocol': '2',
                    'x-nativesync-capabilities': 'shared-space-v1,shared-context-v1,shared-session-v1,shared-session-cancel-v1',
                },
            }, async response => {
                try {
                    const chunks = [];
                    for await (const chunk of response) chunks.push(chunk);
                    const value = JSON.parse(Buffer.concat(chunks));
                    assert.equal(response.statusCode, 200, route + ': ' + JSON.stringify(value));
                    resolve(value);
                } catch (error) { reject(error); }
            });
            req.on('error', reject);
            req.setTimeout(4500, () => req.destroy(Error('Timed out requesting ' + route)));
            req.end(body && JSON.stringify(body));
        });
        if (withPwa) pwa = await require('./pwa.cjs')({ service, out, cert, request, puppet: requireServer('puppeteer') });
        audit = new DatabaseSync(path.join(out, 'runtime-box/config/tool-call-records.sqlite3'), { readOnly: true });
        const approvals = new Map();
        socket = new WebSocket(service.wsOrigin.replace(/^http:/, 'ws:') + '/VCPlog/VCP_Key=synthetic-sponsor-ws?deviceName=ordinary-fixture');
        let connected = false;
        socket.on('message', bytes => {
            const event = JSON.parse(bytes);
            if (event.type === 'connection_ack') connected = true;
            if (event.type !== 'tool_approval_request' || event.data.toolName !== fixture.name) return;
            const marker = JSON.stringify(event.data).match(/ORDINARY_TOOL_[A-Z]+/)?.[0];
            if (marker) approvals.set(marker, event.data);
        });
        await once(socket, 'open');
        await waitUntil(() => connected, 'native approval client acknowledgement');

        const sharedSpaceId = 'sharedAB';
        const rows = id => db.prepare('SELECT invocation_id,native_request_id,plugin_name,record_id,state,error_code FROM mobile_native_invocations WHERE execution_id=?').all(id);
        const job = id => db.prepare('SELECT state,attempts,request_dispatched,cancel_requested,error_code,tool_started,user_message_id,reply_message_id FROM mobile_executions WHERE id=?').get(id);
        const terminal = id => ['completed', 'failed', 'cancelled', 'review_required'].includes(job(id)?.state);
        const providerOffsets = new Map();
        const calls = marker => service.calls.slice(providerOffsets.get(marker));
        const providerView = (marker, records = calls(marker)) => records.map(call => ({
            ordinaryPhase: call.ordinaryCase === marker ? call.ordinaryPhase : 'unclassified',
            hasToolResult: call.hasToolResult === true,
            nativeRequestId: call.id || null,
        }));
        const snapshot = (id, marker) => ({
            job: job(id), invocations: rows(id),
            journal: db.prepare('SELECT seq,msg_id,action FROM journal WHERE msg_id IN (?, ?) ORDER BY seq')
                .all(job(id).user_message_id, 'reply_' + id),
            pluginCalls: fixture.counts(out).filter(row => row.marker === marker).length,
            provider: providerView(marker),
        });
        const decisions = (approval, approved) => socket.send(JSON.stringify({
            type: 'tool_approval_response',
            data: { requestId: approval.requestId, approved, reason: approved ? '' : 'Synthetic ordinary tool denial' },
        }));
        async function admit(marker, topic = service.topics.preSubmit) {
            providerOffsets.set(marker, service.calls.length);
            const sharedId = topic.id;
            const context = await request('context?' + new URLSearchParams({ sharedSpaceId, sharedId }));
            const requestId = randomUUID();
            const body = { sharedSpaceId, sharedId, requestId, expectedHead: context.head, configHash: context.hash,
                message: canonicalSourceMessage({ id: requestId, role: 'user', content: marker, timestamp: Date.now() }, sharedId) };
            const sent = await request('session-send', body);
            assert.equal(sent.replayed, false);
            const id = sent.workId;
            const approval = await waitUntil(() => {
                const event = approvals.get(marker);
                // The WebSocket notification and the shared Work's projected state are delivered separately.
                if (event && (baselineRevision || job(id)?.state === 'waiting_approval')) return event;
                return terminal(id) && { noApproval: true };
            }, marker + ' native approval');
            evidence.cases[marker] = { id, inputId: requestId, approvalId: approval.requestId, beforeDecision: snapshot(id, marker), approvalExposed: !approval.noApproval };
            assert.equal(evidence.cases[marker].beforeDecision.pluginCalls, 0);
            if (!baselineRevision) {
                assert.equal(approval.noApproval, undefined);
                assert.deepEqual(rows(id), [], 'awaiting approval never implies native tool invocation');
                assert.equal(job(id).state, 'waiting_approval');
            }
            return { body, id, approval };
        }

        for (const [label, approved] of [['APPROVE', true], ['DENY', false]]) {
            const marker = 'ORDINARY_TOOL_' + label;
            const { id, approval, body } = await admit(marker);
            if (approved) {
                const replay = await request('session-send', body);
                assert.equal(replay.replayed, true);
                assert.equal(replay.workId, id);
                assert.equal(calls(marker).length, 1);
                evidence.cases[marker].sameAcceptedReplay = true;
                if (pwa) evidence.readOnlyPwa = { duringApproval: await pwa.duringApproval() };
            }
            if (!approval.noApproval) decisions(approval, approved);
            await waitUntil(() => terminal(id), marker + ' terminal');
            const after = evidence.cases[marker].afterDecision = snapshot(id, marker);
            if (!baselineRevision) {
                assert.equal(after.job.state, 'completed');
                assert.equal(after.job.attempts, 1);
                assert.equal(after.journal.length, 2);
                assert.equal(after.pluginCalls, Number(approved));
                assert.equal(after.provider.filter(call => call.hasToolResult).length, Number(approved));
                if (approved) assert.equal(after.provider.length, 2);
                assert.equal(after.invocations.length, Number(approved));
                if (approved) {
                    assert.equal(after.invocations[0].state, 'returned');
                    const { record_id } = after.invocations[0];
                    assert.ok(record_id);
                    const linked = audit.prepare('SELECT id,tool_name,status,success FROM tool_call_records WHERE id=?').get(record_id);
                    assert.deepEqual({ ...linked }, { id: record_id, tool_name: fixture.name, status: 'success', success: 1 });
                    evidence.cases[marker].nativeAuditRecord = linked;
                }
            }
            if (approved && pwa) Object.assign(evidence.readOnlyPwa, await pwa.afterApproval(fixture.finalText));
        }

        const cancelMarker = 'ORDINARY_TOOL_CANCEL';
        const cancel = await admit(cancelMarker);
        if (!cancel.approval.noApproval) {
            const cancelled = await request('session-cancel', { sharedSpaceId, workId: cancel.id, opId: randomUUID() });
            assert.equal(cancelled.submitted, true);
            await waitUntil(() => terminal(cancel.id), 'cancel terminal before late approval');
            decisions(cancel.approval, true);
            await delay(350);
        }
        const afterCancel = evidence.cases[cancelMarker].afterLateApproval = snapshot(cancel.id, cancelMarker);
        if (!baselineRevision) {
            assert.equal(afterCancel.job.state, 'review_required');
            assert.equal(afterCancel.job.cancel_requested, 1);
            assert.equal(afterCancel.journal.length, 1);
            assert.equal(afterCancel.pluginCalls, 0);
            assert.deepEqual(afterCancel.invocations, []);
            assert.equal(afterCancel.provider.length, 1);
        }

        for (const label of ['TIMEOUT', 'THROW']) {
            const marker = 'ORDINARY_TOOL_' + label;
            const { id, approval } = await admit(marker, service.topics[label]);
            if (!approval.noApproval) decisions(approval, true);
            await waitUntil(() => terminal(id), marker + ' settled execution state');
            const after = evidence.cases[marker].afterUnconfirmedResult = snapshot(id, marker);
            if (!baselineRevision) {
                assert.equal(after.job.state, 'review_required');
                assert.equal(after.job.attempts, 1);
                assert.equal(after.pluginCalls, 1);
                assert.equal(after.provider.length, 1);
                assert.equal(after.journal.length, 1);
                assert.equal(after.invocations.length, 1);
                assert.equal(after.invocations[0].state, 'started');
            }
        }

        const crashMarker = 'ORDINARY_TOOL_CRASH';
        const crash = await admit(crashMarker, service.topics.lostAck);
        if (!crash.approval.noApproval) {
            decisions(crash.approval, true);
            await waitUntil(() => fixture.counts(out).filter(row => row.marker === crashMarker).length === 1,
                'fsynced side effect with plugin result still held');
            const before = evidence.cases[crashMarker].beforeCrash = snapshot(crash.id, crashMarker);
            assert.equal(before.pluginCalls, 1);
            assert.equal(before.provider.length, 1);
            assert.equal(before.journal.length, 1);
            if (!baselineRevision) {
                assert.equal(before.invocations.length, 1);
                assert.equal(before.invocations[0].state, 'started');
            }
            const originalPid = service.backendPid;
            evidence.cases[crashMarker].crash = await service.restartAfterCrash();
            assert.notEqual(service.backendPid, originalPid);
            await waitUntil(() => terminal(crash.id), 'reopened job held for recovery');
            const replay = await request('session-send', crash.body);
            assert.equal(replay.replayed, true);
            assert.equal(replay.workId, crash.id);
            await delay(350);
            const recovered = evidence.cases[crashMarker].afterReopenAndReplay = snapshot(crash.id, crashMarker);
            assert.equal(recovered.pluginCalls, before.pluginCalls);
            assert.deepEqual(recovered.provider, before.provider);
            assert.deepEqual(recovered.invocations, before.invocations);
            assert.deepEqual(recovered.journal, before.journal);
            assert.equal(recovered.job.attempts, 1);
            if (!baselineRevision) assert.equal(recovered.job.state, 'review_required');
        }
        const offsets = [...providerOffsets.entries()];
        const byCase = {};
        for (const [index, [marker, start]] of offsets.entries()) {
            const end = offsets[index + 1]?.[1] ?? service.calls.length;
            const recorded = evidence.cases[marker];
            const lastSnapshot = recorded.afterDecision || recorded.afterLateApproval ||
                recorded.afterUnconfirmedResult || recorded.afterReopenAndReplay;
            byCase[marker] = providerView(marker, service.calls.slice(start, end));
            assert.deepEqual(byCase[marker], lastSnapshot.provider, marker + ' has extra calls past its final snapshot');
            assert.ok(byCase[marker].every(call => call.nativeRequestId === recorded.id),
                marker + ' provider requests must belong to its native admission');
        }
        evidence.providerAccounting = {
            totalRequests: service.calls.length,
            assignedRequests: Object.values(byCase).reduce((total, records) => total + records.length, 0),
            unclassifiedRequests: Object.values(byCase).flat().filter(call => call.ordinaryPhase === 'unclassified').length,
        };
        assert.equal(evidence.providerAccounting.totalRequests, evidence.providerAccounting.assignedRequests);
        assert.equal(service.calls.some(call => call.case === 'fixtureError'), false, 'synthetic upstream handled every request');
        if (!baselineRevision) assert.equal(evidence.providerAccounting.unclassifiedRequests, 0);
    } catch (error) {
        evidence.failure = error.stack;
        throw error;
    } finally {
        try {
            socket?.terminate();
            db?.close();
            audit?.close();
            await pwa?.close();
            if (service) {
                evidence.backendExit = await service.close();
                if (evidence.providerAccounting) {
                    evidence.providerAccounting.totalRequestsAtShutdown = service.calls.length;
                    assert.equal(service.calls.length, evidence.providerAccounting.totalRequests,
                        'provider call count stayed unchanged through shutdown');
                }
                const loaded = JSON.parse(fs.readFileSync(path.join(out, 'backend-loaded.json')));
                for (const row of loaded) {
                    const source = baselineRevision
                        ? execFileSync('git', ['show', baselineRevision + ':' + row.file], { cwd: candidate, maxBuffer: 32 * 1024 * 1024 })
                        : fs.readFileSync(path.join(candidate, row.file));
                    assert.equal(row.sha256, createHash('sha256').update(source).digest('hex'), row.file);
                }
                assert.ok(loaded.some(row => row.file.endsWith('/vcpLoop/toolExecutor.js')));
                assert.ok(loaded.some(row => row.file.endsWith('/Plugin.js')));
                evidence.loadedSources = loaded;
            }
        } catch (error) {
            evidence.cleanupFailure = error.stack;
            throw error;
        } finally {
            fs.writeFileSync(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
            for (const directory of ['runtime-box', 'pwa-browser']) {
                fs.rmSync(path.join(out, directory), { recursive: true, force: true });
            }
        }
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

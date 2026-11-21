'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { once } = require('node:events');
const { createRequire } = require('node:module');
const { setTimeout: delay } = require('node:timers/promises');
const { DatabaseSync } = require('node:sqlite');
const ordinaryTools = require('../ordinary-tools/fixture.cjs');
const { createFixture } = require('../group-relay/fixture.cjs');
const { launch, mobileControl, openPwa } = require('../group-relay/pwa.cjs');
const { start } = require('../integration/service.cjs');

const candidate = path.resolve(__dirname, '../..');
const serverRequire = createRequire(path.join(candidate, 'apps/server/package.json'));
const marker = 'ORDINARY_TOOL_APPROVE';
const output = 'RELAY_B_APPROVED_FINAL';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function waitUntil(fn, label, timeout = 25000) {
    const until = Date.now() + timeout;
    do {
        const result = await fn();
        if (result) return result;
        await delay(35);
    } while (Date.now() < until);
    throw Error('Timed out: ' + label);
}

function createProvider() {
    const original = createFixture();
    let approvalRound = true;
    let continuation = false;
    return {
        seed: original.seed,
        beginLegacyRound() { approvalRound = false; },
        isClosed: () => original.closed,
        respond(body, row, res) {
            const system = body.messages.find(message => message.role === 'system');
            if (!approvalRound || !JSON.stringify(system || {}).includes('GROUP_RELAY_MEMBER_B')) {
                return original.respond(body, row, res);
            }
            row.member = 'B';
            row.phase = continuation ? 'continuation' : 'tool-request';
            row.hasToolResult = JSON.stringify(body.messages).includes('ordinary tool invocation recorded for ' + marker);
            const content = continuation ? output : [
                '<<<[TOOL_REQUEST]>>>',
                'tool_name:「始」' + ordinaryTools.name + '「末」,',
                'command:「始」Count「末」,',
                'marker:「始」' + marker + '「末」',
                '<<<[END_TOOL_REQUEST]>>>',
            ].join('\n');
            continuation = true;
            assert.equal(body.stream, true);
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            const frame = (delta, reason) => 'data: ' + JSON.stringify({
                id: 'synthetic-relay-approval', object: 'chat.completion.chunk', created: 1, model: 'synthetic',
                choices: [{ index: 0, delta, finish_reason: reason }],
            }) + '\n\n';
            res.write(frame({ role: 'assistant', content }, null));
            res.write(frame({}, 'stop'));
            res.end('data: [DONE]\n\n');
            return true;
        },
    };
}

async function main() {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-group-compat-'));
    console.log('Isolated group compatibility evidence ' + out);
    const cert = path.join(out, 'loopback-cert.pem');
    const key = path.join(out, 'loopback-key.pem');
    const trace = (event, data) => fs.appendFileSync(path.join(out, 'events.jsonl'), JSON.stringify({ event, data }) + '\n');
    const provider = createProvider();
    const evidence = {};
    let service, browser, socket, db, audit;
    try {
        execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
            '-subj', '/CN=NativeSync synthetic group approval', '-addext', 'subjectAltName=IP:127.0.0.1',
            '-keyout', key, '-out', cert], { stdio: 'ignore' });
        try {
            service = await start({ out, candidate, cert, key, trace, waitUntil,
                ordinaryTools, groupRelay: provider });
        } finally {
            fs.rmSync(key, { force: true });
        }
        const WebSocket = serverRequire('ws');
        socket = new WebSocket(service.wsOrigin.replace(/^http:/, 'ws:') +
            '/VCPlog/VCP_Key=synthetic-sponsor-ws?deviceName=group-compat');
        const approvals = [];
        let connected = false;
        socket.on('message', bytes => {
            const event = JSON.parse(bytes);
            if (event.type === 'connection_ack') connected = true;
            if (event.type === 'tool_approval_request' && event.data.toolName === ordinaryTools.name) {
                approvals.push(event.data.requestId);
            }
        });
        await once(socket, 'open');
        await waitUntil(() => connected, 'native approval client acknowledgement');
        browser = await launch(serverRequire('puppeteer'), cert);
        const pwa = await openPwa({ browser, service, request: mobileControl(service, cert, out), execute: true });
        const loadedBundle = await pwa.page.evaluate(async () => {
            const entry = performance.getEntriesByType('resource')
                .find(resource => new URL(resource.name).pathname.startsWith('/mobile/assets/') && resource.name.endsWith('.js'));
            if (!entry) return null;
            const response = await fetch(entry.name);
            if (!response.ok) return null;
            return { file: new URL(entry.name).pathname, body: await response.text() };
        });
        assert.ok(loadedBundle, 'Chromium loads the built PWA entry bundle');
        const mobileDist = path.join(candidate, 'apps/server/Plugin/NativeSync/mobile-dist');
        evidence.mobile = { browser: await browser.version(), bundle: loadedBundle.file, sha256: sha(loadedBundle.body) };
        assert.equal(evidence.mobile.sha256, sha(fs.readFileSync(path.join(mobileDist, loadedBundle.file.slice('/mobile/'.length)))));
        db = new DatabaseSync(path.join(service.data, 'central.sqlite'), { readOnly: true });
        audit = new DatabaseSync(path.join(out, 'runtime-box/config/tool-call-records.sqlite3'), { readOnly: true });
        const topic = service.topics.groupTopic.id;
        const jobs = () => db.prepare('SELECT id,state,cancel_requested,group_stop_index FROM mobile_executions WHERE topic_key=? ORDER BY rowid').all(topic);
        const steps = id => db.prepare('SELECT id,state,attempts,reply_message_id FROM mobile_execution_steps WHERE job_id=? ORDER BY step_index').all(id);
        const records = () => audit.prepare('SELECT id,status,success FROM tool_call_records WHERE tool_name=? ORDER BY rowid').all(ordinaryTools.name);
        const calls = () => service.calls.filter(row => row.member);
        const snapshot = id => ({
            job: jobs().find(job => job.id === id), steps: steps(id), approvals: [...approvals],
            toolRuns: ordinaryTools.counts(out).length, toolRecords: records(), provider: calls().map(({ member, phase, hasToolResult }) => ({ member, phase, hasToolResult })),
        });

        await pwa.message('Synthetic group pending approval.');
        const work = await waitUntil(() => jobs().find(row => row.state === 'waiting_approval'), 'B waiting for tool approval');
        const originalApproval = await waitUntil(() => approvals[0], 'ordinary approval request in native log');
        const before = snapshot(work.id);
        assert.deepEqual(before.steps.map(row => [row.state, row.attempts]), [['completed', 1], ['waiting_approval', 1], ['queued', 0]]);
        assert.equal(before.toolRuns, 0);
        assert.equal(before.toolRecords.length, 1);
        assert.equal(before.toolRecords[0].status, 'running');
        const selector = '[data-cancel-remaining-id="' + work.id + '"]';
        await pwa.page.waitForSelector(selector, { visible: true });
        await pwa.page.click(selector);
        await waitUntil(() => steps(work.id)[2]?.state === 'cancelled', 'graceful cancellation skips C');
        const cancelled = snapshot(work.id);
        assert.deepEqual({ ...cancelled.job }, { ...before.job, group_stop_index: 2 });
        assert.deepEqual(cancelled.steps.slice(0, 2), before.steps.slice(0, 2));
        assert.equal(cancelled.steps[2].attempts, 0);
        assert.deepEqual(cancelled.approvals, [originalApproval]);
        assert.equal(cancelled.toolRuns, 0);
        assert.deepEqual(cancelled.toolRecords, before.toolRecords);
        assert.deepEqual(cancelled.provider, before.provider);

        socket.send(JSON.stringify({ type: 'tool_approval_response', data: { requestId: originalApproval, approved: true } }));
        await waitUntil(() => jobs().find(row => row.id === work.id)?.state === 'cancelled', 'original B completion settles stopped round');
        await pwa.text(output);
        const completed = snapshot(work.id);
        assert.deepEqual(completed.steps.map(row => [row.state, row.attempts]), [['completed', 1], ['completed', 1], ['cancelled', 0]]);
        assert.deepEqual(completed.approvals, [originalApproval]);
        assert.equal(completed.toolRuns, 1);
        assert.deepEqual(completed.toolRecords.map(row => ({ ...row })), [{ id: before.toolRecords[0].id, status: 'success', success: 1 }]);
        assert.deepEqual(completed.provider.map(row => row.member), ['A', 'B', 'B']);
        assert.deepEqual(completed.provider.filter(row => row.member === 'B').map(({ phase, hasToolResult }) => [phase, hasToolResult]),
            [['tool-request', false], ['continuation', true]]);
        evidence.approval = { before, cancelled, completed };
        await pwa.page.screenshot({ path: path.join(out, 'approved-after-cancel-remaining.png') });

        provider.beginLegacyRound();
        const offset = calls().length;
        await pwa.message('Synthetic legacy full cancel.');
        const legacy = await waitUntil(() => {
            const next = jobs().find(row => row.id !== work.id);
            return next && calls().slice(offset).some(row => row.member === 'B') && next;
        }, 'B starts streaming in legacy cancel round');
        await pwa.text('RELAY_B_PARTIAL');
        const legacyBefore = snapshot(legacy.id);
        assert.equal(provider.isClosed(), false);
        const response = await pwa.request('executions/' + legacy.id + '/cancel', {});
        assert.equal(response.status, 202);
        await waitUntil(() => provider.isClosed(), 'legacy cancel closes current provider connection');
        await waitUntil(() => ['cancelled', 'recovering'].includes(jobs().find(row => row.id === legacy.id)?.state),
            'legacy full cancellation stops execution or retains interrupted publish intent');
        const legacyAfter = snapshot(legacy.id);
        assert.equal(legacyAfter.job.cancel_requested, 1);
        assert.equal(legacyAfter.job.group_stop_index, null);
        assert.deepEqual(legacyAfter.steps.map(row => row.attempts), [1, 1, 0]);
        assert.equal(legacyAfter.steps[0].state, 'completed');
        assert.ok(['cancelled', 'publishing'].includes(legacyAfter.steps[1].state));
        assert.equal(legacyAfter.steps[2].state, 'cancelled');
        assert.deepEqual(legacyAfter.provider.slice(offset).map(row => row.member), ['A', 'B']);
        assert.deepEqual(pwa.errors, []);
        evidence.legacy = { before: legacyBefore, after: legacyAfter, responseStatus: response.status,
            providerConnectionClosed: provider.isClosed() };
    } finally {
        evidence.providerErrors = service?.calls.filter(row => row.case === 'fixtureError').map(row => row.error);
        socket?.terminate();
        db?.close();
        audit?.close();
        await browser?.close();
        evidence.backendExit = await service?.close();
        const loadedReport = path.join(out, 'backend-loaded.json');
        if (fs.existsSync(loadedReport)) {
            evidence.backendSources = JSON.parse(fs.readFileSync(loadedReport, 'utf8'));
            for (const source of evidence.backendSources) {
                assert.equal(source.sha256, sha(fs.readFileSync(path.join(candidate, source.file))), source.file);
            }
        }
        fs.writeFileSync(path.join(out, 'receipt.json'), JSON.stringify(evidence, null, 2) + '\n');
        fs.rmSync(path.join(out, 'runtime-box'), { recursive: true, force: true });
        fs.rmSync(path.join(out, 'node_modules'), { recursive: true, force: true });
    }
    for (const basename of ['groupTurn.js', 'nativeTasks.js', 'sharedGroups.js', 'sharedNative.js', 'sharedEvents.js', 'portal.js']) {
        assert.ok(evidence.backendSources.some(source => source.file.endsWith('/' + basename)), basename);
    }
    assert.deepEqual(evidence.providerErrors, []);
    assert.deepEqual(evidence.backendExit, { code: 0, signal: null });
    console.log('Group compatibility PASS ' + path.join(out, 'receipt.json'));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
